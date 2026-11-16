// Data access for the recall pipeline. Plain parameterized SQL over the turn
// corpus (`messages` + `conversations`). Three concerns live here: the two
// filtered searches (lexical, vector), hydrating fused ids into full turns, and
// the corpus writes ingest/backfill need.

import type { Pool } from "../db";
import type { ScoredTurn, TurnRow } from "./types";

// pgvector wants a literal like '[0.1,0.2,0.3]'.
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

// A time window with nullable, open-ended bounds. start is inclusive, end
// exclusive — matching the spec's `ts >= start AND ts < end`.
export interface TimeRange {
  start: string | null;
  end: string | null;
}

interface SearchFilters {
  timeRange: TimeRange | null;
  surfaces: string[]; // empty = any surface
}

// Lexical search (spec stage 2): time filter + full-text match in one query,
// ranked by ts_rank_cd. websearch_to_tsquery parses a Google-ish query string
// and, by default, requires every term to match — so one unusual word can
// return zero rows. Returns at most `limit`, pre-ranked best-first.
export async function searchTurnsLexical(
  pool: Pool,
  userId: string,
  queryText: string,
  filters: SearchFilters,
  limit: number,
): Promise<ScoredTurn[]> {
  if (!queryText.trim()) return [];
  const start = filters.timeRange?.start ?? null;
  const end = filters.timeRange?.end ?? null;
  const surfaces = filters.surfaces.length > 0 ? filters.surfaces : null;
  const { rows } = await pool.query<{ id: string; score: number }>(
    `SELECT m.id, ts_rank_cd(m.content_tsv, q) AS score
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id,
            websearch_to_tsquery('english', $2) AS q
      WHERE c.user_id = $1
        AND m.content_tsv @@ q
        AND ($3::timestamptz IS NULL OR m.created_at >= $3)
        AND ($4::timestamptz IS NULL OR m.created_at <  $4)
        AND ($5::text[]      IS NULL OR m.surface = ANY($5))
      ORDER BY score DESC
      LIMIT $6`,
    [userId, queryText, start, end, surfaces, limit],
  );
  return rows.map((r) => ({ id: r.id, score: Number(r.score) }));
}

// Vector search (spec stage 3): the same time filter, ranked by cosine distance
// to the question embedding. Score is reported as (1 - distance) so higher is
// better, consistent with the lexical side; ranking itself uses list order.
export async function searchTurnsVector(
  pool: Pool,
  userId: string,
  embedding: number[],
  filters: SearchFilters,
  limit: number,
): Promise<ScoredTurn[]> {
  const start = filters.timeRange?.start ?? null;
  const end = filters.timeRange?.end ?? null;
  const surfaces = filters.surfaces.length > 0 ? filters.surfaces : null;
  const { rows } = await pool.query<{ id: string; distance: number }>(
    `SELECT m.id, (m.embedding <=> $2::vector) AS distance
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.user_id = $1
        AND m.embedding IS NOT NULL
        AND ($3::timestamptz IS NULL OR m.created_at >= $3)
        AND ($4::timestamptz IS NULL OR m.created_at <  $4)
        AND ($5::text[]      IS NULL OR m.surface = ANY($5))
      ORDER BY distance
      LIMIT $6`,
    [userId, toVectorLiteral(embedding), start, end, surfaces, limit],
  );
  return rows.map((r) => ({ id: r.id, score: 1 - Number(r.distance) }));
}

// Hydrate fused ids into full turns (with the conversation title), preserving
// the order of `ids` — the fused ranking — rather than the DB's order.
export async function hydrateTurns(
  pool: Pool,
  ids: string[],
): Promise<TurnRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await pool.query<{
    id: string;
    conversation_id: string;
    conversation_title: string | null;
    seq: number | null;
    speaker: string;
    surface: string;
    ts: string;
    text: string;
  }>(
    `SELECT m.id,
            m.conversation_id,
            c.title AS conversation_title,
            m.seq,
            m.role  AS speaker,
            m.surface,
            m.created_at::text AS ts,
            m.content AS text
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = ANY($1)`,
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      conversationTitle: r.conversation_title,
      seq: r.seq,
      speaker: r.speaker,
      surface: r.surface,
      ts: r.ts,
      text: r.text,
    }));
}

