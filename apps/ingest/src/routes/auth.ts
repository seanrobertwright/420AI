import type { FastifyInstance } from "fastify";
import { findAdminCredential } from "@420ai/db";
import { loginBodySchema } from "../schemas.js";
import { verifyPassword } from "../password.js";
import { signSession, SESSION_TTL_SECONDS } from "../session.js";
import { resolvePrincipal, authorized } from "../auth.js";

interface LoginBody {
  email: string;
  password: string;
}

/**
 * M12 12.3 admin login surface. POST /v1/auth/login is the ONE un-gated admin route
 * (it's the entry point); it issues a stateless HMAC session token the dashboard then
 * carries as a bearer (the hybrid resolvePrincipal gate accepts it). GET /v1/auth/me is
 * a session-gated identity probe for the dashboard's logged-in state.
 *
 * Brute-force rate-limiting was deferred from 12.3 and SHIPPED in 12.4c: the route config
 * below applies app.rateLimitLogin (strict per-route limit, on by default via server.ts).
 *
 * M15 15.3 — NO `withOrg` here, deliberately, and this file is the clearest case of why the
 * identity tables carry no RLS (D-15.3-4). `findAdminCredential` reads `users` in order to
 * ESTABLISH who the caller is; a policy keyed on an org context would be circular — login is
 * precisely the moment before any org is known.
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
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    // M15 15.2 BUG FIX: report the CALLER's email, not the env admin's. Before the
    // principal existed this returned `app.adminEmail` no matter who logged in, so a
    // second user saw the admin's address in the dashboard nav. Shape is unchanged.
    return reply.code(200).send({ email: principal.email });
  });
}
