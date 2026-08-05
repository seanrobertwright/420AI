# Feature: M16 Slice 16.4 — Data-Quality Audit Report

The following plan should be complete, but it is important that you validate documentation, codebase
patterns and task sanity before you start implementing.

Pay special attention to the naming of existing utils, types and models. Import from the right files.

> **Conventions live in [`CLAUDE.md`](../../CLAUDE.md); this plan LINKS, it does not re-paste.** The
> milestone definition is [`.agents/plans/m16-dogfood-instrumentation.md`](./m16-dogfood-instrumentation.md);
> the research method is
> [`.agents/supplemental docs/research-analysis-plan.md`](../supplemental%20docs/research-analysis-plan.md)
> (hereafter "**§n**" with no other qualifier). Where the two disagree, the research plan wins on
> _what to measure_ and the milestone plan wins on _how it is built_.

---

## Feature Description

The last slice of M16. It turns the research plan's **§5.1 data-quality metric table** from seven
numbers a human would otherwise guess into **one deterministic, versioned report artifact** —
generated on demand, stored in the existing `report_artifacts` store, rendered as Markdown, and
exportable through the endpoints M12 already built.

It closes **§7 P0.3** (_"Surface unmapped sessions, missing tokens, stale connectors, parser
failures, and sample reconciliation status. Acceptance: **weekly scorecard values are queryable
rather than manually guessed**"_) and folds in **§7 P1.7** (_git outcome confidence: separate
confirmed linkage, heuristic linkage, and no linkage. Acceptance: **reports never imply causal
productivity from a weak correlation**_).

Its output is shaped to be **copied straight into `.agents/research/weekly/YYYY-WW.md`** — the §10
weekly scorecard template's "Capture health" block has seven rows, and this report emits exactly
those seven rows plus their evidence.

**The organising principle is the one 16.3 established and this slice inherits verbatim: a metric
that cannot be measured must say so.** §5.1 ends with a rule that is easy to read past and is
actually the whole design constraint:

> Record unknown values explicitly. **Do not substitute zero for absent data.**

Two of the seven metrics genuinely require ground truth that lives outside the product (§4.4), and a
third requires work bounded to a sample. This report therefore returns a **three-state value** for
every metric — `measured`, `sampled`, or `unknown` **with a reason** — and never a bare number.

---

## User Story

As **the sole operator of a 24-week dogfood research period**
I want **the seven §5.1 data-quality metrics computed from the archive, with every unmeasurable one
labelled as unmeasurable and why**
So that **my weekly scorecard reports what the system actually knows, and a metric I later publish is
falsifiable rather than flattering.**

---

## Problem Statement

Research plan §5.1 defines seven data-quality metrics with hard targets (capture coverage ≥95%,
attribution ≥90%, token completeness ≥95%, parse success ≥99%, duplicate rate <1%, sync freshness
≥95%, recoverability 100% of monthly sample). §10's weekly scorecard has a row for each. **None of
them is computable today.** The operator would fill that table by hand from the Monitor page, which
is:

1. **Not reproducible** — no artifact records what was counted, over what window, under which parser
   and catalog versions. A number in a scorecard four weeks later cannot be re-derived or challenged.
2. **Structurally biased toward optimism** — every existing projection (`connectorHealth`,
   `usageTotals`, `projectEventSummary`) aggregates **what arrived**. A session that was never
   captured contributes nothing to any of them, so the archive's own numbers cannot see their own
   denominator. Eyeballing them yields a coverage figure that is 100% by construction.
3. **Precisely the milestone's Risk 2** — _"Measuring the thing you are also building. 16.3 and 16.4
   produce the metrics that judge capture quality, and the same operator writes both."_ A
   hand-assembled metric table is that risk with no mitigation attached.

And the specific failure this must not reproduce is the one 16.3 shipped a fix for: **a denominator
of zero rendering as a pass.** `0 parse failures ÷ 0 raw records = "100% ✅"` and `0 ÷ 4000 = "100%
✅"` are opposite facts wearing the same badge.

---

## Solution Statement

One new **org-scoped** report type, `org.data_quality_audit`, generated through the **existing M7
versioned-artifact pipeline** (`projections → metrics stored verbatim → pure renderer →
insertReportArtifact`), following `generate-report-m13.ts` line for line.

Its metrics divide into three honestly-labelled classes:

| Class        | Meaning                                                                          | §5.1 metrics                                                                                             |
| ------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **measured** | Derived from the whole archive inside the window. A real ratio over a real denominator. | Token completeness, Parse success, Duplicate rate, Sync freshness, **Project attribution _coverage_**        |
| **sampled**  | Derived, but over a bounded sample — stated as such, with the sample size on the row.  | **Recoverability** (dry-run re-parse of N sessions)                                                         |
| **unknown**  | Requires ground truth outside the product (§4.4). Emitted with a REASON, never a zero. | **Capture coverage**, **Project attribution _correctness_**                                                  |

Plus two additions that are not §5.1 rows:

- **Capture health roll-up** — the "stale/unhealthy connectors" scorecard row, taken **verbatim from
  16.3's `deriveCaptureHealth`**, never re-derived (D-16.4-2).
- **Git outcome confidence** (§7 P1.7) — sessions bucketed into `confirmed` / `heuristic` / `none`,
  with the report stating in prose that a heuristic link is not causal evidence.

And the bridge to the human half: a **deterministic §4.4 reconciliation worksheet** of N sampled
sessions, with the four archive-answerable checks pre-filled and the two human-only checks left as
explicit blanks.

**No new table. No migration. No new dashboard page.**

---

## Feature Metadata

