/**
 * Cosine similarity between two equal-length vectors -- pure, dependency-free
 * (kept in its own module, separate from melParityHarness.ts, so it's
 * Jest-testable without pulling in RNFS/tflite/network dependencies).
 * Matches the reference gate formula used by
 * analyzer/tests/test_mel_parity.py (dot / (||a|| * ||b|| + 1e-12)).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: length mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-12);
}
