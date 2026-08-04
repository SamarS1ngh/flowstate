import {VibeQueue, VibeQueueDeps} from '../src/engine/vibeQueue';
import {VibeSong} from '../src/engine/similarity';
import {FeedbackData} from '../src/engine/weights';
import {Song} from '../src/types';

// A FeedbackData with no recorded feedback at all -- bias is always 1.
const noFeedback: FeedbackData = {
  pairCount: () => 0,
  songCount: () => 0,
  struckNeighbors: () => [],
};

function vsong(videoId: string, embedding: number[], moods: Record<string, number> = {}): VibeSong {
  return {
    videoId,
    embedding: new Float32Array(embedding),
    moods,
    song: {videoId, title: videoId, artist: 'artist-' + videoId, durationS: 200, hasVibe: true},
  };
}

// A tiny deterministic LCG so multi-call sequences are reproducible without
// relying on Math.random. Returns values in [0, 1).
function makeRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
}

// Three well-separated clusters (near-orthogonal basis vectors in R^3) with
// a couple of within-cluster variants each, so cosine similarity is high
// within a cluster (> 0.75, satisfies even the lock threshold) and ~0 across
// clusters (fails both lock 0.75 and drift 0.65 thresholds).
const a1 = vsong('a1', [1, 0, 0]);
const a2 = vsong('a2', [0.99, 0.14, 0]); // cos(a1,a2) ~ 0.99
const a3 = vsong('a3', [0.98, 0, 0.2]); // cos(a1,a3) ~ 0.98
const b1 = vsong('b1', [0, 1, 0]);
const b2 = vsong('b2', [0.14, 0.99, 0]); // cos(b1,b2) ~ 0.99
const b3 = vsong('b3', [0, 0.98, 0.2]);
const c1 = vsong('c1', [0, 0, 1]);
const c2 = vsong('c2', [0.14, 0, 0.99]);
const c3 = vsong('c3', [0, 0.14, 0.99]);

const allClusterSongs = [a1, a2, a3, b1, b2, b3, c1, c2, c3];

function baseDeps(overrides: Partial<VibeQueueDeps> = {}): VibeQueueDeps {
  return {
    songs: allClusterSongs,
    feedback: noFeedback,
    rng: () => 0,
    ...overrides,
  };
}

describe('VibeQueue: lock vs drift centering', () => {
  test('lock mode always centers on the seed, ignoring lastPlayed', () => {
    const q = new VibeQueue(a1, 'lock', baseDeps());
    // Even when told the last-played song was from cluster B, lock must
    // stay centered on the seed (cluster A) and can only pick cluster-A songs.
    const pick = q.next(b1.song);
    expect(pick).not.toBeNull();
    expect(['a2', 'a3']).toContain(pick!.videoId);
  });

  test('drift mode recenters on lastPlayed and can cross clusters', () => {
    const q = new VibeQueue(a1, 'drift', baseDeps());
    // First call: lastPlayed is a cluster-B song, so drift recenters there
    // and should return another cluster-B song, never a cluster-A one.
    const pick = q.next(b1.song);
    expect(pick).not.toBeNull();
    expect(['b2', 'b3']).toContain(pick!.videoId);
  });

  test('label reflects the mode', () => {
    const lockQ = new VibeQueue(a1, 'lock', baseDeps());
    const driftQ = new VibeQueue(a1, 'drift', baseDeps());
    expect(lockQ.label).toBe('vibe:lock');
    expect(driftQ.label).toBe('vibe:drift');
  });

  test('setMode updates the label and future centering behavior', () => {
    const q = new VibeQueue(a1, 'lock', baseDeps());
    expect(q.label).toBe('vibe:lock');
    q.setMode('drift');
    expect(q.label).toBe('vibe:drift');
    const pick = q.next(b1.song);
    expect(['b2', 'b3']).toContain(pick!.videoId);
  });
});

describe('VibeQueue: recency suppression', () => {
  test('a just-picked song is not immediately re-picked under an rng that would otherwise favor it', () => {
    // Two same-cluster candidates equidistant from the seed; buildPool
    // preserves scope order, so with rng=0 (picks the first cumulative
    // band) the first next() call picks whichever comes first in `songs`.
    const twoCandidates = [a1, a2, a3];
    const q = new VibeQueue(a1, 'lock', baseDeps({songs: twoCandidates, rng: () => 0}));

    const first = q.next(null);
    expect(first).not.toBeNull();

    // Second call: same rng()=0. Without recency suppression this would
    // pick the same first-in-order candidate again. With recency, that
    // candidate's songsSince is now 0 => recencyFactor 0 => weight 0, so
    // the *other* candidate (still unplayed, recencyFactor 1) must win.
    const second = q.next(null);
    expect(second).not.toBeNull();
    expect(second!.videoId).not.toBe(first!.videoId);
  });
});

