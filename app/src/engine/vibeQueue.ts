import {Song} from '../types';
import {QueueSource} from '../player/queue';
import {VibeSong, buildPool, cosine} from './similarity';
import {FeedbackData, recencyFactor, feedbackBias, composeWeight} from './weights';
import {samplePick} from './sampler';

export type VibeMode = 'lock' | 'drift';

const LOCK_THRESHOLD = 0.75;
const DRIFT_THRESHOLD = 0.65;
const RELAX_DELTA = 0.1;
// Same horizon recencyFactor uses to fully stop suppressing a song. Reused
// here so the uniform-random fallback doesn't immediately replay something
// the weighted path was actively suppressing.
const RECENCY_HORIZON = 25;

export interface VibeQueueDeps {
  songs: VibeSong[]; // analyzed songs in scope
  feedback: FeedbackData;
  rng?: () => number;
  onFallback?: (kind: 'relaxed' | 'random') => void;
}

export class VibeQueue implements QueueSource {
  label: string;

  private seed: VibeSong;
  private mode: VibeMode;
  private readonly songs: VibeSong[];
  private readonly byId: Map<string, VibeSong>;
  private readonly feedback: FeedbackData;
  private readonly rng: () => number;
  private readonly onFallback?: (kind: 'relaxed' | 'random') => void;
  private moodFilter: {key: string; min: number} | null = null;
  private readonly sessionBans = new Set<string>();
  // Ordered play-history: seed + every song returned by next(). Used only
  // for recencyFactor's songsSince lookup -- never mutated by lastPlayed.
  private history: VibeSong[];
  // The next pick committed by peekNext() (for stream prefetch), consumed by
  // next(). Cleared whenever the state it was picked under changes (reject,
  // mode, mood filter, reset) so a stale pick is never played.
  private pending: {song: VibeSong; kind: 'primary' | 'relaxed' | 'random'} | null = null;

  constructor(seed: VibeSong, mode: VibeMode, deps: VibeQueueDeps) {
    this.seed = seed;
    this.mode = mode;
    this.songs = deps.songs;
    this.feedback = deps.feedback;
    this.rng = deps.rng ?? Math.random;
    this.onFallback = deps.onFallback;
    this.history = [seed];

    this.byId = new Map();
    for (const s of deps.songs) this.byId.set(s.videoId, s);
    this.byId.set(seed.videoId, seed);

    this.label = VibeQueue.labelFor(mode);
  }

  private static labelFor(mode: VibeMode): string {
    return mode === 'lock' ? 'vibe:lock' : 'vibe:drift';
  }

  setMoodFilter(f: {key: string; min: number} | null): void {
    const prev = this.moodFilter;
    const changed = (prev?.key ?? null) !== (f?.key ?? null) || (prev?.min ?? null) !== (f?.min ?? null);
    this.moodFilter = f;
    // Only a REAL filter change invalidates the committed next pick. PlayerScreen
    // re-asserts setMoodFilter(null) on mount even when it's already null; clearing
    // unconditionally there would discard the pick peekNext just committed for the
    // prefetch, so the first skip would always miss the cache.
    if (changed) this.pending = null;
  }

  setMode(m: VibeMode): void {
    const changed = m !== this.mode;
    this.mode = m;
    this.label = VibeQueue.labelFor(m);
    if (changed) this.pending = null; // lock/drift changes the center -> re-pick
  }

  rejectCurrent(rejectedId: string): void {
    // Session-ban only; persisting the reject (FeedbackStore.recordReject)
    // is the caller's job -- see the VibeQueueDeps.feedback seam, which is
    // refreshed by the caller between vibe sessions, not by this class.
    this.sessionBans.add(rejectedId);
    this.pending = null; // the committed next pick may be the just-rejected vibe
  }

  next(lastPlayed: Song | null): Song | null {
    // If peekNext() already committed the next pick (to warm the stream
    // prefetch), honor it so the prefetched song is the one that actually
    // plays -- otherwise a weighted-random re-pick here would almost never
    // match what was prefetched, defeating instant skips. rejectCurrent /
    // setMode / setMoodFilter / reset clear `pending`, so a committed pick is
    // only ever used while it's still valid for the current center/filters.
    if (this.pending) {
      const picked = this.pending;
      this.pending = null;
      // Re-fire the fallback status that producing this pick would have
      // emitted, since peekNext() computed it silently.
      if (picked.kind !== 'primary') this.onFallback?.(picked.kind);
      this.history.push(picked.song);
      return picked.song.song;
    }
    const center = this.resolveCenter(lastPlayed);
    const picked = this.pickFrom(center, false);
    if (!picked) return null;
    this.history.push(picked.song);
    return picked.song.song;
  }

  // Shared pick logic for both next() and peekNext(): weighted pick at the
  // primary threshold, then a relaxed retry, then a uniform-random fallback.
  // `silent` suppresses the onFallback callbacks so peekNext() (which runs
  // ahead of playback) doesn't flash a stale "relaxed/random" status; next()
  // re-emits it from the committed pick's `kind` when the song actually plays.
  private pickFrom(
    center: VibeSong,
    silent: boolean,
  ): {song: VibeSong; kind: 'primary' | 'relaxed' | 'random'} | null {
    const primaryThreshold = this.mode === 'lock' ? LOCK_THRESHOLD : DRIFT_THRESHOLD;
    let picked = this.attemptWeightedPick(center, primaryThreshold);
    if (picked) return {song: picked, kind: 'primary'};
    if (!silent) this.onFallback?.('relaxed');
    picked = this.attemptWeightedPick(center, primaryThreshold - RELAX_DELTA);
    if (picked) return {song: picked, kind: 'relaxed'};
    if (!silent) this.onFallback?.('random');
    picked = this.randomFallback(center);
    if (picked) return {song: picked, kind: 'random'};
    return null;
  }

