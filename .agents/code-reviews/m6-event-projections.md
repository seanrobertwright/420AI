# Code Review — Milestone 6: Event Projections

Reviewed: the M6 working-tree changes (deterministic projection layer over the event log).
Context: `CLAUDE.md` (conventions/invariants), the M6 plan, and the M5 patterns being mirrored.

**Stats:**

- Files Modified: 8 (README, session-report.ts, app.int.test.ts, app.ts, schemas.ts, db/index.ts,
  workspaces.ts, workspaces.int.test.ts, shared/cost.ts, shared/index.ts)
- Files Added: 4 (shared/projections.ts, db/repositories/projections.ts, db/.../projections.int.test.ts,
  ingest/routes/projections.ts)
- Files Deleted: 0
- New lines: ~258
- Deleted lines: ~25

Validation at review time: `npm run repo-health` → PASS (root `tsc -b` 0 errors; 183/183 vitest
including the Postgres int suite); `npm run db:generate` → "No schema changes" (D1 invariant held).

---

## Issues

```
severity: medium
file: packages/db/src/repositories/projections.ts
line: 100 (usageByModel)
issue: usageByModel emits a spurious { model: null, tokens: all-zero, costUsd: 0 } row.
detail: The query groups by events.model over ALL of a project's events, but message/tool/file
        events all carry a NULL model and contribute no tokens/cost. They collapse into a phantom
        `model: null` group whose tokens and cost are entirely zero (verified against the test DB:
        a project with one usage event + message/tool events yields TWO rows — the real model and a
        null/zero row). A consumer (the M7 "by model" report) would render a misleading
        "(unknown model) — 0 tokens / $0.00" line. The token/cost `filter` clauses already restrict
        the *sums* to usage.reported/cost.estimated; the GROUP set should be restricted the same way.
suggestion: Add `.where(and(eq(workspaces.projectId, projectId), inArray(events.eventType,
        ["usage.reported", "cost.estimated"])))` so only usage/cost events form the model groups.
        This still preserves a legitimate `model: null` row for usage events that genuinely lack a
        model (cost-confidence "unknown"); it only drops the all-zero noise group. FIXED below.
```

```
severity: low
file: packages/db/src/repositories/projections.ts
line: 38 (tokenSum) and the count/usage helpers
issue: Token sub-type sums are cast `::int` (int4), which overflows above 2,147,483,647.
detail: A bigint token sum cast to int4 throws on overflow. At PRD §8.5 volume this is far off, and
        the `::int` cast is a DELIBERATE plan choice (node-postgres returns int8/bigint as a *string*,
        which would break the `number` result type; `projectEventSummary` uses the same `::int`).
        Flagged for awareness only — not changed, to stay faithful to the proven pattern. A future
        materialized-rollup milestone (D2) would revisit the column type if volume ever approaches it.
suggestion: No change now. If totals ever near int4 range, switch to `::bigint` + `Number(...)`
        coercion (accepting >2^53 imprecision) or return strings. Documented as accepted risk.
```

```
severity: low
file: apps/ingest/src/routes/projections.ts
line: 25-95 (project-scoped GETs) and 88 (/v1/sessions/:sessionId)
issue: Project-scoped and session-detail reads are admin-gated but not additionally userId-scoped.
detail: The plan's D6 asks to "resolve and assert userId for defense" on project-scoped queries, while
        also instructing to "mirror routes/projects.ts:73-85 EXACTLY" — and the shipped M5 `/summary`
        route does NOT resolve userId (it calls projectEventSummary(db, id) directly). This code follows
        the actual M5 precedent. In single-user M2 the two are functionally identical: a projectId is an
        unguessable owned UUID and there is exactly one user. The session-detail endpoint queries by a
        connector-generated session_id with no user filter, same single-user caveat.
suggestion: Accepted as-is for M2 (matches the proven projectEventSummary signature + route). When the
        product goes multi-user, thread userId through the project-scoped repo fns
        (`and(eq(workspaces.projectId, id), eq(workspaces.userId, userId))`) and scope sessionDetail via
        the machines join — a deliberate later hardening, not an M6 correctness gap.
```

```
severity: low
file: packages/db/src/repositories/projections.ts
line: 117-138 (usageOverTime)
issue: date_trunc buckets in the DB session timezone.
detail: `date_trunc('day', ts::timestamptz)` truncates relative to the connection's TimeZone setting.
        The archive Postgres container runs UTC and events are stored UTC, so buckets are correct in
        this deployment, but a non-UTC session would shift day boundaries.
suggestion: No change for V1 (UTC deployment, consistent with stored data). If multi-tz reporting is
        ever needed, truncate explicitly: `date_trunc('day', ts::timestamptz AT TIME ZONE 'UTC')`.
```

---

## Positive notes (verified correct)

- **No migration / no schema change** — `db:generate` reports "No schema changes"; D1/D3 invariants
  (plaintext-only reads, never decrypts) hold. No fingerprint/wire/encryption/parse/collector change.
- **Token `total` recomputed** from the four sub-types (== `computeTotal`), never trusting a stored
  total — matches the M1 report arithmetic (D5). Int tests hand-compute and assert exact totals.
- **lowest-confidence-wins** reduced in TS via the promoted shared ladder; `session-report.ts` now
  imports it (one definition) and its tests pass unchanged — behavior-preserving dedup.
- **connectorHealth** correctly uses the `machines` join (not `workspace_keys`) so UNATTRIBUTED events
  still count — verified by a test seeding an unmapped Gemini event.
- **usageOverTime SQL** inlines the closed `"day"|"week"` unit as a raw literal (injection-safe — it is
  a derived ternary, never raw user input) to keep SELECT/GROUP BY/ORDER BY a single matching
  expression; bound parameters were rejected by Postgres. No SQL-injection surface anywhere (all user
  input flows through Drizzle bound parameters or the isUuid/enum guards).
- **Pre-existing M5 bug fixed**: `projectEventSummary.lastActivity` was typed `Date` but is a string at
  runtime (events.ts is `mode:"string"`); aligned the type and the one stale `.toISOString()` test.
```
