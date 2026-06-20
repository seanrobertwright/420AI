import type { FastifyInstance } from "fastify";
import type { IngestBatch } from "@420ai/shared";
import { ingestBatch, getActiveCatalog } from "@420ai/db";
import { ingestBodySchema } from "../schemas.js";

/**
 * POST /v1/ingest — bearer-authed, schema-validated, idempotent batch write
 * (PRD §23). The auth preHandler sets request.machineId before this runs.
 *
 * M10 3d (D1): resolve the ACTIVE uploaded catalog (one indexed read) and pass it as
 * `repricing` so cost-bearing events re-price under it going forward. With no active
 * catalog, nothing is passed → byte-identical to today (the bundled baseline applies).
 */
export default async function ingestRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: IngestBatch }>(
    "/v1/ingest",
    { preHandler: app.authenticate, schema: { body: ingestBodySchema } },
    async (request, reply) => {
      const active = await getActiveCatalog(app.db);
      const result = await ingestBatch(app.db, request.machineId, request.body, active);
      return reply.code(200).send(result);
    },
  );
}
