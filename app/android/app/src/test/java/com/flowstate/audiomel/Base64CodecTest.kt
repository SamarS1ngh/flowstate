package com.flowstate.audiomel

import kotlin.random.Random
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class Base64CodecTest {
    @Test
    fun roundTrips_randomByteArrays_ofVariousLengths() {
        val rng = Random(7)
        for (len in intArrayOf(0, 1, 2, 3, 4, 5, 16, 97, 1000, 100_003)) {
            val bytes = ByteArray(len) { rng.nextInt(256).toByte() }
            val encoded = Base64Codec.encode(bytes)
            val decoded = Base64Codec.decode(encoded)
            assertArrayEquals("length $len", bytes, decoded)
        }
    }

    @Test
    fun matchesKnownVector() {
        // "flowstate" -> base64, verifiable against any standard base64 tool.
        val bytes = "flowstate".toByteArray(Charsets.US_ASCII)
        assertEquals("Zmxvd3N0YXRl", Base64Codec.encode(bytes))
        assertArrayEquals(bytes, Base64Codec.decode("Zmxvd3N0YXRl"))
    }
}

class FloatCodecTest {
    @Test
    fun roundTrips_floatArray() {
        val values = FloatArray(1000) { i -> (i - 500) * 0.001234f }
        val encoded = FloatCodec.encode(values)
        val decoded = FloatCodec.decode(encoded)
        assertEquals(values.size, decoded.size)
        for (i in values.indices) {
            assertEquals(values[i], decoded[i], 1e-9f)
        }
    }

    @Test
    fun emptyArray_roundTrips() {
        val decoded = FloatCodec.decode(FloatCodec.encode(FloatArray(0)))
        assertEquals(0, decoded.size)
    }
}
