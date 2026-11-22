# Retrieval design — 2026-10-15

## Progress — Priya

Shipped the provider abstraction so Anthropic is the default and the fake provider backs the tests.

## Fusion

Chose reciprocal rank fusion (RRF, k=60) to combine the lexical and vector result lists. The reasoning: RRF fuses by rank, so we don't have to calibrate the two scoring scales against each other, and a turn that both methods like floats to the top.
