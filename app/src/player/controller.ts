import TrackPlayer, {RepeatMode} from 'react-native-track-player';
import {Song} from '../types';
import {resolveStreamUrl, StreamResolveError} from '../stream/resolver';
import {offlineUrl} from '../offline/downloads';
import {getPrefetchedStream, requestPrefetch, requestPrefetchQueue} from './prefetchCache';
import {QueueSource} from './queue';
import {holdPlaybackLocks, releasePlaybackLocks} from './playbackLocks';
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
// Bounded retry for preloading the next song. If the next song's resolve fails,
// we retry a FEW times (with backoff) so a transient blip doesn't leave the
// boundary advance empty -- but we must NOT retry forever: a stuck preload
// hammering the resolver every couple seconds is exactly what trips YouTube's
// rate limiting ("all songs suddenly fail"). After the cap we give up until the
// next natural trigger (a skip or a track advance re-arms it fresh).
let preloadRetryTimer: ReturnType<typeof setTimeout> | null = null;
let preloadFailStreak = 0;
const PRELOAD_MAX_RETRIES = 3;
const PRELOAD_RETRY_BASE_MS = 3000;
function clearPreloadRetry(): void {
  if (preloadRetryTimer) {
    clearTimeout(preloadRetryTimer);
    preloadRetryTimer = null;
  }
  preloadFailStreak = 0;
}
function schedulePreloadRetry(): void {
  if (preloadRetryTimer || windowNextId) return;
  if (preloadFailStreak >= PRELOAD_MAX_RETRIES) return; // give up -> no hammering
  const delay = PRELOAD_RETRY_BASE_MS * preloadFailStreak; // 3s, 6s, 9s (backoff)
  preloadRetryTimer = setTimeout(() => {
    preloadRetryTimer = null;
    if (!windowNextId && source && current) void preloadNext();
  }, delay);
}

type Stream = {url: string; headers?: Record<string, string>};

// Serialize every player mutation so async loads never interleave. Only NATIVE
// TrackPlayer calls go through here -- never a network resolve, which can hang
// (its timeout timer is frozen when backgrounded) and would deadlock the queue.
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
// `immediate` = commit the seek NOW instead of after the debounce. Used for
// remote (notification / lock-screen / headset) skips: RN throttles JS timers
// when the app is backgrounded, so a setTimeout-based commit never fires there
// -- the pointer moves and audio pauses but the track never actually switches
// until the app is foregrounded (the "notification next only works in
// foreground" bug). Native calls + promise microtasks DO run in the
// background, so committing directly works. Rapid remote presses still
// coalesce because commitSeek reads the LATEST pos at run time.
function scheduleSeek(immediate = false): void {
  if (immediate) {
    // Commit NOW, and do NOT pause first. The debounce-time pause() only exists
    // to silence the old track during the wait -- an immediate commit has no
    // wait. Worse, pausing then playing from a BACKGROUNDED app can't always
    // re-acquire audio focus (autoHandleInterruptions), which left remote skips
    // stuck PAUSED after a couple of presses. commitSeek switches + plays on its
    // own, so skip the pause entirely here.
    if (seekTimer) {
      clearTimeout(seekTimer);
      seekTimer = null;
    }
    seekActive = false;
    commitSeek();
    return;
  }
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

// Pre-resolve the URLs of the next several upcoming songs (the background-skip
// buffer). This is what makes notification skipping work backgrounded: a live
// resolve HANGS when the app is backgrounded (the OS freezes its network), so
// the ONLY way a skip works there is if the target's URL was already resolved
// while foreground. So we commit the timeline a few songs ahead (via the
// source's real next() -- works for vibe AND plain queues) and prefetch those
// URLs. The 1-deep native preload then always hits the cache, so every skip
// stays a native queue advance with no network on its path.
const PREFETCH_AHEAD = 12;
function prefetchAhead(): void {
  if (!source) return;
  // Commit the timeline a few picks ahead (idempotent -- extendTimeline only
  // grows it; preloadNext reuses the same committed entries).
  while (timeline.length <= activePos + PREFETCH_AHEAD) {
    if (!extendTimeline()) break; // source exhausted
  }
  const ahead: Song[] = [];
  for (let i = activePos + 1; i < timeline.length && i <= activePos + PREFETCH_AHEAD; i++) {
    ahead.push(timeline[i]);
  }
  if (ahead.length > 0) requestPrefetchQueue(ahead);
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
  holdPlaybackLocks(); // keep Wi-Fi/CPU awake so background resolves keep flowing
  current = song;
  windowNextId = null;
  clearPreloadRetry(); // fresh song -> any pending retry targets the old next
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
      // Resolve the URL OFF the serialize chain (slow) ...
      const stream = await resolveStream(nx);
      // ... but do the native TrackPlayer.add ON the chain. Native player
      // mutations must never overlap (a reset/play from a concurrent
      // loadCurrent racing this add wedges RNTP's native layer -- an await
      // that never resolves, which permanently deadlocks the whole serialize
      // queue and freezes every future skip). serialize() guarantees they run
      // strictly one-at-a-time.
      await serialize(async () => {
        if (windowNextId) return; // someone else won the race
        if (timeline[activePos + 1]?.videoId !== nx.videoId) return; // frontier moved
        await TrackPlayer.add(toTrack(nx, stream));
        windowNextId = nx.videoId;
        clearPreloadRetry(); // success: stop retrying
        emitNowPlaying(); // Up Next can now show it
      });
    } catch {
      // Resolve failed (transient blip, or a rate-limit). Retry a bounded number
      // of times with backoff so we don't hammer the resolver (which trips
      // YouTube's rate limiting). After the cap, give up until the next natural
      // trigger re-arms preloading.
      preloadFailStreak += 1;
      schedulePreloadRetry();
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
    prefetchAhead();
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
      releasePlaybackLocks();
      return false;
    }
    return true;
  }).then(ok => {
    // Preload AFTER the serialize block, not inside it: preloadNext serializes
    // its own native add, and awaiting it from within a serialize job would
    // queue that add behind this very job -> deadlock.
    if (ok && source) {
      void preloadNext();
      prefetchAhead();
    }
  });
}

