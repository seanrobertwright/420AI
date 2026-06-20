import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Single-admin password hashing (M12 12.3) using scrypt from node:crypto — zero
 * new dependency (mirrors M10's node:crypto ed25519 precedent, important for the
 * node:sea desktop sidecar build). Stored form is `scrypt$<salt>$<derivedKey>`,
 * both base64url. scrypt's default N=16384 is fine at keylen ≤ 64 (no maxmem tuning).
 */

/** Hash a password with a fresh random salt → `scrypt$<salt>$<dk>` (base64url). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const dk = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${dk.toString("base64url")}`;
}

/**
 * Constant-time verify of `password` against a stored `scrypt$<salt>$<dk>` value.
 * Returns false (never throws) for any malformed stored value.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "base64url");
  const expected = Buffer.from(parts[2]!, "base64url");
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
