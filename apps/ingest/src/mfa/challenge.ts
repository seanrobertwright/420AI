import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * M15 15.8 — the MFA CHALLENGE: the short-lived token a login returns INSTEAD of a session when the
 * user has a confirmed second factor. `POST /v1/auth/mfa/verify` exchanges it, plus a TOTP or
 * recovery code, for an ordinary 15.6 session.
 *
 * STATELESS BY DESIGN (D-15.8-3) — there is no `mfa_challenges` table. Same reasoning 15.7 records
 * for holding no per-flow server state (`routes/sso.ts:208-210`): an unauthenticated endpoint that
 * allocates a row per attempt is a free write amplifier. The security property is NOT "it is
 * unguessable"; it is "it is signed under a key nobody else can derive, AND IT IS NOT A SESSION".
 *
 * STRUCTURALLY PARALLEL TO `session.ts`, AND DELIBERATELY NOT SHARING ITS KEY. This file does not
 * import `session.ts` — the separation is the point (GOTCHA-2):
 *
 *   `verifySession` accepts any well-formed payload whose MAC checks out under `SESSION_SECRET`, and
 *   it is `resolvePrincipal` that then requires a live `sid`. That second check HAPPENS to save us
 *   today. Relying on it means one future change to this payload — adding a `sid`, say, "for
 *   convenience" — silently becomes a complete authentication bypass. Signing under a DERIVED key
 *   makes the bypass UNREPRESENTABLE rather than merely unreached, which is the same move
 *   `findUserIdBySsoIdentity`'s signature makes for the email-fallback rule. Both directions are
 *   pinned in `challenge.test.ts`.
 *
 * The same "pure crypto + expiry, never a database" split `session.ts` calls load-bearing applies
 * here for the same reason: it is what lets the int suite assert "this challenge's MAC still
 * verifies and its `exp` is still in the future, YET the exchange 401s", which is the only way to
 * prove a rejection is the credential-version binding (GOTCHA-1) rather than expiry or tampering.
 */

/** The domain-separation label. Bump the `.v1` if the payload shape ever changes incompatibly. */
const CHALLENGE_PURPOSE = "420ai.mfa.challenge.v1";

/**
 * FIVE MINUTES. Long enough to unlock a phone and read a code, short enough that a challenge
 * scraped from a proxy log is dead before it is useful.
 *
 * THE TTL IS A BOUND, NOT THE MECHANISM. What makes a challenge safe across a concurrent password
 * change is the `cv` binding below, re-checked under a `FOR SHARE` lock (GOTCHA-1) — not this
 * number. Do not let a later comment claim otherwise.
 */
export const CHALLENGE_TTL_SECONDS = 5 * 60;

export interface ChallengePayload {
  /** The USER ID, deliberately — see `credentialVersion`'s comment on why not the email. */
  uid: string;
  /** The credential-version fingerprint this challenge was issued against. */
  cv: string;
  iat: number;
  exp: number;
}

/**
 * DOMAIN SEPARATION: the challenge is signed under a key DERIVED from `SESSION_SECRET`, never
 * `sessionSecret` itself. One HMAC, and it is the whole reason a challenge cannot verify as a
 * session (or a session as a challenge) — see the file header.
 */
function challengeKey(sessionSecret: string): Buffer {
  return createHmac("sha256", sessionSecret).update(CHALLENGE_PURPOSE).digest();
}

