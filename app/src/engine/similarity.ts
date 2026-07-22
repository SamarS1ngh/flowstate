import {Song} from '../types';

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface VibeSong {
  videoId: string;
  embedding: Float32Array;
  moods: Record<string, number>;
  // Seam added in Task 2: VibeQueue.next() must return a full Song (title,
  // artist, etc.) to satisfy QueueSource, but the engine itself stays pure
  // and never touches this field -- it exists purely as a payload carried
  // alongside the analysis data.
  song: Song;
}

export function buildPool(
  center: VibeSong,
  candidates: VibeSong[],
  opts: {
    threshold: number;
    moodFilter?: {key: string; min: number};
    banned: Set<string>;
  },
): Array<{song: VibeSong; sim: number}> {
  const result: Array<{song: VibeSong; sim: number}> = [];
  for (const candidate of candidates) {
    if (candidate.videoId === center.videoId) continue;
    if (opts.banned.has(candidate.videoId)) continue;
    if (opts.moodFilter) {
      const value = candidate.moods[opts.moodFilter.key];
      if (value === undefined || value < opts.moodFilter.min) continue;
    }
    const sim = cosine(center.embedding, candidate.embedding);
    if (sim < opts.threshold) continue;
    result.push({song: candidate, sim});
  }
  return result;
}