// Manual next: move the pointer forward (extending the timeline at the frontier)
// and load the landed song when tapping stops. Instant UI flip; debounced load.
// `immediate` (remote/notification skips) commits now instead of via the
// background-throttled debounce timer -- see scheduleSeek.
export function skipToNext(immediate = false): Promise<void> {
  if (!source || !current) {
    return Promise.resolve();
  }
  if (pos === timeline.length - 1) {
    if (!extendTimeline()) {
      return Promise.resolve(); // at the end of the source
    }
  }
  pos += 1;
  current = timeline[pos];
  emitNowPlaying();
  requestPrefetch(current);
  scheduleSeek(immediate);
  return Promise.resolve();
}

// Manual previous: step the pointer back through the timeline. At the very start
// it restarts the current track.
export function skipToPrevious(immediate = false): Promise<void> {
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
  scheduleSeek(immediate);
  return Promise.resolve();
}

// Fired once tapping stops: bring the player to timeline[pos].
function commitSeek(): void {
  seekTimer = null;
  seekActive = false;
  // NOTE: the outer body is NOT serialized. Only the native TrackPlayer
  // mutations below are wrapped in serialize(). The network RESOLVE for a
  // load-fresh jump is done OFF the chain -- crucial, because that resolve can
  // hang (its 15s timeout is a setTimeout, which Android FREEZES when the app
  // is backgrounded, so it never fires). If the resolve ran on the serialize
  // chain, one hung resolve would deadlock the queue and every future skip
  // would jam behind it -- the "notification next stops working in the
  // background" bug. Off the chain, a hung resolve only strands its own skip.
  void (async () => {
    const targetPos = pos;
    const target = timeline[targetPos];
    if (!source || !target) return;

    // Already on this song -> just make sure we're playing.
    if (targetPos === activePos) {
      await serialize(() => TrackPlayer.play().catch(() => {}));
      return;
    }

    // Adjacent forward to the already-preloaded next -> instant native skip,
    // no resolve on the critical path.
    if (targetPos === activePos + 1 && windowNextId === target.videoId) {
      await serialize(async () => {
        if (activePos !== targetPos - 1 || windowNextId !== target.videoId) return;
        try {
          await TrackPlayer.skipToNext();
        } catch {
          // ignore
        }
        await TrackPlayer.play().catch(() => {});
        holdPlaybackLocks();
        activePos = targetPos;
        current = target;
        windowNextId = null;
        emitNowPlaying();
        prefetchAhead();
      });
      void preloadNext();
      return;
    }

    // Load-fresh jump (backward, or the next wasn't preloaded). Resolve the URL
    // OFF the serialize chain, then do the native reset/add/play ON it.
    let stream: Stream | null = null;
    try {
      stream = await resolveStream(target);
    } catch {
      stream = null;
    }
    if (pos !== targetPos) return; // a newer skip superseded this one -> drop it

    await serialize(async () => {
      if (pos !== targetPos) return; // superseded while queued
      if (!stream) {
        // Won't load (dead id / connection down) -> flag error + stop, rather
        // than an endless spinner. The user can retry or skip again.
        activePos = targetPos;
        current = target;
        fallbackBySong.set(target.videoId, 'error');
        emitNowPlaying();
        await TrackPlayer.stop().catch(() => {});
        releasePlaybackLocks();
        return;
      }
      await TrackPlayer.reset();
      await TrackPlayer.add(toTrack(target, stream));
      await TrackPlayer.play();
      holdPlaybackLocks();
      activePos = targetPos;
      current = target;
      windowNextId = null;
      clearPreloadRetry();
      emitNowPlaying();
    });
    void preloadNext();
    prefetchAhead();
  })();
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
    releasePlaybackLocks();
  });
}

