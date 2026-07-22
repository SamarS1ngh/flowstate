import {
  recencyFactor,
  decayedCount,
  feedbackBias,
  composeWeight,
  FeedbackData,
} from '../src/engine/weights';

describe('recencyFactor', () => {
  test('(5) = 0.04', () => {
    expect(recencyFactor(5)).toBeCloseTo(0.04);
  });

  test('at the horizon (25) = 1', () => {
    expect(recencyFactor(25)).toBe(1);
  });

  test('beyond the horizon (30) = 1', () => {
    expect(recencyFactor(30)).toBe(1);
  });

  test('Infinity = 1', () => {
    expect(recencyFactor(Infinity)).toBe(1);
  });

  test('0 = 0', () => {
    expect(recencyFactor(0)).toBe(0);
  });

  test('respects a custom horizon', () => {
    expect(recencyFactor(5, 10)).toBeCloseTo(0.25); // (5/10)^2
    expect(recencyFactor(10, 10)).toBe(1);
    expect(recencyFactor(20, 10)).toBe(1);
  });
});

describe('decayedCount', () => {
  const DAY = 86400000;

  test('halves after 30 days', () => {
    expect(decayedCount(10, 0, 30 * DAY)).toBeCloseTo(5);
  });

  test('quarters after 60 days', () => {
    expect(decayedCount(10, 0, 60 * DAY)).toBeCloseTo(2.5);
  });

  test('no decay at the same timestamp', () => {
    expect(decayedCount(10, 1000, 1000)).toBeCloseTo(10);
  });

  test('never grows / never negative when now precedes lastAt', () => {
    const result = decayedCount(10, 30 * DAY, 0);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(10);
  });
});

describe('feedbackBias', () => {
  const noFeedback: FeedbackData = {
    pairCount: () => 0,
    songCount: () => 0,
    struckNeighbors: () => [],
  };
  const zeroSim = () => 0;

  test('no feedback at all => 1', () => {
    expect(feedbackBias('center', 'cand', noFeedback, zeroSim)).toBe(1);
  });

  test('pair-hit applies 0.1^n', () => {
    const fb: FeedbackData = {
      pairCount: (from, rejected) => (from === 'center' && rejected === 'cand' ? 2 : 0),
      songCount: () => 0,
      struckNeighbors: () => [],
    };
    expect(feedbackBias('center', 'cand', fb, zeroSim)).toBeCloseTo(0.01); // 0.1^2
  });

  test('song-strike applies 0.5^n', () => {
    const fb: FeedbackData = {
      pairCount: () => 0,
      songCount: rejected => (rejected === 'cand' ? 3 : 0),
      struckNeighbors: () => [],
    };
    expect(feedbackBias('center', 'cand', fb, zeroSim)).toBeCloseTo(0.125); // 0.5^3
  });

  test('pair and song strikes combine multiplicatively', () => {
    const fb: FeedbackData = {
      pairCount: () => 1,
      songCount: () => 1,
      struckNeighbors: () => [],
    };
    expect(feedbackBias('center', 'cand', fb, zeroSim)).toBeCloseTo(0.05); // 0.1 * 0.5
  });

  test('neighborhood rule: candidate near a struck song, center near the rejecter => x0.6', () => {
    const fb: FeedbackData = {
      pairCount: () => 0,
      songCount: () => 0,
      struckNeighbors: () => [{rejectedId: 'r1', fromId: 'from1'}],
    };
    const simTo = (a: string, b: string) => {
      if (a === 'cand' && b === 'r1') return 0.95;
      if (a === 'center' && b === 'from1') return 0.85;
      return 0;
    };
    expect(feedbackBias('center', 'cand', fb, simTo)).toBeCloseTo(0.6);
  });

  test('neighborhood rule: null fromId only needs candidate-rejected similarity', () => {
    const fb: FeedbackData = {
      pairCount: () => 0,
      songCount: () => 0,
      struckNeighbors: () => [{rejectedId: 'r1', fromId: null}],
    };
    const simTo = (a: string, b: string) => (a === 'cand' && b === 'r1' ? 0.95 : 0);
    expect(feedbackBias('center', 'cand', fb, simTo)).toBeCloseTo(0.6);
  });

  test('neighborhood rule does not apply when candidate-rejected sim is at/below 0.9', () => {
    const fb: FeedbackData = {
      pairCount: () => 0,
      songCount: () => 0,
      struckNeighbors: () => [{rejectedId: 'r1', fromId: 'from1'}],
    };
    const simTo = (a: string, b: string) =>
      a === 'cand' && b === 'r1' ? 0.9 : a === 'center' && b === 'from1' ? 0.85 : 0;
    expect(feedbackBias('center', 'cand', fb, simTo)).toBe(1);
  });

  test('neighborhood rule does not apply when center-fromId sim is at/below 0.8', () => {
    const fb: FeedbackData = {
      pairCount: () => 0,
      songCount: () => 0,
      struckNeighbors: () => [{rejectedId: 'r1', fromId: 'from1'}],
    };
    const simTo = (a: string, b: string) =>
      a === 'cand' && b === 'r1' ? 0.95 : a === 'center' && b === 'from1' ? 0.8 : 0;
    expect(feedbackBias('center', 'cand', fb, simTo)).toBe(1);
  });

  test('neighborhood rule applies at most once across multiple matching neighbors', () => {
    const fb: FeedbackData = {
      pairCount: () => 0,
      songCount: () => 0,
      struckNeighbors: () => [
        {rejectedId: 'r1', fromId: null},
        {rejectedId: 'r2', fromId: null},
      ],
    };
    const simTo = (a: string, b: string) => (a === 'cand' && (b === 'r1' || b === 'r2') ? 0.95 : 0);
    expect(feedbackBias('center', 'cand', fb, simTo)).toBeCloseTo(0.6); // not 0.36
  });

  test('neighborhood check is skipped entirely when songCount > 0', () => {
    const fb: FeedbackData = {
      pairCount: () => 0,
      songCount: rejected => (rejected === 'cand' ? 1 : 0), // -> x0.5
      struckNeighbors: () => [{rejectedId: 'r1', fromId: null}],
    };
    const simTo = (a: string, b: string) => (a === 'cand' && b === 'r1' ? 0.95 : 0);
    // Should be 0.5 only, NOT 0.5 * 0.6 -- the "ELSE" branch means neighborhood
    // is only consulted when songCount is 0.
    expect(feedbackBias('center', 'cand', fb, simTo)).toBeCloseTo(0.5);
  });
});

describe('composeWeight', () => {
  test('spot value: sim=.9, recency=1, bias=1 => 0.6561', () => {
    expect(composeWeight(0.9, 1, 1)).toBeCloseTo(0.6561);
  });

  test('zero similarity => 0', () => {
    expect(composeWeight(0, 1, 1)).toBe(0);
  });

  test('multiplies all three factors together', () => {
    expect(composeWeight(1, 0.5, 0.5)).toBeCloseTo(0.25);
  });
});
