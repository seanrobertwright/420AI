/**
 * M15 15.8 — the MFA challenge's ONE definition, shared by the three route handlers that touch it
 * (the login proxy, the SSO callback, and the verify exchange) so its name, path and lifetime cannot
 * drift between them. Same reason `lib/sso-flow.ts` exists.
 */
export const MFA_CHALLENGE_COOKIE = "ai_mfa";

/**
 * THE COOKIE'S PATH, AND IT MUST BE PASSED TO `delete` AS WELL AS TO `set`.
 *
 * Scoping it to the MFA routes is deliberate — it is a CREDENTIAL for half a login and has no
 * business riding along on every request to the app. But browsers key cookies by
 * `(name, domain, path)`, so `cookies().delete("ai_mfa")` — which defaults to `Path=/` — does NOT
 * remove a cookie stored here. It emits a second, unrelated expired cookie and leaves the real one
 * live for its full `Max-Age`.
 *
 * THAT EXACT BUG SHIPPED IN 15.7 (`lib/sso-flow.ts:19-33` documents it: the callback's own comment
 * promised the cookie was cleared on every path while `Path=/` went out on the wire, so the PKCE
 * verifier survived every refused attempt for ten minutes). Do not re-introduce it — the constant
 * exists so the call sites cannot disagree, and `verify/route.test.ts` asserts the delete carries it.
 */
export const MFA_CHALLENGE_PATH = "/api/auth/mfa";

/**
 * Five minutes, matching ingest's `CHALLENGE_TTL_SECONDS`. The cookie's expiry is a CONVENIENCE, not
 * the bound: ingest re-checks the signed `exp` on every exchange, so a cookie a client refused to
 * drop buys nothing. Keeping the two numbers equal only means the browser stops sending a challenge
 * at roughly the moment the server would start refusing it.
 */
export const MFA_CHALLENGE_MAX_AGE_SECONDS = 300;

export interface MfaFlowState {
  /** The signed challenge token issued by ingest. NEVER exposed to client JS (`httpOnly`). */
  challenge: string;
}

/**
 * Parse the cookie value, returning null for anything malformed — mirroring `parseSsoFlow`.
 *
 * Note what is NOT in here: `next`. The destination stays in the URL and goes through `safeNext`,
 * exactly as the login form's own `?next=` does. Putting it in the cookie would add a second,
 * differently-validated path to the same open-redirect surface 15.7 had to close once.
 */
export function parseMfaFlow(raw: string | undefined): MfaFlowState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MfaFlowState>;
    if (typeof parsed.challenge !== "string" || !parsed.challenge) return null;
    return { challenge: parsed.challenge };
  } catch {
    return null;
  }
}

/**
 * The `set` options for the challenge cookie, in one place so no call site can forget `httpOnly`.
 *
 * `httpOnly` is not hygiene here — the challenge is HALF A CREDENTIAL (with a code it becomes a
 * session), so client JS must never be able to read it (D8). `sameSite: "lax"` matches the session
 * cookie: the SSO callback arrives as a top-level cross-site navigation, and `strict` would drop the
 * cookie on exactly that hop.
 */
export function mfaChallengeCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  path: string;
  secure: boolean;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: MFA_CHALLENGE_PATH,
    secure: process.env.NODE_ENV === "production",
    maxAge: MFA_CHALLENGE_MAX_AGE_SECONDS,
  };
}
