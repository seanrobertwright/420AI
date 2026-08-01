import type { FastifyInstance } from "fastify";
import { createApiKey, listApiKeys, revokeApiKey } from "@420ai/db";
import { hasRole } from "@420ai/shared";
import { createApiKeyBodySchema } from "../schemas.js";
import { authorized, isUuid, resolvePrincipal } from "../auth.js";
import { requireRecentAuth } from "../reauth.js";

/**
 * M15 15.9 — API KEY self-service (D-M15-7): mint, list, revoke. The third credential tier, and the
 * one that lets `ADMIN_TOKEN` be retired — a shared, un-attributable, un-revocable, un-expiring
 * god-token becomes one named row per machine client, minted by a real human and capped at that
 * human's rung.
 *
 * M15 15.3 — NONE OF THESE HANDLERS IS `withOrg`-WRAPPED, and this file is on
 * `org-scoping.test.ts`'s `ALLOWED_WITHOUT_WITHORG` list for the reason `auth.ts` and `mfa.ts` are:
 * `api_keys` is an IDENTITY table (D-15.9-1) with no `org_id` and NO RLS policy at all, on the same
 * terms as `users`/`memberships`/`sessions`/`sso_identities`/`totp_credentials`. It is read inside
 * `resolvePrincipal`, at the one moment BEFORE any org context exists, because resolving the row is
 * part of what establishes that context — a strict policy here would read zero rows and every API
 * key would silently 401. There is consequently no policy for `withOrg` to activate, and the
 * `userId` predicate inside every repository call below IS the whole scoping.
 *
 * All three routes are session-gated at `viewer`, matching `GET /v1/auth/sessions`: managing YOUR
 * OWN credentials is not a privileged act on the org, and a read-only account must still be able to
 * revoke a key it issued. The org-level rung only ever bounds what a key may be minted AT.
 *
 * 15.10 note: the mint and revoke handlers are the two audit-worthy events in this file. They are
 * written so an audit call is a one-line addition at the point of success — the audit TABLE lands
 * with the team surfaces, not here.
 */

