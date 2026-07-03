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

export const DB_FILENAME = 'vibes.db';

const SONG_COLS = `s.video_id, s.title, s.artist, s.duration_s,
  EXISTS(SELECT 1 FROM features f WHERE f.video_id = s.video_id) AS has_vibe`;

function rowToSong(r: any): Song {
  return {
    videoId: r.video_id,
    title: r.title,
    artist: r.artist,
    durationS: r.duration_s ?? null,
    hasVibe: !!r.has_vibe,
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
}

function appDbPath(): string {
  return `${RNFS.DocumentDirectoryPath}/${DB_FILENAME}`;
}

export async function importVibesDb(sourcePath: string): Promise<void> {
  const dest = appDbPath();
  await RNFS.copyFile(sourcePath, dest);
  let db: DB | undefined;
  try {
    db = open({name: DB_FILENAME, location: RNFS.DocumentDirectoryPath});
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
    await RNFS.unlink(dest).catch(() => {});
    throw e instanceof Error ? e : new Error('vibes.db is not a valid database file');
  }
  db.close();
}

export async function openVibesDb(): Promise<VibesDb | null> {
  if (!(await RNFS.exists(appDbPath()))) return null;
  return new VibesDb(open({name: DB_FILENAME, location: RNFS.DocumentDirectoryPath}));
}
