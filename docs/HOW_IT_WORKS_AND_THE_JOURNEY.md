# flowstate — How It Works & The Journey to Release

This document explains **what we built**, **how the "vibe" system actually works**
(including the honest answer to "does the model learn?"), and **every major error
we had to fight through** to ship on-device analysis in `v0.3.0-alpha`.

---

## 1. What we built

flowstate is a music app that plays your YouTube Music library and offers **"vibe
shuffle"** — instead of random shuffle, it queues songs that *sound* like whatever
you're currently playing. The signature feature: **it figures out what songs sound
like entirely on your phone**, with no PC, no server, no cloud analysis.

The end-to-end flow a user sees:

```
install APK → log in with YouTube → library syncs → tap "Analyze playlist"
(or just play songs) → vibe shuffle unlocks once 10 songs are analyzed
```

Under the hood there are seven moving parts:

| Part | Job |
|------|-----|
| **Auth** (`src/auth`) | OAuth device-flow login (the "smart TV" flow), no password typing |
| **Sync** (`src/library`) | Pulls your playlists + tracks from YouTube's TV browse surface into SQLite |
| **Resolver** (`src/stream`) | Turns a videoId into a playable/downloadable audio URL |
| **Player** (`src/player`) | Playback, mini-player, the rich full-screen player with seek + gestures |
| **Analyzer** (`src/analyze`) | **The on-device brain**: audio → "fingerprint" |
| **Engine** (`src/engine`) | Turns fingerprints into a vibe-matched queue + learns from feedback |
| **DB** (`src/db`) | SQLite: songs, playlists, and `features` (the fingerprints) |

---

## 2. How the analysis works (the "model")

Analysis produces, for each song, a **fingerprint**: a 200-number vector (the
"embedding") plus 7 mood scores. That's what "vibe" is built on.

### The pipeline, per song

```
resolve stream URL → download audio → decode to 16kHz mono PCM
    → mel-spectrogram → MusiCNN (TFLite) → 200-d embedding
    → 7 mood-head models → {happy, sad, relaxed, aggressive, acoustic, party, danceable}
    → write one row into the `features` table → delete the audio
```

### The model itself: MusiCNN

- **MusiCNN** is a convolutional neural network trained on the Million Song
  Dataset (by the MTG / essentia project). It takes a **mel-spectrogram** — a
  "picture of sound" (time on one axis, 96 frequency bands on the other) — and
  outputs a 200-dimensional embedding that captures timbre/genre/texture.
- On top of the embedding sit **7 tiny "head" models**, one per mood, each a
  binary classifier (e.g. *happy* vs *not-happy*) producing a 0–1 score.
- We converted these from their original TensorFlow frozen-graph form to
  **TFLite** so they run on the phone via `react-native-fast-tflite`.

### The mel-spectrogram is the hard part

The neural net only gives good results if you feed it *exactly* the same
"picture of sound" it was trained on. essentia computes the mel-spectrogram with
a very specific recipe (frame size 512, hop 256, Hann window, 96 mel bands, a
particular filterbank + log compression). We had to reproduce that recipe **bit-
for-bit in Kotlin** on the phone. To prove it, we built a **parity gate**: run
the same audio through essentia (on a Mac, in Docker) and through our phone
pipeline, and require the two embeddings to match with **cosine similarity ≥ 0.99**.
They matched at **1.000000** across all 12 test clips. That gate is what made
on-device analysis trustworthy — the Mac analyzer now exists *only* as this
reference oracle, not as something a user ever runs.

---

## 3. Does the model learn / evolve? (the honest answer)

**The neural network does NOT learn.** MusiCNN is **pre-trained and frozen**. It
never trains on your device, never updates its weights, and produces the *same*
embedding for the same audio forever. When people say "AI that learns your
taste," this part is not that — it's a fixed feature extractor.

**But the app does adapt to you**, in a layer *on top of* the frozen embeddings:

### a) The vibe queue (`src/engine/vibeQueue.ts`, `similarity.ts`)

Given the song you're playing (the "center"), it builds a pool of candidates and
scores each one:

```
weight = similarity⁴ × recency × feedbackBias
```

- **similarity** = cosine distance between the two songs' embeddings (how much
  they "sound alike"). Raised to the 4th power so only genuinely-close songs
  dominate.
- **recency** = down-weights songs you heard in the last ~25 tracks, so it
  doesn't loop.
- **feedbackBias** = your thumbs-down history (below).

The next song is sampled from that weighted pool. Mood chips ("Chill",
"Aggressive"…) add a filter on the mood scores.

### b) The feedback layer — this is what "evolves" (`src/engine/weights.ts`, `feedbackStore.ts`)

When you hit **"Doesn't fit"** in the player, it records a *(from-song → rejected-
song)* pair. That reshapes future queues three ways:

1. **Exact pair penalty** — that specific song is strongly suppressed after that
   specific kind of song (`0.1^hits`).
