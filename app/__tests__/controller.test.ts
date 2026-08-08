// Covers the WINDOWED native-advance model + COALESCED manual skips:
//  - playFrom loads the first song AND pre-loads the next into the player queue;
//  - a song ending advances to that pre-loaded track NATIVELY (no reset/gap) so
//    playback survives a locked screen;
//  - rapid "next" taps advance the UI instantly but load ONLY the landed song
//    (the player is paused during the burst, the load is debounced);
//  - previous reloads the played song from history;
//  - repeat-one maps to native RepeatMode.Track; the first-load failure cap holds.
import {QueueSource} from '../src/player/queue';
import {Song} from '../src/types';

// Stateful RNTP mock modelling the native queue + active index.
const mockState: {queue: string[]; active: number} = {queue: [], active: 0};

jest.mock('react-native-track-player', () => ({
  __esModule: true,
  default: {
    setupPlayer: jest.fn().mockResolvedValue(undefined),
    updateOptions: jest.fn().mockResolvedValue(undefined),
    reset: jest.fn(async () => {
      mockState.queue = [];
      mockState.active = 0;
    }),
    add: jest.fn(async (t: {id: string}) => {
      mockState.queue.push(t.id);
    }),
    play: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    seekTo: jest.fn().mockResolvedValue(undefined),
    skipToNext: jest.fn(async () => {
      if (mockState.active < mockState.queue.length - 1) mockState.active += 1;
    }),
    skipToPrevious: jest.fn(async () => {
      if (mockState.active > 0) mockState.active -= 1;
    }),
    getActiveTrackIndex: jest.fn(async () => mockState.active),
    getQueue: jest.fn(async () => mockState.queue.map((id: string) => ({id}))),
    removeUpcomingTracks: jest.fn(async () => {
      // Drop everything after the active track (never the playing one).
      mockState.queue = mockState.queue.slice(0, mockState.active + 1);
    }),
    getActiveTrack: jest.fn(async () => {
      const id = mockState.queue[mockState.active];
      return id != null ? {id} : undefined;
    }),
    setRepeatMode: jest.fn().mockResolvedValue(undefined),
    getProgress: jest.fn().mockResolvedValue({position: 0, duration: 200, buffered: 0}),
    getPlaybackState: jest.fn().mockResolvedValue({state: 'none'}),
  },
  State: {Playing: 'playing', Paused: 'paused'},
  Event: {},
  RepeatMode: {Off: 'off', Track: 'track', Queue: 'queue'},
  AppKilledPlaybackBehavior: {ContinuePlayback: 'continue-playback'},
  Capability: {},
}));

jest.mock('../src/stream/resolver', () => {
  class StreamResolveError extends Error {}
  return {__esModule: true, resolveStreamUrl: jest.fn(), StreamResolveError};
});

jest.mock('../src/offline/downloads', () => ({
  __esModule: true,
  offlineUrl: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/player/prefetchCache', () => ({
  __esModule: true,
  getPrefetchedStream: jest.fn().mockReturnValue(null),
  requestPrefetch: jest.fn(),
  requestPrefetchQueue: jest.fn(),
}));

import TrackPlayer from 'react-native-track-player';
import {resolveStreamUrl} from '../src/stream/resolver';
import {offlineUrl} from '../src/offline/downloads';
import {getPrefetchedStream, requestPrefetchQueue} from '../src/player/prefetchCache';
import {
  playFrom,
  skipToNext,
  skipToPrevious,
  onActiveTrackChanged,
  handleQueueEnded,
  setRepeatOne,
  isRepeatOne,
  peekNextSong,
  nowPlaying,
  consumeFallbackStatus,
  invalidateWindow,
  _resetControllerForTests,
} from '../src/player/controller';

const tp = TrackPlayer as unknown as Record<string, jest.Mock>;
const resolveMock = resolveStreamUrl as jest.Mock;
const offlineMock = offlineUrl as jest.Mock;
const prefetchedMock = getPrefetchedStream as jest.Mock;
const requestPrefetchQueueMock = requestPrefetchQueue as jest.Mock;

// Advance past the skip debounce AND flush the promise microtasks it schedules.
const settle = async () => {
  await jest.advanceTimersByTimeAsync(400);
};

