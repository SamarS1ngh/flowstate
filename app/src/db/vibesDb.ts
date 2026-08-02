import {open, DB} from '@op-engineering/op-sqlite';
// ADAPTATION: the brief specifies `react-native-fs`, but that package is
// unmaintained and does not support React Native's New Architecture, which
// this app has enabled (android/gradle.properties: newArchEnabled=true).
// We use the maintained fork `@dr.pogodin/react-native-fs` instead, which
// ships explicit New Architecture support. Its API is function-based (named
// exports only, no default export), so imports use `import * as RNFS`
// rather than `import RNFS from ...`. Function/constant names
// (DocumentDirectoryPath, copyFile, unlink, exists) are unchanged from
// react-native-fs, so the rest of the brief's logic is preserved as written.
import * as RNFS from '@dr.pogodin/react-native-fs';
import {Playlist, Song} from '../types';
import {VibeSong} from '../engine/similarity';
import {embeddingFromBlob} from './blob';

export const DB_FILENAME = 'vibes.db';

// Schema version written into a *freshly created* app db (no import ever
// happened -- e.g. a logged-in user who has only ever synced, never
// imported an analyzer vibes.db). Deliberately distinct from the analyzer's
// own SCHEMA_VERSION ("1", checked in importVibesDb below against the
// *candidate* file being imported) -- these two version markers describe
// different things and are not meant to compare equal.
const APP_SCHEMA_VERSION = '2';

// Mirrors analyzer/flowstate_analyzer/db.py's _SCHEMA exactly (column-for-
// column) so an attached analyzer vibes.db can be merged in via plain
// `INSERT INTO x SELECT * FROM src.x` without column-list gymnastics, and so
// a from-scratch app db (synced, never imported) matches the shape every
// query in this file already assumes.
function createSchemaIfMissing(db: DB): void {
  db.executeSync(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.executeSync(`CREATE TABLE IF NOT EXISTS songs (
    video_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    duration_s INTEGER,
    analyzed INTEGER NOT NULL DEFAULT 0,
    analyze_error TEXT
  )`);
  db.executeSync(
    `CREATE TABLE IF NOT EXISTS playlists (playlist_id TEXT PRIMARY KEY, name TEXT NOT NULL)`,
  );
  db.executeSync(`CREATE TABLE IF NOT EXISTS playlist_songs (
    playlist_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, video_id)
  )`);
  db.executeSync(`CREATE TABLE IF NOT EXISTS features (
    video_id TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    mood_happy REAL, mood_sad REAL, mood_relaxed REAL, mood_aggressive REAL,
    danceable REAL, acoustic REAL, party REAL,
    bpm REAL, energy REAL, key TEXT
  )`);
  // Offline downloads: device-LOCAL only (paths are meaningless on another
  // device), so deliberately NOT part of the import/merge in mergeFromFile.
  db.executeSync(`CREATE TABLE IF NOT EXISTS downloads (
    video_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  const res = db.executeSync(`SELECT value FROM meta WHERE key = 'schema_version'`);
  if (!res.rows.length) {
    db.executeSync(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`, [
      APP_SCHEMA_VERSION,
    ]);
  }
}

// The 7 mood keys tflite.ts's analyzeEmbeddingAndMoods produces, in the same
// order storeFeatures/rowToVibeSong reference them. Exported so analyzer.ts
// and its tests can validate a moods object shape without duplicating this
// list.
export const MOOD_KEYS = [
  'happy',
  'sad',
  'relaxed',
  'aggressive',
  'danceable',
  'acoustic',
  'party',
] as const;

const SONG_COLS = `s.video_id, s.title, s.artist, s.duration_s,
  EXISTS(SELECT 1 FROM features f WHERE f.video_id = s.video_id) AS has_vibe,
  EXISTS(SELECT 1 FROM downloads d WHERE d.video_id = s.video_id) AS has_download`;

