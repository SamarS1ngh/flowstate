import TrackPlayer, {State} from 'react-native-track-player';
import {Song} from '../types';
import {resolveStreamUrl, StreamResolveError} from '../stream/resolver';
import {QueueSource} from './queue';

let source: QueueSource | null = null;
let current: Song | null = null;

// Fallback-status seam: VibeQueue's onFallback callback (wired up by whoever
// constructs the VibeQueue, e.g. PlaylistScreen -- see reportFallback) fires
// synchronously inside QueueSource.next(). skipToNext() is the only place
// next() is called (directly or via the retry-on-unplayable loop below), so
// resetting lastFallback immediately before each next() call and never
// touching it elsewhere means it always reflects the outcome of whichever
// next() call produced the track that's currently loaded -- PlayerScreen
// reads it via consumeFallbackStatus() after each track-changed event.
export type FallbackKind = 'relaxed' | 'random';
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
  let url: string;
  try {
    url = await resolveStreamUrl(song.videoId);
  } catch (e) {
    if (!(e instanceof StreamResolveError)) throw e;
    url = await resolveStreamUrl(song.videoId); // second attempt
  }
  await TrackPlayer.reset();
  await TrackPlayer.add({
    id: song.videoId,
    url,
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
  src.reset(first);
  await load(first);
}

export async function skipToNext(): Promise<void> {
  if (!source) return;
  lastFallback = null;
  let candidate = source.next(current);
  while (candidate) {
    try {
      await load(candidate);
      return;
    } catch {
      lastFallback = null;
      candidate = source.next(candidate); // unplayable song: skip forward
    }
  }
  await TrackPlayer.stop();
}

export async function skipToPrevious(): Promise<void> {
  await TrackPlayer.seekTo(0); // v1: previous restarts current track
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

export async function togglePlayPause(): Promise<void> {
  const state = (await TrackPlayer.getPlaybackState()).state;
  if (state === State.Playing) await TrackPlayer.pause();
  else await TrackPlayer.play();
}
