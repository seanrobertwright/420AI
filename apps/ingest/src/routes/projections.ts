import type { FastifyInstance } from "fastify";
import {
  withOrg,
  usageTotals,
  usageByModel,
  usageOverTime,
  sessionProjections,
  sessionDetail,
  connectorHealth,
  projectGitMetadata,
} from "@420ai/db";
import { usageOverTimeQuerySchema } from "../schemas.js";
import { resolvePrincipal, isUuid, authorized } from "../auth.js";

/**
 * M6 deterministic-projection read endpoints (PRD §16.1, D6). All admin-gated
 * (mirrors routes/projects.ts) — these are dashboard/reporting reads, not the
 * machine-authed write path. Project routes guard `:id` with `isUuid` → 404;
 * `:sessionId` is a connector TEXT id (not a uuid) so it is ungated — an unknown
 * id returns a zeroed projection (200), not 404. Read-only: bad input is a guard
 * 401/404/400, never a new typed error.
 *
 * M15 15.3: every DB call runs inside `withOrg`, which sets the transaction-local
 * `app.current_org` the RLS policies key on. Note BOTH layers are kept — the repo still
 * takes its explicit `orgId` argument. That is D-M15-3 (RLS backstops application scoping,
 * it does not replace it) and it is also what keeps the policy CHEAP: with an explicit
 * `org_id = <literal>` in the query the planner collapses the policy predicate to a
 * one-time filter instead of evaluating it per row. Deleting the explicit predicate
 * "because RLS handles it now" would be a correctness AND a performance regression.
 *
 * Guards stay OUTSIDE the transaction: opening one only to 404 wastes a connection, and a
 * `reply.send()` inside the callback would tie commit/rollback to serialization order.
 */
export default async function projectionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/v1/projects/:id/sessions", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "project not found" });
    }
    const result = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
      sessionProjections(tx, principal.orgId, request.params.id),
    );
    return reply.code(200).send(result);
  });

  app.get<{ Params: { id: string } }>("/v1/projects/:id/usage", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "project not found" });
    }
    const result = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
      usageTotals(tx, principal.orgId, request.params.id),
    );
    return reply.code(200).send(result);
  });

  app.get<{ Params: { id: string } }>("/v1/projects/:id/usage/by-model", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "project not found" });
    }
    const result = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
      usageByModel(tx, principal.orgId, request.params.id),
    );
    return reply.code(200).send(result);
  });

  app.get<{ Params: { id: string }; Querystring: { bucket?: "day" | "week" } }>(
    "/v1/projects/:id/usage/over-time",
    { schema: { querystring: usageOverTimeQuerySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "viewer")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      if (!isUuid(request.params.id)) {
        return reply.code(404).send({ error: "project not found" });
      }
      const bucket = request.query.bucket ?? "day";
      const result = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
        usageOverTime(tx, principal.orgId, request.params.id, bucket),
      );
      return reply.code(200).send(result);
    },
  );

  app.get<{ Params: { id: string } }>("/v1/projects/:id/git", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "project not found" });
    }
    const result = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
      projectGitMetadata(tx, principal.orgId, request.params.id),
    );
    return reply.code(200).send(result);
  });

  app.get<{ Params: { sessionId: string } }>("/v1/sessions/:sessionId", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    // sessionId is a connector text id (NOT a uuid) — unknown → zeroed projection.
    const result = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
      sessionDetail(tx, principal.orgId, request.params.sessionId),
    );
    return reply.code(200).send(result);
  });

  app.get("/v1/connectors/health", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    const result = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
      connectorHealth(tx, principal.orgId),
    );
    return reply.code(200).send(result);
  });
}
