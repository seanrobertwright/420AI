import type { FastifyInstance } from "fastify";
import type { IngestBatch } from "@420ai/shared";
import { ingestBatch } from "@420ai/db";
import { ingestBodySchema } from "../schemas.js";

/**
 * POST /v1/ingest — bearer-authed, schema-validated, idempotent batch write
 * (PRD §23). The auth preHandler sets request.machineId before this runs.
 */
export default async function ingestRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: IngestBatch }>(
    "/v1/ingest",
    { preHandler: app.authenticate, schema: { body: ingestBodySchema } },
    async (request, reply) => {
      const result = await ingestBatch(app.db, request.machineId, request.body);
      return reply.code(200).send(result);
    },
  );
}
