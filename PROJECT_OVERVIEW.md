# flowstate — Full Project Overview & Session Handoff

> Purpose of this file: a complete, self-contained briefing so another person (or another Claude instance)
> can understand **what flowstate is**, **how it's built**, **every hard problem that was solved**, and
> **how to talk about it in a portfolio** — without needing the original chat history.

---

## 1. Elevator pitch

**flowstate** is a personal Android music app that streams the developer's own **YouTube Music library**
and layers an on-device **"vibe shuffle"** on top: it analyzes each song's *actual audio* with a neural
network and builds mood-aware queues locally, instead of leaning on YouTube's server-side recommendations.

Mental model: *"my YouTube Music library + a local AI DJ that understands how songs actually sound."*

- **Repo:** https://github.com/SamarS1ngh/flowstate
- **Current release:** `v0.7.0-alpha` (versionCode 18)
- **Platform:** Android only (New Architecture). Primary dev device: a Motorola phone.
- **Status:** working alpha, personal-use, **not** on the Play Store. 232 passing unit tests.
- **Nature:** personal / educational project. Uses a **reverse-engineered YouTube API** (Innertube via
  `youtubei.js`). Not affiliated with or endorsed by YouTube/Google. Frame it as a personal project, never a
  commercial product.

---

## 2. Tech stack (with versions where known)

| Layer | Choice |
|---|---|
| App framework | **React Native 0.86**, **New Architecture** (TurboModules/Fabric interop), **TypeScript** |
| Playback | **react-native-track-player 4.1.2** → ExoPlayer **2.19.0** + KotlinAudio |
| YouTube API | **youtubei.js / Innertube 17.2.0** (unofficial) |
| Auth | **OAuth device-flow, TV client** token for the real account |
| On-device ML | **MusiCNN** (music-tagging CNN) → audio "vibe" embeddings, run locally |
| Storage | **SQLite** (`vibes.db`): library, audio features, user feedback |
| Native modules (Kotlin) | `AudioMelModule` (mel-spectrogram decode), `AnalysisServiceModule` (foreground service + Wi-Fi/wake locks + battery), `NativeHttpModule` (native OkHttp for resolution) |
| UI libs | react-native-svg, react-native-linear-gradient, gesture-handler, safe-area-context |
| Tests | **Jest** — 232 tests |
| Visual identity | Dark **HUD / Stark-JARVIS** aesthetic; neon purple `#c85cff`/`#c04dff` + white |

---

## 3. What the app does (feature list)

- **Library streaming** — playlists, Liked Music, "all songs", pulled from the user's real account.
- **Vibe Shuffle (headline feature)** — on-device MusiCNN analyzes each track's audio → embedding; a
  cosine-similarity engine builds a queue matching the current vibe. Includes:
  - **Mood chips**: happy / chill / aggressive / dance / acoustic / party.
  - **Lock ↔ Drift** dial: how tightly the queue sticks to the current vibe vs. wanders.
  - **Vibe mode On/Off** toggle (auto-on once a playlist has ≥10 analyzed songs).
- **Song Radio mode** — endless YouTube song-radio seeded from a tapped track. A separate, mutually
  exclusive mode from vibe (its own screen, no vibe chrome).
- **Likes → real account** — ❤️ inserts the song into the account's actual **Liked Music** playlist
  (`LIKED_PLAYLIST_ID = 'LM'`), reversible, and mirrors locally for the vibe engine. Already-liked songs show
  as liked. Like target is the album-art bottom-right (tap **and** double-tap).
- **Offline downloads** — per-playlist "Download for offline"; offline URLs are preferred at play time.
- **Random play** — button beside Play on each playlist; starts a random song (respects radio vs vibe mode).
- **Background library analysis** — analyzes the whole library while the screen is locked.
- **Persistent mini-player** across screens; full player screen with progress slider, transport, mood chips.
- **Media notification** — artwork, neon accent color, play/pause/next/prev/seek, lock-screen controls.
- **Audio focus** — auto-pause on phone calls / other apps grabbing audio; auto-resume on transient loss.

---

## 4. Architecture highlights

### 4.1 Playback controller (`src/player/controller.ts`)
A custom timeline navigation model built **on top of** track-player:

