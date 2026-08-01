import type { FastifyInstance, FastifyRequest } from "fastify";
import { findCredentialById, findLiveSessionCreatedAt } from "@420ai/db";
import { verifyPassword } from "./password.js";

/**
 * M15 15.9 — THE re-authentication gate, extracted from `routes/mfa.ts` (D-15.8-16) so the two
 * routes that need it share ONE definition.
 *
 * It was extracted rather than copied, and that is the whole point of this file. Two copies of an
 * auth check drift, the divergence is invisible to `tsc`, and this repo has already paid for that
 * class of bug once. If a third caller appears it uses this; it does not paste the branches again.
 *
 * WHY A LONG-LIVED ACTION NEEDS IT. A credential minted from a STOLEN COOKIE is a persistence
 * primitive that outlives the session it came from: the attacker loses the cookie at the next
 * logout or password change and keeps the thing they minted. That was D-15.8-16's argument for
 * arming a second factor, and it applies at least as strongly to minting an API key, which has no
 * expiry at all by default (D-15.9-6).
 *
 * TWO BRANCHES, because not every account has a password:
 *
 *   - `password_hash` set ⇒ re-prove the PASSWORD. 401 and not 403, because re-proving a current
 *     password is AUTHENTICATION, and a wrong one gets exactly the answer login gives.
 *   - `password_hash` null (an SSO-only account) ⇒ the CURRENT SESSION'S AGE is the only factor
 *     available. Nothing else about such an account can be re-proved without bouncing the user
 *     through their identity provider.
 *
 * NOT applied to listing or revoking, deliberately: REVOCATION MUST NEVER BE HARDER THAN MINTING.
 * A gate on the "undo" is a gate on the incident response.
 *
 * The caller supplies `ssoPrompt` because the SSO branch's message names the REMEDY, and the remedy
 * is the only way out for that user — so it has to say what they were trying to do.
 */

/**
 * D-15.8-16 — how recent the CURRENT session must be for an SSO-only account to re-authenticate.
 *
 * Fifteen minutes: short enough that a stolen cookie is usually already outside it, long enough to
 * cover "I just signed in and went to Settings". It applies ONLY to accounts with no password,
 * since every other account re-proves with the password itself. Exported so the int suites drive
 * the same number the routes do rather than hard-coding a matching literal — which is how a test
 * and its subject drift apart.
 */
export const REAUTH_MAX_SESSION_AGE_MS = 15 * 60_000;

/**
 * `ok: false` carries the response the caller must send VERBATIM. Returning it rather than sending
 * it keeps this a pure decision: the caller owns its reply, and a helper that wrote to the socket
 * could not be reused by a route that needs to do anything afterwards.
 */
export type ReauthResult =
  | { ok: true }
  | { ok: false; code: 401; body: { error: string; reason?: string } };

/**
 * Re-authenticate `userId` for a sensitive action. See the file header for the two branches.
 *
 * `request` is read only for `sessionId` — the SSO branch needs the caller's own session row, and
 * `resolvePrincipal` has already stashed its id there (an API-key caller has `sessionId === null`
 * and therefore fails the SSO branch closed, which is correct: a key must not be able to mint
 * another key without a password).
 */
export async function requireRecentAuth(
  app: FastifyInstance,
  request: FastifyRequest,
  userId: string,
  currentPassword: string | undefined,
  ssoPrompt: string,
): Promise<ReauthResult> {
  const cred = await findCredentialById(app.db, userId);
  if (!cred) {
    // No credential row for a resolved principal is a broken invariant, not a user error — answer
    // the same 401 the gate above would have, and reveal nothing further.
    return { ok: false, code: 401, body: { error: "admin authorization required" } };
  }
  if (cred.passwordHash) {
    if (!currentPassword || !verifyPassword(currentPassword, cred.passwordHash)) {
      return {
        ok: false,
        code: 401,
        body: { error: "invalid email or password", reason: "password_required" },
      };
    }
    return { ok: true };
  }
  // SSO-only. The session's own age is the only factor available to re-prove.
  const since = request.sessionId
    ? await findLiveSessionCreatedAt(app.db, userId, request.sessionId)
    : undefined;
  if (!since || Date.now() - since.getTime() > REAUTH_MAX_SESSION_AGE_MS) {
    return { ok: false, code: 401, body: { error: ssoPrompt, reason: "reauth_required" } };
  }
  return { ok: true };
}