interface CreateApiKeyBody {
  name: string;
  /** Absent = inherit the owner's membership role exactly (D-15.9-4). */
  role?: "viewer" | "member" | "admin" | "owner";
  /** Absent = never expires (D-15.9-8). */
  expiresInDays?: number;
  /** Absent for an SSO-only account, which has no password to re-present (D-15.9-6). */
  currentPassword?: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export default async function apiKeyRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/auth/api-keys — mint a key. THE ONLY TIME THE PLAINTEXT EXISTS outside the caller's
   * client: only its sha256 is stored (D-15.9-2), so a lost token is re-minted, never recovered.
   *
   * RE-AUTHENTICATION IS REQUIRED (D-15.9-6), via the gate shared with MFA enrolment. A long-lived
   * credential minted from a stolen cookie is a persistence primitive that OUTLIVES the session it
   * came from — the attacker loses the cookie at the next logout or password change and keeps the
   * key. That is D-15.8-16's argument, and it applies at least as strongly here, because a key has
   * no expiry at all by default.
   *
   * Listing and revoking are deliberately NOT gated: REVOCATION MUST NEVER BE HARDER THAN MINTING.
   * A re-auth prompt on the "undo" is a prompt in the middle of an incident response.
   */
  app.post<{ Body: CreateApiKeyBody }>(
    "/v1/auth/api-keys",
    {
      schema: { body: createApiKeyBodySchema },
      // 12.4c's brute-force guard. A session-gated route normally does not need one, and this one
      // does ONLY because the re-auth gate makes it VERIFY A PASSWORD: without the limit an
      // attacker holding a stolen session could grind the password here at one scrypt per request.
      // Exactly the reasoning `POST /v1/auth/mfa/enroll` records, and it travelled with the gate.
      config: { rateLimit: app.rateLimitLogin },
    },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "viewer")) {
        return reply.code(403).send({ error: "insufficient role" });
      }

      // D-15.9-4 / D-15.5-11 — YOU MAY NEVER MINT A KEY ABOVE YOUR OWN RUNG. The ceiling is
      // checked here, at mint time, because it is the only moment the CALLER's identity is
      // available; the FLOOR (the `min` against the owner's current rung) is re-derived on every
      // request in `resolvePrincipal`, which is what makes a later demotion take effect without a
      // rotation. Both halves are needed: this one alone would freeze privilege at issuance.
      //
      // `principal.role` is deliberately NOT cast — it is a TEXT column with no CHECK and `hasRole`
      // fails CLOSED. The REQUESTED role is safe to narrow: the body schema's enum constrained it.
      const requestedRole = request.body.role;
      if (requestedRole && !hasRole(principal.role, requestedRole)) {
        return reply.code(403).send({ error: "cannot grant a role above your own" });
      }

      const reauth = await requireRecentAuth(
        app,
        request,
        principal.userId,
        request.body.currentPassword,
        "sign in again before creating an API key",
      );
      if (!reauth.ok) return reply.code(reauth.code).send(reauth.body);

      // The SERVER owns the clock: the body carries a duration, never an absolute timestamp, so a
      // skewed or hostile client cannot mint a key dated to the year 3000. Absent ⇒ null ⇒ never
      // expires (D-15.9-8).
      const expiresAt =
        request.body.expiresInDays === undefined
          ? null
          : new Date(Date.now() + request.body.expiresInDays * MS_PER_DAY);

      const { key, token } = await createApiKey(app.db, principal.userId, {
        name: request.body.name,
        role: requestedRole ?? null,
        expiresAt,
      });

      return reply.code(201).send({
        apiKey: serializeApiKey(key),
        // THE ONLY PLACE THIS EVER APPEARS. `GET` below returns the row without it, and no column
        // holds it — the response is the credential's entire lifetime outside the client.
        token,
      });
    },
  );

  /**
   * GET /v1/auth/api-keys — the caller's LIVE keys, newest first.
   *
   * Never returns `token_hash`: `apiKeyRowColumns` omits it, which is the enforcement, because no
   * route in this app declares a Fastify `response` schema and therefore nothing strips extra
   * properties from a row (CLAUDE.md 15.1). A bare `select()` in the repository would have put the
   * credential's hash on the wire here with no other code change.
   */
  app.get("/v1/auth/api-keys", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    const rows = await listApiKeys(app.db, principal.userId);
    return reply.code(200).send({ apiKeys: rows.map(serializeApiKey) });
  });

  /**
   * DELETE /v1/auth/api-keys/:id — revoke ONE of the caller's own keys.
   *
   * 404 — NOT 403 — when the id belongs to somebody else. `revokeApiKey` collapses "unknown",
   * "already revoked" and "not yours" into one `false` on purpose: telling a caller that a key id
   * exists but is not theirs turns this route into an enumeration oracle, the same reasoning that
   * makes `DELETE /v1/auth/sessions/:id` answer 404 and the reset route always answer 202
   * (D-15.5-7).
   *
   * Revocation takes effect on the key's NEXT REQUEST — including on an ALREADY-OPEN SSE stream,
   * which re-probes the key every tick (`routes/monitor.ts`). A connect-time-only gate does not
   * revoke, and 15.6 already paid for learning that on sessions.
   */
  app.delete<{ Params: { id: string } }>("/v1/auth/api-keys/:id", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    // `isUuid` first, so a malformed id is a 400 rather than a Postgres uuid-cast 500 — the
    // repo-wide "unknown id → 404, never a DB-constraint 500" invariant.
    if (!isUuid(request.params.id)) {
      return reply.code(400).send({ error: "invalid api key id" });
    }
    const revoked = await revokeApiKey(app.db, principal.userId, request.params.id);
    if (!revoked) {
      return reply.code(404).send({ error: "no such api key" });
    }
    return reply.code(204).send();
  });
}

/**
 * One wire shape for a key row, shared by the mint and list responses so the two cannot drift.
 * Dates are ISO strings, matching every other route in this app; `role: null` and `expiresAt: null`
 * travel as `null` rather than being omitted, because BOTH nulls mean something specific to a
 * client ("inherits my role", "never expires") and an absent field would read as "unknown".
 */
function serializeApiKey(key: {
  id: string;
  name: string;
  role: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}): {
  id: string;
  name: string;
  role: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
} {
  return {
    id: key.id,
    name: key.name,
    role: key.role,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    createdAt: key.createdAt.toISOString(),
  };
}
