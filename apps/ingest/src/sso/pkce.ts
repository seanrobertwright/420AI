import { createHash, randomBytes } from "node:crypto";

/**
 * M15 15.7 — the two random values an OAuth authorization request carries. Pure `node:crypto`; no
 * dependency (Scope Decision 3), and no state of its own — the caller stores what it needs.
 */

/** An unguessable CSRF `state` value. 32 bytes, base64url — same budget as `tokens.ts`. */
export function randomState(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * RFC 7636 PKCE pair. `codeChallenge = base64url(sha256(codeVerifier))`, method S256 —
 * CONFIRMED supported by Google's discovery document (`code_challenge_methods_supported`
 * contains "S256"), which is why this is not guarded behind a capability check for Google.
 *
 * Node's `base64url` digest encoding is already unpadded and URL-safe, so no hand-rolled
 * `+/=` replacement is needed — writing one is the classic way to break the challenge.
 */
export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}
