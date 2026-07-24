"""Plan D Phase 1 Task 3 -- the on-device analysis PARITY GATE.

Two layers, both against the golden fixtures in `analyzer/fixtures/*.json`
(dumped from essentia inside the flowstate-analyzer Docker image by
`scripts/gen_fixtures.py --dump`):

  1. `test_mel_matches_essentia` -- pure numpy, no extra deps: does
     `scripts/mel_reference.py` (no essentia dependency) reproduce
     essentia's own `TensorflowInputMusiCNN` mel bands per-bin? Requires
     correlation >= 0.99 (in practice: ~1.000000, float32-precision noise).

  2. `test_full_pipeline_cosine_and_moods` -- needs `tensorflow` (or a
     tflite runtime) to run `analyzer/models_tflite/*.tflite`: does
     numpy-mel -> patches -> TFLite embedding -> mean-pool reproduce
     essentia's own 200-d embedding? **THE GATE: cosine >= 0.99 REQUIRED.**
     Also checks the 7 mood-head scores are within +/-0.1.

The wav clips themselves are NOT committed (deterministically regenerated
by `scripts/gen_fixtures.py --generate`, see `_ensure_wavs()` below) --
only the essentia-computed JSON fixtures are, since those are the actual
oracle data this test protects.
"""
from __future__ import annotations

import base64
import json
import sys
import wave
from pathlib import Path

import numpy as np
import pytest

ANALYZER_DIR = Path(__file__).resolve().parent.parent
FIXTURES_DIR = ANALYZER_DIR / "fixtures"
WAV_DIR = FIXTURES_DIR / "wav"
MODELS_DIR = ANALYZER_DIR / "models_tflite"

sys.path.insert(0, str(ANALYZER_DIR / "scripts"))
from mel_reference import audio_to_mel, mel_to_patches  # noqa: E402

MEL_CORRELATION_GATE = 0.99
EMBEDDING_COSINE_GATE = 0.99
MOOD_MAX_DIFF_GATE = 0.1

MOOD_HEAD_FILES = {
    "happy": ("mood_happy-msd-musicnn-1.tflite", 0),
    "sad": ("mood_sad-msd-musicnn-1.tflite", 1),
    "relaxed": ("mood_relaxed-msd-musicnn-1.tflite", 1),
    "aggressive": ("mood_aggressive-msd-musicnn-1.tflite", 0),
    "danceable": ("danceability-msd-musicnn-1.tflite", 0),
    "acoustic": ("mood_acoustic-msd-musicnn-1.tflite", 0),
    "party": ("mood_party-msd-musicnn-1.tflite", 1),
}


def _fixture_paths() -> list[Path]:
    paths = sorted(FIXTURES_DIR.glob("*.json"))
    if not paths:
        pytest.skip(f"no fixtures found in {FIXTURES_DIR} -- run scripts/gen_fixtures.py --generate/--dump first")
    return paths


def _ensure_wavs() -> None:
    """Regenerate the (gitignored) wav clips deterministically if missing."""
    from gen_fixtures import make_clips, _write_wav  # noqa: PLC0415

    WAV_DIR.mkdir(parents=True, exist_ok=True)
    clips = None
    for path in _fixture_paths():
        wav_path = WAV_DIR / f"{path.stem}.wav"
        if not wav_path.exists():
            if clips is None:
                clips = make_clips()
            _write_wav(wav_path, clips[path.stem])


def _read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        n = w.getnframes()
        data = w.readframes(n)
    return np.frombuffer(data, dtype="<i2").astype(np.float64) / 32768.0


def _load_fixture(path: Path) -> dict:
    return json.loads(path.read_text())


def _b64_to_f32(b64: str, shape: list[int]) -> np.ndarray:
    return np.frombuffer(base64.b64decode(b64), dtype=np.float32).reshape(shape)


@pytest.fixture(scope="module", autouse=True)
def _wavs_ready():
    _ensure_wavs()


