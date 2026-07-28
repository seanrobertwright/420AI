import type { FastifyInstance } from "fastify";
import {
  createInvite,
  findMemberByEmail,
  findPendingInviteByEmail,
  findUserIdByEmail,
  listInvites,
  listMembers,
  normalizeEmail,
  removeMember,
  revokeInvite,
  setMemberRole,
  withOrg,
} from "@420ai/db";
import { hasRole } from "@420ai/shared";
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
      // would therefore be permanently shadowed. Multi-org membership + an org switcher is 15.10.
      const existingMember = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
        findMemberByEmail(tx, principal.orgId, email),
      );
      if (existingMember) {
        return reply.code(409).send({ error: "already a member" });
      }
      const existingUserId = await findUserIdByEmail(app.db, email);
      if (existingUserId) {
        return reply
          .code(409)
          .send({ error: "user already exists — multi-org membership lands in 15.10" });
      }

      const result = await withOrg(app.db, principal.orgId, principal.role, async (tx) => {
        // An outstanding invite for the same address is reused rather than duplicated, so a
        // double-click does not leave two live tokens for one colleague.
        const pending = await findPendingInviteByEmail(tx, principal.orgId, email);
        if (pending) return null;
        return createInvite(tx, principal.orgId, {
          email,
          role: requestedRole,
          invitedByUserId: principal.userId,
        });
      });
      if (!result) {
        return reply.code(409).send({ error: "an invite for this address is already pending" });
      }

      // D-15.5-10 — with a mailer, the token leaves ONLY by email. Without one, it comes back in
      // this response for the admin to pass on out-of-band: exactly the precedent
      // `POST /v1/pairing-codes` already sets, and it keeps a solo self-hosted box with no SMTP
      // fully functional (D-M15-10). The UNAUTHENTICATED reset route cannot do this and 503s
      // instead — see routes/auth.ts.
      if (app.mailer) {
        const link = `${app.mailer.appBaseUrl}/invite/${result.token}`;
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
    const revoked = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
      revokeInvite(tx, principal.orgId, request.params.id),
    );
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
      // Same escalation guard as the invite route (D-15.5-11): an admin cannot promote anyone to
      // `owner`, including themselves.
      const requestedRole = request.body.role as "viewer" | "member" | "admin" | "owner";
      if (!hasRole(principal.role, requestedRole)) {
        return reply.code(403).send({ error: "cannot grant a role above your own" });
      }
      // The last-owner guard (D-15.5-12) lives in the repository and throws `MemberError`, which
      // app.ts maps to 409 (`last_owner`) / 404 (`not_a_member`).
      const member = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
        setMemberRole(tx, principal.orgId, request.params.userId, requestedRole),
      );
      return reply.code(200).send({ member });
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
    const removed = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
      removeMember(tx, principal.orgId, request.params.userId),
    );
    if (!removed) {
      return reply.code(404).send({ error: "no such member in this organization" });
    }
    return reply.code(204).send();
  });
}
