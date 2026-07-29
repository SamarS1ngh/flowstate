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

import {meanPool, pickMood, POSITIVE_INDEX} from '../src/analyze/tflite';

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
