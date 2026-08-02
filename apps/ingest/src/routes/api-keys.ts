import type { FastifyInstance } from "fastify";
import {
  listApiKeys,
  mintApiKey,
  recordAuditEvent,
  revokeAllApiKeys,
  revokeApiKey,
} from "@420ai/db";
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
 * M15 15.10 — THE MINT AND REVOKE HANDLERS ARE NOW AUDITED, and the append lands inside each
 * handler's transaction (D-15.10-3), so a failed audit insert fails the action rather than
 * committing a credential change nobody can attribute.
 *
 * That works from THIS file — which has no org context at all — only because `audit_events` carries
 * an unconditional `FOR INSERT WITH CHECK (true)` policy rather than the repo's strict org pattern
 * (D-15.10-2). It was measured: SPIKE check 8 confirmed a strict policy REJECTS an insert from an
 * unwrapped route, which would have made every mint a 500. The audit row still carries
 * `principal.orgId` — an audit event is an act WITHIN an org even when the object it acts on
 * (an `api_keys` row) is org-less. Do not "fix" this file by introducing `withOrg`; the transactions
 * below are for ATOMICITY, and the append-only policy needs no context.
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

/**
 * The most LIVE keys one user may hold at once.
 *
 * THE NUMBER IS A JUDGEMENT, NOT A MEASUREMENT, and saying so is more useful than implying
 * otherwise: there is no usage data behind it yet. It is chosen to sit far above any legitimate
 * pattern — a person with a laptop, a desktop, a cron host and a CI runner needs four — while still
 * bounding unbounded accumulation, so the first user to hit it has almost certainly been minting
 * instead of revoking, which is exactly when a nudge helps.
 *
 * It is a CEILING ON ACCUMULATION, not a security control: minting already requires a live session
 * AND the current password AND passes the login rate limit, so this is not what stands between an
 * attacker and a key.
 *
 * D-15.10-5 — THE PROMISED REVISIT DID NOT HAPPEN, and the honest thing is to say so rather than
 * carry a forward-reference that quietly expired. The earlier version of this comment promised a
 * revisit "with real data at 15.10, when the management UI makes key counts visible". The UI landed
 * in 15.10; the real data did not, because there is still one install and one human. Changing the
 * number on no evidence would be the dishonest move, so it stays 25 — a judgement, still not a
 * measurement, and now without a due date it was never going to meet.
 */
