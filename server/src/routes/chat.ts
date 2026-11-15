import type { Request, Response } from "express";
import type { ChatMessage, LLMProvider } from "../llm/types";
import { log } from "../logger";

// POST /api/chat   body: { messages: ChatMessage[] }
//
// Streams the assistant's reply to the browser as Server-Sent Events. The
// provider gives us normalized StreamEvents; we re-frame them as SSE for the
// browser's EventSource (named events: "token", "done", "error").
export function makeChatRoute(provider: LLMProvider) {
  return async function chat(req: Request, res: Response): Promise<void> {
    const messages = req.body?.messages as ChatMessage[] | undefined;
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "body must be { messages: ChatMessage[] }" });
      return;
    }

    // SSE handshake. These headers turn the response into an event stream the
    // browser keeps open. Content-Type is the one that matters most.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // If the browser goes away, abort the upstream LLM request too so we don't
    // keep paying for tokens no one will read.
    const ac = new AbortController();
    res.on("close", () => ac.abort());

    log.debug("chat request:", messages.length, "message(s)");

    const send = (event: string, data: unknown): void => {
      log.trace("sse ->", event, data);
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      for await (const ev of provider.streamChat(messages, { signal: ac.signal })) {
        if (ev.type === "text") send("token", { text: ev.text });
        else if (ev.type === "done") send("done", { usage: ev.usage ?? null });
        else send("error", { message: ev.message });
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
  };
}
