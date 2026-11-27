import type { ChatMessage } from "../llm/types";
import type { EmbeddingProvider } from "../embeddings/types";
import type { Pool } from "../db";
import type { MessageRow } from "../conversations/repo";
import { searchSimilarFacts, searchFactsByText, type FactRow } from "./repo";

// Retrieval + prompt assembly (Step 5). Turns the stored history + the user's
// new message into the ChatMessage[] handed to the model.
//
// This runs on the time-to-first-token path: the retrieved facts go into the
// system prompt, so the model can't start streaming until retrieval returns.
// We keep it to a single embedding round-trip plus the DB searches — no LLM
// call here (an LLM query-rewrite is a deliberate future step, not forbidden).
// We lean on a real embedding provider (Voyage) to bridge synonyms (e.g.
// "color" -> "teal"); the fake provider is lexical-only, so semantic recall is
// weak under it.
//
// Query contextualization: a follow-up like "and for dinner?" is a weak query
// on its own. So we retrieve against TWO semantic queries — the current message
// (clean, full weight) and a window of recent user turns (backfill, reduced
// weight) — plus lexical search on the current message, and fuse all three with
// weighted RRF. The current message dominates; the context surfaces facts the
// bare follow-up would miss, without the dilution of blending both into one
// embedding.

export interface RetrievalDeps {
  pool: Pool;
  embeddingProvider: EmbeddingProvider;
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
const CONTEXT_TURNS = 3; // recent user turns used as retrieval context
const CONTEXT_WEIGHT = 0.5; // context hits count this much vs the live message (1.0)

export async function buildPromptMessages(
  deps: RetrievalDeps,
  args: RetrievalArgs,
): Promise<ChatMessage[]> {
  const facts = await retrieveFacts(deps, args);
  return [
    { role: "system", content: buildSystemPrompt(facts) },
    ...toChatMessages(args.history),
  ];
}

// Hybrid, context-aware retrieval. One embedding call covers the current
// message and the recent-context window; the two vector searches and the
// lexical search run concurrently; everything is fused with weighted RRF.
// Lexical search stays on the current message alone — plainto_tsquery ANDs its
// terms, so folding context in would over-constrain it to near-zero matches.
async function retrieveFacts(
  deps: RetrievalDeps,
  args: RetrievalArgs,
): Promise<string[]> {
  const { userId, userMessage } = args;
  const recentContext = recentUserContext(args.history, userMessage);

  const [queryEmbeddings, lexicalMatches] = await Promise.all([
    deps.embeddingProvider.embed(recentContext ? [userMessage, recentContext] : [userMessage]),
    searchFactsByText(deps.pool, userId, userMessage, PER_SOURCE),
  ]);
  const messageEmbedding = queryEmbeddings[0];
  const contextEmbedding = recentContext ? queryEmbeddings[1] : undefined;

  const [messageMatches, contextMatches] = await Promise.all([
    messageEmbedding ? searchSimilarFacts(deps.pool, userId, messageEmbedding, PER_SOURCE) : [],
    contextEmbedding ? searchSimilarFacts(deps.pool, userId, contextEmbedding, PER_SOURCE) : [],
  ]);

  return fuse(
    [
      { list: messageMatches, weight: 1 }, // the live message — primary intent
      { list: lexicalMatches, weight: 1 }, // exact-term hits on the live message
      { list: contextMatches, weight: CONTEXT_WEIGHT }, // recent context — backfill
    ],
    MAX_FACTS,
  );
}

interface RankedList {
  list: FactRow[];
  weight: number;
}

// Weighted Reciprocal Rank Fusion over several ranked lists: each list votes
// weight/(k + rank) for a fact, and a fact appearing in several lists
// accumulates. Dedupes by id and is scale-agnostic, so cosine distance and
// ts_rank combine without normalizing their very different score ranges. The
// per-list weight lets context hits count for less than live-message hits.
// Returns the top-n contents.
function fuse(lists: RankedList[], limit: number): string[] {
  const scores = new Map<string, number>();
  const contentById = new Map<string, string>();
  for (const { list, weight } of lists) {
    list.forEach((f, rank) => {
      scores.set(f.id, (scores.get(f.id) ?? 0) + weight / (RRF_K + rank));
      contentById.set(f.id, f.content);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => contentById.get(id)!);
}

// The recent user turns that give a short follow-up its meaning. The current
// message is already the last user row in history (it's persisted before
// retrieval runs), so drop it — it's retrieved on its own — and return the few
// turns before it. Empty on the first turn of a conversation.
function recentUserContext(
  history: MessageRow[],
  currentMessage: string,
): string {
  const userTurns = history
    .filter((m) => m.role === "user")
    .map((m) => m.content);
  if (userTurns[userTurns.length - 1] === currentMessage) userTurns.pop();
  return userTurns.slice(-CONTEXT_TURNS).join("\n");
}

function buildSystemPrompt(facts: string[]): string {
  const instructions =
    "You are a helpful personal assistant. Answer the user's latest message " +
    "using the conversation so far and the known facts about the user below. " +
    "If the facts don't cover something, answer normally — never invent facts.";
  if (facts.length === 0) return instructions;
  const factList = facts.map((f) => `- ${f}`).join("\n");
  return `${instructions}\n\nKnown facts about the user:\n${factList}`;
}

// History rows -> the model's message shape. We only ever store 'user' and
// 'assistant' turns, so anything else is treated as 'user'.
export function toChatMessages(history: MessageRow[]): ChatMessage[] {
  return history.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));
}
