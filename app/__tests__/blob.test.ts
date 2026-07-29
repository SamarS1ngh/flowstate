import {embeddingFromBlob} from '../src/db/blob';

test('decodes float32[200] little-endian', () => {
  const buf = new ArrayBuffer(800);
  const view = new DataView(buf);
  for (let i = 0; i < 200; i++) view.setFloat32(i * 4, i / 2, true); // little-endian
  const emb = embeddingFromBlob(buf);
  expect(emb.length).toBe(200);
  expect(emb[0]).toBeCloseTo(0);
  expect(emb[199]).toBeCloseTo(99.5);
});

test('rejects wrong byte length', () => {
  expect(() => embeddingFromBlob(new ArrayBuffer(4))).toThrow(/800/);
});

test('decodes ArrayBufferView at nonzero byteOffset', () => {
  // Larger buffer with embedding at offset 100
  const buf = new ArrayBuffer(1000);
  const view = new DataView(buf);
  const offset = 100;
  for (let i = 0; i < 200; i++) {
    view.setFloat32(offset + i * 4, i / 2 + 10, true); // little-endian, offset by 10
  }
  const viewAtOffset = new Uint8Array(buf, offset, 800);
  const emb = embeddingFromBlob(viewAtOffset);
  expect(emb.length).toBe(200);
  expect(emb[0]).toBeCloseTo(10);
  expect(emb[199]).toBeCloseTo(109.5);
  // Verify it's a copy, not a view into the original buffer
  expect(emb.buffer.byteLength).toBe(800);
  expect(emb.byteOffset).toBe(0);
});

test('rejects ArrayBufferView with wrong byte length', () => {
  const buf = new ArrayBuffer(500);
  const view = new Uint8Array(buf, 0, 400);
  expect(() => embeddingFromBlob(view)).toThrow(/800/);
});

// Plan D Task 6: vibesDb.ts's storeFeatures (the analyzer's writer) hands
// op-sqlite a bare Float32Array(200) -- one of op-sqlite's supported Scalar
// bind-param types (ArrayBufferView) -- rather than manually packing bytes,
// trusting op-sqlite to bind it as an 800-byte little-endian BLOB as-is.
// This confirms that exact writer shape survives this reader (getVibeSongs'
// embeddingFromBlob) round-trip: a Float32Array IS the little-endian byte
// layout embeddingFromBlob expects on every platform this app targets
// (Android/ARM + iOS arm64/x86_64 are all little-endian), so feeding one
// straight into the reader is equivalent to what a real sqlite round-trip
// produces.
test('a Float32Array(200), as handed to op-sqlite by vibesDb.storeFeatures, round-trips through embeddingFromBlob unchanged', () => {
  const written = new Float32Array(200);
  for (let i = 0; i < 200; i++) written[i] = Math.sin(i * 0.017) * 3.5;

  const read = embeddingFromBlob(written);

  expect(read.length).toBe(200);
  expect(Array.from(read)).toEqual(Array.from(written));
});
