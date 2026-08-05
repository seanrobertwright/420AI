import type { Db } from "@420ai/db";
import {
  withOrg,
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
  type RecoverabilityRow,
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
 * them, then keeps only fingerprint COUNTS. No DECRYPTED content reaches `metrics`, the rendered
 * Markdown, or the search index — though like every report artifact both do carry plaintext
 * metadata (project paths, model names, machine names, connector error strings). See
 * docs/guide/data-boundary.md §5 ("The data-quality audit decrypts a bounded sample"), which states
 * the same distinction where a design partner will read it.
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
    const gitLinks = await gitLinkageRows(tx, orgId, sinceIso);
    const sample = await reconciliationSample(tx, orgId, sinceIso, params.sampleSize);
    // 16.3's INPUTS, not its conclusions — `deriveDataQualityMetrics` calls `deriveCaptureHealth`
    // itself, so there is no code path in which a second, disagreeing verdict can exist (D-16.4-2).
    const machines = await machineStatuses(tx, orgId);
    const declared = await declaredConnectorHealth(tx, orgId);
    const observed = await observedConnectorAggregates(tx, orgId);
    // TOKEN/LIVENESS DECLARATIONS ARE PROJECTED FROM 16.3's ROWS, not fetched again. `declared` is
    // already one row per (machine, connector) over the whole org and `DeclaredConnectorRow` is a
    // strict superset of what `summarizeDeclarations` reads — so a second read of
    // `machine_connectors` in this same transaction would be a redundant round-trip AND a second
    // place for the two to disagree. Projected explicitly rather than passed through, so 16.4's
    // input contract stays independent of 16.3's row shape.
    const declarations = declared.map((d) => ({
      connectorId: d.connectorId,
      tokens: d.tokens,
      liveness: d.liveness,
    }));
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

  // ONE TRANSACTION PER TARGET, not one for the whole dry run — and this is a real bound, not a
  // tidiness preference. A `withOrg` holds a pooled connection for its whole body; the dry run's
  // body is CPU-bound (decrypt → reassemble → re-parse) with queries only at the ends, so wrapping
  // all N targets in one transaction parks a connection in `idle in transaction` for the entire
  // run. `createDb` builds `new Pool({ connectionString })` — pg defaults, so `max: 10` and NO
  // `connectionTimeoutMillis` — and this route is not rate-limited (`global: false`), so a handful
  // of concurrent audits would exhaust the pool and every other ingest request would then block in
  // `pool.connect()` forever: no error, no log, no 503. The dry run needs no cross-target
  // atomicity (it writes nothing and each target is independent), so per-target transactions cost
  // nothing and return the connection between targets.
  const recoverability: RecoverabilityRow[] = [];
  for (const target of inputs.targets) {
    const [row] = await withOrg(db, orgId, role, (tx) => reparseDryRun(tx, orgId, [target]));
    if (row) recoverability.push(row);
  }

  // A SAMPLED PAIR THAT PRODUCED NO TARGET IS REPORTED, NOT DROPPED. `recoverabilityTargets`
  // selects FROM `raw_source_records`, so a sampled (session, connector) with no surviving raw row
  // yields no target at all — and without this it would vanish from `rows`, from `attempted` and
  // from every skip bucket, rendering as though it had never been sampled. That silently discards
  // the WORST possible recoverability outcome: events that exist with no raw record behind them are
  // 0% recoverable, which is precisely the finding this metric exists to surface. It is also the
  // row `no-raw-records` was written for — the branch inside `reparseDryRun` cannot be reached,
  // because targets are by construction selected from raw.
  const reached = new Set(recoverability.map((r) => `${r.sessionId}\u0000${r.sourceConnector}`));
  for (const s of inputs.sample) {
    const key = `${s.sessionId}\u0000${s.sourceConnector}`;
    if (reached.has(key)) continue;
    reached.add(key);
    recoverability.push({
      sessionId: s.sessionId,
      sourceConnector: s.sourceConnector,
      machineId: s.machineId ?? "(unknown)",
      storedEvents: 0,
      reparsedEvents: 0,
      missing: 0,
      extra: 0,
      ok: false,
      skippedReason: "no-raw-records",
    });
  }

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
