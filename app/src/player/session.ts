// Persisted playback session: the last-played track survives the app being
// killed, so relaunching (even hours or days later) shows it in the mini player
// and lets the user resume near where they left off.
//
// Layering note: this module sits ABOVE the controller -- it imports the queue
// engines (Radio/Vibe/Simple) and the vibes db to REBUILD a source on resume.
// The controller itself stays engine-free (engines import it, never the
// reverse), so all the "which source was this / how do I recreate it" knowledge
// lives here, out of the low-level player.
import AsyncStorage from '@react-native-async-storage/async-storage';
import TrackPlayer from 'react-native-track-player';
import type {Song} from '../types';
import type {QueueSource, SourceDescriptor} from './queue';
import {SimpleQueue} from './queue';
import {RadioQueue} from '../engine/radioQueue';
import {VibeQueue} from '../engine/vibeQueue';
import {openVibesDb} from '../db/vibesDb';
import {FeedbackStore} from '../engine/feedbackStore';
import {
  currentSource,
  isAwaitingResume,
  nowPlaying,
  reportFallback,
  restoreForDisplay,
  resumeAwaiting,
  subscribeNowPlaying,
  togglePlayPause,
} from './controller';

const SESSION_KEY = 'flowstate.player.session.v1';

export interface PlaybackSnapshot {
  song: Song;
  positionS: number;
  savedAt: number;
  source: SourceDescriptor;
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Write the current live session to storage. No-op unless there's a real source
 * AND a current song: a display-only restore (source still null) must not
 * clobber the stored snapshot -- its saved position is what we resume to.
 */
export async function persistNow(): Promise<void> {
  const src = currentSource();
  const song = nowPlaying();
  if (!src || !song) return;
  let positionS = 0;
  try {
    const p = await TrackPlayer.getProgress();
    positionS = p?.position ?? 0;
  } catch {
    // no progress available -> persist position 0
  }
  const snap: PlaybackSnapshot = {
    song,
    positionS,
    savedAt: Date.now(),
    source: src.describe(),
  };
  try {
    await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(snap));
  } catch {
    // best-effort; a failed write just means a slightly older resume point
  }
}

// Coalesce bursty triggers (a skip fires many now-playing emits) into one write.
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void persistNow();
  }, 1000);
}

const PERSIST_INTERVAL_MS = 5000;
let persistTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;

/**
 * Begin persisting the session: a periodic tick (captures position as it
 * advances) plus an immediate-ish write whenever the now-playing track changes.
 * Call once at app bootstrap; returns a cleanup fn.
 */
export function startSessionPersistence(): () => void {
  stopSessionPersistence();
  persistTimer = setInterval(schedulePersist, PERSIST_INTERVAL_MS);
  unsubscribe = subscribeNowPlaying(schedulePersist);
  return stopSessionPersistence;
}

export function stopSessionPersistence(): void {
  if (persistTimer) {
    clearInterval(persistTimer);
    persistTimer = null;
  }
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

// ── Restore ─────────────────────────────────────────────────────────────────

/**
 * Load the persisted snapshot (if any), REBUILD its queue source, and show it in
 * the mini/full player -- paused, at the saved mode (vibe drift/lock + mood, or
 * radio). Does NOT start playback or touch the native player; the first play
 * press resumes it at the saved position (see controller.resumeAwaiting). Call
 * once during app bootstrap, before the UI renders.
 */
export async function restoreSession(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(SESSION_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let snap: PlaybackSnapshot;
  try {
    snap = JSON.parse(raw) as PlaybackSnapshot;
  } catch {
    return; // corrupt entry -> ignore
  }
  if (!snap || !snap.song || !snap.song.videoId) return;
  // Rebuild the real source NOW (not on first play) so the restored player shows
  // the actual mode -- VIBE·DRIFT/LOCK + mood chip, or RADIO -- instead of a
  // blank "QUEUE / END OF QUEUE". No network/native call: the vibe queue just
  // re-seeds off the restored song; radio seeds on resume.
  const src = await buildSource(snap.source, snap.song);
  restoreForDisplay(snap.song, src, snap.positionS);
}

// ── Resume ────────────────────────────────────────────────────────────────────

/**
 * The play/pause handler the UI should call. A restored-but-not-yet-resumed
 * session loads its (already-rebuilt) source at the saved position on the first
 * press; otherwise it's an ordinary play/pause toggle.
 */
export async function playPressed(isPlaying: boolean): Promise<void> {
  if (isAwaitingResume()) {
    await resumeAwaiting();
    return;
  }
  await togglePlayPause(isPlaying);
}

/** Rebuild a live QueueSource from a persisted descriptor, seeded on `seed`. */
async function buildSource(desc: SourceDescriptor, seed: Song): Promise<QueueSource> {
  if (desc.kind === 'simple') {
    return new SimpleQueue(desc.songs, desc.index);
  }
  if (desc.kind === 'vibe') {
    const vibe = await buildVibeSource(desc, seed);
    if (vibe) return vibe;
    // db missing / song no longer analyzed -> degrade to radio so resume still
    // works (radio needs no local data, just the seed).
    return new RadioQueue();
  }
  return new RadioQueue();
}

async function buildVibeSource(
  desc: Extract<SourceDescriptor, {kind: 'vibe'}>,
  seed: Song,
): Promise<QueueSource | null> {
  try {
    const db = await openVibesDb();
    if (!db) return null;
    // Mirror PlayerScreen/PlaylistScreen's vibe construction exactly.
    const vibeSongs = db.getVibeSongs('ALL');
    const seedVibe = vibeSongs.find(v => v.videoId === seed.videoId);
    if (!seedVibe) return null;
    const store = new FeedbackStore(db.handle);
    store.ensureTables();
    const feedback = store.snapshot(Date.now());
    const q = new VibeQueue(seedVibe, desc.mode, {
      songs: vibeSongs,
      feedback,
      onFallback: reportFallback,
    });
    q.setMoodFilter(desc.moodFilter);
    return q;
  } catch {
    return null;
  }
}

// Test-only: reset module state between cases.
export function _resetSessionForTests(): void {
  stopSessionPersistence();
}
