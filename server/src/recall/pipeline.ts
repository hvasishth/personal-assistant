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
  provider: LLMProvider;
  embeddings: EmbeddingProvider;
}

export interface RecallOptions {
  mode?: RetrievalMode; // default "hybrid"
  topK?: number; // default 5
  now?: Date; // default new Date() — the reference for relative dates
  answer?: boolean; // default true; false = retrieval only (eval)
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
  const wantAnswer = opts.answer !== false;
  const timings: StageTimings = {};

  // Stage 1 (parse) and the question embedding are independent; run both and
  // wait — search needs the filter from one and the vector from the other.
  const [parsed, embedding] = await Promise.all([
    time(timings, "parse", () => parseQuery(deps, question, now)),
    time(timings, "embed", async () => {
      const [vec] = await deps.embeddings.embed([question]);
      return vec ?? null;
    }),
  ]);

  // Stages 2-4.
  let turns = await time(timings, "retrieve", () =>
    retrieveTurns(
      { pool: deps.pool },
      { userId, parsed, questionEmbedding: embedding, mode, topK },
    ),
  );

  // Widen once on an empty time-filtered result, then say so in the answer.
  let widened = false;
  if (turns.length === 0 && mode !== "hybrid_no_time") {
    const wider = widenWindow(parsed);
    if (wider) {
      widened = true;
      turns = await time(timings, "retrieve_widened", () =>
        retrieveTurns(
          { pool: deps.pool },
          { userId, parsed: wider, questionEmbedding: embedding, mode, topK },
        ),
      );
    }
  }

  // Stage 5.
  let answer: string | null = null;
  if (wantAnswer) {
    if (turns.length === 0) {
      answer = "Not found in the retrieved turns.";
      timings.answer = 0;
    } else {
      const res = await time(timings, "answer", () =>
        streamAnswer({ provider: deps.provider }, { question, turns }, opts.onToken),
      );
      answer = widened
        ? `(time window widened)\n${res.text}`
        : res.text;
      if (res.firstTokenMs !== null) timings.answer_first_token = res.firstTokenMs;
    }
  }

  return { question, parsed, turns, answer, timings, widened, mode };
}

// Double the time window by extending `start` earlier by its current span. Only
// possible when both bounds are known; otherwise there is nothing to widen.
function widenWindow(parsed: ParsedQuery): ParsedQuery | null {
  const tr = parsed.timeRange;
  if (!tr || !tr.start || !tr.end) return null;
  const start = new Date(tr.start).getTime();
  const end = new Date(tr.end).getTime();
  const span = end - start;
  if (!(span > 0)) return null;
  const newStart = new Date(start - span).toISOString();
  return { ...parsed, timeRange: { start: newStart, end: tr.end } };
}
