// Builds eval/golden.json for the synthetic corpus by looking up the turn id(s)
// that actually contain each planted answer. Run AFTER ingesting the corpus:
//
//   ADVISOR_EMBEDDING_PROVIDER=voyage ADVISOR_PROVIDER=anthropic \
//     tsx --env-file-if-exists=../.env eval/build-golden.ts [--user eval@local]
//
// recall@5 counts a question as a hit if ANY of its expected ids is in the top 5,
// so where an answer was planted in more than one place we record every match.
// The quantum-teleportation question is deliberately left with no expected ids:
// it has no answer in the corpus, and its "Not found" behaviour is checked with
// `recall ask` instead of scored here.

import { writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config";
import { createPool } from "../src/db";
import { getOrCreateCliUser } from "../src/recall/repo";

// A pinned filter (fixed ParsedQuery fields) makes a question's retrieval
// ablation deterministic — the eval uses it instead of the LLM parser.
interface GoldenFilter {
  timeRange?: { start: string | null; end: string | null } | null;
  keyTerms?: string[];
  surfaces?: string[];
  semanticQuery?: string;
}

interface Spec {
  question: string;
  // ILIKE patterns that uniquely identify the planted answer turn(s).
  patterns: string[];
  filter?: GoldenFilter;
  note?: string; // what this question is meant to exercise (kept out of the JSON)
}

const SPECS: Spec[] = [
  { question: "What did we decide about the Q3 budget last week?", patterns: ["%unspent Q3 budget%"] },
  { question: "When did we agree to move the launch date?", patterns: ["%move the public launch%"], note: "literal: 'launch date' matches lexically" },
  {
    question: "When do end users finally get the product?",
    patterns: ["%move the public launch%"],
    // Paraphrase: pinned key_terms share no words with the answer, so lexical
    // returns nothing and only the vector arm can find it.
    filter: { timeRange: null, keyTerms: ["end users", "product rollout"], semanticQuery: "when do end users get the product" },
    note: "paraphrase: lexical should miss, vector should hit",
  },
  { question: "What was the codename for the migration project?", patterns: ["%codenamed Seahorse%"] },
  { question: "What port does the dev server run on?", patterns: ["%dev server runs on port 8787%"], note: "near-miss port decoys can mislead lexical@1" },
  { question: "How did we plan to handle duplicate ingestion?", patterns: ["%content_hash%ON CONFLICT DO NOTHING%", "%ON CONFLICT DO NOTHING%"] },
  { question: "What was the reasoning behind choosing reciprocal rank fusion?", patterns: ["%fuses by rank%", "%RRF only looks at rank%"] },
  { question: "What did Luke say about the hiring level?", patterns: ["%hire at the senior level (L5)%"] },
  { question: "Who owns the embeddings work?", patterns: ["%Priya owns the embeddings%"] },
  {
    question: "Who is on call this week?",
    patterns: ["%Marco is on call%"],
    // Identical phrasing every week -> only the time filter picks the right one.
    // hybrid (filtered to this week) hits; hybrid_no_time ranks an old week first.
    filter: {
      timeRange: { start: "2026-11-09T00:00:00Z", end: "2026-11-16T00:00:00Z" },
      keyTerms: ["on call"],
      semanticQuery: "who is currently on call this week",
    },
    note: "time-collision: hybrid should beat hybrid_no_time",
  },
  { question: "What did we conclude about quantum teleportation pricing?", patterns: [] },
];

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const userFlagIdx = process.argv.indexOf("--user");
  const email = userFlagIdx !== -1 ? process.argv[userFlagIdx + 1]! : "eval@local";
  try {
    const userId = await getOrCreateCliUser(pool, email);
    const questions: {
      question: string;
      expectedTurnIds: string[];
      filter?: GoldenFilter;
    }[] = [];
    for (const spec of SPECS) {
      const ids = new Set<string>();
      for (const pat of spec.patterns) {
        const { rows } = await pool.query<{ id: string }>(
          `SELECT m.id FROM messages m
             JOIN conversations c ON c.id = m.conversation_id
            WHERE c.user_id = $1 AND m.content ILIKE $2`,
          [userId, pat],
        );
        for (const r of rows) ids.add(r.id);
      }
      if (spec.patterns.length > 0 && ids.size === 0) {
        console.warn(`  !! no turn matched for: "${spec.question}" (patterns: ${spec.patterns.join(", ")})`);
      }
      questions.push({
        question: spec.question,
        expectedTurnIds: [...ids],
        ...(spec.filter ? { filter: spec.filter } : {}),
      });
    }
    const out = { _generatedFrom: `${email} corpus`, questions };
    await writeFile("eval/golden.json", JSON.stringify(out, null, 2) + "\n", "utf8");
    console.log(`wrote eval/golden.json for ${email}:`);
    for (const q of questions) {
      console.log(`  [${q.expectedTurnIds.length}] ${q.question}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
