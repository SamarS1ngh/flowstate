// Covers the windowed pre-buffer playback model: playFrom stages [current,next]
// so ExoPlayer pre-buffers the next; skipToNext hands off natively to the
// already-staged track; onNativeTrackChanged (the driver) advances JS state to
// match a native advance and re-stages the following song; the slow fallback
// path (no staged next) still resolves live and caps consecutive failures.
import {QueueSource} from '../src/player/queue';
import {Song} from '../src/types';

// Stateful TrackPlayer mock: a real little queue + active index so we can drive
// realistic advance/trim scenarios. Factory uses only inline jest.fn()s (no
// out-of-scope refs); stateful behavior is attached at run time in beforeEach.
jest.mock('react-native-track-player', () => ({
  __esModule: true,
  default: {
    setupPlayer: jest.fn(),
    updateOptions: jest.fn(),
    reset: jest.fn(),
    add: jest.fn(),
    play: jest.fn(),
    pause: jest.fn(),
    stop: jest.fn(),
    seekTo: jest.fn(),
    skipToNext: jest.fn(),
    remove: jest.fn(),
    getQueue: jest.fn(),
    getActiveTrackIndex: jest.fn(),
    getProgress: jest.fn(),
    getPlaybackState: jest.fn(),
  },
  State: {Playing: 'playing', Paused: 'paused'},
  Event: {},
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

import TrackPlayer from 'react-native-track-player';
import {resolveStreamUrl} from '../src/stream/resolver';
import {offlineUrl} from '../src/offline/downloads';
import {
  playFrom,
  skipToNext,
  skipToPrevious,
  onNativeTrackChanged,
  nowPlaying,
  consumeFallbackStatus,
} from '../src/player/controller';

const tp = TrackPlayer as unknown as Record<string, jest.Mock>;
const resolveMock = resolveStreamUrl as jest.Mock;
const offlineMock = offlineUrl as jest.Mock;

// The mock player's live queue state.
const q: {items: Array<{id: string}>; active: number | null} = {items: [], active: null};
const flush = () => new Promise<void>(r => setImmediate(() => r()));

function song(id: string): Song {
  return {videoId: id, title: id, artist: 'artist', durationS: 200, hasVibe: false};
}
const ids = () => q.items.map(t => t.id);

// Deterministic ordered source with peekNext (mirrors SimpleQueue's contract).
class PeekListSource implements QueueSource {
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

// A source whose next() never runs dry (mirrors VibeQueue's random fallback) --
// used to exercise the consecutive-failure cap. No peekNext -> nothing staged,
// so skipToNext always takes the slow path.
class EndlessSource implements QueueSource {
  label = 'endless';
  private n = 0;
  next(_l: Song | null): Song | null {
    this.n += 1;
    return song(`s${this.n}`);
  }
  reset(_s: Song): void {}
}

beforeEach(() => {
  jest.clearAllMocks();
  q.items = [];
  q.active = null;
  offlineMock.mockResolvedValue(null);
  resolveMock.mockResolvedValue({url: 'https://example.com/s.mp3', headers: {}});
  tp.reset.mockImplementation(async () => {
    q.items = [];
    q.active = null;
  });
  tp.add.mockImplementation(async (t: unknown) => {
    const arr = (Array.isArray(t) ? t : [t]) as Array<{id: string}>;
    q.items.push(...arr);
    if (q.active == null && q.items.length) q.active = 0;
  });
  tp.play.mockResolvedValue(undefined);
  tp.pause.mockResolvedValue(undefined);
  tp.stop.mockResolvedValue(undefined);
  tp.seekTo.mockResolvedValue(undefined);
  tp.skipToNext.mockImplementation(async () => {
    if (q.active != null && q.active < q.items.length - 1) q.active += 1;
  });
  tp.remove.mockImplementation(async (indices: number[]) => {
    const set = new Set(indices);
    const before = indices.filter(i => i < (q.active ?? 0)).length;
    q.items = q.items.filter((_, i) => !set.has(i));
    if (q.active != null) q.active -= before;
  });
  tp.getQueue.mockImplementation(async () => q.items);
  tp.getActiveTrackIndex.mockImplementation(async () => q.active);
  tp.getProgress.mockResolvedValue({position: 0, duration: 200, buffered: 0});
  tp.getPlaybackState.mockResolvedValue({state: 'none'});
});

describe('windowed pre-buffer', () => {
  test('playFrom stages [current, next] so the next is pre-buffered', async () => {
    await playFrom(new PeekListSource(['a', 'b', 'c']), song('a'));
    await flush();
    // Player holds a then b (the pre-buffered next); both were resolved.
    expect(ids()).toEqual(['a', 'b']);
    expect(nowPlaying()?.videoId).toBe('a');
    expect(resolveMock.mock.calls.map(c => c[0]).sort()).toEqual(['a', 'b']);
  });

  test('skipToNext hands off natively to the staged track (no reset/reload)', async () => {
    await playFrom(new PeekListSource(['a', 'b', 'c']), song('a'));
    await flush();
    tp.reset.mockClear();

    await skipToNext(); // fast path: b is staged -> native skipToNext
    expect(tp.skipToNext).toHaveBeenCalledTimes(1);
    expect(tp.reset).not.toHaveBeenCalled(); // did NOT tear down + reload

    // Simulate the resulting PlaybackActiveTrackChanged reaching the driver.
    await onNativeTrackChanged();
    await flush();

    expect(nowPlaying()?.videoId).toBe('b'); // advanced
    // Played 'a' trimmed; window is now [b, c] (c freshly pre-buffered).
    expect(ids()).toEqual(['b', 'c']);
  });

  test('a song ending auto-advances through the driver the same way', async () => {
    await playFrom(new PeekListSource(['a', 'b', 'c']), song('a'));
    await flush();
    // Player auto-advances to the staged next when 'a' ends.
    q.active = 1;
    await onNativeTrackChanged();
    await flush();
    expect(nowPlaying()?.videoId).toBe('b');
    expect(ids()).toEqual(['b', 'c']);
  });

  test('driver is a no-op for the current track (our own load echo)', async () => {
    await playFrom(new PeekListSource(['a', 'b', 'c']), song('a'));
    await flush();
    q.active = 0; // still on current
    await onNativeTrackChanged();
    await flush();
    expect(nowPlaying()?.videoId).toBe('a'); // unchanged
    expect(ids()).toEqual(['a', 'b']);
  });

  test('previous walks history back and rebuilds the window', async () => {
    await playFrom(new PeekListSource(['a', 'b', 'c']), song('a'));
    await flush();
    await skipToNext();
    await onNativeTrackChanged();
    await flush(); // now on b, history [a]

    await skipToPrevious(); // position 0 -> pop history -> a
    await flush();
    expect(nowPlaying()?.videoId).toBe('a');
    expect(tp.seekTo).not.toHaveBeenCalled(); // real previous, not a restart
  });

  test('previous restarts the track when >3s in (no history pop)', async () => {
    tp.getProgress.mockResolvedValue({position: 42, duration: 200, buffered: 0});
    await playFrom(new PeekListSource(['a', 'b']), song('a'));
    await flush();
    tp.reset.mockClear();
    await skipToPrevious();
    expect(tp.seekTo).toHaveBeenCalledWith(0);
    expect(tp.reset).not.toHaveBeenCalled();
  });
});

describe('offline-first', () => {
  test('a downloaded song plays from its local file without resolving', async () => {
    offlineMock.mockImplementation(async (id: string) =>
      id === 'a' ? 'file:///offline/a.audio' : null,
    );
    await playFrom(new PeekListSource(['a', 'b']), song('a'));
    await flush();
    // 'a' came from disk (never resolved); 'b' still resolved for pre-buffer.
    expect(resolveMock.mock.calls.map(c => c[0])).not.toContain('a');
    expect(q.items[0].id).toBe('a');
  });
});

describe('skip fallback (no staged next)', () => {
  test('stops after the consecutive-failure cap instead of looping forever', async () => {
    resolveMock.mockRejectedValue(new Error('offline'));
    // playFrom's own load fails offline (expected) -- just points source at us.
    await expect(playFrom(new EndlessSource(), song('seed'))).rejects.toThrow();
    resolveMock.mockClear();
    tp.stop.mockClear();

    await skipToNext(); // EndlessSource has no peekNext -> slow path
    expect(resolveMock).toHaveBeenCalledTimes(5); // capped
    expect(tp.stop).toHaveBeenCalledTimes(1);
    expect(consumeFallbackStatus()).toBe('error');
  });

  test('a later playable candidate still plays and resets the cap', async () => {
    resolveMock.mockRejectedValue(new Error('offline'));
    await expect(playFrom(new EndlessSource(), song('seed'))).rejects.toThrow();
    resolveMock.mockClear();

    let n = 0;
    resolveMock.mockImplementation(() => {
      n += 1;
      return n < 3
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({url: 'https://example.com/s.mp3', headers: {}});
    });
    await skipToNext();
    expect(tp.stop).not.toHaveBeenCalled();
    expect(nowPlaying()?.videoId).toBe('s3'); // third candidate played
  });
});
