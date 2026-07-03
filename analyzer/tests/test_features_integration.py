import subprocess

import numpy as np
import pytest

pytest.importorskip("essentia")

from flowstate_analyzer.features import Extractor  # noqa: E402

MOOD_KEYS = {"happy", "sad", "relaxed", "aggressive", "danceable", "acoustic", "party"}


@pytest.mark.integration
def test_extract_on_generated_tone(tmp_path):
    wav = tmp_path / "tone.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=10", str(wav)],
        check=True, capture_output=True,
    )
    f = Extractor("/models").extract(wav)
    emb = np.frombuffer(f.embedding, dtype=np.float32)
    assert emb.shape == (200,)
    assert set(f.moods) == MOOD_KEYS
    assert all(0.0 <= v <= 1.0 for v in f.moods.values())
    assert f.bpm >= 0
    assert f.energy >= 0
    assert isinstance(f.key, str) and f.key
