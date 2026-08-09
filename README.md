# flowstate

A vibe-aware music player for your YouTube Music library. When a song plays, flowstate knows its mood and sound — and shuffle stops being random: it follows the vibe.

- **Vibe shuffle** — the next song is chosen by how it actually *sounds*, not by YouTube's recommendations
  - **Lock mode** — stay tight on the current song's vibe
  - **Drift mode** — each pick matches the previous song, so the mood evolves like a DJ set
  - **Mood chips** — steer the shuffle: Happy, Chill, Aggressive, Dance, Acoustic, Party
  - **"Doesn't fit" button** — tell it when a pick broke the vibe; it learns and adjusts
- **Song Radio mode** — endless YouTube song-radio seeded from any track
- **Likes → your real account** — ❤️ inserts into your actual Liked Music playlist (reversible) and feeds the vibe engine
- **Offline downloads** — download a playlist for offline play
- **Random play** — one tap starts a random song from a playlist
- **Solid background playback** — notification / lock-screen controls, gapless auto-advance, audio focus (auto-pause on calls), and reliable skipping from the notification even when the app is backgrounded
- On-device analysis — the ML runs on your phone, no PC/server; no ads

---

## 📖 For contributors & AI assistants — read [`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md)

This README is the user-facing intro. **[`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md) is the full technical
briefing** — architecture, every hard problem solved with root causes and fixes, the key-files map, dev/release
workflow, and known issues. If you're here to understand or extend the codebase (human or LLM), read that file
first; it's written to be self-contained.

---

## Status: v0.7.0-alpha

**What works:** everything, end-to-end, on your phone — login, library sync, on-device analysis, vibe shuffle,
song radio, real-account likes, offline downloads, and background playback/skipping. No PC, no Docker, no
cookie wrangling. Sideload the APK from [Releases](../../releases), log in, and the app takes it from there.

Alpha, personal/educational, Android only. Not on the Play Store. Not affiliated with YouTube/Google.

## Roadmap

- [x] Vibe engine: similarity shuffle, lock/drift, mood filters, feedback learning
- [x] Android player: streaming, background playback, playlists
- [x] In-app YouTube Music login (no cookie setup)
- [x] **On-device analysis** — ML runs on your phone; no PC ever
- [x] Song radio mode + real-account likes
- [x] Offline downloads
- [x] **Reliable background notification skip** (native HTTP resolution — see below)
- [ ] F-Droid listing

## Install

1. Download `flowstate-vX.apk` from [Releases](../../releases) and install it (allow "unknown sources" when
   prompted). arm64 build (~50–60MB) — fine for virtually every Android phone from the last several years.
2. Open the app and log in with your YouTube account (in-app device-flow login — no browser cookie copying).
3. Your library syncs automatically. Tap "Analyze playlist" (or just start playing songs — anything you play
   gets analyzed too) to build sound fingerprints for your tracks.
4. Once 10 songs in a playlist are analyzed, vibe shuffle unlocks for it. Keep listening/analyzing and it gets
   smarter as coverage grows.

Analysis runs as a background job on-device — expect roughly **30 seconds per song** the first time through a
playlist; after that everything's cached and shuffle is instant.

## How it works

### Vibe analysis (once per song, fully on your phone)

1. **Decode** — a native Kotlin decoder pulls PCM audio off a temporary stream (lowest-bitrate, range-bounded
   download — enough to analyze, not enough to trip YouTube's throttling).
2. **Mel spectrogram** — a Kotlin port of the MusiCNN mel front-end turns the PCM into the same time-frequency
   representation the model was trained on.
3. **TFLite inference** — mel patches run through on-device TFLite models (converted from MusiCNN) to produce a
   200-dimensional sound "fingerprint" (embedding) plus mood scores
   (happy/sad/relaxed/aggressive/danceable/acoustic/party).
4. **Vibe shuffle** — the app measures cosine similarity between fingerprints and picks the next song by
   weighted-random sampling: closer vibes get better odds, recently-played songs are suppressed, and your
   "doesn't fit" feedback reshapes the weights over time (with decay, so taste changes are respected).

The on-device models are parity-matched against the original Python/essentia reference pipeline (mel cosine
similarity ≥ 0.99 on golden fixtures) — same fingerprints, same schema, just computed on your phone.

### Playback & streaming

- **Stream resolution** turns a videoId into a playable URL via Innertube (`youtubei.js`), with an
  `ANDROID_VR → IOS` client fallback and forced-anonymous requests to dodge YouTube's Proof-of-Origin gating.
  Unplayable "– Topic" catalog tracks are recovered with a `title + artist + "lyrics"` **search fallback**.
- A custom playback controller keeps a **timeline model** with a 1-deep **native preload window** for gapless
  auto-advance, coalesced burst-skips, and an ahead-of-time **URL prefetch buffer**.
- **Background notification skip is done natively.** React Native's `fetch` freezes when the app is
  backgrounded on Android, so skips past the pre-buffer used to hang. flowstate resolves stream URLs through a
  **native OkHttp module** (its own threads, like ExoPlayer/Spotify), which keeps working in the background —
  device-verified for continuous background skipping. Full story in
  [`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md) §5.4.

## Honest notes

- Unofficial YouTube APIs are involved (device-flow auth, yt-dlp-style stream resolution, `youtubei.js`).
  YouTube changes things occasionally; when streams break, a dependency bump or a client-fallback tweak usually
  fixes it. Free, sideload-only, personal project — treat it accordingly.
- Hammering many resolves in a short window can trip temporary YouTube rate-limiting ("playback failed — check
  connection"); it's external and clears on its own.
- ~30s/song is real device time (mid-range Android), not a best-case benchmark. First-time bulk analysis is a
  background job — let it run.
- Analysis downloads audio temporarily for feature extraction only; nothing is stored or redistributed.
- Bug reports welcome in Issues.

## Development

- `app/` — React Native (0.86, New Architecture) Android app, including the on-device analysis pipeline
  (`src/analyze/`) and native Kotlin modules (`android/app/src/main/java/com/flowstate/`). Tests: `npx jest`
  (232 tests); typecheck: `npx tsc --noEmit`. Release build: `cd android && ./gradlew :app:assembleRelease`.
- `analyzer/` — the original Python/essentia batch analyzer. No longer needed to use the app (on-device
  analysis replaced it), kept as **dev tooling**: reference implementation for golden fixtures + TFLite parity,
  and a starting point if the models are ever retrained. Tests: `PYTHONPATH=. .venv/bin/pytest tests/`.
- Full architecture, subsystem details, and the debugging history: **[`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md)**.
- Design docs and plans: `docs/superpowers/`.
