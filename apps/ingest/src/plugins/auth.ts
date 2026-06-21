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
    adminToken: string;
    /** M12 12.3 single-admin identity (from ADMIN_EMAIL; replaces the hardcoded default email constant). */
    adminEmail: string;
    /** M12 12.3 HMAC key for signing/verifying admin session tokens (POST /v1/auth/login). */
    sessionSecret: string;
    /** M10 3d bundled (or test-injected) ed25519 public key for catalog signature verify. */
    catalogPublicKey: string;
    /** M8 injected analysis provider (real client in server.ts; stub in tests). */
    analysisProvider: AnalysisProvider;
    /** M8 resolved max output tokens for an interpretation call. */
    analysisMaxOutputTokens: number;
    /** M9 SSE push cadence for GET /v1/monitor/stream (default 3000; tests inject 50). */
    monitorStreamIntervalMs: number;
    /** M12 12.4b in-memory request/error counter store (GET /v1/metrics). */
    metrics: import("../metrics.js").MetricsStore;
    /** M12 12.4c per-route login rate limit ({max,timeWindow}) or false when off. Decorated
     * BEFORE routes so routes/auth.ts's `config.rateLimit` resolves either way. */
    rateLimitLogin: { max: number; timeWindow: string } | false;
    /** M12 12.6 injected alert deliverer (webhook in server.ts; spy in tests); null = delivery off. */
    alertDeliverer: import("../delivery/alert-deliverer.js").AlertDeliverer | null;
    /** preHandler that 401s unless a valid bearer token resolves to a machine. */
    authenticate: preHandlerHookHandler;
  }
  interface FastifyRequest {
    machineId: string;
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

  app.decorate("authenticate", async function (this: typeof app, request: FastifyRequest, reply: FastifyReply) {
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
  });
});
