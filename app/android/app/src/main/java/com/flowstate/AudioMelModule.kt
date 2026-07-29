package com.flowstate

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.flowstate.audiomel.AudioDecoder
import com.flowstate.audiomel.FilterbankAsset
import com.flowstate.audiomel.FloatCodec
import com.flowstate.audiomel.MelPipeline
import com.flowstate.audiomel.MiddleSlice

/**
 * Plan D Task 5: native Kotlin audio decode + MusiCNN mel-spectrogram.
 * Exposed to JS as `NativeModules.AudioMel` -- see app/src/analyze/audio.ts
 * for the TS wrapper. Registered via a plain legacy ReactPackage
 * (AudioMelPackage.kt); RN 0.86's New Arch interop layer runs legacy
 * `ReactContextBaseJavaModule`s like this one without requiring a
 * TurboModule spec/codegen (same pattern already relied on for other
 * bridge-based native modules in this app's dependency tree, e.g.
 * react-native-track-player).
 *
 * Large float arrays cross the bridge as base64-encoded little-endian
 * float32 bytes (a single String argument/return value) rather than
 * WritableArray-of-doubles, which would be far more allocation-heavy for
 * multi-megabyte PCM/mel payloads. See FloatCodec.kt.
 *
 * Both methods run on a background thread (not the bridge/JS thread) since
 * MediaCodec decode and the mel FFT loop are too slow to block that thread
 * for a ~120s clip.
 */
class AudioMelModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    override fun getName(): String = NAME

    companion object {
        const val NAME = "AudioMel"

        // Matches analyzer/flowstate_analyzer/features.py's Extractor default
        // (`segment_s=120`) / Plan D's Global Constraints ("middle 120s").
        private const val MIDDLE_SLICE_SECONDS = 120
        private const val TARGET_SAMPLE_RATE = 16000
    }

    /**
     * Decode a local audio file (path from RN's file system, e.g. a
     * downloaded m4a) to mono float PCM at 16kHz, already middle-120s-sliced
     * (matching v1's `middle_slice`). Resolves
     * `{sampleRate: number, numSamples: number, pcmBase64: string}`.
     */
    @ReactMethod
    fun decodeToPcm(path: String, promise: Promise) {
        Thread {
            try {
                val pcm = AudioDecoder.decodeToMonoPcm16k(path)
                val sliced = MiddleSlice.take(pcm, TARGET_SAMPLE_RATE, MIDDLE_SLICE_SECONDS)
                val result = Arguments.createMap()
                result.putInt("sampleRate", TARGET_SAMPLE_RATE)
                result.putInt("numSamples", sliced.size)
                result.putString("pcmBase64", FloatCodec.encode(sliced))
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("audio_mel_decode_error", e.message ?: e.toString(), e)
            }
        }.start()
    }

    /**
     * Compute MusiCNN mel patches from 16kHz mono float PCM (base64 float32
     * LE, as produced by `decodeToPcm` or by the JS side for
     * externally-sourced PCM e.g. golden fixtures). Resolves
     * `{numFrames: number, numPatches: number, patchesBase64: string}` --
     * `patchesBase64` is `numPatches * 187 * 96` float32 values, flattened
     * row-major (patch, frame, band); see audio.ts's `splitPatches`.
     */
    @ReactMethod
    fun computeMel(pcmBase64: String, promise: Promise) {
        Thread {
            try {
                val filterbank = FilterbankAsset.get(reactApplicationContext)
                val pcm = FloatCodec.decode(pcmBase64)
                val mel = MelPipeline.audioToMel(pcm, filterbank)
                val patches = MelPipeline.melToPatches(mel)
                val flat = MelPipeline.flattenPatches(patches)
                val result = Arguments.createMap()
                result.putInt("numFrames", mel.size)
                result.putInt("numPatches", patches.size)
                result.putString("patchesBase64", FloatCodec.encode(flat))
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("audio_mel_compute_error", e.message ?: e.toString(), e)
            }
        }.start()
    }
}
