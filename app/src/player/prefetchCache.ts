import {Song} from '../types';
import {resolveStreamUrl, StreamResolveError} from '../stream/resolver';

// Next-song prefetch, URL edition. We CANNOT pre-download the audio file --
// YouTube throttles anonymous stream downloads to ~real-time and connection-
// resets long bulk pulls (measured: a full song took 75s then "Connection
// reset"), so a downloaded file is never ready before you skip. What we CAN do
// cheaply is resolve the next song's stream URL ahead of time (a ~1s network
// call, not a download). A skip then skips the resolve step and goes straight
// to buffering -> ~570ms instead of ~1.5s.
//
// Anti-anomaly design (unchanged intent from the download version):
//  1. NEVER resolve the same videoId twice while a result is cached / in flight.
//  2. NEVER run more than one resolve at a time -- a single active slot; rapid
//     skips just move `desiredId`, and the slot chases the LATEST target when
//     free. Bursts collapse to "resolve the newest next, once".
//  3. Bounded cache (last MAX_CACHED entries, LRU) so it can't grow unbounded.

type Stream = {url: string; headers?: Record<string, string>};

// Deep enough to hold a small buffer of upcoming songs. This is what makes
// skipping work when the app is BACKGROUNDED: a fresh YouTube resolve hangs in
// the background (the OS freezes the app's network there), so we resolve the
// next several songs' URLs WHILE FOREGROUND and cache them. A backgrounded skip
// then finds its target already resolved and never has to hit the network.
const MAX_CACHED = 16;
const MAX_PREFETCH_DEPTH = 12;

// videoId -> resolved stream (url + headers). Session-scoped; googlevideo URLs
// stay valid for hours, and a stale one just fails playback -> skipToNext's
// retry loads it fresh, so no correctness risk.
const done = new Map<string, Stream>();
const lru: string[] = [];
let activeId: string | null = null;
// The ordered list of songs we WANT resolved ahead (highest priority first).
let queue: Song[] = [];

function touchLru(videoId: string): void {
  const i = lru.indexOf(videoId);
  if (i >= 0) lru.splice(i, 1);
  lru.push(videoId);
}

function evict(): void {
  while (lru.length > MAX_CACHED) {
    const victim = lru.shift();
    if (victim) done.delete(victim);
  }
}

async function resolveOnce(song: Song): Promise<Stream | null> {
  const meta = {title: song.title, artist: song.artist};
  try {
    return await resolveStreamUrl(song.videoId, meta);
  } catch (e) {
    if (!(e instanceof StreamResolveError)) return null;
    try {
      return await resolveStreamUrl(song.videoId, meta); // retry once
    } catch {
      return null;
    }
  }
}

async function pump(): Promise<void> {
  if (activeId) return; // one resolve at a time
  const song = queue.find(s => !done.has(s.videoId)); // first not-yet-cached
  if (!song) return;
  activeId = song.videoId;
  try {
    const stream = await resolveOnce(song);
    if (stream) {
      done.set(song.videoId, stream);
      touchLru(song.videoId);
      evict();
    }
  } finally {
    activeId = null;
    if (queue.some(s => !done.has(s.videoId))) void pump(); // keep filling
  }
}

/**
 * Request that `song` (the likely next) have its stream URL resolved ahead of
 * time. Fire-and-forget. Back-compat single-song entry point.
 */
export function requestPrefetch(song: Song | null): void {
  if (!song) return;
  requestPrefetchQueue([song]);
}

/**
 * Resolve+cache the next several upcoming songs' URLs (highest priority first),
 * one at a time. Songs already cached are skipped. This is the background-skip
 * buffer -- call it (while foreground) with the upcoming songs so a later
 * backgrounded skip finds them pre-resolved.
 */
export function requestPrefetchQueue(songs: Song[]): void {
  queue = songs.filter(Boolean).slice(0, MAX_PREFETCH_DEPTH);
  void pump();
}

/** The pre-resolved stream for a song, or null if not prefetched. */
export function getPrefetchedStream(videoId: string): Stream | null {
  const s = done.get(videoId);
  if (s) touchLru(videoId);
  return s ?? null;
}

/** Test-only: reset all in-memory state. */
export function _resetPrefetchForTests(): void {
  done.clear();
  lru.length = 0;
  activeId = null;
  queue = [];
}
