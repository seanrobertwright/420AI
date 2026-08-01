import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DbClient } from "@420ai/db";
import {
  acceptInvite,
  consumePasswordReset,
  createPasswordReset,
  createSession,
  createUserWithPassword,
  ensurePersonalOrg,
  findAdminCredential,
  findTotpCredential,
  findInviteByToken,
  findUserIdByEmail,
  getOrgName,
  listSessions,
  normalizeEmail,
  revokeAllSessions,
  revokeSession,
  updatePasswordHash,
} from "@420ai/db";
import {
  acceptInviteBodySchema,
  changePasswordBodySchema,
  loginBodySchema,
  passwordResetConfirmBodySchema,
  passwordResetRequestBodySchema,
  signupBodySchema,
} from "../schemas.js";
import { hashPassword, verifyPassword } from "../password.js";
import { signSession, SESSION_TTL_SECONDS } from "../session.js";
import { credentialVersion, signChallenge } from "../mfa/challenge.js";
import { resolvePrincipal, authorized, isUuid } from "../auth.js";

interface LoginBody {
  email: string;
  password: string;
}
interface AcceptInviteBody {
  token: string;
  password: string;
}
interface SignupBody {
  email: string;
  password: string;
}
interface ResetRequestBody {
  email: string;
}
interface ResetConfirmBody {
  token: string;
  password: string;
}
interface ChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}

// ── module-private helpers ────────────────────────────────────────────────────────────────────

/**
 * M15 15.6 — mint a `sessions` row AND the token that carries its id (D-M15-12). The three places
 * that log a user in (login, invite-accept, signup) all go through here.
 *
 * The row's `expires_at` and the token's `exp` come from THE SAME `SESSION_TTL_SECONDS`, in one
 * place, deliberately: computed independently at three call sites the constant would eventually
 * drift, and a token that outlives its row (or vice versa) is a 401 nobody can explain. (The two
 * read the clock a moment apart — the insert's round trip sits between them, and `exp` floors to
 * whole seconds — so they agree on the TTL, not on the exact instant. Sub-second on a 7-day
 * lifetime; worth stating precisely rather than claiming an exactness that is not there.)
 *
 * `userId` and `email` arrive in an OPTIONS OBJECT rather than as two adjacent `string` positional
 * parameters, for the reason the repo makes `orgId` always-second: adjacent same-typed arguments
 * are transposable in a way review cannot see. Here the transposition would be caught by the uuid
 * cast, but relying on the database to catch a caller's slip is the weaker design.
 *
 * The user-agent is truncated to 256 chars HERE, at the edge (D-15.6-9). It is attacker-controlled
 * free text that is later rendered in a session list, and the column is unbounded `text`, so the
 * bound belongs at the boundary rather than in the schema.
 *
 * M15 15.7 — EXPORTED (it was module-private through 15.6) so `routes/sso.ts` reuses this one
 * definition rather than re-deriving the row/token pair. An SSO login is an ordinary login the
 * moment the policy admits it, and a second implementation of this is precisely how the row's
 * `expires_at` and the token's `exp` would drift apart.
 */
