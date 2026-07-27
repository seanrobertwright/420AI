import type { FastifyInstance } from "fastify";
import { searchDocuments, rebuildSearchIndex, listOrganizations, withOrg } from "@420ai/db";
import type { ReindexCounts } from "@420ai/shared";
import type { SearchEntityType } from "@420ai/shared";
import { searchQuerySchema } from "../schemas.js";
import { resolvePrincipal, isUuid } from "../auth.js";

/**
 * M12 §21 admin search endpoints. Both admin-gated (mirrors routes/projections.ts:
 * inline `resolvePrincipal`→401, `isUuid`→404). Hits come from the REDACTED
 * `search_documents` projection — never the encrypted originals (PRD §18.1).
 *
 *   - GET  /v1/search          — ranked, redacted hits (querystring-validated `q`).
 *   - POST /v1/search/reindex  — full delete-then-rebuild of the index (manual-first).
 *
 * `reindex` decrypts session content to redact-then-store it, so the server needs
 * `ARCHIVE_ENCRYPTION_KEY` (the same env every decrypt path requires). The empty/
 * over-long `q` case is rejected by `searchQuerySchema` (400) before the handler.
 */
export default async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      q: string;
      type?: SearchEntityType;
      projectId?: string;
      limit?: number;
      offset?: number;
    };
  }>("/v1/search", { schema: { querystring: searchQuerySchema } }, async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    const { q, type, projectId, limit, offset } = request.query;
    // A project filter must be a well-formed uuid (else a PG uuid-cast 500) →
    // unknown/malformed id is 404, preserving the repo-wide invariant.
    if (projectId !== undefined && !isUuid(projectId)) {
      return reply.code(404).send({ error: "project not found" });
    }
    const result = await withOrg(app.db, principal.orgId, (tx) =>
      searchDocuments(tx, {
        orgId: principal.orgId,
        q,
        type,
        projectId: projectId ?? null,
        limit,
        offset,
      }),
    );
    return reply.code(200).send(result);
  });

  app.post("/v1/search/reindex", async (request, reply) => {
    const principal = await resolvePrincipal(app, request);
    if (!principal) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    // D-15.2-7: DELIBERATELY not org-scoped. Reindex is a deployment-wide maintenance
    // operation, and after 15.1 its writers already stamp the correct per-row `org_id`
    // (pinned by tenancy.int.test.ts "indexSessions emits ONE doc PER ORG"). Restricting
    // WHO may run it is 15.4's RBAC job, not this slice's.
    //
    // M15 15.3 (D-15.3-5) — still deployment-wide in EFFECT; only the MECHANISM changed,
    // from one unscoped pass to a pass PER ORG. It has to: `rebuildSearchIndex` opens with an
    // unqualified delete, so under RLS an unwrapped call would see zero rows and silently
    // report `{total: 0}` — the worst possible failure mode for a maintenance op. The
    // alternative (a privileged bypass connection) would put a permanent cross-org seam in
    // the ingest server; looping keeps the rule absolute: the server can never see across
    // orgs, full stop. The response shape is UNCHANGED — counts are summed in TypeScript,
    // never via an aggregate over `org_id` (CLAUDE.md: aggregating a tenancy column is a
    // smell — it is how 15.1 collapsed two tenants into one search document).
    const orgs = await listOrganizations(app.db);
    const totals: ReindexCounts = { reports: 0, projects: 0, sessions: 0, events: 0, total: 0 };
    for (const org of orgs) {
      const counts = await withOrg(app.db, org.id, (tx) => rebuildSearchIndex(tx, org.id));
      totals.reports += counts.reports;
      totals.projects += counts.projects;
      totals.sessions += counts.sessions;
      totals.events += counts.events;
      totals.total += counts.total;
    }
    return reply.code(200).send(totals);
  });
}
