import type { FastifyInstance } from "fastify";
import type { IngestBatch } from "@420ai/shared";
import { ingestBatch, getActiveCatalog, indexSessions } from "@420ai/db";
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
 */
export default async function ingestRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: IngestBatch }>(
    "/v1/ingest",
    { preHandler: app.authenticate, schema: { body: ingestBodySchema } },
    async (request, reply) => {
      const active = await getActiveCatalog(app.db);
      const result = await ingestBatch(app.db, request.machineId, request.body, active);
      const touched = [...new Set(request.body.records.map((r) => r.sessionId))];
      if (touched.length > 0) {
        try {
          await indexSessions(app.db, touched);
        } catch (err) {
          request.log.warn({ err }, "incremental search indexing failed");
        }
      }
      return reply.code(200).send(result);
    },
  );
}
