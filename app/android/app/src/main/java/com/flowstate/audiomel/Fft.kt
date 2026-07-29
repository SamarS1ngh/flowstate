package com.flowstate.audiomel

import kotlin.math.cos
import kotlin.math.sin

/**
 * Minimal in-place radix-2 Cooley-Tukey FFT, pure Kotlin/JVM (no native deps).
 *
 * Frame size for the MusiCNN mel recipe is fixed at 512 (a power of two), so
 * radix-2 is sufficient -- no need for Bluestein/mixed-radix support.
 *
 * Convention matches numpy's `np.fft.fft` (and therefore `np.fft.rfft`, which
 * `analyzer/scripts/mel_reference.py` uses): forward transform, twiddle
 * factors `exp(-i*2*pi*k/N)`, NO 1/N normalization. `re`/`im` are modified
 * in place; `re` starts as the (windowed) real samples, `im` as zeros.
 *
 * Verified against a brute-force O(n^2) DFT for random signals in
 * FftTest.kt (`assertFftMatchesNaiveDft`) -- see that file for the
 * independent cross-check.
 */
object Fft {
    /** `re.size` (== `im.size`) MUST be a power of two. */
    fun fft(re: DoubleArray, im: DoubleArray) {
        val n = re.size
        require(im.size == n) { "re/im length mismatch: ${re.size} vs ${im.size}" }
        require(n > 0 && (n and (n - 1)) == 0) { "FFT size must be a power of two, got $n" }

        // Bit-reversal permutation.
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) {
                j = j xor bit
                bit = bit shr 1
            }
            j = j or bit
            if (i < j) {
                val tr = re[i]; re[i] = re[j]; re[j] = tr
                val ti = im[i]; im[i] = im[j]; im[j] = ti
            }
        }

        // Iterative Cooley-Tukey, butterfly stages of increasing length.
        var len = 2
        while (len <= n) {
            val ang = -2.0 * Math.PI / len
            val wLenRe = cos(ang)
            val wLenIm = sin(ang)
            var i = 0
            while (i < n) {
                var curWRe = 1.0
                var curWIm = 0.0
                val half = len / 2
                for (k in 0 until half) {
                    val uRe = re[i + k]
                    val uIm = im[i + k]
                    val vRe = re[i + k + half] * curWRe - im[i + k + half] * curWIm
                    val vIm = re[i + k + half] * curWIm + im[i + k + half] * curWRe
                    re[i + k] = uRe + vRe
                    im[i + k] = uIm + vIm
                    re[i + k + half] = uRe - vRe
                    im[i + k + half] = uIm - vIm
                    val nextWRe = curWRe * wLenRe - curWIm * wLenIm
                    val nextWIm = curWRe * wLenIm + curWIm * wLenRe
                    curWRe = nextWRe
                    curWIm = nextWIm
                }
                i += len
            }
            len = len shl 1
        }
    }
}
