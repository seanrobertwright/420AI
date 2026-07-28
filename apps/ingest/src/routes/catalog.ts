import type { FastifyInstance } from "fastify";
import type { ModelPricing } from "@420ai/shared";
import { verifyCatalogSignature } from "@420ai/shared";
import { insertPendingCatalog, listCatalogs, approveCatalog, rejectCatalog } from "@420ai/db";
import { catalogUploadBodySchema } from "../schemas.js";
import { resolvePrincipal, isUuid, authorized } from "../auth.js";

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
 * resolvePrincipal → isUuid(id) else 404 → repo → undefined→404 ladder.
 *
 * POST /v1/catalog            — verify the ed25519 signature (bad → 400) then store pending.
 * GET  /v1/catalog            — list all catalog rows (newest first).
 * POST /v1/catalog/:id/approve — activate a pending catalog, superseding the prior active.
 * POST /v1/catalog/:id/reject  — reject a pending catalog.
 *
 * M15 15.3 — NO `withOrg` here, deliberately. Every route in this file touches only
 * `pricing_catalogs`, which is deployment-GLOBAL (D-M15-9): it has no `org_id` column and
 * therefore no RLS policy (D-15.3-4). Wrapping would set a context nothing reads and cost a
 * transaction per request for nothing. These routes still resolve a principal — that is
 * authentication, not tenancy.
 */
export default async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CatalogUploadBody }>(
    "/v1/catalog",
    { schema: { body: catalogUploadBodySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "admin")) {
        return reply.code(403).send({ error: "insufficient role" });
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
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    return reply.code(200).send(await listCatalogs(app.db));
  });

  app.post<{ Params: { id: string } }>("/v1/catalog/:id/approve", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "admin")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "pending catalog not found" });
    }
    // M15 15.4 (audit B.6): the REAL approver, not the hardcoded literal `"admin"` this used
    // to record. The row is an audit trail; "admin" identified nobody. The gate above is what
    // makes the recorded identity meaningful.
    const row = await approveCatalog(app.db, request.params.id, principal.email, new Date());
    if (!row) return reply.code(404).send({ error: "pending catalog not found" });
    return reply.code(200).send(row);
  });

  app.post<{ Params: { id: string } }>("/v1/catalog/:id/reject", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "admin")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "pending catalog not found" });
    }
    const row = await rejectCatalog(app.db, request.params.id, new Date());
    if (!row) return reply.code(404).send({ error: "pending catalog not found" });
    return reply.code(200).send(row);
  });
}
