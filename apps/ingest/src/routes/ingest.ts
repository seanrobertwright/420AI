import type { FastifyInstance } from "fastify";
import type { IngestBatch } from "@420ai/shared";
import { ingestBatch, getActiveCatalog, indexSessions, getMachineOrgId, withOrg } from "@420ai/db";
import { ingestBodySchema } from "../schemas.js";

/**
 * POST /v1/ingest — bearer-authed, schema-validated, idempotent batch write
 * (PRD §23). The auth preHandler sets request.machineId before this runs.
 *
 * M10 3d (D1): resolve the ACTIVE uploaded catalog (one indexed read) and pass it as
 * `repricing` so cost-bearing events re-price under it going forward. With no active
 * catalog, nothing is passed → byte-identical to today (the bundled baseline applies).
 *
 * M13 13.4: AFTER `ingestBatch` returns (post-transaction — the write transaction
 * stays untouched, the 12.1 rationale), the touched sessions' search docs refresh
 * best-effort: awaited-with-swallow like `deliverFirings` in monitor.ts (a detached
 * promise would race concurrent DDL/tests), so an index failure only logs and NEVER
 * fails the ingest response.
 *
 * M15 15.3: MACHINE-authed, so there is no request principal — the org is resolved from
 * `machines.org_id` BEFORE any transaction opens. That read is possible only because
 * `machines` carries the BOOTSTRAP-PERMISSIVE policy (D-15.3-3): a strict policy there would
 * be circular, since this lookup is what discovers the org in the first place.
 *
 * `ingestBatch` still derives the org internally (D-M15-2) — that seam stays. `withOrg` sets
 * the RLS context and `ingestBatch`'s own transaction nests inside it as a savepoint.
 */
export default async function ingestRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: IngestBatch }>(
    "/v1/ingest",
    { preHandler: app.authenticate, schema: { body: ingestBodySchema } },
    async (request, reply) => {
      const orgId = await getMachineOrgId(app.db, request.machineId);
      if (!orgId) {
        return reply.code(401).send({ error: "machine has no organization" });
      }
      const active = await getActiveCatalog(app.db);
      const result = await withOrg(app.db, orgId, (tx) =>
        ingestBatch(tx, request.machineId, request.body, active),
      );
      const touched = [...new Set(request.body.records.map((r) => r.sessionId))];
      if (touched.length > 0) {
        try {
          await withOrg(app.db, orgId, (tx) => indexSessions(tx, touched, orgId));
        } catch (err) {
          request.log.warn({ err }, "incremental search indexing failed");
        }
      }
      return reply.code(200).send(result);
    },
  );
}
