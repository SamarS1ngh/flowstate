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
