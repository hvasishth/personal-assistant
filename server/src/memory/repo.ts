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
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export async function insertFact(
  pool: Pool,
  fact: {
    userId: string;
    content: string;
    subject?: string | null;
    embedding: number[];
    embeddingModel?: string | null;
    sourceMessageId?: string;
    validFrom?: string | null;
  },
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO facts
       (user_id, content, subject, embedding, embedding_model, source_message_id, valid_from)
     VALUES ($1, $2, $3, $4::vector, $5, $6, COALESCE($7, now()))
     RETURNING id`,
    [
      fact.userId,
      fact.content,
      fact.subject ?? null,
      toVectorLiteral(fact.embedding),
      fact.embeddingModel ?? null,
      fact.sourceMessageId ?? null,
      fact.validFrom ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("insertFact returned no id");
  return row.id;
}

export interface LiveFactMatch extends FactMatch {
  subject: string | null;
}

// Nearest LIVE facts (not superseded) to an embedding, with their subject — the
// input the supersession step reasons over (duplicate detection + finding the
// prior fact a new one replaces).
export async function searchSimilarLiveFacts(
  pool: Pool,
  userId: string,
  embedding: number[],
  limit: number,
): Promise<LiveFactMatch[]> {
  const { rows } = await pool.query<LiveFactMatch>(
    `SELECT id, user_id, content, subject, created_at,
            embedding <=> $2::vector AS distance
       FROM facts
      WHERE user_id = $1
        AND superseded_by IS NULL
        AND embedding IS NOT NULL
      ORDER BY embedding <=> $2::vector
      LIMIT $3`,
    [userId, toVectorLiteral(embedding), limit],
  );
  return rows;
}

// Mark an old fact as replaced by a newer one. The row is kept for history; it
// just stops appearing in live retrieval.
export async function supersedeFact(
  pool: Pool,
  oldId: string,
  newId: string,
): Promise<void> {
  await pool.query(`UPDATE facts SET superseded_by = $2 WHERE id = $1`, [
    oldId,
    newId,
  ]);
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