/**
 * A fingerprint of the credential state a challenge was issued against (D-15.8-4).
 *
 * WHY IT EXISTS. 15.6 closed a measured race by holding a `FOR SHARE` lock on the `users` row
 * across the login's scrypt, so a concurrent password reset could not have its `revokeAllSessions`
 * run past a session about to be inserted (`repositories/users.ts:58-77`). Splitting login into
 * "authenticate now, mint later" puts an UNBOUNDED gap between the credential check and the insert
 * — the gap now spans a human reading a code off their phone — and no database lock reaches across
 * that.
 *
 * So the challenge CARRIES this value, and `POST /v1/auth/mfa/verify` recomputes it from a re-read
 * of the `users` row taken under THE SAME `FOR SHARE` LOCK. Both orderings are then correct, and
 * the mechanism is the lock plus the comparison, named:
 *
 *   - reset first  → the hash changed, so the recomputed `cv` differs and the challenge is dead.
 *   - verify first → the `FOR SHARE` lock blocks the reset's `UPDATE users`, so the reset's
 *                    `revokeAllSessions` runs AFTER the new session row exists and revokes it.
 *
 * Neither needs SERIALIZABLE nor a retry loop.
 *
 * IT IS AN HMAC, NOT THE HASH ITSELF. The stored scrypt value is a password verifier; putting it,
 * or a bare digest of it, inside a token handed to an unauthenticated caller would leak an offline
 * attack target. Keyed under `challengeKey`, the output is opaque to anyone without
 * `SESSION_SECRET`, and 132 bits (22 base64url chars) is far more than a collision needs to be
 * infeasible for a value only ever compared for equality.
 *
 * A NULL HASH IS A REAL CASE, not a defensive branch: an SSO-only user has `password_hash IS NULL`
 * (`createUserWithoutPassword`). `null` and the empty string must therefore map to the SAME
 * fingerprint deterministically, which is why the callers pass the value read from the row rather
 * than `undefined` — a `?? ""` on `undefined` would be a different code path arriving at the same
 * string by accident.
 */
export function credentialVersion(sessionSecret: string, passwordHash: string | null): string {
  return createHmac("sha256", challengeKey(sessionSecret))
    .update(`cv:${passwordHash ?? ""}`)
    .digest("base64url")
    .slice(0, 22);
}

/**
 * Sign an MFA challenge for `userId`, bound to `credentialVersion`, valid for
 * `CHALLENGE_TTL_SECONDS`. Returns the token + `exp` (epoch-seconds), mirroring `signSession`.
 *
 * The payload names the USER ID and not the email, deliberately: the id is the only identifier that
 * cannot change between the two steps, whereas an email can be reassigned. Resolving `id → email →
 * findAdminCredential` on the way back would re-introduce a lookup by a mutable key at the exact
 * moment the code is trying to prove nothing mutated (hence `findCredentialById`).
 *
 * The options object rather than two adjacent `string` positionals, for the reason `mintSession`
 * records: transposable same-typed arguments are invisible in review.
 */
export function signChallenge(
  sessionSecret: string,
  opts: { userId: string; credentialVersion: string },
): { token: string; exp: number } {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + CHALLENGE_TTL_SECONDS;
  const payload: ChallengePayload = { uid: opts.userId, cv: opts.credentialVersion, iat, exp };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", challengeKey(sessionSecret)).update(body).digest("base64url");
  return { token: `${body}.${mac}`, exp };
}

/**
 * Verify a challenge's MAC (constant-time) + expiry. Returns the payload, or null for ANY failure
 * (malformed, tampered, wrong secret, expired, or a SESSION token presented here). Never throws.
 */
export function verifyChallenge(token: string, sessionSecret: string): ChallengePayload | null {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const presented = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(
    createHmac("sha256", challengeKey(sessionSecret)).update(body).digest("base64url"),
  );
  // Length guard before `timingSafeEqual`, which throws on a mismatch (see `password.ts:27`).
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  let payload: ChallengePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }
  // Guard the payload before property access — `JSON.parse` can yield null, and `null.exp` throws.
  // Only the secret-holder could forge such a token, but auth code stays defensive (`session.ts:73`).
  if (
    !payload ||
    typeof payload.exp !== "number" ||
    typeof payload.uid !== "string" ||
    typeof payload.cv !== "string" ||
    payload.exp < Math.floor(Date.now() / 1000)
  ) {
    return null;
  }
  return payload;
}
