import type { Db } from "@420ai/db";
import {
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
 */

/**
 * Generate a project cost-over-time report: read the M6 usage projections, snapshot
 * them into `metrics`, render Markdown, and store a new versioned artifact. An empty
 * project yields a valid all-zero report (D7), never a throw.
 */
export async function generateProjectCostReport(
  db: Db,
  userId: string,
  projectId: string,
  bucket: "day" | "week",
  generatedAt: string,
): Promise<ReportArtifactRow> {
  const [totals, byModel, overTime, projectName] = await Promise.all([
    usageTotals(db, projectId),
    usageByModel(db, projectId),
    usageOverTime(db, projectId, bucket),
    getProjectName(db, projectId),
  ]);
  const metrics = { totals, byModel, overTime };
  const markdown = renderCostOverTimeReport({
    projectName: projectName ?? "(unknown)",
    generatedAt,
    bucket,
    ...metrics,
  });
  return insertReportArtifact(db, {
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
  userId: string,
  sessionId: string,
  generatedAt: string,
): Promise<ReportArtifactRow> {
  const session = await sessionDetail(db, sessionId);
  const markdown = renderSessionAutopsyReport({ generatedAt, session });
  return insertReportArtifact(db, {
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
