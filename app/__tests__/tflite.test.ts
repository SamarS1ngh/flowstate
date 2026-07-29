// Unit tests for the PURE logic in src/analyze/tflite.ts: mean-pooling patch
// outputs and picking the per-head positive-class mood score. The native
// tflite model-runner (loadTensorflowModel/model.run) is never invoked here
// -- that path is device-verified (Task 5's on-device probe), not unit
// tested.
//
// react-native-fast-tflite re-exports react-native-nitro-modules, which
// resolves its native TurboModule *eagerly at import time* (not lazily on
// first call) -- so merely importing tflite.ts would otherwise throw
// "TurboModuleRegistry.getEnforcing(...): 'NitroModules' could not be
// found" under Jest, which has no native binary. Mock the whole package
// with a fake model-runner so the import is safe; tflite.ts's require('./models/*.tflite')
// calls are separately handled by jest.config.js's assetFileTransformer mock.
jest.mock('react-native-fast-tflite', () => ({
  loadTensorflowModel: jest.fn(),
}));

import {loadTensorflowModel} from 'react-native-fast-tflite';
import {loadModels, meanPool, pickMood, POSITIVE_INDEX, runEmbedding} from '../src/analyze/tflite';

describe('meanPool', () => {
  test('averages a single output unchanged', () => {
    const out = meanPool([new Float32Array([1, 2, 3])], 3);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  test('averages multiple known vectors element-wise', () => {
    const out = meanPool(
      [new Float32Array([0, 10]), new Float32Array([2, 20]), new Float32Array([4, 0])],
      2,
    );
    expect(Array.from(out)).toEqual([2, 10]);
  });

  test('throws on empty input', () => {
    expect(() => meanPool([], 3)).toThrow();
  });

  test('throws when an output length mismatches dim', () => {
    expect(() => meanPool([new Float32Array([1, 2])], 3)).toThrow();
  });
});

describe('pickMood', () => {
  test('picks index 0 from a binary softmax output', () => {
    expect(pickMood(new Float32Array([0.9, 0.1]), 0)).toBeCloseTo(0.9);
  });

  test('picks index 1 from a binary softmax output', () => {
    expect(pickMood(new Float32Array([0.9, 0.1]), 1)).toBeCloseTo(0.1);
  });

  test('throws on a non-2-element output', () => {
    expect(() => pickMood(new Float32Array([0.9, 0.05, 0.05]), 0)).toThrow();
  });

  test('throws on an out-of-range index', () => {
    expect(() => pickMood(new Float32Array([0.9, 0.1]), 2 as 0 | 1)).toThrow();
  });
});

describe('runEmbedding buffer-reuse regression (Task 5 on-device finding)', () => {
  // Confirmed on-device (Plan D Task 5): react-native-fast-tflite's
  // TensorflowModel.run() reuses the SAME underlying native ArrayBuffer for
  // its output across successive calls. `new Float32Array(arrayBuffer)` is a
  // zero-copy VIEW (not a copy) of that ArrayBuffer, so without an explicit
  // `.slice()` after each call, every entry accumulated in runEmbedding's
  // `outputs` array ends up aliasing the SAME memory -- by the time
  // meanPool() runs, every entry reads back as whatever the LAST .run() call
  // wrote. This was invisible on near-stationary fixtures (all patches
  // produce similar embeddings anyway) and only surfaced as a real cosine
  // failure (0.6954 instead of ~1.0) on a fixture whose patches vary a lot
  // (`sweep_50_7900hz`, a 50->7900Hz chirp). This test reproduces that
  // buffer-reuse shape directly against a fake model and asserts the pooled
  // result is the TRUE per-patch average, not the last patch repeated.
  const PATCH_LEN = 187 * 96;

  test('averages true per-patch outputs, not the last call repeated into every slot', async () => {
    const dim = 200;
    const sharedBuffer = new ArrayBuffer(dim * 4); // one native buffer, reused every call
    const perCallFirstValue = [10, 20, 30]; // 3 fake patches -> true mean of index 0 is 20
    let callIndex = 0;
    const fakeModel = {
      run: jest.fn(async () => {
        const view = new Float32Array(sharedBuffer);
        view.fill(0);
        view[0] = perCallFirstValue[callIndex];
        callIndex++;
        return [sharedBuffer]; // same buffer object every time -- the reuse under test
      }),
    };
    (loadTensorflowModel as jest.Mock).mockResolvedValue(fakeModel);

    await loadModels();
    const patches = perCallFirstValue.map(() => new Float32Array(PATCH_LEN));
    const embedding = await runEmbedding(patches);

    // A buffer-aliasing bug would report 30 (the last call's value) here;
    // the fix must report the true mean, 20.
    expect(embedding[0]).toBeCloseTo(20, 6);
    expect(fakeModel.run).toHaveBeenCalledTimes(3);
  });
});

describe('POSITIVE_INDEX mapping', () => {
  // Locks the same polarity mapping v1 verifies in
  // analyzer/tests/test_features_polarity.py: every head runs through the
  // SAME [0.9, 0.1] fake softmax row, so only POSITIVE_INDEX determines
  // whether a mood's reported score is 0.9 or 0.1. A regression that flips
  // any head's index (or drops a head) fails this test loudly.
  const FAKE_SOFTMAX = new Float32Array([0.9, 0.1]);
  const POSITIVE_INDEX_0 = ['happy', 'aggressive', 'danceable', 'acoustic'];
  const POSITIVE_INDEX_1 = ['sad', 'relaxed', 'party'];

  test('covers exactly the 7 expected mood keys', () => {
    expect(Object.keys(POSITIVE_INDEX).sort()).toEqual(
      [...POSITIVE_INDEX_0, ...POSITIVE_INDEX_1].sort(),
    );
  });

  test.each(POSITIVE_INDEX_0)('%s reports the class-0 score', name => {
    expect(pickMood(FAKE_SOFTMAX, POSITIVE_INDEX[name])).toBeCloseTo(0.9);
  });

  test.each(POSITIVE_INDEX_1)('%s reports the class-1 score', name => {
    expect(pickMood(FAKE_SOFTMAX, POSITIVE_INDEX[name])).toBeCloseTo(0.1);
  });

  test('running all 7 heads through the mapping produces the expected keys+scores', () => {
    const moods: Record<string, number> = {};
    for (const [name, index] of Object.entries(POSITIVE_INDEX)) {
      moods[name] = pickMood(FAKE_SOFTMAX, index);
    }
    const expected: Record<string, number> = {
      happy: 0.9,
      sad: 0.1,
      relaxed: 0.1,
      aggressive: 0.9,
      acoustic: 0.9,
      party: 0.1,
      danceable: 0.9,
    };
    expect(Object.keys(moods).sort()).toEqual(Object.keys(expected).sort());
    for (const name of Object.keys(expected)) {
      expect(moods[name]).toBeCloseTo(expected[name]);
    }
  });
});
