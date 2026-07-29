package com.flowstate.audiomel

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Cross-checks the Kotlin mel port against `analyzer/scripts/mel_reference.py`
 * (the validated, parity-gated recipe -- commit 130ab47) BEFORE any
 * on-device run: a 1s, 1kHz sine (the exact same synthesis formula as
 * `gen_fixtures.py`'s `_sine`) is run through this Kotlin pipeline and
 * compared to hand-verified mel values dumped by running
 * `mel_reference.audio_to_mel` on the identical signal in Python (see the
 * comment above each expected array for the exact command).
 */
class MelPipelineTest {
    private fun loadTestFilterbank(): Array<DoubleArray> {
        val bytes = requireNotNull(
            javaClass.classLoader?.getResourceAsStream(FilterbankAsset.ASSET_NAME)?.readBytes()
        ) { "test resource ${FilterbankAsset.ASSET_NAME} not found -- copy it from src/main/assets" }
        return FilterbankAsset.parse(bytes)
    }

    private fun sine(freq: Double, seconds: Double, amp: Double = 0.5, sr: Int = 16000): FloatArray {
        val n = (seconds * sr).toInt()
        return FloatArray(n) { i -> (amp * sin(2.0 * PI * freq * i / sr)).toFloat() }
    }

    // Reference values from:
    //   python3 -c "
    //   import sys; sys.path.insert(0,'scripts')
    //   import numpy as np, math
    //   from mel_reference import audio_to_mel
    //   t = np.arange(16000)/16000.0
    //   audio = (0.5*np.sin(2*math.pi*1000.0*t))
    //   mel = audio_to_mel(audio)
    //   print(mel.shape)
    //   print(mel[0,[0,1,2,10,50,95]])
    //   print(mel[30,[0,1,2,10,50,95]])
    //   "
    // (run from analyzer/, see this session's transcript) -- mel shape (64, 96).
    @Test
    fun matchesMelReference_sine1000hz_frame0() {
        val filterbank = loadTestFilterbank()
        val audio = sine(1000.0, 1.0)
        val mel = MelPipeline.audioToMel(audio, filterbank)

        assertEquals(64, mel.size)
        assertEquals(96, mel[0].size)

        val expectedFrame0 = mapOf(0 to 2.7054367, 1 to 2.7088115, 2 to 2.7122958, 10 to 2.8140240, 50 to 2.0032284, 95 to 0.2542111)
        for ((band, expected) in expectedFrame0) {
            assertTrue(
                "frame0 band $band: expected ~$expected, got ${mel[0][band]}",
                abs(mel[0][band] - expected) < 1e-3,
            )
        }
    }

    @Test
    fun matchesMelReference_sine1000hz_frame30() {
        val filterbank = loadTestFilterbank()
        val audio = sine(1000.0, 1.0)
        val mel = MelPipeline.audioToMel(audio, filterbank)

        // Steady-state frame: energy concentrated near 1kHz, so bands away
        // from that bin should be near the log-floor (~0), not the frame-0
        // broadband-leakage magnitude checked above.
        val expectedFrame30 = mapOf(0 to 3.47715e-07, 1 to 4.49233e-07, 2 to 6.23387e-07, 10 to 6.885614e-06, 50 to 3.745289e-06, 95 to 4.996576e-10)
        for ((band, expected) in expectedFrame30) {
            assertTrue(
                "frame30 band $band: expected ~$expected, got ${mel[30][band]}",
                abs(mel[30][band] - expected) < 1e-4,
            )
        }
    }

    @Test
    fun tooShortAudio_producesZeroPatches() {
        val filterbank = loadTestFilterbank()
        val audio = sine(1000.0, 1.0) // 64 frames, well under PATCH_SIZE=187
        val mel = MelPipeline.audioToMel(audio, filterbank)
        val patches = MelPipeline.melToPatches(mel)
        assertEquals(0, patches.size)
    }

    @Test
    fun longEnoughAudio_producesExpectedPatchCount() {
        val filterbank = loadTestFilterbank()
        // 12s @16kHz, same as the golden fixture clips.
        val audio = sine(1000.0, 12.0)
        val mel = MelPipeline.audioToMel(audio, filterbank)
        val patches = MelPipeline.melToPatches(mel)
        // n_frames for a 12s/16kHz clip matches the golden fixtures' n_patches=7
        // (see analyzer/fixtures/sine_1000hz.json).
        assertEquals(7, patches.size)
        assertEquals(187, patches[0].size)
        assertEquals(96, patches[0][0].size)

        val flat = MelPipeline.flattenPatches(patches)
        assertEquals(7 * 187 * 96, flat.size)
    }

    @Test
    fun frameSignal_zeroCenteredFraming_matchesExpectedFrameCount() {
        // essentia FrameCutter(startFromZero=False): first frame centered on
        // sample 0; verify against the same formula mel_reference.py documents.
        val audio = DoubleArray(1000) { 1.0 }
        val frames = MelPipeline.frameSignal(audio)
        // start = -256, hop=256; frames continue while center < n=1000.
        // centers: 0, 256, 512, 768, 1024(>=1000 -> last frame included, stop)
        assertEquals(5, frames.size)
        assertEquals(512, frames[0].size)
    }
}
