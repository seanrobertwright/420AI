import type { FastifyInstance } from "fastify";
import type { ConnectorCatalogPayload } from "@420ai/shared";
import { verifyCatalogSignature } from "@420ai/shared";
import {
  insertPendingConnectorCatalog,
  listConnectorCatalogs,
  approveConnectorCatalog,
  rejectConnectorCatalog,
  getActiveConnectorCatalog,
} from "@420ai/db";
import { connectorCatalogUploadBodySchema } from "../schemas.js";
import { adminAuthorized, isUuid } from "../auth.js";

interface ConnectorCatalogUploadBody {
  version: string;
  payload: ConnectorCatalogPayload;
  signature: string;
}

/**
 * M12 12.7c signed connector-catalog endpoints (PRD §10.4) — the structural twin of
 * `routes/catalog.ts` (pricing), reusing the SAME generic `verifyCatalogSignature`. The
 * four admin endpoints are admin-gated (the dashboard reaches them via the server-side
 * proxy that holds the admin token); the FIFTH — `GET /v1/connector-catalog/active` — is
 * MACHINE-authed (the collector pulls it with its ingest token, mirroring /v1/heartbeat),
 * because the collector, not a human, consumes the active catalog.
 *
 * POST /v1/connector-catalog             — verify the ed25519 signature (bad → 400) then store pending.
 * GET  /v1/connector-catalog             — list all catalog rows (newest first; admin).
 * POST /v1/connector-catalog/:id/approve — activate a pending catalog, superseding the prior active.
 * POST /v1/connector-catalog/:id/reject  — reject a pending catalog.
 * GET  /v1/connector-catalog/active      — MACHINE-authed: the active catalog ({version,payload}) or 204.
 */
export default async function connectorCatalogRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: ConnectorCatalogUploadBody }>(
    "/v1/connector-catalog",
    { schema: { body: connectorCatalogUploadBodySchema } },
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      const { version, payload, signature } = request.body;
      // Verify against the INJECTED public key — production uses the bundled constant;
      // tests swap an ephemeral key. A bad signature is a clean 400 (never a 500).
      if (!verifyCatalogSignature({ version, payload }, signature, app.connectorCatalogPublicKey)) {
        return reply.code(400).send({ error: "signature verification failed" });
      }
      const row = await insertPendingConnectorCatalog(app.db, { version, payload, signature });
      return reply.code(200).send(row);
    },
  );

  app.get("/v1/connector-catalog", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    return reply.code(200).send(await listConnectorCatalogs(app.db));
  });

  app.post<{ Params: { id: string } }>(
    "/v1/connector-catalog/:id/approve",
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!isUuid(request.params.id)) {
        return reply.code(404).send({ error: "pending connector catalog not found" });
      }
      const row = await approveConnectorCatalog(app.db, request.params.id, "admin", new Date());
      if (!row) return reply.code(404).send({ error: "pending connector catalog not found" });
      return reply.code(200).send(row);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/connector-catalog/:id/reject",
    async (request, reply) => {
      if (!adminAuthorized(app, request)) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!isUuid(request.params.id)) {
        return reply.code(404).send({ error: "pending connector catalog not found" });
      }
      const row = await rejectConnectorCatalog(app.db, request.params.id, new Date());
      if (!row) return reply.code(404).send({ error: "pending connector catalog not found" });
      return reply.code(200).send(row);
    },
  );

  // MACHINE-authed (NOT admin): the collector pulls the active catalog with its ingest
  // token. The `app.authenticate` preHandler resolves the bearer → machineId (and 401s
  // an invalid token), mirroring /v1/heartbeat. 204 when no catalog is active → the
  // collector falls back to the bundled CONNECTOR_CATALOG_BASELINE (default-on).
  app.get(
    "/v1/connector-catalog/active",
    { preHandler: app.authenticate },
    async (_request, reply) => {
      const active = await getActiveConnectorCatalog(app.db);
      if (!active) return reply.code(204).send();
      return reply.code(200).send(active);
    },
  );
}
