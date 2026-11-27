import type { Config } from "../config";
import type { EmbeddingProvider } from "./types";
import { createFakeEmbeddingProvider } from "./fake";
import { createVoyageEmbeddingProvider } from "./voyage";

// Build the embeddings provider from config, mirroring the LLM provider factory.
// Defaults to the fake provider so a fresh clone runs with zero setup/cost.
export function createEmbeddingProvider(config: Config): EmbeddingProvider {
  if (config.embeddingProviderName === "voyage") {
    if (!config.voyageApiKey) {
      throw new Error(
        "ADVISOR_EMBEDDING_PROVIDER=voyage but VOYAGE_API_KEY is empty",
      );
    }
    return createVoyageEmbeddingProvider(
      config.voyageApiKey,
      config.embeddingModel,
    );
  }
  return createFakeEmbeddingProvider();
}
