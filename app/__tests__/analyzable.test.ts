import {isAnalyzable, MAX_ANALYZABLE_DURATION_S} from '../src/analyze/analyzable';
import type {Song} from '../src/types';

const s = (durationS: number | null): Song =>
  ({videoId: 'x', title: 't', artist: 'a', durationS, hasVibe: false});

test('allows normal-length songs', () => {
  expect(isAnalyzable(s(180))).toBe(true);
  expect(isAnalyzable(s(MAX_ANALYZABLE_DURATION_S))).toBe(true);
});

test('skips clearly-too-long items (lectures/podcasts/mixes)', () => {
  expect(isAnalyzable(s(MAX_ANALYZABLE_DURATION_S + 1))).toBe(false);
  expect(isAnalyzable(s(60 * 60))).toBe(false); // 1h lecture
});

test('allows unknown duration (no reason to skip)', () => {
  expect(isAnalyzable(s(null))).toBe(true);
});
