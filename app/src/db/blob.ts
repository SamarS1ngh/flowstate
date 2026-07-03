export function embeddingFromBlob(buf: ArrayBuffer | ArrayBufferView): Float32Array {
  let arrayBuffer: ArrayBuffer;

  // Check if input is ArrayBufferView (has buffer and byteOffset properties)
  if ('buffer' in buf && 'byteOffset' in buf) {
    // It's an ArrayBufferView (Uint8Array, DataView, etc.)
    if (buf.byteLength !== 800) {
      throw new Error(`embedding blob must be 800 bytes (float32[200]), got ${buf.byteLength}`);
    }
    // Copy the view into a new ArrayBuffer
    const view = buf as ArrayBufferView;
    arrayBuffer = new ArrayBuffer(800);
    new Uint8Array(arrayBuffer).set(new Uint8Array(view.buffer, view.byteOffset, 800));
  } else {
    // It's an ArrayBuffer
    arrayBuffer = buf as ArrayBuffer;
    if (arrayBuffer.byteLength !== 800) {
      throw new Error(`embedding blob must be 800 bytes (float32[200]), got ${arrayBuffer.byteLength}`);
    }
    arrayBuffer = arrayBuffer.slice(0);
  }

  // vibes.db writes little-endian float32; Android/ARM and iOS (arm64/x86_64) are
  // little-endian, so a direct Float32Array view is correct on every device this
  // app targets.
  return new Float32Array(arrayBuffer);
}
