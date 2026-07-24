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
  const res = db.executeSync(`SELECT value FROM meta WHERE key = 'schema_version'`);
  if (!res.rows.length) {
    db.executeSync(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`, [
      APP_SCHEMA_VERSION,
    ]);
  }
}

const SONG_COLS = `s.video_id, s.title, s.artist, s.duration_s,
  EXISTS(SELECT 1 FROM features f WHERE f.video_id = s.video_id) AS has_vibe`;

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
      handle.executeSync(
        `INSERT OR REPLACE INTO features
         (video_id, embedding, mood_happy, mood_sad, mood_relaxed, mood_aggressive,
          danceable, acoustic, party, bpm, energy, key)
         SELECT video_id, embedding, mood_happy, mood_sad, mood_relaxed, mood_aggressive,
                danceable, acoustic, party, bpm, energy, key
         FROM src.features`,
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
