// Plan D Task 6: the on-device analyzer service -- ties together every
// building block Tasks 4/5 proved in isolation (resolveStreamUrl, the native
// AudioMel decode+mel pipeline, the TFLite embedding+mood models) into one
// `analyzeSong(videoId)` that a screen or the player can call to make a song
// vibe-shuffle-eligible without ever touching a PC.
//
// Pipeline: resolveStreamUrl -> download to a local temp file (MediaCodec,
// underneath decodeAndMel, needs a real file path -- it can't decode a
// streaming URL) -> decodeAndMel -> analyzeEmbeddingAndMoods -> write a
// `features` row -> delete the temp file. Every step after the initial
// already-analyzed check is wrapped in try/finally so a failure (bad
// network, a video with no playable audio format, a corrupt download,
// whatever) always cleans up the temp file and reports `false` rather than
// throwing up into a screen's event handler -- this runs unattended (lazy
// on-play, batch playlist analysis) far more often than it runs from a
// button a user is staring at, so silent-log-and-continue is the right
// default.
import {AppState, NativeEventEmitter, NativeModules} from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import * as RNFS from '@dr.pogodin/react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {resolveStreamUrl} from '../stream/resolver';
import {decodeAndMel} from './audio';
import {analyzeEmbeddingAndMoods} from './tflite';
import {ensureBaseSchema} from '../db/vibesDb';

// Our own native foreground service (AnalysisForegroundService.kt), exposed as
// NativeModules.AnalysisService. Keeps the process foregrounded so Android
// doesn't suspend/kill it while the app is backgrounded -- the analysis loop
// keeps running in JS. This REPLACES react-native-background-actions, whose
// JS-driven startForeground() raced Android 14/15's 5s window and crashed the
// app intermittently; our service calls startForeground() synchronously in
// native onStartCommand, so there's no JS-timing race. Null under jest / if
// the module is missing -> the batch runs bare (fine while foregrounded).
interface AnalysisServiceLike {
  start(title: string, text: string): void;
  update(title: string, text: string): void;
  stop(): void;
  getBatteryStatus?(): Promise<{level: number; charging: boolean}>;
  startBatteryUpdates?(): void;
}
const analysisService: AnalysisServiceLike | null =
  (NativeModules.AnalysisService as AnalysisServiceLike | undefined) ?? null;

const NOTIF_TITLE = 'Analyzing your music';
function notifText(): string {
  const {done, total, failed} = batchState;
  return `${done}/${total}${failed.length ? ` · ${failed.length} failed` : ''}`;
}

// Stamped into the `meta` table (key 'model_version') after every successful
// analysis, so a future model swap has a marker for "which rows were
// produced by the old model and may need re-analysis." Matches the bundled
// embedding model's filename (tflite.ts: models/msd-musicnn-1.tflite).
export const MODEL_VERSION = 'msd-musicnn-1';

function tempAudioPath(videoId: string): string {
  // videoId is a YouTube id (URL-safe base64-ish, no path separators), safe
  // to use directly in a filename. The timestamp guards against two
  // overlapping analyzeSong calls for the same id (shouldn't happen given
  // the mutex below, but costs nothing extra) ever colliding on one file.
  return `${RNFS.TemporaryDirectoryPath}/flowstate-analyze-${videoId}-${Date.now()}.tmp`;
}

