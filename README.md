# flowstate

A vibe-aware music player for your YouTube Music library. When a song plays, flowstate knows its mood and sound — and shuffle stops being random: it follows the vibe.

- **Lock mode** — stay tight on the current song's vibe
- **Drift mode** — each pick matches the previous song, so the mood evolves like a DJ set
- **Mood chips** — steer the shuffle: Happy, Chill, Aggressive, Dance, Acoustic, Party
- **"Doesn't fit" button** — tell it when a pick broke the vibe; it learns and adjusts
- Variety built in: weighted-random picks, never the same order twice
- Background playback, lock-screen controls, no ads

## Status: v0.3.0-alpha

**What works:** everything, end-to-end, on your phone — login, library sync, analysis, and vibe shuffle. No PC, no Docker, no cookie wrangling. Sideload the APK from [Releases](../../releases), log in, and the app takes it from there.

## Roadmap

- [x] Vibe engine: similarity shuffle, lock/drift, mood filters, feedback learning
- [x] Android player: streaming, background playback, playlists
- [x] In-app YouTube Music login (no more cookie setup)
- [x] **On-device analysis** — ML models run on your phone; no PC ever
- [ ] F-Droid listing

## Install

1. Download `app-release.apk` from [Releases](../../releases) and install it (allow "unknown sources" when prompted). It's an arm64 build (~50-60MB) — fine for virtually every Android phone from the last several years.
2. Open the app and log in with your YouTube account (in-app device-flow login — no browser cookie copying).
3. Your library syncs automatically. Tap "Analyze playlist" (or just start playing songs — anything you play gets analyzed too) to build up sound fingerprints for your tracks.
4. Once 10 songs in a playlist are analyzed, vibe shuffle unlocks for it. Keep listening/analyzing and it gets smarter as coverage grows.

That's the whole setup. Analysis runs as a background job on-device — expect roughly **30 seconds per song** the first time through a playlist; after that, everything's cached and shuffle is instant.

## How it works

Each song is analyzed once, fully on your phone:

1. **Decode** — a native Kotlin decoder pulls PCM audio straight off a temporary stream (lowest-bitrate, range-bounded download — enough to analyze, not enough to trip YouTube's throttling).
2. **Mel spectrogram** — a Kotlin port of the MusiCNN mel front-end turns the PCM into the same time-frequency representation the model was trained on.
3. **TFLite inference** — the mel patches run through on-device TFLite models (converted from MusiCNN) to produce a 200-dimensional sound "fingerprint" (embedding) plus mood scores (happy/sad/relaxed/aggressive/danceable/acoustic/party).
4. **Vibe shuffle** — the app measures similarity between fingerprints (cosine similarity) and picks the next song by weighted random sampling: closer vibes get better odds, recently-played songs get suppressed, and your "doesn't fit" feedback reshapes the weights over time (with decay, so taste changes are respected).

The on-device models are parity-matched against the original Python/essentia reference pipeline (mel cosine similarity ≥ 0.99 on golden fixtures) — same fingerprints, same schema, just computed on your phone instead of a server.

## Honest notes

- Unofficial YouTube APIs are involved (ytmusicapi-style auth, yt-dlp-style stream resolution, youtubei.js). YouTube changes things occasionally; when streams break, a dependency bump usually fixes it. This is a free, open-source, sideload-only project — treat it accordingly.
- ~30s/song is real device time (tested on a mid-range Android phone), not a benchmark best-case. Bulk-analyzing a big playlist for the first time is a background job — let it run, don't wait on it.
- Analysis downloads audio temporarily for feature extraction only; nothing is stored or redistributed.
- Bug reports welcome in Issues.

## Development

- `app/` — React Native Android app, including the on-device analysis pipeline (`src/analyze/`). Tests: `npx jest`; typecheck: `npx tsc --noEmit`.
- `analyzer/` — the original Python/essentia batch analyzer. It's no longer needed to use the app — on-device analysis replaced it — but it's kept around as **dev tooling**: the reference implementation used to generate golden fixtures and verify parity for the TFLite models, and a starting point if the mood/embedding models are ever retrained. Tests: `PYTHONPATH=. .venv/bin/pytest tests/`.
- Design docs and plans live in `docs/superpowers/`.
