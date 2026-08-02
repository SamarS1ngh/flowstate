import TrackPlayer, {State} from 'react-native-track-player';
import {Song} from '../types';
import {resolveStreamUrl, StreamResolveError} from '../stream/resolver';
import {QueueSource} from './queue';

let source: QueueSource | null = null;
let current: Song | null = null;

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
  // retry-once semantics per design: fresh extraction on first failure, then skip
  // Pass title/artist so the resolver's search-fallback can find a playable
  // alternate when the stored videoId is an unplayable "- Topic" art track.
  const meta = {title: song.title, artist: song.artist};
  let stream: {url: string; headers?: Record<string, string>};
  try {
    stream = await resolveStreamUrl(song.videoId, meta);
  } catch (e) {
    if (!(e instanceof StreamResolveError)) throw e;
    stream = await resolveStreamUrl(song.videoId, meta); // second attempt
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
}

export async function playFrom(src: QueueSource, first: Song): Promise<void> {
  source = src;
  lastFallback = null; // starting a fresh session -- no stale status from the last one
  history.length = 0; // fresh session -> no previous
  src.reset(first);
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
