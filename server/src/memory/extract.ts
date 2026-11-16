import type { ChatMessage, LLMProvider } from "../llm/types";
import type { EmbeddingProvider } from "../embeddings/types";
import type { Pool } from "../db";
import { insertFact, searchSimilarFacts } from "./repo";
import { log } from "../logger";

// The ingestion half of the memory pipeline (boilerplate; the retrieval half is
// in memory/retrieval.ts). Given a user message, it:
//   1. asks a cheap model to extract durable facts worth remembering,
//   2. embeds each fact,
//   3. reconciles against existing facts (skip near-duplicates),
//   4. stores the new ones.
// It runs in the background, fired-and-forgotten from the chat route, so it is
// best-effort: it owns all its errors and never rejects.

const EXTRACT_MODEL = "claude-haiku-5-5";

// Facts closer than this cosine distance to one we already have are treated as
// already-known and skipped. This is the simplest "reconcile" — add-or-skip.
// A smarter version could update/merge the existing fact; left as a refinement.
const DUPLICATE_DISTANCE = 0.05;

export interface MemoryDeps {
  pool: Pool;
  provider: LLMProvider;
  embeddings: EmbeddingProvider;
}

export async function extractAndStoreFacts(
  deps: MemoryDeps,
  args: { userId: string; content: string; sourceMessageId?: string },
): Promise<void> {
  try {
    const facts = await extractFacts(deps.provider, args.content);
    if (facts.length === 0) return;

    const vectors = await deps.embeddings.embed(facts);
    for (let i = 0; i < facts.length; i++) {
      const content = facts[i]!;
      const embedding = vectors[i];
      if (!embedding) continue;

      // Reconcile: skip if we already know something almost identical.
      const [nearest] = await searchSimilarFacts(
        deps.pool,
        args.userId,
        embedding,
        1,
      );
      if (nearest && nearest.distance < DUPLICATE_DISTANCE) continue;

      await insertFact(deps.pool, {
        userId: args.userId,
        content,
        embedding,
        sourceMessageId: args.sourceMessageId,
      });
    }
  } catch (err) {
    log.warn("fact extraction failed:", err);
  }
}

// Ask a cheap model for durable, standalone facts about the user. Returns [] on
// nothing-to-remember or any parse failure.
async function extractFacts(
  provider: LLMProvider,
  message: string,
): Promise<string[]> {
  const prompt: ChatMessage[] = [
    {
      role: "user",
      content:
        "Extract durable facts worth remembering about the user from the " +
        "message below — stable preferences, personal details, goals. Ignore " +
        "small talk and one-off requests. Reply with a JSON array of short, " +
        'standalone fact strings (e.g. ["The user prefers teal", "The user is ' +
        'learning TypeScript"]). If there is nothing worth remembering, reply ' +
        "with []. Reply with ONLY the JSON array.\n\nMessage: " + message,
    },
  ];

  let text = "";
  for await (const ev of provider.streamChat(prompt, {
    model: EXTRACT_MODEL,
    maxTokens: 256,
  })) {
    if (ev.type === "text") text += ev.text;
    else if (ev.type === "error") return [];
  }
  return parseFacts(text);
}

// Pull the first JSON array out of the model's reply (tolerating stray prose or
// code fences) and keep the non-empty strings.
function parseFacts(raw: string): string[] {
  const json = raw.match(/\[[\s\S]*\]/)?.[0];
  if (!json) return [];
  try {
    const arr: unknown = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((s) => s.trim());
  } catch {
    return [];
  }
}
