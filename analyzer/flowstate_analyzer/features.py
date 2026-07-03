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

# Head model files; every head outputs [positive, negative] class probabilities,
# so index 0 is the score we keep.
MOOD_HEADS = {
    "happy": "mood_happy-msd-musicnn-1.pb",
    "sad": "mood_sad-msd-musicnn-1.pb",
    "relaxed": "mood_relaxed-msd-musicnn-1.pb",
    "aggressive": "mood_aggressive-msd-musicnn-1.pb",
    "danceable": "danceability-msd-musicnn-1.pb",
    "acoustic": "mood_acoustic-msd-musicnn-1.pb",
    "party": "mood_party-msd-musicnn-1.pb",
}


class Extractor:
    def __init__(self, models_dir: str | Path):
        d = Path(models_dir)
        self._embed = TensorflowPredictMusiCNN(
            graphFilename=str(d / EMBEDDING_MODEL), output="model/dense/BiasAdd"
        )
        self._heads = {
            name: TensorflowPredict2D(graphFilename=str(d / fn), output="model/Softmax")
            for name, fn in MOOD_HEADS.items()
        }

    def extract(self, audio_path: str | Path) -> Features:
        audio16 = MonoLoader(filename=str(audio_path), sampleRate=16000)()
        patches = self._embed(audio16)  # shape: (n_patches, 200)
        embedding = np.asarray(patches).mean(axis=0).astype(np.float32)

        moods = {}
        for name, head in self._heads.items():
            probs = np.asarray(head(patches))  # shape: (n_patches, 2)
            moods[name] = float(probs.mean(axis=0)[0])

        audio44 = MonoLoader(filename=str(audio_path), sampleRate=44100)()
        bpm = float(RhythmExtractor2013(method="multifeature")(audio44)[0])
        key, scale, _ = KeyExtractor()(audio44)
        energy = float(RMS()(audio44))

        return Features(
            embedding=embedding.tobytes(),
            moods=moods,
            bpm=bpm,
            energy=energy,
            key=f"{key} {scale}",
        )
