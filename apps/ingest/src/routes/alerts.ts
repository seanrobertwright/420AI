import type { FastifyInstance } from "fastify";
import { withOrg, ackAlertFiring } from "@420ai/db";
import { resolvePrincipal, isUuid, authorized } from "../auth.js";

/**
 * M10 3c — admin-gated alert-firing acknowledgement (PRD §20). Mirrors the
 * PATCH /v1/git-links/:id guard ladder verbatim: resolvePrincipal → isUuid(id) else 404
 * (a malformed id is never a Postgres uuid-cast 500, the M6–M9 invariant) →
 * findUserIdByEmail → repo call → undefined→404 → send the updated firing. The route
 * owns the wall clock (D6). Ack sets `acked_at` but does NOT resolve the firing.
 */
export default async function alertRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>("/v1/alerts/firings/:id/ack", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "member")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "alert firing not found" });
    }
    // M16 16.7 — `withOrg(..., principal.role, ...)` STAYS, unlike the reconcile and delivery paths
    // which run as SERVICE_ROLE. The 15.4 test is "whose action is this?", and here the answer is
    // genuinely "theirs": an ack is a user-initiated write, so the 0016 restrictive policy should
    // and does reject a viewer's. An org context also SEES the deployment rows (`org_id IS NULL`
    // satisfies the amended policy under any context), so a deployment firing is ackable from any
    // org — one row, one ack, universally visible. `ackAlertFiring` no longer takes a user id:
    // there is no `acked_by_user_id` column to stamp, and `user_id` is the OPENER's (provenance).
    const firing = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
      ackAlertFiring(tx, principal.orgId, request.params.id, new Date()),
    );
    if (!firing) return reply.code(404).send({ error: "alert firing not found" });
    return reply.code(200).send(firing);
  });
}
