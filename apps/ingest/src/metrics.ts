import type { FastifyInstance } from "fastify";

/**
 * M12 12.4b — server self-observability. An in-memory counter store, bumped by an
 * `onResponse` hook, surfaced (admin-gated) at GET /v1/metrics. Distinct from the M9
 * collector→monitor heartbeat: this is the SERVER observing ITSELF (request/error
 * volume), not a client liveness ping.
 *
 * Counters live in process memory and reset on restart — acceptable for a single-user
 * self-hosted box (no Prometheus scraper). `startedAt` lets a reader see the window;
 * the route reports it as `uptimeSeconds`. No timer / long-lived resource is added.
 */
export interface MetricsStore {
  startedAt: number; // epoch ms (process start) — injected for deterministic tests
  requests: number; // total responses observed
  byStatusClass: Record<string, number>; // "2xx"|"3xx"|"4xx"|"5xx" → count
  ingestRecordsInserted: number; // bumped by the ingest route (optional)
  ingestEventsUpserted: number;
}

/** Build a zeroed store. `now` is injected (CLAUDE.md: inject clocks for determinism). */
export function createMetrics(now: number): MetricsStore {
  return {
    startedAt: now,
    requests: 0,
    byStatusClass: {},
    ingestRecordsInserted: 0,
    ingestEventsUpserted: 0,
  };
}

/**
 * Count every response by status class. Registered in buildApp when opts.metrics !==
 * false. Reads `app.metrics` (decorated BEFORE this hook is registered).
 */
export function registerMetricsHook(app: FastifyInstance): void {
  app.addHook("onResponse", (_req, reply, done) => {
    const m = app.metrics;
    m.requests += 1;
    const cls = `${Math.floor(reply.statusCode / 100)}xx`;
    m.byStatusClass[cls] = (m.byStatusClass[cls] ?? 0) + 1;
    done();
  });
}
