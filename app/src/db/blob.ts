export function embeddingFromBlob(buf: ArrayBuffer): Float32Array {
  if (buf.byteLength !== 800) {
    throw new Error(`embedding blob must be 800 bytes (float32[200]), got ${buf.byteLength}`);
  }
  // vibes.db writes little-endian float32; Android/ARM and iOS (arm64/x86_64) are
  // little-endian, so a direct Float32Array view is correct on every device this
  // app targets.
  return new Float32Array(buf.slice(0));
}
