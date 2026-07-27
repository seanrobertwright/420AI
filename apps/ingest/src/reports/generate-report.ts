import type { Db } from "@420ai/db";
import {
  withOrg,
  usageTotals,
  usageByModel,
  usageOverTime,
  sessionDetail,
  getProjectName,
  insertReportArtifact,
  type ReportArtifactRow,
} from "@420ai/db";
import {
  renderCostOverTimeReport,
  renderSessionAutopsyReport,
  REPORT_VERSION,
  PRICING_CATALOG_VERSION,
} from "@420ai/shared";

/**
 * M7 report-generation orchestrators (PRD §15). The single seam that composes the
 * M6 read projections + the pure `@420ai/shared` renderer + the versioned db store.
 * Renderers + this module are clock-FREE: the route owns the clock and passes
 * `generatedAt` (an ISO string) in (so the Markdown and the stored row agree).
 * Silent library (CLAUDE.md): throws on error, never logs. Never decrypts (D3) —
 * it reads only the plaintext projections.
 *
 * M15 15.3 — SPLIT WRAPPING, and the split is the whole point (D-15.3-6). The READS run
 * inside one `withOrg`; `insertReportArtifact` stays OUTSIDE it and opens its own, once per
 * retry attempt. That is not tidiness: `insertReportArtifact` retries on a version-conflict
 * unique violation, and a failed statement ABORTS its surrounding transaction — so a retry
 * nested inside an outer transaction would hit `current transaction is aborted` on attempt 2
 * and never recover. Each attempt therefore needs a FRESH transaction, which is exactly what
 * an unwrapped `Db` parameter gives it. Do not "simplify" these functions to take `DbClient`.
 *
 * The reads share ONE transaction and therefore ONE connection, so they are awaited in
 * sequence rather than through `Promise.all`. That is not a style choice: node-postgres queues
 * concurrent queries on a single client and warns that doing so is deprecated (removed in
 * pg@9), so the "parallel" form never actually overlapped. One connection held briefly still
 * beats N connections plus N `set_config` round-trips.
 */

/**
 * Generate a project cost-over-time report: read the M6 usage projections, snapshot
 * them into `metrics`, render Markdown, and store a new versioned artifact. An empty
 * project yields a valid all-zero report (D7), never a throw.
 */
export async function generateProjectCostReport(
  db: Db,
  orgId: string,
  userId: string,
  projectId: string,
  bucket: "day" | "week",
  generatedAt: string,
): Promise<ReportArtifactRow> {
  // Sequential inside the RLS transaction: a transaction is ONE connection, so `Promise.all`
  // here never overlapped — node-postgres queues the queries and warns that concurrent
  // client.query() is deprecated (removed in pg@9). See routes/monitor.ts for the full note.
  const { totals, byModel, overTime, projectName } = await withOrg(db, orgId, async (tx) => ({
    totals: await usageTotals(tx, orgId, projectId),
    byModel: await usageByModel(tx, orgId, projectId),
    overTime: await usageOverTime(tx, orgId, projectId, bucket),
    projectName: await getProjectName(tx, orgId, projectId),
  }));
  const metrics = { totals, byModel, overTime };
  const markdown = renderCostOverTimeReport({
    projectName: projectName ?? "(unknown)",
    generatedAt,
    bucket,
    ...metrics,
  });
  return insertReportArtifact(db, {
    orgId,
    userId,
    projectId,
    reportType: "project.cost_over_time",
    scopeKind: "project",
    scopeId: projectId,
    reportVersion: REPORT_VERSION,
    catalogVersion: PRICING_CATALOG_VERSION,
    analysisVersion: null, // deterministic report — no AI pipeline (D3)
    params: { bucket },
    metrics,
    markdown,
  });
}

/**
 * Generate a session metrics-autopsy report: read the M6 `sessionDetail` projection
 * (a zeroed projection for an unknown id — D7), render it, and store a new versioned
 * artifact. Session-scoped: `projectId` is null, `scopeId` is the connector session id.
 */
export async function generateSessionAutopsyReport(
  db: Db,
  orgId: string,
  userId: string,
  sessionId: string,
  generatedAt: string,
): Promise<ReportArtifactRow> {
  const session = await withOrg(db, orgId, (tx) => sessionDetail(tx, orgId, sessionId));
  const markdown = renderSessionAutopsyReport({ generatedAt, session });
  return insertReportArtifact(db, {
    orgId,
    userId,
    projectId: null,
    reportType: "session.autopsy",
    scopeKind: "session",
    scopeId: sessionId,
    reportVersion: REPORT_VERSION,
    catalogVersion: PRICING_CATALOG_VERSION,
    analysisVersion: null, // deterministic report — no AI pipeline (D3)
    params: null,
    metrics: session,
    markdown,
  });
}