describe('VibeQueue: session bans', () => {
  test('rejectCurrent bans a song for the rest of the session', () => {
    const q = new VibeQueue(a1, 'lock', baseDeps({songs: [a1, a2, a3], rng: () => 0}));
    q.rejectCurrent('a2');
    // Only 'a3' remains as a non-banned, non-center candidate. Once it's
    // picked once, its own recency weight collapses to 0 (it's the only
    // pool entry, so total weight hits 0 too) -- this must fall through to
    // the random-fallback safety net rather than spuriously return null,
    // and 'a2' must never come back regardless of which tier answers.
    for (let i = 0; i < 5; i++) {
      const pick = q.next(null);
      expect(pick).not.toBeNull();
      expect(pick?.videoId).not.toBe('a2');
    }
  });
});

describe('VibeQueue: fallbacks', () => {
  const center = vsong('center', [1, 0]);

  test('relaxed fallback: pool empty at primary threshold, found at threshold-0.1', () => {
    // cos = 0.7: fails lock's 0.75 primary threshold but passes 0.65 relaxed.
    const mid = vsong('mid', [0.7, Math.sqrt(1 - 0.7 * 0.7)]);
    const onFallback = jest.fn();
    const q = new VibeQueue(center, 'lock', baseDeps({songs: [center, mid], rng: () => 0, onFallback}));
    const pick = q.next(null);
    expect(pick?.videoId).toBe('mid');
    expect(onFallback).toHaveBeenCalledWith('relaxed');
    expect(onFallback).not.toHaveBeenCalledWith('random');
  });

  test('auto-relax: an EXHAUSTED tight pool (all recently played) relaxes to a fresh song', () => {
    // tight (cos 0.95) is lock-eligible; mid (cos 0.70) only passes the relaxed
    // threshold. rng ~0.5 lands in the dominant weight -> the fresh song.
    const tight = vsong('tight', [0.95, Math.sqrt(1 - 0.95 * 0.95)]);
    const mid = vsong('mid', [0.7, Math.sqrt(1 - 0.7 * 0.7)]);
    const onFallback = jest.fn();
    const q = new VibeQueue(
      center,
      'lock',
      baseDeps({songs: [center, tight, mid], rng: () => 0.5, onFallback}),
    );
    // First pick: tight is a fresh lock-eligible song -> stay in the tight pool.
    expect(q.next(null)?.videoId).toBe('tight');
    // Now the tight pool is exhausted (tight was just played) -> relax and pull
    // in the fresh song instead of re-cycling 'tight'.
    expect(q.next(null)?.videoId).toBe('mid');
    expect(onFallback).toHaveBeenCalledWith('relaxed');
  });

  test('random fallback: still empty after relaxing, falls back to uniform random over scope minus bans', () => {
    // cos = 0.3: fails both lock's 0.75 and the relaxed 0.65 threshold.
    const far = vsong('far', [0.3, Math.sqrt(1 - 0.3 * 0.3)]);
    const onFallback = jest.fn();
    const q = new VibeQueue(center, 'lock', baseDeps({songs: [center, far], rng: () => 0, onFallback}));
    const pick = q.next(null);
    expect(pick?.videoId).toBe('far');
    expect(onFallback).toHaveBeenCalledWith('relaxed');
    expect(onFallback).toHaveBeenCalledWith('random');
  });

  test('scope minus bans empty => null (random fallback attempted but finds nothing)', () => {
    const onFallback = jest.fn();
    const q = new VibeQueue(center, 'lock', baseDeps({songs: [center], rng: () => 0, onFallback}));
    const pick = q.next(null);
    expect(pick).toBeNull();
    expect(onFallback).toHaveBeenCalledWith('relaxed');
    expect(onFallback).toHaveBeenCalledWith('random');
  });

  test('banned candidates are excluded from the random fallback too', () => {
    const far = vsong('far', [0.3, Math.sqrt(1 - 0.3 * 0.3)]);
    const q = new VibeQueue(center, 'lock', baseDeps({songs: [center, far], rng: () => 0}));
    q.rejectCurrent('far');
    const pick = q.next(null);
    expect(pick).toBeNull();
  });
});

describe('VibeQueue: determinism', () => {
  test('same seed/mode/deps/rng sequence produces the same pick sequence', () => {
    const run = () => {
      const q = new VibeQueue(a1, 'drift', baseDeps({rng: makeRng(42)}));
      const picks: Array<string | null> = [];
      let last: Song | null = null;
      for (let i = 0; i < 8; i++) {
        const pick = q.next(last);
        picks.push(pick?.videoId ?? null);
        last = pick;
      }
      return picks;
    };
    expect(run()).toEqual(run());
  });
});

