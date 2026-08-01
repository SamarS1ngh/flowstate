// Local, instant library search. The whole library (songs + playlists) is
// already in memory once synced, so filtering is a plain JS pass -- no DB
// round-trip, no async, no debounce needed even at ~1200 songs. Pure
// functions so they're unit-tested directly (no React/native).
import type {Song, Playlist} from '../types';

/** Normalize a query/field for case- and whitespace-insensitive matching. */
function norm(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * Filter songs by a free-text query against title OR artist (substring,
 * case-insensitive). Empty/whitespace query returns the list unchanged (same
 * reference), so callers can use the result directly without a separate
 * "is searching" branch.
 */
export function filterSongs(songs: Song[], query: string): Song[] {
  const q = norm(query);
  if (!q) return songs;
  return songs.filter(
    s => s.title.toLowerCase().includes(q) || (s.artist ?? '').toLowerCase().includes(q),
  );
}

/** Filter playlists by name (substring, case-insensitive). */
export function filterPlaylists(playlists: Playlist[], query: string): Playlist[] {
  const q = norm(query);
  if (!q) return playlists;
  return playlists.filter(p => p.name.toLowerCase().includes(q));
}
