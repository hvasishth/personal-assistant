// Shared types for the recall pipeline (Step 6).
//
// The recall pipeline answers "what did we decide about X last week?" over the
// turn corpus: parse the question into a filter, run time-filtered lexical and
// vector search in parallel, fuse them, and answer with citations. These types
// are the vocabulary the stages pass between each other.

// The structured query a small model extracts from the raw question (stage 1).
// Every field is nullable/empty-able: the model fills what it can. Relative
// dates ("last week") are resolved to absolute ISO dates before this is used.
export interface ParsedQuery {
  // Absolute, inclusive-start / exclusive-end ISO timestamps, or null for "no
  // time constraint".
  timeRange: { start: string | null; end: string | null } | null;
  people: string[]; // names mentioned; reserved for future speaker filtering
  surfaces: string[]; // 'text' | 'voice' | 'notes' filters, empty = any
  keyTerms: string[]; // exact terms for the lexical side
  semanticQuery: string; // the natural-language intent for the vector side
}

// One turn as stored in the corpus, hydrated for ranking and for the answer
// prompt. Mirrors the `messages` row plus its conversation's title.
export interface TurnRow {
  id: string;
  conversationId: string;
  conversationTitle: string | null;
  seq: number | null;
  speaker: string; // the message role: 'user' | 'assistant' | 'notes' | ...
  surface: string;
  ts: string; // created_at, the time filter / display timestamp
  text: string;
}

// A single (id, score) result from one ranked list, before fusion.
export interface ScoredTurn {
  id: string;
  score: number; // ts_rank_cd for lexical, (1 - cosine distance) for vector
}

// Which retrieval strategy to run — the pipeline uses "hybrid"; the eval
// harness runs all four to produce the ablation table.
export type RetrievalMode =
  | "hybrid"
  | "vector"
  | "lexical"
  | "hybrid_no_time";

// Per-stage wall-clock timings in milliseconds, keyed by stage name.
export type StageTimings = Record<string, number>;

// The full result of one recall query.
export interface RecallResult {
  question: string;
  parsed: ParsedQuery | null; // null if parsing was skipped/failed
  turns: TurnRow[]; // the fused top-k, hydrated
  answer: string | null; // the grounded answer, or null if the answer stage was skipped
  timings: StageTimings;
  widened: boolean; // true if the time window was widened once on an empty result
  mode: RetrievalMode;
}
