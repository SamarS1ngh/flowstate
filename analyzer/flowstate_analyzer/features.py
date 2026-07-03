from __future__ import annotations

from pathlib import Path

import numpy as np
from essentia.standard import (
    KeyExtractor,
    MonoLoader,
    RMS,
    RhythmExtractor2013,
    TensorflowPredict2D,
    TensorflowPredictMusiCNN,
)

from .db import Features

EMBEDDING_MODEL = "msd-musicnn-1.pb"


def middle_slice(audio: np.ndarray, sample_rate: int, seconds: int | None) -> np.ndarray:
    """Return the centered `seconds`-long slice of `audio` at `sample_rate`.

    Returns `audio` unchanged when `seconds` is None/<=0, or when `audio` is
    not longer than `seconds * sample_rate` samples (nothing to trim).
    """
    if not seconds or seconds <= 0:
        return audio
    window = int(seconds * sample_rate)
    if len(audio) <= window:
        return audio
    start = (len(audio) - window) // 2
    return audio[start : start + window]


# Head model files. Each head is a binary softmax classifier, but the essentia
# metadata JSON (https://essentia.upf.edu/models/classification-heads/<head>/
# <head>-msd-musicnn-1.json, "classes" field) shows the positive-class index is
# NOT consistent across heads:
#   mood_happy:      ["happy", "non_happy"]          -> index 0
#   mood_sad:        ["non_sad", "sad"]              -> index 1
#   mood_relaxed:    ["non_relaxed", "relaxed"]      -> index 1
#   mood_aggressive: ["aggressive", "not_aggressive"]-> index 0
#   mood_acoustic:   ["acoustic", "non_acoustic"]    -> index 0
#   mood_party:      ["non_party", "party"]          -> index 1
#   danceability:    ["danceable", "not_danceable"]  -> index 0
# so each entry below is (filename, positive_class_index).
MOOD_HEADS = {
    "happy": ("mood_happy-msd-musicnn-1.pb", 0),
    "sad": ("mood_sad-msd-musicnn-1.pb", 1),
    "relaxed": ("mood_relaxed-msd-musicnn-1.pb", 1),
    "aggressive": ("mood_aggressive-msd-musicnn-1.pb", 0),
    "danceable": ("danceability-msd-musicnn-1.pb", 0),
    "acoustic": ("mood_acoustic-msd-musicnn-1.pb", 0),
    "party": ("mood_party-msd-musicnn-1.pb", 1),
}


class Extractor:
    def __init__(self, models_dir: str | Path, segment_s: int | None = 120):
        d = Path(models_dir)
        self._segment_s = segment_s
        self._embed = TensorflowPredictMusiCNN(
            graphFilename=str(d / EMBEDDING_MODEL), output="model/dense/BiasAdd"
        )
        self._heads = {
            name: (
                TensorflowPredict2D(graphFilename=str(d / fn), output="model/Softmax"),
                positive_index,
            )
            for name, (fn, positive_index) in MOOD_HEADS.items()
        }

    def extract(self, audio_path: str | Path) -> Features:
        audio16 = MonoLoader(filename=str(audio_path), sampleRate=16000)()
        audio16 = middle_slice(audio16, 16000, self._segment_s)
        patches = self._embed(audio16)  # shape: (n_patches, 200)
        embedding = np.asarray(patches).mean(axis=0).astype(np.float32)

        moods = {}
        for name, (head, positive_index) in self._heads.items():
            probs = np.asarray(head(patches))  # shape: (n_patches, 2)
            moods[name] = float(probs.mean(axis=0)[positive_index])

        audio44 = MonoLoader(filename=str(audio_path), sampleRate=44100)()
        audio44 = middle_slice(audio44, 44100, self._segment_s)
        bpm = float(RhythmExtractor2013(method="degara")(audio44)[0])
        key, scale, _ = KeyExtractor()(audio44)
        energy = float(RMS()(audio44))

        return Features(
            embedding=embedding.tobytes(),
            moods=moods,
            bpm=bpm,
            energy=energy,
            key=f"{key} {scale}",
        )
