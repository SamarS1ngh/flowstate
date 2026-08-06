import TrackPlayer, {RepeatMode} from 'react-native-track-player';
import {Song} from '../types';
import {resolveStreamUrl, StreamResolveError} from '../stream/resolver';
import {offlineUrl} from '../offline/downloads';
import {getPrefetchedStream, requestPrefetch} from './prefetchCache';
import {QueueSource} from './queue';
import {thumbUrl} from '../ui/thumb';

// ── Timeline navigation model ─────────────────────────────────────────────────
//
// `timeline` is the ordered sequence of songs the user has navigated through
// (played + skipped past). `pos` is the index the user is currently ON (moved
// optimistically during a seek burst); `activePos` is the index actually loaded
// and playing. `next`/`previous` just move `pos` within the timeline and load
// the landed song when tapping stops (debounced) -- so a burst loads exactly one
// song, and previous steps back through the timeline one at a time.
//
// Crucially, the queue SOURCE (SimpleQueue cursor / VibeQueue picks) is advanced
// ONLY when we EXTEND the timeline past its frontier. Going back and forth
// within the already-known timeline never touches the source, so ping-ponging
// next/previous can't scramble it (the old bug where mixing them jumped to
// random songs).
//
// A separate "window" preloads the single next song into ExoPlayer's own queue
// so a track ending advances NATIVELY (no reset/gap) -- that's the locked-screen
// playback fix. `current` always reflects the ACTUAL active track (reconciled by
// videoId, never by a stale event index), so the title can't disagree with the
// audio.

let source: QueueSource | null = null;
let current: Song | null = null;
let timeline: Song[] = [];
let pos = 0; // where the user is looking (optimistic target during a seek)
let activePos = 0; // where the player is actually loaded/playing
// videoId of the song preloaded at ExoPlayer's next slot (gapless auto-advance),
// or null. When set it equals timeline[activePos + 1].
let windowNextId: string | null = null;
let repeatOne = false;
// In-flight single-flight preload (null when idle). Shared so awaiters wait on
// the same resolve rather than racing it.
let preloadPromise: Promise<void> | null = null;

type Stream = {url: string; headers?: Record<string, string>};

// Serialize every player mutation so async loads never interleave.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  opChain = run.catch(() => undefined);
  return run;
}

const RESOLVE_TIMEOUT_MS = 15000;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('resolve timed out')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function resolveWithRetry(song: Song): Promise<Stream> {
  const meta = {title: song.title, artist: song.artist};
  try {
    return await resolveStreamUrl(song.videoId, meta);
  } catch (e) {
    if (!(e instanceof StreamResolveError)) throw e;
    return await resolveStreamUrl(song.videoId, meta);
  }
}

// Cheapest-first: offline download -> pre-resolved URL cache -> live resolve.
async function resolveStream(song: Song): Promise<Stream> {
  const offline = await offlineUrl(song.videoId);
  if (offline) return {url: offline};
  const prefetched = getPrefetchedStream(song.videoId);
  if (prefetched) return prefetched;
  return withTimeout(resolveWithRetry(song), RESOLVE_TIMEOUT_MS);
}

function toTrack(song: Song, stream: Stream) {
  return {
    id: song.videoId,
    url: stream.url,
    headers: stream.headers,
    title: song.title,
    artist: song.artist,
    duration: song.durationS ?? undefined,
    // Album art for the media notification / lock screen. Without this the
    // notification renders as a plain gray card; with it Android shows the
    // artwork and tints the notification from it (MediaStyle).
    artwork: thumbUrl(song.videoId),
  };
}

// ── Fallback status (vibe relaxed/random + end error), stored per song ────────
export type FallbackKind = 'relaxed' | 'random' | 'error';
let pendingFallback: FallbackKind | null = null;
const fallbackBySong = new Map<string, FallbackKind>();

export function reportFallback(kind: FallbackKind): void {
  pendingFallback = kind;
}
export function consumeFallbackStatus(): FallbackKind | null {
  if (!current) return null;
  const k = fallbackBySong.get(current.videoId) ?? null;
  if (k) fallbackBySong.delete(current.videoId);
  return k;
}


// ── Seek debounce (shared by next + previous) ─────────────────────────────────
const SEEK_DEBOUNCE_MS = 250;
let seekTimer: ReturnType<typeof setTimeout> | null = null;
let seekActive = false;
function cancelSeek(): void {
  if (seekTimer) {
    clearTimeout(seekTimer);
    seekTimer = null;
  }
  seekActive = false;
}
function scheduleSeek(): void {
  if (!seekActive) {
    seekActive = true;
    void TrackPlayer.pause().catch(() => {}); // stop old audio while you skip
  }
  if (seekTimer) clearTimeout(seekTimer);
  seekTimer = setTimeout(commitSeek, SEEK_DEBOUNCE_MS);
}

// ── Repeat-one (native) ───────────────────────────────────────────────────────
export function isRepeatOne(): boolean {
  return repeatOne;
}
export async function setRepeatOne(on: boolean): Promise<void> {
  repeatOne = on;
  try {
    await TrackPlayer.setRepeatMode(on ? RepeatMode.Track : RepeatMode.Off);
  } catch {
    // non-fatal
  }
}

