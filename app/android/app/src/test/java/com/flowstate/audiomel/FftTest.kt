package com.flowstate.audiomel

import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** Independent cross-check for Fft.kt: a brute-force O(n^2) DFT (a
 * different, deliberately-not-shared implementation) computed against the
 * same input must match Fft.fft within float precision. This is the "known
 * DFT for a test signal" verification called for by the Task 5 brief. */
class FftTest {
    private fun naiveDft(re: DoubleArray, im: DoubleArray): Pair<DoubleArray, DoubleArray> {
        val n = re.size
        val outRe = DoubleArray(n)
        val outIm = DoubleArray(n)
        for (k in 0 until n) {
            var sumRe = 0.0
            var sumIm = 0.0
            for (t in 0 until n) {
                val ang = -2.0 * Math.PI * k * t / n
                val c = cos(ang)
                val s = sin(ang)
                sumRe += re[t] * c - im[t] * s
                sumIm += re[t] * s + im[t] * c
            }
            outRe[k] = sumRe
            outIm[k] = sumIm
        }
        return outRe to outIm
    }

    @Test
    fun matchesNaiveDft_randomSignal_512() {
        val n = 512
        val rng = Random(42)
        val re = DoubleArray(n) { rng.nextDouble(-1.0, 1.0) }
        val im = DoubleArray(n)
        val (expectedRe, expectedIm) = naiveDft(re, im)

        val fftRe = re.copyOf()
        val fftIm = im.copyOf()
        Fft.fft(fftRe, fftIm)

        var maxDiff = 0.0
        for (i in 0 until n) {
            maxDiff = maxOf(maxDiff, kotlin.math.abs(fftRe[i] - expectedRe[i]))
            maxDiff = maxOf(maxDiff, kotlin.math.abs(fftIm[i] - expectedIm[i]))
        }
        assertEquals(0.0, maxDiff, 1e-6)
    }

    @Test
    fun matchesNaiveDft_pureTone_64() {
        // A single-bin sinusoid: FFT should show all energy concentrated at
        // the matching bin (and its Hermitian mirror), a sanity check
        // orthogonal to the full random-signal comparison above.
        val n = 64
        val binIndex = 5
        val re = DoubleArray(n) { i -> cos(2.0 * Math.PI * binIndex * i / n) }
        val im = DoubleArray(n)
        Fft.fft(re, im)

        val mag = DoubleArray(n) { i -> Math.hypot(re[i], im[i]) }
        val expectedPeak = n / 2.0
        assertEquals(expectedPeak, mag[binIndex], 1e-6)
        assertEquals(expectedPeak, mag[n - binIndex], 1e-6)
        for (i in 0 until n) {
            if (i != binIndex && i != n - binIndex) {
                assertEquals(0.0, mag[i], 1e-6)
            }
        }
    }

    @Test
    fun rejectsNonPowerOfTwoSize() {
        assertThrows(IllegalArgumentException::class.java) {
            Fft.fft(DoubleArray(500), DoubleArray(500))
        }
    }
}