function song(id: string): Song {
  return {videoId: id, title: id, artist: 'artist', durationS: 200, hasVibe: false};
}
const addedIds = () => tp.add.mock.calls.map(c => c[0].id);
const resolvedIds = () => resolveMock.mock.calls.map(c => c[0]);
const addedContains = (id: string) => tp.add.mock.calls.some(c => c[0].id === id);

// Simulate the real player finishing a track (native auto-advance): ExoPlayer
// moves to the next queued track and fires PlaybackActiveTrackChanged.
async function autoAdvance(): Promise<void> {
  if (mockState.active < mockState.queue.length - 1) mockState.active += 1;
  await onActiveTrackChanged();
  await settle();
}

class ListSource implements QueueSource {
  label = 'list';
  private i = 0;
  constructor(private list: string[]) {}
  reset(seed: Song): void {
    const j = this.list.indexOf(seed.videoId);
    this.i = j >= 0 ? j : 0;
  }
  next(_l: Song | null): Song | null {
    this.i += 1;
    return this.list[this.i] ? song(this.list[this.i]) : null;
  }
  peekNext(): Song | null {
    return this.list[this.i + 1] ? song(this.list[this.i + 1]) : null;
  }
}

class EndlessSource implements QueueSource {
  label = 'endless';
  private n = 0;
  next(_l: Song | null): Song | null {
    this.n += 1;
    return song(`s${this.n}`);
  }
  reset(_s: Song): void {}
}

// A source whose next pick can flip at runtime -- stands in for a VibeQueue
// whose mood/lock-drift change alters what it will pick next.
class SwitchSource implements QueueSource {
  label = 'switch';
  pick = 'b';
  reset(_s: Song): void {}
  next(_l: Song | null): Song | null {
    return song(this.pick);
  }
  peekNext(): Song | null {
    return song(this.pick);
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockState.queue = [];
  mockState.active = 0;
  _resetControllerForTests();
  offlineMock.mockResolvedValue(null);
  prefetchedMock.mockReturnValue(null);
  resolveMock.mockResolvedValue({url: 'https://example.com/s.mp3', headers: {}});
});

afterEach(() => {
  jest.useRealTimers();
});

describe('windowed native-advance', () => {
  test('playFrom loads the first song AND pre-loads the next', async () => {
    await playFrom(new ListSource(['a', 'b', 'c']), song('a'));
    await settle();
    expect(addedIds()).toEqual(['a', 'b']);
    expect(nowPlaying()?.videoId).toBe('a');
    expect(peekNextSong()?.videoId).toBe('b');
    // The upcoming songs' URLs are prefetched (the background-skip buffer).
    const q = requestPrefetchQueueMock.mock.calls.at(-1)?.[0] as Song[] | undefined;
    expect(q?.map(s => s.videoId)).toContain('b');
  });

  test('a song ending advances to the pre-loaded next NATIVELY (no reset)', async () => {
    await playFrom(new ListSource(['a', 'b', 'c']), song('a'));
    await settle();
    tp.reset.mockClear();

    await autoAdvance();

    expect(nowPlaying()?.videoId).toBe('b');
    expect(tp.reset).not.toHaveBeenCalled();
    expect(addedContains('c')).toBe(true);
  });

  test('the pre-loaded next uses a prefetched URL when available (no re-resolve)', async () => {
    prefetchedMock.mockImplementation((id: string) =>
      id === 'b' ? {url: 'https://cdn/b.mp3', headers: {}} : null,
    );
    resolveMock.mockClear();
    await playFrom(new ListSource(['a', 'b', 'c']), song('a'));
    await settle();
    expect(resolvedIds()).not.toContain('b');
    expect(tp.add.mock.calls.find(c => c[0].id === 'b')?.[0].url).toBe('https://cdn/b.mp3');
  });
});

