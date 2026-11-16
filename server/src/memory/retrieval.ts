import type { ChatMessage } from "../llm/types";
import type { EmbeddingProvider } from "../embeddings/types";
import type { Pool } from "../db";
import type { MessageRow } from "../conversations/repo";
// Pipes ready for you (the retrieval repo). searchFactsByText is the lexical
// alternative if you want hybrid search.
import { searchSimilarFacts, searchFactsByText } from "./repo";

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

// ============================================================================
// YOUR PIECE (Step 5): retrieval + prompt assembly.
//
// Turn the stored conversation history + the user's new message into the exact
// ChatMessage[] handed to the model. Right now this is the SIMPLE version — it
// returns the conversation history verbatim, which is what the app did before
// Step 5, so everything keeps working while this is unimplemented.
//
// Your job: add RETRIEVAL and compose a better prompt. The pipes are ready:
//   const [qvec] = await deps.embeddings.embed([args.userMessage]);
//   const facts  = await searchSimilarFacts(deps.pool, args.userId, qvec, k);
//   // (or searchFactsByText(deps.pool, args.userId, args.userMessage, k) for lexical)
//
// A typical shape:
//   1. embed args.userMessage -> query vector
//   2. searchSimilarFacts(...) -> the top-k relevant facts for this user
//   3. build a leading context/system message from those facts' .content
//   4. append the recent conversation history (toChatMessages(args.history))
//   5. return [context, ...history]   — mind token budget, ordering, how much
//      history vs. retrieved memory to include
//
// Everything downstream (streaming, persistence, titling, the background fact
// extraction that fills the store) already works against whatever you return.
// ============================================================================
export async function buildPromptMessages(
  deps: RetrievalDeps,
  args: RetrievalArgs,
): Promise<ChatMessage[]> {
  // --- SIMPLE default: no retrieval yet. Replace with the steps above. -------
  void deps; // (unused until you implement retrieval)
  void searchSimilarFacts;
  void searchFactsByText;
  return toChatMessages(args.history);
}

// History rows -> the model's message shape. We only ever store 'user' and
// 'assistant' turns, so anything else is treated as 'user'.
export function toChatMessages(history: MessageRow[]): ChatMessage[] {
  return history.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));
}
