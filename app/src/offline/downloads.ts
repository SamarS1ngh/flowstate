import * as RNFS from '@dr.pogodin/react-native-fs';
import NetInfo from '@react-native-community/netinfo';
import {resolveStreamUrl, StreamResolveError} from '../stream/resolver';
import {ensureBaseSchema} from '../db/vibesDb';
import {isAnalyzeWifiOnly} from '../analyze/analyzer';

// Where offline audio lives. DocumentDirectory (not Temporary/Caches) so the OS
// won't reclaim it -- these files must survive until the user deletes them.
const OFFLINE_DIR = `${RNFS.DocumentDirectoryPath}/offline`;

// Full-file download can't be Range-bounded the way analysis clips are (we need
// the whole song), and googlevideo serves open-ended GETs at ~playback speed,
// so a few-minute track can take tens of seconds. Generous per-song ceiling.
const DOWNLOAD_TIMEOUT_MS = 180_000;

// In-memory index of downloaded videoId -> local path. offlineUrl() runs on the
// playback HOT PATH (every load() and every prefetch); opening the db there
// (ensureBaseSchema does a synchronous connection-open + full schema DDL on the
// JS thread) stalled the UI and delayed playback. So we load the index from the
// db exactly ONCE, then keep it in sync on add/remove/clear -- after that,
// offlineUrl is a pure in-memory lookup for the common (no-downloads) case.
let downloadIndex: Map<string, string> | null = null;
let indexLoading: Promise<Map<string, string>> | null = null;

async function getIndex(): Promise<Map<string, string>> {
  if (downloadIndex) return downloadIndex;
  if (!indexLoading) {
    indexLoading = (async () => {
      const db = await ensureBaseSchema();
      try {
        const m = new Map<string, string>();
        for (const r of db.getDownloads()) m.set(r.videoId, r.path);
        downloadIndex = m;
        return m;
      } finally {
        db.close();
      }
    })();
  }
  return indexLoading;
}

/** Test-only: drop the in-memory index so each test reloads from its mock db. */
export function _resetDownloadCacheForTests(): void {
  downloadIndex = null;
  indexLoading = null;
}

function filePath(videoId: string): string {
  // videoIds are [A-Za-z0-9_-]{11}; safe as a filename. Extension is cosmetic --
  // ExoPlayer sniffs the container (m4a/webm-opus/mp3) from content.
  return `${OFFLINE_DIR}/${videoId}.audio`;
}

async function ensureDir(): Promise<void> {
  const exists = await RNFS.exists(OFFLINE_DIR);
  if (!exists) await RNFS.mkdir(OFFLINE_DIR);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Local file:// URL to play a song offline, or null if it isn't downloaded (or
 * its file went missing). controller.load() calls this FIRST so a downloaded
 * song plays instantly from disk with no network resolve at all.
 */
export async function offlineUrl(videoId: string): Promise<string | null> {
  const idx = await getIndex();
  const path = idx.get(videoId);
  if (!path) return null; // common case: not downloaded -> no db, no fs touch
  // Guard against a dangling row whose file was deleted out from under us.
  const exists = await RNFS.exists(path);
  if (!exists) {
    await removeDownload(videoId).catch(() => {});
    return null;
  }
  return path.startsWith('file://') ? path : `file://${path}`;
}

/**
 * Download one song's full audio for offline playback. Idempotent (already-
 * downloaded -> true immediately). Returns false on any failure without
 * throwing, so batch callers can tally failures. Uses the resolver's
 * search-fallback (via title/artist) to recover unplayable "- Topic" ids.
 */
export async function downloadSong(videoId: string): Promise<boolean> {
  const db = await ensureBaseSchema();
  let meta: {title?: string; artist?: string} = {};
  try {
    if (db.getDownloadPath(videoId)) return true;
    const s = db.getSong(videoId);
    if (s) meta = {title: s.title, artist: s.artist};
  } finally {
    db.close();
  }

  const path = filePath(videoId);
  try {
    const stream = await withTimeout(
      resolveStreamUrl(videoId, {quality: 'highest', ...meta}),
      DOWNLOAD_TIMEOUT_MS,
      'resolve',
    );
    await ensureDir();
    const {promise} = RNFS.downloadFile({
      fromUrl: stream.url,
      toFile: path,
      headers: stream.headers,
    });
    const result = await withTimeout(promise, DOWNLOAD_TIMEOUT_MS, 'download');
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`download failed: HTTP ${result.statusCode}`);
    }
    const stat = await RNFS.stat(path);
    const bytes = Number(stat.size) || 0;
    if (bytes <= 0) throw new Error('download produced an empty file');
    const writeDb = await ensureBaseSchema();
    try {
      writeDb.addDownload(videoId, path, bytes, Date.now());
    } finally {
      writeDb.close();
    }
    (await getIndex()).set(videoId, path); // keep hot-path index in sync
    return true;
  } catch (e) {
    if (!(e instanceof StreamResolveError)) console.warn(`[downloads] ${videoId} failed`, e);
    await RNFS.unlink(path).catch(() => {});
    return false;
  }
}

