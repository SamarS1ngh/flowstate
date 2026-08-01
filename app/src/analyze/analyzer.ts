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
import {AppState} from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import * as RNFS from '@dr.pogodin/react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {resolveStreamUrl} from '../stream/resolver';
import {decodeAndMel} from './audio';
import {analyzeEmbeddingAndMoods} from './tflite';
import {ensureBaseSchema} from '../db/vibesDb';

// Android foreground-service wrapper (keeps the analysis loop alive while the
// app is backgrounded / screen off). Loaded defensively -- null under jest or
// if the native module is missing, in which case the batch runs bare (still
// fine while the app is foregrounded). Minimal surface we use, typed loosely.
interface BatchServiceLike {
  start(task: () => Promise<void>, options: unknown): Promise<void>;
  stop(): Promise<void>;
  updateNotification(opts: {taskDesc: string}): Promise<void>;
  isRunning(): boolean;
}
let batchService: BatchServiceLike | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  batchService = require('react-native-background-actions').default as BatchServiceLike;
} catch {
  batchService = null;
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

  return runExclusive(() => doAnalyze(videoId));
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
  resolve: 20_000,
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

async function doAnalyze(videoId: string): Promise<boolean> {
  let tempPath: string | undefined;
  // __DEV__-gated stage timing (Plan D Task 6b): cheap enough to leave in
  // permanently (a handful of Date.now() calls + one console.log per song),
  // and stripped from release builds automatically since __DEV__ is
  // compiled out -- see the Task 6b report for the profiled breakdown this
  // produced on-device.
  const t0 = __DEV__ ? Date.now() : 0;
  try {
    const db = await ensureBaseSchema();
    try {
      // Re-check now that we hold the lock: another queued job (or the
      // pre-check race) may have analyzed this exact song while this call
      // was waiting its turn.
      if (db.hasFeatures(videoId)) return true;

      // 'lowest' bitrate: analysis downsamples to 16kHz mono, so audio
      // quality is irrelevant to the fingerprint but download SIZE is the
      // dominant per-song cost -- the smallest audio format is fastest.
      const stream = await withTimeout(
        resolveStreamUrl(videoId, {quality: 'lowest'}),
        STAGE_TIMEOUT_MS.resolve,
        'resolve',
      );
      const tResolve = __DEV__ ? Date.now() : 0;

      tempPath = tempAudioPath(videoId);
      const {promise} = RNFS.downloadFile({
        fromUrl: stream.url,
        toFile: tempPath,
        // A BOUNDED range (`bytes=0-N`, not open-ended `bytes=0-`) defeats
        // googlevideo's stream throttling: an open-ended range is served at
        // ~playback speed (so a multi-minute track blows past the download
        // timeout -- the real cause of "analysis is so slow": every song was
        // failing on download, not analyzing), while a bounded range is
        // delivered in one fast burst. 12MB comfortably covers the whole of
        // any lowest-bitrate audio-only track (a 10-min track at 64kbps is
        // ~4.8MB); the server just caps at the real file end if smaller.
        headers: {...stream.headers, Range: 'bytes=0-12582911'},
      });
      const result = await withTimeout(promise, STAGE_TIMEOUT_MS.download, 'download');
      if (result.statusCode < 200 || result.statusCode >= 300) {
        throw new Error(`download failed: HTTP ${result.statusCode}`);
      }
      const tDownload = __DEV__ ? Date.now() : 0;

      const patches = await withTimeout(decodeAndMel(tempPath), STAGE_TIMEOUT_MS.decode, 'decode');
      if (patches.length === 0) {
        throw new Error('decodeAndMel produced 0 mel patches (silent, too-short, or undecodable audio)');
      }
      const tDecode = __DEV__ ? Date.now() : 0;

      const {embedding, moods} = await withTimeout(
        analyzeEmbeddingAndMoods(patches),
        STAGE_TIMEOUT_MS.infer,
        'infer',
      );
      const tInfer = __DEV__ ? Date.now() : 0;

      db.storeFeatures(videoId, embedding, moods);
      db.setMeta('model_version', MODEL_VERSION);
      if (__DEV__) {
        console.log(
          `[analyzer] ${videoId} stage timings (ms): resolve=${tResolve - t0} ` +
            `download=${tDownload - tResolve} decode+mel=${tDecode - tDownload} ` +
            `infer=${tInfer - tDecode} total=${tInfer - t0} patches=${patches.length}`,
        );
      }
      return true;
    } finally {
      db.close();
    }
  } catch (e) {
    console.warn(`[analyzer] analyzeSong(${videoId}) failed`, e);
    return false;
  } finally {
    if (tempPath) {
      await RNFS.unlink(tempPath).catch(() => {});
    }
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
}

const IDLE: BatchState = {
  running: false,
  playlistId: null,
  total: 0,
  done: 0,
  ok: 0,
  failed: [],
  pausedForNetwork: false,
};

let batchState: BatchState = IDLE;
let batchCancelled = false;
const batchListeners = new Set<(s: BatchState) => void>();

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
  };
  emitBatch();

  // Run the loop inside an Android foreground service (via
  // react-native-background-actions) so it keeps going when the app is
  // backgrounded or the screen is locked -- not just when the user switches
  // screens (that's already handled by this being module-level state). The
  // service shows a persistent "Analyzing N/M" notification and is torn down
  // when the batch finishes or is cancelled. If the native module is
  // unavailable (e.g. jest), the loop still runs, just without the service.
  void runBatchWithForegroundService(videoIds, playlistId);
}

