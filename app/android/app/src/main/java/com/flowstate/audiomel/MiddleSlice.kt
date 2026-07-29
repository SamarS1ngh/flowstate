package com.flowstate.audiomel

/**
 * Port of analyzer/flowstate_analyzer/features.py's `middle_slice`: returns
 * the centered `seconds`-long slice of `audio` at `sampleRate`, or `audio`
 * unchanged if it's not longer than the window (nothing to trim).
 */
object MiddleSlice {
    fun take(audio: FloatArray, sampleRate: Int, seconds: Int): FloatArray {
        if (seconds <= 0) return audio
        val window = seconds * sampleRate
        if (audio.size <= window) return audio
        val start = (audio.size - window) / 2
        return audio.copyOfRange(start, start + window)
    }
}
