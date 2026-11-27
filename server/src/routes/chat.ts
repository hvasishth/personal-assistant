import type { Request, Response } from "express";
import type { LLMProvider } from "../llm/types";
import type { Pool } from "../db";
import type { EmbeddingProvider } from "../embeddings/types";
import {
  getOrCreateConversation,
  insertUserMessage,
  findMessageById,
  loadHistory,
  upsertAssistantMessage,
  touchConversation,
} from "../conversations/repo";
import { autoTitleConversation } from "../conversations/title";
import { extractAndStoreFacts } from "../memory/extract";
import { buildPromptMessages } from "../memory/retrieval";
import { log } from "../logger";

// POST /api/chat
//   body: { conversationId: string,
//           message: { id: string, content: string },
//           assistantMessageId: string }
//
// All three ids are client-minted UUIDs. `message.id` is the request's
// idempotency key; `assistantMessageId` is where the reply is stored and the
// bubble the browser streams it into. Requires auth (requireAuth sets
// req.userId).
//
// Flow: enforce conversation ownership -> persist the user turn (idempotent)
// -> if this assistant turn was already produced, replay it without a second
// LLM call -> otherwise assemble the prompt from stored history, stream the
// reply to the browser as SSE, and persist it on clean completion.
interface ChatRequestBody {
  conversationId?: unknown;
  message?: { id?: unknown; content?: unknown };
  assistantMessageId?: unknown;
}

export function makeChatRoute(
  llmProvider: LLMProvider,
  pool: Pool,
  embeddingProvider: EmbeddingProvider,
) {
  return async function chat(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as ChatRequestBody;
    const conversationId =
      typeof body.conversationId === "string" ? body.conversationId : undefined;
    const userMessageId =
      typeof body.message?.id === "string" ? body.message.id : undefined;
    const content =
      typeof body.message?.content === "string" ? body.message.content : undefined;
    const assistantMessageId =
      typeof body.assistantMessageId === "string"
        ? body.assistantMessageId
        : undefined;
    const userId = req.userId;

    if (!conversationId || !userMessageId || !content || !assistantMessageId) {
      res.status(400).json({
        error:
          "body must be { conversationId, message: { id, content }, assistantMessageId }",
      });
      return;
    }
    if (!userId) {
      // requireAuth should guarantee this; belt and suspenders.
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    // Ownership: create the conversation if it's new, else confirm it's this
    // user's before writing anything into it.
    const ownerId = await getOrCreateConversation(pool, conversationId, userId);
    if (ownerId !== userId) {
      res.status(403).json({ error: "not your conversation" });
      return;
    }

    // Persist the user's turn. Idempotent on the message id: a duplicate
    // request inserts nothing the second time.
    await insertUserMessage(pool, { id: userMessageId, conversationId, content });

    // Background memory extraction (Step 5): distill durable facts from the
    // user's message and store them for later retrieval. Fire-and-forget — it
    // owns its errors and must never delay or break the chat response.
    void extractAndStoreFacts(
      { pool, llmProvider, embeddingProvider },
      { userId, content, sourceMessageId: userMessageId },
    );

    // SSE handshake. These headers turn the response into an event stream the
    // browser keeps open.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const sendEvent = (event: string, data: unknown): void => {
      log.trace("sse ->", event, data);
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Replay: if this exact assistant turn was already produced AND finished
    // cleanly (a true duplicate request), stream the saved text back instead of
    // spending another LLM call. An 'incomplete' turn (a reply whose stream
    // dropped last time) is NOT replayed — we fall through and regenerate it,
    // so the user never gets a truncated answer served back as final.
    const existingReply = await findMessageById(pool, assistantMessageId);
    if (existingReply && existingReply.status === "complete") {
      log.debug("chat replay:", assistantMessageId);
      sendEvent("token", { text: existingReply.content });
      sendEvent("done", { usage: null, replayed: true });
      // A replayed turn still ensures the conversation gets titled — covers the
      // case where the original turn's titling was missed (it failed, or the
      // first attempt dropped before it ran). No-ops if already titled.
      void autoTitleConversation(pool, llmProvider, conversationId, content);
      res.end();
      return;
    }

    // If the browser goes away, abort the upstream LLM request too so we don't
    // keep paying for tokens no one will read.
    const abortController = new AbortController();
    res.on("close", () => abortController.abort());

    // Retrieval + prompt assembly (Step 5) — buildPromptMessages is YOUR piece.
    // Today it returns the history verbatim; it's where retrieval plugs in.
    const history = await loadHistory(pool, conversationId);
    const promptMessages = await buildPromptMessages(
      { pool, embeddingProvider },
      { userId, conversationId, history, userMessage: content },
    );

    log.debug("chat request:", promptMessages.length, "message(s) in context");

    let replyText = "";
    let completed = false;
    try {
      for await (const ev of llmProvider.streamChat(promptMessages, {
        signal: abortController.signal,
      })) {
        if (ev.type === "text") {
          replyText += ev.text;
          sendEvent("token", { text: ev.text });
        } else if (ev.type === "done") {
          completed = true;
          sendEvent("done", { usage: ev.usage ?? null });
        } else {
          sendEvent("error", { message: ev.message });
        }
      }
    } catch (err) {
      // A thrown error (e.g. the parser stub, or an aborted fetch) lands here.
      if (!abortController.signal.aborted) {
        sendEvent("error", {
          message: err instanceof Error ? err.message : "stream failed",
        });
      }
    } finally {
      // Persist whatever we streamed before closing, then kick off auto-titling
      // in the background (not awaited) so res.end() isn't held up by it.

      // Persist regardless of how the stream ended, so the DB matches what the
      // client saw — otherwise a dropped reply lingers on screen but vanishes
      // on refresh. 'complete' only if we reached the provider's done event; a
      // partial (aborted/errored/dropped mid-stream) is saved 'incomplete' and
      // regenerated on retry, not replayed. Nothing streamed (full === "")
      // means the failure was before any text — the user turn is already stored.
      if (replyText) {
        try {
          await upsertAssistantMessage(pool, {
            id: assistantMessageId,
            conversationId,
            content: replyText,
            status: completed ? "complete" : "incomplete",
          });
          await touchConversation(pool, conversationId);
        } catch (err) {
          log.error("failed to persist assistant message:", err);
        }
      }

      // Auto-title on a clean turn, fire-and-forget: generation runs in the
      // background (and no-ops if the conversation is already titled), so it
      // never holds the response open. The client learns the title by polling
      // GET /api/conversations/:id. autoTitleConversation owns its errors, so
      // this never rejects.
      if (completed && replyText) {
        void autoTitleConversation(pool, llmProvider, conversationId, content);
      }

      res.end();
    }
  };
}
