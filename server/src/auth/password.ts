// Password hashing.
//
// Uses Node's built-in scrypt (a deliberately slow, memory-hard KDF) rather
// than pulling in bcrypt — no native dependency, and the mechanics stay
// visible. Each password gets a random salt; the salt is stored alongside the
// hash so verify can reproduce it.
//
// Stored format:  scrypt$<salt-hex>$<derived-key-hex>

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LEN = 64;
const SALT_LEN = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const derived = (await scryptAsync(password, salt, KEY_LEN)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || saltHex === undefined || hashHex === undefined) {
    return false;
  }

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = (await scryptAsync(password, salt, expected.length)) as Buffer;

  // Constant-time comparison so we don't leak how much of the hash matched.
  return (
    expected.length === derived.length && timingSafeEqual(expected, derived)
  );
}
