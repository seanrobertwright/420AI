# Code Review — M16 Slice 16.4: Data-Quality Audit Report

**Reviewed:** 2026-08-04 · commit `1ed0f38` · branch `m16-slice4-data-quality-audit-report`
**Plan:** [`.agents/plans/m16-slice4-data-quality-audit-report.md`](../plans/m16-slice4-data-quality-audit-report.md)

## Stats

- Files Modified: 15
- Files Added: 14
- Files Deleted: 0
- New lines: 5209
- Deleted lines: 16

## Validation actually run during this review

| Command                                                                                    | Result                        |
| ------------------------------------------------------------------------------------------ | ----------------------------- |
| `npx vitest run packages/shared/src/{data-quality,reports-audit}.test.ts scripts/generate-reports.test.ts` | **48 passed**, 0 skipped |
| `npx vitest run packages/db/src/repositories/{data-quality,recoverability}.int.test.ts apps/ingest/src/reports/reports-audit.int.test.ts` | **39 passed**, 0 skipped |
| `npx vitest run apps/ingest/src/rls.int.test.ts apps/ingest/src/routes/org-scoping.test.ts` | **22 passed**, 0 skipped |
| `npm run repo-health:fast` (pre-commit)                                                     | PASS                          |

Both repository suites carry the role-identity assertion (`is_superuser = 'off'` AND
`rolbypassrls = false`) as their first test — verified by grep, not assumed.

## Acceptance criteria — spot-checked against the plan

| Criterion                                                             | Status |
| ---------------------------------------------------------------------- | ------ |
| No metric renders a bare number; `ratioMetric` is the only constructor  | ✅ `data-quality.ts:59-70`, all seven call sites route through it |
| A zero denominator renders `unknown`, never `100%`                      | ✅ pinned by unit test + empty-org HTTP test; `TARGETS.recoverability` deliberately avoids the literal `100%` so the assertion stays writable (`reports-audit.ts:29-47`) |
| Connector verdict imported from `deriveCaptureHealth`, not re-derived   | ✅ `data-quality.ts:539` CALLS it; the orchestrator passes 16.3's *inputs*, not pre-counted verdicts |
| Recoverability is a dry run — writes nothing                            | ✅ no `insert`/`update`/`delete` in `recoverability.ts`; int test snapshots both table counts across a run |
| Deterministic sample                                                    | ✅ `order by md5(e.session_id)`; determinism pinned by an int test |
| No migration, no new table, no new dashboard page                       | ✅ |
| `viewer` → 403 (not 500); `member` → 201                                | ✅ asserted at HTTP level |
| Both timestamp mechanisms honoured (`toIso` on `mode:"string"` aggregates) | ✅ every `min/max(events.ts)` goes through `toIso`; `ingested_at` bound is a `Date` |
| `orgId` always the second parameter                                     | ✅ all seven reads + `reparseDryRun` |
| Attribution join carries `org_id` on **both** sides                     | ✅ `wk.org_id` AND `w.org_id` |
| No `org_id` on any returned row                                         | ✅ explicit column lists throughout |

The quality of this slice is high, and the two hardest things to get right — the honesty rule being
structural rather than careful, and the `int4` overflow on a clock *difference* — are both handled
and both commented with the measurement rather than a guess.

---

## Findings

### 1

```
severity: medium
file: apps/ingest/src/schemas.ts
line: 330
issue: The `sampleSize: maximum 50` comment claims it bounds the request's decrypt scope; it does not.
detail: The comment reads "`sampleSize` drives N server-side decrypt+re-parse passes, so 50 keeps a
  single request's decrypt scope bounded." That is not what the code does. `reconciliationSample`
  returns N (session, connector) pairs, but `recoverabilityTargets`
  (packages/db/src/repositories/data-quality.ts:448) then selects DISTINCT
  (session_id, source_connector, machine_id) from `raw_source_records` filtered by session id ALONE
  — it drops the connector from the sample and fans out per machine. So the dry run performs up to
  `N × machines × connectors` decrypt+re-parse passes, not N. With two machines that is 100 passes
  at the stated ceiling, and it can also re-parse a connector that was never in the sample.
  In practice the operator has one machine, so this is a latent bound rather than a live bug — but
  CLAUDE.md's 15.5 lesson is precisely that a comment asserting a guarantee the code does not make
  is the defect, because the next reader trusts it instead of re-deriving it (the last-owner guard
  shipped with exactly this shape).
suggestion: Either (a) pass the sampled `(sessionId, sourceConnector)` pairs to
  `recoverabilityTargets` and filter on both, then state the real bound as
  "N × machines-per-session"; or (b) leave the fan-out and correct the comment to name the actual
  multiplier. (a) is preferable — it also stops the dry run measuring a connector the worksheet does
  not list, which makes the two sections of the report describe the same sessions, as
  `recoverabilityTargets`' own header already claims they do.
```

### 2

