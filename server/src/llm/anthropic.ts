import type {
  ChatMessage,
  LLMProvider,
  StreamEvent,
  StreamOptions,
} from "./types";
import { parseAnthropicStream } from "./anthropic-stream";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

// The real provider. It owns the HTTP request (headers, body, abort) but
// delegates ALL stream parsing to parseAnthropicStream — your piece.
export function createAnthropicProvider(
  apiKey: string,
  defaultModel: string,
): LLMProvider {
  return {
    name: "anthropic",
    async *streamChat(
      messages: ChatMessage[],
      opts: StreamOptions = {},
    ): AsyncIterable<StreamEvent> {
      // Anthropic takes the system prompt as a top-level `system` param, not a
      // message, so lift any system-role messages out of the array.
      const system = messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
      const turns = messages.filter((m) => m.role !== "system");
      const body = JSON.stringify({
        model: opts.model ?? defaultModel,
        max_tokens: opts.maxTokens ?? 1024,
        stream: true,
        ...(system ? { system } : {}),
        messages: turns.map((m) => ({ role: m.role, content: m.content })),
      });
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
          "content-type": "application/json",
        },
        body,
        signal: opts.signal,
      });

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        yield {
          type: "error",
          message: `Anthropic API ${response.status}: ${detail || response.statusText}`,
        };
        return;
      }

      // Hand the raw byte stream to your parser and forward whatever it yields.
      yield* parseAnthropicStream(response.body);
    },
  };
}
