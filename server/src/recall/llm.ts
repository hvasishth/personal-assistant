import type { ChatMessage, LLMProvider, StreamOptions } from "../llm/types";

// Consume a provider's stream to a single string. The non-streaming stages
// (query parsing, fact extraction) need the whole reply before continuing.
// Throws on a provider error event so the caller can fall back.
export async function completeText(
  llmProvider: LLMProvider,
  messages: ChatMessage[],
  opts: StreamOptions = {},
): Promise<string> {
  let text = "";
  for await (const ev of llmProvider.streamChat(messages, opts)) {
    if (ev.type === "text") text += ev.text;
    else if (ev.type === "error") throw new Error(ev.message);
  }
  return text;
}
