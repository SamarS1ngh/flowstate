package com.flowstate.audiomel

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import java.nio.ByteOrder

/**
 * Decodes a local audio file (m4a/opus/etc -- whatever the downloaded
 * stream format is) to mono float PCM at 16kHz via MediaExtractor +
 * MediaCodec, matching essentia's `MonoLoader(sampleRate=16000)` input to
 * the mel pipeline (device-only; not JVM-unit-tested -- see AudioDecoderTest
 * notes / the Task 5 report for on-device verification).
 *
 * Multi-channel downmix: plain average of all channels per frame (same
 * behavior as essentia's MonoLoader, which averages L+R for stereo).
 * Resampling: linear interpolation if the decoder's output sample rate
 * isn't already 16kHz -- acceptable for the production decode path since
 * the on-device parity GATE (Task 5) is proven against fixture PCM fed
 * directly into `computeMel`, bypassing this decoder entirely; this decoder
 * is separately sanity-checked end-to-end on a real downloaded song (no
 * essentia reference for that clip, just a non-degenerate-output check).
 *
 * Perf (Plan D Task 6b): profiling a real download on a Moto G64 showed
 * decode dominating the ~2-3min/song cost -- this function used to run
 * MediaExtractor/MediaCodec start-to-finish over the ENTIRE track (a
 * budget-device software audio codec can run close to real-time, so decode
 * cost scaled with FULL TRACK LENGTH) and only slice down to the middle 120s
 * (MiddleSlice, in AudioMelModule) AFTER paying for that whole decode. Since
 * only a ~120s centered window is ever analyzed, this now seeks close to the
 * middle of the track BEFORE decoding and stops the decode loop once it has
 * captured WINDOW_SECONDS+2*MARGIN_SECONDS of audio, instead of running to
 * the file's true end-of-stream -- bounding decode work to a fixed ~136s
 * regardless of how long the source track is. MiddleSlice afterward trims
 * this (still slightly-oversized, for seek-imprecision/resample-edge safety)
 * buffer down to the exact centered 120s, so the ANALYZED AUDIO is
 * unchanged -- only the amount of decode work shrinks. Short tracks (at or
 * under the bounded window) are decoded in full, exactly as before.
 */
object AudioDecoder {
    private const val TARGET_SAMPLE_RATE = 16000

    // Must stay >= AudioMelModule.MIDDLE_SLICE_SECONDS (120) -- this is the
    // amount of audio MiddleSlice needs available to produce its centered
    // slice; MARGIN_SECONDS on top covers seek imprecision (MediaExtractor
    // seeks to the nearest sync point, not the exact microsecond) and the
    // linear resampler's edge behavior.
    private const val WINDOW_SECONDS = 120
    private const val MARGIN_SECONDS = 8
    private const val BOUNDED_WINDOW_US = (WINDOW_SECONDS + 2 * MARGIN_SECONDS).toLong() * 1_000_000L

