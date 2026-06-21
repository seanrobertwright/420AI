import { randomBytes } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { Db } from "@420ai/db";
import { PairingError } from "@420ai/db";
import { createMetrics, registerMetricsHook } from "./metrics.js";
import authPlugin from "./plugins/auth.js";
import authRoutes from "./routes/auth.js";
import healthRoutes from "./routes/health.js";
import metricsRoutes from "./routes/metrics.js";
import pairingCodeRoutes from "./routes/pairing-codes.js";
import pairRoutes from "./routes/pair.js";
import ingestRoutes from "./routes/ingest.js";
import projectRoutes from "./routes/projects.js";
import workspaceRoutes from "./routes/workspaces.js";
import gitRoutes from "./routes/git.js";
import projectionRoutes from "./routes/projections.js";
import reportRoutes from "./routes/reports.js";
import exportRoutes from "./routes/exports.js";
import interpretationRoutes from "./routes/interpretations.js";
import heartbeatRoutes from "./routes/heartbeat.js";
import monitorRoutes from "./routes/monitor.js";
import alertRoutes from "./routes/alerts.js";
import catalogRoutes from "./routes/catalog.js";
import replayRoutes from "./routes/replay.js";
import searchRoutes from "./routes/search.js";
import { CATALOG_PUBLIC_KEY } from "@420ai/shared";
import { AnalysisProviderError, type AnalysisProvider } from "./analysis/provider.js";
import type { AlertDeliverer } from "./delivery/alert-deliverer.js";

const DEFAULT_ANALYSIS_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_MONITOR_STREAM_INTERVAL_MS = 3000;

const DEFAULT_ADMIN_EMAIL = "seanrobertwright@gmail.com";

export interface BuildAppOptions {
  db: Db;
  adminToken: string;
  /** M12 12.3 single-admin email (defaults to the legacy literal so existing test callers + the
   * legacy-default-seeded users keep resolving the same user; only server.ts passes a real value). */
  adminEmail?: string;
  /** M12 12.3 HMAC session-signing key. Optional with an ephemeral per-process default so the 6
   * existing buildApp test callers don't change; server.ts passes the persistent SESSION_SECRET. */
  sessionSecret?: string;
  /** M10 3d ed25519 public key for catalog verify (defaults to the bundled CATALOG_PUBLIC_KEY; tests inject ephemeral). */
  catalogPublicKey?: string;
  /** M8 injected analysis provider (real client in server.ts; deterministic stub in tests). */
  analysisProvider: AnalysisProvider;
  /** M8 resolved max output tokens for an interpretation call (default 4096). */
  analysisMaxOutputTokens?: number;
  /** M9 SSE push cadence for GET /v1/monitor/stream (default 3000; tests inject 50). */
  monitorStreamIntervalMs?: number;
  logger?: boolean;
  /** M12 12.4b pino level (default "info"); ignored when logger:false. */
  logLevel?: string;
  /** M12 12.4b metrics: false disables the store+hook+route (tests may omit → enabled with
   * an injected now, harmless). */
  metrics?: boolean;
  /** M12 12.4c when present, registers @fastify/rate-limit with these limits. Omitted → no rate
   * limiting (the existing buildApp callers run unthrottled; only server.ts + the dedicated int
   * test opt in). */
  rateLimit?: {
    global?: { max: number; timeWindow: string };
    login?: { max: number; timeWindow: string };
  };
  /** M12 12.6 injected alert deliverer. Omitted → null → delivery disabled (mirrors rateLimit
   * opt-in): every existing buildApp caller is unchanged; only server.ts builds a webhook one. */
  alertDeliverer?: AlertDeliverer | null;
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
  const app = Fastify({
    // M12 12.4b: structured logging at an env-tunable level, with the auth/cookie headers
    // REMOVED from every log line (defense-in-depth — pino's default serializers don't log
    // arbitrary headers, but a bearer/cookie must never leak even if a serializer changes).
    logger:
      opts.logger === false
        ? false
        : {
            level: opts.logLevel ?? "info",
            redact: { paths: ["req.headers.authorization", "req.headers.cookie"], remove: true },
          },
  });

