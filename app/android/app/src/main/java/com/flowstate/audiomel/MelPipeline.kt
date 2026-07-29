package com.flowstate.audiomel

import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min

/**
 * Kotlin port of `analyzer/scripts/mel_reference.py` (the validated,
 * parity-gated pure-numpy MusiCNN mel recipe -- commit 130ab47). Every
 * constant/step here must mirror that file exactly; see its module
 * docstring for the essentia source citations this recipe is built from.
 *
 * The mel filterbank itself is NOT recomputed here -- it's baked once by
 * `analyzer/scripts/dump_mel_filterbank.py` (see FilterbankAsset.kt) directly
 * from `mel_reference.mel_filterbank()`, so the exact same float64 filter
 * weights (down to numpy's rounding) are used on-device instead of
 * re-deriving the Slaney-mel warping/triangular-filter math a second time in
 * Kotlin and risking a subtle port bug.
 */
object MelPipeline {
    const val FRAME_SIZE = 512
    const val HOP_SIZE = 256
    const val N_MELS = 96
    const val N_BINS = FRAME_SIZE / 2 + 1 // 257, rfft bin count
    const val PATCH_SIZE = 187
    const val PATCH_HOP = 93
    private const val LOG_SHIFT = 1.0
    private const val LOG_SCALE = 10000.0
    private const val LOG_FLOOR = 1e-30

    // Hann window, essentia Windowing(normalized=False, symmetric=True):
    // w[i] = 0.5 - 0.5*cos(2*pi*i/(N-1)). (zeroPhase is a circular shift
    // that doesn't affect the magnitude spectrum -- see mel_reference.py.)
    private val window: DoubleArray = DoubleArray(FRAME_SIZE) { i ->
        0.5 - 0.5 * cos(2.0 * Math.PI * i / (FRAME_SIZE - 1))
    }

    /**
     * Zero-centered framing matching essentia FrameCutter(startFromZero=False)
     * -- ported 1:1 from mel_reference.py's `frame_signal`. First frame is
     * centered on sample 0 (zero-padded before it); a frame is emitted (zero
     * padded past the end) once its center reaches/passes the buffer end,
     * and no frame after that one.
     */
    fun frameSignal(audio: DoubleArray, frameSize: Int = FRAME_SIZE, hopSize: Int = HOP_SIZE): Array<DoubleArray> {
        val n = audio.size
        val frames = ArrayList<DoubleArray>()
        var start = -((frameSize + 1) / 2)
        while (true) {
            if (start >= n) break
            val center = start + frameSize / 2
            val frame = DoubleArray(frameSize)
            val lo = max(start, 0)
            val hi = min(start + frameSize, n)
            if (hi > lo) {
                for (k in lo until hi) frame[k - start] = audio[k]
            }
            frames.add(frame)
            if (center >= n) break
            start += hopSize
        }
        return frames.toTypedArray()
    }

    /**
     * One frame (length FRAME_SIZE) -> 96 mel bands, essentia recipe: Hann
     * window -> |FFT| magnitude spectrum -> square (power) -> mel filterbank
     * -> shift*scale+1 -> log10. Pure function, filterbank injected so it's
     * independently JVM-testable without an Android asset/Context.
     */
    fun frameToMelBands(frame: DoubleArray, filterbank: Array<DoubleArray>): FloatArray {
        require(frame.size == FRAME_SIZE) { "frame must be length $FRAME_SIZE, got ${frame.size}" }
        val re = DoubleArray(FRAME_SIZE)
        val im = DoubleArray(FRAME_SIZE)
        for (i in 0 until FRAME_SIZE) re[i] = frame[i] * window[i]
        Fft.fft(re, im)

        // power = |rfft|^2 == re^2+im^2 directly (skips an unneeded
        // sqrt-then-square roundtrip vs. mel_reference.py's
        // `np.abs(rfft)**2`; mathematically identical, marginally more
        // precise).
        val power = DoubleArray(N_BINS)
        for (i in 0 until N_BINS) power[i] = re[i] * re[i] + im[i] * im[i]

        val out = FloatArray(N_MELS)
        for (m in 0 until N_MELS) {
            val row = filterbank[m]
            var sum = 0.0
            for (b in 0 until N_BINS) sum += power[b] * row[b]
            val shifted = sum * LOG_SCALE + LOG_SHIFT
            out[m] = log10(max(shifted, LOG_FLOOR)).toFloat()
        }
        return out
    }

    /** Full mel pipeline: 16kHz mono audio -> (n_frames, 96) mel bands. */
    fun audioToMel(audio: FloatArray, filterbank: Array<DoubleArray>): Array<FloatArray> {
        val audioD = DoubleArray(audio.size) { audio[it].toDouble() }
        val frames = frameSignal(audioD)
        return Array(frames.size) { i -> frameToMelBands(frames[i], filterbank) }
    }

    /**
     * (n_frames, 96) mel -> (n_patches, 187, 96), lastPatchMode="discard"
     * (essentia TensorflowPredictMusiCNN default): any trailing partial
     * patch is dropped, matching mel_reference.py's `mel_to_patches`.
     */
    fun melToPatches(mel: Array<FloatArray>): Array<Array<FloatArray>> {
        val nFrames = mel.size
        if (nFrames < PATCH_SIZE) return emptyArray()
        val patches = ArrayList<Array<FloatArray>>()
        var s = 0
        while (s + PATCH_SIZE <= nFrames) {
            patches.add(Array(PATCH_SIZE) { j -> mel[s + j] })
            s += PATCH_HOP
        }
        return patches.toTypedArray()
    }

    /** Flattens (n_patches, 187, 96) row-major into one FloatArray, matching
     * the JS side's `splitPatches` (audio.ts), which slices it back into
     * per-patch Float32Array(187*96) chunks in the same order. */
    fun flattenPatches(patches: Array<Array<FloatArray>>): FloatArray {
        if (patches.isEmpty()) return FloatArray(0)
        val patchLen = PATCH_SIZE * N_MELS
        val out = FloatArray(patches.size * patchLen)
        var idx = 0
        for (patch in patches) {
            for (row in patch) {
                System.arraycopy(row, 0, out, idx, row.size)
                idx += row.size
            }
        }
        return out
    }
}
