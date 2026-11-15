// Session cookie helpers.
//
// The session token lives in an httpOnly cookie instead of a response body:
//   - httpOnly  -> JavaScript can't read it, so an XSS payload can't steal it
//   - SameSite=Strict -> the browser never attaches it to cross-site requests
//                        (CSRF protection). Fine for us: we're a same-origin
//                        SPA that checks auth via a same-site fetch(/auth/me)
//                        after load, so arriving from an external link still
//                        authenticates. (Revisit if we add OAuth redirects.)
//   - Secure    -> HTTPS-only in production; off in dev so http://localhost works
//
// Setting uses Express's built-in res.cookie(); reading parses the Cookie
// header by hand so we don't need a cookie-parser dependency.

import type { Request, Response } from "express";

export const SESSION_COOKIE = "advisor_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

// Cookie header format: "name=value; name2=value2". Return our cookie's value.
export function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}