  app.decorate("db", opts.db);
  app.decorate("adminToken", opts.adminToken);
  app.decorate("adminEmail", opts.adminEmail ?? DEFAULT_ADMIN_EMAIL);
  // Ephemeral fallback secret (per-process) so test callers that omit it still sign/verify
  // internally; tokens simply don't survive a restart. server.ts always passes a persistent one.
  app.decorate("sessionSecret", opts.sessionSecret ?? randomBytes(32).toString("base64url"));
  app.decorate("catalogPublicKey", opts.catalogPublicKey ?? CATALOG_PUBLIC_KEY);
  app.decorate("analysisProvider", opts.analysisProvider);
  app.decorate(
    "analysisMaxOutputTokens",
    opts.analysisMaxOutputTokens ?? DEFAULT_ANALYSIS_MAX_OUTPUT_TOKENS,
  );
  app.decorate(
    "monitorStreamIntervalMs",
    opts.monitorStreamIntervalMs ?? DEFAULT_MONITOR_STREAM_INTERVAL_MS,
  );
  // M12 12.6 alert delivery: omitted → null → disabled (no webhook). The monitor route's
  // deliverFirings early-returns when null, so the default no-webhook path adds no query.
  app.decorate("alertDeliverer", opts.alertDeliverer ?? null);

  // M12 12.4b metrics: decorate the store BEFORE registering the hook (the hook reads
  // app.metrics) and the route. Default-on so the 7 existing callers get counters for free;
  // opts.metrics:false opts out.
  if (opts.metrics !== false) {
    app.decorate("metrics", createMetrics(Date.now()));
    registerMetricsHook(app);
    app.register(metricsRoutes);
  }

  // M12 12.4c rate limiting (opt-in via opts.rateLimit). Register the plugin + decorate
  // app.rateLimitLogin BOTH before the route registrations so routes/auth.ts's per-route
  // config.rateLimit resolves. global:false → only opted-in routes (login) are limited; the
  // ingest hot path stays unthrottled unless a global is chosen. When unset, decorate
  // rateLimitLogin=false so the login route's `config.rateLimit` is valid (a falsy per-route
  // config + an unregistered plugin = no limit) — existing tests run unthrottled.
  if (opts.rateLimit) {
    const rl = opts.rateLimit;
    app.register(rateLimit, {
      global: false,
      max: rl.global?.max ?? 1000,
      timeWindow: rl.global?.timeWindow ?? "1 minute",
    });
    app.decorate("rateLimitLogin", rl.login ?? false);
  } else {
    app.decorate("rateLimitLogin", false);
  }

  app.register(authPlugin);
  app.register(authRoutes);
  app.register(healthRoutes);
  app.register(pairingCodeRoutes);
  app.register(pairRoutes);
  app.register(ingestRoutes);
  app.register(projectRoutes);
  app.register(workspaceRoutes);
  app.register(gitRoutes);
  app.register(projectionRoutes);
  app.register(reportRoutes);
  app.register(exportRoutes);
  app.register(interpretationRoutes);
  app.register(heartbeatRoutes);
  app.register(monitorRoutes);
  app.register(alertRoutes);
  app.register(catalogRoutes);
  app.register(replayRoutes);
  app.register(searchRoutes);

  // Map known failures to clean status codes; never leak internals on a 500.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof PairingError) {
      return reply.code(410).send({ error: err.message });
    }
    // Provider failures (non-200/timeout/parse → 502; not-configured → 503). Placed
    // BEFORE the status>=500 masking branch, which would otherwise hide the message.
    if (err instanceof AnalysisProviderError) {
      return reply.code(err.kind === "not_configured" ? 503 : 502).send({ error: err.message });
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
