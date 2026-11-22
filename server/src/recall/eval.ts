// The evaluation harness — what turns this from a demo into evidence. For a set
// of golden questions (each paired with the turn ids that answer it), it runs
// the four retrieval ablations and reports recall@1, recall@5 and MRR side by
// side, plus per-stage latency (median and p95). Answer correctness stays a
// human judgement; pass `withAnswers` to print the generated answers for grading.
//
// A golden question may pin its own `filter` (a fixed ParsedQuery). When present
// the harness uses it verbatim instead of calling the LLM parser, so the
// retrieval ablation is deterministic and reproducible — parse quality is a
// separate axis, measured elsewhere, not re-sampled on every eval run.

import type { Pool } from "../db";
import type { LLMProvider } from "../llm/types";
import type { EmbeddingProvider } from "../embeddings/types";
import { parseQuery } from "./queryParse";
import { retrieveTurns } from "./retrieve";
import { streamAnswer } from "./answer";
import { percentile } from "./timing";
import type { ParsedQuery, RetrievalMode } from "./types";

const TOP_K = 5;
const MODES: RetrievalMode[] = ["vector", "lexical", "hybrid", "hybrid_no_time"];

// A fixed filter a golden question can pin to make retrieval deterministic.
export interface GoldenFilter {
  timeRange?: { start: string | null; end: string | null } | null;
  keyTerms?: string[];
  surfaces?: string[];
  semanticQuery?: string;
}

export interface GoldenQuestion {
  question: string;
  expectedTurnIds?: string[];
  filter?: GoldenFilter; // pin the parse to isolate the retrieval ablation
}

export interface EvalDeps {
  pool: Pool;
  provider: LLMProvider;
  embeddings: EmbeddingProvider;
}

export interface ModeRecall {
  mode: RetrievalMode;
  scored: number; // questions that had expected ids to score against
  recallAt1: number;
  recallAt5: number;
  mrr: number; // mean reciprocal rank of the first relevant hit (within top 5)
}

export interface EvalResult {
  total: number;
  unscored: number; // questions with no expected ids (timed but not recall-scored)
  modes: ModeRecall[];
  latency: Record<string, { p50: number; p95: number }>;
  answers: { question: string; answer: string }[]; // empty unless withAnswers
}

function parsedFromFilter(q: GoldenQuestion): ParsedQuery {
  const f = q.filter ?? {};
  return {
    timeRange: f.timeRange ?? null,
    people: [],
    surfaces: f.surfaces ?? [],
    keyTerms: f.keyTerms ?? [],
    semanticQuery: f.semanticQuery ?? q.question,
  };
}

// Rank (0-based) of the first expected id in the retrieved list, or -1.
function firstHitRank(turnIds: string[], expected: string[]): number {
  for (let i = 0; i < turnIds.length; i++) {
    if (expected.includes(turnIds[i]!)) return i;
  }
  return -1;
}

export async function runEval(
  deps: EvalDeps,
  userId: string,
  golden: GoldenQuestion[],
  opts: { now?: Date; withAnswers?: boolean } = {},
): Promise<EvalResult> {
  const now = opts.now ?? new Date();
  const zero = (): Record<RetrievalMode, number> => ({
    vector: 0,
    lexical: 0,
    hybrid: 0,
    hybrid_no_time: 0,
  });
  const hits1 = zero();
  const hits5 = zero();
  const rrSum = zero();
  let scored = 0;
  const stageSamples: Record<string, number[]> = {};
  const answers: { question: string; answer: string }[] = [];

  const sample = (stage: string, ms: number): void => {
    (stageSamples[stage] ??= []).push(ms);
  };

  for (const q of golden) {
    // Parse (or use the pinned filter) + embed once per question, shared across
    // all four modes — the modes differ only in which indexes they hit and
    // whether the time filter applies.
    let parsed: ParsedQuery;
    if (q.filter) {
      parsed = parsedFromFilter(q);
    } else {
      const tParse = Date.now();
      parsed = await parseQuery(deps, q.question, now);
      sample("parse", Date.now() - tParse);
    }

    const tEmbed = Date.now();
    const [embedding] = await deps.embeddings.embed([q.question]);
    sample("embed", Date.now() - tEmbed);

    const expected = q.expectedTurnIds ?? [];
    const willScore = expected.length > 0;
    if (willScore) scored += 1;

    for (const mode of MODES) {
      const tRetrieve = Date.now();
      const turns = await retrieveTurns(
        { pool: deps.pool },
        { userId, parsed, questionEmbedding: embedding ?? null, mode, topK: TOP_K },
      );
      if (mode === "hybrid") sample("retrieve", Date.now() - tRetrieve);

      if (willScore) {
        const rank = firstHitRank(turns.map((t) => t.id), expected);
        if (rank === 0) hits1[mode] += 1;
        if (rank !== -1) {
          hits5[mode] += 1;
          rrSum[mode] += 1 / (rank + 1);
        }
      }

      // Generate an answer once per question (hybrid only) when asked.
      if (mode === "hybrid" && opts.withAnswers) {
        if (turns.length > 0) {
          const tAns = Date.now();
          const res = await streamAnswer(
            { provider: deps.provider },
            { question: q.question, turns },
          );
          sample("answer", Date.now() - tAns);
          if (res.firstTokenMs !== null) sample("answer_first_token", res.firstTokenMs);
          answers.push({ question: q.question, answer: res.text });
        } else {
          answers.push({ question: q.question, answer: "Not found in the retrieved turns." });
        }
      }
    }
  }

  const modes: ModeRecall[] = MODES.map((mode) => ({
    mode,
    scored,
    recallAt1: scored > 0 ? hits1[mode] / scored : 0,
    recallAt5: scored > 0 ? hits5[mode] / scored : 0,
    mrr: scored > 0 ? rrSum[mode] / scored : 0,
  }));

  const latency: Record<string, { p50: number; p95: number }> = {};
  for (const [stage, xs] of Object.entries(stageSamples)) {
    latency[stage] = { p50: percentile(xs, 50), p95: percentile(xs, 95) };
  }

  return {
    total: golden.length,
    unscored: golden.length - scored,
    modes,
    latency,
    answers,
  };
}

// Render the eval result as plain-text tables for the terminal.
export function formatEval(r: EvalResult): string {
  const lines: string[] = [];
  lines.push(`Golden questions: ${r.total}  (scored: ${r.total - r.unscored}, unscored: ${r.unscored})`);
  lines.push("");
  lines.push("Ablation (scored questions only)");
  lines.push("  mode             recall@1   recall@5    MRR");
  for (const m of r.modes) {
    const r1 = (m.recallAt1 * 100).toFixed(0).padStart(3);
    const r5 = (m.recallAt5 * 100).toFixed(0).padStart(3);
    const mrr = m.mrr.toFixed(2);
    lines.push(`  ${m.mode.padEnd(15)}  ${r1}%       ${r5}%      ${mrr}`);
  }
  lines.push("");
  lines.push("Latency (ms)");
  lines.push("  stage                p50     p95");
  for (const [stage, v] of Object.entries(r.latency)) {
    lines.push(`  ${stage.padEnd(19)}  ${String(v.p50).padStart(4)}   ${String(v.p95).padStart(4)}`);
  }
  if (r.answers.length > 0) {
    lines.push("");
    lines.push("Answers (judge correctness yourself):");
    for (const a of r.answers) {
      lines.push(`\n  Q: ${a.question}\n  A: ${a.answer.replace(/\n/g, "\n     ")}`);
    }
  }
  return lines.join("\n");
}
