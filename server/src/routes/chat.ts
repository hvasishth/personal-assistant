import type { Request, Response } from "express";
import type { ChatMessage, LLMProvider } from "../llm/types";
import type { Pool } from "../db";
import {
  getOrCreateConversation,
  insertUserMessage,
  findMessageById,
  loadHistory,
  upsertAssistantMessage,
  touchConversation,
} from "../conversations/repo";
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

export function makeChatRoute(provider: LLMProvider, pool: Pool) {
  return async function chat(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as ChatRequestBody;
    const conversationId =
      typeof body.conversationId === "string" ? body.conversationId : undefined;
    const messageId =
      typeof body.message?.id === "string" ? body.message.id : undefined;
    const content =
      typeof body.message?.content === "string" ? body.message.content : undefined;
    const assistantMessageId =
      typeof body.assistantMessageId === "string"
        ? body.assistantMessageId
        : undefined;
    const userId = req.userId;

    if (!conversationId || !messageId || !content || !assistantMessageId) {
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
    const ownerId = await getOrCreateConversation(
      pool,
      conversationId,
      userId,
      content,
    );
    if (ownerId !== userId) {
      res.status(403).json({ error: "not your conversation" });
      return;
    }

    // Persist the user's turn. Idempotent on the message id: a duplicate
    // request inserts nothing the second time.
    await insertUserMessage(pool, { id: messageId, conversationId, content });

    // SSE handshake. These headers turn the response into an event stream the
    // browser keeps open.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (event: string, data: unknown): void => {
      log.trace("sse ->", event, data);
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Replay: if this exact assistant turn was already produced AND finished
    // cleanly (a true duplicate request), stream the saved text back instead of
    // spending another LLM call. An 'incomplete' turn (a reply whose stream
    // dropped last time) is NOT replayed — we fall through and regenerate it,
    // so the user never gets a truncated answer served back as final.
    const existingAssistant = await findMessageById(pool, assistantMessageId);
    if (existingAssistant && existingAssistant.status === "complete") {
      log.debug("chat replay:", assistantMessageId);
      send("token", { text: existingAssistant.content });
      send("done", { usage: null, replayed: true });
      res.end();
      return;
    }

    // If the browser goes away, abort the upstream LLM request too so we don't
    // keep paying for tokens no one will read.
    const ac = new AbortController();
    res.on("close", () => ac.abort());

    // --- prompt assembly (SIMPLE version) -----------------------------------
    // Load the whole conversation (now including the just-saved user turn) and
    // hand it to the model verbatim. This is deliberately naive: the richer
    // "retrieve the relevant context + assemble the prompt" logic is Step 5 and
    // is yours to write — swap this block out there.
    const history = await loadHistory(pool, conversationId);
    const promptMessages: ChatMessage[] = history.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));
    // ------------------------------------------------------------------------

    log.debug("chat request:", promptMessages.length, "message(s) in context");

    let full = "";
    let completed = false;
    try {
      for await (const ev of provider.streamChat(promptMessages, {
        signal: ac.signal,
      })) {
        if (ev.type === "text") {
          full += ev.text;
          send("token", { text: ev.text });
        } else if (ev.type === "done") {
          completed = true;
          send("done", { usage: ev.usage ?? null });
        } else {
          send("error", { message: ev.message });
        }
      }
    } catch (err) {
      // A thrown error (e.g. the parser stub, or an aborted fetch) lands here.
      if (!ac.signal.aborted) {
        send("error", {
          message: err instanceof Error ? err.message : "stream failed",
        });
      }
    } finally {
      res.end();
    }

    // Persist whatever we actually streamed, regardless of how the stream
    // ended, so the DB matches what the client saw — otherwise a dropped reply
    // lingers on screen but vanishes on refresh. 'complete' only if we reached
    // the provider's done event; a partial (aborted/errored/dropped mid-stream)
    // is saved 'incomplete' and will be regenerated on a retry, not replayed.
    // Nothing streamed (full === "") means the failure was before any text, so
    // there's nothing to save — the user turn is already stored for a retry.
    if (full) {
      try {
        await upsertAssistantMessage(pool, {
          id: assistantMessageId,
          conversationId,
          content: full,
          status: completed ? "complete" : "incomplete",
        });
        await touchConversation(pool, conversationId);
      } catch (err) {
        log.error("failed to persist assistant message:", err);
      }
    }
  };
}
