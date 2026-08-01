import type { FastifyInstance, FastifyReply } from "fastify";
import type { Tx } from "@420ai/db";
import {
  clearMfa,
  confirmTotp,
  countUnusedRecoveryCodes,
  findCredentialById,
  findLiveSessionCreatedAt,
  findTotpCredential,
  generateToken,
  hashToken,
  recordMfaFailure,
  recordTotpUse,
  redeemRecoveryCode,
  replaceRecoveryCodes,
  revokeAllSessions,
  upsertUnconfirmedTotp,
} from "@420ai/db";
import { mfaCodeBodySchema, mfaEnrollBodySchema, mfaVerifyBodySchema } from "../schemas.js";
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from "../mfa/totp.js";
import { credentialVersion, verifyChallenge } from "../mfa/challenge.js";
import { verifyPassword } from "../password.js";
import { mintSession } from "./auth.js";
import { authorized, resolvePrincipal } from "../auth.js";

interface CodeBody {
  code: string;
}
interface EnrollBody {
  /** Absent for an SSO-only account, which has no password to re-present (D-15.8-16). */
  currentPassword?: string;
}
interface VerifyBody {
  challenge: string;
  code: string;
}

/**
 * RFC 4226 §7.3 throttling ("we RECOMMEND setting a throttling parameter T, which defines the
 * maximum number of possible attempts"), as a PER-USER counter on `totp_credentials` (D-15.8-9).
 *
 * The per-IP rate limit is not a substitute and this is not belt-and-braces: a six-digit code has
 * 10⁶ possibilities and the ±1-step window makes THREE of them live at any moment, while an attacker
 * who already holds the password can request a fresh challenge at will from any address. The
 * challenge is stateless (D-15.8-3), so it has nowhere to count — the credential row is the only
 * place the count can live.
 *
 * Exported so the int suite can drive the threshold instead of hard-coding a matching literal, which
 * is how a test and its subject drift apart.
 */
export const MFA_MAX_ATTEMPTS = 10;
export const MFA_LOCK_MS = 15 * 60_000;

/**
 * D-15.8-16 — how recent the CURRENT session must be for an SSO-only account to arm a second factor.
 *
 * Fifteen minutes: short enough that a stolen cookie is usually already outside it, long enough to
 * cover "I just signed in and went to Settings". It applies ONLY to accounts with no password, since
 * every other account re-proves with the password itself. Exported so the int suite drives the same
 * number the route does.
 */
export const MFA_REAUTH_MAX_SESSION_AGE_MS = 15 * 60_000;

/** Ten codes, the OWASP MFA cheat-sheet default: enough to survive a lost phone plus mistakes. */
const RECOVERY_CODE_COUNT = 10;

/** The `otpauth://` issuer label, shown as the account name inside the authenticator app. */
const TOTP_ISSUER = "420AI";

/**
 * The outcome of presenting a second factor. `"invalid"` deliberately collapses "wrong code",
 * "replayed code" and "unknown recovery code" into ONE answer: every one of them is a failed attempt
 * and telling them apart tells an attacker which of their guesses was structurally interesting.
 */
type FactorOutcome =
  | { kind: "ok" }
  | { kind: "not_enrolled" }
  | { kind: "locked"; lockedUntil: Date }
  | { kind: "invalid" };

/**
 * THE ONE PLACE a second factor is checked and spent. Both the login-completion path
 * (`POST /v1/auth/mfa/verify`) and the two state-changing paths (`disable`, `recovery-codes`) call
 * it, so "a code is single-use and a lockout applies" cannot be true on one and false on another.
 *
 * TYPED `Tx`, NOT `DbClient`, so the requirement below is unrepresentable rather than merely
 * documented (the 15.8 review found it stated in prose and permitted by the signature — the same
 * gap `findUserIdBySsoIdentity` closes by refusing to accept an email at all).
 *
 * Everything it does is a write — the replay stamp, the redemption
 * stamp, the failure increment — and each one has to commit or roll back with whatever the caller
 * decided on the strength of it. In particular the FAILURE INCREMENT runs inside the caller's
 * transaction on purpose: a route that rolled back after a failed attempt would silently forget it,
 * which is a throttle with a free retry built in.
 *
 * ORDER IS A SECURITY PROPERTY, not style. The lockout check precedes any code comparison, so a
 * locked credential costs no HMAC and cannot be probed; and the TOTP shape check precedes the
 * recovery-code lookup, so a six-digit string is never hashed and looked up as a recovery code (it
 * could not collide — `redeemRecoveryCode` hashes the FULL presented string — but the ordering makes
 * that argument unnecessary rather than merely true).
 */
