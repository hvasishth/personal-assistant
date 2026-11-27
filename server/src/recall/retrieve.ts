import type { Pool } from "../db";
import {
  searchTurnsLexical,
  searchTurnsVector,
  hydrateTurns,
  type TimeRange,
} from "./repo";
import { reciprocalRankFusion, DEFAULT_RRF_K } from "./fuse";
import type { ParsedQuery, RetrievalMode, TurnRow } from "./types";

export const PER_SOURCE = 50; // spec: top 50 from each search before fusion

export interface RetrieveDeps {
  pool: Pool;
}

export interface RetrieveArgs {
  userId: string;
  parsed: ParsedQuery;
  questionEmbedding: number[] | null;
  mode: RetrievalMode;
  topK: number;
}

// The lexical side matches exact terms; prefer the model's key_terms, falling
// back to the semantic query when it extracted none.
function lexicalText(parsed: ParsedQuery): string {
  return parsed.keyTerms.length > 0
    ? parsed.keyTerms.join(" ")
    : parsed.semanticQuery;
}

// hybrid_no_time is the ablation that drops the time filter; every other mode
// keeps whatever the parser produced.
function filtersFor(
  parsed: ParsedQuery,
  mode: RetrievalMode,
): { timeRange: TimeRange | null; surfaces: string[] } {
  return {
    timeRange: mode === "hybrid_no_time" ? null : parsed.timeRange,
    surfaces: parsed.surfaces,
  };
}

// Stages 2+3 (the two searches, in parallel) and stage 4 (RRF fusion). Which
// searches run depends on the mode, so the eval harness can ablate each side.
// Returns the fused top-k, hydrated into full turns.
export async function retrieveTurns(
  deps: RetrieveDeps,
  args: RetrieveArgs,
): Promise<TurnRow[]> {
  const { pool } = deps;
  const filters = filtersFor(args.parsed, args.mode);
  const wantLexical = args.mode !== "vector";
  const wantVector = args.mode !== "lexical" && args.questionEmbedding !== null;

  const [lexicalHits, vectorHits] = await Promise.all([
    wantLexical
      ? searchTurnsLexical(pool, args.userId, lexicalText(args.parsed), filters, PER_SOURCE)
      : Promise.resolve([]),
    wantVector && args.questionEmbedding
      ? searchTurnsVector(pool, args.userId, args.questionEmbedding, filters, PER_SOURCE)
      : Promise.resolve([]),
  ]);

  const fusedIds = reciprocalRankFusion(
    [
      { list: lexicalHits, weight: 1 },
      { list: vectorHits, weight: 1 },
    ],
    DEFAULT_RRF_K,
  ).slice(0, args.topK);

  return hydrateTurns(pool, fusedIds);
}
