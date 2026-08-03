import TrackPlayer, {State} from 'react-native-track-player';
import {Song} from '../types';
import {resolveStreamUrl, StreamResolveError} from '../stream/resolver';
import {offlineUrl} from '../offline/downloads';
import {QueueSource} from './queue';

let source: QueueSource | null = null;
let current: Song | null = null;

// Serialize every playback mutation (playFrom / skipToNext / skipToPrevious /
// the native-advance driver) through one promise chain so they NEVER run
// concurrently. Without this, a fast skip whose next isn't staged yet takes the
// slow (resolve+reset+add) path, and a second tap during that window starts a
// SECOND concurrent load -- the two reset()/add() calls stomp each other, the
// vibe cursor advances twice, and the queue corrupts into runaway auto-skips.
// One-at-a-time makes N taps advance exactly N songs.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn); // run after the previous op, pass or fail
  opChain = run.catch(() => undefined); // a rejection must not break the chain
  return run;
}

type Stream = {url: string; headers?: Record<string, string>};

// --- windowed pre-buffer model ----------------------------------------
// Instead of loading one song at a time (reset+add+play on every skip, which
// makes ExoPlayer re-buffer from scratch each time), we keep the native player
// holding a small window [current, next]. ExoPlayer pre-buffers the *next*
// playlist item on its own connection while `current` plays, so a skip is a
// native skipToNext() onto an already-buffered track -- effectively instant.
//
// Two sources of truth are kept in sync: our JS QueueSource cursor (which
// *decides* the next song) and the native player queue (which *holds* the
// buffered audio). onNativeTrackChanged() -- fired whenever the player advances,
// by a user skip OR a song ending -- is the single place that advances our JS
// state to match the native advance, then pre-buffers the following song.
//
// `enqueuedById` maps every videoId we've handed the native player -> its Song,
// so the driver can turn a native track id back into a Song. `enqueuedNextId`
// is the videoId of the currently pre-buffered next (null if none staged yet).
const enqueuedById = new Map<string, Song>();
let enqueuedNextId: string | null = null;
// True while we're doing a manual reset/add rebuild (playFrom / previous /
// fallback). The PlaybackActiveTrackChanged the rebuild triggers must NOT be
// treated as a real forward advance by the driver.
let rebuilding = false;
// Dedupe concurrent enqueueNext() calls (driver + explicit both may fire).
let enqueuing = false;

function toTrack(song: Song, stream: Stream) {
  return {
    id: song.videoId,
    url: stream.url,
    headers: stream.headers,
    title: song.title,
    artist: song.artist,
    duration: song.durationS ?? undefined,
  };
}

// Fresh resolve with the design's retry-once semantics. Pass title/artist so
// the resolver's search-fallback can recover an unplayable "- Topic" videoId.
async function resolveWithRetry(song: Song): Promise<Stream> {
  const meta = {title: song.title, artist: song.artist};
  try {
    return await resolveStreamUrl(song.videoId, meta);
  } catch (e) {
    if (!(e instanceof StreamResolveError)) throw e;
    return await resolveStreamUrl(song.videoId, meta); // second attempt
  }
}

// A stream resolve must never hang forever. RN's fetch has no default timeout,
// so a stalled googlevideo/Innertube request (common under the many concurrent
// requests rapid skips trigger) would otherwise wedge whatever awaited it -- and
// that's exactly what stuck enqueueNext's `enqueuing` flag true permanently,
// killing all future pre-buffering ("instant skip stops working"). Time-boxing
// turns a hang into a normal failure: loadSingle retries the next candidate,
// enqueueNext just bails and a later skip retries.
const RESOLVE_TIMEOUT_MS = 15000;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('resolve timed out')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// Offline-first stream resolution: a downloaded song plays straight from disk
// (no network, no buffering wait). offlineUrl() self-heals a dangling row.
async function resolveStream(song: Song): Promise<Stream> {
  const local = await offlineUrl(song.videoId);
  if (local) return {url: local};
  return withTimeout(resolveWithRetry(song), RESOLVE_TIMEOUT_MS);
}

async function resolveStreamSafe(song: Song): Promise<Stream | null> {
  try {
    return await resolveStream(song);
  } catch {
    return null;
  }
}

// Manual, non-windowed load: tear the player down to just this one song and
// play it. Used for session start (playFrom), previous, and the skip fallback.
// Throws if the song can't be resolved so callers can react. `rebuilding`
// suppresses the driver for the track-changed events this triggers.
async function loadSingle(song: Song): Promise<void> {
  rebuilding = true;
  try {
    // Stop the OLD track FIRST -- before the (possibly multi-second) resolve --
    // so its audio doesn't keep playing and its timer doesn't keep ticking
    // while the screen already shows the new song. The player then sits empty
    // (state None -> the transport shows the loading spinner, position 0:00)
    // until the new stream is ready.
    await TrackPlayer.reset();
    enqueuedById.clear();
    enqueuedNextId = null;
    const stream = await resolveStream(song); // throws on failure -> caller retries
    await TrackPlayer.add(toTrack(song, stream));
    await TrackPlayer.play();
    enqueuedById.set(song.videoId, song);
    current = song;
    emitNowPlaying();
  } finally {
    rebuilding = false;
  }
}