@pytest.mark.parametrize("fixture_path", _fixture_paths(), ids=lambda p: p.stem)
def test_mel_matches_essentia(fixture_path: Path):
    fx = _load_fixture(fixture_path)
    audio = _read_wav(WAV_DIR / f"{fx['clip']}.wav")

    my_mel = audio_to_mel(audio)
    ess_mel = _b64_to_f32(fx["mel"]["b64"], fx["mel"]["shape"])

    assert my_mel.shape == ess_mel.shape, (
        f"{fx['clip']}: frame count mismatch -- numpy framing (FrameCutter port) has drifted "
        f"from essentia's (mine={my_mel.shape}, essentia={ess_mel.shape})"
    )

    max_abs_diff = float(np.max(np.abs(my_mel - ess_mel)))

    # `silence` is a constant-zero mel matrix: Pearson correlation is
    # undefined (zero variance) even for a perfect match, so gate it on
    # exact-ish equality instead of correlation.
    if np.allclose(ess_mel, 0.0, atol=1e-6):
        assert max_abs_diff < 1e-4, f"{fx['clip']}: max abs diff {max_abs_diff} too high for a silent clip"
        return

    corr = float(np.corrcoef(my_mel.flatten(), ess_mel.flatten())[0, 1])
    assert corr >= MEL_CORRELATION_GATE, (
        f"{fx['clip']}: mel per-bin correlation {corr:.6f} < gate {MEL_CORRELATION_GATE} "
        f"(max abs diff {max_abs_diff:.6f})"
    )


@pytest.mark.tflite
@pytest.mark.parametrize("fixture_path", _fixture_paths(), ids=lambda p: p.stem)
def test_full_pipeline_cosine_and_moods(fixture_path: Path):
    tf = pytest.importorskip("tensorflow")

    fx = _load_fixture(fixture_path)
    audio = _read_wav(WAV_DIR / f"{fx['clip']}.wav")

    patches = mel_to_patches(audio_to_mel(audio))
    if patches.shape[0] == 0:
        pytest.skip(f"{fx['clip']}: clip too short for a single 187-frame patch")

    embed_interp = tf.lite.Interpreter(model_path=str(MODELS_DIR / "msd-musicnn-1.tflite"))
    embed_interp.allocate_tensors()
    embed_in = embed_interp.get_input_details()[0]
    embed_out = embed_interp.get_output_details()[0]

    my_embeddings = []
    for patch in patches:
        embed_interp.set_tensor(embed_in["index"], patch[np.newaxis, :, :].astype(np.float32))
        embed_interp.invoke()
        my_embeddings.append(embed_interp.get_tensor(embed_out["index"])[0])
    my_embeddings = np.stack(my_embeddings, axis=0)
    my_embedding = my_embeddings.mean(axis=0)

    ess_embedding = _b64_to_f32(fx["embedding"]["b64"], fx["embedding"]["shape"])

    cosine = float(
        np.dot(my_embedding, ess_embedding)
        / (np.linalg.norm(my_embedding) * np.linalg.norm(ess_embedding) + 1e-12)
    )
    assert cosine >= EMBEDDING_COSINE_GATE, (
        f"{fx['clip']}: embedding cosine {cosine:.6f} < THE GATE ({EMBEDDING_COSINE_GATE}) -- "
        "on-device (numpy-mel -> TFLite) pipeline does not reproduce essentia's embedding closely enough"
    )

    for mood_name, (fn, positive_index) in MOOD_HEAD_FILES.items():
        interp = tf.lite.Interpreter(model_path=str(MODELS_DIR / fn))
        interp.allocate_tensors()
        head_in = interp.get_input_details()[0]
        head_out = interp.get_output_details()[0]

        probs = []
        for emb in my_embeddings:
            interp.set_tensor(head_in["index"], emb[np.newaxis, :].astype(np.float32))
            interp.invoke()
            probs.append(interp.get_tensor(head_out["index"])[0])
        my_mood = float(np.stack(probs, axis=0).mean(axis=0)[positive_index])

        ess_mood = fx["moods"][mood_name]
        diff = abs(my_mood - ess_mood)
        assert diff <= MOOD_MAX_DIFF_GATE, (
            f"{fx['clip']}/{mood_name}: mood score diff {diff:.4f} > gate {MOOD_MAX_DIFF_GATE} "
            f"(mine={my_mood:.4f}, essentia={ess_mood:.4f})"
        )
