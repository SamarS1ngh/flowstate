// FeedbackStore itself is a thin op-sqlite adapter and isn't unit-tested
// here (native dependency) -- but the row-assembly logic it delegates to
// (turning raw feedback_pair/feedback_song rows into a decayed FeedbackData)
// is nontrivial pure logic, so it's extracted and tested directly.
import {buildFeedbackData, PairRow, SongRow} from '../src/engine/feedbackStore';

const DAY = 86400000;

describe('buildFeedbackData', () => {
  test('no rows at all => zero counts, no struck neighbors', () => {
    const fb = buildFeedbackData([], [], 0);
    expect(fb.pairCount('a', 'b')).toBe(0);
    expect(fb.songCount('b')).toBe(0);
    expect(fb.struckNeighbors()).toEqual([]);
  });

  test('pairCount looks up the exact (fromId, rejectedId) row and pre-decays it', () => {
    const pairRows: PairRow[] = [{from_id: 'center', rejected_id: 'cand', count: 10, last_at: 0}];
    const fb = buildFeedbackData(pairRows, [], 30 * DAY);
    expect(fb.pairCount('center', 'cand')).toBeCloseTo(5); // halved after 30 days
    expect(fb.pairCount('other', 'cand')).toBe(0);
  });

  test('songCount looks up the rejected_id row and pre-decays it', () => {
    const songRows: SongRow[] = [{rejected_id: 'cand', count: 8, last_at: 0}];
    const fb = buildFeedbackData([], songRows, 30 * DAY);
    expect(fb.songCount('cand')).toBeCloseTo(4);
    expect(fb.songCount('other')).toBe(0);
  });

  test('struckNeighbors lists distinct (rejectedId, fromId) pairs from feedback_pair rows', () => {
    const pairRows: PairRow[] = [
      {from_id: 'x', rejected_id: 'r1', count: 1, last_at: 0},
      {from_id: 'y', rejected_id: 'r2', count: 1, last_at: 0},
    ];
    const fb = buildFeedbackData(pairRows, [], 0);
    expect(fb.struckNeighbors().sort((a, b) => a.rejectedId.localeCompare(b.rejectedId))).toEqual([
      {rejectedId: 'r1', fromId: 'x'},
      {rejectedId: 'r2', fromId: 'y'},
    ]);
  });

  test('struckNeighbors lists feedback_song rows with a null fromId', () => {
    const songRows: SongRow[] = [{rejected_id: 'r1', count: 1, last_at: 0}];
    const fb = buildFeedbackData([], songRows, 0);
    expect(fb.struckNeighbors()).toEqual([{rejectedId: 'r1', fromId: null}]);
  });

  test('struckNeighbors combines both tables and de-duplicates identical entries', () => {
    const pairRows: PairRow[] = [{from_id: 'x', rejected_id: 'r1', count: 1, last_at: 0}];
    const songRows: SongRow[] = [{rejected_id: 'r1', count: 1, last_at: 0}];
    const fb = buildFeedbackData(pairRows, songRows, 0);
    // Same (rejectedId, fromId) pair listed twice in the same table collapses
    // to one entry; distinct fromId values (here: 'x' vs null) both survive.
    expect(fb.struckNeighbors().sort((a, b) => String(a.fromId).localeCompare(String(b.fromId)))).toEqual([
      {rejectedId: 'r1', fromId: null},
      {rejectedId: 'r1', fromId: 'x'},
    ]);
  });

  test('duplicate rows for the same key in one table collapse to a single neighbor entry', () => {
    const pairRows: PairRow[] = [
      {from_id: 'x', rejected_id: 'r1', count: 1, last_at: 0},
      {from_id: 'x', rejected_id: 'r1', count: 1, last_at: 0},
    ];
    const fb = buildFeedbackData(pairRows, [], 0);
    expect(fb.struckNeighbors()).toEqual([{rejectedId: 'r1', fromId: 'x'}]);
  });

  test('pairCount and songCount are independent of each other', () => {
    const pairRows: PairRow[] = [{from_id: 'center', rejected_id: 'cand', count: 2, last_at: 0}];
    const songRows: SongRow[] = [{rejected_id: 'cand', count: 3, last_at: 0}];
    const fb = buildFeedbackData(pairRows, songRows, 0);
    expect(fb.pairCount('center', 'cand')).toBeCloseTo(2);
    expect(fb.songCount('cand')).toBeCloseTo(3);
  });
});