// Analyzed-only join: features.video_id is only present once the analyzer
// has processed a song, so an INNER JOIN here is exactly the "analyzed"
// filter -- no separate has_vibe check needed.
const VIBE_SONG_COLS = `${SONG_COLS},
  f.embedding, f.mood_happy, f.mood_sad, f.mood_relaxed, f.mood_aggressive,
  f.danceable, f.acoustic, f.party`;

function rowToSong(r: any): Song {
  return {
    videoId: r.video_id,
    title: r.title,
    artist: r.artist,
    durationS: r.duration_s ?? null,
    hasVibe: !!r.has_vibe,
    hasDownload: !!r.has_download,
  };
}

// Extracted as a standalone function (rather than inlined in getVibeSongs)
// so the row-mapping logic reads clearly, mirroring rowToSong above.
function rowToVibeSong(r: any): VibeSong {
  return {
    videoId: r.video_id,
    embedding: embeddingFromBlob(r.embedding),
    moods: {
      happy: r.mood_happy,
      sad: r.mood_sad,
      relaxed: r.mood_relaxed,
      aggressive: r.mood_aggressive,
      danceable: r.danceable,
      acoustic: r.acoustic,
      party: r.party,
    },
    song: rowToSong(r),
  };
}

export class VibesDb {
  constructor(private db: DB) {}

  getPlaylists(): Playlist[] {
    const res = this.db.executeSync(
      `SELECT p.playlist_id, p.name, COUNT(ps.video_id) AS n
       FROM playlists p LEFT JOIN playlist_songs ps USING (playlist_id)
       GROUP BY p.playlist_id ORDER BY p.name`,
    );
    return res.rows.map((r: any) => ({
      playlistId: r.playlist_id,
      name: r.name,
      trackCount: r.n,
    }));
  }

  getPlaylistSongs(playlistId: string): Song[] {
    const res = this.db.executeSync(
      `SELECT ${SONG_COLS} FROM playlist_songs ps
       JOIN songs s USING (video_id)
       WHERE ps.playlist_id = ? ORDER BY ps.position`,
      [playlistId],
    );
    return res.rows.map(rowToSong);
  }

  getAllSongs(): Song[] {
    const res = this.db.executeSync(
      `SELECT ${SONG_COLS} FROM songs s ORDER BY s.artist, s.title`,
    );
    return res.rows.map(rowToSong);
  }

  getSong(videoId: string): Song | null {
    const res = this.db.executeSync(
      `SELECT ${SONG_COLS} FROM songs s WHERE s.video_id = ?`,
      [videoId],
    );
    return res.rows.length ? rowToSong(res.rows[0]) : null;
  }

  // Analyzed songs in scope, ready to feed a VibeQueue. 'ALL' scopes to the
  // whole library (mirrors getAllSongs/getPlaylistSongs' playlistId param).
  getVibeSongs(playlistId: string | 'ALL'): VibeSong[] {
    const res =
      playlistId === 'ALL'
        ? this.db.executeSync(
            `SELECT ${VIBE_SONG_COLS} FROM songs s
             JOIN features f ON f.video_id = s.video_id
             ORDER BY s.artist, s.title`,
          )
        : this.db.executeSync(
            `SELECT ${VIBE_SONG_COLS} FROM playlist_songs ps
             JOIN songs s USING (video_id)
             JOIN features f ON f.video_id = s.video_id
             WHERE ps.playlist_id = ? ORDER BY ps.position`,
            [playlistId],
          );
    return res.rows.map(rowToVibeSong);
  }

  // UI-only helper (Task: YT-Music-style redesign): one video id per
  // playlist -- its earliest-position song -- keyed by playlist_id, for
  // rendering a single-thumbnail cover on Library's playlist rows without
  // an N+1 getPlaylistSongs() call per row. A plain JS object (not a Map)
  // so callers can destructure/JSON it as easily as any other read here.
  getPlaylistCoverVideoIds(): Record<string, string> {
    const res = this.db.executeSync(
      `SELECT ps.playlist_id, ps.video_id FROM playlist_songs ps
       WHERE ps.position = (
         SELECT MIN(position) FROM playlist_songs ps2
         WHERE ps2.playlist_id = ps.playlist_id
       )`,
    );
    const out: Record<string, string> = {};
    for (const r of res.rows as any[]) out[r.playlist_id] = r.video_id;
    return out;
  }

