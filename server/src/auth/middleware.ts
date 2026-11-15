// requireAuth middleware.
//
// Reads the session token from the httpOnly cookie, looks up the (unexpired)
// session, and attaches the user to the request. Routes mounted behind it can
// trust `req.userId` / `req.userEmail`.

import type { Request, Response, NextFunction } from "express";
import type { Pool } from "../db";
import { findSessionUser } from "./repo";
import { readSessionCookie } from "./cookie";

// Augment Express's Request so the attached user is typed, not `any`.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}

export function makeRequireAuth(pool: Pool) {
  return async function requireAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const token = readSessionCookie(req);
    if (!token) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }

    const session = await findSessionUser(pool, token);
    if (!session) {
      res.status(401).json({ error: "invalid or expired session" });
      return;
    }

    req.userId = session.user_id;
    req.userEmail = session.email;
    next();
  };
}
