import type { FastifyInstance } from "fastify";
import {
  clearMfa,
  createInvite,
  findMemberByEmail,
  findMemberByUserId,
  findPendingInviteByEmail,
  findUserIdByEmail,
  listInvites,
  listMembers,
  normalizeEmail,
  recordAuditEvent,
  removeMember,
  revokeAllApiKeys,
  revokeAllSessions,
  revokeInvite,
  setMemberRole,
  withOrg,
} from "@420ai/db";
import { hasRole, type Role } from "@420ai/shared";
import { inviteMemberBodySchema, patchMemberRoleBodySchema } from "../schemas.js";
import { resolvePrincipal, authorized, isUuid } from "../auth.js";

interface InviteBody {
  email: string;
  role: string;
}
interface RoleBody {
  role: string;
}

/**
 * May a caller at `actorRole` act ON a member at `targetRole`? (D-15.5-11, EXTENDED — see below.)
 *
 * This is the SECOND half of the escalation question, and the plan only specified the first. D-15.5-11
 * as written is about GRANTING — "you may never grant or assign a role above your own" — which the
 * `hasRole(principal.role, requestedRole)` checks answer. It says nothing about acting on a member
 * who sits ABOVE you, and the review found the gap that omission left: an `admin` could PATCH an
 * `owner` down to `viewer` (200) and could `DELETE` an owner outright (204), because the requested
 * rung was below the actor's own and the delete path compared no roles at all. The last-owner guard
 * bounded that to "never zero owners" but not to "an admin cannot evict an owner", which is a
 * privilege inversion — the entire purpose of an ordered ladder is that a lower rung cannot reach up.
 *
 * EQUAL RANK IS ALLOWED (`>=`, via `hasRole`): two owners must be able to administer each other, or
 * a co-owner could never be removed and the last-owner guard would be the only thing standing
 * between the org and an unremovable account.
 *
 * Fails CLOSED on a corrupt `targetRole`: `hasRole` looks the minimum up in its RANK table, and an
 * unrecognised key yields `NaN >= undefined` → false → refuse. A hand-edited membership row therefore
 * makes this route deny rather than permit, which is the right direction for an authorization check.
 */
function outranks(actorRole: string, targetRole: string): boolean {
  return hasRole(actorRole, targetRole as Role);
}

/**
 * M15 15.5 — org MEMBER and INVITE management (D-M15-5). Every handler is principal-authed,
 * `authorized()`-gated and `withOrg`-wrapped.
 *
 * WHY `withOrg` HERE AT ALL, given that `memberships`/`users` carry no RLS: two reasons, and this
 * file is deliberately NOT on either allow-list in `org-scoping.test.ts`.
 *   1. The explicit `orgId` predicate inside `repositories/members.ts` is the ONLY tenancy boundary
 *      for the membership reads — there is no backstop behind it. Wrapping costs one transaction
 *      and keeps the last-owner guard's count-then-mutate atomic (D-15.5-12).
 *   2. `invites` DOES carry a policy, and it is bootstrap-permissive: with NO context set it is
 *      fully open. Wrapping is what makes it behave strictly for these authenticated calls; the
 *      permissiveness exists only for the unauthenticated accept path in `routes/auth.ts`.
 *
 * The role passed to `withOrg` is `principal.role`, NOT `SERVICE_ROLE`. A member change IS the
 * caller's own action, so it should be subject to the 0016 role backstop — this is the 15.4 monitor
 * lesson applied in the opposite direction. Ask "whose action is this?", not "who triggered it?".
 */