/** Delete a single download (file + row). Safe if either is already gone. */
export async function removeDownload(videoId: string): Promise<void> {
  const db = await ensureBaseSchema();
  let path: string | null = null;
  try {
    path = db.getDownloadPath(videoId);
    db.removeDownload(videoId);
  } finally {
    db.close();
  }
  downloadIndex?.delete(videoId);
  if (path) await RNFS.unlink(path).catch(() => {});
}

/** Delete every download (all files + rows). Returns count removed. */
export async function removeAllDownloads(): Promise<number> {
  const db = await ensureBaseSchema();
  let rows: Array<{videoId: string; path: string; bytes: number}> = [];
  try {
    rows = db.getDownloads();
    db.clearDownloads();
  } finally {
    db.close();
  }
  downloadIndex?.clear();
  for (const r of rows) await RNFS.unlink(r.path).catch(() => {});
  return rows.length;
}

/** {count, bytes} of everything downloaded -- for the Settings storage view. */
export async function getStorageInfo(): Promise<{count: number; bytes: number}> {
  const db = await ensureBaseSchema();
  try {
    return {count: db.getDownloads().length, bytes: db.getDownloadsTotalBytes()};
  } finally {
    db.close();
  }
}

// --- batch downloader --------------------------------------------------
// User-initiated "Download playlist for offline". Serial (one at a time --
// full-quality files are large and there's no CPU overlap benefit like the
// analyzer's pipeline has). Module-level so progress survives navigation, and
// respects the same Wi-Fi-only setting as analysis (downloads are large data).

export interface DownloadBatchState {
  running: boolean;
  total: number;
  done: number;
  ok: number;
  failed: string[];
  cancelling: boolean;
  /** Stopped because Wi-Fi-only is on and we're on cellular. */
  pausedForNetwork: boolean;
}

const IDLE: DownloadBatchState = {
  running: false,
  total: 0,
  done: 0,
  ok: 0,
  failed: [],
  cancelling: false,
  pausedForNetwork: false,
};

let batch: DownloadBatchState = IDLE;
let cancelled = false;
const subscribers = new Set<(s: DownloadBatchState) => void>();

function emit(): void {
  for (const cb of subscribers) cb(batch);
}

export function subscribeDownloadBatch(cb: (s: DownloadBatchState) => void): () => void {
  subscribers.add(cb);
  cb(batch);
  return () => subscribers.delete(cb);
}

export function getDownloadBatch(): DownloadBatchState {
  return batch;
}

export function cancelDownloadBatch(): void {
  if (!batch.running) return;
  cancelled = true;
  batch = {...batch, cancelling: true};
  emit();
}

async function onWifiIfRequired(): Promise<boolean> {
  const wifiOnly = await isAnalyzeWifiOnly();
  if (!wifiOnly) return true;
  const state = await NetInfo.fetch();
  return state.type === 'wifi' || state.type === 'ethernet';
}

export async function startDownloadBatch(videoIds: string[]): Promise<void> {
  if (batch.running) return;
  cancelled = false;

  // Skip already-downloaded ids up front so total/progress reflect real work.
  const have = await getIndex();
  const pending = videoIds.filter(id => !have.has(id));

  if (pending.length === 0) {
    batch = {...IDLE};
    emit();
    return;
  }

  if (!(await onWifiIfRequired())) {
    batch = {...IDLE, total: pending.length, pausedForNetwork: true};
    emit();
    return;
  }

  batch = {...IDLE, running: true, total: pending.length};
  emit();

  for (const videoId of pending) {
    if (cancelled) break;
    if (!(await onWifiIfRequired())) {
      batch = {...batch, running: false, pausedForNetwork: true, cancelling: false};
      emit();
      return;
    }
    const ok = await downloadSong(videoId);
    batch = {
      ...batch,
      done: batch.done + 1,
      ok: batch.ok + (ok ? 1 : 0),
      failed: ok ? batch.failed : [...batch.failed, videoId],
    };
    emit();
  }

  batch = {...batch, running: false, cancelling: false};
  emit();
}