- `timeline: Song[]` — ordered sequence the user has navigated (played + skipped past).
- `pos` — index the user is *looking at* (moved optimistically during a burst of skips).
- `activePos` — index actually loaded and playing.
- `windowNextId` — the single next song **preloaded into ExoPlayer's own queue** for **gapless native
  auto-advance** (the fix that made locked-screen playback continue without a reset/gap).
- `reconcileActive()` — on `PlaybackActiveTrackChanged`, reconciles state to the **real** track by videoId,
  so the UI title can never disagree with the audio.
- **Serialized native ops** (`serialize()` / `opChain`) — native track-player calls run one at a time to avoid
  wedging the native player; **resolution runs OFF-chain** so a slow/hung resolve can't deadlock the queue.
- **Immediate commit for remote skips** — notification/media-button skips commit *now* (no `setTimeout`
  debounce, no pause-before-commit), because backgrounded timers are frozen (see §5.4).
- **Prefetch URL cache** (`src/player/prefetchCache.ts`) — resolves the next several songs' stream URLs ahead
  of time (`MAX_PREFETCH_DEPTH = 12`, `MAX_CACHED = 16`, one resolve at a time, LRU eviction). This is the
  buffer that lets backgrounded skips find a pre-resolved URL instead of hitting the network.
- **Bounded preload retry** — a failed next-song preload retries a few times with backoff, then stops, so a
  stuck preload can't hammer YouTube into rate-limiting the whole app.

### 4.2 Stream resolution (`src/stream/resolver.ts`)
Turning a videoId into a playable URL is the single hardest external problem. Details:

- YouTube withholds direct stream URLs from most clients (Proof-of-Origin / PoT gating) and ciphers others.
  The package's cipher evaluator is a stub that throws.
- **Client fallback order: `ANDROID_VR` → `IOS`.** These two return direct, un-ciphered URLs.
  - `ANDROID_VR` has **no GVS PoT cap** → its URL streams a complete file → tried first, and its validation GET
    is skipped (saves a round trip).
  - `IOS` is **capped to ~1 MiB without a PoT** → validated with an open-ended `Range: bytes=0-` GET that
    matches ExoPlayer's real request shape (a small bounded probe would false-positive).
- **Forced-anonymous requests** — `credentials: 'omit'` (RN-fetch path) / no cookie jar (native path). Reason:
  RN's Android networking attaches the process-wide `CookieManager` cookies to *every* request; once the user
  logs in, the resolver's "separate" Innertube instance would silently send authed cookies, tripping PoT
  gating. Anonymous resolves avoid this.
- **Search fallback** — a large class of failures is YouTube Music "– Topic" catalog entries that are
  UNPLAYABLE for every anonymous client. The same song usually exists under a different, playable id. So on
  failure, search `"{title} {artist} lyrics"` and use the first result that actually streams (bounded to a few
  probes). "lyrics" biases toward the accurate studio recording, not a cover/live/sped-up edit. A discovered
  good id is cached (`altIdCache`) for the session.
- **Prewarm** — Innertube session is warmed at app start (fire-and-forget) so the ~900ms bootstrap doesn't land
  on the first play. `retrieve_player:false` skips downloading YouTube's ~2MB player JS (~6× bootstrap speedup)
  since the mobile clients return pre-deciphered URLs.

### 4.3 Native OkHttp resolution (`NativeHttpModule.kt` + resolver shim) — v0.7.0 flagship
See §5.4 for the full story. In short: youtubei.js's `fetch` is routed through a **native OkHttp module** (its
own dispatcher threads) instead of RN's `fetch`, so resolution works while backgrounded. Includes a `readBody`
flag so the IOS validation probe doesn't download a whole media file. No cookie jar = anonymous by default.
Falls back to RN `fetch` when the native module is absent (Jest / non-Android).

### 4.4 On-device vibe engine
- `AudioMelModule.kt` (native) decodes audio → mel-spectrogram; a **parity harness**
  (`__tests__/melParityHarness.test.ts`) proves it matches the reference decoder.
- MusiCNN produces an embedding per song; a similarity module builds mood-aware queues (`VibeQueue`), with a
  `FeedbackStore` (thumbs / "doesn't fit" signals) influencing picks.
- `SimpleQueue` is the non-vibe fallback (plain playlist order) when a song isn't analyzed.
- `RadioQueue` drives song-radio mode via YouTube's radio feed.

### 4.5 Background analysis service
- Runs as a **HeadlessJS foreground service** (`AnalysisForegroundService` + `AnalysisServiceModule`), so it
  keeps processing with the screen off. Key insight: `onStartCommand` calls `startForeground()` synchronously,
  so reliability doesn't depend on JS timing.