export default async function memberRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /v1/members — every colleague in the org. `viewer`, because seeing who you work with
  //    is not a privileged act, and the 15.10 team UI needs it for a read-only account too.
  app.get("/v1/members", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    const members = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
      listMembers(tx, principal.orgId),
    );
    return reply.code(200).send({ members });
  });

  // ── POST /v1/members/invite — mint an invite and mail it (or hand the token back).
  app.post<{ Body: InviteBody }>(
    "/v1/members/invite",
    { schema: { body: inviteMemberBodySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "admin")) {
        return reply.code(403).send({ error: "insufficient role" });
      }

      // D-15.5-11 — YOU MAY NEVER GRANT A ROLE ABOVE YOUR OWN. An admin invites up to `admin`,
      // never `owner`. Enforced HERE and not in RLS because the backstop only ever asks "is this a
      // viewer?"; the strict layer is the route. `principal.role` is deliberately NOT cast to
      // `Role` — it comes from a TEXT column with no CHECK, and `hasRole` takes a `string` and
      // fails CLOSED. The REQUESTED role is safe to narrow: the body schema's enum constrained it.
      const requestedRole = request.body.role as "viewer" | "member" | "admin" | "owner";
      if (!hasRole(principal.role, requestedRole)) {
        return reply.code(403).send({ error: "cannot grant a role above your own" });
      }

      const email = normalizeEmail(request.body.email);

      // D-15.5-9 — THE THREE-WAY REJECTION. An invite for an email that already has a user is
      // refused LOUDLY, because the alternative ships a path that reads as working and does not:
      // `findPrincipalByEmail` resolves the FIRST membership by (created_at, id), and every
      // existing user already owns a personal org that predates any invite. A second membership
      // would therefore be permanently shadowed.
      //
      // MULTI-ORG MEMBERSHIP + AN ORG SWITCHER IS M16, NOT 15.10 (D-15.10-1). 15.10 shipped the
      // team surfaces and deliberately did NOT take this on: it reopens `findPrincipalByEmail`,
      // and additionally needs an active-org claim in the session token, per-org session/key
      // revocation, and a rewrite of this very refusal. Nothing in 15.10's UI needed it — every
      // surface there operates within `principal.orgId`.
      //
      // All three checks and the insert share ONE transaction — they were three round trips across
      // two transactions until the 15.5 review — and BE PRECISE ABOUT WHAT THAT BUYS, because the
      // first version of this comment got it wrong in exactly the way CLAUDE.md warns about:
      //
      //   IT BUYS ATOMICITY AND ONE FEWER ROUND TRIP. IT DOES NOT BUY ISOLATION. Under READ
      //   COMMITTED two overlapping invites both run `findPendingInviteByEmail`, neither sees the
      //   other's uncommitted row, and BOTH insert — measured, not theorised. `invites.email` is
      //   deliberately not unique (a revoked invite must not block re-inviting an address), so
      //   nothing at this layer catches it either.
      //
      // That residue is BENIGN, and it is worth naming what makes it benign rather than assuming it:
      // a second pending invite cannot produce a second account or a second membership, because the
      // ACCEPT path checks `findUserIdByEmail` before creating anything and `users.email` is unique
      // behind it. So whichever token is redeemed first wins and the other answers 409 — pinned by
      // "two pending invites for one email yield exactly ONE membership" in identity.int.test.ts,
      // since that test is now the thing standing between this and a duplicate account.
      //
      // Enforcing single-pending-invite properly would need a partial unique index on
      // `(org_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL`. Deliberately NOT added:
      // it would trade a harmless duplicate row for a new failure mode on the onboarding path, to
      // enforce an invariant nothing depends on.
      const result = await withOrg(app.db, principal.orgId, principal.role, async (tx) => {
        if (await findMemberByEmail(tx, principal.orgId, email)) return "already_member" as const;
        // `users` carries no RLS, so this read is unaffected by the org context — it is in here for
        // the ATOMICITY, not for scoping. It deliberately asks about the whole deployment: a user in
        // ANOTHER org is exactly the case D-15.5-9 rejects.
        if (await findUserIdByEmail(tx, email)) return "user_exists" as const;
        // An outstanding invite for the same address is refused rather than duplicated, so a
        // double-click does not leave two live tokens for one colleague.
        if (await findPendingInviteByEmail(tx, principal.orgId, email)) return "pending" as const;
        const created = await createInvite(tx, principal.orgId, {
          email,
          role: requestedRole,
          invitedByUserId: principal.userId,
        });
        // M15 15.10 (D-15.10-3) — audited IN THIS TRANSACTION, so the invite row and the record of
        // who created it commit together or not at all. Placed BEFORE the mailer call on purpose:
        // the event is that an invite was CREATED, which is true regardless of whether SMTP later
        // succeeded — and the mailer's failure path deliberately still returns 200.
        //
        // `target_user_id` is NULL here and that is the case a normalized-only schema could not
        // record at all: an invited address has no `users` row yet (D-M15-8). `target_email` is the
        // load-bearing column.
        await recordAuditEvent(tx, {
          orgId: principal.orgId,
          actorUserId: principal.userId,
          actorEmail: principal.email,
          action: "member.invited",
          targetEmail: email,
          metadata: { role: requestedRole },
        });
        return created;
      });
      if (result === "already_member") {
        return reply.code(409).send({ error: "already a member" });
      }
      if (result === "user_exists") {
        return reply
          .code(409)
          .send({ error: "user already exists — a user may belong to only one organization" });
      }
      if (result === "pending") {
        return reply.code(409).send({ error: "an invite for this address is already pending" });
      }

      // D-15.5-10 — with a mailer, the token leaves ONLY by email. Without one, it comes back in
      // this response for the admin to pass on out-of-band: exactly the precedent
      // `POST /v1/pairing-codes` already sets, and it keeps a solo self-hosted box with no SMTP
      // fully functional (D-M15-10). The UNAUTHENTICATED reset route cannot do this and 503s
      // instead — see routes/auth.ts.
      if (app.mailer) {
        const link = `${app.mailer.appBaseUrl}/invite/${result.token}`;
        try {
          await app.mailer.send({
            to: email,
            subject: "You have been invited to 420AI",
            text: [
              `${principal.email} invited you to join their 420AI organization as ${requestedRole}.`,
              "",
              `Accept the invitation: ${link}`,
              "",
              `This invitation expires ${result.invite.expiresAt.toISOString()}.`,
            ].join("\n"),
          });
          return reply.code(200).send({ invite: result.invite, mailed: true });
        } catch (err) {
          // A SEND FAILURE MUST NOT STRAND THE INVITE. The row is already committed and only its
          // sha256 is stored, so the token is unrecoverable by design — before the 15.5 review this
          // path threw, the admin got a 500 having never seen the token, and every retry answered
          // 409 "already pending". A transient SMTP blip turned the one route whose whole job is
          // onboarding into a dead end that looked like a server bug.
          //
          // So degrade to the no-mailer branch instead: hand the token back with `mailed: false`.
          // That is already sanctioned by D-15.5-10 for this ADMIN-GATED route ("the admin may pass
          // it on out-of-band"), and the reasoning applies just as well to "SMTP is broken" as to
          // "SMTP is absent". The UNAUTHENTICATED reset route must NEVER adopt this — there,
          // returning a token is a complete account-takeover primitive, which is why it 503s.
          request.log.error(err, "invite mail delivery failed — returning the token to the admin");
          return reply
            .code(200)
            .send({ invite: result.invite, mailed: false, mailError: true, token: result.token });
        }
      }
      return reply.code(200).send({ invite: result.invite, mailed: false, token: result.token });
    },
  );

  // ── GET /v1/invites — the pending invitations. `admin`: an outstanding invite names an address
  //    and a rung, which is org-administration detail rather than "who do I work with".
  app.get("/v1/invites", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "admin")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    const invites = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
      listInvites(tx, principal.orgId),
    );
    return reply.code(200).send({ invites });
  });

  // ── DELETE /v1/invites/:id — revoke a pending invitation.
  app.delete<{ Params: { id: string } }>("/v1/invites/:id", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "admin")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    // `isUuid` first, so a malformed id is a 400 rather than a Postgres uuid-cast 500 — the
    // repo-wide "unknown id → 404, never a DB-constraint 500" invariant.
    if (!isUuid(request.params.id)) {
      return reply.code(400).send({ error: "invalid invite id" });
    }
    const revoked = await withOrg(app.db, principal.orgId, principal.role, async (tx) => {
      const ok = await revokeInvite(tx, principal.orgId, request.params.id);
      // Audited on SUCCESS ONLY (D-15.10-3). A 404 is a refusal, and a refusal is not an event —
      // auditing them would make this a request log and bury the ten actions that matter.
      //
      // `targetEmail` is null and stays null: `revokeInvite` returns a boolean, and WIDENING A
      // REPOSITORY SIGNATURE FOR A LOG FIELD IS THE WRONG TRADE. The invite id identifies the row
      // sufficiently for the break-glass reader, who can join it against `invites` if they care.
      if (ok) {
        await recordAuditEvent(tx, {
          orgId: principal.orgId,
          actorUserId: principal.userId,
          actorEmail: principal.email,
          action: "member.invite_revoked",
          targetEmail: null,
          metadata: { inviteId: request.params.id },
        });
      }
      return ok;
    });
    if (!revoked) {
      return reply.code(404).send({ error: "no such pending invite" });
    }
    return reply.code(204).send();
  });

  // ── PATCH /v1/members/:userId — change a colleague's rung.
  app.patch<{ Params: { userId: string }; Body: RoleBody }>(
    "/v1/members/:userId",
    { schema: { body: patchMemberRoleBodySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "admin")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      if (!isUuid(request.params.userId)) {
        return reply.code(400).send({ error: "invalid user id" });
      }
      // M15 15.6 (D-15.6-7) — A ROLE CHANGE DELIBERATELY DOES NOT REVOKE, unlike the DELETE route
      // below. `findPrincipalByEmail` re-resolves `role` from `memberships` on EVERY request, so a
      // demotion is already live on the target's very next call without touching their session.
      // Revoking here would sign a colleague out for a change that had already taken effect. The
      // asymmetry with DELETE is the point, not an oversight — do not "fix" it.
      //
      // Same escalation guard as the invite route (D-15.5-11): an admin cannot promote anyone to
      // `owner`, including themselves.
      const requestedRole = request.body.role as "viewer" | "member" | "admin" | "owner";
      if (!hasRole(principal.role, requestedRole)) {
        return reply.code(403).send({ error: "cannot grant a role above your own" });
      }
      // The last-owner guard (D-15.5-12) lives in the repository and throws `MemberError`, which
      // app.ts maps to 409 (`last_owner`) / 404 (`not_a_member`). The OUTRANK guard is here,
      // because only the route knows who is asking — see `outranks` below.
      const outcome = await withOrg(app.db, principal.orgId, principal.role, async (tx) => {
        const target = await findMemberByUserId(tx, principal.orgId, request.params.userId);
        if (!target) return "not_a_member" as const;
        if (!outranks(principal.role, target.role)) return "outranked" as const;
        const updated = await setMemberRole(
          tx,
          principal.orgId,
          request.params.userId,
          requestedRole,
        );
        // M15 15.10 — `target` is already in scope from the outrank guard's read; reuse it rather
        // than re-querying, and capture `target.role` as the FROM value before the update lands.
        await recordAuditEvent(tx, {
          orgId: principal.orgId,
          actorUserId: principal.userId,
          actorEmail: principal.email,
          action: "member.role_changed",
          targetUserId: request.params.userId,
          targetEmail: target.email,
          metadata: { from: target.role, to: requestedRole },
        });
        return updated;
      });
      if (outcome === "not_a_member") {
        return reply.code(404).send({ error: "no such member in this organization" });
      }
      if (outcome === "outranked") {
        return reply.code(403).send({ error: "cannot modify a member who outranks you" });
      }
      return reply.code(200).send({ member: outcome });
    },
  );

  // ── DELETE /v1/members/:userId — remove a colleague from the org (their identity survives).
  app.delete<{ Params: { userId: string } }>("/v1/members/:userId", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "admin")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    if (!isUuid(request.params.userId)) {
      return reply.code(400).send({ error: "invalid user id" });
    }
    const outcome = await withOrg(app.db, principal.orgId, principal.role, async (tx) => {
      const target = await findMemberByUserId(tx, principal.orgId, request.params.userId);
      if (!target) return "not_a_member" as const;
      // The DELETE path needs the outrank guard MORE than the PATCH path, not less: it had no role
      // comparison of any kind, so an admin could EVICT an owner outright.
      if (!outranks(principal.role, target.role)) return "outranked" as const;
      const removed = await removeMember(tx, principal.orgId, request.params.userId);
      // M15 15.6 (D-15.6-7) — REMOVING A MEMBER SIGNS THEM OUT, in the SAME transaction, so a
      // dropped membership and dead sessions commit together.
      //
      // Before 15.6 this fell closed only BY ACCIDENT: with the membership gone,
      // `findPrincipalByEmail` stopped resolving and the token 401'd — but only because the user
      // had no OTHER membership. That mechanism evaporates the moment M16 ships multi-org users,
      // at which point a removed colleague's existing token would keep working against their
      // remaining org's data. Revoking explicitly is what makes the guarantee designed rather than
      // incidental.
      //
      // `revokeAllSessions` is keyed on `user_id` with NO org predicate. Correct today, and
      // REVISIT AT M16 — the two halves of that are worth keeping apart:
      //
      //   Today a user belongs to exactly one org (15.5's accept path refuses an email that already
      //   has an account), so "removed from the org" and "no longer has a login" are the same
      //   statement, and a global revoke is the only thing that can be meant.
      //   Under M16's multi-org users it INVERTS: an admin of org A calling this would sign the
      //   user out of org B as well, which is a cross-tenant action taken by someone with no
      //   standing in B. At that point this needs either a per-org session model or a revoke scoped
      //   to sessions whose resolved org is this one.
      //
      // M15 15.9 (D-15.9-9) — AND THEIR API KEYS, in the same transaction, for the same reason and
      // more so. The argument above ("remove an employee, sign them out") is STRICTLY STRONGER for
      // a key: a session expires on its own within seven days, whereas a key defaults to never
      // expiring, so leaving one live is a permanent credential held by a former colleague.
      //
      // Both revokes carry the SAME M16 revisit note, and it applies to keys verbatim: today
      // "removed from the org" and "no longer has a login" coincide, so a global revoke is the only
      // thing that can be meant; under multi-org users it inverts, and an admin of org A would be
      // killing a key its owner legitimately uses against org B.
      //
      // Note what this is NOT paired with: a PASSWORD CHANGE deliberately does not revoke keys. A
      // key is not derived from the password, and revoking on a routine rotation would silently
      // break the desktop app and every scheduled script — a worse outcome than the threat it
      // addresses. The two halves of D-15.9-9 are a deliberate asymmetry, not an oversight.
      //
      // `sessions` and `api_keys` carry no policy, so running inside `withOrg` neither helps nor
      // hinders either — the transaction is here for the ATOMICITY.
      if (removed) {
        const sessionsRevoked = await revokeAllSessions(tx, request.params.userId);
        const keysRevoked = await revokeAllApiKeys(tx, request.params.userId);
        // M15 15.10 — the revoke COUNTS are the audit-worthy detail here, not decoration: on an
        // incident timeline "removed a colleague and killed 4 live keys" is a materially different
        // event from "removed a colleague who held none". Both revokes already return the count.
        await recordAuditEvent(tx, {
          orgId: principal.orgId,
          actorUserId: principal.userId,
          actorEmail: principal.email,
          action: "member.removed",
          targetUserId: request.params.userId,
          targetEmail: target.email,
          metadata: { role: target.role, sessionsRevoked, keysRevoked },
        });
      }
      return removed;
    });
    if (outcome === "outranked") {
      return reply.code(403).send({ error: "cannot modify a member who outranks you" });
    }
    if (outcome === "not_a_member" || outcome === false) {
      return reply.code(404).send({ error: "no such member in this organization" });
    }
    return reply.code(204).send();
  });

  /**
   * DELETE /v1/members/:userId/mfa — M15 15.10: ADMIN-INITIATED MFA RESET for a colleague who has
   * lost their authenticator.
   *
   * 15.8 designed this route and REFUSED TO SHIP IT, on the grounds that it needs two things that
   * did not exist yet: 15.5's rank ceiling-and-floor, and an audit record. Both exist now, and both
   * are here. Without them, the remedy for a routine, expected event — someone changed phones — is
   * the operator opening `psql` under D-M15-7 break-glass.
   *
   * THE OUTRANK FLOOR IS THE REASON 15.8 REFUSED, and it is mandatory rather than symmetric-looking:
   * without it an `admin` strips an `owner`'s second factor, and then — if they also hold or can
   * trigger a reset of that owner's password — owns the account outright. `outranks` permits EQUAL
   * rank on purpose (`hasRole` is `>=`), so a co-owner can help a co-owner.
   *
   * REVOKING THE TARGET'S SESSIONS IS NOT OPTIONAL. Clearing MFA alone leaves every session the
   * target had already established alive, so an attacker who had a session keeps it AND has now had
   * the second factor removed — strictly worse than doing nothing.
   *
   * There is deliberately NO self-service equivalent here: that path already exists as
   * `DELETE /v1/auth/mfa` behind 15.8's re-auth gate. Nothing stops `userId === principal.userId`
   * on this route and nothing needs to — `outranks` permits equal rank, and either way it is
   * audited.
   */
  app.delete<{ Params: { userId: string } }>("/v1/members/:userId/mfa", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "admin")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    if (!isUuid(request.params.userId)) {
      return reply.code(400).send({ error: "invalid user id" });
    }
    const outcome = await withOrg(app.db, principal.orgId, principal.role, async (tx) => {
      const target = await findMemberByUserId(tx, principal.orgId, request.params.userId);
      if (!target) return "not_a_member" as const;
      if (!outranks(principal.role, target.role)) return "outranked" as const;
      // `clearMfa` opens its own transaction for the `FOR UPDATE` lock it takes on the target's
      // `users` row; passing `tx` makes that a SAVEPOINT inside this one, so the clear, the
      // revoke and the audit row all commit together. `routes/mfa.ts` calls it the same way.
      await clearMfa(tx, request.params.userId);
      await revokeAllSessions(tx, request.params.userId);
      await recordAuditEvent(tx, {
        orgId: principal.orgId,
        actorUserId: principal.userId,
        actorEmail: principal.email,
        action: "member.mfa_reset",
        targetUserId: request.params.userId,
        targetEmail: target.email,
        metadata: { role: target.role },
      });
      return "reset" as const;
    });
    if (outcome === "not_a_member") {
      return reply.code(404).send({ error: "no such member in this organization" });
    }
    if (outcome === "outranked") {
      return reply.code(403).send({ error: "cannot modify a member who outranks you" });
    }
    return reply.code(204).send();
  });
}
