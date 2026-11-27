// Embedding retrieval comparison — a runnable eval, not a unit test.
//
// For a fixed set of "facts" and a list of queries, embed everything and rank
// the facts by cosine distance to each query. Run it against BOTH providers to
// see the difference: the fake (lexical, bag-of-words) provider can only match
// on shared words, while Voyage bridges synonyms and paraphrases by meaning.
//
// This is the script I used to demonstrate that a real embedding provider is
// what makes semantic retrieval work. It does NOT touch Postgres — it builds
// the providers in-process — so it needs no DB, just (optionally) VOYAGE_API_KEY
// for the Voyage run.
//
// Run:
//   # fake provider (offline, no key):
//   npx tsx scripts/embed-compare.ts fake
//   # voyage provider (needs VOYAGE_API_KEY in ../.env):
//   npx tsx --env-file-if-exists=../.env scripts/embed-compare.ts voyage
//   # both, side by side:
//   npx tsx --env-file-if-exists=../.env scripts/embed-compare.ts both
//
// Debug:
//   npx tsx --inspect-brk scripts/embed-compare.ts fake
//   then attach from VS Code ("Attach to Node") or chrome://inspect.

import type { EmbeddingProvider } from "../src/embeddings/types";
import { createFakeEmbeddingProvider } from "../src/embeddings/fake";
import { createVoyageEmbeddingProvider } from "../src/embeddings/voyage";

// The user's stored "facts". Innocuous, no PII.
const FACTS = [
  "The user's favorite color is teal",
  "The user is learning TypeScript",
  "The user lives in Berlin",
  "The user has a dog named Pixel",
];

// Queries chosen to separate lexical from semantic matching:
//  - q1 shares the words "favorite"/"color" with the teal fact (lexical wins too)
//  - q2 is a pure synonym: "hue" shares NO words with any fact
//  - q3 is inferential: painting walls implies a color preference
const QUERIES = [
  "what is my favorite color?",
  "which hue do I prefer?",
  "what should I paint my bedroom walls?",
];

// Cosine distance = 1 - cosine similarity. 0 = identical direction, 1 =
// orthogonal, 2 = opposite. Computed from raw dot/norms so it's correct whether
// or not the provider returns unit vectors.
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 1;
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function run(embeddingProvider: EmbeddingProvider): Promise<void> {
  console.log(`\n================ provider: ${embeddingProvider.name} (dim ${embeddingProvider.dim}) ================`);

  // Embed facts and queries in TWO batch calls total (not one call per query),
  // so we stay under Voyage's free-tier 3 requests/minute limit.
  const factEmbeddings = await embeddingProvider.embed(FACTS);
  const queryEmbeddings = await embeddingProvider.embed(QUERIES);

  QUERIES.forEach((query, queryIndex) => {
    const queryEmbedding = queryEmbeddings[queryIndex];
    if (!queryEmbedding) {
      console.log(`\n(no embedding returned for query: ${query})`);
      return;
    }
    const ranked = FACTS.map((fact, i) => ({
      fact,
      distance: cosineDistance(queryEmbedding, factEmbeddings[i] ?? []),
    })).sort((x, y) => x.distance - y.distance);

    console.log(`\nquery: "${query}"`);
    for (const { fact, distance } of ranked) {
      console.log(`  ${distance.toFixed(4)}  ${fact}`);
    }
  });
}

function buildEmbeddingProvider(name: string): EmbeddingProvider {
  if (name === "voyage") {
    const key = process.env.VOYAGE_API_KEY;
    if (!key) {
      throw new Error(
        "VOYAGE_API_KEY is not set — run with --env-file-if-exists=../.env, " +
          "or use `fake` for the offline provider.",
      );
    }
    return createVoyageEmbeddingProvider(
      key,
      process.env.ADVISOR_EMBEDDING_MODEL ?? "voyage-3",
    );
  }
  return createFakeEmbeddingProvider();
}

async function main(): Promise<void> {
  const which = process.argv[2] ?? "fake"; // fake | voyage | both
  const names = which === "both" ? ["fake", "voyage"] : [which];
  for (const name of names) {
    await run(buildEmbeddingProvider(name));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
