// Unit test for the pure cosineSimilarity helper used by the Task 5
// on-device parity gate (re-exported from melParityHarness.ts, but defined
// in its own dependency-free module -- src/analyze/cosine.ts -- so it's
// importable here without pulling in RNFS/tflite/network dependencies that
// melParityHarness.ts itself needs). The rest of melParityHarness.ts (file
// I/O, native mel/tflite calls, network download) is device-only and
// exercised by the actual on-device harness run, not mocked here.
import {cosineSimilarity} from '../src/analyze/cosine';

describe('cosineSimilarity', () => {
  test('is 1 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3, 4]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });

  test('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0, 6);
  });

  test('is -1 for opposite vectors', () => {
    expect(cosineSimilarity(new Float32Array([1, 2, 3]), new Float32Array([-1, -2, -3]))).toBeCloseTo(-1, 6);
  });

  test('is scale-invariant', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([2, 4, 6.5]);
    const scaledB = new Float32Array(b.map(x => x * 10));
    expect(cosineSimilarity(a, scaledB)).toBeCloseTo(cosineSimilarity(a, b), 5);
  });

  test('throws on length mismatch', () => {
    expect(() => cosineSimilarity(new Float32Array([1, 2]), new Float32Array([1, 2, 3]))).toThrow();
  });
});
