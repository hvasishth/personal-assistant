import { loadConfig } from "./config";
import { createApp } from "./app";
import { log, setLogLevel } from "./logger";

// Step 1: load config, build the Express app, and start listening.
const config = loadConfig();
setLogLevel(config.logLevel);
const app = createApp(config);

const server = app.listen(config.port, () => {
  log.info(
    `personal-assistant server listening on http://localhost:${config.port}`,
  );
  log.info(
    `  provider=${config.llmProviderName} model=${config.llmModel} logLevel=${config.logLevel}`,
  );
});

// Close the port cleanly on Ctrl+C / termination so `tsx watch` restarts and
// repeated runs don't leave the port stuck in use.
function shutdown(): void {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
