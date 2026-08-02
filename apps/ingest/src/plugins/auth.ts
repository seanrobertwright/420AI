import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { Db } from "@420ai/db";
import { findMachineIdByToken, recordIngestAuthFailure, touchLastSeen } from "@420ai/db";
import type { AnalysisProvider } from "../analysis/provider.js";

// Module augmentation: make the injected deps + per-request machineId typed
// everywhere in the app. Declared once here; visible across the compilation.
declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    /** M12 12.3 single-admin identity (from ADMIN_EMAIL; replaces the hardcoded default email constant). */
    adminEmail: string;
    /** M12 12.3 HMAC key for signing/verifying admin session tokens (POST /v1/auth/login). */
    sessionSecret: string;
    /** M10 3d bundled (or test-injected) ed25519 public key for catalog signature verify. */
    catalogPublicKey: string;
    /** M12 12.7c bundled (or test-injected) ed25519 public key for CONNECTOR-catalog verify. */
    connectorCatalogPublicKey: string;
    /** M8 injected analysis provider (real client in server.ts; stub in tests). */
    analysisProvider: AnalysisProvider;
    /** M8 resolved max output tokens for an interpretation call. */
    analysisMaxOutputTokens: number;
    /** M9 SSE push cadence for GET /v1/monitor/stream (default 3000; tests inject 50). */
    monitorStreamIntervalMs: number;
    /** M15 15.4 (audit B.4) minimum gap between alert reconcile WRITES per (org,user).
     * Default 30 000; tests inject 0, which reproduces pre-15.4 behaviour exactly (every
     * tick reconciles). Without it a connected dashboard wrote every monitorStreamIntervalMs. */
    reconcileThrottleMs: number;
    /** M15 15.4 per-PROCESS "last reconcile" clock, keyed `${orgId}:${userId}` — the same grain
     * as the firing rows. In-memory and reset on restart on purpose: a missed window costs one
     * extra reconcile, never a wrong result. Mirrors the `metrics` store's shape. */
    reconcileLastRunAt: Map<string, number>;
    /** M15 15.9 (D-15.9-7) minimum gap between `api_keys.last_used_at` WRITES per key. Default
     * 60 000; tests inject 0, which makes every authenticated key request touch the column (the
     * only way to assert the write happens at all). Without it the desktop app's monitor poll
     * writes on EVERY tick — the audit-B.4 shape `reconcileThrottleMs` above exists to remove.
     * `sessions` avoids the problem by having no such column; this tier needs one, so it throttles
     * instead. */
    apiKeyTouchThrottleMs: number;
    /** M15 15.9 per-PROCESS "last touched" clock, keyed by `api_keys.id`. In-memory and reset on
     * restart on purpose, exactly like `reconcileLastRunAt`: a missed window costs one extra
     * write, never a wrong result. */
    apiKeyLastTouchedAt: Map<string, number>;
    /** M12 12.4b in-memory request/error counter store (GET /v1/metrics). */
    metrics: import("../metrics.js").MetricsStore;
    /** M12 12.4c per-route login rate limit ({max,timeWindow}) or false when off. Decorated
     * BEFORE routes so routes/auth.ts's `config.rateLimit` resolves either way. */
    rateLimitLogin: { max: number; timeWindow: string } | false;
    /** M12 12.6 injected alert deliverer (webhook in server.ts; spy in tests); null = delivery off. */
    alertDeliverer: import("../delivery/alert-deliverer.js").AlertDeliverer | null;
    /** M15 15.5 transactional mail for invites + password resets; null = no SMTP configured.
     * Callers branch on null ASYMMETRICALLY (D-15.5-10): the admin-gated invite route hands the
     * token back in its response, while the UNAUTHENTICATED reset route 503s — returning a reset
     * token to an anonymous caller would be a complete account-takeover primitive. */
    mailer: import("../delivery/mailer.js").Mailer | null;
    /** M15 15.5 (D-M15-6) whether POST /v1/auth/signup accepts anyone. FALSE unless the operator
     * sets SELF_SIGNUP_ENABLED=true; invite-only is the default posture for EVERY deployment. */
    selfSignupEnabled: boolean;
    /** M15 15.7 the CONFIGURED SSO providers, keyed by id. `{}` when none — the login page asks
     * `GET /v1/auth/sso/providers` which buttons to render, so an unconfigured provider is ABSENT
     * rather than present-and-throwing (the one divergence from `analysisProvider`'s stand-in). */
    ssoProviders: import("../sso/provider.js").SsoProviders;
    /** M15 15.7 (D-15.7-7) whether an SSO callback may CREATE an account. FALSE unless the
     * operator sets SSO_SIGNUP_ENABLED=true — separate from SELF_SIGNUP_ENABLED on purpose. */
    ssoSignupEnabled: boolean;
    /** M15 15.7 the dashboard origin the OAuth `redirect_uri` is DERIVED from (D-15.7-6). Never
     * caller-supplied — a caller-supplied redirect is a complete takeover primitive. */
    appBaseUrl: string;
    /** preHandler that 401s unless a valid bearer token resolves to a machine. */
    authenticate: preHandlerHookHandler;
  }
  interface FastifyRequest {
    machineId: string;
    /** M15 15.2 — the resolved caller (user + org + role), or null before/without resolution.
     *  Set by resolvePrincipal(); read by handlers that need it after their own gate. */
    principal: import("@420ai/db").Principal | null;
    /** M15 15.6 — the caller's `sessions` row id, or null for an API-KEY caller (which has no
     *  session, D-15.9-5) and before resolution. Set by resolvePrincipal() alongside `principal`.
     *
     *  STASHED RATHER THAN RE-DERIVED. The handlers that need it (logout, revoke-all sparing the
     *  current session, the `current: true` flag, the SSE stream's per-tick re-check) all run
     *  strictly AFTER a successful resolvePrincipal, which has already parsed the bearer, verified
     *  the MAC and validated the id as a uuid. Re-deriving it meant a second Bearer parse and a
     *  second HMAC per request — and, worse, a second place the parsing could drift from this one.
     *  A stashed value cannot drift. */
    sessionId: string | null;
    /** M15 15.9 — the caller's `api_keys` row id, or null for a session caller (and before
     *  resolution). Set by resolvePrincipal() alongside `principal`, on the same terms and for the
     *  same reason as `sessionId`: the SSE stream's per-tick re-check needs it, and re-deriving it
     *  would mean a second bearer parse and a second hash.
     *
     *  EXACTLY ONE of `sessionId` / `apiKeyId` is non-null for an authenticated request — a key
     *  mints no session (D-15.9-5), and a session is not a key. The monitor stream relies on that:
     *  it probes whichever one it was given. */
    apiKeyId: string | null;
  }
}

