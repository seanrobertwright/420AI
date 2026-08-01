import type { FastifyInstance } from "fastify";
import {
  acceptInvite,
  createUserWithoutPassword,
  ensurePersonalOrg,
  findCredentialById,
  findInviteByToken,
  findUserEmailById,
  findUserIdByEmail,
  findUserIdBySsoIdentity,
  linkSsoIdentity,
  listSsoIdentities,
  normalizeEmail,
  unlinkSsoIdentity,
} from "@420ai/db";
import { ssoCallbackBodySchema, ssoStartBodySchema } from "../schemas.js";
import { isSsoProviderId, type SsoProfile, type SsoProviderId } from "../sso/provider.js";
import { createPkcePair, randomState } from "../sso/pkce.js";
// `mintSessionOrChallenge` and NOT `mintSession` directly, since M15 15.8 (D-15.8-5): it wraps
// `mintSession` and stops one step short for an enrolled user, so this file has no reason to import
// the inner function at all.
import { mintSessionOrChallenge } from "./auth.js";
import { authorized, resolvePrincipal } from "../auth.js";

interface SsoStartBody {
  inviteToken?: string;
}
interface SsoCallbackBody {
  code: string;
  codeVerifier?: string;
  inviteToken?: string;
}

type SsoRefusal = "email_unverified" | "link_required" | "signup_disabled" | "invite_mismatch";

type SsoOutcome =
  | { kind: "login"; userId: string; email: string }
  | { kind: "created"; userId: string; email: string }
  | { kind: "refused"; status: 403 | 409; reason: SsoRefusal };

/**
 * THE REDIRECT URI, DERIVED SERVER-SIDE AND NEVER CALLER-SUPPLIED (D-15.7-6).
 *
 * ONE helper used by BOTH `start` and `callback`, because OAuth requires the two to be identical
 * and two independent constructions would eventually disagree. Accepting it from the request body
 * would let anyone redirect an authorization code to a host they control — a complete
 * account-takeover primitive that no test would notice, because the happy path works fine. Note
 * `ssoCallbackBodySchema` has `additionalProperties: false` and no `redirectUri` property, so a
 * caller cannot even smuggle one in.
 */
function ssoRedirectUri(app: FastifyInstance, provider: SsoProviderId): string {
  return `${app.appBaseUrl}/api/auth/sso/${provider}/callback`;
}

/**
 * THE ANTI-TAKEOVER POLICY (M15 15.7, D-15.7-1/4/7). Every branch is a decision. Returns a
 * discriminated outcome rather than throwing, so the route maps each to a status and NOTHING falls
 * through to a default "log them in".
 *
 * BRANCH ORDER IS LOAD-BEARING. The linked-identity probe comes FIRST and is keyed on
 * (provider, subject) alone, so a person whose provider-side email changed keeps their account;
 * and the pre-existing-user refusal comes BEFORE the signup branch, so a takeover attempt can
 * never be answered by "well, signup is on, I'll just make them".
 *
 * 1. (provider, subject) already linked      → log in; THE EMAIL IS NOT CONSULTED
 * 2. the provider says the email is unverified → 403 email_unverified
 * 3. a valid invite token rides along         → create user + membership in the inviting org, link
 * 4. a `users` row already exists             → 409 link_required — NEVER adopted (D-15.7-4)
 * 5. no user, and SSO signup is enabled       → create user + personal org, link
 * 6. no user, signup disabled                 → 403 signup_disabled
 */
