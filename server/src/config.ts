// Centralized, typed access to environment configuration.
// Everything that reads process.env goes through here, so the rest of the
// codebase works with a validated Config object instead of raw strings.

import { isLogLevel, LOG_LEVELS, type LogLevel } from "./logger";

export type ProviderName = "fake" | "anthropic";
export type EmbeddingProviderName = "fake" | "voyage";

export interface Config {
  llmProviderName: ProviderName;
  llmModel: string;
  anthropicApiKey: string | undefined;
  embeddingProviderName: EmbeddingProviderName;
  voyageApiKey: string | undefined;
  embeddingModel: string;
  dataDir: string;
  port: number;
  databaseUrl: string;
  logLevel: LogLevel;
}

function parseLlmProviderName(raw: string | undefined): ProviderName {
  if (raw === "fake" || raw === "anthropic") return raw;
  throw new Error(
    `ADVISOR_PROVIDER must be "fake" or "anthropic", got: ${raw ?? "(unset)"}`,
  );
}

function parseEmbeddingProviderName(raw: string | undefined): EmbeddingProviderName {
  if (raw === "fake" || raw === "voyage") return raw;
  throw new Error(
    `ADVISOR_EMBEDDING_PROVIDER must be "fake" or "voyage", got: ${raw ?? "(unset)"}`,
  );
}

function parseLogLevel(raw: string | undefined): LogLevel {
  if (raw === undefined || raw === "") return "info";
  if (isLogLevel(raw)) return raw;
  throw new Error(
    `ADVISOR_LOG_LEVEL must be one of ${LOG_LEVELS.join("|")}, got: ${raw}`,
  );
}

export function loadConfig(): Config {
  // Default to the fake provider so a fresh clone runs with zero setup.
  const llmProviderName = parseLlmProviderName(process.env.ADVISOR_PROVIDER ?? "fake");

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || undefined;
  // Fail fast: a real provider with no key is a misconfiguration, not a runtime surprise.
  if (llmProviderName === "anthropic" && !anthropicApiKey) {
    throw new Error("ADVISOR_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty");
  }

  const embeddingProviderName = parseEmbeddingProviderName(
    process.env.ADVISOR_EMBEDDING_PROVIDER ?? "fake",
  );
  const voyageApiKey = process.env.VOYAGE_API_KEY || undefined;
  if (embeddingProviderName === "voyage" && !voyageApiKey) {
    throw new Error("ADVISOR_EMBEDDING_PROVIDER=voyage but VOYAGE_API_KEY is empty");
  }

  return {
    llmProviderName,
    llmModel: process.env.ADVISOR_MODEL ?? "claude-opus-5-5",
    anthropicApiKey,
    embeddingProviderName,
    voyageApiKey,
    embeddingModel: process.env.ADVISOR_EMBEDDING_MODEL ?? "voyage-3",
    dataDir: process.env.ADVISOR_DATA_DIR ?? "./data",
    port: Number(process.env.PORT ?? "8787"),
    databaseUrl:
      process.env.DATABASE_URL ??
      "postgres://advisor:advisor@localhost:5432/advisor",
    logLevel: parseLogLevel(process.env.ADVISOR_LOG_LEVEL),
  };
}