describe('coalesced manual skips', () => {
  test('a single next tap flips instantly and advances via a native skip (no reload)', async () => {
    await playFrom(new ListSource(['a', 'b', 'c']), song('a'));
    await settle();
    tp.reset.mockClear();
    tp.skipToNext.mockClear();

    void skipToNext();
    expect(nowPlaying()?.videoId).toBe('b'); // instant flip, before any load
    expect(tp.pause).toHaveBeenCalled(); // burst pauses the old song

    await settle(); // debounce fires
    expect(nowPlaying()?.videoId).toBe('b');
    // landed on the pre-loaded window next -> native advance, NOT a reset+reload
    expect(tp.skipToNext).toHaveBeenCalled();
    expect(tp.reset).not.toHaveBeenCalled();
  });

  test('a rapid burst loads ONLY the landed song, never the ones skipped past', async () => {
    await playFrom(new ListSource(['a', 'b', 'c', 'd', 'e']), song('a'));
    await settle();
    tp.add.mockClear();
    resolveMock.mockClear();

    // four taps in the same tick -> land on 'e'
    void skipToNext();
    void skipToNext();
    void skipToNext();
    void skipToNext();
    expect(nowPlaying()?.videoId).toBe('e'); // UI advanced instantly
    expect(tp.add).not.toHaveBeenCalled(); // nothing loaded mid-burst

    await settle(); // tapping stopped -> load only 'e'
    expect(nowPlaying()?.videoId).toBe('e');
    expect(resolvedIds()).toContain('e');
    expect(resolvedIds()).not.toContain('b');
    expect(resolvedIds()).not.toContain('c');
    expect(resolvedIds()).not.toContain('d');
  });

  test('previous after a burst steps back one song at a time (not to the burst start)', async () => {
    await playFrom(new ListSource(['a', 'b', 'c', 'd', 'e']), song('a'));
    await settle();

    void skipToNext();
    void skipToNext();
    void skipToNext();
    void skipToNext();
    await settle(); // burst lands on 'e'
    expect(nowPlaying()?.videoId).toBe('e');

    await skipToPrevious();
    await settle();
    expect(nowPlaying()?.videoId).toBe('d'); // one back, NOT 'a'

    await skipToPrevious();
    await settle();
    expect(nowPlaying()?.videoId).toBe('c'); // another back
  });

  test('previous reloads the played song from history', async () => {
    await playFrom(new ListSource(['a', 'b', 'c']), song('a'));
    await settle();
    void skipToNext(); // -> b
    await settle(); // commit b, history [a]
    tp.add.mockClear();

    await skipToPrevious(); // pos 0 -> pop history -> a
    await settle();

    expect(nowPlaying()?.videoId).toBe('a');
    expect(addedContains('a')).toBe(true);
  });

  test('previous at the start of the timeline restarts the current track', async () => {
    await playFrom(new ListSource(['a', 'b']), song('a'));
    await settle();
    tp.reset.mockClear();

    await skipToPrevious(); // pos is 0 -> restart current, don't reload
    await settle();

    expect(tp.seekTo).toHaveBeenCalledWith(0);
    expect(tp.reset).not.toHaveBeenCalled();
  });

  test('ping-ponging next/previous then stopping loads the right song', async () => {
    await playFrom(new ListSource(['a', 'b', 'c', 'd']), song('a'));
    await settle();
    tp.reset.mockClear();

    // next, prev, next, prev, next -> net one forward, landing on 'b'
    void skipToNext();
    void skipToPrevious();
    void skipToNext();
    void skipToPrevious();
    void skipToNext();
    expect(nowPlaying()?.videoId).toBe('b');
    await settle();
    expect(nowPlaying()?.videoId).toBe('b'); // committed to the landed song, not a random one
  });
});

describe('offline-first', () => {
  test('a downloaded song plays from its local file without resolving', async () => {
    offlineMock.mockImplementation(async (id: string) =>
      id === 'a' ? 'file:///offline/a.audio' : null,
    );
    await playFrom(new ListSource(['a', 'b']), song('a'));
    await settle();
    expect(resolvedIds()).not.toContain('a');
    expect(tp.add.mock.calls[0][0].url).toBe('file:///offline/a.audio');
  });
});

describe('repeat-one', () => {
  test('setRepeatOne toggles the native RepeatMode', async () => {
    await setRepeatOne(true);
    expect(tp.setRepeatMode).toHaveBeenCalledWith('track');
    expect(isRepeatOne()).toBe(true);
    await setRepeatOne(false);
    expect(tp.setRepeatMode).toHaveBeenCalledWith('off');
    expect(isRepeatOne()).toBe(false);
  });
});

