import type { Pool } from "../db";
import type { LLMProvider } from "../llm/types";
import type { EmbeddingProvider } from "../embeddings/types";
import { parseQuery } from "./queryParse";
import { retrieveTurns } from "./retrieve";
import { streamAnswer } from "./answer";
import { time } from "./timing";
import type {
  ParsedQuery,
  RecallResult,
  RetrievalMode,
  StageTimings,
} from "./types";

// The five-stage query path, orchestrated and timed:
//   1. parse the question        ─┐ run in parallel
//      embed the question        ─┘
//   2. lexical search            ─┐ run in parallel (inside retrieveTurns)
//   3. vector search             ─┘
//   4. fuse (RRF)
//   5. answer (grounded, cited)
// Every stage is wall-clock timed into `timings`. If a time-filtered search
// returns nothing, the window is widened once and the search re-run, and the
// answer says so.

export interface RecallDeps {
  pool: Pool;
  llmProvider: LLMProvider;
  embeddingProvider: EmbeddingProvider;
}

export interface RecallOptions {
  mode?: RetrievalMode; // default "hybrid"
  topK?: number; // default 5
  now?: Date; // default new Date() — the reference for relative dates
  generateAnswer?: boolean; // default true; false = retrieval only (eval)
  onToken?: (t: string) => void; // stream sink for the answer
}

export async function runRecall(
  deps: RecallDeps,
  userId: string,
  question: string,
  opts: RecallOptions = {},
): Promise<RecallResult> {
  const mode = opts.mode ?? "hybrid";
  const topK = opts.topK ?? 5;
  const now = opts.now ?? new Date();
  const shouldAnswer = opts.generateAnswer !== false;
  const timings: StageTimings = {};

  // Stage 1 (parse) and the question embedding are independent; run both and
  // wait — search needs the filter from one and the vector from the other.
  const [parsed, questionEmbedding] = await Promise.all([
    time(timings, "parse", () => parseQuery(deps, question, now)),
    time(timings, "embed", async () => {
      const [embedding] = await deps.embeddingProvider.embed([question]);
      return embedding ?? null;
    }),
  ]);

  // Stages 2-4.
  let turns = await time(timings, "retrieve", () =>
    retrieveTurns(
      { pool: deps.pool },
      { userId, parsed, questionEmbedding, mode, topK },
    ),
  );

  // Widen once on an empty time-filtered result, then say so in the answer.
  let widened = false;
  if (turns.length === 0 && mode !== "hybrid_no_time") {
    const widenedQuery = widenWindow(parsed);
    if (widenedQuery) {
      widened = true;
      turns = await time(timings, "retrieve_widened", () =>
        retrieveTurns(
          { pool: deps.pool },
          { userId, parsed: widenedQuery, questionEmbedding, mode, topK },
        ),
      );
    }
  }

  // Stage 5.
  let answer: string | null = null;
  if (shouldAnswer) {
    if (turns.length === 0) {
      answer = "Not found in the retrieved turns.";
      timings.answer = 0;
    } else {
      const answerResult = await time(timings, "answer", () =>
        streamAnswer({ llmProvider: deps.llmProvider }, { question, turns }, opts.onToken),
      );
      answer = widened
        ? `(time window widened)\n${answerResult.text}`
        : answerResult.text;
      if (answerResult.firstTokenMs !== null) timings.answer_first_token = answerResult.firstTokenMs;
    }
  }

  return { question, parsed, turns, answer, timings, widened, mode };
}

// Double the time window by extending `start` earlier by its current span. Only
// possible when both bounds are known; otherwise there is nothing to widen.
function widenWindow(parsed: ParsedQuery): ParsedQuery | null {
  const timeRange = parsed.timeRange;
  if (!timeRange || !timeRange.start || !timeRange.end) return null;
  const start = new Date(timeRange.start).getTime();
  const end = new Date(timeRange.end).getTime();
  const durationMs = end - start;
  if (!(durationMs > 0)) return null;
  const newStart = new Date(start - durationMs).toISOString();
  return { ...parsed, timeRange: { start: newStart, end: timeRange.end } };
}
