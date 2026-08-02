import { randomBytes } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { Db } from "@420ai/db";
import {
  PairingError,
  InviteError,
  MemberError,
  PasswordResetError,
  SsoIdentityError,
  MfaError,
} from "@420ai/db";
import { createMetrics, registerMetricsHook } from "./metrics.js";
import authPlugin from "./plugins/auth.js";
import authRoutes from "./routes/auth.js";
import ssoRoutes from "./routes/sso.js";
import mfaRoutes from "./routes/mfa.js";
import healthRoutes from "./routes/health.js";
import metricsRoutes from "./routes/metrics.js";
import pairingCodeRoutes from "./routes/pairing-codes.js";
import memberRoutes from "./routes/members.js";
import orgRoutes from "./routes/org.js";
import apiKeyRoutes from "./routes/api-keys.js";
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
import connectorCatalogRoutes from "./routes/connector-catalog.js";
import replayRoutes from "./routes/replay.js";
import searchRoutes from "./routes/search.js";
import { CATALOG_PUBLIC_KEY, CONNECTOR_CATALOG_PUBLIC_KEY } from "@420ai/shared";
import { AnalysisProviderError, type AnalysisProvider } from "./analysis/provider.js";
import { SsoProviderError, type SsoProviders } from "./sso/provider.js";
import type { AlertDeliverer } from "./delivery/alert-deliverer.js";
import type { Mailer } from "./delivery/mailer.js";

const DEFAULT_ANALYSIS_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_MONITOR_STREAM_INTERVAL_MS = 3000;
/**
 * M15 15.4 (audit B.4) — the alert reconcile is a WRITE, and 15.3 made every SSE tick a
 * transaction, so it ran once per DEFAULT_MONITOR_STREAM_INTERVAL_MS per connected client per
 * org. 30 s is an order of magnitude off that hot path while staying far below the human
 * threshold for noticing a stale alert. Injectable; `0` reproduces pre-15.4 behaviour exactly.
 */
const DEFAULT_RECONCILE_THROTTLE_MS = 30_000;
/** M15 15.9 (D-15.9-7) — one `last_used_at` write per key per minute at most. The column answers
 * "is this key still in use?" to the minute, which is the granularity a revocation decision needs;
 * the throttle is what stops a polling client writing on every tick. */
const DEFAULT_API_KEY_TOUCH_THROTTLE_MS = 60_000;

const DEFAULT_ADMIN_EMAIL = "seanrobertwright@gmail.com";

