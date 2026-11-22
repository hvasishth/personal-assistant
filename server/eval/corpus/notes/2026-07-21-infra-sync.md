# Infra sync — local dev setup — 2026-07-21

## Blockers — Priya

Blocked briefly on a role CHECK constraint rejecting 'notes' turns; widened it.

## Dev server

Settled the local setup: the dev server runs on port 8787, Postgres on 5432 in Docker. Everyone standardises on `make dev` so the ports don't drift between machines.
