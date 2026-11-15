// Data access for users and sessions. Plain parameterized SQL — no ORM — so
// what hits the database is exactly what you read here.
//
// Note: Postgres BIGINT comes back as a string in node-postgres (JS numbers
// can't safely hold the full 64-bit range), so `id`/`user_id` are strings.

import type { Pool } from "../db";

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
}

export interface SessionUser {
  user_id: string;
  email: string;
}

function firstRow<T>(rows: T[], context: string): T {
  const row = rows[0];
  if (!row) throw new Error(`expected a row from ${context}`);
  return row;
}

export async function createUser(
  pool: Pool,
  email: string,
  passwordHash: string,
): Promise<UserRow> {
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     RETURNING id, email, password_hash, created_at`,
    [email, passwordHash],
  );
  return firstRow(rows, "createUser");
}

export async function findUserByEmail(
  pool: Pool,
  email: string,
): Promise<UserRow | undefined> {
  const { rows } = await pool.query<UserRow>(
    `SELECT id, email, password_hash, created_at FROM users WHERE email = $1`,
    [email],
  );
  return rows[0];
}

export async function createSession(
  pool: Pool,
  token: string,
  userId: string,
  expiresAt: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)`,
    [token, userId, expiresAt],
  );
}

// Returns the session's user only if the token exists AND hasn't expired.
export async function findSessionUser(
  pool: Pool,
  token: string,
): Promise<SessionUser | undefined> {
  const { rows } = await pool.query<SessionUser>(
    `SELECT s.user_id, u.email
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > now()`,
    [token],
  );
  return rows[0];
}

export async function deleteSession(pool: Pool, token: string): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
}
