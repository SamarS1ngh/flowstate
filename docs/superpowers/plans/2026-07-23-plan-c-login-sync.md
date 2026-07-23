# flowstate Plan C: In-App Login + On-Device Library Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** User logs into YouTube Music inside the app (WebView); the app syncs their playlists/library itself and plays login-gated songs — no PC cookie setup, no vibes.db import required for library structure (analysis data still comes from the analyzer until Plan D).

**Architecture:** A WebView login screen captures cookies via Android CookieManager after the user signs in. An auth store keeps the cookie header + rotates SAPISIDHASH. youtubei.js Session is created with those credentials (cookie + on-the-fly Authorization header), giving authenticated `getBasicInfo` (login-gated playback) and authenticated Innertube `browse` calls for library/playlist listing (music.youtube.com Innertube API, WEB_REMIX client). Synced structure is written to the SAME local SQLite the app already reads (songs/playlists/playlist_songs), preserving any imported `features` rows by videoId. The v1 wifi-import path stays as the way to get `features` (analysis) until Plan D.

**Tech Stack:** existing app stack + react-native-webview.

## Global Constraints

- Cookies never leave the device; stored via AsyncStorage (@react-native-async-storage/async-storage) under key `flowstate.auth.v1`. Logout clears storage AND CookieManager.
- The resolver contract stays: `resolveStreamUrl(videoId) -> Promise<{url, headers}>` — internals may add auth. Client order stays ANDROID_VR-first (works without PoToken); authenticated fallback path added after it for gated content.
- Library sync writes schema the screens already query: `songs(video_id, title, artist, duration_s)`, `playlists(playlist_id, name)`, `playlist_songs(playlist_id, video_id, position)`. Never deletes/overwrites `features` rows. Sync = full replace of playlists/playlist_songs + upsert of songs (mirrors analyzer semantics).
- vibes.db may not exist pre-login (fresh user): the db layer must create the base schema (schema_version "2" meta) when opening for sync with no imported file. Wifi-import of an analyzer vibes.db must MERGE features into the existing db (not replace the whole file) when app-synced library data exists. Simplification allowed: import copies features + marks songs analyzed, taking analyzer file as source of truth for features only.
- All pure logic (cookie parsing, SAPISIDHASH computation, Innertube response parsing) TDD'd in jest. WebView/native flows device-verified (phone available: Moto G64 adb ZA222KMKWQ, USB).
- `npx tsc --noEmit && npx jest` green every task; device verification per task where stated.
- Work from `app/`.

## File Structure

```
app/src/auth/
  authStore.ts        # cookie persistence, SAPISIDHASH(origin, sapisid, ts), auth header assembly (pure parts exported)
  LoginScreen.tsx     # WebView music.youtube.com; detects login success; harvests cookies via CookieManager
app/src/library/
  syncClient.ts       # authenticated Innertube (WEB_REMIX): fetch playlists + tracks; pure parsers exported
  syncToDb.ts         # write parsed library into SQLite (upsert songs, replace playlists) preserving features
app/src/db/vibesDb.ts # + ensureBaseSchema(), mergeFeaturesFrom(importedPath) adjustments
app/__tests__/auth.test.ts, syncParse.test.ts, syncToDb.test.ts (pure parts)
```

## Tasks (compressed — implementer briefs carry the full detail)

### Task 1: Auth store + SAPISIDHASH (pure TS, TDD)
`authStore.ts`: `parseCookieString`, `sapisidHash(sapisid, origin, nowMs)` (SHA-1 via js-sha1 or expo-crypto-free impl — pick a zero-native pure-JS sha1 dep or inline implementation, TDD against known vectors), `buildAuthHeaders(cookieHeader, nowMs)` → {cookie, authorization: `SAPISIDHASH ${ts}_${hash}`, 'x-origin': 'https://music.youtube.com'}; AsyncStorage save/load/clear. Commit: `feat(app): auth store with SAPISIDHASH generation`.

### Task 2: Login screen (WebView) + device verification
`react-native-webview` + LoginScreen: load music.youtube.com; on navigation events check CookieManager for `SAPISID` presence on .youtube.com → success → persist via authStore → navigate to Library. Settings gains Login/Logout row showing state. Manifest/gradle as needed. Device-verify: real login on the Moto (controller drives adb; USER TYPES CREDENTIALS THEMSELVES — pause and hand the phone to the user for the actual credential entry, automated taps only for non-credential navigation). Commit: `feat(app): in-app YouTube Music login via WebView`.

### Task 3: Authenticated library sync (Innertube WEB_REMIX)
`syncClient.ts`: Innertube.create with cookie (youtubei.js supports `cookie` option) + WEB_REMIX-style browse for library playlists (youtubei.js has `ytmusic` namespace — use `yt.music.getLibrary()` / `getPlaylist()` APIs of installed 17.2.0; verify surface, adapt, pure-parse results to {songs, playlists}). `syncToDb.ts`: write to SQLite per Global Constraints. `vibesDb.ts`: `ensureBaseSchema()` for fresh users. Library screen: "Sync library" action + auto-sync on first login; import path relabeled "Import analysis (vibes.db)" and now merges features only. TDD parsers against captured fixture JSON (capture real response once via Node with the user's existing analyzer cookies — sanitize before committing fixture). Commit: `feat(app): on-device authenticated library sync`.

### Task 4: Authenticated playback fallback for gated songs
`resolver.ts`: after anonymous ANDROID_VR/IOS attempts fail, if auth present: authenticated Innertube session attempt (TV_EMBEDDED or WEB_REMIX client with cookie + SAPISIDHASH — whichever yields playable URLs; validate with ranged GET like existing code). Keep contract. Device-verify with one of the 7 known login-gated videoIds from the analyzer's error list (query analyzer/out/vibes.db songs WHERE analyze_error NOT NULL for ids). Commit: `feat(app): authenticated stream fallback for login-gated songs`.

### Task 5: End-to-end device pass + release v0.3.0-alpha
Fresh-install flow on device: login → auto-sync (playlists appear WITHOUT any import) → wifi-import analysis file → vibe shuffle works → gated song plays. Fix-forward anything found. Bump versionCode 4 / 0.3.0-alpha, assembleRelease, install on Moto, push, `gh release create v0.3.0-alpha` with notes, README update (setup section shrinks: install → login → sync; analyzer only needed for vibe analysis until Plan D). Commit + tag.