```
severity: medium
file: scripts/generate-reports.mjs
line: 158
issue: The `--audit` POST reuses the 30 s project-report timeout, so a slow audit logs FAIL while the artifact was actually created.
detail: `TIMEOUT_MS = 30_000` was sized for project report generation, which is pure aggregation.
  The audit additionally decrypts and re-parses a sample server-side (see finding 1 for the real
  fan-out). When `AbortSignal.timeout` fires, the client aborts but the server keeps going and
  `insertReportArtifact` still commits — so cron prints `FAIL org.data_quality_audit → The operation
  was aborted` and exits 1 while a perfectly good artifact exists. This is the milestone's own
  failure mode in miniature: an instrument that reports a problem it does not have. Cron is the
  operator's only unattended trigger for this report, so a spurious red there is the version most
  likely to be believed.
suggestion: Give the audit its own, longer timeout constant (e.g. `AUDIT_TIMEOUT_MS = 180_000`) with
  a one-line comment saying why it differs — that it covers N decrypt+re-parse passes, not an
  aggregate query. Leave `TIMEOUT_MS` alone for the project loop.
```

### 3

```
severity: low
file: scripts/generate-reports.mjs
line: 79
issue: `--window-days` / `--sample-size` are silently ignored without `--audit`, and `--types` is silently ignored with it.
detail: `parseArgs` accepts all five flags in any combination and `main` branches on `audit` first,
  returning before `resolveReportTypes` runs. So `--audit --types project.efficiency` generates only
  the audit, and `--sample-size 20` on its own does nothing at all. The file deliberately throws on
  an unknown flag so "a typo in a cron line fails loudly rather than silently generating the default
  sweep" — a flag that is known but inert in the current mode defeats that same intent by a
  different route.
suggestion: Throw in `parseArgs` (or right after it) when `--window-days`/`--sample-size` appear
  without `--audit`, and when `--types`/`--project` are passed explicitly alongside `--audit`. A
  sentinel default (`types = undefined` rather than `"all"`) distinguishes "explicitly passed" from
  "defaulted".
```

### 4

```
severity: low
file: apps/dashboard/src/app/api/audit/data-quality/route.ts
line: 18
issue: The proxy does not thread `req.signal`, so a client disconnect leaves the server→ingest hop running.
detail: CLAUDE.md's long-lived-resource rule says to pass `request.signal` to a proxy fetch so the
  upstream hop cancels with the client, and `proxyJson` has accepted an optional `signal` since
  15.10. Every pre-15.10 caller omits it (including the project-report sibling this file was
  modelled on), and the helper's own comment calls the field additive — so this is consistent with
  the codebase rather than a regression. It is nonetheless the single most expensive JSON hop in the
  dashboard (it decrypts and re-parses), which makes it the best candidate for the option, not the
  worst.
suggestion: Add `signal: req.signal` to the `proxyJson` init. One line, no behaviour change for a
  completed request. Note the artifact only commits at the very end of generation, so an aborted hop
  cannot leave a half-written report.
```

### 5

```
severity: low
file: packages/db/src/repositories/data-quality.ts
line: 387
issue: `min(e.machine_id::text)` picks an arbitrary machine for a session captured by several.
detail: The worksheet's `machineId` column is an aggregate over a grouping that does not include
  `machine_id`, so a session captured by two machines silently reports whichever uuid sorts first as
  text. This is the shape CLAUDE.md flags as a smell ("an aggregate over an ownership column"),
  though it is materially milder here than the 15.1 case it names: `machine_id` is not a tenancy key,
  the value is display-only on the worksheet, and `recoverabilityTargets` re-derives the machine set
  independently rather than trusting this column. The risk is a human hand-counting the worksheet
  against the wrong machine's files.
suggestion: Either render `count(distinct e.machine_id)` alongside it, or aggregate to a list
  (`array_agg(distinct e.machine_id::text)`) so a multi-machine session is visibly multi-machine
  rather than arbitrarily single. Alternatively add a one-line comment stating that the column is
  indicative and the dry run does not depend on it.
```

---

## Not findings — checked and confirmed correct

Recorded so a later pass does not re-open them:

- **`pct(1)` renders `100.0%`, which does not contain the substring `100%`.** The empty-org
  assertion therefore holds while a genuine perfect score stays expressible. `TARGETS` avoids the
  literal deliberately and says so.
- **`ev` in `duplicateRawRecords` is not windowed.** Correct: it is joined to the windowed `dup`
  CTE, and events map to raw records one-way, so the window is applied exactly once.
- **The git bucket ladder is order-independent.** A `heuristic` session is still promoted by a later
  `confirmed` link, and `rejected` never promotes. Both are pinned by unit tests.
- **`lag_ms` is `::bigint` while every count is `::int`.** Deliberate and load-bearing — a difference
  between two clocks is not bounded by the table, and the `22003` overflow was measured by
  `rls.int.test.ts`, whose fixtures sit a year before `now`.
- **The per-target loop in `reparseDryRun` is an N+1.** Bounded by the sample and inherent to a
  per-session re-parse; the alternative (one query for all raw rows) would not reduce the parse work.
- **`request.body?.windowDays`** — safe against an absent body; the schema declares no `required`.
- **No secret or decrypted content reaches the artifact.** The renderer emits session ids, connector
  ids, model names and counts only; `reparseDryRun` keeps fingerprint counts and discards plaintext.
- **SQL injection.** Every interpolation in the raw `sql` templates is a bound parameter
  (`${orgId}`, `${since}`, `${limit}`); there is no `sql.raw` in the slice, correctly — no closed-set
  keyword appears.
