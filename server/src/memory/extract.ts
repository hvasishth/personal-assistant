import type { ChatMessage, LLMProvider } from "../llm/types";
import type { EmbeddingProvider } from "../embeddings/types";
import type { Pool } from "../db";
import { insertFact, searchSimilarLiveFacts, supersedeFact } from "./repo";
import { log } from "../logger";

// The ingestion half of the memory pipeline (the retrieval half is in
// memory/retrieval.ts). Given a user message, it:
//   1. asks a cheap model to extract durable facts, each with a SUBJECT,
//   2. embeds each fact,
//   3. reconciles against existing LIVE facts: skip near-duplicates, and when a
//      new fact concerns the same subject as an older one, SUPERSEDE the old
//      row (kept for history) so retrieval only ever sees the current truth,
//   4. stores the new ones.
// It runs in the background, fired-and-forgotten from the chat route, so it is
// best-effort: it owns all its errors and never rejects.

const EXTRACT_MODEL = "claude-haiku-5-5";

// Facts closer than this cosine distance to a live one are treated as already
// known and skipped (no new row, no supersession).
const DUPLICATE_DISTANCE = 0.05;

export interface MemoryDeps {
  pool: Pool;
  provider: LLMProvider;
  embeddings: EmbeddingProvider;
}

interface ExtractedFact {
  subject: string;
  statement: string;
}

export async function extractAndStoreFacts(
  deps: MemoryDeps,
  args: { userId: string; content: string; sourceMessageId?: string },
): Promise<void> {
  try {
    const facts = await extractFacts(deps.provider, args.content);
    if (facts.length === 0) return;

    const vectors = await deps.embeddings.embed(facts.map((f) => f.statement));
    for (let i = 0; i < facts.length; i++) {
      const fact = facts[i]!;
      const embedding = vectors[i];
      if (!embedding) continue;

      const nearest = await searchSimilarLiveFacts(
        deps.pool,
        args.userId,
        embedding,
        5,
      );

      // Already know something almost identical -> nothing to do.
      if (nearest.some((n) => n.distance < DUPLICATE_DISTANCE)) continue;

      const newId = await insertFact(deps.pool, {
        userId: args.userId,
        content: fact.statement,
        subject: fact.subject,
        embedding,
        embeddingModel: deps.embeddings.name,
        sourceMessageId: args.sourceMessageId,
      });

      // If a live fact concerns the SAME subject, the new one updates/replaces
      // it: supersede the old row. This is the cheap, threshold-free half of the
      // reconcile; a stronger version would ask a model whether the two actually
      // conflict (accurate, slower) instead of trusting the subject label.
      const prior = nearest.find(
        (n) => n.id !== newId && n.subject !== null && subjectEq(n.subject, fact.subject),
      );
      if (prior) {
        await supersedeFact(deps.pool, prior.id, newId);
        log.debug("superseded fact", prior.id, "->", newId, "subject:", fact.subject);
      }
    }
  } catch (err) {
    log.warn("fact extraction failed:", err);
  }
}

// Ask a cheap model for durable facts, each with a subject + a one-sentence
// statement. Returns [] on nothing-to-remember or any parse failure.
async function extractFacts(
  provider: LLMProvider,
  message: string,
): Promise<ExtractedFact[]> {
  const prompt: ChatMessage[] = [
    {
      role: "user",
      content:
        "Extract durable facts worth remembering about the user from the " +
        "message below — stable preferences, personal details, goals. Ignore " +
        "small talk and one-off requests. Each fact has a SUBJECT (what it is " +
        'about, e.g. "favorite color", "employer", "dog\'s name") and a ' +
        "STATEMENT (the fact in one standalone sentence). Reply with ONLY a " +
        'JSON array like [{"subject": "favorite color", "statement": "The ' +
        'user\'s favorite color is teal."}]. If there is nothing worth ' +
        "remembering, reply with [].\n\nMessage: " + message,
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

// Pull the first JSON array out of the reply and keep well-formed facts. Also
// tolerates the older bare-string shape ("...fact...") for back-compat.
function parseFacts(raw: string): ExtractedFact[] {
  const json = raw.match(/\[[\s\S]*\]/)?.[0];
  if (!json) return [];
  try {
    const arr: unknown = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    const out: ExtractedFact[] = [];
    for (const item of arr) {
      if (typeof item === "string" && item.trim().length > 0) {
        out.push({ subject: "general", statement: item.trim() });
      } else if (typeof item === "object" && item !== null) {
        const o = item as Record<string, unknown>;
        const statement =
          typeof o.statement === "string" ? o.statement.trim() : "";
        const subject = typeof o.subject === "string" ? o.subject.trim() : "";
        if (statement.length > 0) {
          out.push({ subject: subject.length > 0 ? subject : "general", statement });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

function subjectEq(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
