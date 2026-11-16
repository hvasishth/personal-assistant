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

-- Did the assistant finish cleanly? We stream tokens to the client as they
-- arrive but only know the turn is done when the provider says so. If the
-- stream drops mid-way we still persist what was sent, marked 'incomplete', so
-- the DB matches what the client already saw — and a retry regenerates rather
-- than replaying a truncated reply. User messages are always 'complete'.
-- Added via ALTER (the additive convention above) so it lands on the existing
-- table with no reset.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'complete'
  CHECK (status IN ('complete', 'incomplete'));

-- ---------------------------------------------------------------------------
-- Step 5 — memory / RAG. `facts` are short, durable memories the assistant
-- extracts from a user's messages (in the background), embeds, and later
-- retrieves to ground its answers. Scoped per user — this is cross-conversation
-- memory about the user, not per-conversation history.
--   embedding    -> semantic (vector) search, pgvector + HNSW cosine index
--   content_tsv  -> lexical search, a generated tsvector + GIN index
--
-- IMPORTANT: the embedding dimension MUST match the embedding provider (see
-- server/src/embeddings). 1024 = Voyage voyage-3; the fake provider matches it.
-- Switching to a provider with a different dimension (e.g. OpenAI's 1536) means
-- re-creating this column and re-embedding, so it is NOT an additive change.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS facts (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content           TEXT        NOT NULL,
  embedding         vector(1024),
  content_tsv       tsvector    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  source_message_id UUID        REFERENCES messages(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS facts_user_id_idx ON facts (user_id);
-- Semantic search: cosine-distance HNSW index over the embeddings.
CREATE INDEX IF NOT EXISTS facts_embedding_idx
  ON facts USING hnsw (embedding vector_cosine_ops);
-- Lexical search: GIN over the generated tsvector.
CREATE INDEX IF NOT EXISTS facts_content_tsv_idx
  ON facts USING gin (content_tsv);
