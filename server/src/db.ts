// Postgres connection pool.
//
// A pool hands out (and reuses) a small set of connections so each request
// doesn't pay to open its own. pg connects lazily — creating the pool does NOT
// require the database to be up; only the first query does. That means the app
// can boot even if Postgres isn't running yet (you'll just get errors when an
// auth/chat route tries to touch the DB).

import * as pg from "pg";
import { log } from "./logger";

export type Pool = pg.Pool;

export function createPool(connectionString: string): Pool {
  const pool = new pg.Pool({ connectionString });

  // An idle pooled connection can drop (db restart, network blip). Log it
  // instead of letting the unhandled 'error' event crash the process.
  pool.on("error", (err) => {
    log.error("postgres pool error:", err);
  });

  return pool;
}
