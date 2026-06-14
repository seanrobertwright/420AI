# System Review — Milestones 4–6 (process, not code)

#### Meta Information

- Plan reviewed: `.agents/plans/m6-event-projections.md` (primary, first-hand); M4/M5 plans referenced
- Execution report: `.agents/execution-reports/m4-m6-execution.md`
- Plan command: `~/.claude/skills/lril/commands/plan-feature.md`
- Execute command: `~/.claude/skills/lril/commands/execute.md`
- Prior review: `.agents/system-reviews/milestones-1-3-review.md`
- Date: 2026-06-14

> **Provenance.** M6 is first-hand. M4/M5 are reconstructed from the plans, commits (`4207de4`,
> `8c9d74d`, `54d5753`), and code — consistent with the execution report's own caveat. The single
> highest-value finding below is *proven* (not inferred), see Root-Cause Proof.

---

#### Overall Alignment Score: 8/10

Execution adhered to the plans very well. **All five documented divergences are GOOD** — plan
limitations, a plan self-contradiction resolved correctly, or latent-predecessor defects fixed. There
are **zero bad divergences**: no ignored constraints, no rogue architecture, no tech-debt shortcuts. The
M6 plan is exemplary (spike-retired the one novel risk, file:line "Patterns to Follow", explicit deferred
scope), and the executor treated validation as real gates and pasted exit codes.

Held below 9 by **one recurring systemic gap that a prior review's own fix did not close** (the
integration-test layer is conditionally a silent no-op) and **one plan-internal contradiction**
(connector-health join). Both are process bugs, not code bugs.

---

#### Divergence Analysis

```yaml
divergence: date_trunc bucket unit inlined as a raw literal (not a bound parameter)
planned: "date_trunc(${bucket}, ${events.ts}::timestamptz)" as the group key
actual: const unit = bucket==="week"?"week":"day"; sql`date_trunc(${sql.raw(`'${unit}'`)}, ...)`
reason: a bound parameter breaks Postgres GROUP-BY/SELECT expression matching
classification: good ✅
justified: yes
root_cause: plan limitation — exact SQL-dialect behavior unknowable at plan time; the plan FLAGGED this
  as the one residual risk and prescribed a spike, which retired it. System working as designed.
```

```yaml
divergence: connectorHealth scoped via the machines join, not the workspace_keys join
planned: Task 4 suggested events→workspace_keys→workspaces filtered by workspaces.userId
actual: events→machines on events.machine_id filtered by machines.userId
reason: the workspace_keys inner join drops UNATTRIBUTED events, but the plan's own edge-case contract
  requires those to appear in connector health
classification: good ✅
justified: yes
root_cause: UNCLEAR PLAN — internal contradiction. The plan stated both a join that drops unattributed
  events AND a requirement to count them. The executor reconciled correctly, but the plan should not
  have shipped two mutually exclusive instructions.
```

```yaml
divergence: fixed a pre-existing M5 bug (projectEventSummary.lastActivity typed Date, is a string)
planned: M6 touches only the projection surface
actual: corrected the type + one stale .toISOString() test in workspaces.{ts,int.test.ts}
reason: the bug blocked the green-gate requirement once the DB was up
classification: good ✅
justified: yes
root_cause: MISSING VALIDATION at M5 — the int layer never ran against a DB at M5 sign-off (proven
  below). THE systemic finding of this review.
```

```yaml
divergence: usageByModel restricted GROUP set to usage.reported/cost.estimated events
planned: "group by events.model"
actual: added inArray(events.eventType, ["usage.reported","cost.estimated"]) to the WHERE
reason: grouping over all events produced a phantom {model:null, tokens:0, costUsd:0} row
classification: good ✅
justified: yes
root_cause: minor plan under-specification (didn't state the filter); caught by code review + live-DB
  verification, not by types or the original Map-based test.
```

