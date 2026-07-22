# flowstate

A vibe-aware music player for your YouTube Music library. When a song plays, flowstate knows its mood and sound — and shuffle stops being random: it follows the vibe.

- **Lock mode** — stay tight on the current song's vibe
- **Drift mode** — each pick matches the previous song, so the mood evolves like a DJ set
- **Mood chips** — steer the shuffle: Happy, Chill, Aggressive, Dance, Acoustic, Party
- **"Doesn't fit" button** — tell it when a pick broke the vibe; it learns and adjusts
- Variety built in: weighted-random picks, never the same order twice
- Background playback, lock-screen controls, no ads

## Status: v0.2.0-alpha

**What works:** the full player + vibe engine on Android (sideload APK from [Releases](../../releases)).

**What this alpha still requires:** a `vibes.db` analysis file for your library, produced by the bundled analyzer (a Docker one-liner on any PC — see below). This requirement is temporary:

## Roadmap

- [x] Vibe engine: similarity shuffle, lock/drift, mood filters, feedback learning
- [x] Android player: streaming, background playback, playlists
- [ ] **In-app YouTube Music login** (no more cookie setup) — next release
- [ ] **On-device analysis** (ML models run on your phone; no PC ever) — the release after
- [ ] F-Droid listing

## Install (alpha)

1. Download `app-release.apk` from [Releases](../../releases), install it (allow "unknown sources" when prompted).
2. Analyze your library on any PC with Docker (one-time; a few seconds per song):
   ```bash
   git clone https://github.com/samarsingh-winit/flowstate && cd flowstate/analyzer
   # one-time auth: paste your YouTube Music browser headers
   python3 -m venv .venv && .venv/bin/pip install ytmusicapi && .venv/bin/ytmusicapi browser --file auth/browser.json
   docker build -t flowstate-analyzer .
   docker run --rm -v "$PWD/auth:/data-auth" -v "$PWD/out:/data" flowstate-analyzer \
     run --auth /data-auth/browser.json --db /data/vibes.db --models /models
   ```
3. Get `vibes.db` onto the phone: `python -m flowstate_analyzer serve --db out/vibes.db` on the PC, then in the app: Settings → Sync from PC over wifi (or copy the file any way you like and use Settings → Import).
4. Open a playlist, tap a song, vibe.

Re-running the analyzer only processes new songs — adding music later is cheap.

## How it works

The analyzer listens to each song once and produces a 200-dimensional sound "fingerprint" (MusiCNN embeddings) plus mood scores (essentia classifiers). The app measures similarity between fingerprints (cosine similarity) and picks the next song by weighted random sampling — closer vibes get better odds, recently-played songs get suppressed, and your "doesn't fit" feedback reshapes the weights over time (with decay, so taste changes are respected).

## Honest notes

- Unofficial YouTube APIs are involved (ytmusicapi, yt-dlp, youtubei.js). YouTube changes things occasionally; when streams break, a dependency bump usually fixes it. This is a free, open-source, sideload-only project — treat it accordingly.
- This alpha build has not yet completed full on-device verification (built and tested at the unit/build level). Bug reports welcome in Issues.
- Analysis downloads audio temporarily for feature extraction only; nothing is stored or redistributed.

## Development

- `analyzer/` — Python batch analyzer (also the future model-conversion dev tool). Tests: `PYTHONPATH=. .venv/bin/pytest tests/`
- `app/` — React Native Android app. Tests: `npx jest`; typecheck: `npx tsc --noEmit`
- Design docs and plans live in `docs/superpowers/`.
