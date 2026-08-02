import type { FastifyInstance } from "fastify";
import {
  getOrg,
  getOrgForUpdate,
  listMembers,
  recordAuditEvent,
  renameOrg,
  withOrg,
} from "@420ai/db";
import { patchOrgBodySchema } from "../schemas.js";
import { authorized, resolvePrincipal } from "../auth.js";

interface PatchOrgBody {
  name: string;
}

/**
 * M15 15.10 — ORG SETTINGS. Two handlers: read the org, and rename it.
 *
 * M15 15.3 — BOTH ARE `withOrg`-WRAPPED with `principal.role`, and this file is deliberately NOT on
 * either allow-list in `org-scoping.test.ts`. The argument is `routes/members.ts`'s verbatim:
 * `organizations` and `memberships` carry NO RLS (D-15.3-4 — they are the identity tables org
 * resolution itself reads), so the explicit `orgId` predicate inside each repository call is the ONLY
 * tenancy boundary here, with no backstop behind it. Wrapping costs one transaction and buys the
 * read-then-write atomicity the rename needs — `renameOrg` and its audit row must commit together.
 *
 * The role passed is `principal.role`, NOT `SERVICE_ROLE`: a rename IS the caller's own action, so
 * it should be subject to the 0016 role backstop. That is the 15.4 monitor lesson applied in the
 * opposite direction — ask "whose action is this?", not "who triggered it?".
 *
 * THE RENAME IS `owner`, NOT `admin`, and the asymmetry with every other mutation in the milestone
 * is the point: renaming the org is the most org-level act available and there is no undo surface.
 * `admin` is the rung that manages PEOPLE. There is no path here that names a target org — `orgId`
 * comes from `principal.orgId` only, so a cross-org rename is not refused, it is INEXPRESSIBLE.
 */
export default async function orgRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /v1/org — the org behind the Settings card. `viewer`, matching `GET /v1/members`: knowing
   * which organization you are in is not a privileged act.
   *
   * `memberCount` counts MEMBERSHIPS, never invites — a pending invite is not a colleague yet. It is
   * what the dashboard branches on to satisfy D-M15-10 ("a single user never sees an org"): the
   * `<OrgCard/>` renders nothing until a second member exists. Deliberately NOT `isPersonal`, which
   * records provenance rather than current shape (see `renameOrg`).
   */
  app.get("/v1/org", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    const result = await withOrg(app.db, principal.orgId, principal.role, async (tx) => {
      const org = await getOrg(tx, principal.orgId);
      if (!org) return undefined;
      const members = await listMembers(tx, principal.orgId);
      return { org, memberCount: members.length };
    });
    // A resolved principal always has a membership, so a missing org row means the deployment is
    // inconsistent rather than the request being wrong — 404 rather than a null-dereference 500.
    if (!result) {
      return reply.code(404).send({ error: "no such organization" });
    }
    return reply.code(200).send({
      id: result.org.id,
      name: result.org.name,
      isPersonal: result.org.isPersonal,
      memberCount: result.memberCount,
      yourRole: principal.role,
    });
  });

  /**
   * PATCH /v1/org — rename the organization. `owner` only.
   *
   * Audited as `org.renamed` with `{from, to}` IN THE SAME TRANSACTION (D-15.10-3): a rename that
   * committed without its audit row would leave a display name nobody can account for, which is
   * exactly the state the audit table exists to prevent.
   */
  app.patch<{ Body: PatchOrgBody }>(
    "/v1/org",
    { schema: { body: patchOrgBodySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "owner")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      const name = request.body.name.trim();
      // Re-checked after trimming: ajv bounded the RAW string, so "   " passes `minLength: 1` and
      // would land as an empty name. Same class as the schema's own reason for bounding it.
      if (name.length === 0) {
        return reply.code(400).send({ error: "organization name cannot be blank" });
      }
      const updated = await withOrg(app.db, principal.orgId, principal.role, async (tx) => {
        // Read the OLD name under a `FOR UPDATE` LOCK — and the lock is the mechanism, not the
        // transaction. CLAUDE.md's 15.5 lesson is exactly this: a shared transaction buys ATOMICITY,
        // NOT ISOLATION, and the earlier version of this comment claimed the transaction alone made
        // `{from}` accurate, which is the same false assertion 15.5 recorded as the real defect.
        //
        // Without the lock, two concurrent renames both read the same `before.name`; the second
        // UPDATE blocks on the row lock, then commits over the first, and its audit row claims to
        // have replaced a value it never saw — a permanently wrong entry in the one table the
        // application cannot correct. With it, the loser re-reads after the winner commits.
        const before = await getOrgForUpdate(tx, principal.orgId);
        if (!before) return undefined;
        const after = await renameOrg(tx, principal.orgId, name);
        if (!after) return undefined;
        await recordAuditEvent(tx, {
          orgId: principal.orgId,
          actorUserId: principal.userId,
          actorEmail: principal.email,
          action: "org.renamed",
          // No target PERSON: the object of this action is the org itself. Both target columns stay
          // null rather than being filled with the actor, which would read as "acted on themselves".
          metadata: { from: before.name, to: after.name },
        });
        return after;
      });
      if (!updated) {
        return reply.code(404).send({ error: "no such organization" });
      }
      return reply.code(200).send({ org: updated });
    },
  );
}
