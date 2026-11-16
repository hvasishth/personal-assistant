// Data access for `facts` — the per-user memory store. Plain parameterized SQL.
// Embeddings are passed as pgvector literals ('[0.1,0.2,...]') and cast with
// ::vector; cosine distance uses the <=> operator (0 = identical).

import type { Pool } from "../db";

export interface FactRow {
  id: string; // BIGINT -> string
  user_id: string;
  content: string;
  created_at: string;
}

export interface FactMatch extends FactRow {
  distance: number; // cosine distance from the query (0 = identical)
}

// pgvector wants a literal like '[0.1,0.2,0.3]'.
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

export async function insertFact(
  pool: Pool,
  fact: {
    userId: string;
    content: string;
    embedding: number[];
    sourceMessageId?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO facts (user_id, content, embedding, source_message_id)
     VALUES ($1, $2, $3::vector, $4)`,
    [
      fact.userId,
      fact.content,
      toVectorLiteral(fact.embedding),
      fact.sourceMessageId ?? null,
    ],
  );
}

// Semantic search: the nearest facts to a query embedding, for one user, by
// cosine distance. This is the main pipe the retrieval seam calls.
export async function searchSimilarFacts(
  pool: Pool,
  userId: string,
  embedding: number[],
  limit: number,
): Promise<FactMatch[]> {
  const { rows } = await pool.query<FactMatch>(
    `SELECT id, user_id, content, created_at,
            embedding <=> $2::vector AS distance
       FROM facts
      WHERE user_id = $1 AND embedding IS NOT NULL
      ORDER BY embedding <=> $2::vector
      LIMIT $3`,
    [userId, toVectorLiteral(embedding), limit],
  );
  return rows;
}

// Lexical search: full-text match over the generated tsvector, for one user.
// Ranked by ts_rank. An alternative/complement to vector search for retrieval.
export async function searchFactsByText(
  pool: Pool,
  userId: string,
  query: string,
  limit: number,
): Promise<FactRow[]> {
  const { rows } = await pool.query<FactRow>(
    `SELECT id, user_id, content, created_at
       FROM facts
      WHERE user_id = $1
        AND content_tsv @@ plainto_tsquery('english', $2)
      ORDER BY ts_rank(content_tsv, plainto_tsquery('english', $2)) DESC
      LIMIT $3`,
    [userId, query, limit],
  );
  return rows;
}

export async function listFacts(
  pool: Pool,
  userId: string,
): Promise<FactRow[]> {
  const { rows } = await pool.query<FactRow>(
    `SELECT id, user_id, content, created_at
       FROM facts WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}