// --- concurrency guard -------------------------------------------------
// A simple FIFO mutex: only one analysis (the expensive download+decode+
// infer part) runs at a time, so a batch run and a lazy on-play trigger
// never thrash the CPU/network against each other. Implemented as a promise
// chain rather than a queue array since analyzer.ts only ever needs "run
// this next, whatever else is queued" -- no cancellation *within* a single
// queued job is needed here (analyzeMany's cancellation, see below, works a
// level up by simply not enqueueing the next song).
let mutexTail: Promise<unknown> = Promise.resolve();
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = mutexTail.then(fn, fn);
  // Swallow the result/rejection in the tail itself so one job's failure
  // doesn't poison every job queued after it -- each caller still sees its
  // own job's real outcome via `result`.
  mutexTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Analyzes one song end-to-end and writes its `features` row, unless a row
 * already exists (skip). Returns whether the song is analyzed when this
 * resolves (true = row exists now, whether freshly written or already
 * present; false = analysis was attempted and failed, or a row genuinely
 * couldn't be produced). Never throws -- failures are logged and reported
 * as `false` so this is always safe to call unattended (fire-and-forget from
 * the player, or from a batch loop that must keep going past one bad song).
 *
 * Calls for the SAME videoId that overlap in time (e.g. PlaylistScreen's
 * lazy on-play trigger firing at the same moment a batch "Analyze playlist"
 * run reaches that song) share one in-flight promise via `inFlight` below,
 * rather than each running the full download+decode+infer pipeline
 * independently -- the mutex alone only serializes them, it doesn't dedupe
 * the work itself.
 */
export function analyzeSong(videoId: string): Promise<boolean> {
  const existing = inFlight.get(videoId);
  if (existing) return existing;

  const promise = analyzeSongUncached(videoId).finally(() => {
    // Only clear the entry if it's still THIS call's promise -- guards
    // against a pathological case where the map already moved on.
    if (inFlight.get(videoId) === promise) inFlight.delete(videoId);
  });
  inFlight.set(videoId, promise);
  return promise;
}

const inFlight = new Map<string, Promise<boolean>>();

async function analyzeSongUncached(videoId: string): Promise<boolean> {
  // Fast unlocked pre-check: the overwhelmingly common case (a song that's
  // already analyzed, e.g. every re-play, or every OTHER song while a batch
  // run works through the one that actually needs it) returns immediately
  // without waiting behind the mutex for whatever long-running job is
  // currently in flight.
  try {
    const db = await ensureBaseSchema();
    try {
      if (db.hasFeatures(videoId)) return true;
    } finally {
      db.close();
    }
  } catch (e) {
    console.warn(`[analyzer] analyzeSong(${videoId}): pre-check failed`, e);
    return false;
  }

  // Download UNLOCKED (network) so it can overlap another song's compute
  // (the B3 pipeline); only the heavy compute stage takes the mutex, so at
  // most one decode+mel+infer runs at a time across lazy + batch.
  let tempPath: string | undefined;
  try {
    tempPath = await downloadStage(videoId);
  } catch (e) {
    console.warn(`[analyzer] analyzeSong(${videoId}) download failed`, e);
    return false;
  }
  try {
    return await runExclusive(() => computeStage(videoId, tempPath!));
  } catch (e) {
    console.warn(`[analyzer] analyzeSong(${videoId}) compute failed`, e);
    return false;
  } finally {
    await RNFS.unlink(tempPath).catch(() => {});
  }
}

// Per-stage timeouts (Plan D Task 6b): a batch "Analyze playlist" run must
// never hang on one bad song -- a stuck network read, a stream host that
// never responds, or a corrupt file that wedges the native decoder should
// fail THAT song (doAnalyze's existing catch-all already turns any thrown
// error into `false`, logged and cleanup-then-continue) rather than stall
// every song queued behind it. Budgets are generous relative to the ~20-30s/
// song target this task aims for, so they only fire on genuinely stuck
// stages, not slow-but-progressing ones. Note a timeout doesn't cancel the
// underlying native/network work (neither RNFS nor the AudioMel native
// module expose cancellation) -- it just stops THIS call from waiting on it,
// which is what keeps the batch moving; the abandoned work finishes (or
// fails) on its own with no further effect since nothing awaits it anymore.
const STAGE_TIMEOUT_MS = {
  // Generous because a failed direct resolve triggers the search fallback
  // (a search + up to a few player probes for a playable alternate).
  resolve: 45_000,
  download: 90_000,
  decode: 60_000,
  infer: 30_000,
} as const;

function withTimeout<T>(promise: Promise<T>, ms: number, stage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`analyzeSong: stage '${stage}' timed out after ${ms}ms`));
    }, ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * STAGE 1 (network, unlocked): resolve a stream URL + download the audio to a
 * temp file. Returns the temp path; throws on failure. The caller owns
 * deleting the file. 'lowest' bitrate: analysis downsamples to 16kHz mono, so
 * audio quality is irrelevant to the fingerprint but download SIZE is the
 * dominant network cost. A BOUNDED range header defeats googlevideo's
 * stream throttling (see the long note this replaced).
 */
