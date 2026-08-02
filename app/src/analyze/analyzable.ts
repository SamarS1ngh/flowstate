import type {Song} from '../types';

// Longest track we'll try to vibe-analyze. Real songs are short; items well
// past this are lectures, podcasts, DJ mixes, full albums, gaming/stream VODs
// -- not music, so a MusiCNN fingerprint is meaningless AND they're the main
// source of hard analysis failures (e.g. a BTech lecture video that has no
// "song" the search-fallback can recover). 20 min comfortably clears even long
// songs/OST suites while excluding the non-music long tail.
export const MAX_ANALYZABLE_DURATION_S = 20 * 60;

/**
 * Whether a track is worth attempting on-device analysis for. Unknown duration
 * (null) is allowed -- we don't have a reason to skip it. Only an explicit,
 * clearly-too-long duration is filtered out.
 */
export function isAnalyzable(song: Song): boolean {
  if (song.durationS == null) return true;
  return song.durationS <= MAX_ANALYZABLE_DURATION_S;
}
