#!/usr/bin/env python3
"""Pure-numpy reimplementation of essentia's `TensorflowInputMusiCNN` +
`TensorflowPredictMusiCNN` framing/patching, with NO essentia dependency.

This is the parity-gate deliverable for Plan D Task 3: the exact recipe the
native/JS on-device mel code (Phase 2) must port. Every constant below is
sourced directly from the essentia C++ source (fetched from
github.com/MTG/essentia at commit b9fa6cb), not from guesswork or from
librosa -- see the docstring on each function for the exact source file.

Pipeline (mirrors `essentia::standard::TensorflowInputMusiCNN::compute()` +
the framing/patching done by `TensorflowPredictMusiCNN`):

  audio (16kHz mono)
    -> FrameCutter-equivalent framing: frameSize=512, hopSize=256,
       zero-centered (startFromZero=False), zero-padded at the edges
    -> per frame: Hann window (unnormalized) -> magnitude spectrum (rfft)
       -> essentia MelBands (96 bands, Slaney mel warping, linear
          triangular weighting, unit_tri/"unit_sum-of-theoretical-area"
          normalization, power type i.e. squared magnitude bins)
       -> shift by *10000 + 1 -> log10  == log10(1 + 10000*mel)
    -> stack frames into 187-frame patches, hop 93 (50% overlap),
       discard any incomplete trailing patch (essentia's default
       patchHopSize=93 / patchSize=187 / lastPatchMode="discard")

Sources (fetched 2026-07-24 from github.com/MTG/essentia @ b9fa6cb):
  - src/algorithms/spectral/tensorflowinputmusicnn.cpp   (frame->mel recipe,
    hardcoded constants: frameSize=512, numberBands=96, sampleRate=16000,
    warpingFormula="slaneyMel", weighting="linear", normalize="unit_tri",
    shift=1, scale=10000, comp="log10", windowing normalized=False)
  - src/algorithms/machinelearning/tensorflowpredictmusicnn.cpp (FrameCutter
    frameSize=512/hopSize=256; default patchHopSize=93, patchSize=187,
    lastPatchMode="discard" from tensorflowpredictmusicnn.h)
  - src/algorithms/spectral/melbands.cpp (mel-scale filter edge calculation)
  - src/algorithms/spectral/triangularbands.cpp (exact per-bin triangular
    filter weight + "unit_tri" normalization: divide by the THEORETICAL
    triangle area (fstep1+fstep2)/2, not the actual summed bin weights --
    "similar to how normalization is implemented in Librosa")
  - src/essentia/essentiamath.h (hz2melSlaney / mel2hzSlaney -- Slaney's
    Auditory Toolbox formula: linear below 1kHz, log above)
  - src/algorithms/standard/windowing.cpp (Hann: 0.5 - 0.5*cos(2*pi*i/(N-1)),
    zeroPhase=True by default -- but zeroPhase is a circular shift of the
    windowed frame and does NOT change the magnitude spectrum, so it is
    safely omitted here)
  - src/algorithms/standard/framecutter.cpp (startFromZero=False: first
    frame's center is sample 0, i.e. zero-pad frameSize/2 samples of
    silence at the very start; a frame is the last one once its center
    reaches/passes the end of the buffer)
"""
from __future__ import annotations

import numpy as np

FRAME_SIZE = 512
HOP_SIZE = 256
N_MELS = 96
SAMPLE_RATE = 16000.0
PATCH_SIZE = 187
PATCH_HOP = 93
LOG_SHIFT = 1.0
LOG_SCALE = 10000.0


# ---------------------------------------------------------------------------
# Slaney mel warping (essentia src/essentia/essentiamath.h: hz2melSlaney /
# mel2hzSlaney -- MATLAB Auditory Toolbox formula). Linear below 1 kHz,
# logarithmic above.
# ---------------------------------------------------------------------------
_MIN_LOG_HZ = 1000.0
_LIN_SLOPE = 3.0 / 200.0  # 0.015
_MIN_LOG_MEL = _MIN_LOG_HZ * _LIN_SLOPE  # 15.0
_LOG_STEP = np.log(6.4) / 27.0


