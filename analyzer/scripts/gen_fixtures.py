#!/usr/bin/env python3
"""Golden fixtures for the on-device (Plan D) parity gate.

Two independent phases, split because essentia is only available in the
`flowstate-analyzer` Docker image (amd64, slow under emulation on Apple
Silicon) while everything else is plain numpy:

  1. `--generate` — pure numpy/stdlib, runs anywhere (no essentia, no TF).
     Synthesizes >=10 short, DETERMINISTIC 16kHz mono wav clips (sine tones
     at various frequencies, a sweep, white/pink noise, a chord, an AM tone,
     a square wave, tone+noise, silence) covering low/high frequency and
     tonal/noisy variety, and writes them to `analyzer/fixtures/wav/*.wav`.
     Generating clips already at 16kHz mono sidesteps essentia's MonoLoader
     resampling/downmix path entirely (a second, unrelated source of
     essentia-vs-numpy drift we don't want to conflate with mel parity).

  2. `--dump` — MUST run inside the `flowstate-analyzer` image (essentia).
     For each wav in `analyzer/fixtures/wav/`, loads it at 16kHz (MonoLoader;
     effectively a passthrough decode since the wav is already 16kHz mono),
     and computes the golden oracle values:
       (a) essentia's per-frame MusiCNN mel bands, via
           `TensorflowInputMusiCNN` applied to each frame from
           `FrameGenerator(frameSize=512, hopSize=256)` (this is exactly
           what `TensorflowPredictMusiCNN`'s internal streaming FrameCutter
           + TensorflowInputMusiCNN produce — see
           test/src/unittests/spectral/test_tensorflowinputmusicnn.py in
           the essentia source, which validates the same recipe).
       (b) the 200-d embedding, mean-pooled over patches, from
           `TensorflowPredictMusiCNN(graphFilename=msd-musicnn-1.pb,
           output="model/dense/BiasAdd")` — byte-identical recipe to
           `flowstate_analyzer/features.py`'s `Extractor.extract`.
       (c) the 7 mood scores, same heads + positive-class indices as
           `flowstate_analyzer/features.py::MOOD_HEADS`.
     Writes `analyzer/fixtures/<clip>.json` with the mel matrix (base64
     float32, shape recorded), the embedding (base64 float32[200]), and the
     mood dict.

Usage:
    python scripts/gen_fixtures.py --generate
    # then, inside the flowstate-analyzer container (models baked at /models):
    python scripts/gen_fixtures.py --dump --models-dir /models
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import wave
from pathlib import Path

import numpy as np

SR = 16000
FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures"
WAV_DIR = FIXTURES_DIR / "wav"

EMBEDDING_MODEL = "msd-musicnn-1.pb"
# Mirrors flowstate_analyzer/features.py::MOOD_HEADS exactly (same files,
# same positive-class indices) so fixture moods are directly comparable to
# what v1's Extractor would produce for the same clip.
MOOD_HEADS = {
    "happy": ("mood_happy-msd-musicnn-1.pb", 0),
    "sad": ("mood_sad-msd-musicnn-1.pb", 1),
    "relaxed": ("mood_relaxed-msd-musicnn-1.pb", 1),
    "aggressive": ("mood_aggressive-msd-musicnn-1.pb", 0),
    "danceable": ("danceability-msd-musicnn-1.pb", 0),
    "acoustic": ("mood_acoustic-msd-musicnn-1.pb", 0),
    "party": ("mood_party-msd-musicnn-1.pb", 1),
}


def _write_wav(path: Path, samples: np.ndarray) -> None:
    """Write mono 16-bit PCM wav at SR from a float array in [-1, 1]."""
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def _t(seconds: float) -> np.ndarray:
    return np.arange(int(seconds * SR), dtype=np.float64) / SR


def _sine(freq: float, seconds: float, amp: float = 0.5) -> np.ndarray:
    return (amp * np.sin(2 * math.pi * freq * _t(seconds))).astype(np.float64)


def _white_noise(seconds: float, amp: float = 0.3, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return (amp * rng.standard_normal(int(seconds * SR))).astype(np.float64)


def _pink_noise(seconds: float, amp: float = 0.3, seed: int = 1) -> np.ndarray:
    # Simple 1/f approximation: filter white noise in the frequency domain.
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    white = rng.standard_normal(n)
    spectrum = np.fft.rfft(white)
    freqs = np.fft.rfftfreq(n, d=1.0 / SR)
    freqs[0] = freqs[1]  # avoid divide-by-zero at DC
    spectrum = spectrum / np.sqrt(freqs)
    pink = np.fft.irfft(spectrum, n=n)
    pink = pink / (np.max(np.abs(pink)) + 1e-9) * amp
    return pink.astype(np.float64)


def _sweep(f0: float, f1: float, seconds: float, amp: float = 0.5) -> np.ndarray:
    t = _t(seconds)
    k = (f1 / f0) ** (1.0 / seconds)
    phase = 2 * math.pi * f0 * (k**t - 1) / math.log(k)
    return (amp * np.sin(phase)).astype(np.float64)


def _square(freq: float, seconds: float, amp: float = 0.4) -> np.ndarray:
    return (amp * np.sign(np.sin(2 * math.pi * freq * _t(seconds)))).astype(np.float64)


def _chord(freqs: list[float], seconds: float, amp: float = 0.3) -> np.ndarray:
    t = _t(seconds)
    out = np.zeros_like(t)
    for f in freqs:
        out += np.sin(2 * math.pi * f * t)
    out = out / len(freqs) * amp
    return out.astype(np.float64)


def make_clips() -> dict[str, np.ndarray]:
    """Deterministic set of >=10 clips spanning low/high freq, tonal/noisy."""
    dur = 12.0
    clips = {
        "sine_100hz": _sine(100.0, dur),
        "sine_1000hz": _sine(1000.0, dur),
        "sine_5000hz": _sine(5000.0, dur),
        "sine_7500hz": _sine(7500.0, dur),
        "sweep_50_7900hz": _sweep(50.0, 7900.0, dur),
        "white_noise": _white_noise(dur),
        "pink_noise": _pink_noise(dur),
        "chord_am_minor": _chord([220.0, 261.63, 329.63, 440.0], dur),
        "am_tone_440hz_5hz": _sine(440.0, dur) * (0.5 + 0.5 * np.sin(2 * math.pi * 5.0 * _t(dur))),
        "square_440hz": _square(440.0, dur),
        "tone_plus_noise": _sine(440.0, dur, amp=0.35) + _white_noise(dur, amp=0.15, seed=2),
        "silence": np.zeros(int(5.0 * SR), dtype=np.float64),
    }
    return clips


def cmd_generate() -> None:
    WAV_DIR.mkdir(parents=True, exist_ok=True)
    clips = make_clips()
    for name, samples in clips.items():
        path = WAV_DIR / f"{name}.wav"
        _write_wav(path, samples)
        print(f"wrote {path} ({len(samples) / SR:.2f}s, {len(samples)} samples)")
    print(f"{len(clips)} clips generated in {WAV_DIR}")


def _b64_f32(arr: np.ndarray) -> str:
    return base64.b64encode(np.asarray(arr, dtype=np.float32).tobytes()).decode("ascii")


def cmd_dump(models_dir: str) -> None:
    # Imported lazily: only available inside the flowstate-analyzer image.
    from essentia.standard import (
        FrameGenerator,
        MonoLoader,
        TensorflowInputMusiCNN,
        TensorflowPredict2D,
        TensorflowPredictMusiCNN,
    )

    d = Path(models_dir)
    embed = TensorflowPredictMusiCNN(graphFilename=str(d / EMBEDDING_MODEL), output="model/dense/BiasAdd")
    heads = {
        name: (TensorflowPredict2D(graphFilename=str(d / fn), output="model/Softmax"), positive_index)
        for name, (fn, positive_index) in MOOD_HEADS.items()
    }
    mel_extractor = TensorflowInputMusiCNN()

    wavs = sorted(WAV_DIR.glob("*.wav"))
    if not wavs:
        raise SystemExit(f"No wav clips found in {WAV_DIR} -- run --generate first")

    for wav_path in wavs:
        name = wav_path.stem
        audio = MonoLoader(filename=str(wav_path), sampleRate=SR)()

        # (a) essentia's exact per-frame mel bands (essentia FrameGenerator
        # defaults match TensorflowPredictMusiCNN's internal streaming
        # FrameCutter: frameSize=512, hopSize=256, startFromZero=False).
        mel_frames = np.array(
            [mel_extractor(frame) for frame in FrameGenerator(audio, frameSize=512, hopSize=256, startFromZero=False)],
            dtype=np.float32,
        )

        # (b) 200-d embedding, mean-pooled over patches (same recipe as
        # flowstate_analyzer/features.py::Extractor.extract).
        patches = np.asarray(embed(audio))  # (n_patches, 200)
        embedding = patches.mean(axis=0).astype(np.float32)

        # (c) 7 mood scores.
        moods = {}
        for head_name, (head, positive_index) in heads.items():
            probs = np.asarray(head(patches))  # (n_patches, 2)
            moods[head_name] = float(probs.mean(axis=0)[positive_index])

        fixture = {
            "clip": name,
            "sample_rate": SR,
            "n_samples": int(len(audio)),
            "mel": {
                "shape": list(mel_frames.shape),
                "dtype": "float32",
                "b64": _b64_f32(mel_frames),
            },
            "embedding": {
                "shape": [200],
                "dtype": "float32",
                "b64": _b64_f32(embedding),
            },
            "n_patches": int(patches.shape[0]),
            "moods": moods,
        }
        out_path = FIXTURES_DIR / f"{name}.json"
        out_path.write_text(json.dumps(fixture, indent=2))
        print(
            f"{name}: {mel_frames.shape[0]} frames, {patches.shape[0]} patches, "
            f"embedding norm={np.linalg.norm(embedding):.4f} -> {out_path}"
        )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--generate", action="store_true", help="Generate synthetic wav clips (no essentia needed)")
    ap.add_argument("--dump", action="store_true", help="Dump essentia mel/embedding/mood fixtures (needs essentia)")
    ap.add_argument("--models-dir", default="/models", help="Directory with the .pb model files (default: /models)")
    args = ap.parse_args()

    if not args.generate and not args.dump:
        ap.error("pass --generate and/or --dump")

    if args.generate:
        cmd_generate()
    if args.dump:
        cmd_dump(args.models_dir)


if __name__ == "__main__":
    main()
