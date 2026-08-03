import TrackPlayer, {State} from 'react-native-track-player';
import {Song} from '../types';
import {resolveStreamUrl, StreamResolveError} from '../stream/resolver';
import {offlineUrl} from '../offline/downloads';
import {getPrefetchedStream, requestPrefetch} from './prefetchCache';
import {QueueSource} from './queue';

let source: QueueSource | null = null;
let current: Song | null = null;

type Stream = {url: string; headers?: Record<string, string>};

// Serialize every playback mutation (playFrom / skipToNext / skipToPrevious) so
// they NEVER run concurrently. Without this, a second tap during a skip's load
// starts a SECOND concurrent reset()/add()/play() -- the two stomp each other,
// the queue-source cursor advances twice, and playback corrupts. One-at-a-time
// makes N taps advance exactly N songs.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn); // run after the previous op, pass or fail
  opChain = run.catch(() => undefined); // a rejection must not break the chain
  return run;
}

// A stream resolve must never hang forever -- RN fetch has no default timeout,
// so a stalled googlevideo/Innertube request would wedge whatever awaited it.
const RESOLVE_TIMEOUT_MS = 15000;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('resolve timed out')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// Fresh resolve with retry-once semantics; title/artist let the resolver's
// search-fallback recover an unplayable "- Topic" videoId.
async function resolveWithRetry(song: Song): Promise<Stream> {
  const meta = {title: song.title, artist: song.artist};
  try {
    return await resolveStreamUrl(song.videoId, meta);
  } catch (e) {
    if (!(e instanceof StreamResolveError)) throw e;
    return await resolveStreamUrl(song.videoId, meta);
  }
}

// Where to get a song's audio, cheapest-first:
//   1. a real offline download (permanent, from disk) -- instant,
//   2. a Spotify-style PREFETCH of the next song (temp file, from disk) --
//      instant; this is what makes a skip to the pre-downloaded next play with
//      no network buffering,
//   3. a live network resolve (time-boxed).
async function resolveStream(song: Song): Promise<Stream> {
  const offline = await offlineUrl(song.videoId);
  if (offline) return {url: offline};
  // A pre-resolved URL for the next song (prefetchCache) -> skip the network
  // resolve on a skip and go straight to buffering.
  const prefetched = getPrefetchedStream(song.videoId);
  if (prefetched) return prefetched;
  return withTimeout(resolveWithRetry(song), RESOLVE_TIMEOUT_MS);
}

// Load one song into the (single-track) player and play it. Stops the OLD track
// FIRST -- before the (possibly multi-second) resolve -- so its audio doesn't
// keep playing and its timer doesn't keep ticking while the screen already shows
// the new song; the player sits empty (state None -> loading spinner, 0:00)
// until the new stream is ready. Throws if the song can't be resolved so callers
// can react. After it plays, kicks off prefetch of the NEXT song.
async function load(song: Song): Promise<void> {
  await TrackPlayer.reset();
  const stream = await resolveStream(song); // throws on failure -> caller retries
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
  // Spotify-style: download the likely-next song to disk now, so the next skip
  // plays from a local file instantly. Deduped + single-flight in prefetchCache.
  requestPrefetch(source?.peekNext?.() ?? null);
}

// Play history so "previous" walks back through the songs actually played.
// Pushed on each forward skip; popped by skipToPrevious. Bounded.
const history: Song[] = [];
const MAX_HISTORY = 50;

function pushHistory(song: Song | null): void {
  if (!song) return;
  history.push(song);
  if (history.length > MAX_HISTORY) history.shift();
}

// Fallback-status seam: VibeQueue's onFallback callback fires synchronously
// inside QueueSource.next(); it reflects how the pick that produced the current
// track was made (relaxed / random). PlayerScreen reads it via
// consumeFallbackStatus() after each track change. 'error' is set by skipToNext
// when the consecutive-failure cap is hit.
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
    lastFallback = null;
    history.length = 0;
    src.reset(first);
    // Optimistic: reflect the target song immediately (before the resolve) so a
    // caller that navigates to the Player on tap shows this song right away with
    // a loading state; load() re-affirms it.
    current = first;
    emitNowPlaying();
    await load(first);
  });
}

// Safety cap for the retry-on-unplayable loop. Without it, an offline device
// (every resolve fails) plus a QueueSource whose next() never runs dry
// (VibeQueue's random fallback) would loop forever.
const MAX_CONSECUTIVE_LOAD_FAILURES = 5;

export function skipToNext(): Promise<void> {
  return serialize(async () => {
    if (!source) return;
    lastFallback = null;
    const leaving = current; // song we're moving away from -> onto history
    let candidate = source.next(current);
    let consecutiveFailures = 0;
    while (candidate) {
      current = candidate; // optimistic art/title update
      emitNowPlaying();
      try {
        await load(candidate);
        pushHistory(leaving);
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
    // A few seconds into the track, "previous" restarts it (like most players);
    // only jump to the actual previous song near the start.
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
      await TrackPlayer.seekTo(0); // no history -> restart current
      return;
    }
    current = prev; // optimistic
    emitNowPlaying();
    try {
      await load(prev); // do NOT push prev onto history
    } catch {
      await TrackPlayer.seekTo(0); // previous unplayable -> restart current
    }
  });
}

export function nowPlaying(): Song | null {
  return current;
}

// Lets the Player screen react the instant `current` changes -- including the
// OPTIMISTIC set (before the resolve), which no TrackPlayer event covers.
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

// Smallest viable seam so screens can reach the active queue for vibe-specific
// controls (reject routing, mode/mood toggles).
export function currentSource(): QueueSource | null {
  return source;
}

// Thin pass-through to the active source's optional peekUpcoming.
export function peekUpcoming(count: number): Song[] {
  return source?.peekUpcoming?.(count) ?? [];
}

export async function togglePlayPause(): Promise<void> {
  const state = (await TrackPlayer.getPlaybackState()).state;
  if (state === State.Playing) await TrackPlayer.pause();
  else await TrackPlayer.play();
}