async function batchLoop(videoIds: string[], playlistId: string | null): Promise<void> {
  for (let i = 0; i < videoIds.length; i++) {
    if (batchCancelled) break;
    // Wi-Fi guard: don't burn mobile data. If the user requires Wi-Fi and
    // we're not on it, PAUSE here -- remember the remaining songs and let the
    // network/appstate listener resume when Wi-Fi is back. analyzeSong skips
    // already-done songs, so resuming re-covers the remainder cleanly.
    if (!allowedNetworkNow()) {
      pendingResume = {ids: videoIds.slice(i), playlistId};
      batchState = {...batchState, running: false, pausedForNetwork: true};
      emitBatch();
      return;
    }
    const ok = await analyzeSong(videoIds[i]);
    batchState = {
      ...batchState,
      done: batchState.done + 1,
      ok: batchState.ok + (ok ? 1 : 0),
      failed: ok ? batchState.failed : [...batchState.failed, videoIds[i]],
    };
    emitBatch();
    if (batchService?.isRunning()) {
      const {done, total, failed} = batchState;
      await batchService
        .updateNotification({
          taskDesc: `${done}/${total}${failed.length ? ` · ${failed.length} failed` : ''}`,
        })
        .catch(() => {});
    }
  }
  batchState = {...batchState, running: false};
  emitBatch();
}

async function runBatchWithForegroundService(
  videoIds: string[],
  playlistId: string | null,
): Promise<void> {
  if (!batchService) {
    // No foreground-service module (tests / unsupported) -- run bare.
    await batchLoop(videoIds, playlistId);
    return;
  }
  const options = {
    taskName: 'flowstateAnalysis',
    taskTitle: 'Analyzing your music',
    taskDesc: `0/${videoIds.length}`,
    taskIcon: {name: 'ic_launcher', type: 'mipmap'},
    color: '#5b8def',
    linkingURI: 'flowstate://library',
    // REQUIRED on Android 14+ (targetSDK 34+): the service must start with a
    // declared foregroundServiceType or the OS kills the process
    // (InvalidForegroundServiceTypeException "type none"). Analysis downloads +
    // processes audio -> dataSync. Must also be declared in AndroidManifest on
    // the RNBackgroundActionsTask service + hold FOREGROUND_SERVICE_DATA_SYNC.
    foregroundServiceType: ['dataSync'],
  };
  try {
    // BackgroundService.start runs the task (our loop) inside the FGS and
    // resolves when the task returns; stop() removes the notification.
    // Yield ~1.2s at the very start of the task BEFORE any heavy work so the
    // service's startForeground() call wins Android's 5s window -- kicking off
    // analyzeSong (network + native decode) immediately congests the bridge
    // and made the OS throw ForegroundServiceDidNotStartInTimeException,
    // crashing the app intermittently on Android 14/15.
    await batchService.start(async () => {
      await new Promise(r => setTimeout(r, 1200));
      await batchLoop(videoIds, playlistId);
    }, options);
  } catch {
    // Starting the service failed (e.g. OS restriction) -- fall back to a
    // bare loop so analysis still proceeds while the app is foregrounded.
    if (batchState.running && batchState.done === 0) await batchLoop(videoIds, playlistId);
  } finally {
    await batchService.stop().catch(() => {});
  }
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
    const [auto, wifi] = await Promise.all([
      AsyncStorage.getItem(AUTO_ANALYZE_KEY),
      AsyncStorage.getItem(WIFI_ONLY_KEY),
    ]);
    autoAnalyzeEnabled = auto == null ? true : auto === '1';
    analyzeWifiOnly = wifi == null ? true : wifi === '1';
  } catch {
    autoAnalyzeEnabled = true;
    analyzeWifiOnly = true;
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
    if (!allowedNetworkNow()) {
      // On cellular with Wi-Fi-only on: don't start now. Park the work so the
      // network/appstate listener starts it once Wi-Fi is back.
      pendingResume = {ids: unanalyzedVideoIds, playlistId: null};
      batchState = {...IDLE, pausedForNetwork: true};
      emitBatch();
      return;
    }
    startAnalysisBatch(unanalyzedVideoIds, null);
  }, 4000);
}
