import type { FastifyInstance } from "fastify";
import { getActiveCatalog, repriceAll } from "@420ai/db";
import { adminAuthorized } from "../auth.js";

/**
 * M12 12.5a archive-replay (re-price). Admin-gated. Retroactively re-prices every
 * cost-bearing event under the ACTIVE uploaded catalog (the going-forward ingest path only
 * reprices on re-ingest). No body. 409 when no catalog is active (nothing to apply).
 *
 * The /v1/replay/* namespace is forward-looking (12.5b re-parse would add /v1/replay/reparse).
 *
 * POST /v1/replay/reprice → { repriced, catalogVersion }
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
}
