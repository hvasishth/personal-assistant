// Prints what the query parser extracts for a few questions, so we can see
// whether relative/absolute dates become a time_range (the time filter is only
// as good as this). Anthropic-only; no Voyage, no DB.
//
//   ADVISOR_PROVIDER=anthropic tsx --env-file-if-exists=../.env eval/debug-parse.ts

import { loadConfig } from "../src/config";
import { createLlmProvider } from "../src/llm";
import { parseQuery } from "../src/recall/queryParse";

const NOW = new Date("2026-11-16T00:00:00Z");

const QUESTIONS = [
  "What did we decide about the Q3 budget last week?",
  "What did we decide in Q3?",
  "What did we agree on in August?",
  "What was the codename for the migration project?",
  "When did we agree to move the launch date?",
];

async function main(): Promise<void> {
  const config = loadConfig();
  const llmProvider = createLlmProvider(config);
  for (const q of QUESTIONS) {
    const parsed = await parseQuery({ llmProvider }, q, NOW);
    console.log(`\nQ: ${q}`);
    console.log(`   timeRange : ${JSON.stringify(parsed.timeRange)}`);
    console.log(`   keyTerms  : ${JSON.stringify(parsed.keyTerms)}`);
    console.log(`   people    : ${JSON.stringify(parsed.people)}`);
    console.log(`   surfaces  : ${JSON.stringify(parsed.surfaces)}`);
    console.log(`   semantic  : ${parsed.semanticQuery}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
