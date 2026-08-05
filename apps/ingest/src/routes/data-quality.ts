import type { FastifyInstance } from "fastify";
import { withOrg, indexReportDoc } from "@420ai/db";
import { generateDataQualityAuditReport } from "../reports/generate-report-audit.js";
import { dataQualityAuditBodySchema } from "../schemas.js";
import { authorized, resolvePrincipal } from "../auth.js";

/** §10's scorecard is WEEKLY, so the default window is the week it has to fill. */
const DEFAULT_WINDOW_DAYS = 7;
/** §4.4: "For a sample of ten sessions per month, reconcile: …". */
const DEFAULT_SAMPLE_SIZE = 10;

interface AuditBody {
  windowDays?: number;
  sampleSize?: number;
}

/**
 * POST /v1/audit/data-quality (M16 16.4) — generate the org-scoped data-quality audit artifact.
 *
 * GATED AT `member`, NOT `viewer`, and that is measured rather than chosen. Spike F ran a `viewer`
 * insert against `report_artifacts` under the non-owner app role and it failed with `new row
 * violates row-level security policy "report_artifacts_role_write_ins"` — so a `viewer` gate here
 * would return a 500 instead of a clean 403. Every other report GENERATION route gates at `member`
 * for the same reason (`routes/reports.ts:67`, `:168`) — the report READ routes gate at `viewer`
 * (`:198`, `:219`) and can, because they never insert.
 *
 * `principal.role`, NOT `SERVICE_ROLE`. The 15.4 test is "whose action is this?", and an operator
 * generating their own capture audit is the CALLER's action — unlike `routes/monitor.ts`, whose GET
 * performs the org's own alert bookkeeping and therefore must not run as whoever opened the page.
 *
 * NO EXISTENCE CHECK, AND NONE SHOULD BE ADDED. The "unknown id → 404, never a DB-constraint 500"
 * rule exists because a report row FKs to `projects.id`; this artifact sets `projectId: null` and
 * takes its `scopeId` from the authenticated principal's org, so there is no unvalidated id to
 * screen. Adding an `isUuid` gate here would be guarding against a parameter that does not exist.
 *
 * Generation is intentionally NON-IDEMPOTENT, like every other report route: each POST appends a
 * new version, which is what makes week-over-week comparison possible.
 */
export default async function dataQualityRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: AuditBody }>(
    "/v1/audit/data-quality",
    { schema: { body: dataQualityAuditBodySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "member")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      // THE ROUTE OWNS THE CLOCK. The orchestrator, the derivation and the renderer are all
      // clock-free, so the whole artifact is reproducible from this one stamp.
      const generatedAt = new Date().toISOString();
      const params = {
        windowDays: request.body?.windowDays ?? DEFAULT_WINDOW_DAYS,
        sampleSize: request.body?.sampleSize ?? DEFAULT_SAMPLE_SIZE,
      };

      const row = await generateDataQualityAuditReport(
        // UNWRAPPED `app.db` (D-15.3-6): `insertReportArtifact` re-opens a transaction per retry
        // attempt, which a `Tx` cannot do. The orchestrator wraps its own reads.
        app.db,
        principal.orgId,
        principal.role,
        principal.userId,
        params,
        generatedAt,
      );

      // Refresh the artifact's search doc best-effort (the awaited-with-swallow pattern the other
      // report routes use) — a failed index must never fail a generated report.
      try {
        await withOrg(app.db, principal.orgId, principal.role, (tx) => indexReportDoc(tx, row.id));
      } catch (err) {
        request.log.warn({ err }, "audit report search indexing failed");
      }
      return reply.code(201).send(row);
    },
  );
}