// Resolve the QueueSource's committed next song and APPEND it to the native
// player queue, so ExoPlayer starts pre-buffering it in the background. No-op
// if there's no next, one is already staged, or the resolve fails (the skip
// fallback covers an unplayable/absent next). Best-effort and non-blocking.
async function enqueueNext(): Promise<void> {
  if (!source || enqueuing || enqueuedNextId) {
    return;
  }
  const next = source.peekNext?.() ?? null;
  if (!next || next.videoId === current?.videoId) {
    return;
  }
  enqueuing = true;
  try {
    // Resolve OUTSIDE the serialize lock (it can take seconds) so it never
    // blocks a user skip; only the quick add() runs on the lock, re-checking
    // that the pick is still valid and no rebuild happened in between.
    const stream = await resolveStreamSafe(next);
    if (!stream) {
      return;
    }
    await serialize(async () => {
      if (rebuilding || enqueuedNextId) {
        return;
      }
      if (next.videoId === current?.videoId) return;
      // The committed next may have changed while we resolved (reject / mood /
      // lock-drift toggle clears the vibe queue's pending pick).
      const still = source?.peekNext?.() ?? null;
      if (!still || still.videoId !== next.videoId) {
        return;
      }
      await TrackPlayer.add(toTrack(next, stream));
      enqueuedById.set(next.videoId, next);
      enqueuedNextId = next.videoId;
    });
  } finally {
    enqueuing = false;
  }
}

// Remove every already-played track sitting behind the active one, so the
// native queue never grows past the small window. Keeps the map pruned to what
// remains queued.
async function trimBehind(): Promise<void> {
  let active: number | null = null;
  try {
    active = (await TrackPlayer.getActiveTrackIndex()) ?? null;
  } catch {
    return;
  }
  if (active == null || active <= 0) return;
  const indices = Array.from({length: active}, (_, i) => i);
  await TrackPlayer.remove(indices).catch(() => {});
}

// Play history so "previous" walks back through the songs actually played --
// works for both a normal queue and vibe shuffle (a generative forward walk
// that has no inherent "previous"). Pushed on each forward advance; popped by
// skipToPrevious. Bounded so it can't grow without limit in a long session.
const history: Song[] = [];
const MAX_HISTORY = 50;

function pushHistory(song: Song | null): void {
  if (!song) return;
  history.push(song);
  if (history.length > MAX_HISTORY) history.shift();
}

// Fallback-status seam: VibeQueue's onFallback callback (wired up by whoever
// constructs the VibeQueue, e.g. PlaylistScreen -- see reportFallback) fires
// synchronously inside QueueSource.next(). It reflects how the pick that
// produced the now-current track was made (relaxed / random). PlayerScreen
// reads it via consumeFallbackStatus() after each track-changed event. 'error'
// is reported by the skip fallback when the consecutive-failure cap is hit.
export type FallbackKind = 'relaxed' | 'random' | 'error';
let lastFallback: FallbackKind | null = null;

export function reportFallback(kind: FallbackKind): void {
  lastFallback = kind;
}

export function consumeFallbackStatus(): FallbackKind | null {
  const k = lastFallback;
  lastFallback = null;
  return k;
}

export function playFrom(src: QueueSource, first: Song): Promise<void> {
  return serialize(async () => {
    source = src;
    lastFallback = null; // fresh session -- no stale status from the last one
    history.length = 0; // fresh session -> no previous
    enqueuedNextId = null;
    src.reset(first);
    // Optimistic: reflect the target song RIGHT NOW (before the network resolve)
    // so a caller that navigates to the Player on tap shows this song
    // immediately with a buffering state. loadSingle re-affirms it.
    current = first;
    emitNowPlaying();
    await loadSingle(first);
    void enqueueNext(); // start pre-buffering the next song
  });
}

// Safety cap for the fallback retry-on-unplayable loop. Without it, an offline
// device (every resolve fails) combined with a QueueSource whose next() never
// runs out of candidates (VibeQueue's random fallback) would loop forever.
const MAX_CONSECUTIVE_LOAD_FAILURES = 5;

