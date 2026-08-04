import type { Db } from "@420ai/db";
import {
  withOrg,
  connectorDeclarations,
  declaredConnectorHealth,
  duplicateRawRecords,
  gitLinkageRows,
  ingestLagRows,
  insertReportArtifact,
  machineStatuses,
  observedConnectorAggregates,
  rawRecordTotals,
  reconciliationSample,
  recoverabilityTargets,
  reparseDryRun,
  sessionQualityRows,
  type ReportArtifactRow,
} from "@420ai/db";
import {
  AUDIT_REPORT_VERSION,
  deriveDataQualityMetrics,
  deriveMachineStatus,
  renderDataQualityAuditReport,
} from "@420ai/shared";

/**
 * M16 16.4 — the org-scoped data-quality audit orchestrator (research plan §7 P0.3 + P1.7).
 *
 * Same contract as the M7/M13 orchestrators: `projections → metrics stored verbatim → pure renderer
 * → insertReportArtifact`, clock-free (the route passes `generatedAt`). What is new is only the
 * SCOPE: this is the first `scopeKind: "org"` artifact, which `report_artifacts` already permits
 * with no migration (free-text `scope_kind`, nullable `project_id` — spike F proved the whole write
 * path end-to-end under the non-owner app role).
 *
 * IT DECRYPTS, WHICH NO OTHER ORCHESTRATOR DOES, and the boundary is worth stating here rather than
 * only in the doc: `reparseDryRun` decrypts a bounded SAMPLE of raw records server-side to re-parse
 * them, then keeps only fingerprint COUNTS. No decrypted content reaches `metrics`, the rendered
 * Markdown, or the search index (docs/guide/data-boundary.md §5.1 says the same thing where a
 * design partner will read it).
 */
export async function generateDataQualityAuditReport(
  db: Db, // UNWRAPPED. `insertReportArtifact` re-opens a transaction per retry attempt (D-15.3-6).
  orgId: string,
  role: string,
  userId: string,
  params: { windowDays: number; sampleSize: number },
  generatedAt: string, // The ROUTE owns the clock. This module never reads it.
): Promise<ReportArtifactRow> {
  const nowMs = Date.parse(generatedAt);
  const sinceIso = new Date(nowMs - params.windowDays * 24 * 60 * 60 * 1000).toISOString();
  // TWO REPRESENTATIONS OF ONE BOUND, on purpose. `events.ts` is `mode:"string"` so it compares
  // against an ISO STRING directly; `raw_source_records.ingested_at` is a plain timestamptz whose
  // bound is a `Date`. Conflating them is the M5/M9 bug class (CLAUDE.md), so both are derived here
  // once and threaded down rather than re-derived per read.
  const since = new Date(sinceIso);

  const inputs = await withOrg(db, orgId, role, async (tx) => {
    // SEQUENTIAL inside the RLS transaction: a `tx` is ONE connection, so `Promise.all` here never
    // overlapped — node-postgres queues the queries and warns that concurrent client.query() is
    // deprecated (removed in pg@9). See routes/monitor.ts for the full note.
    const sessions = await sessionQualityRows(tx, orgId, sinceIso);
    const rawTotals = await rawRecordTotals(tx, orgId, since);
    const duplicates = await duplicateRawRecords(tx, orgId, since);
    const lag = await ingestLagRows(tx, orgId, sinceIso, since);
    const declarations = await connectorDeclarations(tx, orgId);
    const gitLinks = await gitLinkageRows(tx, orgId, sinceIso);
    const sample = await reconciliationSample(tx, orgId, sinceIso, params.sampleSize);
    // 16.3's INPUTS, not its conclusions — `deriveDataQualityMetrics` calls `deriveCaptureHealth`
    // itself, so there is no code path in which a second, disagreeing verdict can exist (D-16.4-2).
    const machines = await machineStatuses(tx, orgId);
    const declared = await declaredConnectorHealth(tx, orgId);
    const observed = await observedConnectorAggregates(tx, orgId);
    // (session, connector) PAIRS, not bare session ids: the dry run's subjects must be the same
    // ones the worksheet lists, and filtering on the session alone would re-admit connectors the
    // deterministic sample did not select (and widen the decrypt fan-out past the stated ceiling).
    const targets = await recoverabilityTargets(
      tx,
      orgId,
      sample.map((s) => ({ sessionId: s.sessionId, sourceConnector: s.sourceConnector })),
    );
    return {
      sessions,
      rawTotals,
      duplicates,
      lag,
      declarations,
      gitLinks,
      sample,
      machines,
      declared,
      observed,
      targets,
    };
  });

  // THE DRY RUN GETS ITS OWN `withOrg`, deliberately. It decrypts and re-parses, so it is a bounded
  // second pass rather than another read folded into the block above — keeping the (fast, purely
  // aggregate) transaction above short instead of holding one connection open across N re-parses.
  const recoverability = await withOrg(db, orgId, role, (tx) =>
    reparseDryRun(tx, orgId, inputs.targets),
  );

  const metrics = deriveDataQualityMetrics(
    {
      windowDays: params.windowDays,
      sinceIso,
      sessions: inputs.sessions,
      rawTotals: inputs.rawTotals,
      duplicates: inputs.duplicates,
      lag: inputs.lag,
      declarations: inputs.declarations,
      gitLinks: inputs.gitLinks,
      captureHealth: {
        machines: inputs.machines.map((m) => ({
          id: m.id,
          name: m.name,
          status: deriveMachineStatus(m, nowMs),
        })),
        declared: inputs.declared,
        observed: inputs.observed,
      },
      sample: inputs.sample,
      recoverability,
    },
    nowMs,
  );

  const markdown = renderDataQualityAuditReport({ ...metrics, generatedAt });

  return insertReportArtifact(db, role, {
    orgId,
    userId,
    // ORG-scoped: no project FK, hence no existence check to perform. The "unknown id → 404, never
    // an FK-violation 500" rule exists because a report row FKs to `projects.id`; there is no
    // unvalidated id anywhere on this path — `scopeId` comes from the authenticated principal.
    projectId: null,
    reportType: "org.data_quality_audit",
    scopeKind: "org", // free-text column, no CHECK constraint (verified by spike F).
    scopeId: orgId,
    reportVersion: AUDIT_REPORT_VERSION,
    catalogVersion: null, // no cost figures in this report
    analysisVersion: null,
    params,
    metrics,
    markdown,
  });
}