async function consumeSecondFactor(tx: Tx, userId: string, code: string): Promise<FactorOutcome> {
  const totp = await findTotpCredential(tx, userId);
  // An UNCONFIRMED credential gates nothing (D-15.8-10) and is not a second factor.
  if (!totp?.confirmedAt) return { kind: "not_enrolled" };
  if (totp.lockedUntil && totp.lockedUntil > new Date()) {
    return { kind: "locked", lockedUntil: totp.lockedUntil };
  }

  const step = verifyTotp(totp.secret, code, { nowMs: Date.now() });
  const ok =
    step !== null
      ? // `false` here means REPLAY — the step was already spent (RFC 6238 §5.2 / D-15.8-8) — and it
        // is treated as an ordinary failure, counter included. A replay is either a user
        // double-submitting or an attacker with a shoulder-surfed code; neither deserves a distinct
        // response, and the second deserves the increment.
        await recordTotpUse(tx, userId, step)
      : await redeemRecoveryCode(tx, userId, hashToken(code));
  if (!ok) {
    await recordMfaFailure(tx, userId, MFA_MAX_ATTEMPTS, MFA_LOCK_MS);
    return { kind: "invalid" };
  }
  return { kind: "ok" };
}

/** A fresh set of recovery codes: the plaintexts (returned ONCE) and the hashes (stored). */
function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
  // `generateToken()` verbatim — 32 random bytes, base64url — exactly as `invites.token` and
  // `ingest_tokens` do. Machine-generated, so there is no dictionary for the sha256 storage to be
  // weak against (D-15.8-7).
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateToken());
  return { codes, hashes: codes.map(hashToken) };
}

/**
 * M15 15.8 MFA routes (D-M15-5). Five session-gated endpoints at `viewer` plus ONE unauthenticated
 * exchange (`POST /v1/auth/mfa/verify`), which is unauthenticated by necessity: it is the second half
 * of a login, so by construction the caller has no session yet.
 *
 * `viewer` is the correct rung for every gated route here, for the reason `POST /v1/auth/password`
 * records at `routes/auth.ts:428-429`: MANAGING YOUR OWN CREDENTIAL IS NOT A PRIVILEGED ACT ON THE
 * ORG, and a read-only account must still be able to protect itself. Note also that none of these
 * routes takes a user id in its path or body — they all act on `principal.userId`, so cross-user
 * abuse is unrepresentable rather than guarded (pinned by `mfa.int.test.ts`).
 *
 * M15 15.3 — NO `withOrg` anywhere in this file, deliberately, and for exactly the reason
 * `routes/auth.ts` and `routes/sso.ts` state at length. `totp_credentials` and `mfa_recovery_codes`
 * are IDENTITY tables with no `org_id` and no policy (D-15.8-13), read at the one moment before any
 * org context exists — a second factor is presented BEFORE a session is minted, so there is nothing
 * to scope by yet. `userId` is the scoping predicate on every call; the repository takes no `orgId`
 * at all. This file's entry in `org-scoping.test.ts`'s allow-list records the same argument.
 *
 * The writes here run in a plain `app.db.transaction(...)` rather than `withOrg`, and ATOMICITY is
 * what actually matters: a credential confirmed without its recovery codes, or codes replaced
 * without the old ones going away, are both worse than a failed request.
 *
 * MFA adds NO new enforcement point at request time. Once `verify` succeeds it mints an ordinary
 * 15.6 session through the shared `mintSession`, so revocation, expiry and `resolvePrincipal` all
 * apply unchanged.
 *
 * TWO THINGS DELIBERATELY ABSENT, stated so the next reader does not read them as gaps:
 *   - No QR rendering (D-15.8-14). The enrolment response carries the base32 secret and an
 *     `otpauth://` URI; every mainstream authenticator accepts manual entry. A QR needs either a new
 *     dependency or ~300 hand-rolled lines, and it belongs with the account surfaces in 15.10.
 *   - No admin "reset MFA for user X" endpoint. It is a privilege-escalation surface (an `admin`
 *     stripping an `owner`'s second factor), and 15.5's ladder lesson says such a route needs a
 *     ceiling AND a floor. Operator break-glass is direct database access, consistent with D-M15-7.
 */
