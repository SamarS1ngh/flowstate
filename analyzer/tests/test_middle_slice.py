"""Pure-numpy tests for features.middle_slice.

middle_slice itself only touches numpy arrays and plain numbers, but
flowstate_analyzer/features.py imports `essentia.standard` at module scope,
and essentia is not installed on this host (it only exists inside the
Docker image used by the integration test). So, like
test_features_polarity.py, we install minimal fake `essentia` /
`essentia.standard` modules into sys.modules before importing
flowstate_analyzer.features, purely so the module import succeeds - none of
these fakes are exercised by the assertions below, which are pure numpy.
The fixture cleans sys.modules up afterwards so it doesn't leak into other
test modules (e.g. test_features_integration.py's importorskip("essentia")).
"""

from __future__ import annotations

import sys
import types

import numpy as np
import pytest


@pytest.fixture
def middle_slice():
    essentia_module = types.ModuleType("essentia")
    standard_module = types.ModuleType("essentia.standard")
    for name in (
        "MonoLoader",
        "TensorflowPredictMusiCNN",
        "TensorflowPredict2D",
        "RhythmExtractor2013",
        "KeyExtractor",
        "RMS",
    ):
        setattr(standard_module, name, object)
    essentia_module.standard = standard_module

    sys.modules["essentia"] = essentia_module
    sys.modules["essentia.standard"] = standard_module
    sys.modules.pop("flowstate_analyzer.features", None)
    try:
        import flowstate_analyzer.features as features

        yield features.middle_slice
    finally:
        sys.modules.pop("essentia", None)
        sys.modules.pop("essentia.standard", None)
        sys.modules.pop("flowstate_analyzer.features", None)


def test_shorter_than_window_returned_unchanged(middle_slice):
    audio = np.arange(1000, dtype=np.float32)
    sr = 100  # window = 20 * 100 = 2000 samples, longer than the audio
    out = middle_slice(audio, sr, 20)
    assert out is audio or np.array_equal(out, audio)
    assert len(out) == len(audio)


def test_longer_audio_yields_centered_window(middle_slice):
    sr = 100
    seconds = 2
    window = seconds * sr  # 200 samples
    total = 1000
    audio = np.arange(total, dtype=np.float32)  # ramp: value == index

    out = middle_slice(audio, sr, seconds)

    assert len(out) == window
    start = (total - window) // 2
    expected = audio[start : start + window]
    assert np.array_equal(out, expected)
    # Prove centering explicitly via the ramp's values.
    assert out[0] == start
    assert out[-1] == start + window - 1


def test_seconds_zero_is_noop(middle_slice):
    audio = np.arange(1000, dtype=np.float32)
    out = middle_slice(audio, 100, 0)
    assert out is audio or np.array_equal(out, audio)


def test_seconds_none_is_noop(middle_slice):
    audio = np.arange(1000, dtype=np.float32)
    out = middle_slice(audio, 100, None)
    assert out is audio or np.array_equal(out, audio)


def test_exact_length_audio_returned_unchanged(middle_slice):
    sr = 100
    seconds = 10
    audio = np.arange(seconds * sr, dtype=np.float32)  # exactly the window size
    out = middle_slice(audio, sr, seconds)
    assert len(out) == len(audio)
    assert np.array_equal(out, audio)
