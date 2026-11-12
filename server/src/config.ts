// Centralized, typed access to environment configuration.
// Everything that reads process.env goes through here, so the rest of the
// codebase works with a validated Config object instead of raw strings.

export type ProviderName = "fake" | "anthropic";

export interface Config {
  provider: ProviderName;
  model: string;
  anthropicApiKey: string | undefined;
  dataDir: string;
  port: number;
}

function parseProvider(raw: string | undefined): ProviderName {
  if (raw === "fake" || raw === "anthropic") return raw;
  throw new Error(
    `ADVISOR_PROVIDER must be "fake" or "anthropic", got: ${raw ?? "(unset)"}`,
  );
}

export function loadConfig(): Config {
  // Default to the fake provider so a fresh clone runs with zero setup.
  const provider = parseProvider(process.env.ADVISOR_PROVIDER ?? "fake");

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || undefined;
  // Fail fast: a real provider with no key is a misconfiguration, not a runtime surprise.
  if (provider === "anthropic" && !anthropicApiKey) {
    throw new Error("ADVISOR_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty");
  }

  return {
    provider,
    model: process.env.ADVISOR_MODEL ?? "claude-opus-5-5",
    anthropicApiKey,
    dataDir: process.env.ADVISOR_DATA_DIR ?? "./data",
    port: Number(process.env.PORT ?? "8787"),
  };
}
