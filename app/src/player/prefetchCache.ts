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

const MAX_CACHED = 4;

// videoId -> resolved stream (url + headers). Session-scoped; googlevideo URLs
// stay valid for hours, and a stale one just fails playback -> skipToNext's
// retry loads it fresh, so no correctness risk.
const done = new Map<string, Stream>();
const lru: string[] = [];
let activeId: string | null = null;
let desiredId: string | null = null;
let wanted: Song | null = null;

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
  if (activeId) return; // one at a time
  const id = desiredId;
  if (!id || done.has(id)) return; // nothing to do / already cached
  const song = wanted;
  if (!song || song.videoId !== id) return;
  activeId = id;
  try {
    const stream = await resolveOnce(song);
    if (stream) {
      done.set(id, stream);
      touchLru(id);
      evict();
    }
  } finally {
    activeId = null;
    if (desiredId && desiredId !== id && !done.has(desiredId)) void pump();
  }
}

/**
 * Request that `song` (the likely next) have its stream URL resolved ahead of
 * time. Coalesces rapid calls: latest target only, one resolve at a time, never
 * a duplicate. Fire-and-forget.
 */
export function requestPrefetch(song: Song | null): void {
  if (!song) return;
  desiredId = song.videoId;
  wanted = song;
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
  desiredId = null;
  wanted = null;
}
