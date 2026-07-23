// Covers Critical 2 (final-review): skipToNext used to loop forever when
// offline, because the retry-on-unplayable `while (candidate)` loop had no
// bound and a QueueSource (e.g. VibeQueue's random fallback) can keep
// producing candidates indefinitely without ever repeating a banned song.
// These tests drive the real controller module against mocked
// TrackPlayer/resolveStreamUrl so the consecutive-failure cap can be
// exercised without any native module.
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
    getPlaybackState: jest.fn().mockResolvedValue({state: 'none'}),
  },
  State: {Playing: 'playing', Paused: 'paused'},
  AppKilledPlaybackBehavior: {ContinuePlayback: 'continue-playback'},
  Capability: {},
}));

jest.mock('../src/stream/resolver', () => {
  class StreamResolveError extends Error {}
  return {
    __esModule: true,
    resolveStreamUrl: jest.fn(),
    StreamResolveError,
  };
});

import TrackPlayer from 'react-native-track-player';
import {resolveStreamUrl} from '../src/stream/resolver';
import {playFrom, skipToNext, consumeFallbackStatus} from '../src/player/controller';

function song(id: string): Song {
  return {videoId: id, title: id, artist: 'artist', durationS: 200, hasVibe: false};
}

// Mimics the offline hazard called out by the finding: a QueueSource that
// never runs out of candidates (no banning of failed songs, repeats
// allowed), the way VibeQueue's random fallback behaves once its weighted
// pool is exhausted.
class EndlessSource implements QueueSource {
  label = 'endless';
  private n = 0;
  next(_lastPlayed: Song | null): Song | null {
    this.n += 1;
    return song(`s${this.n}`);
  }
  reset(_seed: Song): void {}
}

describe('skipToNext: offline consecutive-failure cap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('stops retrying after 5 consecutive load failures instead of looping forever, and reports an error status', async () => {
    const resolveMock = resolveStreamUrl as jest.Mock;
    resolveMock.mockRejectedValue(new Error('network unreachable'));

    const src = new EndlessSource();
    // The initial playFrom() load also fails offline; that's expected and
    // not under test here -- it's only used to get the module's private
    // `source` pointed at our EndlessSource (mirrors real usage: playFrom is
    // the only way skipToNext has anything to skip through).
    await expect(playFrom(src, song('seed'))).rejects.toThrow();

    resolveMock.mockClear();
    (TrackPlayer.stop as jest.Mock).mockClear();

    await skipToNext();

    // Bounded, not infinite: exactly MAX_CONSECUTIVE_LOAD_FAILURES (5)
    // candidates were tried and abandoned, even though EndlessSource could
    // have supplied arbitrarily many more.
    expect(resolveMock).toHaveBeenCalledTimes(5);
    expect(TrackPlayer.stop).toHaveBeenCalledTimes(1);
    expect(consumeFallbackStatus()).toBe('error');
  });

  test('a later successful candidate still plays normally and does not trip the cap', async () => {
    const resolveMock = resolveStreamUrl as jest.Mock;
    resolveMock.mockRejectedValue(new Error('network unreachable'));

    const src = new EndlessSource();
    await expect(playFrom(src, song('seed'))).rejects.toThrow();

    resolveMock.mockClear();
    (TrackPlayer.stop as jest.Mock).mockClear();
    (TrackPlayer.play as jest.Mock).mockClear();

    let calls = 0;
    resolveMock.mockImplementation(() => {
      calls += 1;
      // Fails twice (well under the cap of 5), then the third candidate's
      // load succeeds -- the retry-on-unplayable path should still recover
      // normally rather than being short-circuited by the new cap.
      if (calls < 3) return Promise.reject(new Error('network unreachable'));
      return Promise.resolve({url: 'https://example.com/stream.mp3', headers: {}});
    });

    await skipToNext();

    expect(TrackPlayer.stop).not.toHaveBeenCalled();
    expect(TrackPlayer.play).toHaveBeenCalledTimes(1);
    expect(consumeFallbackStatus()).toBeNull();
  });
});
