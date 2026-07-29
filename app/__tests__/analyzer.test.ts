// Unit tests for src/analyze/analyzer.ts's scheduling/orchestration logic:
// skip-if-already-analyzed, failure handling + temp-file cleanup, the
// single-job-at-a-time mutex, and analyzeMany's progress accounting +
// cancellation + resumability. Every native/IO dependency (RNFS, the
// resolver, the native AudioMel decode, the TFLite models, and the sqlite
// writer) is mocked -- the real end-to-end pipeline is device-verified
// (see the task report), matching this repo's existing convention for
// orchestration modules over native/IO (e.g. __tests__/controller.test.ts).
import * as RNFS from '@dr.pogodin/react-native-fs';
import {resolveStreamUrl} from '../src/stream/resolver';
import {decodeAndMel} from '../src/analyze/audio';
import {analyzeEmbeddingAndMoods} from '../src/analyze/tflite';
import {ensureBaseSchema} from '../src/db/vibesDb';
import {analyzeSong, analyzeMany, MODEL_VERSION} from '../src/analyze/analyzer';

jest.mock('@dr.pogodin/react-native-fs', () => ({
  __esModule: true,
  TemporaryDirectoryPath: '/tmp',
  downloadFile: jest.fn(),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/stream/resolver', () => ({
  __esModule: true,
  resolveStreamUrl: jest.fn(),
}));

jest.mock('../src/analyze/audio', () => ({
  __esModule: true,
  decodeAndMel: jest.fn(),
}));

jest.mock('../src/analyze/tflite', () => ({
  __esModule: true,
  analyzeEmbeddingAndMoods: jest.fn(),
}));

jest.mock('../src/db/vibesDb', () => ({
  __esModule: true,
  ensureBaseSchema: jest.fn(),
}));

// In-memory stand-in for the `features` table, shared across every
// ensureBaseSchema() call within a test the same way sqlite's real file
// backs every open() call -- lets analyzeMany's "skip already analyzed"
// resumability be exercised without a real database.
function makeFakeDb() {
  const features = new Map<string, {embedding: Float32Array; moods: Record<string, number>}>();
  const meta = new Map<string, string>();
  return {
    features,
    meta,
    handle: {
      hasFeatures: jest.fn((videoId: string) => features.has(videoId)),
      storeFeatures: jest.fn((videoId: string, embedding: Float32Array, moods: Record<string, number>) => {
        features.set(videoId, {embedding, moods});
      }),
      setMeta: jest.fn((key: string, value: string) => meta.set(key, value)),
      close: jest.fn(),
    },
  };
}

function wireEnsureBaseSchema(fake: ReturnType<typeof makeFakeDb>) {
  (ensureBaseSchema as jest.Mock).mockImplementation(async () => ({
    hasFeatures: fake.handle.hasFeatures,
    storeFeatures: fake.handle.storeFeatures,
    setMeta: fake.handle.setMeta,
    close: fake.handle.close,
  }));
}

const MOODS = {
  happy: 0.1,
  sad: 0.2,
  relaxed: 0.3,
  aggressive: 0.4,
  danceable: 0.5,
  acoustic: 0.6,
  party: 0.7,
};