async function resolveSsoLogin(
  app: FastifyInstance,
  provider: SsoProviderId,
  profile: SsoProfile,
  inviteToken?: string,
): Promise<SsoOutcome> {
  // ── 1 ── The identity is already ours. Resolved by the provider's immutable subject alone, so a
  // provider-side email change does not break the login, and the asserted email cannot influence
  // WHICH account is opened. `findUserIdBySsoIdentity` does not even accept an email (D-15.7-1).
  const linkedUserId = await findUserIdBySsoIdentity(app.db, provider, profile.subject);
  if (linkedUserId) {
    // The email comes from OUR row, never from the provider's assertion — see
    // `findUserEmailById`'s doc comment. A user row deleted underneath a live link fails closed.
    const email = await findUserEmailById(app.db, linkedUserId);
    if (!email) return { kind: "refused", status: 409, reason: "link_required" };
    // Refresh the recorded address for display/audit. Best-effort semantics are not needed: this
    // is the same `onConflictDoUpdate` the link path uses, and it cannot move the row's owner.
    await linkSsoIdentity(app.db, linkedUserId, {
      provider,
      subject: profile.subject,
      email: profile.email,
    });
    return { kind: "login", userId: linkedUserId, email };
  }

  // ── 2 ── Everything below CREATES or CLAIMS an account on the strength of an address, so the
  // address must be one the provider itself vouches for. A null email is treated identically: an
  // account we cannot name is one we cannot safely match. (The authenticated LINK route is the
  // exception and deliberately does not run this policy — there the email is cosmetic.)
  if (!profile.email || !profile.emailVerified) {
    return { kind: "refused", status: 403, reason: "email_unverified" };
  }
  const email = normalizeEmail(profile.email);

  // ── 3 ── An invitation rides along: this is how a NEW teammate arrives through SSO at all, since
  // self-provisioning is off by default. Throws `InviteError` → 410 via app.ts for an unknown,
  // revoked, accepted or expired token, exactly as the password accept-invite route does.
  if (inviteToken) {
    const invite = await findInviteByToken(app.db, inviteToken);
    if (normalizeEmail(invite.email) !== email) {
      // The invite names one address and the provider vouches for another. Refusing keeps the
      // invite UNSPENT — nothing has been written at this point — so the right person can still
      // use it. Silently honouring it would let anyone with a leaked invite link join as
      // themselves, which is the invite-flavoured version of the takeover this slice prevents.
      return { kind: "refused", status: 409, reason: "invite_mismatch" };
    }
    // Branch 4's rule applies inside branch 3 as well: an invite is not a licence to adopt an
    // account that already exists. (`createUserWithoutPassword` would raise the unique index here
    // anyway, but as an opaque 500 rather than the answer the dashboard can act on.)
    if (await findUserIdByEmail(app.db, email)) {
      return { kind: "refused", status: 409, reason: "link_required" };
    }
    // ONE transaction, the shape `routes/auth.ts`'s invite-accept uses: create the user, insert
    // EXACTLY ONE membership through `acceptInvite`, and link — with the id RETURNED out of the
    // callback rather than assigned to an outer `let` (see that route's comment for why).
    // `createUserWithoutPassword`, never `ensureUserByEmail`: the latter calls `ensurePersonalOrg`,
    // whose `owner` membership would shadow the invited one forever (D-15.5-9 / GOTCHA-1).
    const newUserId = await app.db.transaction(async (tx) => {
      const id = await createUserWithoutPassword(tx, email);
      await acceptInvite(tx, inviteToken, id);
      await linkSsoIdentity(tx, id, { provider, subject: profile.subject, email });
      return id;
    });
    return { kind: "created", userId: newUserId, email };
  }

  // ── 4 ── THE BRANCH THIS SLICE EXISTS FOR (D-15.7-4). A `users` row for this address already
  // exists, and it is NEVER adopted — not even when the provider has verified the address.
  //
  // The reason is specific to this codebase rather than general caution: NO `users` row has a
  // verified email. 15.5's signup sends no verification mail, and pre-seeded pairing rows were
  // never verified at all, so there is no "verified pre-existing row" class to carve out. Adopting
  // would turn any stale row into a live account for whoever controls that mailbox at a provider.
  //
  // Placed BEFORE the signup branch on purpose: a takeover attempt must never be answered with
  // "well, signup is on, I'll just make them". The escape hatch is the AUTHENTICATED link route.
  if (await findUserIdByEmail(app.db, email)) {
    return { kind: "refused", status: 409, reason: "link_required" };
  }

  // ── 5/6 ── First sight of this address. Creating an account here is SELF-PROVISIONING, gated by
  // its own flag (D-15.7-7) which defaults to false in `buildApp` — otherwise SSO would silently
  // reopen the door D-M15-6 shut, on every deployment that configures a client id.
  if (!app.ssoSignupEnabled) {
    return { kind: "refused", status: 403, reason: "signup_disabled" };
  }
  // `ensurePersonalOrg` HERE and not in branch 3, exactly as `POST /v1/auth/signup` does it: a
  // signup legitimately owns a brand-new org, while an invitee must not be given one first.
  const newUserId = await app.db.transaction(async (tx) => {
    const id = await createUserWithoutPassword(tx, email);
    await ensurePersonalOrg(tx, id, email);
    await linkSsoIdentity(tx, id, { provider, subject: profile.subject, email });
    return id;
  });
  return { kind: "created", userId: newUserId, email };
}

