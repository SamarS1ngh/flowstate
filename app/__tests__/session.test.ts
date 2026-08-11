// Persist + restore + resume of the last-played session (player/session.ts).
// The controller, RNTP, AsyncStorage and the vibes db are mocked so these
// exercise session.ts's own logic in isolation.
//
// Architecture under test: restoreSession() REBUILDS the real queue source
// (so the restored player shows the true mode) and hands it to the controller's
// restoreForDisplay(song, src, positionS) -- display-only, no native play. The
// first play press routes through the controller's awaiting-resume flag
// (isAwaitingResume/resumeAwaiting), NOT a rebuild at play time.
import type {Song} from '../src/types';
import type {VibeSong} from '../src/engine/similarity';

const song = (id: string): Song => ({
  videoId: id,
  title: id,
  artist: 'a',
  durationS: 200,
  hasVibe: true,
});

// ── in-memory AsyncStorage ──
const store: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => (k in store ? store[k] : null)),
    setItem: jest.fn(async (k: string, v: string) => {
      store[k] = v;
    }),
    removeItem: jest.fn(async (k: string) => {
      delete store[k];
    }),
  },
}));

jest.mock('react-native-track-player', () => ({
  __esModule: true,
  default: {
    getProgress: jest.fn(async () => ({position: 42, duration: 200, buffered: 0})),
  },
}));

// Controller is fully mocked: session.ts is the unit under test. `awaiting`
// backs the isAwaitingResume/resumeAwaiting pair so a test can simulate the
// restored-but-not-yet-resumed state.
jest.mock('../src/player/controller', () => {
  let awaiting = false;
  return {
    __esModule: true,
    currentSource: jest.fn(),
    nowPlaying: jest.fn(),
    restoreForDisplay: jest.fn(() => {
      awaiting = true;
    }),
    isAwaitingResume: jest.fn(() => awaiting),
    resumeAwaiting: jest.fn(async () => {
      awaiting = false;
    }),
    togglePlayPause: jest.fn(async () => {}),
    reportFallback: jest.fn(),
    subscribeNowPlaying: jest.fn(() => () => {}),
    __setAwaiting: (v: boolean) => {
      awaiting = v;
    },
  };
});

// vibes db + feedback store, for the vibe rebuild path. Fixtures are built
// INSIDE the factory so the hoisted mock closes over nothing out of scope.
jest.mock('../src/db/vibesDb', () => {
  const vs = (id: string): VibeSong => ({
    videoId: id,
    song: {videoId: id, title: id, artist: 'a', durationS: 200, hasVibe: true},
    embedding: new Float32Array([0, 0, 0]),
    moods: {},
  });
  return {
    __esModule: true,
    openVibesDb: jest.fn(async () => ({
      getVibeSongs: jest.fn(() => [vs('a'), vs('b')]),
      handle: {},
    })),
  };
});
jest.mock('../src/engine/feedbackStore', () => ({
  __esModule: true,
  FeedbackStore: jest.fn().mockImplementation(() => ({
    ensureTables: jest.fn(),
    snapshot: jest.fn(() => ({
      pairCount: () => 0,
      songCount: () => 0,
      struckNeighbors: () => [],
    })),
  })),
}));

import {SimpleQueue} from '../src/player/queue';
import {RadioQueue} from '../src/engine/radioQueue';
import {VibeQueue} from '../src/engine/vibeQueue';
import {
  persistNow,
  restoreSession,
  playPressed,
  _resetSessionForTests,
} from '../src/player/session';

const mockCtl = jest.requireMock('../src/player/controller') as {
  currentSource: jest.Mock;
  nowPlaying: jest.Mock;
  restoreForDisplay: jest.Mock;
  isAwaitingResume: jest.Mock;
  resumeAwaiting: jest.Mock;
  togglePlayPause: jest.Mock;
  reportFallback: jest.Mock;
  subscribeNowPlaying: jest.Mock;
  __setAwaiting: (v: boolean) => void;
};

const radioSource = () => ({describe: () => ({kind: 'radio' as const})});

// The source restoreForDisplay was handed (its 2nd arg) on the last call.
const restoredSource = () => mockCtl.restoreForDisplay.mock.calls.at(-1)?.[1];

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  jest.clearAllMocks();
  mockCtl.__setAwaiting(false);
  _resetSessionForTests();
});

