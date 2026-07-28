import type { FastifyInstance } from "fastify";
import { createPairingCode, findMemberByEmail, findMemberByUserId, withOrg } from "@420ai/db";
import { pairingCodeBodySchema } from "../schemas.js";
import { resolvePrincipal, authorized } from "../auth.js";

interface PairingCodeBody {
  email?: string;
  userId?: string;
}

/**
 * POST /v1/pairing-codes — admin-gated issuance of a short-lived pairing code.
 * Temporary M2 affordance; the dashboard issues codes in a later milestone (§19).
 *
 * M15 15.3 — this route USED to be exempt from `withOrg`, and as of 15.5 it no longer is. The old
 * exemption's reason ("writes a row for a TARGET user whose org is not the caller's") stopped being
 * true when D-M15-8 closed the pre-seeding primitive: the target is now always a member of the
 * caller's own org, so the row is same-org by construction and there is nothing for the
 * bootstrap-permissive policy to let through. Its entry in `ALLOWED_WITHOUT_WITHORG`
 * (`routes/org-scoping.test.ts`) was REMOVED rather than re-worded — a stale reason left in an
 * allow-list is a hole waiting for the next reader.
 *
 * M15 15.5 / D-M15-8 (audit finding C.9) — THE PRIMITIVE IS CLOSED. This route used to upsert a
 * `users` row from a caller-supplied `body.email`: a THIRD users-insert path that bypassed
 * `repositories/users.ts` entirely and let any admin mint an account for `victim@corp.com`. Under
 * 15.7's SSO link-by-email that pre-seeded row becomes an ADOPTED account — the two halves of an
 * account-takeover chain — which is why closing it GATES 15.7. The route now REFERENCES an existing
 * member of the caller's org and 404s otherwise; it can create nothing.
 */
export default async function pairingCodeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: PairingCodeBody }>(
    "/v1/pairing-codes",
    { schema: { body: pairingCodeBodySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "admin")) {
        return reply.code(403).send({ error: "insufficient role" });
      }

      // Resolve the target to a MEMBER of the caller's org, by whichever key the body supplied.
      // BOTH keys are checked against the org, not just `email`: `body.userId` is a raw uuid, so
      // leaving it unverified would keep the primitive alive one parameter to the left.
      const { userId: bodyUserId, email: bodyEmail } = request.body;
      // The lookup and the mint share ONE transaction, so the code cannot be issued against a
      // membership that was revoked between the two statements.
      const issued = await withOrg(app.db, principal.orgId, principal.role, async (tx) => {
        const member = bodyUserId
          ? await findMemberByUserId(tx, principal.orgId, bodyUserId)
          : await findMemberByEmail(tx, principal.orgId, bodyEmail ?? principal.email);
        if (!member) return null;
        // `createPairingCode` still resolves the code's org from the TARGET user rather than from
        // the caller (pairing.ts:35). That resolution is left ALONE deliberately: it is now
        // guaranteed to yield the caller's org — the lookup above proved the target is a member of
        // it — and keeping a row's org derived from whoever it BELONGS to is the rule
        // `organizations.ts`'s header states. Stamping the caller's org here instead would be
        // correct today and wrong the moment 15.10 gives one user two memberships.
        return createPairingCode(tx, member.userId);
      });
      if (!issued) {
        return reply.code(404).send({ error: "no such member in this organization" });
      }
      return reply.code(200).send({ code: issued.code, expiresAt: issued.expiresAt.toISOString() });
    },
  );
}
