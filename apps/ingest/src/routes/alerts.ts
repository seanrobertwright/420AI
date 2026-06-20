import type { FastifyInstance } from "fastify";
import { ackAlertFiring, findUserIdByEmail } from "@420ai/db";
import { adminAuthorized, isUuid } from "../auth.js";

const DEFAULT_EMAIL = "seanrobertwright@gmail.com";

/**
 * M10 3c — admin-gated alert-firing acknowledgement (PRD §20). Mirrors the
 * PATCH /v1/git-links/:id guard ladder verbatim: adminAuthorized → isUuid(id) else 404
 * (a malformed id is never a Postgres uuid-cast 500, the M6–M9 invariant) →
 * findUserIdByEmail → repo call → undefined→404 → send the updated firing. The route
 * owns the wall clock (D6). Ack sets `acked_at` but does NOT resolve the firing.
 */
export default async function alertRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>("/v1/alerts/firings/:id/ack", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!isUuid(request.params.id)) {
      return reply.code(404).send({ error: "alert firing not found" });
    }
    const userId = await findUserIdByEmail(app.db, DEFAULT_EMAIL);
    if (!userId) return reply.code(404).send({ error: "alert firing not found" });
    const firing = await ackAlertFiring(app.db, userId, request.params.id, new Date());
    if (!firing) return reply.code(404).send({ error: "alert firing not found" });
    return reply.code(200).send(firing);
  });
}