// Discard the preloaded "next" and re-pick it from the source. The vibe
// controls (mood filter, lock/drift, reject) change what the source will pick
// NEXT -- but by then we've usually already preloaded the OLD pick into
// ExoPlayer's queue (windowNextId) and committed it onto the timeline, so the
// change wouldn't take effect until a song or two later. This drops that stale
// preload from the player, trims the timeline frontier back to the active
// song, and re-preloads a fresh pick so the change lands on the very next
// advance. Only touches songs AFTER the active one -- current playback is
// untouched.
export async function invalidateWindow(): Promise<void> {
  await serialize(async () => {
    if (!source || !current) return;
    // Only safe to touch the queue when the active track is really the one we
    // think is current -- otherwise a mid-transition remove could drop the
    // wrong track. If they disagree, skip (a fresh window will form on the
    // next natural advance anyway).
    let activeId: string | undefined;
    try {
      const t = await TrackPlayer.getActiveTrack();
      activeId = (t as {id?: string} | undefined)?.id;
    } catch {
      return;
    }
    if (activeId !== current.videoId) return;
    // Drop everything queued AFTER the active track (the stale preload). This
    // is the purpose-built, index-safe API -- it never removes the playing
    // track, so current playback is untouched.
    try {
      await TrackPlayer.removeUpcomingTracks();
    } catch {
      // best-effort; clearing windowNextId below still forces a fresh re-pick
    }
    windowNextId = null;
    timeline = timeline.slice(0, activePos + 1);
    if (pos > activePos) pos = activePos;
  });
  // Preload OUTSIDE the serialize block (it serializes its own native add).
  if (source) {
    void preloadNext();
    prefetchAhead();
    emitNowPlaying();
  }
}

// Called on PlaybackQueueEnded -- a genuine end (nothing preloaded). Try once
// more to extend + advance, else leave stopped. Repeat-one is native.
export async function handleQueueEnded(): Promise<void> {
  if (!source) return;
  // Preload OUTSIDE serialize (it serializes its own native add). Awaiting it
  // inside a serialize block would nest-deadlock.
  await preloadNext();
  if (windowNextId) {
    await serialize(async () => {
      try {
        await TrackPlayer.skipToNext();
      } catch {
        // ignore
      }
      await reconcileActive();
    });
  }
}

export function nowPlaying(): Song | null {
  return current;
}

// ── Session restore ──────────────────────────────────────────────────────────
// The last-played track survives the app being killed so the mini player can
// show it on next launch (see player/session.ts, which owns the persisted
// snapshot). Restore is two-step so a relaunch never auto-blares audio:
//   1. restoreForDisplay() sets `current` WITHOUT touching the native player --
//      the mini player renders the song, paused, with no queue/source yet.
//   2. the first play press hydrates the real queue at the saved position
//      (session.playPressed -> loadAtPosition), which builds a fresh source and
//      resumes playback.

/**
 * Show a restored song in the mini player without starting playback. No native
 * TrackPlayer calls -- `source` stays null, so a play press routes through
 * session.playPressed()'s resume path rather than togglePlayPause.
 */
export function restoreForDisplay(song: Song): void {
  source = null;
  timeline = [];
  pos = 0;
  activePos = 0;
  windowNextId = null;
  current = song;
  emitNowPlaying();
}

/**
 * Load `src`/`first` and seek to `positionS` before it starts — used to resume a
 * restored session where the user left off. Reuses playFrom (which resets the
 * player, loads, and preloads the next), then seeks the freshly-loaded track.
 */
export async function loadAtPosition(
  src: QueueSource,
  first: Song,
  positionS: number,
): Promise<void> {
  await playFrom(src, first);
  if (positionS > 0) {
    try {
      await TrackPlayer.seekTo(positionS);
    } catch {
      // seek is best-effort; playback already started from 0 if it fails
    }
  }
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
  if (isPlaying) {
    await TrackPlayer.pause();
    releasePlaybackLocks(); // paused -> no need to keep Wi-Fi/CPU awake
  } else {
    await TrackPlayer.play();
    holdPlaybackLocks();
  }
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
  clearPreloadRetry();
  pendingFallback = null;
  fallbackBySong.clear();
  cancelSeek();
  opChain = Promise.resolve();
}
