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

// The song actually loaded in the player right now (distinct from `current`,
// which is the OPTIMISTIC ui target that a rapid tap advances ahead of the
// audio). Drives history + the "already playing it?" coalescing check.
let loadedSong: Song | null = null;
// True while a loader run is queued/active, so rapid taps don't each start a
// loader -- the one running chases the latest `current`.
let loaderScheduled = false;

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

// Load one song into the (single-track) player and play it. Stops the OLD track
// FIRST -- before the (possibly multi-second) resolve -- so its audio doesn't
// keep playing while the screen already shows the new song. Returns false if a
// newer tap moved `current` past this song before it could start playing, so a
// superseded intermediate in a rapid-tap burst NEVER becomes audible (the loader
// then chases the newest target). Throws only on a real resolve failure.
async function doLoad(song: Song, pushPrev: boolean): Promise<boolean> {
  await TrackPlayer.reset();
  if (current && current.videoId !== song.videoId) return false; // superseded
  const stream = await resolveStream(song); // throws on failure -> caller retries
  if (current && current.videoId !== song.videoId) return false; // superseded
  await TrackPlayer.add(toTrack(song, stream));
  await TrackPlayer.play();
  if (pushPrev && loadedSong && loadedSong.videoId !== song.videoId) {
    pushHistory(loadedSong);
  }
  loadedSong = song;
  current = song;
  emitNowPlaying();
  // Prefetch the next song's stream URL so the following skip skips the resolve.
  requestPrefetch(source?.peekNext?.() ?? null);
  return true;
}

// Loader loop: load whatever `current` is and keep chasing it while it moves
// (rapid taps advance `current` synchronously). Coalesces a burst into a single
// audible load -- the final song -- resolving at most one superseded target
// along the way. Handles the retry-on-unplayable cap.
async function loaderLoop(pushPrev: boolean): Promise<void> {
  let fails = 0;
  while (source && current && (!loadedSong || loadedSong.videoId !== current.videoId)) {
    const target = current;
    try {
      const ok = await doLoad(target, pushPrev);
      if (!ok) continue; // superseded -> loop re-reads the newer `current`
      fails = 0;
    } catch {
      lastFallback = null;
      fails += 1;
      if (fails >= MAX_CONSECUTIVE_LOAD_FAILURES) {
        await TrackPlayer.stop();
        lastFallback = 'error';
        return;
      }
      const nx = source.next(target); // unplayable -> skip forward
      if (nx) {
        current = nx;
        emitNowPlaying();
      } else {
        await TrackPlayer.stop();
        return;
      }
    }
  }
}

// Kick a loader run (single-flight, serialized). A no-op if one is already
// queued/running -- that run will pick up the latest `current`.
function requestLoad(pushPrev: boolean): void {
  if (loaderScheduled) return;
  loaderScheduled = true;
  void serialize(async () => {
    try {
      await loaderLoop(pushPrev);
    } finally {
      loaderScheduled = false;
    }
  });
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

// Safety cap for the retry-on-unplayable loop. Without it, an offline device
// (every resolve fails) plus a QueueSource whose next() never runs dry
// (VibeQueue's random fallback) would loop forever.
const MAX_CONSECUTIVE_LOAD_FAILURES = 5;

export function playFrom(src: QueueSource, first: Song): Promise<void> {
  return serialize(async () => {
    source = src;
    lastFallback = null;
    history.length = 0;
    loadedSong = null; // fresh session -> nothing to push to history
    src.reset(first);
    // Optimistic: reflect the target song immediately (before the resolve) so a
    // caller that navigates to the Player on tap shows this song right away with
    // a loading state; doLoad re-affirms it.
    current = first;
    emitNowPlaying();
    await doLoad(first, false);
  });
}

// Rapid-tap friendly: advance `current` (art/title) SYNCHRONOUSLY per tap so the
// UI flips instantly, then let the single-flight loader chase the latest target.
// A burst of taps loads only the song you land on -- not each one in between.
export function skipToNext(): Promise<void> {
  if (!source) return Promise.resolve();
  lastFallback = null;
  const cand = source.next(current);
  if (cand) {
    current = cand;
    emitNowPlaying();
  }
  requestLoad(true);
  return Promise.resolve();
}

export async function skipToPrevious(): Promise<void> {
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
  current = prev; // optimistic art flip
  emitNowPlaying();
  requestLoad(false); // load prev; pushPrev=false -> do NOT re-push it to history
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

// The single committed next song (what will actually play on the next skip),
// used by the Player's Up Next -- including vibe mode, where the queue has no
// deterministic full list but DOES commit one next pick (see VibeQueue.peekNext).
export function peekNextSong(): Song | null {
  return source?.peekNext?.() ?? null;
}

export async function togglePlayPause(): Promise<void> {
  const state = (await TrackPlayer.getPlaybackState()).state;
  if (state === State.Playing) await TrackPlayer.pause();
  else await TrackPlayer.play();
}