  // UI-only helper: up to `limit` video ids in playlist order (or library
  // order for 'ALL'), for PlaylistScreen's header collage art. Intentionally
  // separate from getPlaylistCoverVideoIds() above -- that one is a single
  // batch query across every playlist for the Library list; this one is a
  // single small query for the one playlist currently open.
  getFirstVideoIds(playlistId: string | 'ALL', limit: number): string[] {
    const res =
      playlistId === 'ALL'
        ? this.db.executeSync(
            `SELECT video_id FROM songs ORDER BY artist, title LIMIT ?`,
            [limit],
          )
        : this.db.executeSync(
            `SELECT video_id FROM playlist_songs WHERE playlist_id = ?
             ORDER BY position LIMIT ?`,
            [playlistId, limit],
          );
    return res.rows.map((r: any) => r.video_id);
  }

  // --- offline downloads -------------------------------------------------

  /** Local file path for an offline-downloaded song, or null if not saved. */
  getDownloadPath(videoId: string): string | null {
    const res = this.db.executeSync(`SELECT path FROM downloads WHERE video_id = ?`, [videoId]);
    return res.rows.length ? (res.rows[0] as any).path : null;
  }

  /** All downloaded video ids (for batch dedup / "download all" skip checks). */
  getDownloadedIds(): Set<string> {
    const res = this.db.executeSync(`SELECT video_id FROM downloads`);
    return new Set(res.rows.map((r: any) => r.video_id));
  }

  /** Every download row -- used by Settings storage view and cleanup. */
  getDownloads(): Array<{videoId: string; path: string; bytes: number}> {
    const res = this.db.executeSync(`SELECT video_id, path, bytes FROM downloads`);
    return res.rows.map((r: any) => ({videoId: r.video_id, path: r.path, bytes: r.bytes}));
  }

  /** Total bytes across all downloaded files. */
  getDownloadsTotalBytes(): number {
    const res = this.db.executeSync(`SELECT COALESCE(SUM(bytes), 0) AS total FROM downloads`);
    return (res.rows[0] as any).total ?? 0;
  }

  addDownload(videoId: string, path: string, bytes: number, createdAt: number): void {
    this.db.executeSync(
      `INSERT OR REPLACE INTO downloads (video_id, path, bytes, created_at) VALUES (?, ?, ?, ?)`,
      [videoId, path, bytes, createdAt],
    );
  }

  removeDownload(videoId: string): void {
    this.db.executeSync(`DELETE FROM downloads WHERE video_id = ?`, [videoId]);
  }

  clearDownloads(): void {
    this.db.executeSync(`DELETE FROM downloads`);
  }

  // Plan D Task 6: on-device analyzer writer path. `hasFeatures` is the
  // skip-if-already-analyzed check analyzer.ts runs before doing any
  // expensive work (download/decode/infer); `storeFeatures` is the writer,
  // shaped to mirror the exact column list importVibesDb's merge already
  // uses above (video_id, embedding, 7 moods, bpm/energy/key). bpm/energy/key
  // stay NULL -- MusiCNN (the on-device model) only produces an embedding +
  // mood scores, matching the Global Constraints note that v1's rhythm/key
  // extraction was never ported since the vibe engine only reads
  // embedding+moods (see engine/similarity.ts).
  hasFeatures(videoId: string): boolean {
    const res = this.db.executeSync(`SELECT 1 FROM features WHERE video_id = ?`, [videoId]);
    return res.rows.length > 0;
  }

