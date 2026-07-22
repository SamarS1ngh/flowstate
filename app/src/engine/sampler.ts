export function samplePick<T>(
  items: Array<{item: T; weight: number}>,
  rng: () => number,
): T | null {
  if (items.length === 0) return null;

  let total = 0;
  for (const {weight} of items) total += weight;
  if (total <= 0) return null;

  const r = rng() * total;
  let cumulative = 0;
  for (const {item, weight} of items) {
    cumulative += weight;
    if (cumulative > r) return item;
  }
  // Float drift walked r past the final cumulative sum -- clamp to the last item.
  return items[items.length - 1].item;
}
