import TrackPlayer, {State} from 'react-native-track-player';
import {Song} from '../types';
import {resolveStreamUrl, StreamResolveError} from '../stream/resolver';
import {offlineUrl} from '../offline/downloads';
import {QueueSource} from './queue';

let source: QueueSource | null = null;
let current: Song | null = null;

type Stream = {url: string; headers?: Record<string, string>};

// Stream-URL prefetch cache (Task 3). resolveStreamUrl() is the slow part of a
// skip (network round-trip, sometimes a search-fallback probe). After each
// load we kick off resolution of the most-likely next song in the background
// and stash the promise here, keyed by videoId; load() then awaits that instead
// of resolving fresh, so a skip feels instant. Best-effort: a wrong guess (the
// stochastic vibe next() picking a different song) or a failed prefetch just
// falls through to a normal fresh resolve -- never worse than before.
let prefetch: {videoId: string; promise: Promise<Stream | null>} | null = null;

// Resolve the likely-next song's stream in the background. Errors are swallowed
// into a null result so the cache entry is simply ignored on miss (and never
// surfaces as an unhandled rejection).
function schedulePrefetch(): void {
  const nextSong = source?.peekNext?.() ?? null;
  if (!nextSong) {
    prefetch = null;
    return;
  }
  if (prefetch?.videoId === nextSong.videoId) return; // already in flight
  const videoId = nextSong.videoId;
  const meta = {title: nextSong.title, artist: nextSong.artist};
  prefetch = {
    videoId,
    // Skip the network entirely if the next song is downloaded (load() will use
    // the local file); otherwise resolve its stream ahead of the skip.
    promise: offlineUrl(videoId).then(local =>
      local ? {url: local} : resolveStreamUrl(videoId, meta).catch(() => null),
    ),
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

// Play history so "previous" walks back through the songs actually played --
// works for both a normal queue and vibe shuffle (a generative forward walk
// that has no inherent "previous"). Pushed on each forward skip; popped by
// skipToPrevious. Bounded so it can't grow without limit in a long session.
const history: Song[] = [];
const MAX_HISTORY = 50;

// Fallback-status seam: VibeQueue's onFallback callback (wired up by whoever
// constructs the VibeQueue, e.g. PlaylistScreen -- see reportFallback) fires
// synchronously inside QueueSource.next(). skipToNext() is the only place
// next() is called (directly or via the retry-on-unplayable loop below), so
// resetting lastFallback immediately before each next() call and never
// touching it elsewhere means it always reflects the outcome of whichever
// next() call produced the track that's currently loaded -- PlayerScreen
// reads it via consumeFallbackStatus() after each track-changed event.
// 'error' is reported by skipToNext itself (not a VibeQueue fallback) when
// the consecutive-failure cap below is hit -- reuses this same seam so
// PlayerScreen doesn't need a second status channel.
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

async function load(song: Song): Promise<void> {
  // Offline-first: a downloaded song plays straight from disk -- no network
  // resolve at all. offlineUrl() also self-heals a dangling row (file deleted)
  // by returning null, so we fall through to streaming in that case.
  const local = await offlineUrl(song.videoId);
  let stream: Stream | null = local ? {url: local} : null;
  // Use the prefetched stream if it's for this exact song. On a prefetch miss
  // (wrong guess) or a failed prefetch (null), fall through to a fresh resolve.
  if (!stream && prefetch && prefetch.videoId === song.videoId) {
    stream = await prefetch.promise;
    prefetch = null;
  }
  if (!stream) {
    stream = await resolveWithRetry(song);
  }
  await TrackPlayer.reset();
  await TrackPlayer.add({
    id: song.videoId,
    url: stream.url,
    headers: stream.headers,
    title: song.title,
    artist: song.artist,
    duration: song.durationS ?? undefined,
  });
  await TrackPlayer.play();
  current = song;
  emitNowPlaying();
  // Warm the cache for the next skip. Non-blocking -- this song is already
  // playing; the prefetch races in the background.
  schedulePrefetch();
}

export async function playFrom(src: QueueSource, first: Song): Promise<void> {
  source = src;
  lastFallback = null; // starting a fresh session -- no stale status from the last one
  history.length = 0; // fresh session -> no previous
  prefetch = null; // don't let a prior session's cached stream leak in
  src.reset(first);
  // Optimistic: reflect the target song RIGHT NOW (before the network resolve),
  // so a caller that navigates to the Player on tap shows this song immediately
  // -- with a buffering state -- instead of waiting for load() to finish. The
  // real audio follows when load() completes; that just re-affirms `current`.
  current = first;
  emitNowPlaying();
  await load(first);
}

// Safety cap for the retry-on-unplayable loop below. Without it, an offline
// device (every resolveStreamUrl() call in load() fails) combined with a
// QueueSource whose next() never runs out of candidates -- VibeQueue's
// random fallback keeps returning songs indefinitely since a failed load
// doesn't session-ban the song, and it allows repeats once the scope is
// exhausted -- turns into an infinite loop of failed loads. Capping
// consecutive failures bounds that to a handful of quick attempts before
// surfacing an error instead of hanging.
const MAX_CONSECUTIVE_LOAD_FAILURES = 5;

export async function skipToNext(): Promise<void> {
  if (!source) return;
  lastFallback = null;
  const leaving = current; // song we're moving away from -> goes onto history
  let candidate = source.next(current);
  let consecutiveFailures = 0;
  while (candidate) {
    try {
      await load(candidate);
      if (leaving) {
        history.push(leaving);
        if (history.length > MAX_HISTORY) history.shift();
      }
      return;
    } catch {
      lastFallback = null;
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_LOAD_FAILURES) {
        await TrackPlayer.stop();
        // Reuses the fallback-status seam so PlayerScreen can show
        // "playback failed -- check connection" without a second channel.
        lastFallback = 'error';
        return;
      }
      candidate = source.next(candidate); // unplayable song: skip forward
    }
  }
  await TrackPlayer.stop();
}

export async function skipToPrevious(): Promise<void> {
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
  try {
    await load(prev); // load sets current=prev; do NOT push it onto history
  } catch {
    await TrackPlayer.seekTo(0); // previous song unplayable -> restart current
  }
}

export function nowPlaying(): Song | null {
  return current;
}

// Lets the Player screen react the instant `current` changes -- including the
// OPTIMISTIC set in playFrom (before the resolve), which no TrackPlayer event
// covers (the track hasn't loaded yet). Subsequent real track changes still
// also arrive via TrackPlayer's PlaybackActiveTrackChanged; both call the same
// refresh, so a duplicate is a harmless no-op.
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
// QueueSource.peekUpcoming) -- lets PlayerScreen's Up Next list stay
// decoupled from whether the current source actually supports peeking,
// without needing its own `?.` chaining at every call site.
export function peekUpcoming(count: number): Song[] {
  return source?.peekUpcoming?.(count) ?? [];
}

export async function togglePlayPause(): Promise<void> {
  const state = (await TrackPlayer.getPlaybackState()).state;
  if (state === State.Playing) await TrackPlayer.pause();
  else await TrackPlayer.play();
}