/**
 * M15 15.7 SSO routes (D-M15-5). Six endpoints: three unauthenticated (the login flow) and three
 * session-gated at `viewer` (the link surface — managing your OWN credentials is not a privileged
 * act on the org, the same reasoning `POST /v1/auth/password` records).
 *
 * M15 15.3 — NO `withOrg` anywhere in this file, deliberately, and for the reason `routes/auth.ts`
 * states at length. `sso_identities` is an identity table with no `org_id` and no policy
 * (D-15.7-3), read at the one moment before any org context exists — resolving this row is part of
 * what establishes it. An identity belongs to a USER, so `userId` is the scoping predicate
 * everywhere here; the repository takes no `orgId` at all.
 *
 * The ONE path that writes an org-owned row is invite-acceptance, and it goes through
 * `acceptInvite` exactly as `auth.ts`'s password invite-accept does: `invites` is
 * bootstrap-permissive on the org axis (D-15.3-3 / D-15.5-2) precisely because the invite lookup is
 * what DISCOVERS the org, so wrapping it would read zero rows. `memberships` carries no policy.
 * This file's entry in `org-scoping.test.ts`'s allow-list records the same argument.
 *
 * SSO adds NO new enforcement point. Once the policy admits a login it mints an ordinary 15.6
 * session through the shared `mintSession`, so revocation, expiry and `resolvePrincipal` all apply
 * unchanged (pinned by `sso.int.test.ts`'s revoke-all case).
 *
 * M15 15.8 — the callback now goes through `mintSessionOrChallenge` (D-15.8-5), so it also READS
 * `totp_credentials`. The `org-scoping.test.ts` allow-list entry for this file is a claim about its
 * DB access, and the claim STAYS TRUE — `totp_credentials` and `mfa_recovery_codes` are identity
 * tables with no `org_id` and no policy (D-15.8-13), on exactly the terms `sso_identities` is — but
 * the header says so rather than leaving the entry to quietly under-describe the file, which is the
 * failure mode the removed `pairing-codes.ts` entry documents.
 */
