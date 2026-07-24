// Pure-function tests for src/library/syncToDb.ts's assembleSyncRows.
// syncLibraryToDb itself (the SQL-writing wrapper) is integration glue
// around a real op-sqlite connection and is device-verified instead (see
// the task report: row counts from sqlite_query against the on-device db
// after a real sync).
import {assembleSyncRows} from '../src/library/syncToDb';
import type {SyncedLibrary} from '../src/library/syncClient';

describe('assembleSyncRows', () => {
  test('flattens playlists into deduplicated songs + ordered playlist rows', () => {
    const lib: SyncedLibrary = {
      playlists: [
        {
          playlistId: 'LM',
          name: 'Liked Music',
          tracks: [
            {videoId: 'a1', title: 'Song A', artist: 'Artist A', durationS: 200},
            {videoId: 'a2', title: 'Song B', artist: 'Artist B', durationS: 180},
          ],
        },
        {
          playlistId: 'PL2',
          name: 'Dang OSTs',
          tracks: [
            {videoId: 'a2', title: 'Song B', artist: 'Artist B', durationS: 180},
            {videoId: 'a3', title: 'Song C', artist: 'Artist C', durationS: null},
          ],
        },
      ],
    };

    const {songs, playlists} = assembleSyncRows(lib);

    expect(songs).toEqual([
      {videoId: 'a1', title: 'Song A', artist: 'Artist A', durationS: 200},
      {videoId: 'a2', title: 'Song B', artist: 'Artist B', durationS: 180},
      {videoId: 'a3', title: 'Song C', artist: 'Artist C', durationS: null},
    ]);
    expect(playlists).toEqual([
      {playlistId: 'LM', name: 'Liked Music', videoIds: ['a1', 'a2']},
      {playlistId: 'PL2', name: 'Dang OSTs', videoIds: ['a2', 'a3']},
    ]);
  });

  test('an empty library yields empty songs and playlists', () => {
    expect(assembleSyncRows({playlists: []})).toEqual({songs: [], playlists: []});
  });

  test('preserves per-playlist track order for playlist_songs position', () => {
    const lib: SyncedLibrary = {
      playlists: [
        {
          playlistId: 'P1',
          name: 'Ordered',
          tracks: [
            {videoId: 'z', title: 'Z', artist: 'Z', durationS: null},
            {videoId: 'y', title: 'Y', artist: 'Y', durationS: null},
            {videoId: 'x', title: 'X', artist: 'X', durationS: null},
          ],
        },
      ],
    };
    const {playlists} = assembleSyncRows(lib);
    expect(playlists[0].videoIds).toEqual(['z', 'y', 'x']);
  });

  test('drops a track missing a videoId', () => {
    const lib: SyncedLibrary = {
      playlists: [
        {
          playlistId: 'P1',
          name: 'Has a gap',
          tracks: [
            {videoId: '', title: 'No id', artist: 'X', durationS: null},
            {videoId: 'ok1', title: 'Fine', artist: 'X', durationS: null},
          ],
        },
      ],
    };
    const {songs, playlists} = assembleSyncRows(lib);
    expect(songs).toEqual([{videoId: 'ok1', title: 'Fine', artist: 'X', durationS: null}]);
    expect(playlists[0].videoIds).toEqual(['ok1']);
  });

  test('defaults an empty playlist name to a placeholder', () => {
    const lib: SyncedLibrary = {playlists: [{playlistId: 'P1', name: '', tracks: []}]};
    const {playlists} = assembleSyncRows(lib);
    expect(playlists[0].name).toBe('Untitled playlist');
  });
});
