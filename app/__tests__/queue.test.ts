import {SimpleQueue} from '../src/player/queue';
import {Song} from '../src/types';

const song = (id: string): Song => ({
  videoId: id, title: id, artist: 'a', durationS: 100, hasVibe: true,
});

test('plays list in order from start index and ends with null', () => {
  const q = new SimpleQueue([song('a'), song('b'), song('c')], 1);
  expect(q.next(null)?.videoId).toBe('c');
  expect(q.next(null)).toBeNull();
});

test('reset re-seeds position', () => {
  const q = new SimpleQueue([song('a'), song('b'), song('c')], 2);
  q.reset(song('a'));
  expect(q.next(null)?.videoId).toBe('b');
});

describe('peekUpcoming', () => {
  test('returns the next N songs without mutating position', () => {
    const q = new SimpleQueue([song('a'), song('b'), song('c'), song('d')], 0);
    expect(q.peekUpcoming(2).map(s => s.videoId)).toEqual(['b', 'c']);
    // next() still resumes from index 0 -> 1, proving peek didn't advance idx
    expect(q.next(null)?.videoId).toBe('b');
  });

  test('truncates near the end of the list', () => {
    const q = new SimpleQueue([song('a'), song('b'), song('c')], 1);
    expect(q.peekUpcoming(5).map(s => s.videoId)).toEqual(['c']);
  });

  test('returns empty when already at the last song', () => {
    const q = new SimpleQueue([song('a'), song('b')], 1);
    expect(q.peekUpcoming(3)).toEqual([]);
  });
});
