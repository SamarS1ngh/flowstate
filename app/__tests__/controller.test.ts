// Covers the single-track + prefetch playback model: playFrom loads the first
// song and requests a prefetch of the next; a skip to a PREFETCHED song plays
// from its local file with no network resolve (the instant path); the fallback
// path still resolves live and caps consecutive failures; previous walks
// history; the old track is stopped before the new resolve.
import {QueueSource} from '../src/player/queue';
import {Song} from '../src/types';

jest.mock('react-native-track-player', () => ({
  __esModule: true,
  default: {
    setupPlayer: jest.fn().mockResolvedValue(undefined),
    updateOptions: jest.fn().mockResolvedValue(undefined),
    reset: jest.fn().mockResolvedValue(undefined),
    add: jest.fn().mockResolvedValue(undefined),
    play: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    seekTo: jest.fn().mockResolvedValue(undefined),
    getProgress: jest.fn().mockResolvedValue({position: 0, duration: 200, buffered: 0}),
    getPlaybackState: jest.fn().mockResolvedValue({state: 'none'}),
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

jest.mock('../src/player/prefetchCache', () => ({
  __esModule: true,
  getPrefetchedStream: jest.fn().mockReturnValue(null),
  requestPrefetch: jest.fn(),
}));

import TrackPlayer from 'react-native-track-player';
import {resolveStreamUrl} from '../src/stream/resolver';
import {offlineUrl} from '../src/offline/downloads';
import {getPrefetchedStream, requestPrefetch} from '../src/player/prefetchCache';
import {
  playFrom,
  skipToNext,
  skipToPrevious,
  nowPlaying,
  consumeFallbackStatus,
} from '../src/player/controller';

const tp = TrackPlayer as unknown as Record<string, jest.Mock>;
const resolveMock = resolveStreamUrl as jest.Mock;
const offlineMock = offlineUrl as jest.Mock;
const prefetchedMock = getPrefetchedStream as jest.Mock;
const requestPrefetchMock = requestPrefetch as jest.Mock;

const flush = () => new Promise<void>(r => setImmediate(() => r()));
// skipToNext/skipToPrevious are fire-and-forget now (a single-flight loader runs
// the async load), so let several microtask rounds drain before asserting.
const settle = async () => {
  for (let i = 0; i < 12; i++) await flush();
};

function song(id: string): Song {
  return {videoId: id, title: id, artist: 'artist', durationS: 200, hasVibe: false};
}
const addedIds = () => tp.add.mock.calls.map(c => c[0].id);
const resolvedIds = () => resolveMock.mock.calls.map(c => c[0]);

// Deterministic ordered source with peekNext (mirrors SimpleQueue).
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

// next() never runs dry (mirrors VibeQueue random fallback) -- for the cap test.
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
  offlineMock.mockResolvedValue(null);
  prefetchedMock.mockReturnValue(null);
  resolveMock.mockResolvedValue({url: 'https://example.com/s.mp3', headers: {}});
});

describe('single-track + prefetch playback', () => {
  test('playFrom loads the first song and requests a prefetch of the next', async () => {
    await playFrom(new ListSource(['a', 'b', 'c']), song('a'));
    await flush();
    expect(addedIds()).toEqual(['a']);
    expect(nowPlaying()?.videoId).toBe('a');
    // it kicked off prefetch of the next song 'b'
    expect(requestPrefetchMock).toHaveBeenCalled();
    expect(requestPrefetchMock.mock.calls.at(-1)?.[0]?.videoId).toBe('b');
  });

  test('a skip to a song with a pre-resolved URL uses it (no re-resolve)', async () => {
    prefetchedMock.mockImplementation((id: string) =>
      id === 'b' ? {url: 'https://cdn/b.mp3', headers: {}} : null,
    );
    await playFrom(new ListSource(['a', 'b', 'c']), song('a'));
    await flush();
    resolveMock.mockClear();

    await skipToNext(); // -> b, which is pre-resolved
    await settle();
    expect(resolveMock).not.toHaveBeenCalled(); // never re-resolved
    expect(tp.add.mock.calls.at(-1)?.[0].url).toBe('https://cdn/b.mp3');
    expect(nowPlaying()?.videoId).toBe('b');
  });

  test('a rapid burst of skips loads ONLY the final song, not each one', async () => {
    await playFrom(new ListSource(['a', 'b', 'c', 'd', 'e']), song('a'));
    await settle();
    tp.add.mockClear();
    resolveMock.mockClear();

    // Four taps in the same tick (no await between) -> current advances to 'e'.
    void skipToNext();
    void skipToNext();
    void skipToNext();
    void skipToNext();
    expect(nowPlaying()?.videoId).toBe('e'); // UI advanced instantly
    await settle();

    // Only 'e' was actually loaded -- b/c/d were never added to the player.
    expect(addedIds()).toEqual(['e']);
    expect(resolvedIds()).toEqual(['e']);
  });

  test('a skip to a NON-prefetched song resolves live', async () => {
    await playFrom(new ListSource(['a', 'b']), song('a'));
    await flush();
    resolveMock.mockClear();
    await skipToNext();
    await settle();
    expect(resolvedIds()).toContain('b');
    expect(nowPlaying()?.videoId).toBe('b');
  });

  test('old track is stopped (reset) before the new resolve', async () => {
    // reset must be called before resolveStreamUrl for the skip target.
    const order: string[] = [];
    tp.reset.mockImplementation(async () => order.push('reset'));
    resolveMock.mockImplementation(async () => {
      order.push('resolve');
      return {url: 'https://example.com/s.mp3', headers: {}};
    });
    await playFrom(new ListSource(['a', 'b']), song('a'));
    await flush();
    // for the initial load: reset happened before resolve
    expect(order.indexOf('reset')).toBeLessThan(order.indexOf('resolve'));
  });
});

describe('offline-first', () => {
  test('a downloaded song plays from its local file without resolving', async () => {
    offlineMock.mockImplementation(async (id: string) =>
      id === 'a' ? 'file:///offline/a.audio' : null,
    );
    await playFrom(new ListSource(['a', 'b']), song('a'));
    await flush();
    expect(resolvedIds()).not.toContain('a');
    expect(tp.add.mock.calls[0][0].url).toBe('file:///offline/a.audio');
  });
});

describe('skip fallback + previous', () => {
  test('stops after the consecutive-failure cap instead of looping forever', async () => {
    resolveMock.mockRejectedValue(new Error('offline'));
    await expect(playFrom(new EndlessSource(), song('seed'))).rejects.toThrow();
    resolveMock.mockClear();
    tp.stop.mockClear();

    await skipToNext();
    await settle();
    expect(resolveMock).toHaveBeenCalledTimes(5); // capped
    expect(tp.stop).toHaveBeenCalledTimes(1);
    expect(consumeFallbackStatus()).toBe('error');
  });

  test('previous walks history back near the start of the track', async () => {
    await playFrom(new ListSource(['a', 'b', 'c']), song('a'));
    await skipToNext(); // -> b, history [a]
    await settle();
    tp.add.mockClear();
    await skipToPrevious(); // pos 0 -> pop -> a
    await settle();
    expect(tp.add.mock.calls.at(-1)?.[0].id).toBe('a');
    expect(tp.seekTo).not.toHaveBeenCalled();
  });

  test('previous restarts the track when >3s in', async () => {
    tp.getProgress.mockResolvedValue({position: 42, duration: 200, buffered: 0});
    await playFrom(new ListSource(['a', 'b']), song('a'));
    tp.add.mockClear();
    await skipToPrevious();
    await settle();
    expect(tp.seekTo).toHaveBeenCalledWith(0);
    expect(tp.add).not.toHaveBeenCalled();
  });
});
