// Auth routes: signup, login, logout, me.
//
// Tokens are opaque random strings stored in the sessions table (see repo.ts),
// sent back to the client, and presented as `Authorization: Bearer <token>`.
// All DB access goes through repo.ts; this file is just HTTP glue + validation.

import express from "express";
import { randomBytes } from "node:crypto";
import type { Pool } from "../db";
import { log } from "../logger";
import { hashPassword, verifyPassword } from "./password";
import {
  createSession,
  createUser,
  deleteSession,
  findUserByEmail,
} from "./repo";
import { bearerToken, makeRequireAuth } from "./middleware";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_PASSWORD_LEN = 8;

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

// Pull and normalize email/password from a request body.
function readCredentials(body: unknown): { email: string; password: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  const password = typeof b.password === "string" ? b.password : "";
  return { email, password };
}

export function makeAuthRouter(pool: Pool): express.Router {
  const router = express.Router();
  const requireAuth = makeRequireAuth(pool);

  // Create an account and return a fresh session token.
  router.post("/signup", async (req, res) => {
    const { email, password } = readCredentials(req.body);
    if (!email.includes("@")) {
      res.status(400).json({ error: "a valid email is required" });
      return;
    }
    if (password.length < MIN_PASSWORD_LEN) {
      res.status(400).json({
        error: `password must be at least ${MIN_PASSWORD_LEN} characters`,
      });
      return;
    }
    if (await findUserByEmail(pool, email)) {
      res.status(409).json({ error: "email already registered" });
      return;
    }

    const user = await createUser(pool, email, await hashPassword(password));
    const token = newToken();
    await createSession(
      pool,
      token,
      user.id,
      new Date(Date.now() + SESSION_TTL_MS),
    );
    log.info("signup:", email);
    res.status(201).json({ token, user: { id: user.id, email: user.email } });
  });

  // Verify credentials and return a fresh session token.
  router.post("/login", async (req, res) => {
    const { email, password } = readCredentials(req.body);
    const user = await findUserByEmail(pool, email);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      // Same message whether the email or the password was wrong.
      res.status(401).json({ error: "invalid email or password" });
      return;
    }

    const token = newToken();
    await createSession(
      pool,
      token,
      user.id,
      new Date(Date.now() + SESSION_TTL_MS),
    );
    res.json({ token, user: { id: user.id, email: user.email } });
  });

  // Revoke the current session.
  router.post("/logout", requireAuth, async (req, res) => {
    const token = bearerToken(req);
    if (token) await deleteSession(pool, token);
    res.status(204).end();
  });

  // Who am I? (requires a valid token)
  router.get("/me", requireAuth, (req, res) => {
    res.json({ user: { id: req.userId, email: req.userEmail } });
  });

  return router;
}
