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
 */
object AudioDecoder {
    private const val TARGET_SAMPLE_RATE = 16000

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

            val dec = MediaCodec.createDecoderByType(mime)
            codec = dec
            dec.configure(format, null, null, 0)
            dec.start()

            val bufferInfo = MediaCodec.BufferInfo()
            val pcmChunks = ArrayList<ShortArray>()
            var sawInputEos = false
            var sawOutputEos = false

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
                        }
                        dec.releaseOutputBuffer(outIndex, false)
                        if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
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
