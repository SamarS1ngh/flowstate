import {Song} from '../types';

// Serializable snapshot of a queue source, enough to rebuild an equivalent one
// after the app is killed (see player/session.ts). It deliberately does NOT try
// to capture a stochastic source's exact history -- a vibe session re-seeds off
// the restored song and re-runs the model, and radio regenerates from the API.
export type SourceDescriptor =
  | {kind: 'radio'}
  | {kind: 'vibe'; mode: 'drift' | 'lock'; moodFilter: {key: string; min: number} | null}
  | {kind: 'simple'; songs: Song[]; index: number};

export interface QueueSource {
  label: string;
  next(lastPlayed: Song | null): Song | null;
  reset(seed: Song): void;
  // A serializable descriptor of this source, used to persist and later rebuild
  // the session (player/session.ts). Every source must implement it.
  describe(): SourceDescriptor;
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

  describe(): SourceDescriptor {
    return {kind: 'simple', songs: this.songs, index: this.idx};
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