export interface BuildAppOptions {
  db: Db;
  /** M12 12.3 single-admin email (defaults to the legacy literal so existing test callers + the
   * legacy-default-seeded users keep resolving the same user; only server.ts passes a real value). */
  adminEmail?: string;
  /** M12 12.3 HMAC session-signing key. Optional with an ephemeral per-process default so the 6
   * existing buildApp test callers don't change; server.ts passes the persistent SESSION_SECRET. */
  sessionSecret?: string;
  /** M10 3d ed25519 public key for catalog verify (defaults to the bundled CATALOG_PUBLIC_KEY; tests inject ephemeral). */
  catalogPublicKey?: string;
  /** M12 12.7c ed25519 public key for connector-catalog verify (defaults to bundled CONNECTOR_CATALOG_PUBLIC_KEY; tests inject ephemeral). */
  connectorCatalogPublicKey?: string;
  /** M8 injected analysis provider (real client in server.ts; deterministic stub in tests). */
  analysisProvider: AnalysisProvider;
  /** M8 resolved max output tokens for an interpretation call (default 4096). */
  analysisMaxOutputTokens?: number;
  /** M9 SSE push cadence for GET /v1/monitor/stream (default 3000; tests inject 50). */
  monitorStreamIntervalMs?: number;
  /** M15 15.4 minimum gap between alert reconcile writes per (org,user) (default 30 000).
   * Tests that assert a firing appears on the first GET inject `0` — every tick reconciles,
   * which is exactly today's behaviour. */
  reconcileThrottleMs?: number;
  /** M15 15.9 minimum gap between `api_keys.last_used_at` writes per key (default 60 000).
   * Tests that assert the touch happened at all inject `0` — there is no other way to observe a
   * throttled fire-and-forget write. */
  apiKeyTouchThrottleMs?: number;
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
  /** M15 15.5 injected transactional mailer (invites, password resets). Omitted → null → the
   * invite route returns the token in its response (D-15.5-10) and the reset route 503s. Same
   * opt-in shape as `alertDeliverer`, so no existing caller changes and no test opens SMTP. */
  mailer?: Mailer | null;
  /** M15 15.5 (D-M15-6) self-signup. Omitted → FALSE, and that default is the single most
   * consequential one in the slice: `true` would turn every existing test caller — and every
   * deployment that upgrades without touching `.env` — into an open-signup box. */
  selfSignupEnabled?: boolean;
  /** M15 15.7 injected SSO providers (real `fetch` clients in server.ts; a deterministic stub in
   * every test). Omitted → `{}` → no provider is configured, `GET /v1/auth/sso/providers` returns
   * an empty list and every `:provider` route 404s. Same opt-in shape as `alertDeliverer`/`mailer`,
   * so no existing caller changes and no test opens a socket to Google. */
  ssoProviders?: SsoProviders;
  /** M15 15.7 (D-15.7-7) whether an SSO callback may CREATE an account. Omitted → FALSE, and the
   * default matters for exactly the reason `selfSignupEnabled`'s does: `true` would make every
   * deployment that configures a client id an open-signup box, silently reopening the door
   * D-M15-6 shut. Deliberately a SEPARATE flag from `selfSignupEnabled` — an operator may want
   * "anyone with a company Google account may self-provision, password signup stays shut". */
  ssoSignupEnabled?: boolean;
  /** M15 15.7 the dashboard's public origin, used to DERIVE the OAuth `redirect_uri` server-side
   * (D-15.7-6 — it is never read from a request body). Omitted → next dev's default origin, the
   * same fallback `mailer.appBaseUrl` uses. */
  appBaseUrl?: string;
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
    // C.6: Fastify's default body limit is 1 MiB. A `collector git` sweep over a large history (or a
    // full ingest batch) easily exceeds that, and the server reset the connection mid-body
    // (ECONNRESET, server up). Raise the ceiling to 16 MiB — comfortably above the collector's 4 MiB
    // git-chunk size and typical ingest batches, while still bounding a hostile body.
    bodyLimit: 16 * 1024 * 1024,
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
  app.decorate("adminEmail", opts.adminEmail ?? DEFAULT_ADMIN_EMAIL);
  // Ephemeral fallback secret (per-process) so test callers that omit it still sign/verify
  // internally; tokens simply don't survive a restart. server.ts always passes a persistent one.
  app.decorate("sessionSecret", opts.sessionSecret ?? randomBytes(32).toString("base64url"));
  app.decorate("catalogPublicKey", opts.catalogPublicKey ?? CATALOG_PUBLIC_KEY);
  app.decorate(
    "connectorCatalogPublicKey",
    opts.connectorCatalogPublicKey ?? CONNECTOR_CATALOG_PUBLIC_KEY,
  );
  app.decorate("analysisProvider", opts.analysisProvider);
  app.decorate(
    "analysisMaxOutputTokens",
    opts.analysisMaxOutputTokens ?? DEFAULT_ANALYSIS_MAX_OUTPUT_TOKENS,
  );
  app.decorate(
    "monitorStreamIntervalMs",
    opts.monitorStreamIntervalMs ?? DEFAULT_MONITOR_STREAM_INTERVAL_MS,
  );
  app.decorate("reconcileThrottleMs", opts.reconcileThrottleMs ?? DEFAULT_RECONCILE_THROTTLE_MS);
  // Per-PROCESS, in-memory, like `metrics` below. Not a cache of results — only of "when did
  // this (org,user) last reconcile", so losing it on restart is free.
  app.decorate("reconcileLastRunAt", new Map<string, number>());
  // M15 15.9 (D-15.9-7) the API-key `last_used_at` touch throttle. Decorated HERE, before the route
  // registrations below, for the same reason `rateLimitLogin` is: `resolvePrincipal` reads both of
  // these on every key-authenticated request, and a decorator added after registration is not
  // visible to the handlers. Per-PROCESS and in-memory, like `reconcileLastRunAt` above.
  app.decorate(
    "apiKeyTouchThrottleMs",
    opts.apiKeyTouchThrottleMs ?? DEFAULT_API_KEY_TOUCH_THROTTLE_MS,
  );
  app.decorate("apiKeyLastTouchedAt", new Map<string, number>());
  // M12 12.6 alert delivery: omitted → null → disabled (no webhook). The monitor route's
  // deliverFirings early-returns when null, so the default no-webhook path adds no query.
  app.decorate("alertDeliverer", opts.alertDeliverer ?? null);
  // M15 15.5 identity core. Both decorated BEFORE the route registrations below, like every other
  // decoration, so `app.mailer` / `app.selfSignupEnabled` resolve inside the handlers.
  app.decorate("mailer", opts.mailer ?? null);
  app.decorate("selfSignupEnabled", opts.selfSignupEnabled ?? false);
  // M15 15.7 SSO. All three decorated BEFORE the route registrations below so `app.ssoProviders` /
  // `app.ssoSignupEnabled` / `app.appBaseUrl` resolve inside the handlers.
  app.decorate("ssoProviders", opts.ssoProviders ?? {});
  app.decorate("ssoSignupEnabled", opts.ssoSignupEnabled ?? false);
  app.decorate("appBaseUrl", opts.appBaseUrl ?? "http://localhost:3000");

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
  app.register(ssoRoutes);
  app.register(mfaRoutes);
  app.register(healthRoutes);
  app.register(pairingCodeRoutes);
  app.register(memberRoutes);
  app.register(orgRoutes);
  app.register(apiKeyRoutes);
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
  app.register(connectorCatalogRoutes);
  app.register(replayRoutes);
  app.register(searchRoutes);

