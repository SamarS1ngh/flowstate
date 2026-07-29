package com.flowstate.audiomel

import android.content.Context
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Loads the baked mel filterbank (96 x 257 float64-precision weights,
 * stored as little-endian float32) from the app's Android assets. Generated
 * by running `analyzer/scripts/mel_reference.mel_filterbank()` and dumping
 * it to `android/app/src/main/assets/musicnn_mel_filterbank_96x257_f32le.bin`
 * -- see that script for provenance. Cached process-wide after first load.
 */
object FilterbankAsset {
    const val ASSET_NAME = "musicnn_mel_filterbank_96x257_f32le.bin"

    @Volatile
    private var cached: Array<DoubleArray>? = null

    fun get(context: Context): Array<DoubleArray> {
        cached?.let { return it }
        synchronized(this) {
            cached?.let { return it }
            val bytes = context.assets.open(ASSET_NAME).use { it.readBytes() }
            val loaded = parse(bytes)
            cached = loaded
            return loaded
        }
    }

    internal fun parse(bytes: ByteArray): Array<DoubleArray> {
        val floatBuf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
        val expected = MelPipeline.N_MELS * MelPipeline.N_BINS
        require(floatBuf.remaining() == expected) {
            "filterbank asset has ${floatBuf.remaining()} floats, expected $expected " +
                "(${MelPipeline.N_MELS}x${MelPipeline.N_BINS})"
        }
        return Array(MelPipeline.N_MELS) { m ->
            DoubleArray(MelPipeline.N_BINS) { floatBuf.get().toDouble() }
        }
    }
}