describe('VibeQueue: reject recenter (drift)', () => {
  test('rejecting the current song in drift mode does not recenter the next pick on it', () => {
    const q = new VibeQueue(a1, 'drift', baseDeps());

    // First call: pretend lastPlayed is a cluster-B song (same setup as the
    // "drift mode recenters on lastPlayed" test above), so drift centers
    // there and returns a cluster-B pick. This is "X" -- the song that's
    // about to get rejected.
    const x = q.next(b1.song);
    expect(x).not.toBeNull();
    expect(['b2', 'b3']).toContain(x!.videoId);

    q.rejectCurrent(x!.videoId);

    // This mirrors the real bug: skipToNext() calls next(current), and
    // `current` at this point is X (the just-rejected song) -- controller.ts
    // doesn't know or care that X was just banned. Before the fix,
    // resolveCenter would happily center on X (it's in `byId`), so the next
    // pick would come from X's cluster (B) again -- i.e. the reject would
    // have no effect on where the vibe drifts to. With the fix, a
    // session-banned lastPlayed is ignored and resolveCenter walks history
    // backwards (skipping the now-banned X) to land back on the seed, so
    // the next pick must come from the seed's cluster (A), not X's (B).
    const pick = q.next(x!);
    expect(pick).not.toBeNull();
    expect(['a2', 'a3']).toContain(pick!.videoId);
  });
});

describe('VibeQueue: reset', () => {
  test('reset re-seeds the center for lock mode', () => {
    const q = new VibeQueue(a1, 'lock', baseDeps());
    q.reset(b1.song);
    const pick = q.next(null);
    expect(['b2', 'b3']).toContain(pick!.videoId);
  });

  test('reset throws when the seed is not in scope (no analysis data available)', () => {
    const q = new VibeQueue(a1, 'lock', baseDeps());
    expect(() => q.reset({videoId: 'unknown', title: 'x', artist: 'y', durationS: null, hasVibe: false})).toThrow();
  });
});

describe('VibeQueue: peekNext (commit-ahead for prefetch)', () => {
  test('lock mode commits an in-cluster candidate', () => {
    const q = new VibeQueue(a1, 'lock', baseDeps());
    const guess = q.peekNext();
    expect(guess).not.toBeNull();
    expect(['a2', 'a3']).toContain(guess!.videoId);
  });

  test('next() returns exactly the song peekNext committed (so the prefetch hits)', () => {
    const q = new VibeQueue(a1, 'lock', baseDeps({rng: makeRng(7)}));
    const committed = q.peekNext();
    expect(committed).not.toBeNull();
    // next() must return the SAME song peekNext promised -- that equality is
    // the whole point: the controller prefetched committed.videoId's stream.
    expect(q.next(null)?.videoId).toBe(committed!.videoId);
  });

  test('repeated peekNext returns the same committed pick (idempotent)', () => {
    const q = new VibeQueue(a1, 'lock', baseDeps({rng: makeRng(7)}));
    expect(q.peekNext()?.videoId).toBe(q.peekNext()?.videoId);
  });

  test('the committed pick still matches an un-peeked run (same rng => same next)', () => {
    // With and without a preceding peekNext, the first next() yields the same
    // song -- commit-ahead reorders WHEN the pick is computed, not WHICH.
    const withoutPeek = new VibeQueue(a1, 'lock', baseDeps({rng: makeRng(7)}));
    const first = withoutPeek.next(null);

    const withPeek = new VibeQueue(a1, 'lock', baseDeps({rng: makeRng(7)}));
    withPeek.peekNext();
    const firstAfterPeek = withPeek.next(null);

    expect(firstAfterPeek?.videoId).toBe(first?.videoId);
  });

  test('rejectCurrent discards the committed pick (reject must re-pick)', () => {
    const q = new VibeQueue(a1, 'lock', baseDeps());
    const committed = q.peekNext();
    q.rejectCurrent(committed!.videoId); // ban exactly the committed song
    // Since pending was cleared, next() re-picks and can never return the
    // now-banned song.
    const pick = q.next(null);
    expect(pick?.videoId).not.toBe(committed!.videoId);
  });

  test('setMode discards the committed pick', () => {
    const q = new VibeQueue(a1, 'lock', baseDeps({rng: makeRng(3)}));
    q.peekNext();
    q.setMode('drift'); // must clear pending
    // A fresh peek after the mode change re-commits (no crash, still valid).
    const after = q.peekNext();
    expect(after).not.toBeNull();
  });

  test('a no-op setMoodFilter(null) keeps the committed pick (PlayerScreen mount)', () => {
    // Regression: PlayerScreen re-asserts setMoodFilter(null) on mount right
    // after playFrom peeked+committed the next pick. That no-op must NOT discard
    // the pick, or the very first skip always misses the prefetch cache.
    const q = new VibeQueue(a1, 'lock', baseDeps({rng: makeRng(5)}));
    const committed = q.peekNext();
    q.setMoodFilter(null); // already null -> no real change
    expect(q.next(null)?.videoId).toBe(committed!.videoId);
  });

  test('a no-op setMode(sameMode) keeps the committed pick', () => {
    const q = new VibeQueue(a1, 'lock', baseDeps({rng: makeRng(5)}));
    const committed = q.peekNext();
    q.setMode('lock'); // already lock -> no change
    expect(q.next(null)?.videoId).toBe(committed!.videoId);
  });

  test('returns null when scope has no analyzable neighbors', () => {
    // Seed alone in scope -> no candidates at any threshold.
    const q = new VibeQueue(a1, 'lock', baseDeps({songs: [a1]}));
    expect(q.peekNext()).toBeNull();
  });
});
