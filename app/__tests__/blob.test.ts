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
