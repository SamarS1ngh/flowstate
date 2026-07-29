#!/usr/bin/env python3
"""Bakes `mel_reference.mel_filterbank()` into a raw binary asset for the
on-device (Kotlin) mel port (Plan D Task 5).

Rather than re-deriving the Slaney-mel-warping + triangular-filter math a
second time in Kotlin (and risking a subtle rounding/indexing mismatch vs.
the validated `mel_reference.py`), the native `MelPipeline.kt` loads this
asset directly and only re-implements framing/windowing/FFT/log -- the parts
that must run on->device anyway.

Usage (from analyzer/, needs numpy):
    python3 scripts/dump_mel_filterbank.py

Writes (little-endian float32, row-major, shape (96, 257)):
    ../app/android/app/src/main/assets/musicnn_mel_filterbank_96x257_f32le.bin
and a copy for JVM unit tests (com.flowstate.audiomel.MelPipelineTest):
    ../app/android/app/src/test/resources/musicnn_mel_filterbank_96x257_f32le.bin
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mel_reference import mel_filterbank  # noqa: E402

ASSET_NAME = "musicnn_mel_filterbank_96x257_f32le.bin"


def main() -> None:
    fb = mel_filterbank().astype("<f4")  # (96, 257)
    app_dir = Path(__file__).resolve().parent.parent.parent / "app" / "android" / "app" / "src"
    targets = [
        app_dir / "main" / "assets" / ASSET_NAME,
        app_dir / "test" / "resources" / ASSET_NAME,
    ]
    for path in targets:
        path.parent.mkdir(parents=True, exist_ok=True)
        fb.tofile(path)
        print(f"wrote {path} ({fb.nbytes} bytes, shape {fb.shape})")


if __name__ == "__main__":
    main()
