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

/**
 * M15 15.9 (D-15.9-3) — the distinguishing prefix on an API key's plaintext. ONE definition,
 * shared by the repository that mints keys and `resolvePrincipal`'s branch that routes them, so the
 * two can never disagree about what an API key looks like.
 *
 * The prefix lets `resolvePrincipal` decide which credential branch to take WITHOUT a DB probe on
 * every session token, and lets a leaked string be recognised in a log or a git history.
 *
 * ROUTE IT WITH `startsWith`, NEVER by splitting on `_`. Measured during planning: base64url's
 * alphabet INCLUDES `_` and `-` (all of `-0-9A-Z_a-z` appeared across 200 `generateToken()`
 * samples), so a token BODY routinely contains underscores. Any `split("_")[1]` parsing would
 * mis-handle a large fraction of otherwise-valid keys. The whole composed token — prefix included —
 * is what gets hashed, so there is nothing to strip. Total length 48 = 5 + 43.
 */
export const API_KEY_PREFIX = "k420_";