/** Extract a Bearer token from the Authorization header, or null if malformed. */
function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match ? match[1]! : null;
}

export default fp(async function authPlugin(app) {
  app.decorateRequest("machineId", "");
  // M15 15.2: `null`, never an object literal — Fastify shares a reference-type decorator
  // default across every request, so a per-request assignment is the only safe form.
  app.decorateRequest("principal", null);
  // M15 15.6 — same rule: a primitive default is safe to share, an object literal would not be.
  app.decorateRequest("sessionId", null);
  // M15 15.9 — same rule again. `null`, never a Map or an object: Fastify shares a reference-type
  // decorator default across every request, so one request's key id would become every request's.
  app.decorateRequest("apiKeyId", null);

  app.decorate(
    "authenticate",
    async function (this: typeof app, request: FastifyRequest, reply: FastifyReply) {
      const token = bearer(request);
      if (!token) {
        return reply.code(401).send({ error: "missing or malformed authorization header" });
      }
      const machineId = await findMachineIdByToken(app.db, token);
      if (!machineId) {
        // Best-effort §20 audit (M12 12.6) — fire-and-forget so a logging write never alters
        // the 401 latency/contract (CLAUDE.md silent libs). Feeds the ingest.auth_failure alert.
        void recordIngestAuthFailure(app.db, { remoteIp: request.ip }).catch(() => {});
        return reply.code(401).send({ error: "invalid or revoked token" });
      }
      request.machineId = machineId;
      await touchLastSeen(app.db, machineId);
    },
  );
});