  reset(seed: Song): void {
    const found = this.byId.get(seed.videoId);
    if (!found) {
      throw new Error(
        `VibeQueue.reset: song ${seed.videoId} has no analysis data in scope`,
      );
    }
    this.seed = found;
    this.history = [found];
    this.pending = null; // new seed -> discard any committed next pick
  }

  private resolveCenter(lastPlayed: Song | null): VibeSong {
    if (this.mode === 'lock') return this.seed;
    // A session-banned lastPlayed (i.e. the song the caller just rejected
    // via rejectCurrent, then immediately called next() with it as
    // lastPlayed -- see PlayerScreen's onDoesntFit) must never become the
    // drift center: that would recenter the whole vibe on the very song the
    // user just said doesn't fit. Ignore it and fall through to the
    // history-walk below instead.
    if (lastPlayed && !this.sessionBans.has(lastPlayed.videoId)) {
      const found = this.byId.get(lastPlayed.videoId);
      if (found) return found;
    }
    // Walk history backwards looking for the most recent non-banned entry
    // -- covers both "lastPlayed was banned" above and the pre-existing
    // lastPlayed-missing/unknown case. history's last entry is exactly what
    // rejectCurrent may have just banned, so this must skip banned ids
    // rather than blindly returning history[history.length - 1].
    for (let i = this.history.length - 1; i >= 0; i--) {
      const candidate = this.history[i];
      if (!this.sessionBans.has(candidate.videoId)) return candidate;
    }
    // Entire history is banned (pathological/small-scope edge case) --
    // the seed itself is never banned (rejectCurrent only ever bans songs
    // that were actually played), so it's always a safe last resort.
    return this.seed;
  }

  private weightedCandidates(
    center: VibeSong,
    threshold: number,
  ): Array<{item: VibeSong; weight: number}> {
    // The center itself is excluded structurally by buildPool (it skips
    // candidate.videoId === center.videoId), so the ban set only needs the
    // session-rejected ids.
    const pool = buildPool(center, this.songs, {
      threshold,
      moodFilter: this.moodFilter ?? undefined,
      banned: this.sessionBans,
    });
    if (pool.length === 0) return [];

    const simTo = (a: string, b: string): number => {
      const songA = this.byId.get(a);
      const songB = this.byId.get(b);
      if (!songA || !songB) return 0;
      return cosine(songA.embedding, songB.embedding);
    };

    return pool.map(({song, sim}) => ({
      item: song,
      weight: composeWeight(
        sim,
        recencyFactor(this.songsSince(song.videoId)),
        feedbackBias(center.videoId, song.videoId, this.feedback, simTo),
      ),
    }));
  }

  private attemptWeightedPick(center: VibeSong, threshold: number): VibeSong | null {
    const weighted = this.weightedCandidates(center, threshold);
    if (weighted.length === 0) return null;
    return samplePick(weighted, this.rng);
  }

  // Commit the actual next pick ahead of time so the controller can prefetch
  // its stream and the skip is instant (see QueueSource.peekNext). Unlike a
  // best-effort guess, this runs the SAME weighted-random pick next() would,
  // caches it in `pending`, and next() returns that exact song -- so the
  // prefetched stream is always the one that plays. Center is resolved from
  // the current history head (the song now playing), matching what next() will
  // see as lastPlayed on the coming skip. Idempotent: repeated peeks return the
  // same committed pick. Cleared by reject/mode/mood/reset so a committed pick
  // is never played after the state it was picked under changed.
  peekNext(): Song | null {
    if (!this.pending) {
      this.pending = this.pickFrom(this.resolveCenter(null), true);
    }
    return this.pending?.song.song ?? null;
  }

  private randomFallback(center: VibeSong): VibeSong | null {
    const banned = this.sessionBans;
    const historyTail = this.historyTailSet();

    let candidates = this.songs.filter(
      s => s.videoId !== center.videoId && !banned.has(s.videoId) && !historyTail.has(s.videoId),
    );
    if (candidates.length === 0) {
      // The tail exclusion ate every option (small scope, lots of replays)
      // -- fall back further and just avoid bans/center, per the contract
      // that next() only returns null when scope-minus-bans is empty.
      candidates = this.songs.filter(s => s.videoId !== center.videoId && !banned.has(s.videoId));
    }
    if (candidates.length === 0) return null;

    const idx = Math.min(candidates.length - 1, Math.floor(this.rng() * candidates.length));
    return candidates[idx];
  }

  private historyTailSet(): Set<string> {
    const set = new Set<string>();
    for (const s of this.songs) {
      if (this.songsSince(s.videoId) < RECENCY_HORIZON) set.add(s.videoId);
    }
    return set;
  }

  private songsSince(videoId: string): number {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].videoId === videoId) return this.history.length - 1 - i;
    }
    return Infinity;
  }
}
