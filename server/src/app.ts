import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { Config } from "./config";
import type { LLMProvider } from "./llm/types";
import { createProvider } from "./llm";
import { makeChatRoute } from "./routes/chat";
import { makeConversationsRouter } from "./routes/conversations";
import { createPool, type Pool } from "./db";
import { makeAuthRouter } from "./auth/routes";
import { makeRequireAuth } from "./auth/middleware";
import { log } from "./logger";

// Build the Express application.
//
// This is kept separate from actually starting the server (see index.ts) so
// that tests and the eval harness (Step 7) can import the app and exercise its
// routes without binding to a TCP port.
// The provider is injectable so tests / evals can pass a fake. By default we
// build it from config.
export function createApp(
  config: Config,
  provider: LLMProvider = createProvider(config),
  pool: Pool = createPool(config.databaseUrl),
): Express {
  const app = express();

  // Middleware: parse JSON request bodies so route handlers see a typed
  // `req.body` object. Without this, req.body is undefined for POST requests.
  app.use(express.json());

  // Liveness probe. Useful for curl right now and for Docker health checks later.
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", provider: config.provider, model: config.model });
  });

  // Auth (Step 4): signup / login / logout / me.
  app.use("/auth", makeAuthRouter(pool));

  // The streaming chat endpoint (Step 2) — now behind auth (Step 4) and backed
  // by the DB (Step 4): it persists each turn and reloads history. A valid
  // session cookie is required; requireAuth short-circuits with 401 otherwise,
  // so the handler only runs when authed (and req.userId is set).
  const requireAuth = makeRequireAuth(pool);
  app.post("/api/chat", requireAuth, makeChatRoute(provider, pool));

  // Conversation list + history for the sidebar (Step 4), also behind auth.
  app.use("/api/conversations", requireAuth, makeConversationsRouter(pool));

  // Anything unmatched falls through to here -> 404.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not found" });
  });

  // Central error handler. Express identifies it by its FOUR parameters
  // (err, req, res, next) — that signature is what marks it as error-handling.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error("unhandled error:", err);
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}