def hz2mel_slaney(hz: np.ndarray | float) -> np.ndarray:
    hz = np.asarray(hz, dtype=np.float64)
    mel = hz * _LIN_SLOPE
    log_region = hz >= _MIN_LOG_HZ
    mel = np.where(
        log_region,
        _MIN_LOG_MEL + np.log(np.maximum(hz, 1e-12) / _MIN_LOG_HZ) / _LOG_STEP,
        mel,
    )
    return mel


def mel2hz_slaney(mel: np.ndarray | float) -> np.ndarray:
    mel = np.asarray(mel, dtype=np.float64)
    hz = mel / _LIN_SLOPE
    log_region = mel >= _MIN_LOG_MEL
    hz = np.where(
        log_region,
        _MIN_LOG_HZ * np.exp((mel - _MIN_LOG_MEL) * _LOG_STEP),
        hz,
    )
    return hz


# ---------------------------------------------------------------------------
# Mel filterbank: essentia MelBands.calculateFilterFrequencies() +
# TriangularBands.createFilters(), reproduced exactly (NOT via librosa,
# which does not guarantee identical rounding/edge behavior).
# ---------------------------------------------------------------------------
def mel_filterbank(
    n_fft: int = FRAME_SIZE,
    n_mels: int = N_MELS,
    sample_rate: float = SAMPLE_RATE,
    low_freq: float = 0.0,
    high_freq: float | None = None,
) -> np.ndarray:
    """Returns filterbank of shape (n_mels, n_fft//2 + 1)."""
    if high_freq is None:
        high_freq = sample_rate / 2.0
    n_bins = n_fft // 2 + 1

    # MelBands::calculateFilterFrequencies: n_mels+2 edge points, linearly
    # spaced in Slaney-mel scale between hz2mel(low) and hz2mel(high), then
    # converted back to Hz.
    low_mel = hz2mel_slaney(low_freq)
    high_mel = hz2mel_slaney(high_freq)
    mel_increment = (high_mel - low_mel) / (n_mels + 1)
    mel_points = low_mel + mel_increment * np.arange(n_mels + 2)
    band_freqs = mel2hz_slaney(mel_points)  # (n_mels+2,) in Hz

    # TriangularBands::createFilters: weighting="linear" -> the interpolation
    # is linear in Hz (not mel-warped); only the band EDGES are mel-spaced.
    freq_scale = (sample_rate / 2.0) / (n_bins - 1)  # Hz per spectrum bin
    bin_freqs = np.arange(n_bins) * freq_scale

    fb = np.zeros((n_mels, n_bins), dtype=np.float64)
    for i in range(n_mels):
        f0, f1, f2 = band_freqs[i], band_freqs[i + 1], band_freqs[i + 2]
        fstep1 = f1 - f0
        fstep2 = f2 - f1

        jbegin = int(np.ceil(f0 / freq_scale))
        jend = int(np.floor(f2 / freq_scale))
        jbegin = max(jbegin, 0)
        jend = min(jend, n_bins - 1)

        for j in range(jbegin, jend + 1):
            bf = bin_freqs[j]
            if bf < f1:
                fb[i, j] = (bf - f0) / fstep1
            else:
                fb[i, j] = (f2 - bf) / fstep2

        # normalize == "unit_tri": divide by the THEORETICAL triangle area
        # (fstep1+fstep2)/2, not the actual summed bin weights (this is the
        # detail essentia's own comment calls out as "similar to ... Librosa").
        weight = (fstep1 + fstep2) / 2.0
        fb[i, jbegin : jend + 1] /= weight

    return fb


_FILTERBANK = mel_filterbank()