  // Map known failures to clean status codes; never leak internals on a 500.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof PairingError) {
      return reply.code(410).send({ error: err.message });
    }
    // M15 15.5 — an invite token and a reset token are the same KIND of thing as a pairing code: a
    // short-lived single-use credential. 410 Gone for all three, and the typed `reason` rides along
    // so a client can tell "expired" from "already used" without parsing the message.
    if (err instanceof InviteError || err instanceof PasswordResetError) {
      return reply.code(410).send({ error: err.message, reason: err.reason });
    }
    // A membership mutation refused by the repository. `last_owner` is a CONFLICT with the org's
    // current state (409); `not_a_member` is a missing subject (404). Mapped by reason rather than
    // collapsed, because "you cannot do that" and "that does not exist" are different answers.
    if (err instanceof MemberError) {
      return reply
        .code(err.reason === "not_a_member" ? 404 : 409)
        .send({ error: err.message, reason: err.reason });
    }
    // M15 15.7 — an SSO link refused by the repository. Both reasons are CONFLICTS with state that
    // already exists (`identity_taken`: that provider identity belongs to somebody else;
    // `last_credential`: unlinking would leave the account unopenable), so both are 409 and the
    // typed `reason` rides along for the dashboard's copy.
    if (err instanceof SsoIdentityError) {
      return reply.code(409).send({ error: err.message, reason: err.reason });
    }
    // M15 15.8 — a second-factor mutation refused by the repository. Its one reason
    // (`already_enrolled`) is a CONFLICT with state that already exists, on exactly the same terms as
    // the SSO branch above, so this is a 409 with no other arm.
    //
    // NOTE what is deliberately NOT handled here: lockouts. `routes/mfa.ts` answers those itself
    // (429 + `Retry-After`), because it holds the `lockedUntil` value and an error handler does not.
    // An earlier version of this branch mapped a `locked` reason that nothing ever constructed —
    // unreachable code whose comment described behaviour the system could not produce.
    if (err instanceof MfaError) {
      return reply.code(409).send({ error: err.message, reason: err.reason });
    }
    // Provider failures (non-200/timeout/parse → 502; not-configured → 503). Placed
    // BEFORE the status>=500 masking branch, which would otherwise hide the message.
    if (err instanceof AnalysisProviderError) {
      return reply.code(err.kind === "not_configured" ? 503 : 502).send({ error: err.message });
    }
    // M15 15.7 — the same mapping for an OAuth provider outage: a Google timeout or a GitHub 500
    // is a 502 here, never a leaked internal error. Placed alongside its analysis sibling and
    // BEFORE the status>=500 masking branch for the same reason.
    if (err instanceof SsoProviderError) {
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
