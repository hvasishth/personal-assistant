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

-- ===========================================================================
-- Recall pipeline (Step 6) — make the conversation corpus searchable as
-- "turns". The spec's unit of storage AND retrieval is the turn (one message).
-- These columns turn the existing `messages` table into that corpus. All
-- additive (ALTER ADD COLUMN IF NOT EXISTS), per the convention at the top.
-- Live chat writes still only set (id, conversation_id, role, content, status);
-- the new columns are filled by ingest and the embed-backfill command.
-- ===========================================================================

-- Ordinal position within a conversation (set during ingest; live chat leaves
-- it NULL and relies on created_at for ordering).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS seq INTEGER;

-- Modality of the turn: 'text' | 'voice' | 'notes'. A retrieval filter.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS surface TEXT NOT NULL DEFAULT 'text';

-- Semantic-search vector. NULL until embedded (by ingest or the backfill cmd).
-- 1024 = Voyage voyage-3 / the fake provider; must match the active provider.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- Which model produced `embedding`, so a model change is detectable, not silent.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding_model TEXT;

-- Idempotent (re-)ingest: a hash of (user + normalised text). A row whose hash
-- already exists is skipped on insert, so running ingest twice changes nothing.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- Lexical-search column, generated by the DB from `content`.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

-- Indexes: the time filter (most selective, runs first), the two searches, and
-- the idempotent-ingest uniqueness.
CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages (created_at);
CREATE INDEX IF NOT EXISTS messages_embedding_idx
  ON messages USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS messages_content_tsv_idx
  ON messages USING gin (content_tsv);
CREATE UNIQUE INDEX IF NOT EXISTS messages_content_hash_uniq
  ON messages (content_hash) WHERE content_hash IS NOT NULL;

-- Ingested notes have no chat role; widen the role check so a turn's speaker
-- can be 'notes' as well as the chat roles. (Drop-then-add so re-applying the
-- schema is idempotent.)
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_role_check;
ALTER TABLE messages ADD CONSTRAINT messages_role_check
  CHECK (role IN ('user', 'assistant', 'system', 'notes'));

-- Conversation provenance for ingested corpora: where it came from and when the
-- thread started (display + coarse time filtering).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

-- ===========================================================================
-- Recall pipeline — fact supersession (the "stretch" temporal memory). Facts
-- gain a subject, a provenance timestamp and a supersession pointer, so a newer
-- fact can retire an older, contradicting one WITHOUT deleting history. Old
-- rows stay; retrieval reads only live (not-superseded) facts.
-- ===========================================================================
ALTER TABLE facts ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS superseded_by BIGINT REFERENCES facts(id) ON DELETE SET NULL;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS embedding_model TEXT;
-- Live facts (the ones retrieval reads) — a partial index on the common filter.
CREATE INDEX IF NOT EXISTS facts_live_user_idx ON facts (user_id) WHERE superseded_by IS NULL;
