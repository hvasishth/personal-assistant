// Data access for conversations and messages. Plain parameterized SQL — no
// ORM — so what hits the database is exactly what you read here.
//
// Identity note: unlike users/sessions (server-owned BIGINTs), the PRIMARY KEYs
// here are UUIDs minted by the CLIENT and sent in the request. That gives us:
//   - optimistic UI: the browser knows a message's id before the server replies
//   - idempotency: a retried/duplicated request carries the same ids, so an
//     INSERT ... ON CONFLICT DO NOTHING is a no-op the second time instead of
//     duplicating rows or spending a second LLM call.
// UUIDs come back from node-postgres as plain strings.

import type { Pool } from "../db";

export type Role = "user" | "assistant" | "system";

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: Role;
  content: string;
  created_at: string;
}

// Create the conversation if it doesn't exist, then return its owner's user_id
// so the caller can enforce ownership (a user must not write into someone
// else's conversation by guessing a UUID). Written insert-then-read so a race
// between two "first" requests is safe: exactly one INSERT wins, both read back
// the same owner.
export async function getOrCreateConversation(
  pool: Pool,
  id: string,
  userId: string,
  title: string,
): Promise<string> {
  await pool.query(
    `INSERT INTO conversations (id, user_id, title)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [id, userId, title.slice(0, 80)],
  );
  const { rows } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM conversations WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error("conversation vanished after insert");
  return row.user_id;
}

// Insert the user's turn. Returns true if newly inserted, false if a row with
// this id already existed (a duplicate request). The id is the idempotency key.
export async function insertUserMessage(
  pool: Pool,
  msg: { id: string; conversationId: string; content: string },
): Promise<boolean> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages (id, conversation_id, role, content)
     VALUES ($1, $2, 'user', $3)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [msg.id, msg.conversationId, msg.content],
  );
  return rows.length > 0;
}

export async function findMessageById(
  pool: Pool,
  id: string,
): Promise<MessageRow | undefined> {
  const { rows } = await pool.query<MessageRow>(
    `SELECT id, conversation_id, role, content, created_at
       FROM messages WHERE id = $1`,
    [id],
  );
  return rows[0];
}

// All messages in a conversation, oldest first — the raw material for the
// prompt. (Step 5 replaces "all of them" with actual retrieval.)
export async function loadHistory(
  pool: Pool,
  conversationId: string,
): Promise<MessageRow[]> {
  const { rows } = await pool.query<MessageRow>(
    `SELECT id, conversation_id, role, content, created_at
       FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC, id ASC`,
    [conversationId],
  );
  return rows;
}

// Save the assistant's reply. Upsert on id so even a racing duplicate request
// overwrites the same row rather than creating a second one.
export async function upsertAssistantMessage(
  pool: Pool,
  msg: { id: string; conversationId: string; content: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO messages (id, conversation_id, role, content)
     VALUES ($1, $2, 'assistant', $3)
     ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content`,
    [msg.id, msg.conversationId, msg.content],
  );
}

// Bump updated_at so conversations can be listed most-recent-first later.
export async function touchConversation(pool: Pool, id: string): Promise<void> {
  await pool.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [
    id,
  ]);
}