**Feature Type**: New Capability
**Estimated Complexity**: Medium–Large (matches the milestone table's `M–L`)
**Primary Systems Affected**: `packages/shared` (pure derivation + renderer), `packages/db`
(aggregate reads + dry-run re-parse), `apps/ingest` (orchestrator + one route), `apps/dashboard` (one
proxy + one button on the **existing** Reports page), `scripts/generate-reports.mjs`, docs
**Dependencies**: **None new.** Every package needed is already installed and already imported by
the files being mirrored. No `npm install` in this slice.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — IMPORTANT: YOU MUST READ THESE BEFORE IMPLEMENTING

**The pattern to mirror, in priority order:**

- `packages/shared/src/capture-health.ts` (whole file, 363 lines) — **the closest sibling and the
  model for this slice's shared module.** Pure, clock-injected, dependency-free; a union that
  includes explicit "cannot tell" states; a `*_VERSION` stamp; every judgement unit-testable with no
  database. Copy its shape and its comment discipline.
- `apps/ingest/src/reports/generate-report-m13.ts` (lines 1–75) — **the orchestrator contract.** Note
  precisely: reads inside ONE `withOrg` **sequentially** (a `tx` is one connection — `Promise.all`
  never overlapped and warns), `metrics` stored verbatim, then `insertReportArtifact(db, role, …)`
  with the **UNWRAPPED `db`**.
- `packages/db/src/repositories/reports.ts` (lines 62–137) — `insertReportArtifact`. **Read the
  D-15.3-6 comment block at 92–103 before touching the call.** The `Db` (not `Tx`) parameter is
  load-bearing: it re-opens a transaction per retry attempt. Do not "fix" it.
- `packages/db/src/repositories/capture-health.ts` (whole file, 297 lines) — the aggregate-read
  model: explicit column constants, `orgId` always the SECOND parameter, `toIso` on every
  `mode:"string"` aggregate, and a header comment naming the mechanism.
- `packages/db/src/repositories/sql-coerce.ts` (whole file, 30 lines) — **`toIso`. Import it; do not
  re-derive it.** Its header states the mechanism once, deliberately.
- `apps/ingest/src/routes/capture-health.ts` (whole file, 71 lines) — the route model: the **route
  owns the clock**, `principal.role` (not `SERVICE_ROLE`) because this path performs no org
  bookkeeping write, sequential reads inside `withOrg`.
- `apps/ingest/src/routes/reports.ts` (lines 43–57, 58–83) — the generation-route model, the
  existence-check-before-insert rule (a well-formed-but-nonexistent id must 404 **before** the
  insert, never an FK-violation 500), and the best-effort `indexReportDoc` swallow.
- `packages/db/src/repositories/reparse.ts` (lines 63–119, 173–212) — `reassembleCodex` /
  `reassembleClaude` and the decrypt→reassemble→parse sequence. **These two functions are currently
  module-private; Task 5 adds `export` to them and changes nothing else.**
- `packages/shared/src/reports.ts` (lines 16–66, 262–321) — renderer contract: pure, `generatedAt`
  caller-injected, **Markdown tables are the source of truth** and any Mermaid block is explicitly
  labelled illustrative.
- `packages/db/src/repositories/projections.ts` (lines 381–414, `connectorHealthWindowed`) — **the
  windowing idiom.** `gte(events.ts, sinceIso)` compares an ISO string directly against the
  `mode:"string"` column; the return normalizes `max(ts)` through `toIso` with the reason in the
  comment.
- `packages/db/src/repositories/capture-health.int.test.ts` (lines 1–80) — **the two-role integration
  harness this slice must copy**, including the role-identity first test.
- `apps/dashboard/src/components/projects/project-report-actions.tsx` (whole file) — the client
  mutation island: POST the same-origin proxy, **check `res.ok`** (fetch resolves on 4xx/5xx),
  disable in-flight against a duplicate non-idempotent POST, `router.refresh()`.
- `apps/dashboard/src/app/api/projects/[id]/reports/route.ts` (whole file, 17 lines) — the POST proxy.
- `scripts/generate-reports.mjs` (lines 30–80, 120–160) — `PROJECT_REPORT_TYPES`, `parseArgs`,
  `resolveReportTypes`, and the POST loop.

**Schema and contract references (read, do not change):**

- `packages/db/src/schema.ts:409–486` — `rawSourceRecords` + `events`. Note `events.ts` is
  `mode:"string"`; `rawSourceRecords.ingestedAt` is a **plain** timestamptz (a `Date`).
- `packages/db/src/schema.ts:644–678` — `reportArtifacts`. `scopeKind` is free text (**no CHECK
  constraint** — verified by spike F); `projectId` is nullable; the unique index is
  `(userId, reportType, scopeId, version)`.
- `packages/db/src/schema.ts:769–795` — `sessionGitLinks` (`status`: `suggested|confirmed|rejected`).
- `packages/shared/src/fingerprint.ts` (whole file, 25 lines) — **the duplicate-rate argument depends
  on the exact input list**: `sha256(sourceConnector | rawRecordId | eventIndex | eventType)`.
  `session_id` is **not** an input. This is why the duplicate grouping key omits it (D-16.4-3).
- `packages/shared/src/control-protocol.ts:54–73` — `ConnectorInfo`: `tokens: "exact" | "estimated" |
"none"`, `liveness`, `approval`, `status`. `tokens !== "none"` is the token-completeness
  eligibility predicate.
- `packages/shared/src/cost.ts:14–42` — `CostConfidence` + `CONFIDENCE_ORDER`.
- `apps/ingest/src/routes/org-scoping.test.ts` (lines 1–60) — the structural grep a new route file
  must satisfy (it will, automatically, by calling `withOrg`). Read its KNOWN LIMIT paragraph: it is
  file-granular, which is why Task 12's behavioural app-role test is the real proof.

### New Files to Create

| Path                                                        | Purpose                                                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/shared/src/data-quality.ts`                       | Pure types + `deriveDataQualityMetrics` + `DATA_QUALITY_VERSION`. Clock-injected, no I/O.        |
| `packages/shared/src/data-quality.test.ts`                  | Unit tests for every metric branch, especially the zero-denominator ones.                        |
| `packages/shared/src/reports-audit.ts`                      | `renderDataQualityAuditReport` — the Markdown renderer.                                          |
| `packages/shared/src/reports-audit.test.ts`                 | Renderer unit tests (golden-ish assertions on the seven rows + the worksheet).                  |
| `packages/db/src/repositories/data-quality.ts`              | The five windowed aggregate reads.                                                              |
| `packages/db/src/repositories/data-quality.int.test.ts`     | **Two-role** integration suite for the aggregates.                                              |
| `packages/db/src/repositories/recoverability.ts`            | `reparseDryRun` — decrypt → reassemble → re-parse → compare fingerprints. **Writes nothing.**    |
| `packages/db/src/repositories/recoverability.int.test.ts`   | **Two-role** integration suite, incl. the "wrote nothing" assertion.                            |
| `apps/ingest/src/reports/generate-report-audit.ts`          | The orchestrator.                                                                               |
| `apps/ingest/src/reports/reports-audit.int.test.ts`         | HTTP-level integration through `buildApp`.                                                      |
| `apps/ingest/src/routes/data-quality.ts`                    | `POST /v1/audit/data-quality`.                                                                  |
| `apps/dashboard/src/app/api/audit/data-quality/route.ts`    | The same-origin POST proxy.                                                                     |
| `apps/dashboard/src/components/reports/audit-actions.tsx`   | The one button on the existing Reports page.                                                    |

### Files to Modify

| Path                                              | Change                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/shared/src/index.ts`                    | Export the two new modules.                                                                  |
| `packages/shared/src/reports.ts`                  | Add `"org.data_quality_audit"` to the `ReportType` union **only**. Renderers stay untouched. |
| `packages/db/src/repositories/reparse.ts`         | Add `export` to `reassembleCodex` + `reassembleClaude`. **Nothing else.**                    |
| `packages/db/src/index.ts`                        | Export the two new repositories.                                                             |
| `apps/ingest/src/schemas.ts`                      | Add `dataQualityAuditBodySchema`.                                                            |
| `apps/ingest/src/app.ts`                          | Register `dataQualityRoutes`.                                                                |
| `apps/dashboard/src/components/reports/reports-view.tsx` | Mount `<AuditActions />`; widen the subtitle.                                          |
| `scripts/generate-reports.mjs`                    | Add the `--audit` flag.                                                                      |
| `docs/PRD.md` §15                                 | Add the report type to the V1/V2 list with its org scope.                                    |
| `docs/guide/data-boundary.md`                     | New subsection under §1 or §5: what the audit reads, decrypts, and never stores.              |
| `SUMMARY.md`                                      | Flip **16.4** to ✅ + a DONE line in §0 and §6; M16 status line (16.4 is the last open slice).  |
| `.agents/research/weekly/TEMPLATE.md`             | One pointer line: which report fills the Capture-health block.                                |

### Relevant Documentation

Internal (authoritative here — read these before the external links):

- [`.agents/supplemental docs/research-analysis-plan.md`](../supplemental%20docs/research-analysis-plan.md)
  - **§4.4** (lines 141–159) — the six reconciliation checks. The worksheet is a literal transcription.
  - **§5.1** (lines 162–174) — the seven metrics, their formulas and targets, **and the
    record-unknowns-explicitly rule that closes it.**
  - **§5.3** (lines 188–193) — guardrails. _"No recommendation presented without its source metrics,
    data range, and confidence caveat."_ This is why every rendered row carries its window and its class.
  - **§7 P0.3 / P1.7** (lines 372–398) — the two acceptance criteria.
  - **§10** (lines 446–486) — the weekly scorecard the report's headline table must slot into.
- [`.agents/plans/m16-dogfood-instrumentation.md`](./m16-dogfood-instrumentation.md)
  - **D-M16-1** (lines ~133–157) — the FIXED observation set. Claude Code + Codex CLI only; the
    browser extension deliberately NOT run, precisely so the D1 `claude-live`/`claude-export` dedup
    gap cannot contaminate the duplicate-rate metric. **The report must state this scope**, or a
    reader takes "duplicate rate 0.2%" as a global claim.
  - **Risks 1–3** and the **pre-sign-off checklist** (the audit's numbers must reconcile against a
    hand-counted ten-session sample).
- [`.agents/plans/m16-slice3-capture-health-scorecard.md`](./m16-slice3-capture-health-scorecard.md)
  — D-16.3-4 (the liveness gate), D-16.3-7 (the collector owns error counts). Reused, not re-derived.
- [`docs/guide/data-boundary.md`](../../docs/guide/data-boundary.md) — §2 what is encrypted, §5 what
  can be exported. The recoverability check **decrypts**; the boundary doc must say so.

External (only where a repo pattern does not already answer it):

- [PostgreSQL — Aggregate Functions, `FILTER`](https://www.postgresql.org/docs/17/sql-expressions.html#SYNTAX-AGGREGATES)
  - _Why:_ every metric numerator uses `count(*) FILTER (WHERE …)`; the repo idiom is
    `connectorHealthWindowed`, which this mirrors.
- [PostgreSQL — `md5()`](https://www.postgresql.org/docs/17/functions-string.html)
  - _Why:_ `ORDER BY md5(session_id)` is the **deterministic** sample selector (D-16.4-5).
    `Math.random()` is unavailable/forbidden in a replayable artifact, and "most recent N" biases the
    sample toward the newest capture configuration.
- [Drizzle ORM — `sql` template & `sql.raw`](https://orm.drizzle.team/docs/sql)
  - _Why:_ CLAUDE.md's closed-set-keyword rule. **This slice has no closed-set keyword** (no
    `date_trunc` granularity), so nothing here needs `sql.raw` — noted so the executor does not add
    one defensively.

### Patterns to Follow

> **Spike-snippet fidelity:** every snippet below encodes an assertion from a spike that was
> **actually run during planning** (outputs in NOTES). The assertion is stated next to the snippet so
> drift is detectable. A transcribed snippet that contradicts its own spike is worse than no snippet.

**1. The three-state metric value — the heart of the slice.**

```ts
// packages/shared/src/data-quality.ts
/**
 * A metric is NEVER a bare number. §5.1 closes with "Record unknown values explicitly. Do not
 * substitute zero for absent data" — and the failure that rule prevents is not hypothetical: it is
 * exactly 16.3's healthy-looking zero, one layer up. `0 parse failures / 0 raw records` and
 * `0 / 4000` are opposite facts, and a bare `ratio` renders both as "100% ✅".
 */
export type MetricValue =
  /** A real ratio over a real, non-zero denominator across the whole window. */
  | { kind: "measured"; numerator: number; denominator: number; ratio: number }
  /** A real ratio, but over a bounded SAMPLE. `sampleSize` is rendered on the row. */
  | { kind: "sampled"; numerator: number; denominator: number; ratio: number; sampleSize: number }
  /** Not derivable from the archive. `reason` is rendered verbatim — never blank, never "0". */
  | { kind: "unknown"; reason: string };

/**
 * The ONLY constructor. A zero denominator yields `unknown`, not a 100% pass — this is the single
 * most important line in the module and the reason the constructor is not inlined at five call sites.
 */
export function ratioMetric(
  numerator: number,
  denominator: number,
  emptyReason: string,
  sampleSize?: number,
): MetricValue {
  if (denominator <= 0) return { kind: "unknown", reason: emptyReason };
  const ratio = numerator / denominator;
  return sampleSize === undefined
    ? { kind: "measured", numerator, denominator, ratio }
    : { kind: "sampled", numerator, denominator, ratio, sampleSize };
}
```

**2. Windowed aggregate reads — obey BOTH timestamp mechanisms.** _(Spike S4/B asserted:
`max(events.ts)` returns `"2026-08-02 09:00:00+00"` — Postgres text, NOT ISO. `raw.ingested_at` is a
plain timestamptz and arrives as a `Date`.)_

```ts
// packages/db/src/repositories/data-quality.ts
import { and, eq, gte, sql } from "drizzle-orm";
import { toIso } from "./sql-coerce.js";           // ONE definition — do not re-derive it.
import { events, rawSourceRecords } from "../schema.js";

/**
 * `events.ts` is `mode:"string"`, so an ISO string compares DIRECTLY (the connectorHealthWindowed
 * idiom, projections.ts:400) — no Date coercion. `rawSourceRecords.ingestedAt` is a PLAIN
 * timestamptz, so its window bound is a `Date`. Two columns, two mechanisms, ten lines apart:
 * the exact conflation CLAUDE.md records as the M5/M9 bug class.
 */
export async function sessionQualityRows(
  db: DbClient,
  orgId: string,          // ALWAYS the second parameter (D-15.2-4).
  sinceIso: string,
): Promise<SessionQualityRow[]> {
  const rows = await db
    .select({
      sessionId: events.sessionId,
      sourceConnector: events.sourceConnector,
      eventCount: sql<number>`count(${events.fingerprint})::int`,
      withTokens: sql<number>`count(*) filter (where ${events.tokens} is not null and ${events.model} is not null)::int`,
      firstTs: sql<string | null>`min(${events.ts})`,   // aggregate over mode:"string" → TEXT
      lastTs: sql<string | null>`max(${events.ts})`,    // ditto
    })
    .from(events)
    .where(and(eq(events.orgId, orgId), gte(events.ts, sinceIso)))
    // GROUP BY (session_id, source_connector) — NEVER session_id alone. `session_id` is a
    // connector-supplied, globally-scoped string (15.1/15.2); grouping on it alone merges a
    // collision and forces an aggregate over the connector, which is the 15.1 `min(org_id)` smell.
    .groupBy(events.sessionId, events.sourceConnector)
    .orderBy(events.sessionId, events.sourceConnector);

  return rows.map((r) => ({
    ...r,
    // MANDATORY. Aggregates over a `mode:"string"` column are Postgres text, not ISO.
    firstTs: toIso(r.firstTs),
    lastTs: toIso(r.lastTs),
  }));
}
```

**3. Duplicate rate — measured at the ONLY layer where duplicates still exist.** _(Spike C1
asserted, on a seeded fixture: `raw_rows=4, distinct_raw=3, duplicate_events=2, stored_events=3`.)_

```ts
/**
 * §5.1 defines this as "duplicate event fingerprints ÷ ingested events". IT CANNOT BE MEASURED ON
 * `events`: that table upserts by fingerprint, so every duplicate has ALREADY collapsed and a count
 * there is a structural zero — a metric that reports success because it is blind.
 *
 * It IS measurable one layer down. `raw_source_records` dedups per-MACHINE
 * (`ON CONFLICT (machine_id, source_connector, source_record_id) DO NOTHING`, ingest.ts:67), so two
 * machines shipping the same record leave TWO VISIBLE ROWS. And because
 * `fingerprint = sha256(source_connector | raw_record_id | event_index | event_type)`
 * (fingerprint.ts, and `session_id` is NOT an input), those two rows provably produced IDENTICAL
 * fingerprints. So the excess copies, times that record's event yield, IS the collapsed-duplicate
 * event count — exact, not a proxy.
 *
 * THE GROUPING KEY OMITS `session_id` ON PURPOSE (D-16.4-3): matching the fingerprint's actual
 * inputs. Adding it would under-count a real collision between two sessions sharing a record id.
 */
const duplicates = sql`
  with dup as (
    select source_connector, source_record_id, count(*)::int as copies
    from ${rawSourceRecords}
    where ${rawSourceRecords.orgId} = ${orgId} and ${rawSourceRecords.ingestedAt} >= ${sinceDate}
    group by source_connector, source_record_id
  ),
  ev as (
    select source_connector, raw_record_id, count(*)::int as n
    from ${events} where ${events.orgId} = ${orgId}
    group by source_connector, raw_record_id
  )
  select
    coalesce(sum((d.copies - 1) * coalesce(e.n, 0)), 0)::int as duplicate_events,
    coalesce(sum(coalesce(e.n, 0)), 0)::int                  as distinct_events
  from dup d
  left join ev e on e.source_connector = d.source_connector and e.raw_record_id = d.source_record_id`;
// ratio = duplicate_events / (distinct_events + duplicate_events)   -- i.e. ÷ INGESTED events.
```

**4. Parse success — the denominator is raw ROWS, never a join count.** _(Spike C5/S1 asserted:
`raw_rows=4, yielded=3`. Spike S1 also showed the trap — a raw⋈events join returns `r1` **twice**
when two machines hold it, so a naive `count(*)` over the join double-counts.)_

```ts
/**
 * `count(*) filter (where exists(...))`, NOT a join. Spike S1 measured the failure mode: the same
 * `source_record_id` held by two machines produces two raw rows, each joining to the same events —
 * a join-based denominator inflates and the ratio silently drifts.
 *
 * `events.raw_record_id` is the CONNECTOR's record id, the same namespace as
 * `raw_source_records.source_record_id` (spike S1 confirmed the join matches; reparse.ts:228-233
 * already treats them as one namespace). It is NOT the raw row's uuid.
 */
select count(*)::int as raw_rows,
       count(*) filter (where exists (
         select 1 from events e
         where e.org_id = r.org_id
           and e.source_connector = r.source_connector
           and e.raw_record_id = r.source_record_id
       ))::int as yielded_events
from raw_source_records r
where r.org_id = $orgId and r.ingested_at >= $since
```

**5. Attribution — the join needs `orgId` on BOTH sides.** _(Spike E asserted, with real
`workspace_keys`: `sessions=4, attributed=2`.)_

```ts
/**
 * CLAUDE.md 15.2, stated as a corollary that cost a slice to learn: "The org predicate on the FACT
 * table gives isolation, not ownership." `events.org_id` stops org A seeing org B's events; without
 * `workspaces.org_id` too, org B querying gets a rollup of ITS OWN events attributed to a project it
 * does not own. Both predicates, every time.
 *
 * AND THE NAME MATTERS: this is attribution COVERAGE (a project key resolves), never attribution
 * CORRECTNESS (the key resolves to the RIGHT project). §5.1's ≥90% target is about correctness, and
 * only §4.4's human check can answer it — so correctness ships as `unknown`, and the report says so
 * on the row rather than letting coverage quietly stand in for it (D-16.4-4).
 */
bool_or(exists (
  select 1 from workspace_keys wk
  join workspaces w on w.id = wk.workspace_id
  where wk.org_id = $orgId and w.org_id = $orgId and wk.project_key = e.project_path
)) as attributed
```

**6. Recoverability — a DRY RUN. It writes nothing.** _(Spike D asserted for Claude:
`storedEvents 10, reparsedEvents 10, missing 0, extra 0`. Spike E asserted for Codex:
`stored 18, reparsed 18, missing 0, extra 0`.)_

```ts
// packages/db/src/repositories/recoverability.ts
/**
 * §5.1's recoverability: "sampled raw records reparse successfully with EXPECTED OUTPUT". The
 * existing `reparseAll` (reparse.ts) is the WRITE engine — it upserts and GCs orphans. Running it to
 * measure would mutate the very archive under audit and make the metric a side effect of its own
 * measurement. So this is a read-only twin: same decrypt → reassemble → re-parse sequence, then a
 * SET COMPARISON of fingerprints against what is stored. No insert, no delete, no upsert.
 *
 * "Expected output" is defined as fingerprint-set EQUALITY, which is the strongest available claim:
 * the fingerprint is the dedup/idempotency key (PRD §12/§23), so if the re-parse reproduces the same
 * set, the archive's derived layer is fully re-derivable from its sacred raw records.
 *
 * SCOPE IS INHERITED, NOT RE-DECIDED (D-M13-2): Claude Code + Codex only. A Gemini session's raw
 * records cannot reconstruct the parser's whole-file input, and a custom connector has no shared
 * parser. Both are reported as `skipped` with their reason — NEVER counted as a failure, which would
 * be a fabricated defect, and never silently dropped, which would inflate the ratio.
 */
export interface RecoverabilityRow {
  sessionId: string;
  sourceConnector: string;
  machineId: string;
  storedEvents: number;
  reparsedEvents: number;
  missing: number;   // stored but not reproduced — the failure that matters
  extra: number;     // reproduced but not stored — a parser drift signal
  ok: boolean;       // missing === 0 && extra === 0
  skippedReason: "gemini" | "unsupported-connector" | "decrypt-error" | null;
}
```

**7. Route + orchestrator wiring — the D-15.3-6 seam.**

```ts
// apps/ingest/src/reports/generate-report-audit.ts
export async function generateDataQualityAuditReport(
  db: Db,                 // UNWRAPPED. insertReportArtifact re-opens a transaction per retry.
  orgId: string,
  role: string,
  userId: string,
  params: { windowDays: number; sampleSize: number },
  generatedAt: string,    // The ROUTE owns the clock. This module never reads it.
): Promise<ReportArtifactRow> {
  const nowMs = Date.parse(generatedAt);
  const sinceIso = new Date(nowMs - params.windowDays * 24 * 60 * 60 * 1000).toISOString();

  // Sequential inside the RLS transaction: a `tx` is ONE connection, so `Promise.all` here never
  // overlapped — node-postgres queues the queries and warns (deprecated, removed in pg@9).
  // See routes/monitor.ts for the full note.
  const inputs = await withOrg(db, orgId, role, async (tx) => ({
    sessions: await sessionQualityRows(tx, orgId, sinceIso),
    rawTotals: await rawRecordTotals(tx, orgId, sinceIso),
    duplicates: await duplicateRawRecords(tx, orgId, sinceIso),
    freshness: await ingestLagRows(tx, orgId, sinceIso),
    eligibility: await connectorTokenEligibility(tx, orgId),
    gitLinkage: await gitLinkageBuckets(tx, orgId, sinceIso),
    // 16.3's verdict, IMPORTED — never re-derived (D-16.4-2).
    machines: await machineStatuses(tx, orgId),
    declared: await declaredConnectorHealth(tx, orgId),
    observed: await observedConnectorAggregates(tx, orgId),
    sample: await reconciliationSample(tx, orgId, sinceIso, params.sampleSize),
  }));

  // The dry run needs its OWN withOrg: it decrypts, so it is deliberately a separate, bounded pass
  // over the sample rather than another read folded into the block above.
  const recoverability = await withOrg(db, orgId, role, (tx) =>
    reparseDryRun(tx, orgId, inputs.sample.map((s) => ({ sessionId: s.sessionId, ... }))),
  );

  const metrics = deriveDataQualityMetrics({ ...inputs, recoverability }, nowMs);
  const markdown = renderDataQualityAuditReport({ generatedAt, windowDays: params.windowDays, ...metrics });

  return insertReportArtifact(db, role, {
    orgId, userId,
    projectId: null,                       // org-scoped: no project FK, hence no existence check.
    reportType: "org.data_quality_audit",
    scopeKind: "org",                      // free-text column, no CHECK — verified by spike F.
    scopeId: orgId,
    reportVersion: AUDIT_REPORT_VERSION,   // "m16-audit-v1"
    catalogVersion: null,                  // no cost figures in this report
    analysisVersion: null,
    params,
    metrics,
    markdown,
  });
}
```

---

## Decisions

Recorded here so a later reader does not re-derive them wrongly.

### D-16.4-1 — An org-scoped artifact, not a new store

`report_artifacts` already carries `scopeKind` as **free text with no CHECK constraint**, `projectId`
as nullable, and a version series keyed on `(userId, reportType, scopeId, version)`. **Spike F proved
the whole write path end-to-end under the non-owner app role**: `scopeKind:"org"` + `projectId:null`
inserted cleanly, versions bumped 1→2→3, `org_id` stayed off the returned row, a `viewer` was
correctly blocked by `report_artifacts_role_write_ins`, and `indexReportDoc` handled the null
`projectId`/`sessionId`. So this slice needs **no migration**, and the audit inherits — free — report
listing, the version-history compare view, redacted Markdown/JSON export, and the search index.

_Consequence:_ generation gates at **`member`**, exactly like every other report route, and that is
not a taste call — spike F measured a `viewer` insert failing with `new row violates row-level
security policy "report_artifacts_role_write_ins"`. Gating at `viewer` would produce a 500, not a
403.

### D-16.4-2 — The connector verdict is IMPORTED from 16.3, never re-derived

The §10 scorecard's "Stale/unhealthy connectors" row is filled by calling `deriveCaptureHealth` and
counting `CAPTURE_HEALTH_VERDICT` buckets. 16.3's own header states the intent — _"16.4 reuses the
verdict rather than deriving a second, disagreeing one"_ — and the milestone's D-16.3-1 erratum spells
out the failure it prevents: **two independently-derived numbers on one screen is the "which number do
I believe?" problem this milestone exists to remove.**

The report therefore stamps **both** `CAPTURE_HEALTH_VERSION` and `AUDIT_REPORT_VERSION` in its
metrics, so a future reader can tell which derivation produced the connector counts.

### D-16.4-3 — Duplicate rate is measured on `raw_source_records`, and the grouping key omits `session_id`

Two independent reasons, either sufficient:

1. **`events` cannot see duplicates.** It upserts by fingerprint; a duplicate has already collapsed
   before any query runs. A count there is structurally zero — success by blindness.
2. **The grouping key must match the fingerprint's actual inputs.** `fingerprint = sha256(connector |
rawRecordId | eventIndex | eventType)` — `session_id` is **not** an input. Grouping duplicates by
   `(connector, source_record_id, session_id)` would therefore miss a genuine collision between two
   sessions sharing a record id, which is exactly the case worth catching.

**Stated caveat, rendered in the report (§5.3 requires it):** this counts duplicates **visible as
redundant raw rows**. It does **not** see duplicates the collector suppressed at its queue cursor
before upload, and it does **not** see the D1 `claude-live` vs `claude-export` cross-connector gap
(different connector ⇒ different fingerprint ⇒ two legitimate-looking sessions). D-M16-1 keeps the
extension switched off during Phase 1 precisely so that gap cannot contaminate this metric — the
report says so on the row rather than leaving the reader to know it.

### D-16.4-4 — Coverage and correctness are DIFFERENT metrics, and only one is derivable

§5.1 asks for _"sessions with **correct** project/workspace attribution"_. The archive can answer
"does `project_path` resolve to a `workspace_key`" (**coverage**); it cannot answer "does it resolve
to the **right** project" (**correctness**), because the ground truth is what the operator believes
the session was about.

Shipping coverage under the label "Project attribution" would be the milestone's Risk 2 in one line:
the instrument grading itself with the easier question. So the report renders **two rows** —
coverage as `measured`, correctness as `unknown` with the reason and a pointer to the worksheet row
that answers it. Same treatment for **capture coverage**, whose denominator (_tool-native sessions_)
does not exist inside the product at all.

### D-16.4-5 — The reconciliation sample is DETERMINISTIC, and it is `md5(session_id)`

Three candidates were considered:

- **Random** — `Math.random()` makes the artifact unreproducible, and a versioned report artifact
  whose sample cannot be re-derived defeats the point of §23 replay metadata.
- **Most recent N** — biases every sample toward the newest capture configuration, which is the one
  least likely to be broken. The metric would systematically miss the regressions it exists to find.
- **`ORDER BY md5(session_id) LIMIT N`** — a stable pseudo-random spread, deterministic in Postgres,
  reproducible from the artifact, and unbiased with respect to time. **Chosen.**

The selected session ids are stored in `metrics.reconciliation.sample`, so a hand-count four weeks
later audits the same ten sessions the report did.

### D-16.4-6 — Recoverability is a read-only twin of the re-parse engine, not a call to it

`reparseAll` upserts events and deletes orphans. Calling it to *measure* recoverability would mutate
the archive under audit — the measurement would change its own subject, and a "100% recoverable"
result would partly be an artifact of the re-parse having just run. `reparseDryRun` performs the
identical decrypt → reassemble → re-parse sequence and then only **compares fingerprint sets**.

To avoid a second, drifting copy of the reassembly logic, `reassembleCodex` and `reassembleClaude`
gain an `export` keyword and nothing else. One implementation, two callers — a duplicated reassembler
would silently diverge from the write engine and make the metric measure the copy rather than the
product.

### D-16.4-7 — One button on the existing Reports page; no new dashboard section

The milestone's non-goals name _"new dashboard sections that do not improve capture quality"_, and the
16.4 roadmap row says _"as a report artifact … rather than a new surface"_. Both are honoured: the
artifact appears in the existing Reports list with **zero changes** to it (verified —
`reports-view.tsx:89` renders `r.reportType` generically, with no type filter to update), and the
only addition is one generate button on that same page.

A button is included rather than omitted because without it the sole operator's only trigger is
`curl` or cron, and a §7 P0.3 acceptance criterion phrased as _"queryable rather than manually
guessed"_ is not met by a report nobody can run.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation (pure, no database)

Types and the pure derivation, testable with zero infrastructure. This is where the honesty rules
live, so it goes first and is unit-tested before anything queries a database.

**Tasks:** the `MetricValue` union + `ratioMetric` constructor; `deriveDataQualityMetrics`; the
renderer; the shared barrel exports.

### Phase 2: Core Implementation (database reads)

The five windowed aggregates and the dry-run re-parse, each with a two-role integration suite.

### Phase 3: Integration (orchestrator, route, dashboard, cron)

Wire the pure layer to the data layer through the M7 pipeline, expose one route, one proxy, one
button, and the `--audit` cron flag.

### Phase 4: Testing, docs & the gate

HTTP-level integration through `buildApp`, the app-role behavioural test (the real coverage proof —
the structural grep is only a first net), docs, and `repo-health -- --require-db`.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Each task is atomic and independently validatable.

> Run every `npx vitest run <path>` **from the repo root**. Workspaces have no `test` script
> (`npm test -w <pkg>` fails with `Missing script: "test"`).

---

### 1. CREATE `packages/shared/src/data-quality.ts`

- **IMPLEMENT**: `DATA_QUALITY_VERSION = "m16-data-quality-v1"`; the `MetricValue` union and
  `ratioMetric` constructor (Pattern 1 above, verbatim); the input row interfaces
  (`SessionQualityRow`, `RawRecordTotals`, `DuplicateTotals`, `IngestLagRow`,
  `ConnectorTokenEligibility`, `GitLinkageBuckets`, `ReconciliationSampleRow`,
  `RecoverabilityRow`); the output `DataQualityMetrics`; and the pure
  `deriveDataQualityMetrics(inputs, nowMs)`.
- **PATTERN**: `packages/shared/src/capture-health.ts` — same file shape, same comment density, same
  clock-injection contract. `CAPTURE_HEALTH_VERDICT` (capture-health.ts:86) is the model for a
  frozen, exported mapping the UI cannot re-decide.
- **IMPORTS**: type-only, from `./capture-health.js` (`CaptureHealthRow`, `CaptureHealthVerdict`),
  `./control-protocol.js` (`ConnectorInfo`), `./cost.js` (`CostConfidence`). **No runtime imports, no
  `new Date()`, no I/O** — `@420ai/shared` is dependency-free.
- **GOTCHA**: the whole point of this file is that `denominator === 0` yields `unknown`, not a
  passing ratio. If you find yourself writing `denominator === 0 ? 1 : n / d`, stop — that is the
  healthy-looking zero 16.3 shipped a fix for.
- **GOTCHA**: `TOKEN_ELIGIBLE` is `tokens !== "none"` from `ConnectorInfo["tokens"]`. A connector with
  **no declaration at all** (a pre-16.3 collector) is neither eligible nor ineligible — its sessions
  go to a third bucket rendered as `unknown`, mirroring 16.3's `unreported`. Do not default it to
  eligible (inflates the denominator) or ineligible (inflates the ratio).
- **VALIDATE**: `npx tsc -b` (exit 0)

### 2. CREATE `packages/shared/src/data-quality.test.ts`

- **IMPLEMENT**: unit tests covering, at minimum —
  1. `ratioMetric(0, 0, "…")` → `{kind:"unknown"}`, **explicitly asserting it is NOT a 1.0 ratio**;
  2. `ratioMetric(0, 4000, "…")` → `{kind:"measured", ratio:0}` — the opposite fact, distinct;
  3. every §5.1 metric present in the output, with capture-coverage and attribution-correctness
     always `unknown` and their `reason` non-empty;
  4. token completeness excludes ineligible connectors from the denominator AND routes
     undeclared-connector sessions to the `unknown` bucket;
  5. the capture-health roll-up counts match `CAPTURE_HEALTH_VERDICT` buckets for a hand-built row set;
  6. git linkage: a session with both a `confirmed` and a `suggested` link counts **once**, as
     `confirmed` (confirmed outranks heuristic);
  7. a `rejected`-only link counts as **no linkage**, not heuristic.
- **PATTERN**: `packages/shared/src/capture-health.test.ts`.
- **VALIDATE**: `npx vitest run packages/shared/src/data-quality.test.ts`

### 3. CREATE `packages/shared/src/reports-audit.ts`

- **IMPLEMENT**: `AUDIT_REPORT_VERSION = "m16-audit-v1"` and
  `renderDataQualityAuditReport(input): string`, emitting in order:
  1. header bullets — generated at, window (`YYYY-MM-DD → YYYY-MM-DD`), sessions in window, the
     `DATA_QUALITY_VERSION` + `CAPTURE_HEALTH_VERSION` stamps;
  2. **`## §5.1 Data quality`** — the seven-row table, columns
     `| metric | value | target | basis | notes |`, where `basis` is `measured` / `sampled (n=N)` /
     `unknown`. An `unknown` row renders its **reason** in `value`, never `—`, never `0%`;
  3. `## Capture health (from 16.3)` — verdict counts + the per-connector state table;
  4. `## Git outcome confidence (§7 P1.7)` — the three buckets **and** the mandatory prose line:
     _"A heuristic link is a time/file-overlap correlation, not evidence of causation."_;
  5. `## §4.4 Reconciliation worksheet` — the N sampled sessions, with checks 2/3/5/6 pre-filled and
     checks 1/4 as literal `( )` blanks for the human;
  6. `## Scope and caveats` — D-M16-1's fixed observation set, the duplicate-rate caveat (D-16.4-3),
     and the coverage-vs-correctness distinction (D-16.4-4);
  7. one illustrative Mermaid `pie showData` of the capture-health verdicts, **preceded by the
     `<!-- tables above are the source of truth -->` comment** the other renderers carry.
- **PATTERN**: `packages/shared/src/reports.ts:262–321` (`renderFailedToolCallsReport`) — bullets,
  tables, one Mermaid block, empty-state italic lines.
- **GOTCHA**: pure and clock-free — `generatedAt` is caller-injected. Never call `new Date()`.
- **GOTCHA**: an empty section renders an italic `_No …_` line (see reports.ts:302, 316, 345) — never
  an empty table body and never a silently omitted heading.
- **VALIDATE**: `npx tsc -b`

### 4. CREATE `packages/shared/src/reports-audit.test.ts` + UPDATE `packages/shared/src/index.ts` and `reports.ts`

- **IMPLEMENT**: renderer tests asserting an `unknown` metric renders its reason (and the string
  `"0%"` appears **nowhere** on that row); the git-confidence caveat sentence is present; the
  worksheet has exactly N rows with two unfilled human checks each. Then export `./data-quality.js`
  and `./reports-audit.js` from `packages/shared/src/index.ts`, and add
  `| "org.data_quality_audit"` to the `ReportType` union in `reports.ts:33–42` **only** — the M7/M13
  renderers are untouched.
- **PATTERN**: the barrel's existing export block; `REPORT_VERSION_M13`'s doc comment (reports.ts:51–57)
  explains why a new milestone gets its own version lineage rather than bumping an old one.
- **VALIDATE**: `npx vitest run packages/shared/src/reports-audit.test.ts && npx tsc -b`

### 5. UPDATE `packages/db/src/repositories/reparse.ts` — export the two reassemblers

- **IMPLEMENT**: add `export` to `reassembleCodex` (line 72) and `reassembleClaude` (line 104).
  **Change nothing else in this file** — no signature, no body, no behaviour.
- **PATTERN**: n/a (a visibility change).
- **GOTCHA**: do **not** copy these into the new file. A duplicated reassembler drifts from the write
  engine and makes recoverability measure the copy rather than the product (D-16.4-6).
- **VALIDATE**: `npx tsc -b && npx vitest run packages/db/src/repositories/reparse` (existing re-parse
  tests unchanged and green)

### 6. CREATE `packages/db/src/repositories/data-quality.ts`

- **IMPLEMENT**: six exported reads, each `(db: DbClient, orgId: string, …)`:
  `sessionQualityRows`, `rawRecordTotals`, `duplicateRawRecords`, `ingestLagRows`,
  `connectorTokenEligibility`, `gitLinkageBuckets`, plus `reconciliationSample`.
- **PATTERN**: `packages/db/src/repositories/capture-health.ts` — header comment naming the two
  timestamp mechanisms, explicit column constants, `orgId` always second.
- **IMPORTS**: `{ and, eq, gte, sql }` from `drizzle-orm`; `toIso` from `./sql-coerce.js`;
  `{ events, rawSourceRecords, machineConnectors, sessionGitLinks, workspaceKeys, workspaces,
searchDocuments }` from `../schema.js`; types from `@420ai/shared`.
- **GOTCHA (the M5/M9 bug class)**: `min(ts)`/`max(ts)` over the `mode:"string"` `events.ts` return
  **Postgres text**, not ISO — spike S4 measured `"2026-08-02 09:00:00+00"`. Every one goes through
  `toIso`. `rawSourceRecords.ingestedAt` is a **plain** timestamptz and arrives as a `Date` — a
  different mechanism; `toIso` is not what you want there.
- **GOTCHA**: `::int` every count (node-postgres returns bare `numeric` as a **string**).
- **GOTCHA**: `GROUP BY (session_id, source_connector)`, never `session_id` alone (15.1/15.2 —
  connector-supplied, globally-scoped strings).
- **GOTCHA**: the attribution join needs **both** `workspaceKeys.orgId` and `workspaces.orgId` — the
  fact-table predicate alone gives isolation, not ownership.
- **GOTCHA**: `reconciliationSample` orders by `md5(session_id)` (D-16.4-5). `md5(...)` is a plain
  function call over a column, **not** a closed-set keyword — it needs no `sql.raw`, and adding one
  would be wrong.
- **GOTCHA**: no returned row may carry `org_id` — no ingest route declares a Fastify `response`
  schema, so a bare `select()` puts every future column on the wire (15.1).
- **VALIDATE**: `npx tsc -b`

### 7. CREATE `packages/db/src/repositories/data-quality.int.test.ts` — TWO-ROLE

- **IMPLEMENT**: mirror `capture-health.int.test.ts` exactly.
  - **Test 1 is the role-identity assertion** (`current_setting('is_superuser') = 'off'` AND
    `rolbypassrls = false` for `DATABASE_URL_TEST_APP`). Without it the whole file is theatre.
  - `owner` (`DATABASE_URL_TEST`) for `TRUNCATE` + seeding only; **`appRole`
    (`DATABASE_URL_TEST_APP`) for every assertion.**
  - Cover: parse success with a raw record that yielded no events; the **cross-machine duplicate**
    (the same `(connector, source_record_id)` on two machines); token eligibility across an `exact`
    and a `none` connector plus one undeclared; attribution with real `workspace_keys`; window
    exclusion (a row just outside `sinceIso` is absent); `reconciliationSample` returning the **same
    ids on two consecutive calls** (determinism).
- **PATTERN**: `capture-health.int.test.ts:1–80` (the header block explains why the split exists).
- **GOTCHA**: `workspaces` requires `userId`; `workspace_keys` requires `userId` **and**
  `sourceConnector` — both are `NOT NULL` and both bit the planning spikes (`23502`). Seed them.
- **GOTCHA**: `describe.skipIf(!process.env.DATABASE_URL_TEST)` — the file must self-skip cleanly.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/data-quality.int.test.ts` (with the DB up;
  **0 skipped**)

### 8. CREATE `packages/db/src/repositories/recoverability.ts`

- **IMPLEMENT**: `reparseDryRun(db, orgId, targets, opts?) : Promise<RecoverabilityRow[]>`.
  Per target: select the session's raw rows (ordered by `ingestedAt`, scoped by
  `orgId`+`sessionId`+`sourceConnector`+`machineId`) → `decryptField` → `reassembleCodex` /
  `reassembleClaude` → `parseCodexSession` / `parseClaudeCodeSession` with
  `{ ingestedAt: rawRows[0].ingestedAt.toISOString() }` → compare the fresh fingerprint set against
  the stored one. Gemini → `skippedReason: "gemini"`; any other connector →
  `"unsupported-connector"`.
- **PATTERN**: `reparse.ts:173–212` — the identical read/decrypt/reassemble/parse sequence, minus
  every write.
- **IMPORTS**: `{ decryptField }` from `../crypto.js`; `{ reassembleClaude, reassembleCodex }` from
  `./reparse.js`; `{ parseClaudeCodeSession, parseCodexSession, CLAUDE_CODE_CONNECTOR,
CODEX_CLI_CONNECTOR, GEMINI_CLI_CONNECTOR }` from `@420ai/shared`.
- **GOTCHA**: **no `insert`, no `update`, no `delete` in this file.** That is the entire contract.
- **GOTCHA**: the deterministic `ingestedAt` must be the session's **earliest stored ingest time**, not
  `now` — a re-parse must not stamp today onto old events, and a different value changes the parser's
  fallbacks and therefore the fingerprints (reparse.ts:200–202).
- **GOTCHA**: a `decryptField` failure must become `skippedReason: "decrypt-error"` on that row, not a
  thrown request. A bounded audit over a sample is exactly the place where one bad row must not take
  the report down — and this is the ONE deviation from the silent-library rule in this slice, so say
  so in the comment.
- **VALIDATE**: `npx tsc -b`

### 9. CREATE `packages/db/src/repositories/recoverability.int.test.ts` — TWO-ROLE

- **IMPLEMENT**: role-identity test first, then:
  1. **Claude round-trip** — ingest `packages/shared/src/parsers/fixtures/sample-session.jsonl`
     through `parseClaudeCodeSession` + `ingestBatch`, then assert the dry run reports
     `missing === 0 && extra === 0 && ok === true`. _(Spike D measured exactly this: 10 stored, 10
     reparsed, 0/0.)_
  2. **Codex round-trip** — same with `fixtures/sample-codex-rollout.jsonl`. _(Spike E: 18/18, 0/0.)_
  3. **It writes nothing** — snapshot `count(*)` of `events` **and** `raw_source_records` before and
     after; assert both unchanged. This is the test that would catch someone "optimising" the dry run
     into a call to `reparseAll`.
  4. **Gemini is skipped, not failed** — `skippedReason === "gemini"`, and it is excluded from the
     recoverability denominator rather than counted as a failure.
- **PATTERN**: `capture-health.int.test.ts`; `apps/ingest/src/reports/reports-m13.int.test.ts` for
  fixture ingestion.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/recoverability.int.test.ts`

### 10. UPDATE `packages/db/src/index.ts`

- **IMPLEMENT**: export every new repository function + its row types, in the existing commented
  block style (`// M16 16.4: …`).
- **VALIDATE**: `npx tsc -b`

### 11. CREATE `apps/ingest/src/reports/generate-report-audit.ts` + UPDATE `apps/ingest/src/schemas.ts`

- **IMPLEMENT**: `generateDataQualityAuditReport` per Pattern 7. Add to `schemas.ts`:

  ```ts
  /** POST body for the org-scoped data-quality audit (M16 16.4). Both fields optional. */
  export const dataQualityAuditBodySchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      windowDays: { type: "integer", minimum: 1, maximum: 365 },
      sampleSize: { type: "integer", minimum: 1, maximum: 50 },
    },
  } as const;
  ```

- **PATTERN**: `apps/ingest/src/reports/generate-report-m13.ts` (structure) and
  `apps/ingest/src/schemas.ts:303–320` (schema style).
- **GOTCHA**: pass `app.db` **UNWRAPPED** to `insertReportArtifact` (D-15.3-6 — it re-opens a
  transaction per retry attempt; a `Tx` is a compile error and forcing past it reintroduces
  `current transaction is aborted`). Wrap only the **reads** in `withOrg`.
- **GOTCHA**: reads inside one `withOrg` run **sequentially** — a `tx` is one connection.
- **GOTCHA**: defaults are `windowDays: 7` (the §10 weekly scorecard) and `sampleSize: 10` (§4.4's
  ten sessions per month). Store both in `params` so the artifact is self-describing.
- **VALIDATE**: `npx tsc -b`

### 12. CREATE `apps/ingest/src/routes/data-quality.ts` + UPDATE `apps/ingest/src/app.ts`

- **IMPLEMENT**: `POST /v1/audit/data-quality` — `resolvePrincipal` → 401; `authorized(principal,
"member")` → 403; **the route owns the clock** (`new Date().toISOString()`); call the orchestrator;
  best-effort `indexReportDoc` inside `try/catch` with `request.log.warn`; `reply.code(201).send(row)`.
  Register in `app.ts` beside `captureHealthRoutes`.
- **PATTERN**: `apps/ingest/src/routes/capture-health.ts` (header discipline, clock ownership) +
  `apps/ingest/src/routes/reports.ts:148–157` (the `indexReportDoc` swallow).
- **GOTCHA**: gate at **`member`**, not `viewer`. This is a WRITE, and spike F measured a `viewer`
  insert failing with `new row violates row-level security policy "report_artifacts_role_write_ins"` —
  a `viewer` gate would return 500 instead of 403.
- **GOTCHA**: **no existence check is needed and none should be added.** The
  "unknown-id → 404, never a DB-constraint 500" rule exists because a report row FKs to
  `projects.id`; this artifact sets `projectId: null` and takes its `scopeId` from the authenticated
  principal's org, so there is no unvalidated id to screen.
- **GOTCHA**: `principal.role`, **not** `SERVICE_ROLE`. The 15.4 test is "whose action is this?" — an
  operator generating their own audit is the caller's action, unlike `monitor.ts`'s evaluate-on-read
  reconcile, which is the org's bookkeeping.
- **VALIDATE**: `npx tsc -b && npx vitest run apps/ingest/src/routes/org-scoping.test.ts` (the new file
  must pass the structural grep without an allow-list entry)

### 13. CREATE `apps/ingest/src/reports/reports-audit.int.test.ts`

- **IMPLEMENT**: HTTP-level through `buildApp`:
  1. `POST /v1/audit/data-quality` → **201**, `reportType === "org.data_quality_audit"`,
     `scopeKind === "org"`, `projectId === null`, `version === 1`; a second POST → `version === 2`.
  2. The artifact appears in `GET /v1/reports?type=org.data_quality_audit` and is fetchable by id.
  3. `GET /v1/reports/:id/export?format=md` returns the Markdown (proving the M12 export path is
     inherited for free).
  4. **`viewer` → 403** (and specifically *not* 500 — assert the status code, since that is the
     distinction spike F measured).
  5. **The honesty assertion:** on an org with **zero** events, capture coverage, attribution
     correctness **and** parse success all render `unknown`, and the Markdown contains **no** `100%`.
     This is the regression test for the healthy-looking zero and is the most important test in the file.
  6. `metrics` round-trips through jsonb unchanged (the replay/compare seam).
- **PATTERN**: `apps/ingest/src/reports/reports-m13.int.test.ts`.
- **VALIDATE**: `npx vitest run apps/ingest/src/reports/reports-audit.int.test.ts`

### 14. UPDATE `apps/ingest/src/rls.int.test.ts` — the behavioural app-role proof

- **IMPLEMENT**: one test that generates the audit **connected as the non-owner app role** and asserts
  the metrics are **non-empty and non-zero** for seeded data.
- **PATTERN**: `rls.int.test.ts` test 9 (the alert-delivery behavioural test).
- **GOTCHA**: this is the test that matters. `org-scoping.test.ts` is file-granular — one `withOrg(`
  anywhere exempts the whole file — and CLAUDE.md records the exact failure it missed
  (`deliverPendingFirings` read zero rows silently and every webhook stopped, with every
  owner-connected test still green). An audit report is **especially** vulnerable: under a missing
  org context every count returns 0, and 0 is a *plausible-looking* audit result. Assert the side
  effect actually happened.
- **VALIDATE**: `npx vitest run apps/ingest/src/rls.int.test.ts`

### 15. CREATE the dashboard proxy + button; UPDATE `reports-view.tsx`

- **IMPLEMENT**:
  - `apps/dashboard/src/app/api/audit/data-quality/route.ts` — `export const dynamic =
"force-dynamic"`, `POST` forwarding the body verbatim through `proxyJson`.
  - `apps/dashboard/src/components/reports/audit-actions.tsx` — a `"use client"` island with a window
    select (`7` / `30` days) and one **Generate audit** button.
  - Mount it in the `Artifacts` card header of `reports-view.tsx`; widen the page subtitle to mention
    the audit.
- **PATTERN**: `apps/dashboard/src/app/api/projects/[id]/reports/route.ts` and
  `project-report-actions.tsx` (verbatim mutation discipline).
- **GOTCHA**: **check `res.ok`** — `fetch` resolves on 4xx/5xx. Map 403 → `FORBIDDEN_MESSAGE`
  (`@/lib/mutation-error`). Disable in-flight (generation is non-idempotent: each POST appends a
  version). `router.refresh()` on success.
- **GOTCHA**: never import from `@/lib/proxy` in a `"use client"` file — only Route Handlers may.
- **VALIDATE**: `npm run typecheck:dashboard && npm run build:dashboard` — **both**. The root `tsc -b`
  will NEVER catch a dashboard type error (the workspace is deliberately outside its graph), and
  `next build` is what catches theGridCN barrel breakage.

### 16. UPDATE `scripts/generate-reports.mjs` — the `--audit` flag

- **IMPLEMENT**: `--audit` (boolean) POSTs `/v1/audit/data-quality` once, org-wide, and returns
  without iterating projects. Extend `parseArgs`; keep `PROJECT_REPORT_TYPES` and
  `resolveReportTypes` **unchanged** (the audit is org-scoped, not a project type — putting it in
  that list would make `--types all` POST it once per project).
- **PATTERN**: the existing `parseArgs`/POST loop (lines 42–160).
- **GOTCHA**: an unknown flag throws today — keep that. Add `--audit` to the usage comment at the top.
- **GOTCHA**: any new env read uses `||`, not `??` — `.env.example` ships keys with **empty** values,
  so `??` yields `""` and the fallback silently fails for the operator it was written for.
- **VALIDATE**: `npx vitest run scripts` (if a test exists) and
  `node scripts/generate-reports.mjs --help` / a deliberate bad flag → non-zero exit

### 17. UPDATE the docs

- **IMPLEMENT**:
  - `docs/PRD.md` §15 — add `data-quality audit (org-scoped)` to the report-type list.
  - `docs/guide/data-boundary.md` — a subsection stating that the audit reads **plaintext metadata
    only** for six of seven metrics, that **recoverability decrypts a bounded sample server-side**,
    and that **no decrypted content is stored in, or rendered into, the artifact** — only fingerprint
    counts. This is a §7 P0.4 surface (a design partner reads it before pairing).
  - `.agents/research/weekly/TEMPLATE.md` — one line under "Capture health": which report fills this
    block and how to generate it.
- **GOTCHA**: CI runs `prettier --check` over `.md` but local `repo-health` does **not**. Run
  `npm run format` before pushing.
- **VALIDATE**: `npm run format:check`

### 18. UPDATE `SUMMARY.md` and run the full gate

- **IMPLEMENT**: flip **16.4** to ✅ with `DONE <date> (PR #NN)` in **both** §0 and §6, and update the
  M16 status line — 16.4 is the last open slice.
- **GOTCHA (milestone Risk 4)**: `scripts/check-summary.mjs` needs the ✅ within 4 characters of the
  `**16.4**` token. Declaring `**M16 …** is **DONE**` would *disable* per-slice checking — only write
  that once every slice is genuinely marked.
- **VALIDATE**: `npm run repo-health -- --require-db` — **green, 0 skipped**.

---

## TESTING STRATEGY

### Unit Tests (no infrastructure — always run)

`packages/shared/src/data-quality.test.ts` and `reports-audit.test.ts`. Every classification and
every rendering decision is unit-testable **because the derivation is pure and clock-injected** —
that is the reason for the shared/db split, not an incidental benefit. The zero-denominator branch
gets its own named test.

### Integration Tests (`*.int.test.ts`, self-skip without `DATABASE_URL_TEST`)

Four suites: the two repository two-role suites (Tasks 7, 9), the HTTP suite (Task 13), and the
app-role behavioural addition to `rls.int.test.ts` (Task 14).

**`bypassed ≠ enforced`.** Both repository suites use the owner handle for `TRUNCATE`/seed **only**
and the `420ai_app` handle for every assertion, with the role-identity assertion as test 1. Point the
"app" handle at the owner URL by mistake and, without that first test, every isolation test still
passes while proving nothing.

### Edge Cases (each must have a named test)

| Case                                                          | Expected                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Empty org / empty window                                       | Every ratio `unknown` with a reason. **`100%` appears nowhere in the Markdown.** |
| One raw record, zero events                                    | Parse success `1/2`, not `unknown` and not `100%`                                |
| Same `(connector, source_record_id)` on two machines           | Counted as a duplicate; the parse-success denominator **does not** double-count  |
| A connector declaring `tokens:"none"`                          | Excluded from the token-completeness denominator entirely                        |
| A connector with **no** declaration (pre-16.3 collector)       | Third bucket → `unknown`; neither eligible nor ineligible                        |
| Gemini session in the recoverability sample                    | `skipped`, excluded from the denominator — **never** counted as a failure         |
| Undecryptable raw record                                       | That row → `decrypt-error`; the report still generates                            |
| A session with both `confirmed` and `suggested` git links      | Counted **once**, as `confirmed`                                                  |
| A session with only a `rejected` link                          | **No linkage**, not heuristic                                                     |
| `sampleSize` > sessions available                              | Sample = all of them; `sampleSize` on the row reflects the **actual** count       |
| Two consecutive generations                                    | `version` 1 then 2; the same `md5`-ordered sample ids                            |
| `viewer` POSTs the audit                                       | **403**, not 500 (spike-F-measured distinction)                                   |
| Generation under the **non-owner app role** with seeded data   | Non-empty, non-zero metrics (Task 14)                                            |

---

## VALIDATION COMMANDS

All runnable from the **repo root**. Every level is a gate with a stated pass signal.

### Level 1: Syntax & Style

```bash
npm run typecheck          # root `tsc -b` — MUST exit 0 (per-workspace build is NOT a substitute)
npm run typecheck:dashboard # the dashboard is outside the root graph — its own enforced lane
npm run lint               # ESLint — NOT part of repo-health; CI runs it
npm run format:check       # CI lints .md with prettier; local repo-health does not
```

### Level 2: Unit Tests

```bash
npx vitest run packages/shared/src/data-quality.test.ts packages/shared/src/reports-audit.test.ts
# Pass: all tests green, 0 skipped.
```

### Level 3: Integration Tests

```bash
npm run db:up && npm run db:migrate     # migrate 420ai_test separately if it lags
npx vitest run packages/db/src/repositories/data-quality.int.test.ts \
               packages/db/src/repositories/recoverability.int.test.ts \
               apps/ingest/src/reports/reports-audit.int.test.ts \
               apps/ingest/src/rls.int.test.ts
# Pass: all green with **0 skipped**. A skipped int suite still reports green — `skipped ≠ passed`.
```

### Level 4: Manual Validation

```bash
# 1. Generate a weekly audit (member API key).
curl.exe -s -X POST http://localhost:3001/v1/audit/data-quality \
  -H "authorization: Bearer $API_KEY" -H "content-type: application/json" \
  --data-binary "@body.json"        # body.json: {"windowDays":7,"sampleSize":10}
# Expect 201 with reportType "org.data_quality_audit", scopeKind "org", version 1.
# (PowerShell: use curl.exe + a FILE body — bare `curl` is an alias and `\"` escaping breaks.)

# 2. Read the Markdown back.
curl.exe -s "http://localhost:3001/v1/reports/<id>/export?format=md" -H "authorization: Bearer $API_KEY"

# 3. THE ACCEPTANCE CHECK (§7 P0.3 + pre-sign-off): hand-count the ten worksheet sessions against
#    the tool-native files under ~/.claude/projects and ~/.codex/sessions. Every derived cell must
#    match. Log mismatches in .agents/research/incidents.md, categorized per §4.4.

# 4. Dashboard: Reports page → "Generate audit" → the new artifact appears at the top of the list
#    and renders. Confirm the ADMIN_TOKEN/session token appears 0 times in the served HTML.
```

### Level 5: The Gate

```bash
npm run repo-health -- --require-db
# Pass: exit 0, and the int layer ACTUALLY RAN (0 skipped). A plain `repo-health` PASS does NOT
# prove the DB-backed layer executed — this slice touches @420ai/db and apps/ingest, so
# --require-db is mandatory before sign-off.
```

---

## ACCEPTANCE CRITERIA

- [ ] **§7 P0.3 acceptance met**: every §5.1 scorecard value is queryable — the seven rows appear in
      one generated artifact, none hand-guessed.
- [ ] **§7 P1.7 acceptance met**: git linkage is split into confirmed / heuristic / none, and the
      report states in prose that a heuristic link is not causal evidence.
- [ ] **No metric renders a bare number.** Every row carries `measured` / `sampled (n=N)` / `unknown`,
      and every `unknown` carries a non-empty reason.
- [ ] **A zero denominator renders `unknown`, never `100%`** — pinned by a named unit test and by the
      empty-org HTTP test asserting `100%` appears nowhere.
- [ ] The connector verdict counts are **imported from `deriveCaptureHealth`**, not re-derived
      (D-16.4-2); both version stamps appear in `metrics`.
- [ ] Recoverability is a **dry run**: `events` and `raw_source_records` counts are provably unchanged
      across it.
- [ ] The §4.4 worksheet lists N deterministically-sampled sessions; two consecutive generations over
      the same window select the **same** ids.
- [ ] **No migration, no new table, no new dashboard page.**
- [ ] Both repository suites are **two-role**, each with the role-identity assertion as test 1.
- [ ] `rls.int.test.ts` carries a **behavioural** app-role test proving the audit returns real data
      (not a silent all-zero read).
- [ ] `viewer` → **403**; `member` → **201**.
- [ ] The artifact lists, reads, compares and exports through the existing M12 endpoints with no
      changes to them.
- [ ] The scope caveats (D-M16-1's fixed observation set; the duplicate-rate blind spots;
      coverage ≠ correctness) are rendered **in the report**, not only in this plan.
- [ ] `docs/guide/data-boundary.md` states that recoverability decrypts a bounded sample and stores
      no decrypted content.
- [ ] `npm run repo-health -- --require-db` green, **0 skipped**; `npm run lint` and
      `npm run format:check` green; `npm run build:dashboard` green.
- [ ] `SUMMARY.md` flips **16.4** to ✅ in §0 and §6 **in the same commit** as the execution report.

---

## COMPLETION CHECKLIST

- [ ] All 18 tasks completed in order
- [ ] Each task's `VALIDATE` command run immediately and passing
- [ ] Full `vitest run` green (unit + integration, 0 skipped with the DB up)
- [ ] Root `tsc -b`, `typecheck:dashboard`, `build:dashboard`, `lint`, `format:check` all clean
- [ ] Manual Level-4 hand-count performed; mismatches logged to `.agents/research/incidents.md`
- [ ] Every acceptance criterion ticked
- [ ] `SUMMARY.md` updated in the same commit as the execution report
- [ ] Reviewed against CLAUDE.md's "Validation is a GATE" section

---

## NOTES

### Spikes ACTUALLY RUN during planning (evidence for the confidence score)

All six ran against the live `420ai_test` database (`DATABASE_URL_TEST`, Postgres in
`420ai-archive` on :5433) using the real repository code via `tsx`. Every throwaway file was deleted
and the test DB was truncated back to a clean state (`git status` clean, verified).

| #      | Question                                                                   | Result                                                                                                                                                                                   |
| ------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **S1** | Are `events.raw_record_id` and `raw_source_records.source_record_id` the same namespace? | **Yes.** The join matched: `c1→1 event, r1→2, r1→2, r2→0`. **And it exposed the trap:** `r1` appears **twice** (two machines), so a join-based parse-success denominator double-counts. Task 6 uses `count(*) filter (where exists(...))` because of this. |
| **S2** | Are cross-machine duplicates visible after ingest?                         | **Yes.** `group by (source_connector, source_record_id)` → `claude-code / r1 / copies=2`. Duplicates survive at the raw layer. |
| **S3** | Is the duplicate-event count exactly derivable?                            | **Yes.** `raw_rows=4, distinct_raw=3, duplicate_events=2, stored_events=3` — `(copies-1) × events_per_record` matches the collapsed count exactly. |
| **S4** | Does the documented aggregate-timestamp gotcha reproduce here?             | **Yes, verbatim.** `max(events.ts)` returned `"2026-08-02 09:00:00+00"` (Postgres text, `timestamp with time zone`), **not** ISO. Every new aggregate goes through `toIso`. |
| **S5** | Do the token-eligibility / attribution / git-bucket queries work?          | **Yes.** Eligibility resolved `claude-code→true`, `codex-cli→false`; git buckets returned `sessions=2, confirmed=0, heuristic=0, none=2`; attribution with real `workspace_keys` returned `sessions=4, attributed=2`. |
| **D**  | Does a **Claude** dry-run re-parse reproduce the stored fingerprints?      | **Exactly.** Ingested `fixtures/sample-session.jsonl` (3 raw / 10 events) → dry run: `stored 10, reparsed 10, missing 0, extra 0, exactMatch true`. |
| **E**  | Does a **Codex** dry-run re-parse reproduce them?                          | **Exactly.** `fixtures/sample-codex-rollout.jsonl` (16 raw / 18 events) → `stored 18, reparsed 18, missing 0, extra 0`. |
| **F**  | Does the org-scoped artifact write path work under the **non-owner** role? | **Yes, fully.** App role verified real (`420ai_app`, `is_superuser=off`, `rolbypassrls=false`). `scopeKind:"org"` + `projectId:null` inserted; versions bumped 1→2→3; `org_id` **absent** from the returned row; **a `viewer` was blocked** by `report_artifacts_role_write_ins`; read-back, list-by-type and `indexReportDoc` (`entity_type=report, project_id=null`) all worked. |

**Facts folded back into the plan from these spikes:** the parse-success denominator must be raw rows
(S1); the duplicate grouping key omits `session_id` (S2/S3 + `fingerprint.ts`); `toIso` is mandatory
on every new aggregate (S4); recoverability is genuinely computable and exact (D/E); the route must
gate at `member` or return 500 instead of 403 (F); no migration is required (F).

**Symbols verified by reading source, not memory:** `insertReportArtifact` (reports.ts:105) and its
`Db`-not-`Tx` requirement; `withOrg` arity (org-context.ts:52 — 4 params, `role` required);
`toIso` (sql-coerce.ts:30); `deriveCaptureHealth` / `CAPTURE_HEALTH_VERDICT` / `deriveMachineStatus` /
`machineStatuses` (capture-health.ts:213/86, routes/capture-health.ts:48); `declaredConnectorHealth`
+ `observedConnectorAggregates` (capture-health.ts:187/267); `reassembleCodex`/`reassembleClaude`
(reparse.ts:72/104 — confirmed **module-private**, hence Task 5); `indexReportDoc` (search.ts:425);
`proxyJson` (lib/proxy.ts:35); `parseClaudeCodeSession`/`parseCodexSession` signatures;
`ConnectorInfo` field unions (control-protocol.ts:54–73); `AttributionConfidence` (git.ts:77);
`SearchEntityType` (search.ts:14).

**Harness confirmed to exist:** `capture-health.int.test.ts:1–80` (two-role header + role-identity
test 1), `reports-m13.int.test.ts`, `rls.int.test.ts` test 9, `org-scoping.test.ts` allow-list,
`ensurePersonalOrg` (organizations.ts:209), `createMachine` (machines.ts:19), `ingestBatch`
(ingest.ts:35), and the eight parser fixtures.

**Not-null columns discovered the hard way during spikes** (they will bite the executor identically):
`workspaces.user_id`, `workspace_keys.user_id`, `workspace_keys.source_connector`. Seed all three.

### Design trade-offs

**Why not a `reconciliation_results` table?** The §4.4 reconciliation is a **human** judgement made
ten times a month by one person for 24 weeks. 16.2 already set this precedent explicitly (D-16.2-5/6:
§7 P1.5's decision log "gets no new table"), and `.agents/research/` already exists from 16.0 with
`decisions.md` / `incidents.md` / `weekly/TEMPLATE.md` waiting for exactly these entries. A table
would add a schema migration, an RLS classification, a CRUD surface and an audit-trail question — for
240 rows a human writes in Markdown. The report **emits the worksheet**; the human's answers land in
`.agents/research/`.

**Why is the report org-scoped rather than per project?** Every §5.1 metric is a statement about the
**capture pipeline**, not about a project. A per-project parse-success rate would invite the reading
"project X has bad data", when the real subject is a connector, a machine, or a parser version.

**Why `member` and not `admin`?** The audit reads broadly and decrypts a bounded sample, which argues
for `admin`; but it is a report, every other report gates at `member`, and the 15.4 test — "whose
action is this?" — answers "the operator auditing their own capture." `admin` would also break the
`--audit` cron path if the key is ever downgraded. Gating at `member` is consistent and measured; if
the decrypt scope later widens, that is the moment to revisit.

**The one place this slice deliberately breaks a repo rule**, named so it is not "fixed" later: the
silent-library rule says a decrypt error throws. `reparseDryRun` **catches** it per row and records
`decrypt-error`. A bounded audit over a sample is precisely the context where one corrupt row must
not take down the instrument that would have reported it — and an audit report that fails to generate
because it found a problem is the worst possible failure mode for this milestone. The catch is
narrow (one row), loud (rendered on the row and counted), and commented with this reasoning.

### What this slice does NOT do

- No hero-workflow evidence panel (§7 P1.6) — deliberately not an M16 slice; it becomes one when
  research Phase 2's gate G2 names the winning workflow.
- No fix for anything the audit reveals. §2's scope-change rule requires a **named** data-quality
  failure with evidence before a fix is built. This slice creates the evidence; it does not spend it.
- No cross-connector dedup (D1) — avoided by configuration (D-M16-1), deferred as work to M19.
- No change to the fingerprint, the ingest upsert, or any existing renderer.
