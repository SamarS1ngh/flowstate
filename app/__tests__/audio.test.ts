// Unit tests for the PURE helpers in src/analyze/audio.ts: base64<->Float32Array
// codec and patch-splitting. The native AudioMel module (decodeToPcm/computeMel)
// is device-only and verified on-device (Plan D Task 5's on-device parity
// harness), not mocked/unit-tested here.
import {base64ToFloat32Array, float32ArrayToBase64, splitPatches} from '../src/analyze/audio';

describe('float32ArrayToBase64 / base64ToFloat32Array round trip', () => {
  test('round-trips a small known array', () => {
    const original = new Float32Array([0, 1, -1, 0.5, -0.25, 3.14159]);
    const b64 = float32ArrayToBase64(original);
    const decoded = base64ToFloat32Array(b64);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  test('round-trips an empty array', () => {
    const decoded = base64ToFloat32Array(float32ArrayToBase64(new Float32Array(0)));
    expect(decoded.length).toBe(0);
  });

  test('round-trips a large array spanning multiple base64 chunk boundaries', () => {
    const n = 200_000; // > the 0x8000-byte chunking in float32ArrayToBase64
    const original = new Float32Array(n);
    for (let i = 0; i < n; i++) original[i] = Math.sin(i * 0.001);
    const decoded = base64ToFloat32Array(float32ArrayToBase64(original));
    expect(decoded.length).toBe(n);
    for (let i = 0; i < n; i += 997) {
      expect(decoded[i]).toBeCloseTo(original[i], 6);
    }
  });

  test('throws on a byte length not a multiple of 4', () => {
    // "AAA=" base64-decodes to 2 bytes -- not a valid float32 stream.
    expect(() => base64ToFloat32Array('AAA=')).toThrow();
  });
});

describe('splitPatches', () => {
  const PATCH_LEN = 187 * 96;

  test('splits a flat array into the requested number of independent patches', () => {
    const flat = new Float32Array(PATCH_LEN * 3);
    for (let i = 0; i < flat.length; i++) flat[i] = i;
    const patches = splitPatches(flat, 3);
    expect(patches).toHaveLength(3);
    for (const patch of patches) expect(patch.length).toBe(PATCH_LEN);
    expect(patches[0][0]).toBe(0);
    expect(patches[1][0]).toBe(PATCH_LEN);
    expect(patches[2][PATCH_LEN - 1]).toBe(flat.length - 1);
  });

  test('each patch is an independent copy with byteOffset 0 (not a view into `flat`)', () => {
    const flat = new Float32Array(PATCH_LEN * 2);
    const patches = splitPatches(flat, 2);
    // Critical for tflite.ts's runEmbedding, which reads `patch.buffer`
    // directly (ignoring byteOffset/length) -- a `.subarray()` view here
    // would silently hand the model the WHOLE flat buffer instead of one
    // patch's window.
    expect(patches[0].byteOffset).toBe(0);
    expect(patches[1].byteOffset).toBe(0);
    expect(patches[0].buffer).not.toBe(flat.buffer);
    expect(patches[0].buffer.byteLength).toBe(PATCH_LEN * 4);
  });

  test('returns an empty array for zero patches', () => {
    expect(splitPatches(new Float32Array(0), 0)).toEqual([]);
  });
});
