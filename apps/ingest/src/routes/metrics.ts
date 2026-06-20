import type { FastifyInstance } from "fastify";
import { adminAuthorized } from "../auth.js";

/**
 * GET /v1/metrics — admin-gated server self-observability (M12 12.4b). A readable JSON
 * snapshot (request / status-class / ingest counters + uptime + RSS), NOT Prometheus —
 * a single-user self-hosted box runs no scraper. Counters reset on restart; `uptimeSeconds`
 * lets a reader see the window the counts cover. MIRRORS health.ts + the pairing-codes gate.
 */
export default async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/metrics", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    const m = app.metrics;
    return reply.code(200).send({
      uptimeSeconds: Math.floor((Date.now() - m.startedAt) / 1000),
      requests: m.requests,
      byStatusClass: m.byStatusClass,
      ingest: { recordsInserted: m.ingestRecordsInserted, eventsUpserted: m.ingestEventsUpserted },
      memory: process.memoryUsage().rss,
    });
  });
}
