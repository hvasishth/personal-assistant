// The provider-agnostic LLM contract.
//
// Every provider (anthropic, fake, ...) implements LLMProvider. Code that uses
// an LLM depends only on these types — never on a provider's wire format. That
// is the whole point of the abstraction: the Express route and, later, the
// memory/tool code should not know or care which provider is behind it.

/** A single message in the conversation. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Token counts for a turn (providers fill this in when they report it). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * The normalized events a provider emits while streaming one assistant turn.
 * Each provider translates its own wire format into exactly these shapes, so
 * the consumer sees one vocabulary regardless of provider.
 */
export type StreamEvent =
  | { type: "text"; text: string } // an incremental chunk of assistant text
  | { type: "done"; usage?: Usage } // the turn finished normally
  | { type: "error"; message: string }; // the provider/transport failed

export interface StreamOptions {
  /** Override the default model for this call. */
  model?: string;
  /** Cap the response length. */
  maxTokens?: number;
  /** Abort the upstream request if the client disconnects. */
  signal?: AbortSignal;
}

/** The contract. For now a provider only needs to stream a chat turn. */
export interface LLMProvider {
  readonly name: string;
  streamChat(
    messages: ChatMessage[],
    opts?: StreamOptions,
  ): AsyncIterable<StreamEvent>;
}
