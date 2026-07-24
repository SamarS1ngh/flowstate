// Writes a fetched SyncedLibrary (src/library/syncClient.ts) into the app's
// SQLite db, per Plan C's Global Constraints:
//   - songs: upserted (insert new, update title/artist/duration_s on an
//     existing row -- sync is the freshest source of truth for these,
//     unlike the analyzer import which never overwrites an existing song).
//   - playlists + playlist_songs: full REPLACE, mirroring the analyzer's own
//     sync semantics (the analyzer's `sync` command in db.py does the same
//     delete-then-reinsert dance against the account's current library).
//     A playlist that disappeared from the account (deleted, unfollowed)
//     disappears from the local db too on next sync; a still-present
//     playlist's position ordering is always rewritten from scratch rather
//     than diffed, since a full account-side reorder would otherwise leave
//     stale positions behind.
//   - features: NEVER touched here. That table belongs entirely to the
//     analyzer-import path (src/db/vibesDb.ts importVibesDb); a song that's
//     already analyzed keeps its features row across any number of syncs.
import type {DB} from '@op-engineering/op-sqlite';
import {VibesDb} from '../db/vibesDb';
import type {SyncedLibrary} from './syncClient';

export interface SyncResult {
  songCount: number;
  playlistCount: number;
}

/**
 * Assembles the flat (videoId -> song) map and the ordered per-playlist
 * track-id lists a SyncedLibrary implies, deduplicating songs that appear
 * in more than one playlist (each keeps its last-seen title/artist/duration
 * -- library responses are internally consistent per sync, so this is just
 * a defensive tie-break, not a meaningful choice). Pure and unit-tested;
 * syncLibraryToDb below is the thin SQL-writing wrapper around this.
 */
export function assembleSyncRows(lib: SyncedLibrary): {
  songs: Array<{videoId: string; title: string; artist: string; durationS: number | null}>;
  playlists: Array<{playlistId: string; name: string; videoIds: string[]}>;
} {
  const songsById = new Map<
    string,
    {videoId: string; title: string; artist: string; durationS: number | null}
  >();
  const playlists: Array<{playlistId: string; name: string; videoIds: string[]}> = [];

  for (const playlist of lib.playlists ?? []) {
    const videoIds: string[] = [];
    for (const track of playlist.tracks ?? []) {
      if (!track?.videoId) continue;
      videoIds.push(track.videoId);
      songsById.set(track.videoId, {
        videoId: track.videoId,
        title: track.title || 'Unknown title',
        artist: track.artist || 'Unknown',
        durationS: typeof track.durationS === 'number' ? track.durationS : null,
      });
    }
    playlists.push({
      playlistId: playlist.playlistId,
      name: playlist.name || 'Untitled playlist',
      videoIds,
    });
  }

  return {songs: Array.from(songsById.values()), playlists};
}

function writeRows(
  handle: DB,
  rows: ReturnType<typeof assembleSyncRows>,
): SyncResult {
  handle.executeSync('BEGIN');
  try {
    for (const song of rows.songs) {
      handle.executeSync(
        `INSERT INTO songs (video_id, title, artist, duration_s)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(video_id) DO UPDATE SET
           title = excluded.title,
           artist = excluded.artist,
           duration_s = excluded.duration_s`,
        [song.videoId, song.title, song.artist, song.durationS],
      );
    }

    // Full replace of playlists + playlist_songs (never features): clear
    // every existing playlist_songs row first (FK-less schema, so order
    // between the two deletes doesn't matter), then the playlists
    // themselves, then reinsert everything sync just fetched.
    handle.executeSync('DELETE FROM playlist_songs');
    handle.executeSync('DELETE FROM playlists');

    for (const playlist of rows.playlists) {
      handle.executeSync(`INSERT INTO playlists (playlist_id, name) VALUES (?, ?)`, [
        playlist.playlistId,
        playlist.name,
      ]);
      playlist.videoIds.forEach((videoId, position) => {
        handle.executeSync(
          `INSERT INTO playlist_songs (playlist_id, video_id, position) VALUES (?, ?, ?)`,
          [playlist.playlistId, videoId, position],
        );
      });
    }

    handle.executeSync('COMMIT');
  } catch (e) {
    handle.executeSync('ROLLBACK');
    throw e;
  }

  return {songCount: rows.songs.length, playlistCount: rows.playlists.length};
}

/**
 * Writes a fetched library into the given (already-open) db. Accepts a
 * VibesDb (the app's usual handle wrapper) so callers don't need to reach
 * into its private connection themselves.
 */
export function syncLibraryToDb(db: VibesDb, lib: SyncedLibrary): SyncResult {
  const rows = assembleSyncRows(lib);
  return writeRows(db.handle, rows);
}
