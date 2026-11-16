// Minimal wall-clock timing for the recall pipeline and eval harness.
import type { StageTimings } from "./types";

// Run a stage and record its duration (ms) under `label`. The timing is
// recorded even if the stage throws, so a partial run still shows where time
// went.
export async function time<T>(
  timings: StageTimings,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    timings[label] = Date.now() - start;
  }
}

// p50 (median) and p95 for the latency tables. Nearest-rank, no interpolation —
// enough for a golden set of ~20.
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}