async function downloadStage(videoId: string): Promise<string> {
  // Look up title/artist so resolveStreamUrl's search-fallback can find a
  // playable alternate for unplayable "- Topic" tracks (see resolver.ts).
  let meta: {title?: string; artist?: string} = {};
  try {
    const db = await ensureBaseSchema();
    try {
      const s = db.getSong(videoId);
      if (s) meta = {title: s.title, artist: s.artist};
    } finally {
      db.close();
    }
  } catch {
    // no meta -> resolver just skips the search fallback
  }
  const stream = await withTimeout(
    resolveStreamUrl(videoId, {quality: 'lowest', ...meta}),
    STAGE_TIMEOUT_MS.resolve,
    'resolve',
  );
  const tempPath = tempAudioPath(videoId);
  const {promise} = RNFS.downloadFile({
    fromUrl: stream.url,
    toFile: tempPath,
    headers: {...stream.headers, Range: 'bytes=0-12582911'},
  });
  const result = await withTimeout(promise, STAGE_TIMEOUT_MS.download, 'download');
  if (result.statusCode < 200 || result.statusCode >= 300) {
    await RNFS.unlink(tempPath).catch(() => {});
    throw new Error(`download failed: HTTP ${result.statusCode}`);
  }
  return tempPath;
}

/**
 * STAGE 2 (CPU-heavy, runs under the mutex): decode the downloaded file ->
 * mel -> embedding + moods -> write the features row. Returns true if a row
 * exists after (freshly written, or already present -- another path may have
 * analyzed it while this one waited for the mutex). Throws on real failure.
 * Does NOT delete tempPath (the caller does).
 */
async function computeStage(videoId: string, tempPath: string): Promise<boolean> {
  const db = await ensureBaseSchema();
  try {
    if (db.hasFeatures(videoId)) return true;
    const patches = await withTimeout(decodeAndMel(tempPath), STAGE_TIMEOUT_MS.decode, 'decode');
    if (patches.length === 0) {
      throw new Error('decodeAndMel produced 0 mel patches (silent, too-short, or undecodable audio)');
    }
    const {embedding, moods} = await withTimeout(
      analyzeEmbeddingAndMoods(patches),
      STAGE_TIMEOUT_MS.infer,
      'infer',
    );
    db.storeFeatures(videoId, embedding, moods);
    db.setMeta('model_version', MODEL_VERSION);
    return true;
  } finally {
    db.close();
  }
}

export interface AnalyzeManyHandle {
  /** Resolves once every id has been attempted or cancel() was called. */
  promise: Promise<{done: number; total: number; cancelled: boolean}>;
  /** Stops the loop before starting the next not-yet-attempted song. */
  cancel: () => void;
}

/**
 * Sequentially analyzes a list of songs (e.g. "Analyze playlist"),
 * reporting progress after each one and skipping any already analyzed
 * (analyzeSong's own skip check) -- so calling this again with the same or
 * a superset list simply resumes where a previous run left off or was
 * cancelled. Deliberately sequential, not parallel: analyzeSong's mutex
 * would serialize the heavy work anyway, and a plain for-loop keeps
 * progress accounting (and cancellation) trivial to reason about and test.
 */
export function analyzeMany(
  videoIds: string[],
  onProgress?: (done: number, total: number) => void,
): AnalyzeManyHandle {
  const total = videoIds.length;
  let cancelled = false;

  const promise = (async () => {
    let done = 0;
    for (const videoId of videoIds) {
      if (cancelled) break;
      await analyzeSong(videoId);
      done += 1;
      onProgress?.(done, total);
    }
    return {done, total, cancelled};
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
    },
  };
}

// --- module-level batch controller ------------------------------------
// The batch used to live in PlaylistScreen's state, so navigating away (or
// backgrounding) unmounted the screen and CANCELLED analysis -- you had to
// sit and watch a progress bar. This moves the running batch to module scope
// so it survives navigation and any screen can subscribe to / start / cancel
// it. (App-kill survival is a separate step: a native foreground service.)
//
// It also tracks OK vs FAILED per song instead of counting every attempt as
// "done" -- so the UI can honestly show "N analyzed, M failed" and offer a
// retry, rather than a failure looking like progress (which hid the analysis
// bug for a whole session).

