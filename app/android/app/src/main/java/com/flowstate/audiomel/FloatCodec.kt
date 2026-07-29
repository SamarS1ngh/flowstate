package com.flowstate.audiomel

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * FloatArray <-> base64 little-endian float32 bytes, matching the wire
 * format the JS side expects (see app/src/analyze/audio.ts's
 * base64ToFloat32Array / float32ArrayToBase64 -- ArrayBuffers on Android/RN
 * are little-endian, same convention as db/blob.ts's embedding BLOB).
 */
object FloatCodec {
    fun encode(values: FloatArray): String {
        val bytes = ByteArray(values.size * 4)
        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        for (v in values) buf.putFloat(v)
        return Base64Codec.encode(bytes)
    }

    fun decode(base64: String): FloatArray {
        val bytes = Base64Codec.decode(base64)
        require(bytes.size % 4 == 0) { "base64-decoded byte length ${bytes.size} is not a multiple of 4" }
        val floatBuf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
        val out = FloatArray(floatBuf.remaining())
        floatBuf.get(out)
        return out
    }
}
