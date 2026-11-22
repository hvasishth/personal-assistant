// The provider-agnostic embeddings contract — the mirror of LLMProvider, but
// for turning text into vectors. Retrieval code depends only on this, never on
// a specific embeddings API.
//
// EMBEDDING_DIM is the one source of truth for the vector size. It MUST match
// the `facts.embedding vector(1024)` column in db/schema.sql and whatever the
// active provider returns. 1024 = Voyage voyage-3; the fake provider matches it.

export const EMBEDDING_DIM = 1024;

export interface EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  /** Embed a batch of texts; returns one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
}
