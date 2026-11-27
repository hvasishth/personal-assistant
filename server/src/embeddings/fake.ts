import { EMBEDDING_DIM, type EmbeddingProvider } from "./types";

// A deterministic, offline embeddings provider for dev/evals — the counterpart
// of the fake LLM provider. It is NOT semantically smart: it hashes word tokens
// into buckets (a bag-of-words sketch) and L2-normalizes. But texts that share
// words get similar vectors, so cosine similarity is roughly meaningful — good
// enough to build and test retrieval against with no API key or cost. Switch to
// the Voyage provider for real quality. Same dimension, so the DB column is
// unchanged either way.
export function createFakeEmbeddingProvider(): EmbeddingProvider {
  return {
    name: "fake",
    dim: EMBEDDING_DIM,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(embedOne);
    },
  };
}

function embedOne(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIM).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const token of words) {
    const h = hash(token) % EMBEDDING_DIM;
    vector[h] = (vector[h] ?? 0) + 1;
  }
  // L2-normalize so cosine distance behaves (and matches a normalized index).
  const norm = Math.sqrt(vector.reduce((s, x) => s + x * x, 0)) || 1;
  return vector.map((x) => x / norm);
}

// FNV-1a — a small, fast, deterministic string hash.
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
