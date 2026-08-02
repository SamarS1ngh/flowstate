import {Song} from '../types';

export interface QueueSource {
  label: string;
  next(lastPlayed: Song | null): Song | null;
  reset(seed: Song): void;
  // Optional, non-mutating "what's coming up" preview (Player screen's
  // Up Next list). Deliberately optional: a source whose next() is
  // non-deterministic (VibeQueue picks weighted-random each call, and
  // calling next() just to peek would consume/mutate its history) has no
  // honest deterministic answer, so it simply doesn't implement this rather
  // than fabricate one. Callers must feature-detect with `?.`.
  peekUpcoming?(count: number): Song[];
  // Optional, non-mutating best-effort guess at the single most-likely next
  // song, used ONLY to warm the stream-URL prefetch cache (controller.ts) so a
  // skip feels instant. Unlike peekUpcoming this is NOT shown to the user, so a
  // stochastic source may return its most-probable candidate even though its
  // real next() might pick differently -- a wrong guess just causes a harmless
  // prefetch-cache miss (the skip resolves fresh, exactly as before). Deterministic
  // sources (SimpleQueue) always guess right.
  peekNext?(): Song | null;
}

export class SimpleQueue implements QueueSource {
  label = 'playlist order';
  private idx: number;

  constructor(private songs: Song[], startIndex: number) {
    this.idx = startIndex;
  }

  next(_lastPlayed: Song | null): Song | null {
    this.idx += 1;
    return this.idx < this.songs.length ? this.songs[this.idx] : null;
  }

  reset(seed: Song): void {
    const i = this.songs.findIndex(s => s.videoId === seed.videoId);
    this.idx = i >= 0 ? i : 0;
  }

  // Playlist order is fully deterministic and known up front, so this can
  // just slice ahead of the current index -- no mutation of `idx`.
  peekUpcoming(count: number): Song[] {
    return this.songs.slice(this.idx + 1, this.idx + 1 + count);
  }

  peekNext(): Song | null {
    return this.songs[this.idx + 1] ?? null;
  }
}
