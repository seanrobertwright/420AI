import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Db } from "@420ai/db";
import { PairingError } from "@420ai/db";
import authPlugin from "./plugins/auth.js";
import healthRoutes from "./routes/health.js";
import pairingCodeRoutes from "./routes/pairing-codes.js";
import pairRoutes from "./routes/pair.js";
import ingestRoutes from "./routes/ingest.js";
import projectRoutes from "./routes/projects.js";
import workspaceRoutes from "./routes/workspaces.js";
import projectionRoutes from "./routes/projections.js";
import reportRoutes from "./routes/reports.js";
import interpretationRoutes from "./routes/interpretations.js";
import heartbeatRoutes from "./routes/heartbeat.js";
import monitorRoutes from "./routes/monitor.js";
import { AnalysisProviderError, type AnalysisProvider } from "./analysis/provider.js";

const DEFAULT_ANALYSIS_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_MONITOR_STREAM_INTERVAL_MS = 3000;

export interface BuildAppOptions {
  db: Db;
  adminToken: string;
  /** M8 injected analysis provider (real client in server.ts; deterministic stub in tests). */
  analysisProvider: AnalysisProvider;
  /** M8 resolved max output tokens for an interpretation call (default 4096). */
  analysisMaxOutputTokens?: number;
  /** M9 SSE push cadence for GET /v1/monitor/stream (default 3000; tests inject 50). */
  monitorStreamIntervalMs?: number;
  logger?: boolean;
}

/**
 * Build the ingest Fastify instance with its dependencies injected (so tests
 * pass a test-DB-backed Db). Does NOT call listen — callers use app.inject()
 * (tests) or app.listen() (server.ts / collector push integration test).
 *
 * The auth plugin is registered before routes so app.authenticate exists when
 * the ingest route wires it as a preHandler.
 */
export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? true });

  app.decorate("db", opts.db);
  app.decorate("adminToken", opts.adminToken);
  app.decorate("analysisProvider", opts.analysisProvider);
  app.decorate(
    "analysisMaxOutputTokens",
    opts.analysisMaxOutputTokens ?? DEFAULT_ANALYSIS_MAX_OUTPUT_TOKENS,
  );
  app.decorate(
    "monitorStreamIntervalMs",
    opts.monitorStreamIntervalMs ?? DEFAULT_MONITOR_STREAM_INTERVAL_MS,
  );

  app.register(authPlugin);
  app.register(healthRoutes);
  app.register(pairingCodeRoutes);
  app.register(pairRoutes);
  app.register(ingestRoutes);
  app.register(projectRoutes);
  app.register(workspaceRoutes);
  app.register(projectionRoutes);
  app.register(reportRoutes);
  app.register(interpretationRoutes);
  app.register(heartbeatRoutes);
  app.register(monitorRoutes);

  // Map known failures to clean status codes; never leak internals on a 500.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof PairingError) {
      return reply.code(410).send({ error: err.message });
    }
    // Provider failures (non-200/timeout/parse → 502; not-configured → 503). Placed
    // BEFORE the status>=500 masking branch, which would otherwise hide the message.
    if (err instanceof AnalysisProviderError) {
      return reply
        .code(err.kind === "not_configured" ? 503 : 502)
        .send({ error: err.message });
    }
    if (err.validation) {
      return reply.code(400).send({ error: err.message });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      request.log.error(err);
      return reply.code(status).send({ error: "internal server error" });
    }
    return reply.code(status).send({ error: err.message });
  });

  return app;
}
