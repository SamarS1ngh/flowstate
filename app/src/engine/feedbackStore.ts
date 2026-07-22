import type {DB} from '@op-engineering/op-sqlite';
import {FeedbackData, decayedCount} from './weights';

// Raw row shapes, one per feedback table (see ensureTables for the schema).
export interface PairRow {
  from_id: string;
  rejected_id: string;
  count: number;
  last_at: number;
}

export interface SongRow {
  rejected_id: string;
  count: number;
  last_at: number;
}

// YouTube video ids never contain a space, so joining on one gives a
// collision-free composite key for the pair-count lookup map.
function pairKey(fromId: string, rejectedId: string): string {
  return fromId + '|' + rejectedId;
}

// Pure assembly: turns raw table rows into a FeedbackData whose counts are
// pre-decayed as of `nowMs` (the feedback tables are tiny, so decaying
// everything up front is cheap and keeps FeedbackData itself trivial).
// Extracted from FeedbackStore.snapshot so it can be unit-tested without a
// real op-sqlite database.
export function buildFeedbackData(pairRows: PairRow[], songRows: SongRow[], nowMs: number): FeedbackData {
  const pairMap = new Map<string, number>();
  for (const r of pairRows) {
    pairMap.set(pairKey(r.from_id, r.rejected_id), decayedCount(r.count, r.last_at, nowMs));
  }

  const songMap = new Map<string, number>();
  for (const r of songRows) {
    songMap.set(r.rejected_id, decayedCount(r.count, r.last_at, nowMs));
  }

  const neighborKeys = new Set<string>();
  const neighbors: Array<{rejectedId: string; fromId: string | null}> = [];
  const addNeighbor = (rejectedId: string, fromId: string | null) => {
    const key = (fromId ?? '') + '|' + rejectedId;
    if (neighborKeys.has(key)) return;
    neighborKeys.add(key);
    neighbors.push({rejectedId, fromId});
  };
  for (const r of pairRows) addNeighbor(r.rejected_id, r.from_id);
  for (const r of songRows) addNeighbor(r.rejected_id, null);

  return {
    pairCount: (fromId, rejectedId) => pairMap.get(pairKey(fromId, rejectedId)) ?? 0,
    songCount: rejectedId => songMap.get(rejectedId) ?? 0,
    struckNeighbors: () => neighbors,
  };
}

// Thin op-sqlite adapter; all decision logic (decay, bias, weighting) stays
// in weights.ts / vibeQueue.ts. This class only knows how to read and write
// the two feedback tables.
export class FeedbackStore {
  constructor(private db: DB) {}

  ensureTables(): void {
    this.db.executeSync(
      `CREATE TABLE IF NOT EXISTS feedback_pair (
         from_id TEXT NOT NULL,
         rejected_id TEXT NOT NULL,
         count INTEGER NOT NULL,
         last_at INTEGER NOT NULL,
         PRIMARY KEY (from_id, rejected_id)
       )`,
    );
    this.db.executeSync(
      `CREATE TABLE IF NOT EXISTS feedback_song (
         rejected_id TEXT PRIMARY KEY,
         count INTEGER NOT NULL,
         last_at INTEGER NOT NULL
       )`,
    );
  }

  recordReject(fromId: string | null, rejectedId: string, nowMs: number): void {
    this.db.executeSync(
      `INSERT INTO feedback_song (rejected_id, count, last_at) VALUES (?, 1, ?)
       ON CONFLICT(rejected_id) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
      [rejectedId, nowMs],
    );
    if (fromId !== null) {
      this.db.executeSync(
        `INSERT INTO feedback_pair (from_id, rejected_id, count, last_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(from_id, rejected_id) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
        [fromId, rejectedId, nowMs],
      );
    }
  }

  snapshot(nowMs: number): FeedbackData {
    const pairRows = this.db.executeSync(`SELECT from_id, rejected_id, count, last_at FROM feedback_pair`)
      .rows as unknown as PairRow[];
    const songRows = this.db.executeSync(`SELECT rejected_id, count, last_at FROM feedback_song`)
      .rows as unknown as SongRow[];
    return buildFeedbackData(pairRows, songRows, nowMs);
  }
}
