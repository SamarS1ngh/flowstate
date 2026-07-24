# flowstate Plan D: On-Device Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The phone analyzes songs itself — decode audio → mel-spectrogram → TFLite MusiCNN → 200-d embedding + 7 mood scores → SQLite `features` — so vibe shuffle works with no PC. Analysis output must match the essentia (Mac analyzer) reference within cosine ≥ 0.99 on embeddings.

**Architecture:** Staged to de-risk the hard part (mel-spectrogram parity) BEFORE app integration. Phase 1 (offline dev-tools): convert models to TFLite + generate golden fixtures + prove a portable mel implementation matches essentia. Phase 2 (app): native Kotlin decode→PCM, mel (validated recipe), react-native-fast-tflite inference, features write, scheduling. Reuses the existing analyzer (v1) purely as the parity oracle.

**Tech Stack:** Phase 1: Python (TF/tflite converter, essentia for fixtures), numpy. Phase 2: RN 0.86, Kotlin (MediaCodec, native mel module OR JS mel), react-native-fast-tflite, existing db/engine.

## Global Constraints

- **Parity gate (BLOCKING):** on a fixed set of ≥10 golden audio clips, the phone/JS pipeline's 200-d embedding must have cosine ≥ 0.99 vs the essentia embedding stored by the v1 analyzer for the same clip. Mood scores within ±0.1. If unmet after real effort, STOP and escalate — do NOT ship degraded analysis silently.
- Mel recipe MUST match essentia `TensorflowInputMusiCNN`: 16 kHz mono, frame 512, hop 256, Hann window, magnitude spectrum, 96 mel bands, essentia's mel filterbank + log compression. Confirm exact params from essentia source / model metadata; the recipe is the crux — document every constant with its essentia source.
- Embedding stored as float32[200] little-endian BLOB, mood columns exactly mood_happy/sad/relaxed/aggressive/danceable/acoustic/party, model_version stamped in features + meta — SAME schema as v1 (analyzer/flowstate_analyzer/db.py) so imports/engine already work.
- Per-head positive-class index mapping carried from v1 (sad/relaxed/party = index 1) — verified by v1's polarity test.
- Analysis analyzes middle 120 s (segment), matching v1's middle_slice.
- Device: Moto G64 adb ZA222KMKWQ. Reference vibes.db + models on Mac at analyzer/ (models baked in the Docker image / analyzer/models after download_models.sh).
- Every phase gate: `npx tsc --noEmit && npx jest` (app) / `pytest` (analyzer) green.

## Phase 1 — Offline de-risking (dev tools, no app changes)

### Task 1: Convert MusiCNN + mood heads to TFLite
**Files:** `analyzer/scripts/convert_tflite.py`, output `analyzer/models_tflite/*.tflite`
- Load the essentia MusiCNN embedding frozen graph (msd-musicnn-1.pb) + 7 head .pb; identify input tensor (mel patches [N,187,96] or similar — confirm shape from model metadata JSON) and output tensors (embedding `model/dense/BiasAdd`; heads `model/Softmax`).
- Convert to TFLite (TF1 frozen_graph → TFLiteConverter.from_frozen_graph with named input/output; or via concrete function). Handle dynamic patch dim (fixed batch or resizable input).
- Verify: run the SAME mel input through both the .pb (essentia/TF) and the .tflite; outputs must match ~1e-4. Emit a report of tensor shapes + a fixed test vector.
- Commit `feat(analyzer): TFLite conversion of MusiCNN embedding and mood heads`.

### Task 2: Golden fixtures + reference mel dump
**Files:** `analyzer/scripts/gen_fixtures.py`, output `analyzer/fixtures/{clip}.json` (+ small wav clips or their videoIds)
- Pick ≥10 clips spanning genres from the user's analyzed library (query vibes.db for videoIds with features; re-fetch middle-120s audio via existing fetch, or reuse cached).
- For each: dump (a) the essentia mel-spectrogram array (the exact input essentia feeds the model — via essentia TensorflowInputMusiCNN), (b) the essentia 200-d embedding, (c) the 7 mood scores. Store as JSON (+ raw PCM or wav for the pipeline under test to consume).
- These are the parity oracle. Commit `test(analyzer): golden fixtures for on-device parity`.

