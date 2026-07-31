import {NativeModules} from 'react-native';
import {decode as atob, encode as btoa} from 'base-64';

// Plan D Task 5: TS bridge to the native `AudioMel` Kotlin module
// (android/app/src/main/java/com/flowstate/AudioMelModule.kt). That module
// decodes a local audio file to 16kHz mono float PCM (MediaCodec) and/or
// computes MusiCNN mel patches from PCM (port of
// analyzer/scripts/mel_reference.py), returning large float payloads as
// base64 little-endian float32 strings (see FloatCodec.kt) rather than
// WritableArray-of-doubles.
//
// Uses the `base-64` package directly (rather than the global atob/btoa
// installed by src/polyfills.ts at app startup) so these encode/decode
// helpers are plain, dependency-free functions under Jest too.

const {AudioMel} = NativeModules as {
  AudioMel?: {
    decodeToPcm(path: string): Promise<{sampleRate: number; numSamples: number; pcmBase64: string}>;
    computeMel(
      pcmBase64: string,
    ): Promise<{numFrames: number; numPatches: number; patchesBase64: string}>;
    // Plan D Task 6b perf: decode+slice+mel in one native call, so the ~120s
    // PCM buffer never crosses the bridge as JS-visible base64 at all (see
    // decodeAndMel below). decodeToPcm/computeMel above stay as separate
    // steps for the fixture-driven parity harness, which needs externally
    // -sourced PCM to legitimately cross from JS.
    decodeAndComputeMel(
      path: string,
    ): Promise<{numFrames: number; numPatches: number; patchesBase64: string}>;
  };
};

export const MEL_PATCH_FRAMES = 187;
export const MEL_PATCH_BANDS = 96;
const PATCH_LEN = MEL_PATCH_FRAMES * MEL_PATCH_BANDS;

/** Decodes a base64 string of little-endian float32 bytes into a Float32Array. */
export function base64ToFloat32Array(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i) & 0xff;
  }
  // bytes is a fresh Uint8Array (byteOffset 0), so its buffer can be
  // reinterpreted directly as float32 without a copy.
  if (bytes.byteLength % 4 !== 0) {
    throw new Error(`base64ToFloat32Array: byte length ${bytes.byteLength} is not a multiple of 4`);
  }
  return new Float32Array(bytes.buffer);
}

/** Encodes a Float32Array as base64 little-endian float32 bytes. */
export function float32ArrayToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...Array.from(chunk));
  }
  return btoa(binary);
}

/**
 * Splits a flat (numPatches*187*96) Float32Array into `numPatches`
 * standalone Float32Array(187*96) patches. Uses `.slice()` (a real copy,
 * byteOffset 0) rather than `.subarray()` (a view) -- tflite.ts's
 * runEmbedding reads `patch.buffer` directly, which would otherwise hand
 * the model the ENTIRE flat buffer instead of just that patch's window.
 */
export function splitPatches(flat: Float32Array, numPatches: number): Float32Array[] {
  const patches: Float32Array[] = [];
  for (let i = 0; i < numPatches; i++) {
    patches.push(flat.slice(i * PATCH_LEN, (i + 1) * PATCH_LEN));
  }
  return patches;
}

function requireNativeModule(): NonNullable<typeof AudioMel> {
  if (!AudioMel) {
    throw new Error('AudioMel native module not available (Android only, requires a native rebuild)');
  }
  return AudioMel;
}

/**
 * Runs the native MusiCNN mel pipeline on already-decoded 16kHz mono float
 * PCM (e.g. golden-fixture PCM pushed to the device for the on-device
 * parity harness, bypassing decodeToPcm entirely).
 */
export async function computeMelFromPcm(pcm: Float32Array): Promise<Float32Array[]> {
  const native = requireNativeModule();
  const pcmBase64 = float32ArrayToBase64(pcm);
  const {numPatches, patchesBase64} = await native.computeMel(pcmBase64);
  if (numPatches === 0) return [];
  const flat = base64ToFloat32Array(patchesBase64);
  return splitPatches(flat, numPatches);
}

/**
 * Full production path: decode a local audio file (path from RN's
 * filesystem, e.g. a downloaded m4a) to 16kHz mono PCM (middle-120s-sliced
 * by the native side) and compute its MusiCNN mel patches.
 *
 * Plan D Task 6b perf: this used to be `decodeToPcm` (native decode -> base64
 * -> JS Float32Array) followed by `computeMelFromPcm` (JS Float32Array ->
 * base64 -> native mel) -- round-tripping the ~120s PCM buffer (~7.5MB raw,
 * ~10MB as base64) across the bridge TWICE even though JS never does
 * anything with it except hand it straight back. `decodeAndComputeMel` does
 * decode+slice+mel in one native call instead, so only the much smaller mel
 * patches payload (a few MB, not ~20MB of round-tripped base64) ever crosses
 * the bridge.
 */
export async function decodeAndMel(path: string): Promise<Float32Array[]> {
  const native = requireNativeModule();
  const {numPatches, patchesBase64} = await native.decodeAndComputeMel(path);
  if (numPatches === 0) return [];
  const flat = base64ToFloat32Array(patchesBase64);
  return splitPatches(flat, numPatches);
}