export interface BatchState {
  running: boolean;
  /** Playlist this batch belongs to (for the UI to know which screen owns it). */
  playlistId: string | null;
  total: number;
  /** Attempts completed (ok + failed). */
  done: number;
  /** Songs a features row exists for after the attempt. */
  ok: number;
  /** videoIds whose analysis attempt failed (network/decode/etc). */
  failed: string[];
  /** True when the batch stopped because Wi-Fi-only is on but we're on
   * cellular -- it auto-resumes when Wi-Fi returns (see pendingResume). */
  pausedForNetwork: boolean;
  /** True when the batch stopped because the phone is low and unplugged (and
   * "pause on low battery" is on) -- auto-resumes when charging or recovered. */
  pausedForBattery: boolean;
  /** True after cancel is requested but before the in-flight song finishes and
   * the loop exits -- lets the UI show "Stopping…" instead of a stale count. */
  cancelling: boolean;
}

const IDLE: BatchState = {
  running: false,
  playlistId: null,
  total: 0,
  done: 0,
  ok: 0,
  failed: [],
  pausedForNetwork: false,
  pausedForBattery: false,
  cancelling: false,
};

let batchState: BatchState = IDLE;
let batchCancelled = false;
const batchListeners = new Set<(s: BatchState) => void>();

// Wakeup channel for the pipelined batchLoop's parked producer/consumer.
// Module-level (not local to batchLoop) so cancelAnalysisBatch() can WAKE a
// parked loop -- otherwise setting batchCancelled while a loop is asleep on
// `changed()` would hang it forever (the service would never tear down).
let batchWaiters: Array<() => void> = [];
function signalBatch(): void {
  const ws = batchWaiters;
  batchWaiters = [];
  for (const w of ws) w();
}

function emitBatch() {
  const snapshot = {...batchState, failed: [...batchState.failed]};
  for (const l of batchListeners) l(snapshot);
}

/** Current batch state (snapshot). */
export function getAnalysisBatch(): BatchState {
  return {...batchState, failed: [...batchState.failed]};
}

/** Subscribe to batch-state changes; returns an unsubscribe fn. */
export function subscribeAnalysisBatch(cb: (s: BatchState) => void): () => void {
  batchListeners.add(cb);
  cb(getAnalysisBatch());
  return () => {
    batchListeners.delete(cb);
  };
}

/** Cancel the running batch (stops before the next not-yet-attempted song). */
export function cancelAnalysisBatch(): void {
  batchCancelled = true;
  pendingResume = null; // an explicit cancel shouldn't auto-resume later
  if (batchState.running) {
    batchState = {...batchState, cancelling: true}; // UI shows "Stopping…" now
    emitBatch();
  }
  signalBatch(); // wake a parked producer/consumer so the loop can exit now
}

/**
 * Start analyzing `videoIds` as the module-level batch. No-op if a batch is
 * already running. Survives screen navigation (it's module state, not screen
 * state). Skips already-analyzed songs via analyzeSong's own check, so it's
 * naturally resumable. Notifies subscribers after every song.
 */
export function startAnalysisBatch(videoIds: string[], playlistId: string | null): void {
  if (batchState.running) return;
  batchCancelled = false;
  pendingResume = null;
  batchState = {
    running: true,
    playlistId,
    total: videoIds.length,
    done: 0,
    ok: 0,
    failed: [],
    pausedForNetwork: false,
    pausedForBattery: false,
    cancelling: false,
  };
  emitBatch();

  // Hold the process foreground (native AnalysisForegroundService) so the loop
  // keeps running when the app is backgrounded/screen-off, then run the loop
  // in JS. The service calls startForeground() synchronously in native code,
  // so there's no JS-timing race (the bug that made the old lib crash). Bare
  // loop if the module is missing (jest).
  void runBatch(videoIds, playlistId);
}

async function runBatch(videoIds: string[], playlistId: string | null): Promise<void> {
  try {
    analysisService?.start(NOTIF_TITLE, `0/${videoIds.length}`);
  } catch {
    // never let a service hiccup stop analysis
  }
  try {
    await batchLoop(videoIds, playlistId);
  } finally {
    try {
      analysisService?.stop();
    } catch {
      // ignore
    }
  }
}

// Depth of the download-ahead buffer (B3 pipeline). Compute is the on-device
// bottleneck, so 2 ready files is enough to keep the (single) compute stage
// fed while the next downloads happen in parallel -- more just wastes disk
// (see the "one cashier, one restocker" reasoning). Overlap makes throughput
// ~max(download, compute)/song instead of download+compute.
const DOWNLOAD_AHEAD = 2;

function bumpBatch(ok: boolean, videoId: string): void {
  batchState = {
    ...batchState,
    done: batchState.done + 1,
    ok: batchState.ok + (ok ? 1 : 0),
    failed: ok ? batchState.failed : [...batchState.failed, videoId],
  };
  emitBatch();
  try {
    analysisService?.update(NOTIF_TITLE, notifText());
  } catch {
    // ignore notification-update failures
  }
}

