package com.flowstate.audiomel

import java.io.ByteArrayOutputStream

/**
 * Plain-Kotlin/JVM base64 codec (standard alphabet, `=` padding) -- used
 * instead of `android.util.Base64` so the mel/FFT pipeline (and its bridge
 * payload encoding) can be exercised by plain JVM unit tests
 * (`src/test/java/...`) without an Android runtime/Robolectric.
 */
object Base64Codec {
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    private val DECODE_TABLE = IntArray(128) { -1 }.also { table ->
        for ((idx, c) in ALPHABET.withIndex()) table[c.code] = idx
    }

    fun encode(bytes: ByteArray): String {
        val out = StringBuilder(((bytes.size + 2) / 3) * 4)
        var i = 0
        while (i < bytes.size) {
            val b0 = bytes[i].toInt() and 0xFF
            val hasB1 = i + 1 < bytes.size
            val hasB2 = i + 2 < bytes.size
            val b1 = if (hasB1) bytes[i + 1].toInt() and 0xFF else 0
            val b2 = if (hasB2) bytes[i + 2].toInt() and 0xFF else 0
            val triple = (b0 shl 16) or (b1 shl 8) or b2
            out.append(ALPHABET[(triple shr 18) and 0x3F])
            out.append(ALPHABET[(triple shr 12) and 0x3F])
            out.append(if (hasB1) ALPHABET[(triple shr 6) and 0x3F] else '=')
            out.append(if (hasB2) ALPHABET[triple and 0x3F] else '=')
            i += 3
        }
        return out.toString()
    }

    fun decode(s: String): ByteArray {
        val out = ByteArrayOutputStream(s.length / 4 * 3 + 3)
        var buffer = 0
        var bits = 0
        for (c in s) {
            if (c == '=' || c == '\n' || c == '\r') continue
            val v = if (c.code < DECODE_TABLE.size) DECODE_TABLE[c.code] else -1
            if (v < 0) continue
            buffer = (buffer shl 6) or v
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.write((buffer shr bits) and 0xFF)
            }
        }
        return out.toByteArray()
    }
}