const MAX_API_KEYS_PER_USER = 25;

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

      // TRANSACTIONAL because `mintApiKey`'s cap is a count-then-insert: the count and the insert
      // must commit together or the cap is advisory. See that function for the two mechanisms —
      // a `FOR UPDATE` on the owner's `users` row for the cap, the partial unique index for the
      // name. No `withOrg`: `api_keys` is an identity table with no policy (D-15.9-1), so there is
      // nothing for an org context to activate.
      const minted = await app.db.transaction(async (tx) => {
        const result = await mintApiKey(
          tx,
          principal.userId,
          { name: request.body.name, role: requestedRole ?? null, expiresAt },
          MAX_API_KEYS_PER_USER,
        );
        // M15 15.10 — audited on SUCCESS only, in this transaction. A capacity/name refusal is not
        // an event. `metadata` carries the key's SHAPE and NEVER `result.token` or any hash: the
        // plaintext exists exactly once, in the response below, and echoing it here would put a
        // second, PERMANENT copy in the one table the application cannot delete from.
        if (result.ok) {
          await recordAuditEvent(tx, {
            orgId: principal.orgId,
            actorUserId: principal.userId,
            actorEmail: principal.email,
            action: "api_key.minted",
            // Actor and target are the same person: key management is self-service, and setting
            // both makes "everything this user did" and "everything done to this user" agree.
            targetUserId: principal.userId,
            targetEmail: principal.email,
            metadata: {
              keyName: request.body.name,
              role: requestedRole ?? null,
              expiresAt: expiresAt?.toISOString() ?? null,
            },
          });
        }
        return result;
      });
      if (!minted.ok) {
        // 409, not 400: the request is well-formed and would have succeeded against a different
        // state. The `reason` discriminant is what lets a client tell "revoke something first" from
        // "pick another name" without parsing prose.
        return reply.code(409).send({
          error:
            minted.reason === "at_capacity"
              ? `at most ${MAX_API_KEYS_PER_USER} live API keys per user`
              : "a live api key with that name already exists",
          reason: minted.reason,
        });
      }

      return reply.code(201).send({
        apiKey: serializeApiKey(minted.key),
        // THE ONLY PLACE THIS EVER APPEARS. `GET` below returns the row without it, and no column
        // holds it — the response is the credential's entire lifetime outside the client.
        token: minted.token,
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
   * DELETE /v1/auth/api-keys — revoke EVERY key the caller holds.
   *
   * Added by the 15.9 PR review, which found `revokeAllApiKeys` had exactly ONE call site (member
   * removal). That path cannot be applied to an owner by an admin (the 15.5 floor check) and cannot
   * be applied to a sole owner by anyone (the last-owner guard) — so the DEFAULT single-admin
   * deployment had no way to purge keys at all, only to delete them one at a time from a list.
   * "Kill everything I have" must be expressible by the person most likely to need it, and at the
   * moment they need it.
   *
   * The sibling of `POST /v1/auth/sessions/revoke-all`, gated identically at `viewer`: revoking
   * your OWN credentials is not a privileged act on the org, and a panic button a read-only account
   * cannot press is not a panic button.
   *
   * NOT re-auth gated, consistent with the rest of this tier (D-15.9-6) — revocation must never be
   * harder than minting. Returns `{revoked: n}`, how many were LIVE, so a second call answers 0
   * rather than erroring (`revokeAllApiKeys` is idempotent by its `revoked_at IS NULL` predicate).
   *
   * REGISTERED BEFORE the `:id` route below only for readability — Fastify's radix router matches a
   * static path and a parametric one distinctly, so the two cannot shadow each other regardless of
   * order.
   */
  app.delete("/v1/auth/api-keys", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    if (!authorized(principal, "viewer")) {
      return reply.code(403).send({ error: "insufficient role" });
    }
    // TRANSACTIONAL only so the revoke and its audit row commit together (D-15.10-3) — the revoke
    // itself is a single statement and needed none before.
    //
    // AUDITED EVEN WHEN `revoked === 0`. "I pressed the panic button and there was nothing to kill"
    // is a real, meaningful entry on an incident timeline — it is the difference between a user who
    // reacted and a user who did not. This is deliberately NOT the "audit success only" rule's
    // exception: the call SUCCEEDED, it simply had no work to do.
    const revoked = await app.db.transaction(async (tx) => {
      const n = await revokeAllApiKeys(tx, principal.userId);
      await recordAuditEvent(tx, {
        orgId: principal.orgId,
        actorUserId: principal.userId,
        actorEmail: principal.email,
        action: "api_key.revoked_all",
        targetUserId: principal.userId,
        targetEmail: principal.email,
        metadata: { revoked: n },
      });
      return n;
    });
    return reply.code(200).send({ revoked });
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
    // TRANSACTIONAL for the audit row's sake (D-15.10-3); the revoke alone needed no transaction.
    // Audited on success only — a 404 here covers "unknown", "already revoked" and "not yours"
    // deliberately (see above), and none of the three is an event that happened.
    const revoked = await app.db.transaction(async (tx) => {
      const ok = await revokeApiKey(tx, principal.userId, request.params.id);
      if (ok) {
        await recordAuditEvent(tx, {
          orgId: principal.orgId,
          actorUserId: principal.userId,
          actorEmail: principal.email,
          action: "api_key.revoked",
          targetUserId: principal.userId,
          targetEmail: principal.email,
          metadata: { keyId: request.params.id },
        });
      }
      return ok;
    });
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
