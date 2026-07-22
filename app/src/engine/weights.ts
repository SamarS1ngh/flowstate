export function recencyFactor(songsSince: number, horizon: number = 25): number {
  if (songsSince === Infinity || songsSince >= horizon) return 1;
  return Math.min(1, Math.pow(songsSince / horizon, 2));
}

export interface FeedbackData {
  pairCount(fromId: string, rejectedId: string): number; // already-decayed count
  songCount(rejectedId: string): number; // already-decayed count
  struckNeighbors(): Array<{rejectedId: string; fromId: string | null}>;
}

export function decayedCount(count: number, lastAtMs: number, nowMs: number): number {
  const days = Math.max(0, (nowMs - lastAtMs) / 86400000);
  return count * Math.pow(0.5, days / 30);
}

export function feedbackBias(
  centerId: string,
  candidateId: string,
  fb: FeedbackData,
  simTo: (a: string, b: string) => number,
): number {
  let bias = 1.0;

  const pairHits = fb.pairCount(centerId, candidateId);
  if (pairHits > 0) {
    bias *= Math.pow(0.1, pairHits);
  }

  const songHits = fb.songCount(candidateId);
  if (songHits > 0) {
    bias *= Math.pow(0.5, songHits);
  } else {
    for (const neighbor of fb.struckNeighbors()) {
      const candidateNearRejected = simTo(candidateId, neighbor.rejectedId) > 0.9;
      const centerNearRejecter =
        neighbor.fromId === null || simTo(centerId, neighbor.fromId) > 0.8;
      if (candidateNearRejected && centerNearRejecter) {
        bias *= 0.6;
        break; // apply at most once
      }
    }
  }

  return bias;
}

export function composeWeight(sim: number, recency: number, bias: number): number {
  return Math.pow(sim, 4) * recency * bias;
}
