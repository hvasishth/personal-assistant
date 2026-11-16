import type { ChatMessage } from "../llm/types";
import type { EmbeddingProvider } from "../embeddings/types";
import type { Pool } from "../db";
import type { MessageRow } from "../conversations/repo";
import { searchSimilarFacts, searchFactsByText, type FactRow } from "./repo";

// Retrieval + prompt assembly (Step 5). Turns the stored history + the user's
// new message into the ChatMessage[] handed to the model.
//
// Design: NO LLM calls on this path — retrieval runs before the model can start
// streaming, so every call here is pure time-to-first-token. We embed the query
// once, run vector + lexical search concurrently, and fuse them. We lean on a
// real embedding provider (Voyage) to bridge synonyms (e.g. "color" -> "teal");
// the fake provider is lexical-only, so semantic recall is weak under it.

export interface RetrievalDeps {
  pool: Pool;
  embeddings: EmbeddingProvider;
}

export interface RetrievalArgs {
  userId: string;
  conversationId: string;
  history: MessageRow[];
  userMessage: string;
}

const PER_SOURCE = 8; // facts pulled from each search
const MAX_FACTS = 6; // facts that survive fusion into the prompt
const RRF_K = 60; // Reciprocal Rank Fusion dampening constant (standard default)

export async function buildPromptMessages(
  deps: RetrievalDeps,
  args: RetrievalArgs,
): Promise<ChatMessage[]> {
  const facts = await retrieveFacts(deps, args.userId, args.userMessage);
  return [
    { role: "system", content: buildSystemPrompt(facts) },
    ...toChatMessages(args.history),
  ];
}

// Hybrid retrieval: one embedding call, vector + lexical search in parallel,
// fused. The vector search needs the embedding, so it follows the Promise.all.
async function retrieveFacts(
  deps: RetrievalDeps,
  userId: string,
  query: string,
): Promise<string[]> {
  const [embedded, lexical] = await Promise.all([
    deps.embeddings.embed([query]),
    searchFactsByText(deps.pool, userId, query, PER_SOURCE),
  ]);
  const qvec = embedded[0];
  const semantic = qvec
    ? await searchSimilarFacts(deps.pool, userId, qvec, PER_SOURCE)
    : [];
  return fuse([semantic, lexical], MAX_FACTS);
}

// Reciprocal Rank Fusion over several ranked lists: each list votes 1/(k + rank)
// for a fact, and a fact appearing in several lists accumulates. Dedupes by id
// and is scale-agnostic, so cosine distance and ts_rank combine without having
// to normalize their very different score ranges. Returns the top-n contents.
function fuse(lists: FactRow[][], n: number): string[] {
  const score = new Map<string, number>();
  const content = new Map<string, string>();
  for (const list of lists) {
    list.forEach((f, rank) => {
      score.set(f.id, (score.get(f.id) ?? 0) + 1 / (RRF_K + rank));
      content.set(f.id, f.content);
    });
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id]) => content.get(id)!);
}

function buildSystemPrompt(facts: string[]): string {
  const base =
    "You are a helpful personal assistant. Answer the user's latest message " +
    "using the conversation so far and the known facts about the user below. " +
    "If the facts don't cover something, answer normally — never invent facts.";
  if (facts.length === 0) return base;
  const block = facts.map((f) => `- ${f}`).join("\n");
  return `${base}\n\nKnown facts about the user:\n${block}`;
}

// History rows -> the model's message shape. We only ever store 'user' and
// 'assistant' turns, so anything else is treated as 'user'.
export function toChatMessages(history: MessageRow[]): ChatMessage[] {
  return history.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));
}
