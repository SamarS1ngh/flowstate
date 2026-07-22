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
