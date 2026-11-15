-- Database schema for the personal assistant.
--
-- This is the whole schema in one file. It is idempotent (IF NOT EXISTS
-- everywhere), so `make db-apply` can be run repeatedly — it is NOT a
-- migration system. When we need to evolve the schema later we'll decide
-- between "edit + db-reset" (fine while there's no real data) and adding a
-- migrations tool.

-- ---------------------------------------------------------------------------
-- Extensions. Enabled up front so the store is ready for the search work to
-- come, even though nothing uses them yet:
--   vector   -> embedding columns for semantic search (Step 5)
--   pg_trgm  -> trigram index for lexical / fuzzy text search
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Users & auth.
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
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_user_id_idx ON conversations (user_id);

CREATE TABLE IF NOT EXISTS messages (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id BIGINT      NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT        NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Fetch a conversation's messages in order.
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Coming in Step 5 (left here as a signpost, intentionally NOT created yet):
--   ALTER TABLE messages ADD COLUMN embedding vector(1536);       -- semantic search
--   CREATE INDEX ... ON messages USING hnsw (embedding vector_cosine_ops);
--   ALTER TABLE messages ADD COLUMN content_tsv tsvector ...;     -- lexical search
--   CREATE INDEX ... ON messages USING gin (content_tsv);
-- ---------------------------------------------------------------------------
