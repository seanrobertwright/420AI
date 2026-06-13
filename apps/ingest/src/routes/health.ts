import type { FastifyInstance } from "fastify";

/** GET /v1/health — unauthenticated liveness check (PRD §20). */
export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/health", async () => ({ status: "ok", time: new Date().toISOString() }));
}
