#!/usr/bin/env python3
"""Build device-pushable fixtures for the Plan D Task 5 on-device parity harness.

For each `analyzer/fixtures/<clip>.json` (essentia golden oracle) + matching
`analyzer/fixtures/wav/<clip>.wav` (regenerate with
`gen_fixtures.py --generate` if missing), emit into `--out-dir`:
  - `<clip>.f32`   -- raw little-endian float32 PCM samples in [-1, 1]
    (mono, 16kHz), i.e. exactly what MonoLoader/essentia fed the mel
    extractor for that clip.
  - `manifest.json` -- one entry per clip: pcm filename, sample count,
    essentia's embedding (base64 float32[200], copied verbatim from the
    fixture json), and mood scores. This is what the app's dev harness
    (`app/src/analyze/melParityHarness.ts`) reads to know what its own
    Kotlin-mel -> TFLite pipeline's output should match.

Usage:
    python3 scripts/make_device_fixtures.py [--out-dir device_fixtures]

Then push the output directory to a DEBUG (debuggable) build's private
storage:
    adb push device_fixtures /data/local/tmp/flowstate_fixtures
    adb shell run-as com.flowstate sh -c \\
      'mkdir -p files/flowstate_fixtures && \\
       cp -r /data/local/tmp/flowstate_fixtures/* files/flowstate_fixtures/'
    adb shell rm -rf /data/local/tmp/flowstate_fixtures
"""
from __future__ import annotations

import argparse
import json
import wave
from pathlib import Path

import numpy as np

ANALYZER_DIR = Path(__file__).resolve().parent.parent
FIXTURES_DIR = ANALYZER_DIR / "fixtures"
WAV_DIR = FIXTURES_DIR / "wav"


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        n = w.getnframes()
        data = w.readframes(n)
    return (np.frombuffer(data, dtype="<i2").astype(np.float64) / 32768.0).astype(np.float32)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out-dir", default=str(ANALYZER_DIR / "device_fixtures"), help="Output directory")
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    fixture_paths = sorted(FIXTURES_DIR.glob("*.json"))
    if not fixture_paths:
        raise SystemExit(f"no fixtures found in {FIXTURES_DIR} -- run gen_fixtures.py --generate/--dump first")

    manifest = []
    for fx_path in fixture_paths:
        fx = json.loads(fx_path.read_text())
        clip = fx["clip"]
        wav_path = WAV_DIR / f"{clip}.wav"
        if not wav_path.exists():
            raise SystemExit(f"missing {wav_path} -- run `gen_fixtures.py --generate` first")
        pcm = read_wav(wav_path)
        pcm_filename = f"{clip}.f32"
        pcm.astype("<f4").tofile(out_dir / pcm_filename)
        manifest.append(
            {
                "clip": clip,
                "pcmFile": pcm_filename,
                "nSamples": int(len(pcm)),
                "embeddingB64": fx["embedding"]["b64"],
                "moods": fx["moods"],
            }
        )
        print(f"{clip}: {len(pcm)} samples -> {pcm_filename}")

    (out_dir / "manifest.json").write_text(json.dumps({"fixtures": manifest}, indent=2))
    print(f"wrote manifest with {len(manifest)} fixtures to {out_dir / 'manifest.json'}")


if __name__ == "__main__":
    main()
