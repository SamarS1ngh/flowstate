# flowstate — Design

**Date:** 2026-07-03
**Status:** Approved for planning

## What

A personal, free, mood/vibe-aware shuffle player for a YouTube Music library. When a song plays, the app knows its vibe (mood, energy, sound signature) and queues only songs that fit — either locked to the current vibe or drifting gradually like a DJ set.

## Goals

- Zero cost: no paid APIs, no cloud hosting, no subscriptions.
- Phone-first: standalone Android app; no server needed for day-to-day listening.
- Real audio understanding: vibe comes from analyzing the sound itself, not just titles/genres.
- Library scale: 500–5,000 songs.

## Non-goals (v1)

- iOS, web player, desktop player.
- Offline playback (songs stream from YouTube; only the vibe database is local).
- LLM/lyrics-based tagging.
- Multi-user support.

## Architecture

Two components:

```
┌─────────────────────────┐        vibes.db         ┌──────────────────────────┐
│ Analyzer (any PC, batch)│ ──── (wifi/USB/Drive) ──▶│ flowstate Android app    │
│ Python, run occasionally│                          │ standalone player        │
└─────────────────────────┘                          └──────────────────────────┘
```

The analyzer is **not a server**. It is a batch script run occasionally (initially once, then whenever new songs are added). The PC can be off at all other times.

### Component 1: Analyzer (Python, Docker-packaged)

Runs on any PC (macOS/Linux native; Windows via WSL2 or Docker). Docker image is the recommended distribution so it runs identically everywhere.

Pipeline per run:

1. **Library sync** — `ytmusicapi` (unofficial YouTube Music API) pulls the user's library and playlists. One-time auth via browser cookies.
2. **Diff** — compare against `vibes.db`; only new/unanalyzed songs proceed.
3. **Audio fetch** — `yt-dlp` downloads audio to a temp file (deleted after analysis).
4. **Feature extraction** per song:
   - **Embedding vector** (~200–512 dims) — the "sound fingerprint" used for similarity. Default: MusiCNN embeddings via essentia-tensorflow (one runtime for embeddings + mood models). Fallback if quality disappoints on the test playlist: CLAP.
   - **Mood scores** via Essentia pre-trained classifiers: happy, sad, relaxed, aggressive, danceable, acoustic, party (each 0–1).
   - **Basics** via librosa/essentia: tempo (BPM), energy, key.
5. **Store** — everything into a single SQLite file `vibes.db` (~10–20 MB for 5k songs), including song metadata (videoId, title, artist, duration, playlist membership).

Throughput: ~5–30 sec/song depending on hardware. Full 5k-song library = overnight once; incremental runs = minutes.

Transfer to phone: any file path works — USB cable, Google Drive, or a tiny optional `--serve` flag that exposes `vibes.db` over local wifi for the app's "Sync" button.

### Component 2: Android app

- **Framework:** React Native.
- **Playback:** `react-native-track-player` — background audio, lock-screen and notification controls, headphone/Bluetooth buttons.
- **Streaming:** `youtubei.js` (open-source Innertube client, same approach as yt-dlp) resolves a fresh audio stream URL at play time, in-app. No downloads, no server.
- **Data:** imports `vibes.db` (file picker or wifi sync), loads vectors into memory.
- **Vibe engine** (plain TypeScript, milliseconds for 5k songs):
  - Cosine similarity over embedding vectors.
  - **Lock mode:** queue restricted to songs within a tight similarity radius of the seed song.
  - **Drift mode:** each next song is picked near the *previously played* song, so the vibe evolves gradually across a session.
  - Mode is a user toggle.
  - **Recently-played penalty:** songs played in the last N tracks are down-weighted to prevent tight loops.
  - **Mood chips:** optional filter layer (Happy / Chill / Aggressive / Dance / Acoustic / Party) applied on top of similarity, driven by the essentia mood scores.
- **UI screens:** library + playlists list, now-playing (with lock/drift toggle and mood chips), queue view, settings (DB sync/import).

## Data flow (listening session)

1. User picks a song (or hits shuffle on a playlist).
2. App resolves stream URL via youtubei.js, starts playback.
3. Vibe engine computes candidate set (similarity radius + mood-chip filter + recency penalty) and fills the queue.
4. On track change: drift mode re-centers on the song just played; lock mode keeps the original seed.

## Error handling

- **Stream resolution fails** (expired URL, extraction hiccup): retry once with fresh extraction, then skip to next queued song and surface a toast.
- **YouTube changes break youtubei.js:** app shows an explicit "stream extraction failed — update needed" state rather than failing silently; fix is a dependency bump.
- **Song not in vibes.db** (not yet analyzed): playable manually, excluded from vibe-shuffle candidates.
- **DB import errors:** validate schema version on import; reject with a clear message instead of half-loading.

## Testing

- **Analyzer:** run against a 10-song test playlist; sanity-check mood scores and embeddings (similar songs should have high cosine similarity). Unit tests for diff/incremental logic.
- **Vibe engine:** unit tests with synthetic vectors — lock radius, drift chaining, recency penalty, mood filtering.
- **App:** manual test checklist — background playback survives screen-off, lock-screen controls work, queue behaves in both modes, DB import/sync works.

## Risks / maintenance reality

- ytmusicapi, yt-dlp, and youtubei.js are unofficial. YouTube changes occasionally break them; fixes are usually upstream within days. This is a hobby-project trade-off accepted in exchange for $0 cost.
- Personal-use only; downloading audio for analysis sits in YouTube ToS grey area.

## Milestones

1. **M1 — Analyzer core:** sync + fetch + features + `vibes.db` on a 10-song playlist.
2. **M2 — Vibe engine:** similarity/queue logic as a pure TS module with tests.
3. **M3 — App skeleton:** RN app, DB import, library UI, plain playback via youtubei.js + track-player.
4. **M4 — Vibe shuffle:** wire engine into queue, lock/drift toggle, mood chips.
5. **M5 — Polish:** wifi sync, recency tuning, error states, full-library run.
