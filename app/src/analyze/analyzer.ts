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
import * as RNFS from '@dr.pogodin/react-native-fs';
import {resolveStreamUrl} from '../stream/resolver';
import {decodeAndMel} from './audio';
import {analyzeEmbeddingAndMoods} from './tflite';
import {ensureBaseSchema} from '../db/vibesDb';

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
  download: 60_000,
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

      const stream = await withTimeout(resolveStreamUrl(videoId), STAGE_TIMEOUT_MS.resolve, 'resolve');
      const tResolve = __DEV__ ? Date.now() : 0;

      tempPath = tempAudioPath(videoId);
      const {promise} = RNFS.downloadFile({
        fromUrl: stream.url,
        toFile: tempPath,
        headers: stream.headers,
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
