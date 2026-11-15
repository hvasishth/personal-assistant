import type {
  ChatMessage,
  LLMProvider,
  StreamEvent,
  StreamOptions,
} from "./types";

// A deterministic, offline provider. It ignores the model, makes no network
// call, and streams a canned reply word-by-word. Handy later for building the
// web UI and for evals without cost — but it is NOT the real wire format, so
// it's not what you debug streaming against. Switch to anthropic for that.
export function createFakeProvider(): LLMProvider {
  return {
    name: "fake",
    async *streamChat(
      messages: ChatMessage[],
      _opts: StreamOptions = {},
    ): AsyncIterable<StreamEvent> {
      const last = messages[messages.length - 1]?.content ?? "";
      const reply = `You said: "${last}". This reply comes from the fake provider.`;
      for (const word of reply.split(" ")) {
        yield { type: "text", text: word + " " };
      }
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}