async function alreadyAnalyzed(videoId: string): Promise<boolean> {
  try {
    const db = await ensureBaseSchema();
    try {
      return db.hasFeatures(videoId);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/**
 * Pipelined batch: a producer downloads up to DOWNLOAD_AHEAD songs in parallel
 * with a consumer that computes them one at a time (compute is CPU-bound and
 * serialized via computeStage's mutex). Download of song N+1 overlaps compute
 * of song N. Preserves the Wi-Fi guard, cancel, per-song ok/failed accounting,
 * and paused-for-network resume of the old serial loop.
 */
async function batchLoop(videoIds: string[], playlistId: string | null): Promise<void> {
  const ready: Array<{videoId: string; tempPath: string}> = [];
  let producerDone = false;
  let pausedForNet = false;
  let pausedForBat = false;
  const changed = () => new Promise<void>(r => batchWaiters.push(r));

  const producer = (async () => {
    for (let i = 0; i < videoIds.length; i++) {
      if (batchCancelled) break;
      if (!allowedNetworkNow() || !batteryOkNow()) {
        // Pause: hand the not-yet-downloaded remainder to the resume listener.
        pendingResume = {ids: videoIds.slice(i), playlistId};
        pausedForNet = !allowedNetworkNow();
        pausedForBat = !batteryOkNow();
        break;
      }
      const videoId = videoIds[i];
      if (await alreadyAnalyzed(videoId)) {
        bumpBatch(true, videoId); // shared across playlists -> no work needed
        continue;
      }
      // Backpressure: don't get more than DOWNLOAD_AHEAD ahead of compute.
      while (ready.length >= DOWNLOAD_AHEAD && !batchCancelled) await changed();
      if (batchCancelled) break;
      try {
        const tempPath = await downloadStage(videoId);
        ready.push({videoId, tempPath});
      } catch (e) {
        console.warn(`[analyzer] download ${videoId} failed`, e);
        bumpBatch(false, videoId);
      }
      signalBatch();
    }
    producerDone = true;
    signalBatch();
  })();

  const consumer = (async () => {
    while (true) {
      while (ready.length === 0 && !producerDone && !batchCancelled) await changed();
      if (batchCancelled) break;
      if (ready.length === 0) {
        if (producerDone) break;
        continue;
      }
      const {videoId, tempPath} = ready.shift()!;
      signalBatch(); // freed a slot -> producer may download the next
      try {
        const ok = await runExclusive(() => computeStage(videoId, tempPath));
        bumpBatch(ok, videoId);
      } catch (e) {
        console.warn(`[analyzer] compute ${videoId} failed`, e);
        bumpBatch(false, videoId);
      } finally {
        await RNFS.unlink(tempPath).catch(() => {});
      }
    }
  })();

  await Promise.all([producer, consumer]);

  // Clean up any downloaded-but-unconsumed files (cancel / pause path).
  for (const {tempPath} of ready) await RNFS.unlink(tempPath).catch(() => {});

  batchState = {
    ...batchState,
    running: false,
    pausedForNetwork: pausedForNet,
    pausedForBattery: pausedForBat,
    cancelling: false,
  };
  emitBatch();
}

/** Re-run just the failed songs from the last batch (the "retry" action). */
export function retryFailedAnalysis(playlistId: string | null): void {
  if (batchState.running) return;
  const toRetry = batchState.failed;
  if (toRetry.length === 0) return;
  startAnalysisBatch(toRetry, playlistId);
}

// --- Wi-Fi / network guard --------------------------------------------
// Auto-analyze downloads audio for the whole library; on cellular that can be
// a lot of data. When "Wi-Fi only" is on (default), batches only run on Wi-Fi
// (or ethernet) and PAUSE on cellular, auto-resuming when Wi-Fi is back and
// the app is foregrounded (starting the foreground service from background is
// itself disallowed). Manual/explicit batches respect the same setting -- if
// you truly want cellular, turn the toggle off.

const WIFI_ONLY_KEY = 'flowstate.analyzeWifiOnly.v1';
let analyzeWifiOnly = true;
let currentIsWifi = true; // optimistic until the first NetInfo fetch resolves
let pendingResume: {ids: string[]; playlistId: string | null} | null = null;
let netListenersArmed = false;

function allowedNetworkNow(): boolean {
  return !analyzeWifiOnly || currentIsWifi;
}

/** Resume a network-paused batch once Wi-Fi is back AND the app is active. */
function maybeResume(): void {
  if (!pendingResume) return;
  if (batchState.running) return;
  if (!autoAnalyzeEnabled && batchState.playlistId === null) return;
  if (!allowedNetworkNow()) return;
  if (!batteryOkNow()) return;
  if (AppState.currentState !== 'active') return; // never start FGS from bg
  const {ids, playlistId} = pendingResume;
  pendingResume = null;
  startAnalysisBatch(ids, playlistId);
}

function armNetListeners(): void {
  if (netListenersArmed) return;
  netListenersArmed = true;
  NetInfo.addEventListener(state => {
    currentIsWifi = state.type === 'wifi' || state.type === 'ethernet';
    if (currentIsWifi) maybeResume();
  });
  AppState.addEventListener('change', s => {
    if (s === 'active') maybeResume();
  });
  void NetInfo.fetch().then(state => {
    currentIsWifi = state.type === 'wifi' || state.type === 'ethernet';
  });
  armBatteryListener();
}

export async function isAnalyzeWifiOnly(): Promise<boolean> {
  await ensureAutoPref();
  return analyzeWifiOnly;
}

export async function setAnalyzeWifiOnly(enabled: boolean): Promise<void> {
  analyzeWifiOnly = enabled;
  try {
    await AsyncStorage.setItem(WIFI_ONLY_KEY, enabled ? '1' : '0');
  } catch {
    // best-effort
  }
  if (enabled && batchState.running && !allowedNetworkNow()) {
    // Turned Wi-Fi-only on while running on cellular -> the loop's per-song
    // guard will pause at the next song; nothing else to do here.
  } else if (!enabled) {
    // Turned it off -> cellular is now allowed; pick up any paused batch.
    maybeResume();
  }
}

// --- battery guard -----------------------------------------------------
// Analysis is CPU-heavy (decode + repeated TFLite inference); running it on a
// low, unplugged phone drains the battery the user needs. When "pause on low
// battery" is on (default), a background batch pauses below PAUSE_BELOW and
// auto-resumes once charging or recovered past RESUME_AT (hysteresis so it
// doesn't flap around the threshold). Charging always allows analysis.

const BATTERY_KEY = 'flowstate.analyzePauseLowBattery.v1';
const PAUSE_BELOW = 0.2;
const RESUME_AT = 0.25;
let pauseLowBattery = true;
// Optimistic until the first native read resolves -- assume plugged & full so
// analysis is never wedged off before we know the real state.
let currentBattery: {level: number; charging: boolean} = {level: 1, charging: true};
// Hysteresis latch: once we drop below PAUSE_BELOW we stay "blocking" until we
// climb back to RESUME_AT (or plug in), instead of toggling at a single point.
let batteryBlocking = false;
let batteryListenerArmed = false;

function recomputeBatteryBlocking(): void {
  if (currentBattery.charging) {
    batteryBlocking = false;
  } else if (currentBattery.level < PAUSE_BELOW) {
    batteryBlocking = true;
  } else if (currentBattery.level >= RESUME_AT) {
    batteryBlocking = false;
  }
  // Between PAUSE_BELOW and RESUME_AT while discharging: keep prior state.
}

function batteryOkNow(): boolean {
  return !pauseLowBattery || !batteryBlocking;
}

function armBatteryListener(): void {
  if (batteryListenerArmed) return;
  batteryListenerArmed = true;
  const svc = analysisService;
  if (!svc?.getBatteryStatus) return; // native module missing (e.g. tests)
  void svc.getBatteryStatus().then(b => {
    if (b) currentBattery = b;
    recomputeBatteryBlocking();
  });
  svc.startBatteryUpdates?.();
  const emitter = new NativeEventEmitter(NativeModules.AnalysisService);
  emitter.addListener('flowstateBattery', (b: {level: number; charging: boolean}) => {
    currentBattery = b;
    const wasBlocking = batteryBlocking;
    recomputeBatteryBlocking();
    if (wasBlocking && !batteryBlocking) maybeResume(); // recovered/plugged in
  });
}

export async function isAnalyzePauseLowBattery(): Promise<boolean> {
  await ensureAutoPref();
  return pauseLowBattery;
}

export async function setAnalyzePauseLowBattery(enabled: boolean): Promise<void> {
  pauseLowBattery = enabled;
  try {
    await AsyncStorage.setItem(BATTERY_KEY, enabled ? '1' : '0');
  } catch {
    // best-effort
  }
  // Turned the guard off -> low battery no longer blocks; pick up any batch
  // that was paused for battery.
  if (!enabled) maybeResume();
}

// --- auto-analyze ------------------------------------------------------
// Analysis should just HAPPEN once the library is synced -- no manual
// "Analyze playlist" tap. The whole library is analyzed in the background
// (foreground service) as one global batch (playlistId = null), deduped by
// videoId so a song in five playlists is analyzed once. A per-session guard
// keeps re-focusing Library from restarting it, and a persisted toggle lets
// the user turn it off.

const AUTO_ANALYZE_KEY = 'flowstate.autoAnalyze.v1';
let autoAnalyzeEnabled = true;
let autoAnalyzePrefLoaded = false;
let autoStartedThisSession = false;

async function ensureAutoPref(): Promise<void> {
  if (autoAnalyzePrefLoaded) return;
  try {
    const [auto, wifi, battery] = await Promise.all([
      AsyncStorage.getItem(AUTO_ANALYZE_KEY),
      AsyncStorage.getItem(WIFI_ONLY_KEY),
      AsyncStorage.getItem(BATTERY_KEY),
    ]);
    autoAnalyzeEnabled = auto == null ? true : auto === '1';
    analyzeWifiOnly = wifi == null ? true : wifi === '1';
    pauseLowBattery = battery == null ? true : battery === '1';
  } catch {
    autoAnalyzeEnabled = true;
    analyzeWifiOnly = true;
    pauseLowBattery = true;
  }
  autoAnalyzePrefLoaded = true;
  armNetListeners();
}

export async function isAutoAnalyzeEnabled(): Promise<boolean> {
  await ensureAutoPref();
  return autoAnalyzeEnabled;
}

export async function setAutoAnalyzeEnabled(enabled: boolean): Promise<void> {
  autoAnalyzeEnabled = enabled;
  autoAnalyzePrefLoaded = true;
  try {
    await AsyncStorage.setItem(AUTO_ANALYZE_KEY, enabled ? '1' : '0');
  } catch {
    // best-effort; in-memory value still applies this session
  }
  if (!enabled && batchState.running && batchState.playlistId === null) {
    // Turning auto off cancels the *global* auto batch (leaves an explicit
    // per-playlist batch alone).
    cancelAnalysisBatch();
  }
}

/**
 * Auto-start a background analysis of the whole library (all currently
 * unanalyzed songs) as a global batch. No-op if: auto is off, we already
 * auto-started this app session, a batch is already running, or there's
 * nothing to analyze. Safe to call on every Library focus -- the guards make
 * it idempotent for the session.
 */
export async function autoStartAnalysis(unanalyzedVideoIds: string[]): Promise<void> {
  await ensureAutoPref();
  if (
    !autoAnalyzeEnabled ||
    autoStartedThisSession ||
    batchState.running ||
    unanalyzedVideoIds.length === 0
  ) {
    return;
  }
  autoStartedThisSession = true;
  // DEFER the foreground-service start. Starting it during app cold-start
  // races Android's "startForegroundService() must call startForeground()
  // within 5s" rule -- on a congested cold-start the service dispatch can
  // miss that window and the OS crashes the process
  // (ForegroundServiceDidNotStartInTimeException), which made the app fail to
  // open ~2 of 3 launches. Wait for the app to settle AND be actually
  // foregrounded (starting an FGS from background is itself disallowed).
  setTimeout(() => {
    if (batchState.running) return;
    if (AppState.currentState !== 'active') return;
    if (!allowedNetworkNow() || !batteryOkNow()) {
      // On cellular with Wi-Fi-only on, or low & unplugged: don't start now.
      // Park the work so the network/battery/appstate listener starts it once
      // the condition clears.
      pendingResume = {ids: unanalyzedVideoIds, playlistId: null};
      batchState = {
        ...IDLE,
        pausedForNetwork: !allowedNetworkNow(),
        pausedForBattery: !batteryOkNow(),
      };
      emitBatch();
      return;
    }
    startAnalysisBatch(unanalyzedVideoIds, null);
  }, 4000);
}