- Holds a **Wi-Fi lock** (`WIFI_MODE_FULL_LOW_LATENCY`) + **partial wake lock** while working, and requests a
  **battery-optimization exemption** (App Standby otherwise throttles it to a crawl).
- Pauses on low battery when unplugged / when off Wi-Fi; a `BroadcastReceiver` emits battery + network events.
- The same Wi-Fi/wake-lock mechanism was later reused for **playback** (`playbackLocks.ts`).

---

## 5. The engineering problems solved this session (detailed)

This session spanned several releases (v0.6.0 → v0.7.0). Each below is a real problem, its root cause, and the fix.

### 5.1 Song Radio + real-account likes (v0.6.0)
- Probed what the TV-client OAuth token can actually read/write. **Verified on-device:** song-radio ✅, music
  feed ✅, like/unlike ✅; playlist writes are one-way/limited.
- Built song-radio "For You" seeded from a track. Likes push to the **real** Liked Music playlist (`'LM'`),
  reversible, and mirror locally. Already-liked detection (`isLikedSong`).
- **UI iteration on the like button** (many rounds): moved out of header → below slider → into transport →
  finally onto **album-art bottom-right** with tap **and** double-tap; made the pill fully opaque;
  "once liked, stay liked" (unlike disabled); insert into the existing Liked Music playlist (not a new one).

### 5.2 Playback reliability + speed + notification polish (v0.6.1)
- **Auto-advance dead-stop** — sometimes a finished song didn't advance. Fixed via the native preload window
  (`windowNextId`) so ExoPlayer advances natively.
- **Resolve speedup** — prewarm + `retrieve_player:false`; loading spinner while a track resolves.
- **Buffer tuning** — `playBuffer` 0.75s (was 2.5s) so sound starts fast on YouTube's ~1× throttled streams;
  `minBuffer` 15s keeps playback smooth.
- **Notification** — artwork + neon accent color + MediaStyle; mini-player restored on relaunch with progress.
- **Audio focus** — `autoHandleInterruptions: true`: pause on call/other-app audio, resume on transient loss.
- **No auto-jump on failure** — the old behavior churned through up to 5 songs (each a slow resolve) then
  errored anyway. Now it **stops on the failing song** and surfaces retry/skip; a failed song is the user's to
  skip, not the app's.

### 5.3 Mood/shuffle re-picks the NEXT song (v0.6.2)
- Changing mood or tapping shuffle now re-picks the **preloaded** next song (invalidates the window), instead
  of only affecting songs after the already-queued one.

### 5.4 ⭐ Background notification-tile skip — the flagship fix (v0.7.0)
**Symptom:** skipping from the notification tile with the app **backgrounded** worked for ~3–4 taps, then the
current song kept playing and skips did nothing.

**Investigation (multiple wrong turns corrected along the way):**
- Confirmed backgrounded JS `setTimeout` is **frozen** (so the skip debounce never fired) → switched remote
  skips to **immediate commit**.
- A **deadlock** where `preloadNext` did an *unserialized* native `TrackPlayer.add()` racing serialized
  reset/play → wedged the native player → skips jammed after 3–4. Fixed by serializing the native add.
- A slow/hung resolve inside the serialize chain deadlocked the queue → moved **resolution off-chain**.
- Held Wi-Fi + wake locks during playback (like analysis) — helped, but skips **still** stalled once the
  ~12-song prefetch buffer ran out.
- **Root cause, finally measured on-device:** a plain `fetch()` to a trivial Google endpoint **never returns
  when the app is backgrounded** on this phone. **React Native's `fetch`/XHR itself freezes in the
  background.** Meanwhile ExoPlayer keeps streaming (native networking) and RNFS downloads work (native). This
  is exactly why Spotify/YT Music work: they resolve over **native HTTP**.
  - Corrected an earlier wrong claim ("YT Music is a privileged Google app") after the user pointed out
    "Spotify does it too and it's not a Google app."
  - Corroborating evidence: background **analysis** already resolves fine with the screen locked — because it
    runs in a HeadlessJS task that keeps RN networking alive.

