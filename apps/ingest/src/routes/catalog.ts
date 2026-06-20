import type { FastifyInstance } from "fastify";
import type { ModelPricing } from "@420ai/shared";
import { verifyCatalogSignature } from "@420ai/shared";
import {
  insertPendingCatalog,
  listCatalogs,
  approveCatalog,
  rejectCatalog,
} from "@420ai/db";
import { catalogUploadBodySchema } from "../schemas.js";
import { adminAuthorized, isUuid } from "../auth.js";

interface CatalogUploadBody {
  version: string;
  payload: Record<string, ModelPricing>;
  signature: string;
}

/**
 * M10 3d signed pricing-catalog endpoints (PRD §10.4/§18/§20). All admin-gated
 * (the dashboard reaches them via the server-side proxy that holds the admin token,
 * D9). The catalog is GLOBAL (D6) — the approve/reject routes drop the
 * findUserIdByEmail step the per-user alerts route has, keeping the same
 * adminAuthorized → isUuid(id) else 404 → repo → undefined→404 ladder.
 *
 * POST /v1/catalog            — verify the ed25519 signature (bad → 400) then store pending.
 * GET  /v1/catalog            — list all catalog rows (newest first).
 * POST /v1/catalog/:id/approve — activate a pending catalog, superseding the prior active.
 * POST /v1/catalog/:id/reject  — reject a pending catalog.
 */
export default async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CatalogUploadBody }>(
    "/v1/catalog",
    { schema: { body: catalogUploadBodySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      const { version, payload, signature } = request.body;
      // Verify against the INJECTED public key (D4) — production uses the bundled
      // constant; tests swap an ephemeral key. A bad signature is a clean 400.
      if (!verifyCatalogSignature({ version, payload }, signature, app.catalogPublicKey)) {
        return reply.code(400).send({ error: "signature verification failed" });
      }
      const row = await insertPendingCatalog(app.db, { version, payload, signature });
      return reply.code(200).send(row);
    },
  );

  app.get("/v1/catalog", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    return reply.code(200).send(await listCatalogs(app.db));
  });

  app.post<{ Params: { id: string } }>("/v1/catalog/:id/approve", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "pending catalog not found" });
    }
    const row = await approveCatalog(app.db, request.params.id, "admin", new Date());
    if (!row) return reply.code(404).send({ error: "pending catalog not found" });
    return reply.code(200).send(row);
  });

  app.post<{ Params: { id: string } }>("/v1/catalog/:id/reject", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "pending catalog not found" });
    }
    const row = await rejectCatalog(app.db, request.params.id, new Date());
    if (!row) return reply.code(404).send({ error: "pending catalog not found" });
    return reply.code(200).send(row);
  });
}
