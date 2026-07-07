import type { Db } from "@420ai/db";
import {
  contextPathSample,
  failedToolBreakdown,
  failureSeries,
  gitCommitsByProject,
  getProjectName,
  insertReportArtifact,
  sessionProjections,
  toolStatsByModel,
  usageOverTime,
  usageTotals,
  type ReportArtifactRow,
} from "@420ai/db";
import {
  alignFailureRateSeries,
  contextWasteRecommendations,
  detectAnomalies,
  PRICING_CATALOG_VERSION,
  REPORT_VERSION_M13,
  renderContextWasteReport,
  renderFailedToolCallsReport,
  renderProjectEfficiencyReport,
  renderToolModelComparisonReport,
  renderTrendAnomaliesReport,
} from "@420ai/shared";

/**
 * M13 13.2: the five new project report orchestrators (PRD §15), kept in their
 * own file so `generate-report.ts` stays small. Same contract as the M7
 * orchestrators: `Promise.all(projections) → metrics stored verbatim →
 * renderer → insertReportArtifact`; clock-free (the route passes `generatedAt`).
 * `reportVersion` stamps `REPORT_VERSION_M13`, NOT the M7 `REPORT_VERSION` — the
 * two old renderers are untouched. Never decrypts here — the two decrypt-bearing
 * projections (`failedToolBreakdown`/`contextPathSample`) already return
 * classified counts + `redact()`-ed strings ONLY (D-M13-1); this orchestrator
 * layer stores exactly what they return, unchanged.
 */

export async function generateToolModelComparisonReport(
  db: Db,
  userId: string,
  projectId: string,
  generatedAt: string,
): Promise<ReportArtifactRow> {
  const [rows, projectName] = await Promise.all([
    toolStatsByModel(db, projectId),
    getProjectName(db, projectId),
  ]);
  const metrics = { rows };
  const markdown = renderToolModelComparisonReport({
    projectName: projectName ?? "(unknown)",
    generatedAt,
    ...metrics,
  });
  return insertReportArtifact(db, {
    userId,
    projectId,
    reportType: "project.tool_model_comparison",
    scopeKind: "project",
    scopeId: projectId,
    reportVersion: REPORT_VERSION_M13,
    catalogVersion: PRICING_CATALOG_VERSION,
    analysisVersion: null,
    params: null,
    metrics,
    markdown,
  });
}

export async function generateFailedToolCallsReport(
  db: Db,
  userId: string,
  projectId: string,
  bucket: "day" | "week",
  generatedAt: string,
): Promise<ReportArtifactRow> {
  const [breakdown, series, projectName] = await Promise.all([
    failedToolBreakdown(db, projectId),
    failureSeries(db, projectId, bucket),
    getProjectName(db, projectId),
  ]);
  const metrics = { breakdown, series };
  const markdown = renderFailedToolCallsReport({
    projectName: projectName ?? "(unknown)",
    generatedAt,
    bucket,
    ...metrics,
  });
  return insertReportArtifact(db, {
    userId,
    projectId,
    reportType: "project.failed_tool_calls",
    scopeKind: "project",
    scopeId: projectId,
    reportVersion: REPORT_VERSION_M13,
    catalogVersion: null, // no cost figures in this report
    analysisVersion: null,
    params: { bucket },
    metrics,
    markdown,
  });
}

export async function generateContextWasteReport(
  db: Db,
  userId: string,
  projectId: string,
  generatedAt: string,
): Promise<ReportArtifactRow> {
  const [sample, projectName] = await Promise.all([
    contextPathSample(db, projectId),
    getProjectName(db, projectId),
  ]);
  // The deterministic §17 deliverable: a project-specific, ranked ignore-recommendation
  // list derived purely from the classified counts (no I/O, no clock).
  const recommendations = contextWasteRecommendations(sample.byClass, sample.topPaths);
  const metrics = { ...sample, recommendations };
  const markdown = renderContextWasteReport({
    projectName: projectName ?? "(unknown)",
    generatedAt,
    ...metrics,
  });
  return insertReportArtifact(db, {
    userId,
    projectId,
    reportType: "project.context_waste",
    scopeKind: "project",
    scopeId: projectId,
    reportVersion: REPORT_VERSION_M13,
    catalogVersion: null, // no cost figures in this report
    analysisVersion: null,
    params: null,
    metrics,
    markdown,
  });
}

export async function generateProjectEfficiencyReport(
  db: Db,
  userId: string,
  projectId: string,
  generatedAt: string,
): Promise<ReportArtifactRow> {
  const [totals, sessions, commits, projectName] = await Promise.all([
    usageTotals(db, projectId),
    sessionProjections(db, projectId),
    gitCommitsByProject(db, projectId),
    getProjectName(db, projectId),
  ]);
  const metrics = { totals, sessions, commits };
  const markdown = renderProjectEfficiencyReport({
    projectName: projectName ?? "(unknown)",
    generatedAt,
    ...metrics,
  });
  return insertReportArtifact(db, {
    userId,
    projectId,
    reportType: "project.efficiency",
    scopeKind: "project",
    scopeId: projectId,
    reportVersion: REPORT_VERSION_M13,
    catalogVersion: PRICING_CATALOG_VERSION,
    analysisVersion: null,
    params: null,
    metrics,
    markdown,
  });
}

export async function generateTrendAnomaliesReport(
  db: Db,
  userId: string,
  projectId: string,
  bucket: "day" | "week",
  generatedAt: string,
): Promise<ReportArtifactRow> {
  const [costSeries, failureSeriesRows, projectName] = await Promise.all([
    usageOverTime(db, projectId, bucket),
    failureSeries(db, projectId, bucket),
    getProjectName(db, projectId),
  ]);
  const costAnomalies = detectAnomalies(
    costSeries.map((r) => ({ bucket: r.bucket, value: r.costUsd })),
  );
  // Failure RATE per bucket (toolsFailed/toolCalls), not the raw count — a rate is
  // comparable across buckets of varying activity, mirroring the alerts.ts
  // connector.failing ratio convention. Aligned onto costSeries's bucket set so a
  // quiet bucket (zero terminal tool calls) contributes a genuine 0 rather than a
  // gap — see alignFailureRateSeries's doc comment.
  const failureRateSeries = alignFailureRateSeries(costSeries, failureSeriesRows);
  const failureAnomalies = detectAnomalies(failureRateSeries);
  const metrics = {
    costSeries,
    costAnomalies,
    failureSeries: failureSeriesRows,
    failureAnomalies,
  };
  const markdown = renderTrendAnomaliesReport({
    projectName: projectName ?? "(unknown)",
    generatedAt,
    bucket,
    ...metrics,
  });
  return insertReportArtifact(db, {
    userId,
    projectId,
    reportType: "project.trend_anomalies",
    scopeKind: "project",
    scopeId: projectId,
    reportVersion: REPORT_VERSION_M13,
    catalogVersion: PRICING_CATALOG_VERSION,
    analysisVersion: null,
    params: { bucket },
    metrics,
    markdown,
  });
}
