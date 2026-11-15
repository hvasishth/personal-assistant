import type { Config } from "../config";
import type { LLMProvider } from "./types";
import { createAnthropicProvider } from "./anthropic";
import { createFakeProvider } from "./fake";

// The factory: translate config into a concrete provider. This is the single
// place that knows the mapping from config.provider -> implementation.
export function createProvider(config: Config): LLMProvider {
  switch (config.provider) {
    case "anthropic":
      if (!config.anthropicApiKey) {
        throw new Error("anthropic provider requires ANTHROPIC_API_KEY");
      }
      return createAnthropicProvider(config.anthropicApiKey, config.model);
    case "fake":
      return createFakeProvider();
  }
  // No default branch: config.provider is a union of "anthropic" | "fake",
  // so TypeScript proves this switch is exhaustive. Add a provider -> compile error here.
}

export type { LLMProvider } from "./types";
