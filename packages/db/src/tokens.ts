import { randomBytes, createHash } from "node:crypto";

/**
 * Ingest-token helpers. The plaintext token is returned to the collector ONCE at
 * pairing time and never stored; the DB holds only its SHA-256 hash. Auth looks
 * up the machine by hashing the presented bearer token — the indexed hash lookup
 * leaks nothing useful and a DB leak does not expose usable tokens.
 */

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
