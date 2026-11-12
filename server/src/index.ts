import { loadConfig } from "./config";

// Step 0: prove the TypeScript toolchain runs and config loading works.
// There is no HTTP server yet — that arrives in Step 1 (Express).
const config = loadConfig();

console.log("personal-assistant server — environment check");
console.log("  provider :", config.provider);
console.log("  model    :", config.model);
console.log("  dataDir  :", config.dataDir);
console.log("  port     :", config.port);
console.log("  hasKey   :", config.anthropicApiKey ? "yes" : "no");
console.log("\n✓ TS toolchain is working. Next step: Express server.");
