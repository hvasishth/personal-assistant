import type { Pool } from "../db";
import type { EmbeddingProvider } from "../embeddings/types";
import { listUnembeddedTurns, setTurnEmbedding } from "./repo";

// Embed any turns that have content but no vector yet — live-chat messages, or
// turns ingested while the embed provider was down. Makes them searchable by
// the vector side. Loops in batches until the corpus is fully embedded.
export interface BackfillDeps {
  pool: Pool;
  embeddings: EmbeddingProvider;
  embeddingModel: string;
}

export async function backfillEmbeddings(
  deps: BackfillDeps,
  userId: string,
  batchSize = 64,
): Promise<number> {
  let total = 0;
  for (;;) {
    const turns = await listUnembeddedTurns(deps.pool, userId, batchSize);
    if (turns.length === 0) break;
    const vectors = await deps.embeddings.embed(turns.map((t) => t.text));
    for (let i = 0; i < turns.length; i++) {
      const vec = vectors[i];
      const turn = turns[i];
      if (!vec || !turn) continue;
      await setTurnEmbedding(deps.pool, turn.id, vec, deps.embeddingModel);
      total += 1;
    }
    // Fewer than a full batch means we've drained the backlog.
    if (turns.length < batchSize) break;
  }
  return total;
}
