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
    getProgress: jest.fn().mockResolvedValue({position: 0, duration: 200, buffered: 0}),
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
import {playFrom, skipToNext, skipToPrevious, consumeFallbackStatus} from '../src/player/controller';

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

describe('skipToPrevious: history-backed previous song', () => {
  const resolveMock = resolveStreamUrl as jest.Mock;
  const addMock = TrackPlayer.add as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    resolveMock.mockResolvedValue({url: 'https://example.com/s.mp3', headers: {}});
    (TrackPlayer.getProgress as jest.Mock).mockResolvedValue({position: 0, duration: 200, buffered: 0});
  });

  // A simple ordered source so skipToNext produces deterministic songs.
  class ListSource implements QueueSource {
    label = 'list';
    constructor(private ids: string[]) {}
    private i = 0;
    reset(_seed: Song): void {
      this.i = 0;
    }
    next(_last: Song | null): Song | null {
      this.i += 1;
      return this.ids[this.i - 1] ? song(this.ids[this.i - 1]) : null;
    }
  }

  function lastAddedId(): string {
    const calls = addMock.mock.calls;
    return calls[calls.length - 1][0].id;
  }

  test('near the start, previous loads the actually-previous song from history', async () => {
    await playFrom(new ListSource(['b', 'c']), song('a')); // playing a
    await skipToNext(); // -> b, history [a]
    expect(lastAddedId()).toBe('b');

    await skipToPrevious(); // position 0 (<3s) -> pop history -> a
    expect(lastAddedId()).toBe('a');
    // seekTo(0) is NOT used when there's real history to go back to
    expect((TrackPlayer.seekTo as jest.Mock)).not.toHaveBeenCalled();
  });

  test('more than 3s into a track, previous restarts it (no history pop)', async () => {
    (TrackPlayer.getProgress as jest.Mock).mockResolvedValue({position: 42, duration: 200, buffered: 0});
    await playFrom(new ListSource(['b']), song('a'));
    await skipToNext(); // -> b, history [a]
    addMock.mockClear();

    await skipToPrevious(); // 42s in -> restart current, don't touch history
    expect(TrackPlayer.seekTo).toHaveBeenCalledWith(0);
    expect(addMock).not.toHaveBeenCalled();
  });

  test('with no history (session start), previous restarts current', async () => {
    await playFrom(new ListSource([]), song('only'));
    addMock.mockClear();
    await skipToPrevious(); // position 0 but history empty -> restart
    expect(TrackPlayer.seekTo).toHaveBeenCalledWith(0);
    expect(addMock).not.toHaveBeenCalled();
  });
});