function stubHappyPath() {
  (resolveStreamUrl as jest.Mock).mockResolvedValue({url: 'https://example.com/a.audio', headers: {}});
  (RNFS.downloadFile as jest.Mock).mockReturnValue({
    jobId: 1,
    promise: Promise.resolve({jobId: 1, statusCode: 200, bytesWritten: 1234}),
  });
  (decodeAndMel as jest.Mock).mockResolvedValue([new Float32Array(187 * 96)]);
  (analyzeEmbeddingAndMoods as jest.Mock).mockResolvedValue({
    embedding: new Float32Array(200),
    moods: MOODS,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

// analyzeSong deliberately logs (rather than throws) on failure -- these
// tests exercise several expected failure paths, so silence the resulting
// console.warn noise rather than let it clutter test output.
let warnSpy: jest.SpyInstance;
beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe('analyzeSong: skip-if-already-analyzed', () => {
  test('returns true without touching the network when a features row already exists', async () => {
    const fake = makeFakeDb();
    fake.features.set('already-analyzed', {embedding: new Float32Array(200), moods: MOODS});
    wireEnsureBaseSchema(fake);

    const result = await analyzeSong('already-analyzed');

    expect(result).toBe(true);
    expect(resolveStreamUrl).not.toHaveBeenCalled();
    expect(RNFS.downloadFile).not.toHaveBeenCalled();
  });

  test('runs the full pipeline and writes a features row + model_version when not yet analyzed', async () => {
    const fake = makeFakeDb();
    wireEnsureBaseSchema(fake);
    stubHappyPath();

    const result = await analyzeSong('fresh-song');

    expect(result).toBe(true);
    expect(fake.features.has('fresh-song')).toBe(true);
    expect(fake.features.get('fresh-song')?.moods).toEqual(MOODS);
    expect(fake.meta.get('model_version')).toBe(MODEL_VERSION);
    // Downloaded temp file must be cleaned up on success.
    expect(RNFS.unlink).toHaveBeenCalledTimes(1);
  });
});

describe('analyzeSong: failure handling', () => {
  test('returns false (never throws) and still cleans up the temp file when decode fails', async () => {
    const fake = makeFakeDb();
    wireEnsureBaseSchema(fake);
    (resolveStreamUrl as jest.Mock).mockResolvedValue({url: 'https://example.com/a.audio', headers: {}});
    (RNFS.downloadFile as jest.Mock).mockReturnValue({
      jobId: 1,
      promise: Promise.resolve({jobId: 1, statusCode: 200, bytesWritten: 1234}),
    });
    (decodeAndMel as jest.Mock).mockResolvedValue([]); // 0 patches -> treated as failure

    const result = await analyzeSong('bad-song');

    expect(result).toBe(false);
    expect(fake.features.has('bad-song')).toBe(false);
    expect(RNFS.unlink).toHaveBeenCalledTimes(1);
  });

  test('returns false when resolveStreamUrl rejects, without ever calling downloadFile', async () => {
    const fake = makeFakeDb();
    wireEnsureBaseSchema(fake);
    (resolveStreamUrl as jest.Mock).mockRejectedValue(new Error('no stream'));

    const result = await analyzeSong('unresolvable');

    expect(result).toBe(false);
    expect(RNFS.downloadFile).not.toHaveBeenCalled();
    // No download ever started, so there's nothing to unlink.
    expect(RNFS.unlink).not.toHaveBeenCalled();
  });

  test('returns false on a non-2xx download status', async () => {
    const fake = makeFakeDb();
    wireEnsureBaseSchema(fake);
    (resolveStreamUrl as jest.Mock).mockResolvedValue({url: 'https://example.com/a.audio', headers: {}});
    (RNFS.downloadFile as jest.Mock).mockReturnValue({
      jobId: 1,
      promise: Promise.resolve({jobId: 1, statusCode: 403, bytesWritten: 0}),
    });

    const result = await analyzeSong('gone');

    expect(result).toBe(false);
    expect(decodeAndMel).not.toHaveBeenCalled();
    expect(RNFS.unlink).toHaveBeenCalledTimes(1); // temp path was still claimed, still cleaned up
  });
});

describe('analyzeSong: single-job-at-a-time mutex', () => {
  test('two concurrent analyzeSong calls for different songs never run their pipelines overlapping', async () => {
    const fake = makeFakeDb();
    wireEnsureBaseSchema(fake);
    stubHappyPath();

    const active: string[] = [];
    let maxConcurrent = 0;
    (decodeAndMel as jest.Mock).mockImplementation(async (path: string) => {
      active.push(path);
      maxConcurrent = Math.max(maxConcurrent, active.length);
      await new Promise(r => setTimeout(r, 5));
      active.pop();
      return [new Float32Array(187 * 96)];
    });

    await Promise.all([analyzeSong('song-a'), analyzeSong('song-b')]);

    expect(maxConcurrent).toBe(1);
    expect(fake.features.has('song-a')).toBe(true);
    expect(fake.features.has('song-b')).toBe(true);
  });

  test("one job's failure doesn't block jobs queued behind it", async () => {
    const fake = makeFakeDb();
    wireEnsureBaseSchema(fake);
    (resolveStreamUrl as jest.Mock)
      .mockRejectedValueOnce(new Error('first fails'))
      .mockResolvedValue({url: 'https://example.com/a.audio', headers: {}});
    (RNFS.downloadFile as jest.Mock).mockReturnValue({
      jobId: 1,
      promise: Promise.resolve({jobId: 1, statusCode: 200, bytesWritten: 1234}),
    });
    (decodeAndMel as jest.Mock).mockResolvedValue([new Float32Array(187 * 96)]);
    (analyzeEmbeddingAndMoods as jest.Mock).mockResolvedValue({
      embedding: new Float32Array(200),
      moods: MOODS,
    });

    const [firstResult, secondResult] = await Promise.all([
      analyzeSong('fails'),
      analyzeSong('succeeds'),
    ]);

    expect(firstResult).toBe(false);
    expect(secondResult).toBe(true);
    expect(fake.features.has('succeeds')).toBe(true);
  });
});

describe('analyzeSong: in-flight de-duplication', () => {
  test('two concurrent calls for the SAME videoId share one pipeline run, not two', async () => {
    const fake = makeFakeDb();
    wireEnsureBaseSchema(fake);
    stubHappyPath();

    const [a, b] = await Promise.all([analyzeSong('same-song'), analyzeSong('same-song')]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    // Without de-duplication this would be 2 (each call unaware of the
    // other, both past the pre-check before either finishes).
    expect(decodeAndMel).toHaveBeenCalledTimes(1);
    expect(resolveStreamUrl).toHaveBeenCalledTimes(1);
  });

  test('a later call for the same videoId, after the first has finished, runs its own (post-completion no-op) check', async () => {
    const fake = makeFakeDb();
    wireEnsureBaseSchema(fake);
    stubHappyPath();

    await analyzeSong('song-once');
    (decodeAndMel as jest.Mock).mockClear();
    (resolveStreamUrl as jest.Mock).mockClear();

    const result = await analyzeSong('song-once');

    expect(result).toBe(true);
    // Already analyzed by the first call -- the second is a pure skip.
    expect(decodeAndMel).not.toHaveBeenCalled();
    expect(resolveStreamUrl).not.toHaveBeenCalled();
  });
});

describe('analyzeMany: progress accounting, resumability, cancellation', () => {
  test('reports progress after each song and skips ones already analyzed', async () => {
    const fake = makeFakeDb();
    fake.features.set('already-done', {embedding: new Float32Array(200), moods: MOODS});
    wireEnsureBaseSchema(fake);
    stubHappyPath();

    const progressCalls: Array<[number, number]> = [];
    const {promise} = analyzeMany(['already-done', 'a', 'b'], (done, total) =>
      progressCalls.push([done, total]),
    );
    const result = await promise;

    expect(result).toEqual({done: 3, total: 3, cancelled: false});
    expect(progressCalls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    // 'already-done' was skipped -- no download/decode for it specifically,
    // but decodeAndMel *was* called for the other two.
    expect(decodeAndMel).toHaveBeenCalledTimes(2);
    expect(fake.features.has('a')).toBe(true);
    expect(fake.features.has('b')).toBe(true);
  });

  test('cancel() lets the in-flight song finish but stops before starting the next one', async () => {
    const fake = makeFakeDb();
    wireEnsureBaseSchema(fake);
    stubHappyPath();
    // Gate decodeAndMel so the test can cancel() while song 'a' is still
    // in-flight (mid-pipeline), deterministically, without racing a timer.
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    (decodeAndMel as jest.Mock).mockImplementationOnce(async () => {
      await gate;
      return [new Float32Array(187 * 96)];
    });

    const progressCalls: Array<[number, number]> = [];
    const handle = analyzeMany(['a', 'b', 'c'], (done, total) => progressCalls.push([done, total]));
    handle.cancel(); // cancel while 'a' is still awaiting decodeAndMel's gate
    releaseFirst(); // let 'a' finish now that cancel() has been requested
    const result = await handle.promise;

    // 'a' was already in flight when cancel() was called, so it's allowed
    // to complete -- but 'b' and 'c' are never attempted.
    expect(result).toEqual({done: 1, total: 3, cancelled: true});
    expect(progressCalls).toEqual([[1, 3]]);
    expect(fake.features.has('a')).toBe(true);
    expect(fake.features.has('b')).toBe(false);
    expect(fake.features.has('c')).toBe(false);
  });

  test('re-running analyzeMany with the same list resumes: already-written songs are skipped', async () => {
    const fake = makeFakeDb();
    wireEnsureBaseSchema(fake);
    stubHappyPath();

    const ids = ['x', 'y', 'z'];
    await analyzeMany(ids).promise;
    expect(fake.features.size).toBe(3);

    (decodeAndMel as jest.Mock).mockClear();
    const second = await analyzeMany(ids).promise;

    expect(second).toEqual({done: 3, total: 3, cancelled: false});
    // Every song was already analyzed by the first run -- the resumed run
    // shouldn't re-decode any of them.
    expect(decodeAndMel).not.toHaveBeenCalled();
  });
});
