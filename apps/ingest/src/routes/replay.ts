import type { FastifyInstance } from "fastify";
import { getActiveCatalog, repriceAll, reparseAll, listOrganizations, withOrg } from "@420ai/db";
import type { RepriceResult, ReparseResult } from "@420ai/db";
import { resolvePrincipal } from "../auth.js";

/**
 * M12 12.5a + M13 13.3 archive-replay. Admin-gated.
 *
 * POST /v1/replay/reprice → { repriced, catalogVersion }
 *   Retroactively re-prices every cost-bearing event under the ACTIVE uploaded
 *   catalog (the going-forward ingest path only reprices on re-ingest). No body.
 *   409 when no catalog is active (nothing to apply).
 *
 * POST /v1/replay/reparse → { sessions, eventsUpserted, orphansDeleted, skipped }
 *   The 12.5b re-parse engine: decrypt raw records → re-parse under the CURRENT
 *   shared parsers → upsert-by-fingerprint → orphan-event GC. Optional body
 *   `{ sessionId }` scopes to one session. An active catalog is OPTIONAL here
 *   (present → the upsert re-prices under it) — no 409. Gemini sessions are
 *   skipped and reported (D-M13-2).
 *
 * M15 15.3 (D-15.3-5) — both remain DEPLOYMENT-WIDE in effect, but the mechanism changed from
 * one unscoped pass to a pass PER ORG. Under the app role an unwrapped pass sees zero rows and
 * would silently report `{repriced: 0}` — a maintenance op that reports success having done
 * nothing is the worst failure mode available. Iterating `listOrganizations` inside `withOrg`
 * gets the same coverage with ZERO privileged seams in the server. Response shapes are
 * unchanged: counts are summed in TypeScript, never via an aggregate over `org_id`.
 *
 * `getActiveCatalog` stays OUTSIDE the loop — `pricing_catalogs` is a deployment-global table
 * (D-M15-9) with no `org_id` and no policy, so it is one read, not one per org.
 */
export default async function replayRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/replay/reprice", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    const active = await getActiveCatalog(app.db);
    if (!active) {
      return reply.code(409).send({ error: "no active catalog to re-price under" });
    }
    const orgs = await listOrganizations(app.db);
    const totals: RepriceResult = { repriced: 0, catalogVersion: active.version };
    for (const org of orgs) {
      const counts = await withOrg(app.db, org.id, (tx) => repriceAll(tx, org.id, active));
      totals.repriced += counts.repriced;
    }
    return reply.code(200).send(totals);
  });

  app.post("/v1/replay/reparse", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    // The body is OPTIONAL (a bare POST re-parses everything, mirroring reprice's
    // no-body contract) — so no JSON-schema `body` (Fastify would 400 an absent
    // body); validate the one optional field by hand instead.
    const body = (request.body ?? {}) as { sessionId?: unknown };
    if (
      body.sessionId !== undefined &&
      (typeof body.sessionId !== "string" || body.sessionId === "")
    ) {
      return reply.code(400).send({ error: "sessionId must be a non-empty string" });
    }
    // Capture the narrowed value: the guard above narrows `body.sessionId` from `unknown`,
    // but that narrowing does NOT survive into the closure below (TS cannot prove a mutable
    // property is unchanged when a callback runs).
    const sessionId = body.sessionId as string | undefined;
    const repricing = await getActiveCatalog(app.db);
    const orgs = await listOrganizations(app.db);
    const totals: ReparseResult = {
      sessions: 0,
      eventsUpserted: 0,
      orphansDeleted: 0,
      skipped: { gemini: 0, other: 0 },
    };
    for (const org of orgs) {
      const counts = await withOrg(app.db, org.id, (tx) =>
        reparseAll(tx, org.id, { sessionId, repricing }),
      );
      totals.sessions += counts.sessions;
      totals.eventsUpserted += counts.eventsUpserted;
      totals.orphansDeleted += counts.orphansDeleted;
      totals.skipped.gemini += counts.skipped.gemini;
      totals.skipped.other += counts.skipped.other;
    }
    return reply.code(200).send(totals);
  });
}
