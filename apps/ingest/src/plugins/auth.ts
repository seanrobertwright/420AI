import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { Db } from "@420ai/db";
import { findMachineIdByToken, touchLastSeen } from "@420ai/db";
import type { AnalysisProvider } from "../analysis/provider.js";

// Module augmentation: make the injected deps + per-request machineId typed
// everywhere in the app. Declared once here; visible across the compilation.
declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    adminToken: string;
    /** M8 injected analysis provider (real client in server.ts; stub in tests). */
    analysisProvider: AnalysisProvider;
    /** M8 resolved max output tokens for an interpretation call. */
    analysisMaxOutputTokens: number;
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
      return reply.code(401).send({ error: "invalid or revoked token" });
    }
    request.machineId = machineId;
    await touchLastSeen(app.db, machineId);
  });
});