// Pull the immediate neighbours of a turn (same conversation, nearby seq/time)
// so an answer can show a hit in context. Ordered by seq then time.
export async function neighbourTurns(
  pool: Pool,
  turn: TurnRow,
  radius: number,
): Promise<TurnRow[]> {
  const { rows } = await pool.query<{
    id: string;
    conversation_id: string;
    conversation_title: string | null;
    seq: number | null;
    speaker: string;
    surface: string;
    ts: string;
    text: string;
  }>(
    `SELECT m.id, m.conversation_id, c.title AS conversation_title, m.seq,
            m.role AS speaker, m.surface, m.created_at::text AS ts, m.content AS text
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = $1
      ORDER BY m.seq NULLS LAST, m.created_at
    `,
    [turn.conversationId],
  );
  const idx = rows.findIndex((r) => r.id === turn.id);
  if (idx === -1) return [];
  const slice = rows.slice(Math.max(0, idx - radius), idx + radius + 1);
  return slice.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    conversationTitle: r.conversation_title,
    seq: r.seq,
    speaker: r.speaker,
    surface: r.surface,
    ts: r.ts,
    text: r.text,
  }));
}

// -------------------------------------------------------------------------
// Corpus writes (used by ingest + the embed-backfill command)
// -------------------------------------------------------------------------

// Upsert a conversation with ingest provenance. Idempotent on the (client/
// deterministic) id, so re-ingest updates metadata rather than duplicating.
export async function upsertIngestConversation(
  pool: Pool,
  conv: {
    id: string;
    userId: string;
    title: string | null;
    source: string;
    startedAt: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO conversations (id, user_id, title, source, started_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE
       SET title = COALESCE(EXCLUDED.title, conversations.title),
           source = EXCLUDED.source,
           started_at = COALESCE(EXCLUDED.started_at, conversations.started_at)`,
    [conv.id, conv.userId, conv.title, conv.source, conv.startedAt],
  );
}

// Insert one turn. ON CONFLICT DO NOTHING (any unique: the id PK or the
// content_hash) makes re-ingest a no-op. Returns true if a row was inserted.
export async function insertTurn(
  pool: Pool,
  turn: {
    id: string;
    conversationId: string;
    role: string;
    content: string;
    seq: number;
    surface: string;
    ts: string;
    contentHash: string;
    embedding: number[] | null;
    embeddingModel: string | null;
  },
): Promise<boolean> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages
       (id, conversation_id, role, content, status, seq, surface, created_at,
        content_hash, embedding, embedding_model)
     VALUES ($1, $2, $3, $4, 'complete', $5, $6, $7, $8, $9::vector, $10)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      turn.id,
      turn.conversationId,
      turn.role,
      turn.content,
      turn.seq,
      turn.surface,
      turn.ts,
      turn.contentHash,
      turn.embedding ? toVectorLiteral(turn.embedding) : null,
      turn.embeddingModel,
    ],
  );
  return rows.length > 0;
}

// Turns for this user that have content but no embedding yet — the backfill
// command embeds these so live-chat (or partially-ingested) turns become
// searchable by the vector side.
export async function listUnembeddedTurns(
  pool: Pool,
  userId: string,
  limit: number,
): Promise<{ id: string; text: string }[]> {
  const { rows } = await pool.query<{ id: string; text: string }>(
    `SELECT m.id, m.content AS text
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.user_id = $1
        AND m.embedding IS NULL
      ORDER BY m.created_at
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

export async function setTurnEmbedding(
  pool: Pool,
  id: string,
  embedding: number[],
  model: string,
): Promise<void> {
  await pool.query(
    `UPDATE messages SET embedding = $2::vector, embedding_model = $3 WHERE id = $1`,
    [id, toVectorLiteral(embedding), model],
  );
}

// Get-or-create a user to own a CLI-ingested corpus. The password hash is a
// disabled sentinel (no interactive login for this account); auth still works
// for real signups. Returns the user id as a string (BIGINT -> string).
export async function getOrCreateCliUser(
  pool: Pool,
  email: string,
): Promise<string> {
  await pool.query(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, 'cli$disabled')
     ON CONFLICT (email) DO NOTHING`,
    [email],
  );
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE email = $1`,
    [email],
  );
  const row = rows[0];
  if (!row) throw new Error(`could not get-or-create CLI user ${email}`);
  return row.id;
}
