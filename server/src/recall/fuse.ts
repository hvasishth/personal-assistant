import type { ScoredTurn } from "./types";

export const DEFAULT_RRF_K = 60; // spec's starting dampening constant

export interface WeightedList {
  list: ScoredTurn[];
  weight: number;
}

// Reciprocal Rank Fusion over several pre-ranked lists. Each list contributes
// weight/(k + rank) per id, where rank is 0-based list position; ids appearing
// in several lists accumulate. Because only rank matters, the lexical and
// vector score scales (ts_rank vs cosine) never need reconciling. Returns the
// fused ids, best-first.
export function reciprocalRankFusion(
  lists: WeightedList[],
  k: number = DEFAULT_RRF_K,
): string[] {
  const score = new Map<string, number>();
  for (const { list, weight } of lists) {
    list.forEach((hit, rank) => {
      score.set(hit.id, (score.get(hit.id) ?? 0) + weight / (k + rank));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