```yaml
divergence: M5 required a post-merge review-fix pass (commit 54d5753, 6 files: types/scoping/validation/ordering)
planned: deliver the mapping layer correct on first pass
actual: a second commit corrected issues a review caught
reason: not directly observable; commit message = "address M5 review feedback"
classification: good ✅ (process — the review gate working as intended)
justified: yes
root_cause: none problematic; evidence the code-review step catches real issues. Worth noting the same
  /lril:code-review step caught M6's phantom-row issue pre-commit — the gate is earning its place.
```

---

#### Root-Cause Proof — the integration gate is a conditional silent no-op

The execution report *inferred* "M5's gate ran with the DB down." This review **proves** the stronger
claim and pins the exact mechanism:

1. `events.ts` is `mode:"string"` → `max(ts)` returns a string at runtime. The M5 test
   `summary.lastActivity?.toISOString()` therefore **could never have passed against a real DB**. Since
   it shipped, the int layer **never executed against a DB at M5 sign-off** — conclusive, not inferred.
2. `DATABASE_URL_TEST` lives only in **`.env`, which is gitignored / per-machine** (`git ls-files .env`
   → not tracked). A fresh checkout or any session without it → every `*.int.test.ts` self-skips via
   `describe.skipIf(!TEST_URL)`.
3. `scripts/repo-health.mjs` runs `vitest run` but **never checks whether `DATABASE_URL_TEST` is set or
   whether int tests were skipped** — skipped tests render as PASS. The pre-commit hook runs `--fast`,
   skipping the test suite entirely.

So the M1–M3 review's fix (creating `repo-health` to make commands real gates) solved "commands listed
but not run." The **residual gap**: the test gate has a *conditionally-empty layer that reports green
when empty*. `skipped ≠ failed`, and nothing forces the DB-backed layer to run before a milestone ships.

