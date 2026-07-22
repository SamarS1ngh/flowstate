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
}

function appDbPath(): string {
  return `${RNFS.DocumentDirectoryPath}/${DB_FILENAME}`;
}

const IMPORTING_FILENAME = `${DB_FILENAME}.importing`;

function importingPath(): string {
  return `${RNFS.DocumentDirectoryPath}/${IMPORTING_FILENAME}`;
}

// Validates a candidate vibes.db entirely out-of-place (a `.importing`
// sidecar file, never the live vibes.db) before it's ever allowed to touch
// the working library. Previously this copied straight over the live
// vibes.db and only unlinked it on failure -- which meant a bad or corrupt
// re-import destroyed a perfectly good existing library. Now a failed
// candidate only ever costs the temp file; the existing db is never opened,
// closed, or removed until the new one has already proven valid.
export async function importVibesDb(sourcePath: string): Promise<void> {
  const dest = appDbPath();
  const temp = importingPath();

  // Clear out any leftover temp file from a previous crashed/aborted import
  // before starting, so copyFile below always starts from a clean slate.
  await RNFS.unlink(temp).catch(() => {});
  await RNFS.copyFile(sourcePath, temp);

  let db: DB | undefined;
  try {
    db = open({name: IMPORTING_FILENAME, location: RNFS.DocumentDirectoryPath});
    const res = db.executeSync(
      `SELECT value FROM meta WHERE key = 'schema_version'`,
    );
    const version = res.rows.length ? res.rows[0].value : undefined;
    if (version !== '1') {
      throw new Error(
        `vibes.db schema_version is ${version ?? 'missing'}, this app needs "1". Re-run the analyzer.`,
      );
    }
  } catch (e) {
    db?.close();
    // Candidate is bad: clean up only the temp file. The existing, working
    // vibes.db (if any) was never touched, so this can't brick the library.
    await RNFS.unlink(temp).catch(() => {});
    throw e instanceof Error ? e : new Error('vibes.db is not a valid database file');
  }
  db.close();

  // Candidate validated -- safe to swap it in. Stale -wal/-shm sidecar
  // files from the *previous* vibes.db must go first: if left behind (e.g.
  // the app was killed mid-write), SQLite's WAL recovery would otherwise
  // replay them against the new file's contents on next open, corrupting it.
  await RNFS.unlink(`${dest}-wal`).catch(() => {});
  await RNFS.unlink(`${dest}-shm`).catch(() => {});

  try {
    // On Android this is an atomic rename (overwrites dest in place). Some
    // platforms' move implementations refuse to overwrite an existing
    // destination or fail across storage volumes, hence the fallback below.
    await RNFS.moveFile(temp, dest);
  } catch {
    await RNFS.copyFile(temp, dest);
    await RNFS.unlink(temp).catch(() => {});
  }
}

export async function openVibesDb(): Promise<VibesDb | null> {
  if (!(await RNFS.exists(appDbPath()))) return null;
  return new VibesDb(open({name: DB_FILENAME, location: RNFS.DocumentDirectoryPath}));
}