// Extend the timeline by one committed pick from the source frontier.
function extendTimeline(): Song | null {
  if (!source) return null;
  const from = timeline[timeline.length - 1] ?? current;
  const nx = source.next(from);
  const fb = pendingFallback;
  pendingFallback = null;
  if (!nx) return null;
  timeline.push(nx);
  if (fb) fallbackBySong.set(nx.videoId, fb);
  return nx;
}

// The song that should sit right after the ACTIVE one (for preloading): a known
// timeline entry if the user has been further, else a fresh frontier pick.
function nextAfterActive(): Song | null {
  if (activePos + 1 < timeline.length) return timeline[activePos + 1];
  return extendTimeline();
}

// Load `song` fresh (reset the player) and play it. Resolve FIRST so a failed
// resolve doesn't tear down the currently-playing track. Returns false on
// failure so the caller can skip forward.
async function loadCurrent(song: Song): Promise<boolean> {
  let stream: Stream;
  try {
    stream = await resolveStream(song);
  } catch {
    return false;
  }
  await TrackPlayer.reset();
  await TrackPlayer.add(toTrack(song, stream));
  await TrackPlayer.play();
  current = song;
  windowNextId = null;
  emitNowPlaying();
  return true;
}

// Preload the next song into ExoPlayer's queue so a track ending advances
// natively (no reset, no gap) -- keeps the media FGS + wake lock held, so
// playback continues with the screen locked. Single-flight: concurrent callers
// share (and can AWAIT) the one in-flight resolve. This matters at the queue
// boundary -- handleQueueEnded awaits this, and if a preload was already
// mid-resolve it must wait for THAT to finish (and set windowNextId) rather
// than see a false "nothing preloaded" and stop playback (the rare
// end-of-track-doesn't-advance bug).
function preloadNext(): Promise<void> {
  if (windowNextId) return Promise.resolve();
  if (preloadPromise) return preloadPromise;
  preloadPromise = (async () => {
    try {
      const nx = nextAfterActive();
      if (!nx) return;
      const stream = await resolveStream(nx);
      if (windowNextId) return; // someone else won the race
      await TrackPlayer.add(toTrack(nx, stream));
      windowNextId = nx.videoId;
      emitNowPlaying(); // Up Next can now show it
    } catch {
      // leave unloaded; a genuine end just fires PlaybackQueueEnded
    } finally {
      preloadPromise = null;
    }
  })();
  return preloadPromise;
}

// Reconcile `current`/`activePos` to whatever ExoPlayer is ACTUALLY playing,
// identified by videoId. Called on PlaybackActiveTrackChanged (auto-advance).
// Because it keys on the real track id, a stale/self-induced event can never
// leave the UI showing the wrong song.
async function reconcileActive(): Promise<void> {
  if (!source) return;
  let id: string | undefined;
  try {
    const t = await TrackPlayer.getActiveTrack();
    id = (t as {id?: string} | undefined)?.id;
  } catch {
    return;
  }
  if (!id || id === current?.videoId) return; // no real change
  if (windowNextId && id === windowNextId) {
    // Advanced to the preloaded next.
    activePos += 1;
    pos = activePos;
    current = timeline[activePos] ?? current;
    windowNextId = null;
    emitNowPlaying();
    requestPrefetch(source.peekNext?.() ?? null);
    void preloadNext();
    return;
  }
  // Unexpected id -> map it back into the timeline if we can.
  const i = timeline.findIndex(s => s.videoId === id);
  if (i >= 0) {
    activePos = i;
    pos = i;
    current = timeline[i];
    windowNextId = null;
    emitNowPlaying();
    void preloadNext();
  }
}

export function playFrom(src: QueueSource, first: Song): Promise<void> {
  cancelSeek();
  return serialize(async () => {
    source = src;
    pendingFallback = null;
    fallbackBySong.clear();
    src.reset(first);
    timeline = [first];
    pos = 0;
    activePos = 0;
    windowNextId = null;
    current = first;
    emitNowPlaying(); // optimistic: show the tapped song immediately

    // Do NOT auto-jump through the library on failure. If the chosen song
    // can't load (dead id, or -- far more often -- a flaky/slow connection),
    // stop ON THAT song and flag the error so the UI can offer retry/skip.
    // The old behaviour churned through up to 5 songs, each with its own slow
    // resolve, then errored anyway -- a terrible cascade on a bad network.
    // A failed song is the user's to skip, not the app's.
    const ok = await loadCurrent(first);
    if (!ok) {
      fallbackBySong.set(first.videoId, 'error');
      emitNowPlaying();
      await TrackPlayer.stop();
      return;
    }
    await preloadNext();
    // Warm the URL of the song after the window for a snappy following advance.
    requestPrefetch(source.peekNext?.() ?? null);
  });
}

