// Persist + restore + resume of the last-played session (player/session.ts).
// The controller, RNTP, AsyncStorage and the vibes db are mocked so these
// exercise session.ts's own logic in isolation.
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

// Controller is fully mocked: session.ts is the unit under test. Built inside
// the factory (ES imports hoist above module-body consts, so a factory that
// closed over an outer const would see it in the TDZ). The handle is retrieved
// via requireMock after imports, below.
jest.mock('../src/player/controller', () => ({
  __esModule: true,
  currentSource: jest.fn(),
  nowPlaying: jest.fn(),
  restoreForDisplay: jest.fn(),
  loadAtPosition: jest.fn(async () => {}),
  togglePlayPause: jest.fn(async () => {}),
  reportFallback: jest.fn(),
  subscribeNowPlaying: jest.fn(() => () => {}),
}));

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
  hasPendingRestore,
  _resetSessionForTests,
} from '../src/player/session';

const mockCtl = jest.requireMock('../src/player/controller') as {
  currentSource: jest.Mock;
  nowPlaying: jest.Mock;
  restoreForDisplay: jest.Mock;
  loadAtPosition: jest.Mock;
  togglePlayPause: jest.Mock;
  reportFallback: jest.Mock;
  subscribeNowPlaying: jest.Mock;
};

const radioSource = () => ({describe: () => ({kind: 'radio' as const})});

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  jest.clearAllMocks();
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

test('restoreSession loads the snapshot and shows it paused, without playing', async () => {
  store['flowstate.player.session.v1'] = JSON.stringify({
    song: song('a'),
    positionS: 30,
    savedAt: 1,
    source: {kind: 'radio'},
  });

  await restoreSession();

  expect(hasPendingRestore()).toBe(true);
  expect(mockCtl.restoreForDisplay).toHaveBeenCalledWith(song('a'));
  expect(mockCtl.togglePlayPause).not.toHaveBeenCalled();
  expect(mockCtl.loadAtPosition).not.toHaveBeenCalled();
});

test('restoreSession ignores a missing or corrupt snapshot', async () => {
  await restoreSession(); // nothing stored
  expect(hasPendingRestore()).toBe(false);

  store['flowstate.player.session.v1'] = '{not json';
  await restoreSession();
  expect(hasPendingRestore()).toBe(false);
});

test('playPressed resumes a pending radio session at the saved position', async () => {
  store['flowstate.player.session.v1'] = JSON.stringify({
    song: song('a'),
    positionS: 55,
    savedAt: 1,
    source: {kind: 'radio'},
  });
  mockCtl.currentSource.mockReturnValue(null); // display-only
  await restoreSession();

  await playPressed(false);

  expect(mockCtl.loadAtPosition).toHaveBeenCalledTimes(1);
  const [src, seed, positionS] = mockCtl.loadAtPosition.mock.calls[0];
  expect(src).toBeInstanceOf(RadioQueue);
  expect(seed).toEqual(song('a'));
  expect(positionS).toBe(55);
  expect(hasPendingRestore()).toBe(false); // consumed
  expect(mockCtl.togglePlayPause).not.toHaveBeenCalled();
});

test('playPressed rebuilds a vibe session with the persisted mode and mood', async () => {
  store['flowstate.player.session.v1'] = JSON.stringify({
    song: song('a'),
    positionS: 10,
    savedAt: 1,
    source: {kind: 'vibe', mode: 'lock', moodFilter: {key: 'energy', min: 0.5}},
  });
  mockCtl.currentSource.mockReturnValue(null);
  await restoreSession();

  await playPressed(false);

  const [src] = mockCtl.loadAtPosition.mock.calls[0];
  expect(src).toBeInstanceOf(VibeQueue);
  expect(src.describe()).toEqual({
    kind: 'vibe',
    mode: 'lock',
    moodFilter: {key: 'energy', min: 0.5},
  });
});

test('playPressed rebuilds a simple (playlist) session with its list and index', async () => {
  const songs = [song('a'), song('b'), song('c')];
  store['flowstate.player.session.v1'] = JSON.stringify({
    song: song('b'),
    positionS: 0,
    savedAt: 1,
    source: {kind: 'simple', songs, index: 1},
  });
  mockCtl.currentSource.mockReturnValue(null);
  await restoreSession();

  await playPressed(false);

  const [src] = mockCtl.loadAtPosition.mock.calls[0];
  expect(src).toBeInstanceOf(SimpleQueue);
  expect(src.describe()).toEqual({kind: 'simple', songs, index: 1});
});

test('playPressed with no pending restore is an ordinary toggle', async () => {
  mockCtl.currentSource.mockReturnValue(null);
  await playPressed(true);
  expect(mockCtl.togglePlayPause).toHaveBeenCalledWith(true);
  expect(mockCtl.loadAtPosition).not.toHaveBeenCalled();
});

test('a live source supersedes a stale pending restore', async () => {
  store['flowstate.player.session.v1'] = JSON.stringify({
    song: song('a'),
    positionS: 5,
    savedAt: 1,
    source: {kind: 'radio'},
  });
  await restoreSession();
  expect(hasPendingRestore()).toBe(true);

  // User started something else -> a real source now exists.
  mockCtl.currentSource.mockReturnValue(radioSource());
  await playPressed(true);

  expect(mockCtl.togglePlayPause).toHaveBeenCalledWith(true);
  expect(mockCtl.loadAtPosition).not.toHaveBeenCalled();
  expect(hasPendingRestore()).toBe(false);
});