export async function mintSession(
  db: DbClient,
  request: FastifyRequest,
  sessionSecret: string,
  { userId, email }: { userId: string; email: string },
): Promise<{ token: string; expiresAt: string }> {
  const { id: sid } = await createSession(
    db,
    userId,
    new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
    request.headers["user-agent"]?.slice(0, 256) ?? null,
  );
  const { token, exp } = signSession(email, sessionSecret, SESSION_TTL_SECONDS, sid);
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * M15 15.8 — THE ONE PLACE a completed authentication becomes either a session or an MFA challenge.
 *
 * Both login paths call it — password login below, and the SSO callback in `routes/sso.ts` — so
 * "an enrolled user gets asked for a second factor" cannot be true on one path and false on the
 * other (D-15.8-5). That is not a tidiness argument: if MFA guarded only the password path, an
 * attacker who compromises the linked Google account signs in with no second factor at all and the
 * enrolment was theatre. One shared helper makes the two paths agree by construction rather than by
 * two implementations that happen to match today.
 *
 * `passwordHash` is a REQUIRED parameter, not read from the database here, and that is the whole
 * point: the caller must pass the value it read under its own `FOR SHARE` lock, so the `cv`
 * fingerprint in the challenge describes the credential state the login actually authenticated
 * against. Re-reading it here would put an unlocked read between the two and reopen the race
 * (D-15.8-4 / GOTCHA-1). It is `string | null` and never `undefined` — an SSO-only user genuinely
 * has a null hash (`createUserWithoutPassword`), and `null` and `undefined` must not produce
 * different fingerprints.
 *
 * An UNCONFIRMED credential does not gate (D-15.8-10): a user who abandoned enrolment logs in
 * exactly as before. This is the check that keeps that promise, and it is `confirmedAt`, never the
 * mere existence of the row.
 *
 * `mintSession` stays exported and UNCHANGED; this wraps it. Changing its signature would ripple
 * into `sso.ts` and both int suites for no gain, and the three paths that mint for a user being
 * CREATED (invite-accept, signup, SSO signup) must keep calling it directly — a user who does not
 * exist yet cannot have a second factor.
 */
export async function mintSessionOrChallenge(
  app: FastifyInstance,
  db: DbClient,
  request: FastifyRequest,
  { userId, email, passwordHash }: { userId: string; email: string; passwordHash: string | null },
): Promise<
  { token: string; expiresAt: string } | { mfaRequired: true; challenge: string; expiresAt: string }
> {
  const totp = await findTotpCredential(db, userId);
  if (!totp?.confirmedAt) {
    return mintSession(db, request, app.sessionSecret, { userId, email });
  }
  const { token, exp } = signChallenge(app.sessionSecret, {
    userId,
    credentialVersion: credentialVersion(app.sessionSecret, passwordHash),
  });
  return {
    mfaRequired: true,
    challenge: token,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/**
 * M12 12.3 admin login surface. POST /v1/auth/login is the ONE un-gated admin route
 * (it's the entry point); it issues an HMAC session token the dashboard then carries as a bearer
 * (the hybrid resolvePrincipal gate accepts it). GET /v1/auth/me is a session-gated identity probe
 * for the dashboard's logged-in state. (12.3 called that token STATELESS; M15 15.6 made it stateful
 * — see the 15.6 paragraph at the end of this block.)
 *
 * Brute-force rate-limiting was deferred from 12.3 and SHIPPED in 12.4c: the route config
 * below applies app.rateLimitLogin (strict per-route limit, on by default via server.ts).
 *
 * M15 15.3 — NO `withOrg` here, deliberately, and this file is the clearest case of why the
 * identity tables carry no RLS (D-15.3-4). `findAdminCredential` reads `users` in order to
 * ESTABLISH who the caller is; a policy keyed on an org context would be circular — login is
 * precisely the moment before any org is known.
 *
 * M15 15.5 — the file grew from "login" to THE UNAUTHENTICATED IDENTITY EDGE, and the 15.3
 * explanation above now covers more than it used to say, so it is extended rather than left stale:
 *
 *   - The INVITE routes (preview + accept) read `invites` by token IN ORDER TO discover the org,
 *     exactly as `pair.ts` reads a pairing code. That is why migration 0017 gives `invites` the
 *     BOOTSTRAP-PERMISSIVE org policy (D-15.3-3/D-15.5-2) rather than a strict one: with no context
 *     set the lookup must succeed, because the lookup is what establishes the context. These calls
 *     therefore must NOT be wrapped in `withOrg` — wrapping them would read zero rows.
 *   - The RESET routes read `password_reset_tokens`, which carries NO policy at all (D-15.5-1), for
 *     the same reason `users` does not: a reset is consumed before any identity is established.
 *   - `POST /v1/auth/password` is the one SESSION-GATED route added here, and it still needs no
 *     `withOrg`: it reads and writes the caller's own `users` row, which is not tenant data.
 *
 * Writes on this file's paths run in a plain `app.db.transaction(...)`, not `withOrg`. That is the
 * correct choice and not an omission: the tables touched (`users`, `memberships`,
 * `password_reset_tokens`) carry no RLS, and `invites` is permissive without a context — while the
 * ATOMICITY is what actually matters here (a user created without their membership, or a token
 * consumed without the password changing, are both worse than a failed request).
 *
 * M15 15.6 — the file gains SESSION MANAGEMENT (D-M15-12), and the `withOrg` reasoning above
 * extends to it unchanged: `sessions` is an identity table with no `org_id` and no policy
 * (D-15.6-3), read inside `resolvePrincipal` at the one moment before any org context exists. Every
 * session read and write here is scoped by `userId`, never `orgId`, because a session belongs to a
 * USER — being removed from an org ends the login (`routes/members.ts`), but the org is not what
 * owns the row.
 */
export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: LoginBody }>(
    "/v1/auth/login",
    {
      schema: { body: loginBodySchema },
      // M12 12.4c: brute-force guard (deferred here from 12.3). app.rateLimitLogin is decorated
      // in buildApp BEFORE this route registers — {max,timeWindow} when opted in (server.ts /
      // the int test), or false when off (→ no limit; the plugin isn't even registered then).
      config: { rateLimit: app.rateLimitLogin },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      // M15 15.6 — THE CREDENTIAL READ AND THE SESSION INSERT ARE ONE TRANSACTION, holding a
      // `FOR SHARE` lock on the user row across the scrypt in between. Without the lock a login
      // that overlapped a password RESET could mint a session the reset's `revokeAllSessions` had
      // already run past, leaving a session minted from the OLD password valid for 7 days — the
      // exact takeover-recovery failure D-15.6-6 exists to close, and reproducible at the HTTP
      // layer. `findAdminCredential`'s doc comment names the lock and both orderings.
      //
      // The cost is holding a transaction across ~100 ms of scrypt on a rate-limited path, which
      // the sibling reset-confirm route already accepts for the same class of reason.
      const outcome = await app.db.transaction(async (tx) => {
        const cred = await findAdminCredential(tx, email, { lock: true });
        // Generic 401 whether the user is missing or the password is wrong (no user-enumeration).
        if (!cred?.passwordHash || !verifyPassword(password, cred.passwordHash)) {
          return "invalid" as const;
        }
        // M15 15.5 (D-15.5-3): sign the NORMALIZED address, so a session minted from `Foo@corp.com`
        // carries the same `sub` that `findPrincipalByEmail` will look up on every later request.
        // M15 15.6: the row is created BEFORE the token is signed — a token can never name a `sid`
        // that does not exist, so `resolvePrincipal` failing closed on an unknown `sid` is safe.
        //
        // M15 15.8: for an ENROLLED user this returns a short-lived MFA challenge instead of a
        // session, and no `sessions` row is written at all. The lock and the transaction above are
        // UNCHANGED — `cred.passwordHash` is passed through so the challenge's `cv` fingerprint is
        // computed from the LOCKED read, which is what lets `POST /v1/auth/mfa/verify` prove nothing
        // changed in between (D-15.8-4 / GOTCHA-1).
        return mintSessionOrChallenge(app, tx, request, {
          userId: cred.id,
          email: cred.email,
          passwordHash: cred.passwordHash,
        });
      });
      if (outcome === "invalid") {
        return reply.code(401).send({ error: "invalid email or password" });
      }
      return reply.code(200).send(outcome);
    },
  );

  app.get("/v1/auth/me", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    // M15 15.2 BUG FIX: report the CALLER's email, not the env admin's. Before the
    // principal existed this returned `app.adminEmail` no matter who logged in, so a
    // second user saw the admin's address in the dashboard nav. Shape is unchanged.
    return reply.code(200).send({ email: principal.email });
  });

  // ── M15 15.5 ──────────────────────────────────────────────────────────────────────────────

  /**
   * GET /v1/auth/invites/:token — PREVIEW an invitation so the accept page can say "join Acme as
   * member" before asking for a password. Unauthenticated by necessity: the holder has no account
   * yet, and the token IS the credential.
   *
   * The token is deliberately NOT echoed back, and nothing about the org beyond its NAME is
   * exposed. `InviteError` (unknown/revoked/accepted/expired) becomes a 410 with its `reason` via
   * app.ts's handler, mirroring how a spent pairing code answers.
   */
  app.get<{ Params: { token: string } }>("/v1/auth/invites/:token", async (request, reply) => {
    const invite = await findInviteByToken(app.db, request.params.token);
    const orgName = await getOrgName(app.db, invite.orgId);
    return reply.code(200).send({
      email: invite.email,
      role: invite.role,
      orgName: orgName ?? null,
      expiresAt: invite.expiresAt.toISOString(),
    });
  });

  /**
   * POST /v1/auth/invites/accept — redeem an invitation: create the user with the password they
   * chose, insert EXACTLY ONE membership in the inviting org, and return a session so they are
   * logged in (the same shape `/v1/auth/login` returns).
   *
   * `createUserWithPassword`, NEVER `setUserPassword` (GOTCHA-1 / D-15.5-9). `setUserPassword`
   * calls `ensurePersonalOrg`, and since `findPrincipalByEmail` resolves the FIRST membership by
   * `(created_at, id)`, a personal `owner` membership created first would shadow the invited one
   * FOREVER — the invite would look like it worked while the user resolved to their own empty org
   * at the wrong rung. `identity.int.test.ts` pins this with a membership-count assertion.
   */
  app.post<{ Body: AcceptInviteBody }>(
    "/v1/auth/invites/accept",
    {
      schema: { body: acceptInviteBodySchema },
      // An unauthenticated WRITE that creates a user and runs scrypt. The token is 32 random bytes
      // so guessing is not the threat; bounding the request rate is (the same reason signup carries
      // it). Note the hash below is computed only AFTER `findInviteByToken` has validated the
      // token, so an invalid token costs a cheap indexed read rather than a scrypt.
      config: { rateLimit: app.rateLimitLogin },
    },
    async (request, reply) => {
      // Validate + resolve the org BEFORE creating anything (throws InviteError → 410).
      const invite = await findInviteByToken(app.db, request.body.token);
      if (await findUserIdByEmail(app.db, invite.email)) {
        return reply
          .code(409)
          .send({ error: "user already exists — multi-org membership lands in 15.10" });
      }

      const passwordHash = hashPassword(request.body.password);
      // ONE transaction: `acceptInvite` re-validates the token inside it, so two concurrent
      // accepts cannot both stamp the same invite, and a crash cannot leave a user with no
      // membership (which `resolvePrincipal` would fail closed on — a permanently locked account).
      // M15 15.6: the new user's id must ESCAPE the transaction so the session can be minted for
      // it — REUSED, never re-queried, so there is no window in which a second `users` row for the
      // same address could be resolved instead. RETURNED out of the callback rather than assigned
      // to an outer `let`: the `let` form needs a `!` at the use site (TS cannot see through the
      // callback), and that assertion would hide a real bug the day someone adds an early `return`
      // to the transaction — `undefined` would reach `createSession` as a `user_id` AFTER the user
      // row had already committed. Returning it makes that a type error instead.
      const newUserId = await app.db.transaction(async (tx) => {
        const id = await createUserWithPassword(tx, invite.email, passwordHash);
        await acceptInvite(tx, request.body.token, id);
        return id;
      });

      // The session is minted AFTER the transaction commits, deliberately: a rolled-back accept
      // must not leave a live session pointing at a user row that no longer exists.
      return reply.code(200).send(
        await mintSession(app.db, request, app.sessionSecret, {
          userId: newUserId,
          email: invite.email,
        }),
      );
    },
  );

  /**
   * POST /v1/auth/signup — self-service account creation, OFF BY DEFAULT (D-M15-6 / D-15.5-5).
   *
   * 403 when disabled, not 404. The route's existence is public knowledge (this is open source), so
   * pretending it is absent buys nothing while making a misconfiguration undiagnosable.
   *
   * D-15.5-6: a signup creates a NEW PERSONAL ORG and never joins an existing one. A signup that
   * joined the first org it found would hand every passer-by a tenant. This is the one new path
   * where `ensurePersonalOrg` is the correct call.
   */
  app.post<{ Body: SignupBody }>(
    "/v1/auth/signup",
    {
      schema: { body: signupBodySchema },
      // One of the two new unauthenticated WRITE endpoints, and an account-creation firehose
      // without this. Same per-route limit the login route uses.
      config: { rateLimit: app.rateLimitLogin },
    },
    async (request, reply) => {
      if (!app.selfSignupEnabled) {
        return reply.code(403).send({ error: "self-signup is disabled" });
      }
      const email = normalizeEmail(request.body.email);
      if (await findUserIdByEmail(app.db, email)) {
        // Deliberately NOT the generic response the reset route uses: signup cannot avoid telling
        // you an address is taken (it has to refuse), so a vague error would only confuse.
        return reply.code(409).send({ error: "user already exists" });
      }

      const passwordHash = hashPassword(request.body.password);
      // Same escape-the-transaction shape as invite-accept above, and for the same reason.
      const newUserId = await app.db.transaction(async (tx) => {
        const id = await createUserWithPassword(tx, email, passwordHash);
        await ensurePersonalOrg(tx, id, email);
        return id;
      });

      return reply
        .code(200)
        .send(await mintSession(app.db, request, app.sessionSecret, { userId: newUserId, email }));
    },
  );

  /**
   * POST /v1/auth/password-reset — mail a single-use reset link.
   *
   * ALWAYS 202, whether or not the address has an account (D-15.5-7). That mirrors the generic 401
   * on login above and OWASP's "return a consistent message" rule: a 404 here would turn this
   * endpoint into a user-enumeration oracle. The consequence — a reset request for an unknown
   * address does nothing and reports success — is intended, and `identity.int.test.ts` asserts it
   * so nobody later "fixes" it into a 404.
   *
   * 503 with NO mailer configured (D-15.5-10). Unlike the admin-gated invite route, this one is
   * UNAUTHENTICATED, so returning the token in the response would be a complete account-takeover
   * primitive for anyone who can reach the port. The 503 fires before the always-202 path because
   * it is a property of the DEPLOYMENT, not of the requested address — it leaks nothing.
   */
  app.post<{ Body: ResetRequestBody }>(
    "/v1/auth/password-reset",
    {
      schema: { body: passwordResetRequestBodySchema },
      // The second new unauthenticated write endpoint, and a mail-bomb without this.
      config: { rateLimit: app.rateLimitLogin },
    },
    async (request, reply) => {
      const mailer = app.mailer;
      if (!mailer) {
        return reply
          .code(503)
          .send({ error: "password reset is unavailable — no mail transport is configured" });
      }
      const email = normalizeEmail(request.body.email);
      const userId = await findUserIdByEmail(app.db, email);
      if (userId) {
        const { token, expiresAt } = await createPasswordReset(app.db, userId);
        try {
          await mailer.send({
            to: email,
            subject: "Reset your 420AI password",
            text: [
              "Someone requested a password reset for this address.",
              "",
              `Reset it here: ${mailer.appBaseUrl}/reset/${token}`,
              "",
              `This link expires ${expiresAt.toISOString()} and can be used once.`,
              "If you did not request this, no action is needed.",
            ].join("\n"),
          });
        } catch (err) {
          // A send failure must NOT change the status code: a 500 here versus a 202 for an unknown
          // address would re-introduce exactly the enumeration oracle the always-202 rule exists to
          // close. The operator still learns about it — this is a route, so logging is in bounds.
          request.log.error(err, "password-reset mail delivery failed");
        }
      }
      return reply.code(202).send({ status: "accepted" });
    },
  );

  /**
   * POST /v1/auth/password-reset/confirm — spend the token and set the new password.
   *
   * ONE transaction with `consumePasswordReset`, so the token is stamped and the password written
   * together. Split across two transactions, a leaked token would be replayable in the window
   * between them.
   */
  app.post<{ Body: ResetConfirmBody }>(
    "/v1/auth/password-reset/confirm",
    {
      schema: { body: passwordResetConfirmBodySchema },
      // An unauthenticated WRITE, so it carries the same limit as login/signup/reset-request.
      config: { rateLimit: app.rateLimitLogin },
    },
    async (request, reply) => {
      await app.db.transaction(async (tx) => {
        // Throws PasswordResetError (unknown/consumed/expired) → 410 via app.ts.
        const { userId } = await consumePasswordReset(tx, request.body.token);
        // `hashPassword` is called HERE, AFTER the token is validated, and the ordering is a
        // security property rather than a style choice. scrypt (N=16384, keylen 64) blocks the
        // single-threaded event loop for ~100 ms; hashing BEFORE validation — which is what this
        // route did until the 15.5 review — hands an unauthenticated caller a cheap
        // CPU-exhaustion primitive, since a garbage token still costs a full scrypt before being
        // rejected. Note the sibling paths already got this right by accident of ordering (login
        // hashes only after a hash is found, accept-invite only after the invite validates), which
        // is precisely why the wrong order read as correct here.
        //
        // The cost is holding the transaction open across the scrypt. That is acceptable: it locks
        // one `password_reset_tokens` row on a rate-limited, low-volume path, and it buys the
        // atomicity that makes a leaked token non-replayable.
        await updatePasswordHash(tx, userId, hashPassword(request.body.password));
        // M15 15.6 (D-M15-12 / D-15.6-6) — INVALIDATE ON CREDENTIAL CHANGE, and here that means
        // ALL of them, sparing none. OWASP's Forgot-Password guidance requires it, and the reason
        // is the canonical recovery story: "somebody took over my account, let me reset my
        // password". The caller is UNAUTHENTICATED and has no current session to spare; the whole
        // point of the flow is that somebody else may be holding one.
        //
        // Inside the EXISTING transaction, not a second one: a password written but sessions left
        // live is exactly the half-state the atomicity note above warns about, and it is the more
        // dangerous half — the victim believes they have locked the attacker out.
        await revokeAllSessions(tx, userId);
      });
      return reply.code(204).send();
    },
  );

  /** POST /v1/auth/password — change your OWN password. Session-gated; requires the current one. */
  app.post<{ Body: ChangePasswordBody }>(
    "/v1/auth/password",
    {
      schema: { body: changePasswordBodySchema },
      // M15 15.8 — added late, and the gap it closes predates this slice. This route VERIFIES the
      // current password, so without a limit an attacker holding a stolen session cookie can grind
      // it here at one scrypt per request — a password-guessing oracle behind a session, which is
      // exactly the credential a session alone should not yield. Every sibling that touches a
      // password already carried this (login, signup, both reset routes, invite-accept); this one
      // and 15.8's `POST /v1/auth/mfa/enroll` were the two outliers, found while reviewing the
      // latter and fixed together rather than one at a time.
      config: { rateLimit: app.rateLimitLogin },
    },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      // `viewer`: changing your own credential is not a privileged act on the ORG, and a read-only
      // account must still be able to rotate its password.
      if (!authorized(principal, "viewer")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      const cred = await findAdminCredential(app.db, principal.email);
      if (!cred?.passwordHash || !verifyPassword(request.body.currentPassword, cred.passwordHash)) {
        // 401, not 403: re-proving the current password is authentication, and a wrong one is the
        // same answer login gives.
        return reply.code(401).send({ error: "invalid email or password" });
      }
      // ONE transaction, for the same reason the reset-confirm route above uses one: a password
      // written with sessions left live is the dangerous half-state — the user believes they have
      // locked an attacker out, and has not. These were two autocommit statements until review
      // caught the asymmetry with the sibling path that documents exactly this hazard.
      const keep = request.sessionId ?? undefined;
      await app.db.transaction(async (tx) => {
        await updatePasswordHash(tx, principal.userId, hashPassword(request.body.newPassword));
        // M15 15.6 (D-15.6-6) — every session EXCEPT the caller's own, which is the deliberate
        // asymmetry with the reset-confirm route above. A voluntary password change is performed BY
        // an authenticated user who has just re-proved their current password; logging them out of
        // the very tab they did it in would be a usability tax with no security gain. A reset is the
        // opposite situation and spares nobody.
        await revokeAllSessions(tx, principal.userId, keep);
      });
      return reply.code(204).send();
    },
  );

  // ── M15 15.6 session management (D-M15-12) ────────────────────────────────────────────────
  //
  // All four routes are session-gated at `viewer`, for the reason `POST /v1/auth/password` above
  // records: managing YOUR OWN sessions is not a privileged act on the org, and a read-only
  // account must still be able to sign out a stolen laptop.
  //
  // None of them takes `withOrg`. `sessions` is an identity table with no `org_id` and no policy
  // (D-15.6-3); the `userId` predicate inside every repository call IS the whole scoping.

  /**
   * GET /v1/auth/sessions — the caller's LIVE sessions, newest first, with their own flagged
   * `current: true` so a UI can say "this device".
   *
   * An `ADMIN_TOKEN` caller has no session, so `currentSid` is null and nothing is flagged. The
   * list itself is still whatever `sessions` holds for the bootstrap admin USER — which is empty
   * unless that human has also logged in through `/v1/auth/login`.
   */
  app.get("/v1/auth/sessions", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    const sid = request.sessionId;
    const rows = await listSessions(app.db, principal.userId);
    return reply.code(200).send({
      sessions: rows.map((s) => ({
        id: s.id,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        userAgent: s.userAgent,
        current: s.id === sid,
      })),
    });
  });

  /**
   * DELETE /v1/auth/sessions/:id — sign ONE of the caller's own sessions out.
   *
   * 404 — NOT 403 — when the id belongs to somebody else. `revokeSession` collapses "unknown",
   * "already revoked" and "not yours" into one `false` on purpose: telling a caller that a session
   * id exists but is not theirs turns this route into an enumeration oracle, the same reasoning
   * that makes the reset route always answer 202 (D-15.5-7).
   */
  app.delete<{ Params: { id: string } }>("/v1/auth/sessions/:id", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    // `isUuid` first, so a malformed id is a 400 rather than a Postgres uuid-cast 500 — the
    // repo-wide "unknown id → 404, never a DB-constraint 500" invariant.
    if (!isUuid(request.params.id)) {
      return reply.code(400).send({ error: "invalid session id" });
    }
    const revoked = await revokeSession(app.db, principal.userId, request.params.id);
    if (!revoked) {
      return reply.code(404).send({ error: "no such session" });
    }
    return reply.code(204).send();
  });

  /**
   * POST /v1/auth/logout — end the CURRENT session server-side.
   *
   * This is the route that makes logout mean something (OWASP Session Management: a session
   * identifier must be invalidated ON THE SERVER, not merely dropped by the client). Until 15.6 the
   * dashboard deleted its cookie and the token stayed valid for the rest of its seven days.
   *
   * 204 even for an `ADMIN_TOKEN` caller, which has no session to revoke: logout is idempotent, and
   * the desktop app still presents `ADMIN_TOKEN` until D-M15-7 retires it in 15.9. Erroring there
   * would break a client for successfully being in the state it asked for.
   */
  app.post("/v1/auth/logout", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    const sid = request.sessionId;
    if (sid) await revokeSession(app.db, principal.userId, sid);
    return reply.code(204).send();
  });

  /**
   * POST /v1/auth/sessions/revoke-all — sign out EVERYWHERE, the caller's own session INCLUDED.
   *
   * That inclusion is the deliberate difference from `POST /v1/auth/password`, which spares the
   * current session: "sign out all devices" is a panic button, and a panic button that leaves the
   * device you pressed it on signed in does not do what its label says. The dashboard clears the
   * cookie immediately afterwards.
   *
   * Returns `{revoked: n}` where n is how many were LIVE, so a second call answers 0 rather than
   * erroring — `revokeAllSessions` is idempotent by its `revoked_at IS NULL` predicate.
   */
  app.post("/v1/auth/sessions/revoke-all", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    const revoked = await revokeAllSessions(app.db, principal.userId);
    return reply.code(200).send({ revoked });
  });
}