// Manual next: move the pointer forward (extending the timeline at the frontier)
// and load the landed song when tapping stops. Instant UI flip; debounced load.
export function skipToNext(): Promise<void> {
  if (!source || !current) return Promise.resolve();
  if (pos === timeline.length - 1) {
    if (!extendTimeline()) return Promise.resolve(); // at the end of the source
  }
  pos += 1;
  current = timeline[pos];
  emitNowPlaying();
  requestPrefetch(current);
  scheduleSeek();
  return Promise.resolve();
}

// Manual previous: step the pointer back through the timeline. At the very start
// it restarts the current track.
export function skipToPrevious(): Promise<void> {
  if (!source || !current) return Promise.resolve();
  if (pos === 0) {
    cancelSeek();
    void serialize(() => TrackPlayer.seekTo(0));
    return Promise.resolve();
  }
  pos -= 1;
  current = timeline[pos];
  emitNowPlaying();
  requestPrefetch(current);
  scheduleSeek();
  return Promise.resolve();
}

// Fired once tapping stops: bring the player to timeline[pos].
function commitSeek(): void {
  seekTimer = null;
  seekActive = false;
  const targetPos = pos;
  void serialize(async () => {
    if (!source) return;
    const target = timeline[targetPos];
    if (!target) return;
    if (targetPos === activePos) {
      // Ping-ponged back to where we already are -> just resume.
      await TrackPlayer.play().catch(() => {});
      return;
    }
    if (targetPos === activePos + 1 && windowNextId === target.videoId) {
      // Adjacent forward to the already-preloaded next -> native skip (instant).
      try {
        await TrackPlayer.skipToNext();
      } catch {
        // ignore
      }
      await TrackPlayer.play().catch(() => {});
      activePos = targetPos;
      current = target;
      windowNextId = null;
      emitNowPlaying();
      requestPrefetch(source.peekNext?.() ?? null);
      await preloadNext();
    } else {
      // Jump (multi-song burst, or any backward move) -> load fresh.
      const ok = await loadCurrent(target);
      if (ok) {
        activePos = targetPos;
        await preloadNext();
      } else {
        // Landed on a song that won't load -> flag the error and stop here
        // rather than leaving an endless spinner. The user chose this song;
        // let them retry or skip again, don't silently churn onward.
        activePos = targetPos;
        fallbackBySong.set(target.videoId, 'error');
        emitNowPlaying();
        await TrackPlayer.stop().catch(() => {});
      }
    }
  });
}

// Called by the playback service on PlaybackActiveTrackChanged. Ignored while a
// seek burst is in progress (we're previewing with the player paused).
export function onActiveTrackChanged(): Promise<void> {
  if (seekActive) return Promise.resolve();
  return serialize(reconcileActive);
}

// Called on PlaybackError -- ExoPlayer failed to play the active track (e.g. a
// preloaded URL turned out dead, or the connection dropped mid-stream). Flag
// the error on the current song and STOP rather than stalling on an endless
// spinner or churning onward. Ignored mid-seek (a reset/re-add can briefly
// surface a transient error that isn't real).
export function handlePlaybackError(): Promise<void> {
  if (seekActive) return Promise.resolve();
  return serialize(async () => {
    if (current) {
      fallbackBySong.set(current.videoId, 'error');
      emitNowPlaying();
    }
    await TrackPlayer.stop().catch(() => {});
  });
}

// Called on PlaybackQueueEnded -- a genuine end (nothing preloaded). Try once
// more to extend + advance, else leave stopped. Repeat-one is native.
export async function handleQueueEnded(): Promise<void> {
  await serialize(async () => {
    if (!source) return;
    await preloadNext();
    if (windowNextId) {
      try {
        await TrackPlayer.skipToNext();
      } catch {
        // ignore
      }
      await reconcileActive();
    }
  });
}

export function nowPlaying(): Song | null {
  return current;
}

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

export function currentSource(): QueueSource | null {
  return source;
}

export function peekUpcoming(count: number): Song[] {
  return source?.peekUpcoming?.(count) ?? [];
}

// The committed next song (what plays next): the known timeline entry, else the
// source's best guess.
export function peekNextSong(): Song | null {
  return timeline[pos + 1] ?? source?.peekNext?.() ?? null;
}

// The videoId of the song ACTUALLY loaded/playing right now (distinct from
// `current`, which is the optimistic target during a seek). The Player uses this
// to know whether the shown song is really playing yet -- so it can snap the
// progress bar to 0 while a skip's song is still loading.
export function activeVideoId(): string | null {
  return timeline[activePos]?.videoId ?? null;
}

// The caller passes what it already knows the state to be (from its
// usePlaybackState hook), so we DON'T pay an extra getPlaybackState() native
// round-trip before acting -- that round-trip was the play/pause lag.
export async function togglePlayPause(isPlaying: boolean): Promise<void> {
  if (isPlaying) await TrackPlayer.pause();
  else await TrackPlayer.play();
}

// Test-only reset of module state.
export function _resetControllerForTests(): void {
  source = null;
  current = null;
  timeline = [];
  pos = 0;
  activePos = 0;
  windowNextId = null;
  repeatOne = false;
  preloadPromise = null;
  pendingFallback = null;
  fallbackBySong.clear();
  cancelSeek();
  opChain = Promise.resolve();
}