export default async function ssoRoutes(app: FastifyInstance): Promise<void> {
  /** Resolve `:provider` to a CONFIGURED provider, or undefined → the route answers 404. */
  function provider(id: string) {
    if (!isSsoProviderId(id)) return undefined;
    const p = app.ssoProviders[id];
    return p ? ({ id, impl: p } as const) : undefined;
  }

  /**
   * GET /v1/auth/sso/providers — which providers this deployment has CONFIGURED, so the login page
   * renders exactly the buttons that can work. Unauthenticated by necessity (the caller is logged
   * out) and it leaks nothing: which OAuth apps an operator registered is not a secret, and no
   * client id or secret appears in the response.
   */
  app.get("/v1/auth/sso/providers", async (_request, reply) => {
    return reply.code(200).send({ providers: Object.keys(app.ssoProviders) });
  });

  /**
   * POST /v1/auth/sso/:provider/start — begin an authorization request.
   *
   * Returns the `state` and (for a PKCE provider) the `codeVerifier` to the caller, which is the
   * dashboard route handler; it stores both in a short-lived httpOnly cookie and compares `state`
   * on the way back. Ingest deliberately holds NO per-flow server state: an unauthenticated
   * endpoint that allocated a row per click would be a free write amplifier.
   */
  app.post<{ Params: { provider: string }; Body: SsoStartBody }>(
    "/v1/auth/sso/:provider/start",
    {
      schema: { body: ssoStartBodySchema },
      // Un-gated and write-adjacent, exactly as login/signup/reset are (12.4c's guard).
      config: { rateLimit: app.rateLimitLogin },
    },
    async (request, reply) => {
      const p = provider(request.params.provider);
      // 404 for BOTH an unknown id and a configured-but-absent one, before anything else — never
      // a 500 from indexing an empty map.
      if (!p) return reply.code(404).send({ error: "unknown or unconfigured sso provider" });

      const state = randomState();
      const pkce = p.impl.usesPkce ? createPkcePair() : undefined;
      return reply.code(200).send({
        authorizeUrl: p.impl.authorizeUrl({
          state,
          codeChallenge: pkce?.codeChallenge,
          redirectUri: ssoRedirectUri(app, p.id),
        }),
        state,
        codeVerifier: pkce?.codeVerifier,
      });
    },
  );

  /**
   * POST /v1/auth/sso/:provider/callback — exchange the code, run the policy, mint a session.
   *
   * The expensive route (two outbound hops), and un-gated, so it carries the login rate limit for
   * a second reason beyond brute force: an unthrottled one is a free proxy for hammering Google.
   *
   * A refusal returns its `reason` and NOTHING else — no token, and no row written. That totality
   * is asserted directly in `sso.int.test.ts`: a handler that 409s AFTER writing the link or
   * minting a session has still performed the takeover.
   */
  app.post<{ Params: { provider: string }; Body: SsoCallbackBody }>(
    "/v1/auth/sso/:provider/callback",
    { schema: { body: ssoCallbackBodySchema }, config: { rateLimit: app.rateLimitLogin } },
    async (request, reply) => {
      const p = provider(request.params.provider);
      if (!p) return reply.code(404).send({ error: "unknown or unconfigured sso provider" });

      // Throws `SsoProviderError` → 502/503 via app.ts, never a leaked 500.
      const profile = await p.impl.exchange({
        code: request.body.code,
        codeVerifier: request.body.codeVerifier,
        redirectUri: ssoRedirectUri(app, p.id),
      });

      const outcome = await resolveSsoLogin(app, p.id, profile, request.body.inviteToken);
      if (outcome.kind === "refused") {
        return reply
          .code(outcome.status)
          .send({ error: "sso login refused", reason: outcome.reason });
      }
      // M15 15.8 (D-15.8-5) — THE SAME GATE AS PASSWORD LOGIN. An enrolled user's SSO login returns
      // an MFA challenge, not a token. Without this, "enable MFA" would mean "enable MFA unless the
      // attacker uses the Google button", and the linked identity is exactly what an attacker who
      // owns the mailbox controls. `resolveSsoLogin` above is untouched — only what happens AFTER it
      // admits the login changes.
      //
      // The password hash comes from a `findCredentialById` READ, never from `undefined`: an SSO-only
      // user genuinely has `password_hash IS NULL` (`createUserWithoutPassword`), and `null` and
      // `undefined` must not produce different `cv` fingerprints. A row that vanished between the
      // policy decision and here fails closed rather than fingerprinting a guess.
      const cred = await findCredentialById(app.db, outcome.userId);
      if (!cred) {
        return reply
          .code(409)
          .send({ error: "sso login refused", reason: "link_required" satisfies SsoRefusal });
      }
      return reply.code(200).send(
        await mintSessionOrChallenge(app, app.db, request, {
          userId: outcome.userId,
          email: outcome.email,
          passwordHash: cred.passwordHash,
        }),
      );
    },
  );

  /**
   * POST /v1/auth/sso/:provider/link — attach a provider identity to the CALLER's account.
   *
   * This is branch 4's escape hatch, and the reason it is safe is that it inverts the trust
   * direction: the account is proven by an existing session, and the provider identity is what is
   * being added. Nothing is resolved from the asserted email, so an UNVERIFIED address is accepted
   * here — the stored `email` is display metadata, not a key.
   *
   * `inviteToken` is part of the shared schema and is DELIBERATELY IGNORED: the caller is already
   * authenticated and already in an org, so honouring an invite here would silently move or
   * double their membership.
   */
  app.post<{ Params: { provider: string }; Body: SsoCallbackBody }>(
    "/v1/auth/sso/:provider/link",
    {
      schema: { body: ssoCallbackBodySchema },
      // Session-gated, but it makes the SAME two-to-three outbound provider hops the callback
      // throttles for — so an authenticated caller could still use it to hammer Google on the
      // operator's behalf (and burn their provider rate limit / IP reputation).
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
      const p = provider(request.params.provider);
      if (!p) return reply.code(404).send({ error: "unknown or unconfigured sso provider" });

      const profile = await p.impl.exchange({
        code: request.body.code,
        codeVerifier: request.body.codeVerifier,
        redirectUri: ssoRedirectUri(app, p.id),
      });
      // Throws `SsoIdentityError("identity_taken")` → 409 via app.ts when that (provider, subject)
      // belongs to somebody else. No row is moved.
      await linkSsoIdentity(app.db, principal.userId, {
        provider: p.id,
        subject: profile.subject,
        email: profile.email,
      });
      return reply.code(204).send();
    },
  );

  /**
   * GET /v1/auth/sso/identities — the caller's own links, newest first.
   *
   * `subject` is absent from the response by construction (`ssoIdentityRowColumns` omits it), not
   * by a filter here. An `ADMIN_TOKEN` caller resolves to the bootstrap admin USER and gets that
   * user's list — empty unless that human has linked something.
   */
  app.get("/v1/auth/sso/identities", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    const rows = await listSsoIdentities(app.db, principal.userId);
    return reply.code(200).send({
      identities: rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        email: r.email,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  });

  /**
   * DELETE /v1/auth/sso/:provider — detach a provider identity from the caller's account.
   *
   * 404 when nothing was linked; 409 `last_credential` when removing it would leave the account
   * with no way in at all (an SSO-created user has `password_hash` NULL). The guard is LOCKED —
   * see `unlinkSsoIdentity`'s comment; a shared transaction alone would not exclude the race.
   *
   * Note this accepts an UNCONFIGURED provider id, unlike the three routes above: a deployment
   * that turns GitHub off must not strand the links it already issued. Only the id's SHAPE is
   * validated.
   */
  app.delete<{ Params: { provider: string } }>("/v1/auth/sso/:provider", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    if (!isSsoProviderId(request.params.provider)) {
      return reply.code(404).send({ error: "unknown sso provider" });
    }
    const removed = await unlinkSsoIdentity(app.db, principal.userId, request.params.provider);
    if (!removed) return reply.code(404).send({ error: "no such linked identity" });
    return reply.code(204).send();
  });
}
