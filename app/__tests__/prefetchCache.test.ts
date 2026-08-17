// Verifies the prefetch cache's anti-anomaly guarantees on the URL-resolve
// version: never resolves the same song twice, never runs more than one resolve
// at a time (rapid requests coalesce to the latest target), bounded eviction.

jest.mock('../src/stream/resolver', () => {
  class StreamResolveError extends Error {}
  return {__esModule: true, resolveStreamUrl: jest.fn(), StreamResolveError};
});

import {resolveStreamUrl} from '../src/stream/resolver';
import {
  requestPrefetch,
  getPrefetchedStream,
  _resetPrefetchForTests,
} from '../src/player/prefetchCache';
import {Song} from '../src/types';

const resolveMock = resolveStreamUrl as jest.Mock;
const flush = () => new Promise<void>(r => setImmediate(() => r()));
const song = (id: string): Song => ({videoId: id, title: id, artist: 'a', durationS: 100, hasVibe: false});

// Each resolve parks a resolver so the test controls when it completes.
let pending: Array<{id: string; done: () => void}>;

beforeEach(() => {
  jest.clearAllMocks();
  _resetPrefetchForTests();
  pending = [];
  resolveMock.mockImplementation((id: string) => {
    let resolve!: () => void;
    const p = new Promise<{url: string}>(r => {
      resolve = () => r({url: `https://cdn/${id}.mp3`});
    });
    pending.push({id, done: resolve});
    return p;
  });
});

async function settle(): Promise<void> {
  await flush();
  await flush();
}

test('resolves a requested song and serves its stream', async () => {
  requestPrefetch(song('a'));
  await settle();
  expect(pending.map(p => p.id)).toEqual(['a']);
  pending.find(p => p.id === 'a')!.done();
  await settle();
  expect(getPrefetchedStream('a')?.url).toBe('https://cdn/a.mp3');
});

test('never resolves the same song twice', async () => {
  requestPrefetch(song('a'));
  requestPrefetch(song('a'));
  await settle();
  expect(pending.filter(p => p.id === 'a')).toHaveLength(1);
  pending[0].done();
  await settle();
  requestPrefetch(song('a')); // already cached -> no new resolve
  await settle();
  expect(resolveMock.mock.calls.filter(c => c[0] === 'a')).toHaveLength(1);
});

test('one resolve at a time; rapid requests coalesce to the LATEST target', async () => {
  requestPrefetch(song('a'));
  await settle();
  requestPrefetch(song('b')); // a still in flight -> just moves desired
  requestPrefetch(song('c')); // desired = c
  await settle();
  expect(pending.map(p => p.id)).toEqual(['a']); // b/c did NOT start concurrently

  pending.find(p => p.id === 'a')!.done();
  await settle();
  // chases the LATEST desired (c), skipping the superseded b
  expect(pending.map(p => p.id)).toEqual(['a', 'c']);
});

test('evicts to a bounded cache', async () => {
  // MAX_CACHED = 64. Cache 65 distinct ids -> the oldest is evicted.
  const ids = Array.from({length: 65}, (_, i) => `s${i}`);
  for (const id of ids) {
    requestPrefetch(song(id));
    await settle();
    pending.find(p => p.id === id)!.done();
    await settle();
  }
  expect(getPrefetchedStream('s0')).toBeNull(); // oldest of 65 evicted
  expect(getPrefetchedStream('s64')).not.toBeNull(); // newest kept
});