export default async function mfaRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /v1/auth/mfa — the caller's own second-factor status, for the Settings card.
   *
   * An UNCONFIRMED credential reports `enabled: false`, which is the whole of D-15.8-10 expressed on
   * the wire: an abandoned enrolment must be indistinguishable from no enrolment, or a user who
   * closed the tab would believe they are protected when they are not.
   *
   * An `ADMIN_TOKEN` caller resolves to the bootstrap admin USER and gets that user's status —
   * mirroring `GET /v1/auth/sso/identities`. The service token itself is never MFA-gated (D-15.8-15).
   */
  app.get("/v1/auth/mfa", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    const totp = await findTotpCredential(app.db, principal.userId);
    const confirmedAt = totp?.confirmedAt ?? null;
    const cred = await findCredentialById(app.db, principal.userId);
    return reply.code(200).send({
      enabled: confirmedAt !== null,
      confirmedAt: confirmedAt?.toISOString() ?? null,
      recoveryCodesRemaining: confirmedAt
        ? await countUnusedRecoveryCodes(app.db, principal.userId)
        : 0,
      // D-15.8-16 — WHICH re-auth branch `enroll` will take, so the card asks for a password only
      // when one exists. It reports the CALLER's own account shape on a session-gated route, so it
      // discloses nothing they cannot already see from `GET /v1/auth/sso/identities`.
      passwordRequiredToEnrol: Boolean(cred?.passwordHash),
    });
  });

  /**
   * POST /v1/auth/mfa/enroll — phase ONE of a two-phase enrolment (D-15.8-10): mint a secret, store
   * it UNCONFIRMED, and hand it to the caller for manual entry.
   *
   * IT REQUIRES RE-AUTHENTICATION (D-15.8-16), and that is a security property, not friction. The
   * first version of this route was session-gated and nothing more, which made a stolen session
   * cookie into PERMANENT account takeover — reproduced end to end during the 15.8 code review:
   *
   *   1. the attacker enrols their own authenticator with nothing but the cookie;
   *   2. `enroll/confirm`'s `revokeAllSessions` (D-15.8-11) signs the real owner OUT;
   *   3. the owner's password still works but now yields only a challenge they cannot answer;
   *   4. A FULL PASSWORD RESET DOES NOT RECOVER THE ACCOUNT — nothing on the reset path clears
   *      `totp_credentials`, so proven control of the mailbox is no longer enough to get back in;
   *   5. the attacker keeps access with the factor they planted.
   *
   * Step 4 is what made it critical rather than untidy: it breaks the documented recovery story for a
   * compromised account, leaving operator database access as the only way back — and on a self-hosted
   * deployment the person locked out is often the only operator. Note the fix is NOT "make password
   * reset clear MFA": that would let anyone with mailbox access strip the second factor and defeat
   * the entire slice.
   *
   * This is the same asymmetry D-15.8-12 already closed for `disable` and `recovery-codes`, whose
   * stated reasoning — "an attacker holding a stolen session cookie must not be able to switch the
   * second factor off" — applies verbatim to switching it ON, and simply had not been made.
   *
   * TWO BRANCHES, because an SSO-only account has no password to re-present:
   *   - `password_hash` set → the current password is REQUIRED, exactly as `POST /v1/auth/password`
   *     requires it, and a wrong one is the same generic 401 login gives.
   *   - `password_hash IS NULL` (an SSO-created user) → the CURRENT SESSION must be recent
   *     (`MFA_REAUTH_MAX_SESSION_AGE_MS`). Weaker than a password, and deliberately so: the
   *     alternative is either blocking the users who most need MFA, or bolting a second OAuth round
   *     trip onto this slice. It still bounds the attack to a cookie stolen within the window, and
   *     the remedy when it refuses is discoverable — sign out and back in — which the error says.
   *
   * `enroll/confirm` needs NO gate of its own and that is not an omission: it can only confirm a
   * pending secret, and a pending secret can only exist because this route created one.
   *
   * An `ADMIN_TOKEN` caller has no session at all, so it falls to the password branch (or is refused
   * for a password-less bootstrap admin). That does not contradict D-15.8-15 — the service token is
   * never MFA-GATED at authentication; this is about arming a factor on a human's account.
   *
   * THE SECRET IS RETURNED IN THE RESPONSE BODY, and that is correct rather than a leak: the shared
   * secret is exactly what the caller must transcribe into their authenticator. It is stored
   * encrypted (D-15.8-6) and is never readable again — `GET /v1/auth/mfa` reports status only.
   */
  app.post<{ Body: EnrollBody }>(
    "/v1/auth/mfa/enroll",
    {
      schema: { body: mfaEnrollBodySchema },
      // 12.4c's brute-force guard. Session-gated routes normally do not need it, and this one does
      // ONLY because D-15.8-16 made it verify a password: without the limit, an attacker holding a
      // stolen session could grind the password here at one scrypt per request. Every other
      // password-touching route already carries it (login, signup, both reset routes,
      // invite-accept); `POST /v1/auth/password` was the other outlier and was fixed alongside this.
      config: { rateLimit: app.rateLimitLogin },
    },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "viewer")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      const cred = await findCredentialById(app.db, principal.userId);
      if (!cred) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (cred.passwordHash) {
        // 401, not 403: re-proving the current password is AUTHENTICATION, and a wrong one gets the
        // same answer login gives (`routes/auth.ts:437`).
        if (
          !request.body?.currentPassword ||
          !verifyPassword(request.body.currentPassword, cred.passwordHash)
        ) {
          return reply
            .code(401)
            .send({ error: "invalid email or password", reason: "password_required" });
        }
      } else {
        // SSO-only. The session's own age is the only factor available to re-prove.
        const since = request.sessionId
          ? await findLiveSessionCreatedAt(app.db, principal.userId, request.sessionId)
          : undefined;
        if (!since || Date.now() - since.getTime() > MFA_REAUTH_MAX_SESSION_AGE_MS) {
          // The message names the remedy, because there is no other way out for this user.
          return reply.code(401).send({
            error: "sign in again before enabling two-factor authentication",
            reason: "reauth_required",
          });
        }
      }

      const secret = generateTotpSecret();
      // Throws `MfaError("already_enrolled")` → 409 via app.ts.
      await upsertUnconfirmedTotp(app.db, principal.userId, secret);
      return reply.code(200).send({
        // Unpadded, matching the URI — `base32Decode` accepts either, and a trailing `=` in a field a
        // human retypes is one more thing to get wrong.
        secret: base32Encode(secret).replace(/=+$/, ""),
        otpauthUri: otpauthUri({ issuer: TOTP_ISSUER, account: principal.email, secret }),
      });
    },
  );

  /**
   * POST /v1/auth/mfa/enroll/confirm — phase TWO: prove the authenticator agrees, then arm the
   * credential and issue the recovery codes.
   *
   * ONE transaction for the confirm, the codes and the session revocation. A credential armed without
   * its recovery codes is the dangerous half-state: the user is now required to present a device they
   * have no fallback for.
   *
   * THE RECOVERY CODES ARE RETURNED HERE AND ONLY HERE. They are stored as sha256 (D-15.8-7), so
   * there is no endpoint that could show them again — regeneration replaces the set. The dashboard
   * says so explicitly.
   *
   * A WRONG CODE DOES NOT COUNT TOWARDS THE LOCKOUT, and that is deliberate rather than an omission.
   * The credential gates nothing yet, the caller is already authenticated by a session, and the
   * secret was handed to them one request ago — there is nothing to brute-force. Locking here would
   * only let a stolen session soft-block its victim's enrolment.
   */
  app.post<{ Body: CodeBody }>(
    "/v1/auth/mfa/enroll/confirm",
    { schema: { body: mfaCodeBodySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "viewer")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      const keep = request.sessionId ?? undefined;
      const outcome = await app.db.transaction(async (tx) => {
        const totp = await findTotpCredential(tx, principal.userId);
        if (!totp) return "not_enrolled" as const;
        if (totp.confirmedAt) return "already_enrolled" as const;
        const step = verifyTotp(totp.secret, request.body.code, { nowMs: Date.now() });
        if (step === null) return "invalid" as const;
        // The confirming step is STAMPED as spent, so the very code just used cannot be replayed at
        // the login that follows seconds later (RFC 6238 §5.2). `false` means a concurrent confirm
        // won — the blind UPDATE's predicate resolved it, see `confirmTotp`.
        if (!(await confirmTotp(tx, principal.userId, step))) return "already_enrolled" as const;
        const { codes, hashes } = newRecoveryCodes();
        await replaceRecoveryCodes(tx, principal.userId, hashes);
        // OWASP Session Management: renew after a privilege-level change. Every OTHER session
        // predates the second factor and would otherwise stay valid without ever presenting one.
        // The caller's own is spared, the same asymmetry `POST /v1/auth/password` documents: they
        // have just proved a factor in this tab, so signing them out is a usability tax with no
        // security gain.
        await revokeAllSessions(tx, principal.userId, keep);
        return { codes };
      });
      if (outcome === "not_enrolled") {
        return reply.code(409).send({ error: "no pending enrolment", reason: "not_enrolled" });
      }
      if (outcome === "already_enrolled") {
        return reply.code(409).send({
          error: "two-factor authentication is already enabled",
          reason: "already_enrolled",
        });
      }
      if (outcome === "invalid") {
        return reply.code(401).send({ error: "invalid code" });
      }
      return reply.code(200).send({ recoveryCodes: outcome.codes });
    },
  );

  /**
   * POST /v1/auth/mfa/disable — turn the second factor off. Requires a LIVE code (D-15.8-12).
   *
   * A session alone is deliberately not enough. An attacker holding a stolen session cookie must not
   * be able to switch the second factor off — that would make MFA protect only the login it guards
   * and nothing after it. This is the MFA analogue of `POST /v1/auth/password` demanding the current
   * password, and either factor is accepted (TOTP or a recovery code), because a user whose phone is
   * gone still needs a way out.
   *
   * ONE transaction with `revokeAllSessions`, for the reason the password-change route records: a
   * credential change with sessions left live is the dangerous half-state.
   */
  app.post<{ Body: CodeBody }>(
    "/v1/auth/mfa/disable",
    { schema: { body: mfaCodeBodySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "viewer")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      const keep = request.sessionId ?? undefined;
      const outcome = await app.db.transaction(async (tx) => {
        const factor = await consumeSecondFactor(tx, principal.userId, request.body.code);
        if (factor.kind !== "ok") return factor;
        await clearMfa(tx, principal.userId);
        // Every other session was minted while the second factor applied; after removing it they
        // continue on one. Spare the caller's, exactly as enrol-confirm does.
        await revokeAllSessions(tx, principal.userId, keep);
        return factor;
      });
      return replyForFactor(reply, outcome) ?? reply.code(204).send();
    },
  );

  /**
   * POST /v1/auth/mfa/recovery-codes — replace the recovery-code set. Requires a live code, for the
   * same reason `disable` does (D-15.8-12): a stolen session must not be able to mint itself a set of
   * long-lived bypass credentials.
   *
   * The new set is returned ONCE. The old set stops working the moment this commits.
   */
  app.post<{ Body: CodeBody }>(
    "/v1/auth/mfa/recovery-codes",
    { schema: { body: mfaCodeBodySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "viewer")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      const outcome = await app.db.transaction(async (tx) => {
        const factor = await consumeSecondFactor(tx, principal.userId, request.body.code);
        if (factor.kind !== "ok") return { factor };
        const { codes, hashes } = newRecoveryCodes();
        await replaceRecoveryCodes(tx, principal.userId, hashes);
        return { factor, codes };
      });
      return (
        replyForFactor(reply, outcome.factor) ??
        reply.code(200).send({ recoveryCodes: outcome.codes })
      );
    },
  );

  /**
   * POST /v1/auth/mfa/verify — THE SECOND HALF OF A LOGIN. Exchange a challenge plus a code for an
   * ordinary 15.6 session. Unauthenticated by necessity, and rate-limited like every other
   * unauthenticated credential endpoint (12.4c's guard).
   *
   * THE ORDER OF THE CHECKS BELOW IS A SECURITY PROPERTY, not style:
   *
   *   1. The challenge MAC + expiry, in pure crypto, before any database work — a forged or stale
   *      challenge costs one HMAC.
   *   2. The credential re-read UNDER THE SAME `FOR SHARE` LOCK the 15.6 login takes, and the `cv`
   *      comparison. THIS IS THE SUBTLEST PART OF THE SLICE (D-15.8-4 / GOTCHA-1): splitting login
   *      into "authenticate now, mint later" puts an unbounded gap — a human reading a phone — where
   *      15.6 held a lock, and this is what closes it. See `findCredentialById`'s doc comment for
   *      both orderings. The 5-minute TTL is a BOUND, not the mechanism.
   *   3. Enrolment + lockout, then the code itself.
   *
   * `"stale"` AND `"invalid"` ANSWER THE SAME GENERIC 401. A distinguishable "your password changed"
   * would tell an attacker both that their stolen challenge is stale AND that the account is live —
   * the same reasoning behind the generic login 401 (`routes/auth.ts:163`). `"locked"` is allowed to
   * be distinguishable (429 + `retryAfter`), because a lockout the user cannot see is a support
   * ticket, and an attacker learning that the lockout works is not a leak.
   */
  app.post<{ Body: VerifyBody }>(
    "/v1/auth/mfa/verify",
    { schema: { body: mfaVerifyBodySchema }, config: { rateLimit: app.rateLimitLogin } },
    async (request, reply) => {
      const payload = verifyChallenge(request.body.challenge, app.sessionSecret);
      if (!payload) {
        // `reason: "expired"` HERE AND NOWHERE ELSE. GOTCHA-1's generic-401 rule is about the
        // CREDENTIAL-VERSION mismatch below, where a distinguishable answer would tell an attacker
        // their stolen challenge is stale AND that the account is live. It does not extend to this
        // branch: a caller presenting a well-formed challenge already holds it, so naming the expiry
        // discloses nothing — while withholding it made the dashboard tell a user whose five-minute
        // window had lapsed that their CODE was wrong, so they retyped correct codes indefinitely.
        // `mfa.int.test.ts` pins that the cv-mismatch 401 still carries NO reason.
        return reply.code(401).send({ error: "invalid or expired challenge", reason: "expired" });
      }
      const outcome = await app.db.transaction(async (tx) => {
        // THE SAME LOCK THE 15.6 LOGIN TAKES — see the block comment above and GOTCHA-1.
        const cred = await findCredentialById(tx, payload.uid, { lock: true });
        if (!cred) return { kind: "invalid" as const };
        if (credentialVersion(app.sessionSecret, cred.passwordHash) !== payload.cv) {
          // The credential changed under this challenge. Same generic answer as a wrong code.
          return { kind: "invalid" as const };
        }
        const factor = await consumeSecondFactor(tx, payload.uid, request.body.code);
        if (factor.kind !== "ok") return factor;
        // The row is inserted while the `FOR SHARE` lock is still held, so a concurrent password
        // reset's `revokeAllSessions` cannot run past it — the identical argument 15.6 makes.
        return {
          kind: "ok" as const,
          session: await mintSession(tx, request, app.sessionSecret, {
            userId: payload.uid,
            email: cred.email,
          }),
        };
      });
      if (outcome.kind !== "ok") {
        // `not_enrolled` collapses into the generic 401 here — unlike on the session-gated routes,
        // where the caller is already authenticated and a precise answer helps them. An
        // unauthenticated caller learning "that account has no second factor" is enumeration.
        return replyForFactor(reply, outcome, { collapseNotEnrolled: true })!;
      }
      return reply.code(200).send(outcome.session);
    },
  );
}

/**
 * Map a non-`ok` `FactorOutcome` to its response, or `null` when the factor was accepted. Written as
 * one helper rather than three copies so the generic-401 rule cannot hold on two routes and lapse on
 * the third.
 *
 * `Retry-After` is sent as a header AND in the body: the header is what an HTTP client honours, the
 * body is what the dashboard renders.
 */
function replyForFactor(
  reply: FastifyReply,
  outcome: FactorOutcome,
  opts?: { collapseNotEnrolled?: boolean },
): FastifyReply | null {
  switch (outcome.kind) {
    case "ok":
      return null;
    case "not_enrolled":
      return opts?.collapseNotEnrolled
        ? reply.code(401).send({ error: "invalid code" })
        : reply
            .code(409)
            .send({ error: "two-factor authentication is not enabled", reason: "not_enrolled" });
    case "locked": {
      const retryAfter = Math.max(
        1,
        Math.ceil((outcome.lockedUntil.getTime() - Date.now()) / 1000),
      );
      return reply
        .code(429)
        .header("retry-after", String(retryAfter))
        .send({ error: "too many failed attempts", reason: "locked", retryAfter });
    }
    case "invalid":
      return reply.code(401).send({ error: "invalid code" });
  }
}
