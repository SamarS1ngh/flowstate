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
            return if (sampleRate == TARGET_SAMPLE_RATE) mono else linearResample(mono, sampleRate, TARGET_SAMPLE_RATE)
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

    /** Simple linear-interpolation resampler -- adequate for the production
     * decode path; see class doc for why this doesn't affect the parity gate. */
    private fun linearResample(input: FloatArray, srcRate: Int, dstRate: Int): FloatArray {
        if (srcRate == dstRate || input.isEmpty()) return input
        val ratio = srcRate.toDouble() / dstRate.toDouble()
        val outLen = (input.size / ratio).toInt()
        val out = FloatArray(outLen)
        for (i in 0 until outLen) {
            val srcPos = i * ratio
            val i0 = srcPos.toInt()
            val frac = (srcPos - i0).toFloat()
            val s0 = input[i0]
            val s1 = if (i0 + 1 < input.size) input[i0 + 1] else s0
            out[i] = s0 + (s1 - s0) * frac
        }
        return out
    }
}
