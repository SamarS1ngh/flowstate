import {samplePick} from '../src/engine/sampler';

describe('samplePick', () => {
  test('rng=0 picks the first item (by cumulative weight)', () => {
    const items = [
      {item: 'a', weight: 1},
      {item: 'b', weight: 2},
      {item: 'c', weight: 3},
    ];
    expect(samplePick(items, () => 0)).toBe('a');
  });

  test('rng=0.999 picks the last item', () => {
    const items = [
      {item: 'a', weight: 1},
      {item: 'b', weight: 2},
      {item: 'c', weight: 3},
    ];
    expect(samplePick(items, () => 0.999)).toBe('c');
  });

  test('empty items => null', () => {
    expect(samplePick([], () => 0.5)).toBeNull();
  });

  test('all-zero weights => null', () => {
    const items = [
      {item: 'a', weight: 0},
      {item: 'b', weight: 0},
    ];
    expect(samplePick(items, () => 0.5)).toBeNull();
  });

  test('non-positive total weight => null', () => {
    const items = [{item: 'a', weight: -1}];
    expect(samplePick(items, () => 0.5)).toBeNull();
  });

  test('honors strict cumulative-weight bands', () => {
    const items = [
      {item: 'a', weight: 1}, // cumulative 1
      {item: 'b', weight: 2}, // cumulative 3
      {item: 'c', weight: 3}, // cumulative 6
    ];
    // total=6; r=3 exactly falls on b's boundary (cumulative 3 is not > 3),
    // so it should roll into c's band.
    expect(samplePick(items, () => 0.5)).toBe('c');
    // r=2.9 lands inside b's band (cumulative after b = 3 > 2.9).
    expect(samplePick(items, () => 2.9 / 6)).toBe('b');
  });

  test('clamps to the last item when float drift walks r past the final cumulative', () => {
    const items = [
      {item: 'a', weight: 1},
      {item: 'b', weight: 1},
    ];
    // rng() = 1 => r = total exactly; cumulative (2) is never strictly > r (2).
    expect(samplePick(items, () => 1)).toBe('b');
  });

  test('weighted proportionality via a seeded sweep', () => {
    const items = [
      {item: 'a', weight: 1},
      {item: 'b', weight: 3},
    ];
    const N = 1000;
    let aCount = 0;
    let bCount = 0;
    for (let i = 0; i < N; i++) {
      const r = (i + 0.5) / N; // deterministic sweep across [0,1)
      const pick = samplePick(items, () => r);
      if (pick === 'a') aCount++;
      else if (pick === 'b') bCount++;
    }
    expect(aCount + bCount).toBe(N);
    expect(aCount / N).toBeCloseTo(0.25, 1);
    expect(bCount / N).toBeCloseTo(0.75, 1);
  });
});
