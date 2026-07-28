import type { FastifyInstance } from "fastify";
import {
  acceptInvite,
  consumePasswordReset,
  createPasswordReset,
  createUserWithPassword,
  ensurePersonalOrg,
  findAdminCredential,
  findInviteByToken,
  findUserIdByEmail,
  getOrgName,
  normalizeEmail,
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
import { resolvePrincipal, authorized } from "../auth.js";

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

/**
 * M12 12.3 admin login surface. POST /v1/auth/login is the ONE un-gated admin route
 * (it's the entry point); it issues a stateless HMAC session token the dashboard then
 * carries as a bearer (the hybrid resolvePrincipal gate accepts it). GET /v1/auth/me is
 * a session-gated identity probe for the dashboard's logged-in state.
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
      const cred = await findAdminCredential(app.db, email);
      // Generic 401 whether the user is missing or the password is wrong (no user-enumeration).
      if (!cred?.passwordHash || !verifyPassword(password, cred.passwordHash)) {
        return reply.code(401).send({ error: "invalid email or password" });
      }
      // M15 15.5 (D-15.5-3): sign the NORMALIZED address, so a session minted from `Foo@corp.com`
      // carries the same `sub` that `findPrincipalByEmail` will look up on every later request.
      const { token, exp } = signSession(cred.email, app.sessionSecret, SESSION_TTL_SECONDS);
      return reply.code(200).send({ token, expiresAt: new Date(exp * 1000).toISOString() });
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
    { schema: { body: acceptInviteBodySchema } },
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
      await app.db.transaction(async (tx) => {
        const userId = await createUserWithPassword(tx, invite.email, passwordHash);
        await acceptInvite(tx, request.body.token, userId);
      });

      const { token, exp } = signSession(invite.email, app.sessionSecret, SESSION_TTL_SECONDS);
      return reply.code(200).send({ token, expiresAt: new Date(exp * 1000).toISOString() });
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
      await app.db.transaction(async (tx) => {
        const userId = await createUserWithPassword(tx, email, passwordHash);
        await ensurePersonalOrg(tx, userId, email);
      });

      const { token, exp } = signSession(email, app.sessionSecret, SESSION_TTL_SECONDS);
      return reply.code(200).send({ token, expiresAt: new Date(exp * 1000).toISOString() });
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
    { schema: { body: passwordResetConfirmBodySchema } },
    async (request, reply) => {
      const passwordHash = hashPassword(request.body.password);
      await app.db.transaction(async (tx) => {
        // Throws PasswordResetError (unknown/consumed/expired) → 410 via app.ts.
        const { userId } = await consumePasswordReset(tx, request.body.token);
        await updatePasswordHash(tx, userId, passwordHash);
      });
      // 15.6 (D-M15-12): sessions become stateful; THIS is where invalidate-on-credential-change
      // lands. Today a session is a stateless HMAC (session.ts) and the ONLY revocation is rotating
      // SESSION_SECRET, so there is no partial revocation to attempt here. Half-revocation would be
      // worse than none: indistinguishable from working revocation, and harder to verify in 15.6.
      return reply.code(204).send();
    },
  );

  /** POST /v1/auth/password — change your OWN password. Session-gated; requires the current one. */
  app.post<{ Body: ChangePasswordBody }>(
    "/v1/auth/password",
    { schema: { body: changePasswordBodySchema } },
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
      await updatePasswordHash(app.db, principal.userId, hashPassword(request.body.newPassword));
      // 15.6 (D-M15-12): sessions become stateful; THIS is where invalidate-on-credential-change
      // lands. See the note on the reset-confirm route above — the caller's other sessions stay
      // valid until then, and that is a deliberate deferral rather than an oversight.
      return reply.code(204).send();
    },
  );
}
