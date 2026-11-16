// The evaluation harness — what turns this from a demo into evidence. For a set
// of golden questions (each paired with the turn ids that answer it), it runs
// the four retrieval ablations and reports recall@5 side by side, plus per-stage
// latency (median and p95). Answer correctness stays a human judgement; pass
// `withAnswers` to print the generated answers for grading.

import type { Pool } from "../db";
import type { LLMProvider } from "../llm/types";
import type { EmbeddingProvider } from "../embeddings/types";
import { parseQuery } from "./queryParse";
import { retrieveTurns } from "./retrieve";
import { streamAnswer } from "./answer";
import { percentile } from "./timing";
import type { RetrievalMode } from "./types";

const TOP_K = 5;
const MODES: RetrievalMode[] = ["vector", "lexical", "hybrid", "hybrid_no_time"];

export interface GoldenQuestion {
  question: string;
  expectedTurnIds?: string[];
}

export interface EvalDeps {
  pool: Pool;
  provider: LLMProvider;
  embeddings: EmbeddingProvider;
}

export interface ModeRecall {
  mode: RetrievalMode;
  hits: number; // questions whose expected turn was in the top 5
  scored: number; // questions that had expected ids to score against
  recallAt5: number; // hits / scored
}

export interface EvalResult {
  total: number;
  unscored: number; // questions with no expected ids (timed but not recall-scored)
  modes: ModeRecall[];
  latency: Record<string, { p50: number; p95: number }>;
  answers: { question: string; answer: string }[]; // empty unless withAnswers
}

export async function runEval(
  deps: EvalDeps,
  userId: string,
  golden: GoldenQuestion[],
  opts: { now?: Date; withAnswers?: boolean } = {},
): Promise<EvalResult> {
  const now = opts.now ?? new Date();
  const hits: Record<RetrievalMode, number> = {
    vector: 0,
    lexical: 0,
    hybrid: 0,
    hybrid_no_time: 0,
  };
  let scored = 0;
  const stageSamples: Record<string, number[]> = {};
  const answers: { question: string; answer: string }[] = [];

  const sample = (stage: string, ms: number): void => {
    (stageSamples[stage] ??= []).push(ms);
  };

  for (const q of golden) {
    // Parse + embed once per question, shared across all four modes (the modes
    // differ only in which indexes they hit and whether the time filter applies).
    const tParse = Date.now();
    const parsed = await parseQuery(deps, q.question, now);
    sample("parse", Date.now() - tParse);

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
        const hit = turns.some((t) => expected.includes(t.id));
        if (hit) hits[mode] += 1;
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
    hits: hits[mode],
    scored,
    recallAt5: scored > 0 ? hits[mode] / scored : 0,
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

// Render the eval result as two plain-text tables for the terminal.
export function formatEval(r: EvalResult): string {
  const lines: string[] = [];
  lines.push(`Golden questions: ${r.total}  (scored: ${r.total - r.unscored}, unscored: ${r.unscored})`);
  lines.push("");
  lines.push("Ablation — recall@5");
  lines.push("  mode             recall@5   hits/scored");
  for (const m of r.modes) {
    const pct = (m.recallAt5 * 100).toFixed(0).padStart(3);
    lines.push(`  ${m.mode.padEnd(15)}  ${pct}%       ${m.hits}/${m.scored}`);
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
