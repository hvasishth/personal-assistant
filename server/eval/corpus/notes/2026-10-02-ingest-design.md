# Ingest design review — 2026-10-02

## Parked — me

Debated whether to return unused budget each quarter; historically we have, but it's revisited every time.

## Dedup

Decided how to handle duplicate ingestion: a per-user content_hash column plus INSERT ... ON CONFLICT DO NOTHING, so re-running ingest is an idempotent no-op instead of creating duplicate turns.