export function skipToNext(): Promise<void> {
  return serialize(async () => {
    if (!source) return;
    lastFallback = null;
    // Fast path: the next song is already staged + pre-buffered -> hand off to
    // it natively. onNativeTrackChanged() advances our JS state to match.
    if (enqueuedNextId) {
      await TrackPlayer.skipToNext();
      return;
    }
    // Slow path: nothing pre-buffered yet (right after a previous, a fast
    // double-skip, or an enqueue that failed). Resolve+load live, skipping
    // unplayable candidates up to the cap, then re-establish the window.
    const leaving = current;
    let candidate = source.next(current);
    let consecutiveFailures = 0;
    while (candidate) {
      current = candidate; // optimistic art/title update
      emitNowPlaying();
      try {
        await loadSingle(candidate);
        pushHistory(leaving);
        void enqueueNext();
        return;
      } catch {
        lastFallback = null;
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_LOAD_FAILURES) {
          await TrackPlayer.stop();
          lastFallback = 'error';
          return;
        }
        candidate = source.next(candidate); // unplayable -> skip forward
      }
    }
    await TrackPlayer.stop();
  });
}

export function skipToPrevious(): Promise<void> {
  return serialize(async () => {
    // If we're a few seconds into the track, "previous" restarts it (like most
    // players); only jump to the actual previous song near the start.
    try {
      const pos = await TrackPlayer.getProgress();
      if (pos.position > 3) {
        await TrackPlayer.seekTo(0);
        return;
      }
    } catch {
      // ignore -- fall through to history behavior
    }
    const prev = history.pop();
    if (!prev) {
      await TrackPlayer.seekTo(0); // no history (session start) -> restart current
      return;
    }
    current = prev; // optimistic: slide the art to the previous song immediately
    emitNowPlaying();
    try {
      // Previous rebuilds the window around `prev` (ExoPlayer pre-buffers
      // forward, not backward, so prev isn't held pre-buffered -- one live load).
      await loadSingle(prev);
      void enqueueNext();
    } catch {
      await TrackPlayer.seekTo(0); // previous song unplayable -> restart current
    }
  });
}

// DRIVER: called (from the playback service) on every PlaybackActiveTrackChanged
// -- i.e. whenever the native player advances to a new track, whether from a
// user skipToNext() or a song ending and auto-advancing to the pre-buffered
// next. This is the ONE place our JS state moves forward to match the native
// queue. No-op for the track-changed events our own manual rebuilds trigger
// (guarded by `rebuilding` and the current-track check).
export function onNativeTrackChanged(): Promise<void> {
  return serialize(async () => {
    if (rebuilding || !source) return;
    let active: number | null = null;
    try {
      active = (await TrackPlayer.getActiveTrackIndex()) ?? null;
    } catch {
      return;
    }
    if (active == null) return;
    const qq = await TrackPlayer.getQueue().catch(() => []);
    const track = qq[active] as {id?: string} | undefined;
    const id = track?.id;
    if (!id || id === current?.videoId) return; // no real change / our own load
    if (id !== enqueuedNextId) return; // advanced to something we didn't stage
    const advancedTo = enqueuedById.get(id);
    if (!advancedTo) return;

    const leaving = current;
    lastFallback = null;
    // Advance the JS QueueSource cursor to match (VibeQueue.next consumes the
    // pending pick == advancedTo, re-emitting any relaxed/random fallback).
    try {
      source?.next(leaving);
    } catch {
      // ignore -- state still advances below
    }
    pushHistory(leaving);
    current = advancedTo;
    enqueuedNextId = null;
    // Keep the map to just the current song; enqueueNext re-adds the next.
    enqueuedById.clear();
    enqueuedById.set(advancedTo.videoId, advancedTo);
    emitNowPlaying();
    await trimBehind(); // drop the played track(s) behind us
    void enqueueNext(); // pre-buffer the following song
  });
}

export function nowPlaying(): Song | null {
  return current;
}

// Lets the Player screen react the instant `current` changes -- including the
// OPTIMISTIC set in playFrom/skip (before the resolve), which no TrackPlayer
// event covers. Real native advances also drive onNativeTrackChanged, which
// calls emitNowPlaying; a duplicate refresh is a harmless no-op.
const nowPlayingListeners = new Set<() => void>();
export function subscribeNowPlaying(cb: () => void): () => void {
  nowPlayingListeners.add(cb);
  return () => {
    nowPlayingListeners.delete(cb);
  };
}
function emitNowPlaying(): void {
  for (const cb of nowPlayingListeners) cb();
}

// Smallest viable seam (Task 3) so screens can reach the active queue for
// vibe-specific controls (reject routing, mode/mood toggles) without the
// controller knowing anything about VibeQueue itself.
export function currentSource(): QueueSource | null {
  return source;
}

// Thin pass-through to the active source's optional peekUpcoming (see
// QueueSource.peekUpcoming) -- lets PlayerScreen's Up Next list stay decoupled
// from whether the current source actually supports peeking.
export function peekUpcoming(count: number): Song[] {
  return source?.peekUpcoming?.(count) ?? [];
}

export async function togglePlayPause(): Promise<void> {
  const state = (await TrackPlayer.getPlaybackState()).state;
  if (state === State.Playing) await TrackPlayer.pause();
  else await TrackPlayer.play();
}