    fun decodeToMonoPcm16k(path: String): FloatArray {
        val extractor = MediaExtractor()
        var codec: MediaCodec? = null
        try {
            extractor.setDataSource(path)
            var trackIndex = -1
            var format: MediaFormat? = null
            for (i in 0 until extractor.trackCount) {
                val f = extractor.getTrackFormat(i)
                val mime = f.getString(MediaFormat.KEY_MIME) ?: continue
                if (mime.startsWith("audio/")) {
                    trackIndex = i
                    format = f
                    break
                }
            }
            require(trackIndex >= 0 && format != null) { "no audio track found in $path" }
            extractor.selectTrack(trackIndex)

            val mime = format.getString(MediaFormat.KEY_MIME)!!
            var sampleRate = if (format.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            } else {
                TARGET_SAMPLE_RATE
            }
            var channelCount = if (format.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            } else {
                1
            }

            // Bound decode work to ~136s: if the track is long enough that
            // full decode would waste time on audio MiddleSlice would just
            // throw away anyway, seek to the start of a centered window and
            // cap how much output we collect. Unknown duration or a track
            // already at/under the bounded window: fall back to full decode
            // (identical to pre-Task-6b behavior) rather than risk seeking
            // wrong on a file we can't reason about.
            val durationUs = if (format.containsKey(MediaFormat.KEY_DURATION)) {
                format.getLong(MediaFormat.KEY_DURATION)
            } else {
                -1L
            }
            var sampleBudget = Long.MAX_VALUE
            if (durationUs > BOUNDED_WINDOW_US) {
                val startUs = ((durationUs - WINDOW_SECONDS.toLong() * 1_000_000L) / 2
                    - MARGIN_SECONDS.toLong() * 1_000_000L).coerceAtLeast(0)
                extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
                // Budget is in SOURCE sample-rate frames (pre-resample) --
                // recomputed below once channelCount/sampleRate are final
                // (they're already known from the input format for nearly
                // every container; OUTPUT_FORMAT_CHANGED, handled below,
                // corrects them if the decoder disagrees before real data
                // arrives).
                sampleBudget = (BOUNDED_WINDOW_US * sampleRate) / 1_000_000L
            }

            val dec = MediaCodec.createDecoderByType(mime)
            codec = dec
            dec.configure(format, null, null, 0)
            dec.start()

            val bufferInfo = MediaCodec.BufferInfo()
            val pcmChunks = ArrayList<ShortArray>()
            var sawInputEos = false
            var sawOutputEos = false
            var framesDecoded = 0L

            while (!sawOutputEos) {
                if (!sawInputEos) {
                    val inIndex = dec.dequeueInputBuffer(10_000)
                    if (inIndex >= 0) {
                        val inBuf = dec.getInputBuffer(inIndex)!!
                        val sampleSize = extractor.readSampleData(inBuf, 0)
                        if (sampleSize < 0) {
                            dec.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            sawInputEos = true
                        } else {
                            val pts = extractor.sampleTime
                            dec.queueInputBuffer(inIndex, 0, sampleSize, pts, 0)
                            extractor.advance()
                        }
                    }
                }

                val outIndex = dec.dequeueOutputBuffer(bufferInfo, 10_000)
                when {
                    outIndex >= 0 -> {
                        if (bufferInfo.size > 0) {
                            val outBuf = dec.getOutputBuffer(outIndex)!!
                            outBuf.position(bufferInfo.offset)
                            outBuf.limit(bufferInfo.offset + bufferInfo.size)
                            val shortBuf = outBuf.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                            val arr = ShortArray(shortBuf.remaining())
                            shortBuf.get(arr)
                            pcmChunks.add(arr)
                            val channels = if (channelCount <= 0) 1 else channelCount
                            framesDecoded += arr.size / channels
                        }
                        dec.releaseOutputBuffer(outIndex, false)
                        if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                            sawOutputEos = true
                        } else if (framesDecoded >= sampleBudget) {
                            // Collected enough of the centered window --
                            // stop decoding the rest of the track rather
                            // than running to true EOS. codec/extractor are
                            // released unconditionally in `finally` below,
                            // which is safe to call mid-stream.
                            sawInputEos = true
                            sawOutputEos = true
                        }
                    }
                    outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        val newFormat = dec.outputFormat
                        if (newFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                            sampleRate = newFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                        }
                        if (newFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                            channelCount = newFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                        }
                        if (sampleBudget != Long.MAX_VALUE) {
                            sampleBudget = (BOUNDED_WINDOW_US * sampleRate) / 1_000_000L
                        }
                    }
                    else -> Unit // INFO_TRY_AGAIN_LATER / INFO_OUTPUT_BUFFERS_CHANGED (deprecated): nothing to do
                }
            }