test('persistNow writes the live song, position and source descriptor', async () => {
  mockCtl.currentSource.mockReturnValue(radioSource());
  mockCtl.nowPlaying.mockReturnValue(song('a'));

  await persistNow();

  const raw = store['flowstate.player.session.v1'];
  expect(raw).toBeDefined();
  const snap = JSON.parse(raw);
  expect(snap.song.videoId).toBe('a');
  expect(snap.positionS).toBe(42);
  expect(snap.source).toEqual({kind: 'radio'});
});

test('persistNow is a no-op with no live source (display-only restore keeps its snapshot)', async () => {
  store['flowstate.player.session.v1'] = JSON.stringify({
    song: song('a'),
    positionS: 99,
    savedAt: 1,
    source: {kind: 'radio'},
  });
  mockCtl.currentSource.mockReturnValue(null);
  mockCtl.nowPlaying.mockReturnValue(song('a'));

  await persistNow();

  // untouched -> saved position preserved
  expect(JSON.parse(store['flowstate.player.session.v1']).positionS).toBe(99);
});

test('restoreSession rebuilds the source and shows it display-only (no play)', async () => {
  store['flowstate.player.session.v1'] = JSON.stringify({
    song: song('a'),
    positionS: 30,
    savedAt: 1,
    source: {kind: 'radio'},
  });

  await restoreSession();

  expect(mockCtl.restoreForDisplay).toHaveBeenCalledTimes(1);
  const [seed, src, positionS] = mockCtl.restoreForDisplay.mock.calls[0];
  expect(seed).toEqual(song('a'));
  expect(src).toBeInstanceOf(RadioQueue);
  expect(positionS).toBe(30);
  expect(mockCtl.togglePlayPause).not.toHaveBeenCalled();
  expect(mockCtl.resumeAwaiting).not.toHaveBeenCalled();
});

test('restoreSession ignores a missing or corrupt snapshot', async () => {
  await restoreSession(); // nothing stored
  expect(mockCtl.restoreForDisplay).not.toHaveBeenCalled();

  store['flowstate.player.session.v1'] = '{not json';
  await restoreSession();
  expect(mockCtl.restoreForDisplay).not.toHaveBeenCalled();
});

test('restoreSession rebuilds a vibe session with the persisted mode and mood', async () => {
  store['flowstate.player.session.v1'] = JSON.stringify({
    song: song('a'),
    positionS: 10,
    savedAt: 1,
    source: {kind: 'vibe', mode: 'lock', moodFilter: {key: 'energy', min: 0.5}},
  });

  await restoreSession();

  const src = restoredSource();
  expect(src).toBeInstanceOf(VibeQueue);
  expect(src.describe()).toEqual({
    kind: 'vibe',
    mode: 'lock',
    moodFilter: {key: 'energy', min: 0.5},
  });
});

test('restoreSession rebuilds a simple (playlist) session with its list and index', async () => {
  const songs = [song('a'), song('b'), song('c')];
  store['flowstate.player.session.v1'] = JSON.stringify({
    song: song('b'),
    positionS: 0,
    savedAt: 1,
    source: {kind: 'simple', songs, index: 1},
  });

  await restoreSession();

  const src = restoredSource();
  expect(src).toBeInstanceOf(SimpleQueue);
  expect(src.describe()).toEqual({kind: 'simple', songs, index: 1});
});

test('playPressed resumes a restored session via the controller (no toggle)', async () => {
  store['flowstate.player.session.v1'] = JSON.stringify({
    song: song('a'),
    positionS: 55,
    savedAt: 1,
    source: {kind: 'radio'},
  });
  await restoreSession(); // -> isAwaitingResume() now true

  await playPressed(false);

  expect(mockCtl.resumeAwaiting).toHaveBeenCalledTimes(1);
  expect(mockCtl.togglePlayPause).not.toHaveBeenCalled();
  expect(mockCtl.isAwaitingResume()).toBe(false); // consumed
});

test('playPressed with no pending restore is an ordinary toggle', async () => {
  await playPressed(true);
  expect(mockCtl.togglePlayPause).toHaveBeenCalledWith(true);
  expect(mockCtl.resumeAwaiting).not.toHaveBeenCalled();
});
