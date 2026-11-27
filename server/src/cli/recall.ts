// Command-line entry point for the recall pipeline.
//
//   npx tsx --env-file-if-exists=../.env src/cli/recall.ts <command> [flags]
// (or `npm run recall -- <command>` from the server directory)
//
// Commands:
//   ingest  --claude <file> --notes <dir> [--user <email>]
//       Parse a Claude export and/or a notes folder into the turn corpus.
//   backfill [--user <email>]
//       Embed any turns that have no vector yet (e.g. live-chat messages).
//   ask "<question>" [--user <email>] [--mode <mode>] [--top <k>]
//       Run the full query path and print the cited answer + timings.
//       mode: hybrid (default) | vector | lexical | hybrid_no_time
//   eval [--golden <path>] [--user <email>] [--answers]
//       Run the golden set: recall@5 ablations + per-stage latency.
//
// The corpus is per-user; the CLI defaults to the user "cli@local". Pass
// --user <email> to target another account's corpus (e.g. your web-app login).

import { readFile } from "node:fs/promises";
import { loadConfig } from "../config";
import { setLogLevel } from "../logger";
import { createPool } from "../db";
import { createLlmProvider } from "../llm";
import { createEmbeddingProvider } from "../embeddings";
import { getOrCreateCliUser } from "../recall/repo";
import { ingestClaudeExport, ingestNotesFolder } from "../recall/ingest";
import { backfillEmbeddings } from "../recall/backfill";
import { runRecall } from "../recall/pipeline";
import { runEval, formatEval, type GoldenQuestion } from "../recall/eval";
import type { RetrievalMode } from "../recall/types";

const MODES: RetrievalMode[] = ["hybrid", "vector", "lexical", "hybrid_no_time"];

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function flagStr(flags: ParsedArgs["flags"], key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function asMode(x: string | undefined): RetrievalMode {
  if (x === undefined) return "hybrid";
  if ((MODES as string[]).includes(x)) return x as RetrievalMode;
  throw new Error(`--mode must be one of ${MODES.join(" | ")}`);
}

function parseGolden(raw: string): GoldenQuestion[] {
  const data: unknown = JSON.parse(raw);
  const list: unknown = Array.isArray(data)
    ? data
    : typeof data === "object" && data !== null && Array.isArray((data as Record<string, unknown>).questions)
      ? (data as Record<string, unknown>).questions
      : [];
  const out: GoldenQuestion[] = [];
  for (const item of list as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.question !== "string") continue;
    const expected = Array.isArray(o.expectedTurnIds)
      ? o.expectedTurnIds.filter((x): x is string => typeof x === "string")
      : undefined;
    // An optional pinned filter (fixed ParsedQuery) for a deterministic
    // retrieval ablation; passed through as-is when present.
    const filter =
      typeof o.filter === "object" && o.filter !== null
        ? (o.filter as GoldenQuestion["filter"])
        : undefined;
    out.push({ question: o.question, expectedTurnIds: expected, filter });
  }
  return out;
}

function usage(): void {
  console.log(
    [
      "recall <command> [flags]",
      "",
      "  ingest   --claude <file> --notes <dir> [--user <email>]",
      "  backfill [--user <email>]",
      '  ask      "<question>" [--user <email>] [--mode <mode>] [--top <k>]',
      "  eval     [--golden <path>] [--user <email>] [--answers]",
      "",
      `  modes: ${MODES.join(" | ")}`,
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const { positionals, flags } = parseArgs(argv.slice(1));

  if (!command || command === "help" || flags.help) {
    usage();
    return;
  }

  const config = loadConfig();
  setLogLevel(config.logLevel);
  const pool = createPool(config.databaseUrl);

  try {
    const llmProvider = createLlmProvider(config);
    const embeddingProvider = createEmbeddingProvider(config);
    const email = flagStr(flags, "user") ?? "cli@local";
    const userId = await getOrCreateCliUser(pool, email);

    switch (command) {
      case "ingest": {
        const claudeExportPath = flagStr(flags, "claude");
        const notesDirPath = flagStr(flags, "notes");
        if (!claudeExportPath && !notesDirPath) {
          console.error("ingest needs --claude <file> and/or --notes <dir>");
          process.exitCode = 1;
          return;
        }
        const deps = { pool, embeddingProvider, embeddingModel: config.embeddingModel };
        if (claudeExportPath) {
          const ingestResult = await ingestClaudeExport(deps, userId, claudeExportPath);
          console.log(
            `claude_export: ${ingestResult.conversations} conversations, +${ingestResult.inserted} turns, ${ingestResult.skipped} skipped`,
          );
        }
        if (notesDirPath) {
          const ingestResult = await ingestNotesFolder(deps, userId, notesDirPath);
          console.log(
            `meeting_notes: ${ingestResult.conversations} conversations, +${ingestResult.inserted} turns, ${ingestResult.skipped} skipped`,
          );
        }
        break;
      }

      case "backfill": {
        const embeddedCount = await backfillEmbeddings(
          { pool, embeddingProvider, embeddingModel: config.embeddingModel },
          userId,
        );
        console.log(`embedded ${embeddedCount} turns`);
        break;
      }

      case "ask": {
        const question = positionals[0];
        if (!question) {
          console.error('ask needs a question, e.g. recall ask "what did we decide about X?"');
          process.exitCode = 1;
          return;
        }
        const mode = asMode(flagStr(flags, "mode"));
        const topFlag = flagStr(flags, "top");
        const topK = topFlag ? Number(topFlag) : 5;
        process.stdout.write("\n");
        const result = await runRecall(
          { pool, llmProvider, embeddingProvider },
          userId,
          question,
          { mode, topK, onToken: (t) => process.stdout.write(t) },
        );
        process.stdout.write("\n\n--- retrieved turns ---\n");
        if (result.turns.length === 0) console.log("  (none)");
        for (const t of result.turns) {
          console.log(
            `  [${t.id}] ${t.ts.slice(0, 10)} · ${t.conversationTitle ?? "untitled"} · ${t.speaker}`,
          );
        }
        console.log("\n--- timings (ms) ---");
        for (const [k, v] of Object.entries(result.timings)) {
          console.log(`  ${k}: ${v}`);
        }
        break;
      }

      case "eval": {
        const goldenPath = flagStr(flags, "golden") ?? "eval/golden.json";
        const raw = await readFile(goldenPath, "utf8");
        const golden = parseGolden(raw);
        if (golden.length === 0) {
          console.error(`no questions found in ${goldenPath}`);
          process.exitCode = 1;
          return;
        }
        const result = await runEval(
          { pool, llmProvider, embeddingProvider },
          userId,
          golden,
          { withAnswers: flags.answers === true },
        );
        console.log(formatEval(result));
        break;
      }

      default:
        console.error(`unknown command: ${command}`);
        usage();
        process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
