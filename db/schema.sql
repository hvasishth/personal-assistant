-- Database schema for the personal assistant.
--
-- This is the whole schema in one file. It is idempotent (IF NOT EXISTS
-- everywhere), so `make db-apply` can be run repeatedly — it is NOT a
-- migration system. When we need to evolve the schema later we'll decide
-- between "edit + db-reset" (fine while there's no real data) and adding a
-- migrations tool.
--
-- Adding a COLUMN later stays idempotent too — use:
--   ALTER TABLE <table> ADD COLUMN IF NOT EXISTS <col> <type>;
-- so re-running `make db-apply` picks the new column up on an existing table
-- with no drop (CREATE INDEX IF NOT EXISTS behaves the same). See the Step 5
-- block at the bottom for the pattern.
--
-- The limit: only ADDITIVE changes are idempotent this way. Changing an
-- existing column's type or constraints (e.g. the UUID id columns below) is
-- NOT — CREATE TABLE IF NOT EXISTS won't touch a table that already exists, so
-- those still need `make db-reset` (or, eventually, a real migration tool).

-- ---------------------------------------------------------------------------
-- Extensions. Enabled up front so the store is ready for the search work to
-- come, even though nothing uses them yet:
--   vector   -> embedding columns for semantic search (Step 5)
--   pg_trgm  -> trigram index for lexical / fuzzy text search
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Users & auth. Server-owned BIGINT identity: the client never names a user.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT        NOT NULL UNIQUE,
  -- Never the raw password. Format: "scrypt$<salt-hex>$<hash-hex>" (see auth/password.ts).
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Opaque session tokens. DB-backed (rather than stateless JWTs) so you can
-- see and revoke live sessions by looking at this table.
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT        PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);

-- ---------------------------------------------------------------------------
-- Conversations & messages. This is what lets a conversation be sustained
-- across requests: we load prior messages for a conversation and feed them
-- back to the model.
--
-- Identity is CLIENT-OWNED here: the primary keys are UUIDs the browser mints
-- and sends in the request body. That buys two things:
--   - optimistic UI: the browser knows a message's id before the server answers
--   - idempotency: a retried/duplicated request carries the SAME ids, so an
--     INSERT ... ON CONFLICT DO NOTHING is a harmless no-op the second time
--     instead of creating duplicate rows or triggering a second LLM call.
-- The user-message id doubles as the request's idempotency key; the assistant
-- message gets its own distinct id (never derived from the user message, so
-- "regenerate" can produce a fresh response without colliding).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id         UUID        PRIMARY KEY,   -- client-supplied
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_user_id_idx ON conversations (user_id);

CREATE TABLE IF NOT EXISTS messages (
  id              UUID        PRIMARY KEY,   -- client-supplied; doubles as idempotency key
  conversation_id UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT        NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Fetch a conversation's messages in order.
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Coming in Step 5 (left here as a signpost, intentionally NOT enabled yet).
-- When the time comes, uncomment these: each is idempotent, so `make db-apply`
-- adds them to the existing messages table without a reset.
--   -- semantic search:
--   ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding vector(1536);
--   CREATE INDEX IF NOT EXISTS messages_embedding_idx
--     ON messages USING hnsw (embedding vector_cosine_ops);
--   -- lexical / fuzzy search:
--   ALTER TABLE messages ADD COLUMN IF NOT EXISTS content_tsv tsvector;
--   CREATE INDEX IF NOT EXISTS messages_content_tsv_idx
--     ON messages USING gin (content_tsv);
-- ---------------------------------------------------------------------------