  // `embedding` is handed to op-sqlite as a bare Float32Array (an
  // ArrayBufferView, one of op-sqlite's supported Scalar param types) rather
  // than manually packed into a Uint8Array/base64 -- op-sqlite binds it as
  // an 800-byte little-endian BLOB as-is, which is exactly the byte layout
  // db/blob.ts's embeddingFromBlob (the read side, used by getVibeSongs)
  // already expects. `moods` must carry all 7 keys tflite.ts's
  // analyzeEmbeddingAndMoods produces (happy/sad/relaxed/aggressive/
  // danceable/acoustic/party) -- see __tests__/analyzer.test.ts for the
  // param-shape unit coverage of this mapping.
  storeFeatures(videoId: string, embedding: Float32Array, moods: Record<string, number>): void {
    if (embedding.length !== 200) {
      throw new Error(`storeFeatures: embedding must be length 200 (float32), got ${embedding.length}`);
    }
    for (const key of MOOD_KEYS) {
      if (typeof moods[key] !== 'number') {
        throw new Error(`storeFeatures: moods.${key} missing or not a number`);
      }
    }
    this.db.executeSync(
      `INSERT OR REPLACE INTO features
       (video_id, embedding, mood_happy, mood_sad, mood_relaxed, mood_aggressive,
        danceable, acoustic, party, bpm, energy, key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      [
        videoId,
        embedding,
        moods.happy,
        moods.sad,
        moods.relaxed,
        moods.aggressive,
        moods.danceable,
        moods.acoustic,
        moods.party,
      ],
    );
  }

  // Generic single-row key/value stamp -- analyzer.ts uses this to record
  // which model produced the features currently in this db ('model_version'
  // -> 'msd-musicnn-1'), so a future model swap can tell which rows need
  // re-analysis. Shares the same `meta` table schema_version already lives
  // in (createSchemaIfMissing above).
  setMeta(key: string, value: string): void {
    this.db.executeSync(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [key, value]);
  }

  getMeta(key: string): string | null {
    const res = this.db.executeSync(`SELECT value FROM meta WHERE key = ?`, [key]);
    return res.rows.length ? (res.rows[0] as any).value : null;
  }

  // Raw handle so FeedbackStore (a thin op-sqlite adapter of its own) can
  // share the same open connection instead of re-opening vibes.db.
  get handle(): DB {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

function appDbPath(): string {
  return `${RNFS.DocumentDirectoryPath}/${DB_FILENAME}`;
}

const IMPORTING_FILENAME = `${DB_FILENAME}.importing`;

function importingPath(): string {
  return `${RNFS.DocumentDirectoryPath}/${IMPORTING_FILENAME}`;
}

// Validates a candidate analyzer vibes.db entirely out-of-place (a
// `.importing` sidecar file, never the live app db) before it's ever
// allowed to touch the working library. A failed candidate only ever costs
// the temp file; the existing db is never opened, closed, or removed until
// the new one has already proven valid.
//
// ADAPTATION (Plan C Task 3, Global Constraints): this used to copy the
// whole analyzer file over the app's vibes.db wholesale, taking it as the
// single source of truth for songs/playlists/features. Now that library
// structure (songs/playlists/playlist_songs) is populated by authenticated
// sync (src/library/syncToDb.ts) and may already be live in the app db
// before any import ever happens, a wholesale file swap would destroy synced
// playlists the moment someone imports an analyzer file for vibe features.
// So this now MERGES: only `features` (the analysis data the analyzer
// produces, which sync never touches) is brought in, upserted by video_id.
// `songs` rows are inserted only for videoIds the merge needs but that
// aren't already present (e.g. a song analyzed by the analyzer that isn't
// in any currently-synced playlist) -- ON CONFLICT DO NOTHING, so a
// synced song's title/artist (from the live YT Music account) is never
// clobbered by potentially-stale analyzer metadata. playlists/playlist_songs
// are never touched by import at all; those are sync's alone.
export async function importVibesDb(sourcePath: string): Promise<void> {
  const dest = appDbPath();
  const temp = importingPath();

  // Clear out any leftover temp file from a previous crashed/aborted import
  // before starting, so copyFile below always starts from a clean slate.
  await RNFS.unlink(temp).catch(() => {});
  await RNFS.copyFile(sourcePath, temp);

  let validationDb: DB | undefined;
  try {
    validationDb = open({name: IMPORTING_FILENAME, location: RNFS.DocumentDirectoryPath});
    const res = validationDb.executeSync(
      `SELECT value FROM meta WHERE key = 'schema_version'`,
    );
    const version = res.rows.length ? res.rows[0].value : undefined;
    if (version !== '1') {
      throw new Error(
        `vibes.db schema_version is ${version ?? 'missing'}, this app needs "1". Re-run the analyzer.`,
      );
    }
  } catch (e) {
    validationDb?.close();
    // Candidate is bad: clean up only the temp file. The existing, working
    // app db (if any) was never touched, so this can't brick the library.
    await RNFS.unlink(temp).catch(() => {});
    throw e instanceof Error ? e : new Error('vibes.db is not a valid database file');
  }
  // Keep the connection open below -- it's about to be ATTACHed to, and
  // op-sqlite's ATTACH needs the *destination* connection open, not this one.
  validationDb.close();

  // Candidate validated -- safe to merge from it. ensureBaseSchema() so a
  // fresh, never-synced-or-imported user importing straight away still gets
  // a valid app db to merge into (not just a bare features grab-bag with no
  // songs table to satisfy the FK-shaped join every read query assumes).
  const appDb = await ensureBaseSchema();
  const handle = appDb.handle;
  try {
    handle.executeSync(`ATTACH DATABASE ? AS src`, [temp]);
    try {
      // Songs the merge needs a row for, that aren't already present --
      // ON CONFLICT DO NOTHING so a pre-existing (synced) row always wins.
      handle.executeSync(
        `INSERT INTO songs (video_id, title, artist, duration_s, analyzed, analyze_error)
         SELECT video_id, title, artist, duration_s, analyzed, analyze_error
         FROM src.songs WHERE analyzed = 1
         ON CONFLICT(video_id) DO NOTHING`,
      );
      // Features: analyzer file is the sole source of truth for these, so a
      // plain REPLACE (features' PK is video_id) is correct -- no need to
      // preserve anything from a previous features row for the same song.
      // Guarded to src.songs the same way the songs merge above is guarded
      // to `analyzed = 1`: a features row with no corresponding songs row in
      // the source file would be orphaned data (shouldn't exist in a
      // well-formed analyzer db, but the merge shouldn't trust that blindly)
      // and must not be imported without a song to attach it to.
      handle.executeSync(
        `INSERT OR REPLACE INTO features
         (video_id, embedding, mood_happy, mood_sad, mood_relaxed, mood_aggressive,
          danceable, acoustic, party, bpm, energy, key)
         SELECT video_id, embedding, mood_happy, mood_sad, mood_relaxed, mood_aggressive,
                danceable, acoustic, party, bpm, energy, key
         FROM src.features WHERE video_id IN (SELECT video_id FROM src.songs)`,
      );
    } finally {
      handle.executeSync(`DETACH DATABASE src`);
    }
  } finally {
    appDb.close();
    await RNFS.unlink(temp).catch(() => {});
    // Stale -wal/-shm sidecars for the *temp* file specifically (not dest --
    // dest was never swapped out, so its own WAL state is untouched).
    await RNFS.unlink(`${temp}-wal`).catch(() => {});
    await RNFS.unlink(`${temp}-shm`).catch(() => {});
  }
}

/**
 * Opens (creating if necessary) the app's db with the base schema present,
 * for a logged-in user who syncs before ever importing an analyzer file.
 * Unlike openVibesDb(), this never returns null -- it always hands back a
 * usable VibesDb, creating vibes.db and its tables from scratch if this is
 * the very first time anything has touched it on this device.
 */
export async function ensureBaseSchema(): Promise<VibesDb> {
  const db = open({name: DB_FILENAME, location: RNFS.DocumentDirectoryPath});
  createSchemaIfMissing(db);
  return new VibesDb(db);
}

export async function openVibesDb(): Promise<VibesDb | null> {
  if (!(await RNFS.exists(appDbPath()))) return null;
  const db = open({name: DB_FILENAME, location: RNFS.DocumentDirectoryPath});
  createSchemaIfMissing(db);
  return new VibesDb(db);
}
