import type { FastifyInstance } from "fastify";
import { findAdminCredential } from "@420ai/db";
import { loginBodySchema } from "../schemas.js";
import { verifyPassword } from "../password.js";
import { signSession, SESSION_TTL_SECONDS } from "../session.js";
import { adminAuthorized } from "../auth.js";

interface LoginBody {
  email: string;
  password: string;
}

/**
 * M12 12.3 admin login surface. POST /v1/auth/login is the ONE un-gated admin route
 * (it's the entry point); it issues a stateless HMAC session token the dashboard then
 * carries as a bearer (the hybrid adminAuthorized gate accepts it). GET /v1/auth/me is
 * a session-gated identity probe for the dashboard's logged-in state.
 *
 * Brute-force rate-limiting was deferred from 12.3 and SHIPPED in 12.4c: the route config
 * below applies app.rateLimitLogin (strict per-route limit, on by default via server.ts).
 */
export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: LoginBody }>(
    "/v1/auth/login",
    {
      schema: { body: loginBodySchema },
      // M12 12.4c: brute-force guard (deferred here from 12.3). app.rateLimitLogin is decorated
      // in buildApp BEFORE this route registers — {max,timeWindow} when opted in (server.ts /
      // the int test), or false when off (→ no limit; the plugin isn't even registered then).
      config: { rateLimit: app.rateLimitLogin },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const cred = await findAdminCredential(app.db, email);
      // Generic 401 whether the user is missing or the password is wrong (no user-enumeration).
      if (!cred?.passwordHash || !verifyPassword(password, cred.passwordHash)) {
        return reply.code(401).send({ error: "invalid email or password" });
      }
      const { token, exp } = signSession(email, app.sessionSecret, SESSION_TTL_SECONDS);
      return reply.code(200).send({ token, expiresAt: new Date(exp * 1000).toISOString() });
    },
  );

  app.get("/v1/auth/me", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    return reply.code(200).send({ email: app.adminEmail });
  });
}
