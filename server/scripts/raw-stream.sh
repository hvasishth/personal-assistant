#!/usr/bin/env bash
# Watch the RAW Anthropic SSE stream — this is exactly the byte format your
# parser (anthropic-stream.ts) will consume. Run it, read the event:/data:
# lines, sketch your parsing approach, THEN implement the parser and compare.
#
# Usage:
#   cd server && ./scripts/raw-stream.sh                 # default prompt
#   cd server && ./scripts/raw-stream.sh "your prompt"
#
# Needs ANTHROPIC_API_KEY in ../.env (repo root). Uses the cheapest model.
set -euo pipefail
set -x

# Load .env from the repo root (one level up from server/) if present.
if [ -f ../.env ]; then
  set -a
  . ../.env
  set +a
fi

: "${ANTHROPIC_API_KEY:?Set ANTHROPIC_API_KEY in ../.env first (cp ../.env.example ../.env and edit)}"

MODEL="claude-haiku-5-5"   # cheapest; override by editing this line
PROMPT="${1:-Say hello in exactly five words.}"

# Build the JSON body with node (guaranteed present) so the prompt is escaped safely.
BODY="$(MODEL="$MODEL" PROMPT="$PROMPT" node -e 'process.stdout.write(JSON.stringify({model:process.env.MODEL,max_tokens:64,stream:true,messages:[{role:"user",content:process.env.PROMPT}]}))')"

# -N disables curl buffering so you see events arrive incrementally.
curl -sN https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "$BODY"
