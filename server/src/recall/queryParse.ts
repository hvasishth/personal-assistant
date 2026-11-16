import type { ChatMessage, LLMProvider } from "../llm/types";
import type { ParsedQuery } from "./types";
import { completeText } from "./llm";
import { log } from "../logger";

// Stage 1: a small model turns the raw question into a fixed JSON filter. It is
// the cheapest place to resolve "last week" into two dates and to pull out the
// exact terms the lexical side needs. Every field is optional; on any failure
// we fall back to "no filter, semantic = the raw question" so the pipeline
// degrades rather than breaks.

const PARSE_MODEL = "claude-haiku-5-5";

export interface ParseDeps {
  provider: LLMProvider;
}

export async function parseQuery(
  deps: ParseDeps,
  question: string,
  now: Date,
): Promise<ParsedQuery> {
  const today = now.toISOString().slice(0, 10);
  const prompt: ChatMessage[] = [
    {
      role: "user",
      content:
        "You convert a question about someone's own conversation history into " +
        "a JSON search filter. Today is " +
        today +
        ". Resolve relative dates (\"last week\", \"yesterday\") to absolute " +
        "YYYY-MM-DD using today's date. Reply with ONLY this JSON, no prose:\n" +
        "{\n" +
        '  "time_range": { "start": "YYYY-MM-DD" | null, "end": "YYYY-MM-DD" | null } | null,\n' +
        '  "people": string[],\n' +
        '  "surfaces": string[],      // any of "text", "voice", "notes"\n' +
        '  "key_terms": string[],     // exact words/names/codenames to match literally\n' +
        '  "semantic_query": string   // the intent, in natural language\n' +
        "}\n" +
        "Use null for time_range when no time is implied. `end` is EXCLUSIVE " +
        "(the day after the last day meant).\n\nQuestion: " +
        question,
    },
  ];

  try {
    const raw = await completeText(deps.provider, prompt, {
      model: PARSE_MODEL,
      maxTokens: 400,
    });
    return normalize(raw, question);
  } catch (err) {
    log.warn("query parse failed, using fallback:", err);
    return fallback(question);
  }
}

function fallback(question: string): ParsedQuery {
  return {
    timeRange: null,
    people: [],
    surfaces: [],
    keyTerms: [],
    semanticQuery: question,
  };
}

function strArray(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

// YYYY-MM-DD -> an ISO timestamp at UTC midnight, which is how the DB compares.
function toTs(day: unknown): string | null {
  if (typeof day !== "string") return null;
  const m = day.match(/^\d{4}-\d{2}-\d{2}$/);
  if (!m) return null;
  return `${day}T00:00:00Z`;
}

function normTimeRange(x: unknown): ParsedQuery["timeRange"] {
  if (x === null || x === undefined) return null;
  if (typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const start = toTs(o.start);
  const end = toTs(o.end);
  if (start === null && end === null) return null;
  return { start, end };
}

function normalize(raw: string, question: string): ParsedQuery {
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return fallback(question);
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const semantic =
      typeof o.semantic_query === "string" && o.semantic_query.trim().length > 0
        ? o.semantic_query.trim()
        : question;
    return {
      timeRange: normTimeRange(o.time_range),
      people: strArray(o.people),
      surfaces: strArray(o.surfaces).filter(
        (s) => s === "text" || s === "voice" || s === "notes",
      ),
      keyTerms: strArray(o.key_terms),
      semanticQuery: semantic,
    };
  } catch {
    return fallback(question);
  }
}
