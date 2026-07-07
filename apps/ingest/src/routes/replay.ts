import type { FastifyInstance } from "fastify";
import { getActiveCatalog, repriceAll, reparseAll } from "@420ai/db";
import { adminAuthorized } from "../auth.js";

/**
 * M12 12.5a + M13 13.3 archive-replay. Admin-gated.
 *
 * POST /v1/replay/reprice → { repriced, catalogVersion }
 *   Retroactively re-prices every cost-bearing event under the ACTIVE uploaded
 *   catalog (the going-forward ingest path only reprices on re-ingest). No body.
 *   409 when no catalog is active (nothing to apply).
 *
 * POST /v1/replay/reparse → { sessions, eventsUpserted, orphansDeleted, skipped }
 *   The 12.5b re-parse engine: decrypt raw records → re-parse under the CURRENT
 *   shared parsers → upsert-by-fingerprint → orphan-event GC. Optional body
 *   `{ sessionId }` scopes to one session. An active catalog is OPTIONAL here
 *   (present → the upsert re-prices under it) — no 409. Gemini sessions are
 *   skipped and reported (D-M13-2).
 */
export default async function replayRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/replay/reprice", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    const active = await getActiveCatalog(app.db);
    if (!active) {
      return reply.code(409).send({ error: "no active catalog to re-price under" });
    }
    return reply.code(200).send(await repriceAll(app.db, active));
  });

  app.post("/v1/replay/reparse", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    // The body is OPTIONAL (a bare POST re-parses everything, mirroring reprice's
    // no-body contract) — so no JSON-schema `body` (Fastify would 400 an absent
    // body); validate the one optional field by hand instead.
    const body = (request.body ?? {}) as { sessionId?: unknown };
    if (
      body.sessionId !== undefined &&
      (typeof body.sessionId !== "string" || body.sessionId === "")
    ) {
      return reply.code(400).send({ error: "sessionId must be a non-empty string" });
    }
    const repricing = await getActiveCatalog(app.db);
    return reply.code(200).send(await reparseAll(app.db, { sessionId: body.sessionId, repricing }));
  });
}