**Fix shipped:** `NativeHttpModule.kt` — OkHttp on its own dispatcher threads (via `enqueue`), which the OS
doesn't freeze; results cross back to JS via the normal bridge Promise (already proven to work backgrounded).
`resolver.ts`'s `anonymousFetch` routes youtubei.js through it. Details:
- Timeouts: connect 20s / read 30s / write 20s / call 45s; follows redirects.
- **No cookie jar** → `CookieJar.NO_COOKIES` → genuinely anonymous (also retires the CookieManager workaround).
- Strips caller `Accept-Encoding`/`Content-Length` so OkHttp does transparent gzip + correct length.
- `readBody` flag: the IOS `Range: bytes=0-` validation probe reads only the status, closing the body so it
  doesn't pull a whole media file.
- Response rebuilt as a whatwg `Response` (`status`, `headers`, `url`, `.text()/.json()`).
- Falls back to RN `fetch` under Jest / non-Android (tests unchanged).

**Verification:** device-tested by backgrounding the app and dispatching `media_session` skips (same path as
the notification tile). **Result: 20/20 background skips, each landing on a fresh PLAYING song**, well past the
old ~12 stall point; a 5-tap burst settled cleanly with no wedge. Before: ~3–4 then stall.

### 5.5 Random play button (v0.7.0)
- Button beside Play on each playlist. Picks a random song from the (visible) list and plays it exactly as if
  the user tapped that row — respects mode (radio seeds radio from it; vibe plays it into a vibe/simple queue).

### 5.6 Stale-session expiry (v0.7.0)
- **Problem:** `appKilledPlaybackBehavior: ContinuePlayback` keeps the track-player queue + media notification
  alive long after the app is swiped away / left idle, so relaunching hours later **resurrected the last
  (usually paused) song** in the mini-player.
- **Fix:** stamp the last time playback was actually active (module var + AsyncStorage
  `flowstate.player.lastActiveAt`). On app foreground (AppState) **and** cold start, if the session has been
  idle past `STALE_SESSION_MS = 2h` **and** isn't currently playing, `clearSession()` resets track-player,
  clears state, drops the notification, and empties the mini-player. A live/long listen is never disturbed.

### 5.7 Shuffle icon → crisp vector (v0.7.0)
- The icon set is Unicode glyphs (`src/ui/Icon.tsx`). The old shuffle glyph `⇄` didn't read as "shuffle," and
  the emoji `🔀` can't be tinted (renders fixed orange). Added `src/ui/ShuffleGlyph.tsx` — a monochrome
  **react-native-svg** shuffle (classic crossing-arrows). White on the playlist button, state-tinted (neon /
  dimmed) in the player transport. `CircleButton`/`IconButton` gained an optional `children` prop to render a
  custom icon node. (react-native-svg was already a dependency, autolinked — no new install.)

---

## 6. Key files map

```
app/
  src/
    App.tsx                       # bootstrap, player setup, AppState stale-session hook, mini-player shell
    player/
      controller.ts               # timeline model, skips, preload window, stale-session, markActivity
      prefetchCache.ts            # ahead-of-time URL resolution buffer (depth 12, LRU 16)
      playbackLocks.ts            # Wi-Fi + wake locks held during playback
      service.ts                  # track-player remote event handlers (RemoteNext/Prev/PlaybackError)
      queue.ts                    # SimpleQueue + QueueSource interface
    stream/
      resolver.ts                 # Innertube stream resolution, native-fetch shim, client fallback, search fallback
    engine/
      vibeQueue.ts, similarity.ts, radioQueue.ts, feedbackStore.ts, accountLikes.ts
    analyze/
      analyzer.ts, analyzable.ts  # MusiCNN batch/lazy analysis, HeadlessJS batch controller
    offline/downloads.ts          # offline download batch + offlineUrl()
    screens/
      PlaylistScreen.tsx          # play + random buttons, mode selector, analyze/download, song list
      PlayerScreen.tsx            # full player: art, mood chips, transport, progress, like
      RadioScreen.tsx             # song-radio mode screen
    ui/
      Icon.tsx, ShuffleGlyph.tsx, CircleButton.tsx, IconButton.tsx, MiniPlayer.tsx, theme.ts, ...
    db/vibesDb.ts                 # SQLite access
  android/app/src/main/java/com/flowstate/
    AudioMelModule.kt             # mel-spectrogram decode (native)
    AnalysisServiceModule.kt      # analysis foreground service, Wi-Fi/wake/battery, playback locks
    NativeHttpModule.kt           # native OkHttp resolution (v0.7.0)
    AudioMelPackage.kt            # ReactPackage registering the three native modules
  __tests__/                      # 232 Jest tests (controller, prefetchCache, resolver, similarity, melParity, ...)
```

