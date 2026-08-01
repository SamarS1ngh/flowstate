#!/usr/bin/env python3
"""Real-song end-to-end essentia reference embeddings (Plan D follow-up:
real-song decode+resample parity gate).

The existing golden-fixture pipeline (gen_fixtures.py / test_mel_parity.py)
proves [mel -> model] parity by injecting already-16kHz-mono PCM directly --
it never exercises essentia's own MonoLoader decode+resample step, so it
can't catch a bug in the device's MediaCodec-decode + LINEAR-resample
front-end (android/app/src/main/java/com/flowstate/audiomel/AudioDecoder.kt).

This script closes that gap on the essentia side: given a directory of real
downloaded audio files (m4a/webm/whatever a real yt-dlp/youtubei.js download
produced -- same files the phone would download), it runs the exact same
embedding recipe as `flowstate_analyzer.features.Extractor.extract` --
`MonoLoader(sampleRate=16000)` (essentia's own decode+resample, our "ground
truth" front-end) -> `middle_slice(.., 16000, 120)` ->
`TensorflowPredictMusiCNN(output="model/dense/BiasAdd")` -> mean-pool -- and
dumps each file's 200-d reference embedding to JSON. The on-device probe
(app/src/analyze/melParityHarness.ts's runRealSongPathParityProbe, run via a
__DEV__-gated Settings screen button) runs the SAME local file through the
production phone pipeline (AudioDecoder.decodeToMonoPcm16k -> MiddleSlice ->
MelPipeline -> TFLite embedding); comparing the two via cosine similarity
measures the decode+resample front-end's real-world fidelity, not just the
mel/model math the fixture gate already covers.

MUST run inside the flowstate-analyzer Docker image (models baked at
/models), same as gen_fixtures.py --dump:

    docker run --rm -v /path/to/audio:/audio:ro -v /path/to/out:/out \
      flowstate-analyzer:latest \
      python3 scripts/real_song_reference.py --models-dir /models \
      --audio-dir /audio --out /out/reference_embeddings.json <file1> <file2> ...

Output JSON: {"<stem-of-file>": {"embedding_b64": "...", "shape": [200],
"num_patches": N}} or {"error": "..."} per entry on failure.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from flowstate_analyzer.features import EMBEDDING_MODEL, middle_slice  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models-dir", required=True)
    parser.add_argument("--audio-dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--segment-s", type=int, default=120)
    parser.add_argument("files", nargs="+", help="audio filenames within --audio-dir")
    args = parser.parse_args()

    from essentia.standard import MonoLoader, TensorflowPredictMusiCNN  # noqa: PLC0415

    models_dir = Path(args.models_dir)
    audio_dir = Path(args.audio_dir)
    embed = TensorflowPredictMusiCNN(
        graphFilename=str(models_dir / EMBEDDING_MODEL), output="model/dense/BiasAdd"
    )

    results: dict[str, dict] = {}
    for fn in args.files:
        path = audio_dir / fn
        key = Path(fn).stem
        try:
            audio = MonoLoader(filename=str(path), sampleRate=16000)()
            audio = middle_slice(audio, 16000, args.segment_s)
            patches = np.asarray(embed(audio))
            embedding = patches.mean(axis=0).astype(np.float32)
            results[key] = {
                "embedding_b64": base64.b64encode(embedding.tobytes()).decode("ascii"),
                "shape": list(embedding.shape),
                "num_patches": int(patches.shape[0]),
            }
            print(f"{key}: OK ({patches.shape[0]} patches)")
        except Exception as e:  # noqa: BLE001
            print(f"{key}: FAILED {e}")
            results[key] = {"error": str(e)}

    Path(args.out).write_text(json.dumps(results, indent=2))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