# ---------------------------------------------------------------------------
# Framing: essentia FrameCutter equivalent (frameSize=512, hopSize=256,
# startFromZero=False -- zero-centered, zero-padded at both edges).
# ---------------------------------------------------------------------------
def frame_signal(audio: np.ndarray, frame_size: int = FRAME_SIZE, hop_size: int = HOP_SIZE) -> np.ndarray:
    """Zero-centered framing matching essentia FrameCutter(startFromZero=False).

    First frame is centered on sample 0 (i.e. covers samples
    [-frame_size/2, frame_size/2)), zero-padded for indices outside the
    buffer. A frame is the last one once its center (start + frame_size/2)
    reaches or passes the end of the buffer (this frame IS included,
    zero-padded as needed); subsequent calls would return nothing.
    """
    n = len(audio)
    start = -((frame_size + 1) // 2)  # C++ integer division of -(size+1)/2, truncation toward zero
    frames = []
    while True:
        # FrameCutter::compute(): bails with NO frame once _startIndex itself
        # is past the end of the buffer.
        if start >= n:
            break
        center = start + frame_size // 2
        frame = np.zeros(frame_size, dtype=np.float64)
        lo = max(start, 0)
        hi = min(start + frame_size, n)
        if hi > lo:
            frame[lo - start : hi - start] = audio[lo:hi]
        frames.append(frame)
        # This IS the last frame once its center reaches/passes the end of
        # the buffer (essentia still emits it, zero-padded) -- but no more
        # frames after it.
        if center >= n:
            break
        start += hop_size
    return np.asarray(frames, dtype=np.float64)


# ---------------------------------------------------------------------------
# Hann window (essentia Windowing: normalized=False, symmetric=True):
# w[i] = 0.5 - 0.5*cos(2*pi*i/(N-1)). zeroPhase=True (essentia default) is a
# circular shift of the windowed frame before FFT and does not change the
# magnitude spectrum, so it's omitted here (we only need |FFT|).
# ---------------------------------------------------------------------------
def _hann_window(size: int) -> np.ndarray:
    i = np.arange(size)
    return 0.5 - 0.5 * np.cos(2.0 * np.pi * i / (size - 1))


_WINDOW = _hann_window(FRAME_SIZE)


def frames_to_mel(frames: np.ndarray) -> np.ndarray:
    """frames: (n_frames, 512) -> mel bands (n_frames, 96), essentia recipe.

    magnitude spectrum (Spectrum: |rfft|, NOT power) -> MelBands with
    type="power" (squares magnitude bins internally, see
    TriangularBands::compute) -> shift*scale+1 -> log10.
    """
    windowed = frames * _WINDOW[np.newaxis, :]
    spectrum = np.abs(np.fft.rfft(windowed, n=FRAME_SIZE, axis=-1))  # (n_frames, 257)
    power = spectrum**2
    mel = power @ _FILTERBANK.T  # (n_frames, 96)
    shifted = mel * LOG_SCALE + LOG_SHIFT
    return np.log10(np.maximum(shifted, 1e-30)).astype(np.float32)


def audio_to_mel(audio: np.ndarray) -> np.ndarray:
    """Full mel pipeline: raw 16kHz mono audio -> (n_frames, 96) mel bands."""
    frames = frame_signal(np.asarray(audio, dtype=np.float64))
    return frames_to_mel(frames)


def mel_to_patches(mel: np.ndarray, patch_size: int = PATCH_SIZE, patch_hop: int = PATCH_HOP) -> np.ndarray:
    """(n_frames, 96) mel -> (n_patches, patch_size, 96), lastPatchMode="discard"."""
    n_frames = mel.shape[0]
    if n_frames < patch_size:
        return np.zeros((0, patch_size, mel.shape[1]), dtype=mel.dtype)
    starts = range(0, n_frames - patch_size + 1, patch_hop)
    patches = np.stack([mel[s : s + patch_size] for s in starts], axis=0)
    return patches


def audio_to_patches(audio: np.ndarray) -> np.ndarray:
    """Convenience: raw audio -> (n_patches, 187, 96) ready for the TFLite model."""
    return mel_to_patches(audio_to_mel(audio))
