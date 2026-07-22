import {cosine, buildPool, VibeSong} from '../src/engine/similarity';

describe('cosine', () => {
  test('identical vectors => 1', () => {
    const a = new Float32Array([1, 2, 3]);
    expect(cosine(a, a)).toBeCloseTo(1);
  });

  test('orthogonal vectors => 0', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosine(a, b)).toBeCloseTo(0);
  });

  test('opposite vectors => -1', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosine(a, b)).toBeCloseTo(-1);
  });

  test('zero-norm vector => 0 (never NaN)', () => {
    const zero = new Float32Array([0, 0, 0]);
    const other = new Float32Array([1, 2, 3]);
    expect(cosine(zero, other)).toBe(0);
    expect(cosine(other, zero)).toBe(0);
    expect(cosine(zero, zero)).toBe(0);
  });
});

function song(videoId: string, embedding: number[], moods: Record<string, number> = {}): VibeSong {
  return {
    videoId,
    embedding: new Float32Array(embedding),
    moods,
    song: {videoId, title: videoId, artist: 'a', durationS: 100, hasVibe: true},
  };
}

describe('buildPool', () => {
  const center = song('center', [1, 0]);

  test('filters candidates below the similarity threshold', () => {
    const a = song('a', [1, 0]); // sim 1
    const b = song('b', [0, 1]); // sim 0
    const c = song('c', [0.8, 0.6]); // sim 0.8
    const pool = buildPool(center, [a, b, c], {threshold: 0.5, banned: new Set()});
    expect(pool.map(p => p.song.videoId).sort()).toEqual(['a', 'c']);
  });

  test('keeps candidates exactly at the threshold', () => {
    // Integer components keep both the embedding and the cosine division
    // exactly representable in floating point, so sim === 0.8 bit-for-bit
    // rather than merely close to it.
    const centerInt = song('center', [5, 0]);
    const c = song('c', [4, 3]); // sim = 20 / (5*5) = 0.8 exactly
    const pool = buildPool(centerInt, [c], {threshold: 0.8, banned: new Set()});
    expect(pool.map(p => p.song.videoId)).toEqual(['c']);
  });

  test('excludes the center itself even if present in candidates', () => {
    const pool = buildPool(center, [center, song('a', [1, 0])], {
      threshold: 0.5,
      banned: new Set(),
    });
    expect(pool.map(p => p.song.videoId)).toEqual(['a']);
  });

  test('excludes banned candidates regardless of similarity', () => {
    const a = song('a', [1, 0]); // sim 1, would otherwise pass
    const pool = buildPool(center, [a], {threshold: 0.5, banned: new Set(['a'])});
    expect(pool).toEqual([]);
  });

  test('mood filter keeps songs with moods[key] >= min', () => {
    const a = song('a', [1, 0], {chill: 0.6});
    const b = song('b', [1, 0], {chill: 0.4});
    const pool = buildPool(center, [a, b], {
      threshold: 0.5,
      banned: new Set(),
      moodFilter: {key: 'chill', min: 0.5},
    });
    expect(pool.map(p => p.song.videoId)).toEqual(['a']);
  });

  test('mood filter excludes songs lacking the mood key entirely', () => {
    const a = song('a', [1, 0], {}); // no 'chill' key at all
    const pool = buildPool(center, [a], {
      threshold: 0.5,
      banned: new Set(),
      moodFilter: {key: 'chill', min: 0.5},
    });
    expect(pool).toEqual([]);
  });

  test('returns the similarity alongside each pooled song', () => {
    const a = song('a', [1, 0]);
    const pool = buildPool(center, [a], {threshold: 0.5, banned: new Set()});
    expect(pool[0].sim).toBeCloseTo(1);
    expect(pool[0].song).toBe(a);
  });

  test('empty candidates => empty pool', () => {
    expect(buildPool(center, [], {threshold: 0.5, banned: new Set()})).toEqual([]);
  });
});