            val mono = downmixToMonoFloat(pcmChunks, channelCount)
            return if (sampleRate == TARGET_SAMPLE_RATE) mono else sincResample(mono, sampleRate, TARGET_SAMPLE_RATE)
        } finally {
            codec?.let {
                it.stop()
                it.release()
            }
            extractor.release()
        }
    }

    private fun downmixToMonoFloat(chunks: List<ShortArray>, channelCount: Int): FloatArray {
        val channels = if (channelCount <= 0) 1 else channelCount
        val totalSamples = chunks.sumOf { it.size }
        val frameCount = totalSamples / channels
        val mono = FloatArray(frameCount)
        var frameIdx = 0
        for (chunk in chunks) {
            var i = 0
            while (i + channels <= chunk.size) {
                var sum = 0f
                for (c in 0 until channels) sum += chunk[i + c] / 32768f
                mono[frameIdx] = sum / channels
                frameIdx++
                i += channels
            }
        }
        return if (frameIdx == mono.size) mono else mono.copyOf(frameIdx)
    }

    // Resampler kernel params, tuned to match essentia's MonoLoader resampler
    // to embedding cosine >= 0.99 end-to-end (measured on real songs). A
    // Kaiser-windowed sinc with a transition band (cutoff below Nyquist) is what
    // essentia/ffmpeg use; a plain Hann-windowed sinc plateaued at ~0.96-0.98.
    // Sweep result (half, beta, cutoff): (16,9,1.0)->0.974, (32,14,0.92)->0.986,
    // (64,16,0.90)->0.9975 mean. So: 64 taps/side, beta 16, cutoff 0.90.
    private const val SINC_HALF = 64
    private const val KAISER_BETA = 16.0
    private const val CUTOFF_FRAC = 0.90

    /**
     * Windowed-sinc (Lanczos-style) resampler.
     *
     * REPLACES an earlier naive linear-interpolation resampler. Linear interp
     * was the single largest source of on-device/essentia divergence: measured
     * end-to-end (real songs, MediaCodec decode + resample vs essentia
     * MonoLoader) it dragged embedding cosine down to ~0.93-0.96, well under the
     * 0.99 the mel-only fixture gate implied -- because linear interpolation is a
     * poor low-pass filter and lets aliasing through when downsampling (source
     * is typically 44.1k/48k -> 16k). Holding decode constant and swapping only
     * the resampler (linear -> proper) reproduced the exact drift, isolating this
     * as the cause. A windowed-sinc kernel with a proper anti-alias cutoff at the
     * lower Nyquist restores parity to >=0.99.
     *
     * For each output sample it sums nearby input samples weighted by
     * `sinc(fc * t) * hann(t)`, where `fc = min(1, dstRate/srcRate)` is the
     * normalized cutoff (only < 1 when downsampling, which is our case), and the
     * weights are normalized so DC gain is exactly 1.
     */
    private fun sincResample(input: FloatArray, srcRate: Int, dstRate: Int): FloatArray {
        if (srcRate == dstRate || input.isEmpty()) return input
        val step = srcRate.toDouble() / dstRate.toDouble() // input samples per output sample
        val outLen = (input.size / step).toInt()
        val out = FloatArray(outLen)
        // Anti-alias cutoff at the LOWER Nyquist, pulled in by CUTOFF_FRAC to
        // leave a transition band (the last ~10% would otherwise alias).
        val fc = (if (dstRate < srcRate) dstRate.toDouble() / srcRate.toDouble() else 1.0) * CUTOFF_FRAC
        val n = input.size
        val i0Beta = besselI0(KAISER_BETA)
        for (i in 0 until outLen) {
            val center = i * step
            val i0 = Math.floor(center).toInt()
            var acc = 0.0
            var norm = 0.0
            var k = i0 - SINC_HALF + 1
            val kEnd = i0 + SINC_HALF
            while (k <= kEnd) {
                if (k in 0 until n) {
                    val t = center - k
                    val w = sincLowpass(t, fc) * kaiser(t, SINC_HALF, i0Beta)
                    acc += input[k] * w
                    norm += w
                }
                k++
            }
            out[i] = if (norm != 0.0) (acc / norm).toFloat() else 0f
        }
        return out
    }

    /** Normalized-sinc low-pass kernel value: fc * sinc(fc * t), sinc(0)=1. */
    private fun sincLowpass(t: Double, fc: Double): Double {
        if (t == 0.0) return fc
        val x = Math.PI * fc * t
        return fc * Math.sin(x) / x
    }

    /**
     * Kaiser window over [-half, half]; 0 outside.
     * w(t) = I0(beta * sqrt(1 - (t/half)^2)) / I0(beta). `i0Beta` = I0(beta),
     * precomputed by the caller since it's constant across the whole resample.
     */
    private fun kaiser(t: Double, half: Int, i0Beta: Double): Double {
        val r = t / half
        if (r <= -1.0 || r >= 1.0) return 0.0
        return besselI0(KAISER_BETA * Math.sqrt(1.0 - r * r)) / i0Beta
    }

    /** Modified Bessel function of the first kind, order 0 (series expansion). */
    private fun besselI0(x: Double): Double {
        var sum = 1.0
        var term = 1.0
        val halfXSq = (x * x) / 4.0
        var k = 1
        while (k < 50) {
            term *= halfXSq / (k * k)
            sum += term
            if (term < 1e-12 * sum) break
            k++
        }
        return sum
    }
}
