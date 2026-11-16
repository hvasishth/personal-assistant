import { EMBEDDING_DIM, type EmbeddingProvider } from "./types";

// Real embeddings via Voyage AI (Anthropic's recommended embeddings partner).
// voyage-3 returns 1024-dim vectors, matching EMBEDDING_DIM. One HTTP call per
// batch; the caller decides batch sizes.
const API_URL = "https://api.voyageai.com/v1/embeddings";

export function createVoyageEmbeddingProvider(
  apiKey: string,
  model: string,
): EmbeddingProvider {
  return {
    name: "voyage",
    dim: EMBEDDING_DIM,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: texts, model }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `Voyage API ${res.status}: ${detail || res.statusText}`,
        );
      }
      const data = (await res.json()) as { data: { embedding: number[] }[] };
      return data.data.map((d) => d.embedding);
    },
  };
}
