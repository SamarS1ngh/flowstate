import {filterSongs, filterPlaylists} from '../src/library/search';
import type {Song, Playlist} from '../src/types';

const song = (videoId: string, title: string, artist: string): Song => ({
  videoId,
  title,
  artist,
  durationS: 0,
  hasVibe: false,
});
const pl = (playlistId: string, name: string): Playlist => ({
  playlistId,
  name,
  trackCount: 0,
});

const songs: Song[] = [
  song('a', 'Bye Bye Bye', 'NSYNC'),
  song('b', 'Firework', 'Katy Perry'),
  song('c', 'FIREWORK', '&TEAM'),
  song('d', 'Teeth', '5 Seconds of Summer'),
];

describe('filterSongs', () => {
  test('empty query returns the same list reference (no-op)', () => {
    expect(filterSongs(songs, '')).toBe(songs);
    expect(filterSongs(songs, '   ')).toBe(songs);
  });

  test('matches title, case-insensitive, substring', () => {
    const r = filterSongs(songs, 'fire');
    expect(r.map(s => s.videoId).sort()).toEqual(['b', 'c']);
  });

  test('matches artist too', () => {
    expect(filterSongs(songs, 'katy').map(s => s.videoId)).toEqual(['b']);
    expect(filterSongs(songs, 'team').map(s => s.videoId)).toEqual(['c']);
  });

  test('trims surrounding whitespace in the query', () => {
    expect(filterSongs(songs, '  teeth  ').map(s => s.videoId)).toEqual(['d']);
  });

  test('no match returns empty', () => {
    expect(filterSongs(songs, 'zzzzz')).toEqual([]);
  });

  test('tolerates a missing/empty artist', () => {
    const s = [song('x', 'Untitled', '')];
    expect(filterSongs(s, 'unt').map(v => v.videoId)).toEqual(['x']);
    expect(filterSongs(s, 'nope')).toEqual([]);
  });
});

describe('filterPlaylists', () => {
  const pls = [pl('1', 'Liked Music'), pl('2', 'Dang OSTs'), pl('3', 'Workout')];
  test('empty query is a no-op (same reference)', () => {
    expect(filterPlaylists(pls, '')).toBe(pls);
  });
  test('matches name substring, case-insensitive', () => {
    expect(filterPlaylists(pls, 'ost').map(p => p.playlistId)).toEqual(['2']);
    expect(filterPlaylists(pls, 'MUSIC').map(p => p.playlistId)).toEqual(['1']);
  });
});