---

## 7. Testing & verification

- **232 Jest tests** across 22 suites. Notable:
  - `controller.test.ts` — hung-resolve regression, immediate-skip, invalidateWindow, queue-ends-mid-preload.
  - `prefetchCache.test.ts` — never-resolve-twice, single-flight coalescing, bounded LRU eviction.
  - `resolver.test.ts` — pins `credentials: 'omit'` anonymity behavior.
  - `melParityHarness.test.ts` — native mel-spectrogram matches the reference decoder.
- **On-device verification** for playback/skip behavior via `adb` + `dumpsys media_session` (state + metadata)
  and screenshots. The background-skip fix was verified by backgrounding the app and dispatching skips through
  the media session (identical path to the notification tile), not by testing in-app.

---

## 8. Dev & release workflow (as practiced this session)

- **Wireless adb** was set up after USB kept dropping: `adb tcpip 5555` then `adb connect <phone-ip>:5555`.
- **Installs use release-signed builds** (`./gradlew :app:assembleRelease`) so they update in place **without
  wiping app data** (login, library, analysis, downloads). A debug build has a different signature and would
  force an uninstall (data loss). Release builds also bundle JS, so background tests don't depend on Metro.
- **Releases:** bump `versionCode`/`versionName` in `android/app/build.gradle` → commit → tag `vX` → push →
  `gh release create vX <apk>#flowstate-vX.apk --title ... --notes ...`. Prior releases attach the APK named
  `flowstate-vX.apk`.
- **Commit convention:** co-author trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Standing constraints from the developer:** be honest about what works vs. doesn't; no fake/placeholder
  buttons; commit/push/release **only** when explicitly asked.

---

## 9. Release history (this project's recent tags)

| Version | Theme |
|---|---|
| v0.5.2-alpha | HUD redesign + playback overhaul |
| v0.5.6-alpha | Background analysis + playback fixes |
| v0.6.0-alpha | Song radio + real-account likes |
| v0.6.1-alpha | Playback reliability, faster loads, notification art, audio focus |
| v0.6.2-alpha | Mood/shuffle re-picks the next song |
| **v0.7.0-alpha** | **Background notification skip via native HTTP + random play + stale-session expiry + vector shuffle icon** |

---

## 10. Known issues / caveats (be honest in any write-up)

- **Transient YouTube rate-limiting.** Hammering many stream resolves in a short window (e.g. rapid automated
  skip testing) can make YouTube temporarily return unplayable/empty formats → "playback failed — check
  connection." It's external and clears on its own; it is **not** a code bug and affects any build.
- **Unofficial API.** Innertube is reverse-engineered; YouTube changes can break resolution. The client
  fallback + search fallback are defensive but not future-proof.
- **Alpha, single-device.** Tuned/verified mainly on one Motorola phone; OEM background behavior varies.
- **Some catalog tracks are genuinely unplayable** anonymously and rely on the search fallback; a few may still
  fail.
- **Personal project.** No account system, no server, single user. Not a commercial product; no YouTube
  affiliation.

---

## 11. Portfolio angles (for whoever writes the piece)

- **Breadth in one person:** native Android (Kotlin), React Native/TypeScript, on-device neural inference, and
  unofficial-API stream resolution — full stack from ExoPlayer internals to a HUD UI.
- **Debugging depth as the standout story:** the background-skip fix — a measured, non-obvious root cause (RN's
  networking is frozen in the background while native networking isn't) fixed by dropping to native OkHttp,
  which is how Spotify/YT Music actually work. Great "systematic debugging beats guessing" narrative.
- **On-device ML with rigor:** a parity harness proving the native mel-spectrogram matches the reference — not
  just "ran a model," but validated its inputs.
- **Product taste:** distinctive HUD identity; thoughtful playback UX (lock/drift, radio vs vibe modes,
  gapless native auto-advance, no auto-jump on failure).
- **Honesty framing:** describe as a **personal/educational** project built on a reverse-engineered API; do
  not imply YouTube affiliation or present it as a shipping commercial app.

---

*Generated as a handoff summary of the development session that produced v0.7.0-alpha. Repo:
https://github.com/SamarS1ngh/flowstate*
