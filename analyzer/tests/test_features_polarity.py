"""Host-runnable lock on the per-head mood polarity mapping in features.py.

`flowstate_analyzer/features.py` imports `essentia.standard` at module scope,
and essentia is not installed on this host (it only exists inside the Docker
image used by the integration test). To exercise `Extractor.extract` here we
install fake `essentia` / `essentia.standard` modules into `sys.modules`
*before* importing `flowstate_analyzer.features`, so the module-level import
in features.py resolves against our fakes instead of failing with
ModuleNotFoundError.

The fake mood-head model always returns the asymmetric probability row
[0.9, 0.1] for every patch, regardless of which head it represents. That
means the *only* thing that can make a head's reported score come out to
0.9 vs 0.1 is which index `MOOD_HEADS` says is the positive class for that
head. A revert to a uniform positive_index (e.g. all heads -> 0) would flip
sad/relaxed/party to 0.9 and this test would fail loudly.
"""

from __future__ import annotations

import sys
import types

import numpy as np
import pytest

N_PATCHES = 3
EMBED_DIM = 200

POSITIVE_INDEX_0 = {"happy", "aggressive", "danceable", "acoustic"}
POSITIVE_INDEX_1 = {"sad", "relaxed", "party"}


class _FakeMonoLoader:
    def __init__(self, filename=None, sampleRate=None, **kwargs):
        self.filename = filename
        self.sampleRate = sampleRate

    def __call__(self):
        return np.zeros(1024, dtype=np.float32)


class _FakeTensorflowPredictMusiCNN:
    """Stand-in for the embedding model: (n_patches, 200) float32 patches."""

    def __init__(self, graphFilename=None, output=None, **kwargs):
        self.graphFilename = graphFilename
        self.output = output

    def __call__(self, audio):
        row = np.arange(EMBED_DIM, dtype=np.float32)
        return np.tile(row, (N_PATCHES, 1))


class _FakeTensorflowPredict2D:
    """Stand-in for a mood head: every patch scores [0.9, 0.1].

    This is deliberately identical for every head - the fake has no idea
    which mood it's supposed to represent. Only MOOD_HEADS' positive_index
    determines whether Extractor.extract reports 0.9 or 0.1 for a given mood.
    """

    def __init__(self, graphFilename=None, output=None, **kwargs):
        self.graphFilename = graphFilename
        self.output = output

    def __call__(self, patches):
        row = np.array([0.9, 0.1], dtype=np.float32)
        return np.tile(row, (N_PATCHES, 1))


class _FakeRhythmExtractor2013:
    def __init__(self, method=None, **kwargs):
        self.method = method

    def __call__(self, audio):
        return (128.0, 0, 0.0, [], [])


class _FakeKeyExtractor:
    def __call__(self, audio):
        return ("C", "major", 0.9)


class _FakeRMS:
    def __call__(self, audio):
        return 0.05


def _install_fake_essentia():
    essentia_module = types.ModuleType("essentia")
    standard_module = types.ModuleType("essentia.standard")
    standard_module.MonoLoader = _FakeMonoLoader
    standard_module.TensorflowPredictMusiCNN = _FakeTensorflowPredictMusiCNN
    standard_module.TensorflowPredict2D = _FakeTensorflowPredict2D
    standard_module.RhythmExtractor2013 = _FakeRhythmExtractor2013
    standard_module.KeyExtractor = _FakeKeyExtractor
    standard_module.RMS = _FakeRMS
    essentia_module.standard = standard_module

    sys.modules["essentia"] = essentia_module
    sys.modules["essentia.standard"] = standard_module


def _uninstall_fake_essentia():
    sys.modules.pop("essentia", None)
    sys.modules.pop("essentia.standard", None)


@pytest.fixture
def features_module():
    # Hygienic on both sides: make sure we import a fresh module against our
    # fakes, and don't leave anything behind (real or fake) for other tests.
    sys.modules.pop("flowstate_analyzer.features", None)
    _install_fake_essentia()
    try:
        import flowstate_analyzer.features as features

        yield features
    finally:
        _uninstall_fake_essentia()
        sys.modules.pop("flowstate_analyzer.features", None)


def test_mood_heads_constants_encode_documented_positive_index(features_module):
    # Assert the mapping constants directly so a revert of MOOD_HEADS itself
    # (not just extract()'s use of it) fails loudly.
    mood_heads = features_module.MOOD_HEADS
    assert mood_heads["happy"][1] == 0
    assert mood_heads["aggressive"][1] == 0
    assert mood_heads["danceable"][1] == 0
    assert mood_heads["acoustic"][1] == 0
    assert mood_heads["sad"][1] == 1
    assert mood_heads["relaxed"][1] == 1
    assert mood_heads["party"][1] == 1


def test_extract_reports_positive_class_per_head(features_module, tmp_path):
    extractor = features_module.Extractor(tmp_path)
    audio_path = tmp_path / "tone.wav"
    audio_path.write_bytes(b"")  # never read; MonoLoader is faked

    f = extractor.extract(audio_path)

    assert set(f.moods) == POSITIVE_INDEX_0 | POSITIVE_INDEX_1

    for name in POSITIVE_INDEX_0:
        assert f.moods[name] == pytest.approx(0.9), name
    for name in POSITIVE_INDEX_1:
        assert f.moods[name] == pytest.approx(0.1), name

    # Embedding contract: mean over (n_patches, 200) patches -> 200 float32s.
    emb = np.frombuffer(f.embedding, dtype=np.float32)
    assert emb.shape == (200,)
    assert len(f.embedding) == 800