### Task 3: Portable mel implementation + PARITY GATE
**Files:** `analyzer/scripts/mel_reference.py` (pure-numpy mel matching essentia, no essentia dep) + `analyzer/tests/test_mel_parity.py`
- Implement the mel-spectrogram in pure numpy from documented essentia params (framing, Hann, FFT magnitude, mel filterbank, log). This is the algorithm the Kotlin/JS on-device code will mirror — proving it in numpy first de-risks cheaply.
- Test: pure-numpy mel vs essentia mel (from fixtures) — per-bin close (correlation ≥ 0.99). Then feed the pure-numpy mel through the TFLite model → embedding; compare to essentia embedding: **cosine ≥ 0.99** (THE GATE). Mood scores ±0.1.
- Iterate the mel params until the gate passes (filterbank normalization, log offset, dc/nyquist handling are the usual mismatch culprits). If unreachable, STOP + escalate with the closest achieved cosine + diagnosis.
- Commit `test(analyzer): mel parity harness meeting cosine>=0.99 gate`.

**PHASE 1 EXIT:** parity gate green. Only then proceed to Phase 2. The pure-numpy `mel_reference.py` is the spec the native/JS mel must reproduce.

## Phase 2 — App integration (only after Phase 1 gate passes)

### Task 4: Bundle TFLite + react-native-fast-tflite inference
**Files:** `app/src/analyze/tflite.ts`, model assets in app, deps
- Add `react-native-fast-tflite` (verify New Arch build). Bundle the .tflite models (android assets).
- `runModel(melPatches: Float32Array[]): {embedding: Float32Array; moods: Record<string,number>}` — load models once, run embedding + heads, mean-pool patches, apply per-head positive index. Unit-test the pooling/index logic with a fake model output.
- Commit.

### Task 5: Native decode + mel (Kotlin) matching the validated recipe
**Files:** `app/android/.../AudioMel.kt` (native module), `app/src/analyze/audio.ts` bridge
- Kotlin: MediaCodec decode cached m4a → PCM float mono 16 kHz, middle 120 s; compute mel EXACTLY per `mel_reference.py` (port the validated numpy recipe to Kotlin: framing 512/256, Hann, FFT (e.g. a known Kotlin FFT), mel filterbank constants shipped as an asset generated from mel_reference.py, log). Output mel patches to JS.
- **On-device parity check:** run the SAME fixture clips through the Kotlin mel → TFLite → embedding on the phone; compare to golden essentia embeddings. cosine ≥ 0.99 REQUIRED (re-uses fixtures; ship a dev-only screen or test harness to run it). If the Kotlin port drifts from the numpy reference, fix until it matches.
- Commit.

### Task 6: Analyzer service — decode→mel→infer→store, scheduling
**Files:** `app/src/analyze/analyzer.ts`, wire into player/library
- `analyzeSong(videoId)`: resolve+download audio (reuse resolver/anonymous fetch) → Kotlin mel → TFLite → Features → db.storeFeatures (add a writer mirroring v1 schema incl. model_version) → delete audio.
- Scheduling: lazy (on play, background), prefetch (next candidates), batch ("Analyze playlist" → foreground service + progress notification, resumable). Update the Playlist "N analyzed" live; enable Vibe shuffle when ≥ threshold analyzed.
- Device-verify: analyze a real playlist on the phone, confirm features rows written, vibe shuffle becomes enabled and produces vibe-matched picks; spot-check a few songs' mood scores are sane. Commit.

### Task 7: Release + README
- Bump version, assembleRelease, install, device smoke, push, `gh release create` (on-device analysis = the "no PC needed" milestone — README setup shrinks to install→login→listen). Tag.

## After this plan
flowstate is fully self-contained: install → login → your library syncs → songs analyze on-device → vibe shuffle. The Mac analyzer remains only as the parity oracle for future model updates.
