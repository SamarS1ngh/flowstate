// Unit coverage for the offline downloads module: batch dedup/tally, the
// Wi-Fi guard, and offlineUrl's self-heal when a file goes missing. All native
// deps (RNFS, NetInfo) and the db are mocked so this runs without a device.

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/data',
  exists: jest.fn(),
  mkdir: jest.fn(),
  unlink: jest.fn(),
  stat: jest.fn(),
  downloadFile: jest.fn(),
}));
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {fetch: jest.fn()},
}));
jest.mock('../src/analyze/analyzer', () => ({
  __esModule: true,
  isAnalyzeWifiOnly: jest.fn(),
}));
jest.mock('../src/stream/resolver', () => {
  class StreamResolveError extends Error {}
  return {__esModule: true, resolveStreamUrl: jest.fn(), StreamResolveError};
});
jest.mock('../src/db/vibesDb', () => ({
  __esModule: true,
  ensureBaseSchema: jest.fn(),
}));

import * as RNFS from '@dr.pogodin/react-native-fs';
import NetInfo from '@react-native-community/netinfo';
import {isAnalyzeWifiOnly} from '../src/analyze/analyzer';
import {resolveStreamUrl} from '../src/stream/resolver';
import {ensureBaseSchema} from '../src/db/vibesDb';
import {
  startDownloadBatch,
  getDownloadBatch,
  offlineUrl,
  downloadSong,
} from '../src/offline/downloads';

const rnfs = RNFS as unknown as Record<string, jest.Mock>;
const netFetch = (NetInfo as unknown as {fetch: jest.Mock}).fetch;
const wifiOnly = isAnalyzeWifiOnly as jest.Mock;
const resolve = resolveStreamUrl as jest.Mock;
const ensure = ensureBaseSchema as jest.Mock;

// Fake db: an in-memory downloads set + song lookups.
const store = {downloaded: new Set<string>(), paths: new Map<string, string>()};
const fakeDb = {
  getDownloadPath: (id: string) => store.paths.get(id) ?? null,
  getDownloadedIds: () => new Set(store.downloaded),
  getSong: (id: string) => ({videoId: id, title: 't', artist: 'a', durationS: 100, hasVibe: false}),
  addDownload: (id: string, path: string) => {
    store.downloaded.add(id);
    store.paths.set(id, path);
  },
  removeDownload: (id: string) => {
    store.downloaded.delete(id);
    store.paths.delete(id);
  },
  close: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  store.downloaded.clear();
  store.paths.clear();
  ensure.mockResolvedValue(fakeDb);
  wifiOnly.mockResolvedValue(false);
  netFetch.mockResolvedValue({type: 'wifi'});
  resolve.mockResolvedValue({url: 'https://x/y', headers: {}});
  rnfs.exists.mockResolvedValue(true);
  rnfs.mkdir.mockResolvedValue(undefined);
  rnfs.unlink.mockResolvedValue(undefined);
  rnfs.stat.mockResolvedValue({size: 1234});
  rnfs.downloadFile.mockReturnValue({promise: Promise.resolve({statusCode: 200})});
});

test('downloadSong writes a row and reports success', async () => {
  const ok = await downloadSong('song1');
  expect(ok).toBe(true);
  expect(store.downloaded.has('song1')).toBe(true);
  expect(store.paths.get('song1')).toBe('/data/offline/song1.audio');
});

test('downloadSong is idempotent (already-downloaded -> no re-fetch)', async () => {
  store.downloaded.add('song1');
  store.paths.set('song1', '/data/offline/song1.audio');
  const ok = await downloadSong('song1');
  expect(ok).toBe(true);
  expect(resolve).not.toHaveBeenCalled();
});

test('downloadSong returns false and cleans up on a bad HTTP status', async () => {
  rnfs.downloadFile.mockReturnValue({promise: Promise.resolve({statusCode: 403})});
  const ok = await downloadSong('song1');
  expect(ok).toBe(false);
  expect(store.downloaded.has('song1')).toBe(false);
  expect(rnfs.unlink).toHaveBeenCalled();
});

test('batch skips already-downloaded ids and tallies ok/failed', async () => {
  store.downloaded.add('a'); // already have 'a'
  // 'b' succeeds, 'c' fails (empty file)
  rnfs.stat.mockImplementation((p: string) =>
    Promise.resolve({size: p.includes('c.audio') ? 0 : 1234}),
  );

  await startDownloadBatch(['a', 'b', 'c']);
  const s = getDownloadBatch();
  expect(s.total).toBe(2); // 'a' skipped up front
  expect(s.ok).toBe(1); // 'b'
  expect(s.failed).toEqual(['c']);
  expect(s.running).toBe(false);
});

test('batch pauses for network when Wi-Fi-only is on and on cellular', async () => {
  wifiOnly.mockResolvedValue(true);
  netFetch.mockResolvedValue({type: 'cellular'});
  await startDownloadBatch(['a', 'b']);
  const s = getDownloadBatch();
  expect(s.pausedForNetwork).toBe(true);
  expect(s.running).toBe(false);
  expect(resolve).not.toHaveBeenCalled();
});

test('offlineUrl self-heals a dangling row whose file is gone', async () => {
  store.downloaded.add('a');
  store.paths.set('a', '/data/offline/a.audio');
  rnfs.exists.mockResolvedValue(false); // file vanished
  const url = await offlineUrl('a');
  expect(url).toBeNull();
  expect(store.paths.has('a')).toBe(false); // row removed
});

test('offlineUrl returns a file:// url for a present download', async () => {
  store.paths.set('a', '/data/offline/a.audio');
  rnfs.exists.mockResolvedValue(true);
  const url = await offlineUrl('a');
  expect(url).toBe('file:///data/offline/a.audio');
});
