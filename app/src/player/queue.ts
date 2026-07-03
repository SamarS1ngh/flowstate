import {Song} from '../types';

export interface QueueSource {
  label: string;
  next(lastPlayed: Song | null): Song | null;
  reset(seed: Song): void;
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
}
