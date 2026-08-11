// describe(): every QueueSource must report a serializable descriptor so a
// session can be persisted and rebuilt (see player/session.ts). Covers all
// three implementations.
import {SimpleQueue} from '../src/player/queue';
import {RadioQueue} from '../src/engine/radioQueue';
import {VibeQueue} from '../src/engine/vibeQueue';
import type {VibeSong} from '../src/engine/similarity';
import {Song} from '../src/types';

const song = (id: string): Song => ({
  videoId: id,
  title: id,
  artist: 'a',
  durationS: 100,
  hasVibe: true,
});

const vibeSong = (id: string): VibeSong => ({
  videoId: id,
  song: song(id),
  embedding: new Float32Array([0, 0, 0]),
  moods: {},
});

const noFeedback = {
  pairCount: () => 0,
  songCount: () => 0,
  struckNeighbors: () => [],
};

test('SimpleQueue.describe carries the full list and current index', () => {
  const q = new SimpleQueue([song('a'), song('b'), song('c')], 1);
  expect(q.describe()).toEqual({
    kind: 'simple',
    songs: [song('a'), song('b'), song('c')],
    index: 1,
  });
  // Advancing moves the reported index so a mid-list resume lands correctly.
  q.next(null);
  expect(q.describe()).toMatchObject({kind: 'simple', index: 2});
});

test('RadioQueue.describe is just the kind (regenerated from the seed on restore)', () => {
  const q = new RadioQueue(async () => []);
  expect(q.describe()).toEqual({kind: 'radio'});
});

test('VibeQueue.describe carries mode and the live mood filter', () => {
  const q = new VibeQueue(vibeSong('a'), 'drift', {
    songs: [vibeSong('a'), vibeSong('b')],
    feedback: noFeedback,
  });
  expect(q.describe()).toEqual({kind: 'vibe', mode: 'drift', moodFilter: null});

  q.setMode('lock');
  q.setMoodFilter({key: 'energy', min: 0.5});
  expect(q.describe()).toEqual({
    kind: 'vibe',
    mode: 'lock',
    moodFilter: {key: 'energy', min: 0.5},
  });
});