**Cross-milestone pattern (M3→M5):** each milestone fixes a latent defect in its predecessor that only
surfaces when the next milestone exercises it harder (M3 fixed M2's broken `tsc -b` + a NUL file; M6
fixed M5's `lastActivity` type). This is *healthy* (good divergences) but it means predecessor
sign-offs are systematically over-claiming "all green." The fix is the same conditional-gate fix.

---

#### Pattern Compliance

- [x] Followed codebase architecture — every M6 projection is the proven `projectEventSummary` join +
  more columns; routes clone `routes/projects.ts`; int harness extends `app.int.test.ts`.
- [x] Used documented patterns (CLAUDE.md) — silent library (throws, never logs), `userId`-scoping
  discipline, `.js` specifiers + `import type`, no migration / fingerprint / encryption / parse change.
- [x] Applied testing patterns — co-located units + `*.int.test.ts` `skipIf` gating; int tests
  hand-compute expected aggregates (the numbers are the contract).
- [x] Met validation requirements — `repo-health` PASS pasted with exit code; `db:generate` run to
  *prove* zero schema drift. (The gate's int-layer gap is a tooling issue, not an executor lapse — this
  session ran it WITH the DB up and caught the latent bug.)

---

#### System Improvement Actions

> **Status: all six implemented in the session that produced this review** (2026-06-14), and the boxes
> below are checked accordingly. Project files changed: `scripts/repo-health.mjs` (added `--require-db`),
> `CLAUDE.md`. Global lril skill files changed: `~/.claude/skills/lril/commands/{execute,plan-feature}.md`.
> The `--require-db` mode was verified live: "47 integration tests ran, 0 skipped" with the DB up, and a
> fast FAIL when `DATABASE_URL_TEST` is unconfigured (.env-aware so it doesn't false-negative).

**Update CLAUDE.md** — under "Validation is a GATE, not a list":

- [x] Add the **conditional-gate warning** (this review's #1 action):
  > *Integration tests self-skip without `DATABASE_URL_TEST` (which lives in gitignored `.env`). A green
  > `repo-health` with the int layer skipped is NOT green — `skipped ≠ passed`. Before signing off ANY
  > milestone that touches `@420ai/db` or `apps/ingest`, run `repo-health` once with the test DB up
  > (`npm run db:up && npm run db:migrate`, `DATABASE_URL_TEST` set) and confirm the int tests actually
  > RAN (non-zero int count, zero skipped), not merely that the suite was green.*
- [x] Add the **Drizzle raw-`sql` gotchas** (both bit us in M6, both general):
  > *In a raw `sql` template a column's `mode:"string"` parser does NOT apply — `max(ts)`/`min(ts)`/
  > `date_trunc(...)` over a `mode:"string"` timestamptz come back as strings; type the `sql<...>`
  > result as `string`, not `Date`. Inline closed-set SQL keywords (e.g. `date_trunc` granularity) as
  > raw literals via `sql.raw`, never as bound parameters — a bound param makes Postgres treat the
  > SELECT and GROUP BY expressions as distinct and reject the query.*

**Update Plan Command (`plan-feature.md`)** — in Phase 4 (Deep Strategic Thinking) / Phase 5 (template):

- [x] Add a **precedence rule for conflicting guidance** (root cause of the connectorHealth divergence):
  > *When two referenced patterns could conflict (e.g. "mirror route X exactly" AND "scope every query
  > by userId"; or a suggested join AND an edge-case contract the join violates), state explicitly which
  > wins and why. Do not ship two mutually exclusive instructions.*
- [x] Add to the validation/acceptance template, for DB-touching features:
  > *Acceptance MUST include: "ran `repo-health` with the test DB up; the `*.int.test.ts` layer
  > executed (N tests, 0 skipped), not skipped."*

**Update Execute Command (`execute.md`)** — Section 4 (gates):

- [x] Add an explicit step after the gate run:
  > *If the plan or repo has `*.int.test.ts` files, confirm they RAN. `vitest` prints skipped counts —
  > a "passed" suite with the integration files skipped means the DB layer was never exercised. Bring
  > the test DB up and re-run before declaring done.*

**Create / extend tooling** (highest-leverage — converts the convention into enforcement):

- [x] **`repo-health --require-db`** (used at milestone sign-off, not the fast hook): fail if
  `DATABASE_URL_TEST` is unset OR if any `*.int.test.ts` self-skipped. Implementation: pass
  `--reporter=json` to vitest (or grep the summary) and assert `skipped === 0` for `*.int.test.ts`.
  Justification: this is the ONE check that would have caught the M5 bug at M5 time, and the same gap
  will recur on every db/ingest milestone (M7 reads these same projections). The M1–M3 review already
  built `repo-health`; this is the missing assertion inside it, not a new tool.

---

#### Key Learnings

**What worked well**
- **Spike-retires-the-one-novel-risk planning** held for the third+ milestone running. M6 named jsonb
  aggregation as the only risk, prescribed a spike, and it worked — the `date_trunc` divergence was the
  spike doing its job, not a surprise.
- **Reuse over reinvention** kept M6 to one genuinely new idiom; everything else cloned proven M5 code.
- **The `/lril:code-review` step caught a real defect pre-commit** (the phantom null-model row) that
  types and the original test missed — and live-DB verification, not code reading, exposed it.
- **`db:generate` run to prove the no-migration invariant** rather than asserting it — exactly the
  "show evidence, don't claim" discipline the M1–M3 review asked for.

**What needs improvement**
- **The integration gate is conditionally empty and reports green.** A prior review fixed "gates not
  run"; this review's job is to close the follow-on hole: "a gate layer that silently skips." Until
  `repo-health` asserts the int layer ran, predecessor sign-offs will keep over-claiming and the next
  milestone will keep finding the latent bug.
- **Plans occasionally ship internally-contradictory guidance** (the connectorHealth join). A precedence
  rule in the plan template removes the ambiguity the executor currently resolves by judgment.

**For next implementation (M7)**
- M7 reads these same projections — run `repo-health` with the test DB up at sign-off (or land
  `--require-db` first so it is enforced, not remembered).
- Apply the new CLAUDE.md Drizzle gotchas proactively when M7 adds report-rendering queries.
- If M7's plan references "two patterns," demand the precedence call up front.
```