describe('failure handling', () => {
  test('a failed first load stops ON the song and flags error -- no auto-jump', async () => {
    resolveMock.mockRejectedValue(new Error('offline'));
    await playFrom(new EndlessSource(), song('seed'));
    await settle();
    // Must NOT churn through the library trying other songs.
    expect(resolveMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(nowPlaying()?.videoId).toBe('seed'); // stayed on the chosen song
    expect(tp.stop).toHaveBeenCalled();
    expect(consumeFallbackStatus()).toBe('error');
  });

  test('a hung load-fresh resolve does NOT jam the queue -- a later skip still advances', async () => {
    await playFrom(new ListSource(['a', 'b', 'c', 'd']), song('a'));
    await settle();
    // 'c' will never resolve (simulates a resolve that hangs backgrounded, where
    // the 15s timeout timer is frozen). 'd' resolves fine.
    resolveMock.mockImplementation((id: string) =>
      id === 'c'
        ? new Promise(() => {}) // never settles
        : Promise.resolve({url: 'https://example.com/s.mp3', headers: {}}),
    );
    await skipToNext(true); // -> 'b' (native preloaded)
    await settle();
    await skipToNext(true); // -> 'c' (load-fresh, resolve HANGS off-chain)
    await settle();
    await skipToNext(true); // -> 'd' (load-fresh, resolves)
    await settle();
    // The hung 'c' must not have blocked 'd': the queue advanced to 'd'.
    expect(addedContains('d')).toBe(true);
    expect(nowPlaying()?.videoId).toBe('d');
  });

  test('a remote (immediate) skip advances WITHOUT the debounce timer', async () => {
    await playFrom(new ListSource(['a', 'b', 'c']), song('a'));
    await settle();
    // immediate=true (notification/lock skip): must commit on microtasks alone,
    // since JS timers are frozen when the app is backgrounded.
    await skipToNext(true);
    for (let i = 0; i < 10; i++) await Promise.resolve(); // flush microtasks only
    expect(nowPlaying()?.videoId).toBe('b');
    // and it must NOT leave the player paused (the stuck-paused bug).
    expect(tp.pause).not.toHaveBeenCalled();
  });

  test('invalidateWindow drops the stale preloaded next and re-picks a fresh one', async () => {
    const s = new SwitchSource();
    await playFrom(s, song('a'));
    await settle();
    expect(addedContains('b')).toBe(true); // 'b' preloaded
    expect(peekNextSong()?.videoId).toBe('b');

    // Mood/mode change -> the source would now pick 'x' next.
    s.pick = 'x';
    await invalidateWindow();
    await settle();

    // The stale 'b' is dropped from the player queue and 'x' preloaded instead.
    expect(tp.removeUpcomingTracks).toHaveBeenCalled();
    expect(addedContains('x')).toBe(true);
    expect(peekNextSong()?.videoId).toBe('x');
  });

  test('end of queue: PlaybackQueueEnded with no next does not throw', async () => {
    await playFrom(new ListSource(['a']), song('a'));
    await settle();
    await expect(handleQueueEnded()).resolves.toBeUndefined();
  });

  // Regression: a track can end WHILE its successor is still being resolved
  // (slow network / search-fallback). handleQueueEnded must await that in-flight
  // preload and then advance -- not see a momentary "nothing preloaded" and
  // stop dead (the rare "doesn't move to next after completion" bug).
  test('queue ends mid-preload: awaits the in-flight resolve, then advances', async () => {
    await playFrom(new ListSource(['a', 'b', 'c']), song('a'));
    await settle();

    // Make the follow-up preload of 'c' (kicked when we land on 'b') hang.
    let releaseC: (v: {url: string; headers: Record<string, string>}) => void = () => {};
    resolveMock.mockImplementationOnce(
      () => new Promise(res => (releaseC = res)),
    );
    await autoAdvance(); // now on 'b'; preload of 'c' is in-flight (hung)
    expect(addedContains('c')).toBe(false);

    // 'b' ends before 'c' finished preloading.
    const ended = handleQueueEnded();
    releaseC({url: 'https://example.com/s.mp3', headers: {}});
    await ended;
    await settle();

    expect(addedContains('c')).toBe(true);
    expect(nowPlaying()?.videoId).toBe('c');
  });
});