2. **Global penalty** — a song you reject repeatedly gets suppressed everywhere
   (`0.5^hits`).
3. **Generalization** — and this is the clever part: a *new* candidate that is
   **very similar** (cosine > 0.9) to something you've rejected, played from a
   context **similar** to where you rejected it, also gets down-weighted. So
   rejecting one song teaches it to avoid *songs like it* in *situations like
   that* — without you rating every track.

4. **Forgetting / evolving** — all feedback **decays with a 30-day half-life**.
   Old dislikes fade, so as your taste drifts, the system drifts with it.

So the honest framing: **fixed ears, adaptive taste.** The model's *perception*
of sound is constant; the app's *preferences* about which perceptions to string
together are personal, feedback-driven, and time-decaying. It also "evolves" in
the trivial sense that coverage grows — the more songs analyzed, the richer the
candidate pools and the better the matches.

---

## 4. The errors we fought through

The path to release was mostly debugging. In rough order:

### Mel-spectrogram parity (the research risk)
The whole feature was gated on reproducing essentia's mel-spectrogram exactly.
Getting the filterbank normalization, log offset, and framing to match to cosine
≥ 0.99 was the make-or-break step. Solved in a pure-numpy reference first, then
ported 1:1 to Kotlin — and re-verified on the actual phone.

### The Mac disk filled mid-build
During a native build the Mac ran out of disk (Gradle caches ballooned). Blind
`rm` of caches freed space; the build finished cold (~11 min). Recovered without
data loss.

### Player gesture bug
The rich player's horizontal swipe-to-change-track didn't fire — two competing
`Gesture.Pan()` in a `Gesture.Race()` lost to real touch input. Replaced with a
single pan that picks its dominant axis per frame. Seek slider + pull-to-dismiss
worked; swipe needed this fix.

### The big one: analysis silently produced **zero** results
This is the error that mattered most, and it hid for a long time because of a
chain of smaller problems:

1. **"Verified" that wasn't.** Earlier sessions marked the TFLite/inference tasks
   "device-verified," but they never actually exercised the real path on a phone.
   The feature *looked* done and was completely broken.

2. **Models never loaded.** `require('./model.tflite')` bundled the models as
   Android *raw resources* whose only runtime handle is a bare name with no URL
   scheme. `react-native-fast-tflite` fed that into `new URL(...)` and threw
   `MalformedURLException: no protocol`. Every single song failed at model-load.
   → **Fix:** ship the models as real Android *assets*, copy them to the
   filesystem once at startup, and load them via a proper `file://` URL.

3. **Failures were invisible.** Release builds strip `console.warn`, so the
   failures produced no logs. The progress bar advanced anyway (the batch counts
   each song "done" even on failure), so it *looked* like slow progress when it
   was actually 100% failure. We only saw the truth by building a **debug**
   build and reading `logcat`.

4. **The debug build lied too.** Debug loads JS from the Metro dev server over
   `adb reverse`. When Metro was restarted, the tunnel went stale and the phone
   kept running an **old cached JS bundle** — so code edits appeared to have no
   effect. Lesson: **release builds bundle JS deterministically; use a release
   build to actually verify JS changes.** Debug is for logs, not for trusting
   *which* code is running.

5. **YouTube throttled the download.** With models finally loading, songs then
   failed at *download* — every one hit the 60-second timeout. Cause:
   googlevideo serves a plain open-ended GET at **~playback speed** (a 4-minute
   song takes ~4 minutes to download), so it never finished in time. *This* was
   the real "why is analysis so slow." → **Fix:** request the **smallest**
   audio-only format (analysis downsamples to 16 kHz mono anyway, so quality is
   irrelevant) with a **bounded `Range` header** (`bytes=0-12582911`), which the
   CDN delivers in one fast burst instead of throttling. Result: **~30 s/song.**

### Performance
Before those fixes, decode ran over the *entire* track then threw most of it
away, and the PCM buffer was needlessly base64-round-tripped across the JS↔native
bridge. Fixed by seeking to the middle and bounding the decode, and keeping PCM
native — roughly 3× faster.

### Release hygiene
The final packaging pass caught a stray `debuggable true` on release builds
(shouldn't ship), and slimmed the APK from **~140 MB → ~49 MB** by shipping only
the `arm64-v8a` native libraries instead of four architectures.

---

## 5. Where it landed

`v0.3.0-alpha` — on-device analysis, no PC required.

- ~30 s/song; vibe shuffle unlocks at 10 analyzed songs; each song analyzed once,
  then cached.
- Verified live on a real phone: the analyzed count climbs, vibe shuffle enables,
  and playing it opens a real vibe session driven by on-device fingerprints.
- Honest limits: bulk-analyzing a whole large playlist is still a long background
  job (~30 s × number of songs); it's designed around "10 unlocks it, the rest
  fills in gradually."

**The through-line lesson:** *a feature isn't done because the code compiles and
the tests pass — it's done when you've watched it work on the actual device.*
Most of this release was the distance between "looks finished" and "actually runs."
