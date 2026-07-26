# Feature: M15 Slice 15.0 — Truth fixes + RLS spike write-up

The following plan should be complete, but it's important that you validate documentation and codebase
patterns and task sanity before you start implementing.

Pay special attention to naming of existing utils, types and models. Import from the right files etc.

> **This slice ships NO production code.** It is documentation + research only. Every RLS fact below
> was **empirically proven during planning** against the live `420ai-archive` container on 2026-07-25;
> the raw results are embedded verbatim in "SPIKE RESULTS" and your job is to write them up, not to
> re-derive them. Re-running them to confirm is encouraged (commands are given); discovering a
> different result is a **stop-and-report** event, not something to paper over.

## Feature Description

M15 Slice 15.0 is the gating slice of the **M15 — Multi-user & Access Control** milestone
([`.agents/plans/m15-multi-user-access-control.md`](./m15-multi-user-access-control.md)). It does two
things and nothing else:

1. **Truth fixes.** Correct the three documents that currently assert M15/M16 are "a product-surface
   build, not a data migration." That claim was true for per-user isolation and is **false** under the
   org-level tenancy decided in D-M15-1 — `org_id` lands across ~15 tables with a backfill. Also
   refresh `docs/CONTEXT.md`'s stale "V2 Scope" paragraph (unchanged since before the 2026-07-21 V2
   commitment) and promote the PRD §25 M15 sketch entry into a pointer at the real milestone plan.
2. **The RLS spike write-up.** Produce `docs/research/m15-rls-spike.md` recording the proven
   Row-Level-Security mechanics for this codebase and **deciding the transaction-wrapping pattern**
   that Slice 15.3 will implement. Per the milestone plan, **15.0 gates 15.3** — 15.3 cannot be
   planned until this document exists.

The spike found one result that materially changes M15's risk profile and is the single most
important sentence this slice will write:

> **The role in `DATABASE_URL` / `DATABASE_URL_TEST` is a Postgres SUPERUSER with `rolbypassrls`.
> RLS is currently INERT against it, and `FORCE ROW LEVEL SECURITY` does not change that.**

Without a dedicated non-owner application role, Slice 15.3 would ship policies that pass review, pass
every test, and enforce **nothing**.

## User Story

As the **maintainer planning M15**,
I want **the tenancy/RLS mechanics proven and written down, and the docs that contradict them
corrected**,
So that **Slice 15.3 is planned against verified Postgres behavior instead of assumptions, and nobody
later under-scopes M15 by trusting a sentence that says it isn't a data migration.**

## Problem Statement

Three problems, all of which cause damage *later* rather than now:

1. **The docs actively mislead.** `docs/PRD.md:922-923`, `SUMMARY.md:93-94`, and `SUMMARY.md:220` all
   state M15/M16 are "a product-surface build rather than a data migration." Anyone sizing M15 from
   those lines will under-scope it by an entire migration + backfill.
2. **RLS is unproven in this codebase and has three non-obvious failure modes** — a superuser
   connection role, first-boot-only test-DB provisioning, and a pooled connection that silently
   carries tenant context between requests. Each of them fails *silently* (green tests, no error,
   wrong data), which is precisely the class this repo's "skipped ≠ passed" rule exists to catch.
3. **`docs/CONTEXT.md`'s "V2 Scope" is stale** — it still says V2 is only "General AI Chat sessions,"
   which shipped as M14 and was superseded by the 2026-07-21 five-milestone V2 commitment.

## Solution Statement

Write two documents and edit three. No source code, no schema, no migration.

- **New:** `docs/research/m15-rls-spike.md` — the proven RLS mechanics, the four hazards, the decided
  `withOrg` transaction pattern, and the explicit list of inputs Slice 15.3 must consume.
- **New (already drafted, needs committing):** `.agents/plans/m15-multi-user-access-control.md` is
  currently **untracked** — it is the milestone definition and must land in this slice's commit.
- **Edit:** `docs/PRD.md`, `SUMMARY.md`, `docs/CONTEXT.md` for the truth fixes.

## Feature Metadata

**Feature Type**: Refactor (documentation/truth) + Research
**Estimated Complexity**: **Low** (no code; the hard part — the spike — is already done)
**Primary Systems Affected**: `docs/`, `SUMMARY.md`, `.agents/plans/` — **no workspace source**
**Dependencies**: none added. Spike used only `pg` + `drizzle-orm`, both already dependencies of
`@420ai/db`.

---

## CONTEXT REFERENCES

### Relevant Codebase Files IMPORTANT: YOU MUST READ THESE FILES BEFORE IMPLEMENTING!

- `.agents/plans/m15-multi-user-access-control.md` (whole file) — Why: the milestone definition this
  slice serves. **Currently untracked — `git add` it in this slice.** D-M15-1/2/3 are the decisions
  the research doc must not contradict.
- `packages/db/src/client.ts` (lines 21-25) — Why: `createDb` builds `new Pool({connectionString})`.
  The shared pool is the *reason* the `SET LOCAL` hazard exists; cite these exact lines in the
  research doc.
- `packages/db/src/client.ts` (lines 5-15) — Why: `Db` / `Tx` / `DbClient` types. The decided
  `withOrg` pattern operates on these; name them correctly.
- `docker/init-test-db.sql` (whole file, 3 lines) — Why: it runs **only on first boot of an empty
  volume**. The archive volume is long-since initialized, so adding an app role here would **not**
  apply to the running container. This is a documented input to 15.3.
- `vitest.global-setup.ts` (whole file) — Why: runs `runMigrations(DATABASE_URL_TEST)` as the
  superuser. 15.3's two-role suite has to coexist with this.
- `scripts/repo-health.mjs` (lines 183-233) — Why: the `--require-db` gate asserts `ran > 0 &&
  skipped === 0`. The research doc must state why that gate is **necessary but not sufficient** for
  RLS (it proves int tests ran; it does not prove they ran as a *non-bypassing role*).
- `scripts/check-summary.mjs` (lines 36-70) — Why: the SUMMARY consistency gate. This slice's
  execution report will be named `m15-slice0-*.md` → `sliceIdsFromReportName` yields `["15.0"]`, so
  **SUMMARY.md must contain `**15.0**` with a ✅ within 4 characters** or `repo-health` fails.
- `docs/PRD.md` (lines 920-941) — Why: the exact V2 roadmap block to edit.
- `SUMMARY.md` (lines 88-95, 215-222, 369-378) — Why: the §0 status block, the §3 V2 block, and the
  §6 "NEXT" item all need updating.
- `docs/CONTEXT.md` (lines 15-17) — Why: the stale "V2 Scope" paragraph.

### New Files to Create

- `docs/research/m15-rls-spike.md` — the RLS spike write-up + decided pattern (the slice's headline
  deliverable). Mirror the tone/structure of `docs/research/chat-capture-spike.md` and
  `docs/research/extension-spike.md`: findings first, then a **go/no-go-style decision section**, then
  explicit "inputs for the next slice."

### Files to Modify

- `docs/PRD.md` — correct the false framing at 922-923; repoint the §25 item 15 entry at the plan.
- `SUMMARY.md` — same correction in two places; flip the §6 NEXT item; add the M15 roadmap entry with
  `**15.0**` ✅.
- `docs/CONTEXT.md` — refresh "V2 Scope".
- `.agents/plans/m15-multi-user-access-control.md` — `git add` (untracked).

### Relevant Documentation YOU SHOULD READ THESE BEFORE IMPLEMENTING!

- [PostgreSQL — Row Security Policies](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)
  - Specific section: the paragraph beginning "Superusers and roles with the BYPASSRLS attribute
    always bypass the row security system"
  - Why: this is the documented basis for the spike's headline finding; cite it in the research doc
    so the claim isn't merely empirical.
- [PostgreSQL — `ALTER TABLE ... FORCE ROW LEVEL SECURITY`](https://www.postgresql.org/docs/17/sql-altertable.html)
  - Specific section: `FORCE ROW LEVEL SECURITY`
  - Why: documents that FORCE applies to the **table owner**, and (critically) that it still does not
    apply to superusers/BYPASSRLS — the distinction the spike proved.
- [PostgreSQL — `set_config` / Configuration Settings Functions](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-SET)
  - Specific section: `set_config(setting_name, new_value, is_local)`
  - Why: `is_local = true` is the transaction-scoped equivalent of `SET LOCAL`, and unlike `SET LOCAL`
    it **accepts a bound parameter** — the basis of the decided pattern.
- [PostgreSQL — `SET`](https://www.postgresql.org/docs/17/sql-set.html)
  - Why: documents that `SET` takes a value, not a parameter — why `SET LOCAL x = $1` is rejected.

### Patterns to Follow

**Research-doc shape** — mirror `docs/research/chat-capture-spike.md`: a dated header stating what was
run and on what, numbered findings each with the **command and its verbatim output**, then a decision
section, then "inputs for the next slice." The M14 spike docs are the precedent for a research doc
that *gates* a later slice; match that.

**Truth-fix discipline** — the M13.1 and M14.1 truth slices are the precedent: correct the claim
**and** leave a short note saying what superseded it, so the history stays legible. Do not silently
delete a false sentence; replace it with the corrected one plus its reason.

**Markdown formatting is gated in CI, not locally.** `npm run repo-health` does **not** run Prettier,
but the CI `pr-checks` workflow runs `npm run format:check`, which **includes `**/*.md`**. This slice
is ~100% markdown, so an unformatted file fails CI while passing every local gate. **Run
`npm run format` before committing** — see VALIDATION COMMANDS Level 1.

> **Spike-snippet fidelity:** the `withOrg` snippet below encodes behavior proven by the spike whose
> verbatim output is in SPIKE RESULTS. The assertions are printed next to it. If you change the
> snippet, re-run the spike — a transcribed snippet that contradicts its own spike is worse than no
> snippet.

---

## SPIKE RESULTS — already run, 2026-07-25, against `420ai-archive` (postgres:17, host port 5433)

> Reproduce with the commands shown. All spike objects (`rls_spike` schema, `rls_spike_app` role) were
> **dropped after the run** — verified `SELECT count(*) FROM pg_roles WHERE rolname='rls_spike_app'`
> → `0`. If you re-run, drop them again.

### Finding 1 — the connection role is a superuser with BYPASSRLS. RLS is inert against it.

```
$ docker exec -i 420ai-archive psql -U 420ai -d 420ai_test \
    -c "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='420ai';"
    rolname    | rolsuper | rolbypassrls
---------------+----------+--------------
 420ai         | t        | t
```

`.env` sets both `DATABASE_URL` and `DATABASE_URL_TEST` to `postgres://420ai:...`. With a table that
had `ENABLE ROW LEVEL SECURITY` **and** a policy that matched no rows (no org context set):

```
--- (1) OWNER, RLS enabled but NOT forced, no org set:   owner_sees = 2   ← policy ignored
--- (2) OWNER after FORCE ROW LEVEL SECURITY, no org set: owner_sees = 2   ← FORCE did NOT help
```

**FORCE constrains the table *owner*; it does not constrain a *superuser*.** This is the finding that
makes the dedicated app role load-bearing rather than optional.

### Finding 2 — a non-owner role gives correct isolation, and fails closed.

Role created as `CREATE ROLE rls_spike_app LOGIN PASSWORD '...'` (no superuser, no BYPASSRLS), granted
`USAGE` on the schema and `SELECT, INSERT, UPDATE` on the table. Policy:

```sql
CREATE POLICY ev_org_isolation ON ev
  USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
```

```
--- (5) APP ROLE, no org set:            sees = 0            ← FAILS CLOSED
--- (6) APP ROLE, org A:                 sees = 1  (org A row)
--- (7) APP ROLE, org B:                 sees = 1  (org B row)
--- (8) APP ROLE, empty string org:      sees = 0            ← nullif guard works
--- (9) APP ROLE, cross-tenant INSERT:   ERROR: new row violates row-level security policy for table "ev"
```

Two sub-findings worth their own lines in the write-up:

- **The `nullif(..., '')` guard is mandatory, not defensive styling.** `current_setting(x, true)`
  returns `''` (empty string) — *not* `NULL` — after a `RESET`, and `''::uuid` raises
  `invalid input syntax for type uuid`. Without `nullif`, an un-set context turns every query into a
  500 instead of an empty result.
- **A policy with only `USING` also guards writes.** Finding (9) blocked a cross-tenant INSERT even
  though no `WITH CHECK` clause was written — Postgres applies `USING` as the `WITH CHECK` when the
  latter is omitted. This is what enforces the D-M15-2 hazard ("an ingest must never flip an existing
  row's `org_id`") **at the database**, and 15.3 should still write the explicit negative test.

### Finding 3 — plain `SET` LEAKS across pooled checkouts. `SET LOCAL` does not.

Run through `pg.Pool({ max: 1 })` (forces every checkout onto the same physical connection — the
hazard, deterministically), as the non-superuser app role, with a fresh pool per scenario:

```
=== A: plain SET, no transaction (the WRONG way) ===
  req2 saw 1 row(s) | inherited ctx = "11111111-1111-1111-1111-111111111111"
  >>> LEAK  (expected LEAK) OK
=== B: SET LOCAL inside BEGIN/COMMIT (the RIGHT way) ===
  req2 saw 0 row(s) | inherited ctx = ""
  >>> CONTAINED  (expected CONTAINED) OK
=== C: SET LOCAL inside a tx that ROLLS BACK ===
  req2 saw 0 row(s) | inherited ctx = ""
  >>> CONTAINED  (expected CONTAINED) OK
=== D: after RESET ===
  ctx = "" | rows = 0
```

In scenario A, **request 2 set nothing at all and read request 1's tenant data.** That is the
cross-tenant leak in its minimal form. Note also that during an earlier contaminated run, a plain
`SET` from one scenario survived into a *later, unrelated* scenario on the same physical connection —
the context persists for the lifetime of the connection, not just the next checkout.

### Finding 4 — the decided pattern works through Drizzle's `transaction()`, with a BOUND parameter.

```
1. SET LOCAL with bound param: REJECTED — Failed query: SET LOCAL app.current_org = $1
2. set_config bound, in tx (org A): 1 row(s)
   set_config bound, in tx (org B): 1 row(s)
3. OUTSIDE any tx (expect 0 = contained): 0 row(s)
4. after a rolled-back tx (expect 0): 0 row(s)
5. next tx WITHOUT set_config (expect 0): 0 row(s)
```

**`SET LOCAL app.current_org = $1` is rejected by Postgres** — `SET` takes a literal, not a bind
parameter. Writing it the naive way therefore requires string interpolation of the org id into SQL,
i.e. **an injection vector in the isolation primitive itself**. `set_config('app.current_org', $1,
true)` is transaction-local *and* parameterized, and works unchanged inside `db.transaction()`.

Assertions 3–5 prove containment: no context escapes onto the pooled connection after commit, after a
thrown/rolled-back transaction, or into a subsequent transaction.

### The decided pattern (record this in the research doc as the 15.3 input)

```ts
// DECIDED (15.0) — 15.3 implements this. Proven by Findings 2-4.
// `sql` and the Db/Tx types come from packages/db/src/client.ts (Db | Tx = DbClient).
export async function withOrg<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // set_config(..., true) == SET LOCAL, but PARAMETERIZED.
    // `SET LOCAL app.current_org = ${orgId}` is REJECTED by Postgres (Finding 4.1) and
    // would require string interpolation — never write it that way.
    await tx.execute(sql`SELECT set_config('app.current_org', ${orgId}, true)`);
    return fn(tx);
  });
}
```

Asserted by the spike: (a) org A context sees only org A rows; (b) context does not survive COMMIT,
ROLLBACK, or a thrown callback; (c) a subsequent transaction with no `set_config` sees 0 rows.

### Open inputs this spike hands to Slice 15.3 (list these explicitly in the doc)

1. **A non-owner app role must exist in every environment** — dev, test, and any deployment. It is
   **not** optional and it is what makes RLS real.
2. **`docker/init-test-db.sql` cannot deliver it.** That file runs only on first boot of an *empty*
   data volume (see its own header comment); the archive volume has been initialized since M2, so an
   edit there is inert for existing installs. 15.3 must create the role by an **idempotent** path
   (a migration, or a documented `operations.md` step) that works on an already-provisioned database.
3. **`vitest.global-setup.ts` migrates as the superuser** — correct and should stay that way
   (migrations need owner rights). The *tests* are what must connect as the app role.
4. **`repo-health --require-db` is necessary but NOT sufficient for RLS.** It proves int tests ran and
   none skipped; it cannot prove they ran as a **non-bypassing role**. If the suite keeps connecting
   as `420ai`, every RLS policy is untested and the gate still reports green. 15.3 must add the
   role-identity assertion (e.g. a test asserting `current_setting('is_superuser') = 'off'`).
5. **Transaction wrapping is required on every tenant-touching read**, not just writes (Finding 3).
   Only 11 `db.transaction()` call sites exist today. If 15.3's planning finds this cost prohibitive,
   the milestone-plan fallback (RLS on `events`, `raw_source_records`, `report_artifacts`,
   `search_documents` only) is decided **there**, not mid-implementation.

---

## IMPLEMENTATION PLAN

### Phase 1: Land the milestone definition

The milestone plan is written but untracked. It must be in this commit — every later slice references
its `D-M15-*` decisions.

### Phase 2: Write the research doc

Transcribe SPIKE RESULTS into `docs/research/m15-rls-spike.md` in the house research-doc shape, ending
with the decided pattern and the five inputs for 15.3.

### Phase 3: Truth fixes

Correct PRD/SUMMARY/CONTEXT. Each correction states what superseded the old claim.

### Phase 4: Gate

`repo-health` + `format` + `lint`, then the execution report and the SUMMARY ✅ in the same commit.

---

## STEP-BY-STEP TASKS

IMPORTANT: Execute every task in order, top to bottom.

### 1. VERIFY branch

- **IMPLEMENT**: Confirm you are on `m15-slice0-truth-and-rls-spike` (created during planning). If
  not, create it from `main`.
- **GOTCHA**: Per memory + `SUMMARY.md`, M3+ work never lands directly on `main`.
- **VALIDATE**: `git rev-parse --abbrev-ref HEAD` → `m15-slice0-truth-and-rls-spike`

### 2. ADD `.agents/plans/m15-multi-user-access-control.md`

- **IMPLEMENT**: `git add` the untracked milestone plan. Read it end-to-end first; if anything in it
  contradicts SPIKE RESULTS above, **stop and report** rather than editing either to match.
- **GOTCHA**: Do not rewrite the D-M15-* decisions — they were settled in the 2026-07-25 scope
  conversation and are explicitly marked "do not re-litigate."
- **VALIDATE**: `git status --short .agents/plans/` shows `A` (staged), not `??`

### 3. CREATE `docs/research/m15-rls-spike.md`

- **IMPLEMENT**: Write the spike doc. Required sections, in order:
  1. Header — what was run, when (2026-07-25), against what (`420ai-archive`, postgres:17, port 5433),
     and a one-line statement that all spike objects were dropped.
  2. **Headline finding** — the superuser/BYPASSRLS result, stated first because it changes the
     milestone's risk profile.
  3. Findings 1–4 with their **verbatim command output** as given in SPIKE RESULTS.
  4. The **decided pattern** (`withOrg` snippet + its three asserted properties).
  5. **Inputs for Slice 15.3** — all five, numbered.
  6. A short "what this does NOT establish" section (see GOTCHA).
- **PATTERN**: `docs/research/chat-capture-spike.md` and `docs/research/extension-spike.md` — findings,
  then an explicit decision, then next-slice inputs.
- **GOTCHA**: Be precise that the spike ran against a **synthetic 2-row table**, not the real schema.
  It establishes *mechanics* (role behavior, context propagation, parameter binding), **not**
  performance on `events` at real row counts, and not the cost of wrapping existing read paths in
  transactions. Both are 15.3's to measure. Overclaiming here is how a spike becomes a liability.
- **GOTCHA**: Cite `packages/db/src/client.ts:21-25` for the pool, and link the four PostgreSQL doc
  anchors from "Relevant Documentation" so the claims are backed by spec, not only by observation.
- **VALIDATE**: `test -f docs/research/m15-rls-spike.md && grep -c "rolbypassrls" docs/research/m15-rls-spike.md`
  → ≥ 1

### 4. UPDATE `docs/PRD.md` — the false framing

- **IMPLEMENT**: At **lines 922-923**, replace the claim that M15/M16 are "a product-surface build
  rather than a data migration" with the corrected statement: the schema is multi-user-*capable* at
  the `user_id` level, but M15 adopts **org-level tenancy** (D-M15-1), which **does** require a
  migration + backfill across ~15 tables including `events`. Note what superseded it (the 2026-07-25
  scope conversation) so the history stays legible.
- **GOTCHA**: Do **not** touch `docs/PRD.md:9` or `:37`. Those describe **V1** scope ("V1 is
  single-user in the product experience but multi-user capable in the schema") and remain **true**.
  Only the V2-roadmap framing at 922-923 is false.
- **VALIDATE**: `grep -n "product-surface build" docs/PRD.md` → no match, or matched only inside an
  explicitly-marked superseded note

### 5. UPDATE `docs/PRD.md` — promote the §25 item 15 entry

- **IMPLEMENT**: At **line 938**, mark item 15 **PROMOTED** to a real milestone (mirroring how item 14
  was marked when M14 was promoted — see `docs/PRD.md:935-936` for the exact house phrasing) and link
  `.agents/plans/m15-multi-user-access-control.md`. Add the settled decisions in one line: org
  tenancy, RLS, four fixed roles, all identity paths, `ADMIN_TOKEN` retired.
- **PATTERN**: `docs/PRD.md:935-936` (the M14 promotion note).
- **VALIDATE**: `grep -n "m15-multi-user-access-control" docs/PRD.md` → ≥ 1 match

### 6. UPDATE `SUMMARY.md` — the same correction, two places

- **IMPLEMENT**: Correct the identical false claim at **lines 93-94** (§0 status) and **line 220**
  (§3 V2 block), matching the PRD wording from Task 4.
- **VALIDATE**: `grep -c "not a data migration" SUMMARY.md` → `0` (or only inside a superseded note)

### 7. UPDATE `SUMMARY.md` — §3 roadmap entry + §6 NEXT

- **IMPLEMENT**: (a) In §3, change the M15 bullet from committed-but-unsequenced to **IN PROGRESS**,
  linking the milestone plan and listing slices 15.0–15.10. (b) In §6, replace the "NEXT — promote one
  of M15–M19" item with an M15 entry whose first sub-item is **`**15.0**` ✅ DONE `2026-07-25`** plus
  the one-line summary and the PR number. (c) Note that M16–M19 remain committed and unsequenced.
- **GOTCHA — this is a hard gate.** `scripts/check-summary.mjs` requires that for the execution report
  `m15-slice0-*.md`, SUMMARY contains the token `**15.0**` with a ✅ **within 4 characters** of it
  (either ordering: `**15.0** ✅` or `✅ **15.0**`). Anything further away fails `repo-health`. See
  `scripts/check-summary.mjs:60-70` (`sliceMarkedDone`).
- **GOTCHA**: Do **not** mark M15 `is **DONE**` — that phrasing makes the checker skip per-slice marks
  for the whole milestone (`doneMilestones`, `check-summary.mjs:52-58`) and would disable drift
  detection for slices 15.1–15.10.
- **VALIDATE**: `node scripts/check-summary.mjs` → exit 0

### 8. UPDATE `docs/CONTEXT.md` — refresh "V2 Scope"

- **IMPLEMENT**: At **lines 15-17**, replace "The second release expands tracking to General AI Chat
  sessions." — that shipped as M14. State that V2 is the committed M15–M19 bucket (2026-07-21) and
  that M15 (multi-user & access control) is the first promoted milestone.
- **GOTCHA**: `docs/CONTEXT.md` is the **domain glossary** and code is named after its terms
  (`CLAUDE.md`). If you introduce **Organization** / **Membership** / **Role** as glossary entries,
  they become the canonical names Slice 15.1 must use for tables and types. Either add them
  deliberately and consistently with D-M15-1/D-M15-4, or leave the glossary to 15.1 — **do not**
  introduce a near-miss synonym (e.g. "Team", "Tenant") that later code will diverge from.
- **VALIDATE**: `grep -n -A 4 "## V2 Scope" docs/CONTEXT.md` shows the refreshed text

### 9. RUN the gate

- **IMPLEMENT**: Format, lint, then the full health gate.
- **GOTCHA**: `npm run format` **must** run — CI's `format:check` covers `**/*.md` and this slice is
  almost entirely markdown, but local `repo-health` never runs Prettier. This is a known repeat
  failure mode.
- **VALIDATE**: `npm run format && npm run format:check && npm run lint && npm run repo-health` → all
  exit 0

### 10. WRITE the execution report

- **IMPLEMENT**: `.agents/execution-reports/m15-slice0-truth-and-rls-spike.md` per
  `/lril:execution-report`.
- **GOTCHA**: Per `CLAUDE.md`, the SUMMARY update (Task 7) and this report land in the **same commit**.
- **VALIDATE**: `npm run repo-health` → still exit 0 (the checker now sees the report and demands the
  ✅ from Task 7)

---

## TESTING STRATEGY

This slice ships no code, so there are **no new unit or integration tests** — asserting on prose would
be theatre. The gate is the existing `repo-health` (which must stay green, proving the doc edits broke
no scan) plus `check-summary.mjs`, which is a genuine executable assertion about this slice's SUMMARY
edit.

### Unit Tests

None. `scripts/check-summary.test.ts` already covers the checker itself; do not extend it.

### Integration Tests

None added. **Do not** run `--require-db` for this slice: no DB behavior changed, and the spike's
scratch objects were already dropped. (15.3 is where the DB assertions land.)

### Edge Cases

- `check-summary.mjs` ✅-adjacency: the ✅ must be within 4 chars of `**15.0**`. Verified by running
  the checker, not by eye.
- Prettier reflows long markdown lines and can move the ✅ relative to the token — so run
  `npm run format` **before** the final `check-summary`/`repo-health`, not after.

---

## VALIDATION COMMANDS

Every command runs from the repo root.

### Level 1: Syntax & Style

```bash
npm run format          # MUST run — CI format:check covers **/*.md; repo-health does not
npm run format:check    # expect: exit 0, "All matched files use Prettier code style!"
npm run lint            # expect: exit 0 (ESLint; not run by repo-health)
```

### Level 2: Unit Tests

```bash
npm run repo-health     # expect: exit 0 — root tsc -b, full vitest, NUL + stray-artifact scans,
                        # and check-summary (which gates the **15.0** ✅)
```

### Level 3: Integration Tests

**Intentionally not run for this slice.** No DB-backed behavior changed. `--require-db` is required at
**milestone** sign-off and for any slice touching `@420ai/db` / `apps/ingest` — 15.0 touches neither.

### Level 4: Manual Validation

1. `node scripts/check-summary.mjs` → exit 0.
2. Read `docs/research/m15-rls-spike.md` and confirm it states the superuser finding **first**.
3. Confirm no spike residue survives:
   ```bash
   docker exec -i 420ai-archive psql -U 420ai -d 420ai_test -tc \
     "SELECT count(*) FROM pg_roles WHERE rolname='rls_spike_app';"   # expect 0
   docker exec -i 420ai-archive psql -U 420ai -d 420ai_test -tc \
     "SELECT count(*) FROM information_schema.schemata WHERE schema_name='rls_spike';"  # expect 0
   git status --short   # expect: no stray .mjs/.sql at repo root
   ```
4. Optional — re-run Finding 1 (one command, read-only, no cleanup needed):
   ```bash
   docker exec -i 420ai-archive psql -U 420ai -d 420ai_test \
     -c "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='420ai';"
   ```
   Expect `t | t`. **If this ever returns `f | f`, the headline finding is wrong — stop and report.**

### Level 5: Additional Validation (Optional)

None applicable — no UI, no API surface.

---

## ACCEPTANCE CRITERIA

- [ ] `.agents/plans/m15-multi-user-access-control.md` is tracked (was untracked)
- [ ] `docs/research/m15-rls-spike.md` exists and leads with the superuser/BYPASSRLS finding
- [ ] The spike doc contains all four findings with verbatim output, the `withOrg` decided pattern, and
      all five numbered inputs for 15.3
- [ ] The spike doc explicitly scopes its own limits (synthetic table; no performance claim)
- [ ] `grep -c "not a data migration" SUMMARY.md` → 0 outside a superseded note
- [ ] `docs/PRD.md:922-923` corrected; `docs/PRD.md:9` and `:37` **unchanged**
- [ ] PRD §25 item 15 marked PROMOTED and links the milestone plan
- [ ] `docs/CONTEXT.md` "V2 Scope" refreshed; no near-miss synonym for Organization introduced
- [ ] SUMMARY has `**15.0**` with an adjacent ✅; M15 is **not** marked `is **DONE**`
- [ ] `npm run format:check`, `npm run lint`, `npm run repo-health` all exit 0
- [ ] No spike residue: no `rls_spike` schema, no `rls_spike_app` role, no stray root files
- [ ] Execution report written and in the same commit as the SUMMARY update
- [ ] **Zero source files changed** — `git diff --name-only main` touches only `docs/`, `SUMMARY.md`,
      `.agents/`

---

## COMPLETION CHECKLIST

- [ ] All tasks completed in order
- [ ] Each task validation passed immediately
- [ ] All Level 1/2 validation commands executed successfully
- [ ] `repo-health` green (Level 3 intentionally skipped, justified above)
- [ ] No linting, formatting, or type errors
- [ ] Manual validation (Level 4) confirms no spike residue
- [ ] Acceptance criteria all met
- [ ] `/lril:code-review` run before commit (per the build loop)

---

## NOTES

### Spikes actually run during planning (2026-07-25)

All four findings in SPIKE RESULTS were executed live against `420ai-archive`, not reasoned about:

1. `pg_roles` query → proved `420ai` is `rolsuper=t, rolbypassrls=t`.
2. A scratch `rls_spike.ev` table with two org-tagged rows → proved owner sees all rows with RLS
   enabled, **and still after `FORCE ROW LEVEL SECURITY`**.
3. A non-superuser `rls_spike_app` role → proved fail-closed (0 rows unset), correct per-org
   isolation (1 row each), the `nullif('')` cast guard, and that a `USING`-only policy **also blocks
   cross-tenant INSERT**.
4. A `pg.Pool({max:1})` harness → proved plain `SET` leaks to the next checkout and `SET LOCAL` does
   not, across COMMIT, ROLLBACK, and subsequent transactions.
5. A `drizzle-orm` harness → proved `SET LOCAL … = $1` is **rejected**, `set_config(…, $1, true)`
   works inside `db.transaction()`, and context never escapes the transaction.

Throwaway script deleted; schema and role dropped; both verified. Spikes 4 and 5 used `pg` and
`drizzle-orm` resolved from the repo's own `node_modules` — no new dependency was introduced or needed.

### Design decisions and trade-offs

- **Doc-only slice, deliberately.** Shipping the `withOrg` helper here was considered and rejected:
  it would drag the transaction-wrapping decision (and its blast radius) into a slice whose purpose is
  to *decide* it. Keeping 15.0 code-free makes it trivially safe to land and keeps 15.3 honest.
- **`set_config` over `SET LOCAL`** is a security decision, not a style one. `SET LOCAL` cannot bind
  parameters, so the naive form requires interpolating the org id into SQL — an injection vector in
  the very primitive that enforces isolation.
- **Correct rather than delete the false claims.** Matches the M13.1/M14.1 truth-slice precedent:
  a reader who remembers the old sentence needs to see what superseded it.
- **PRD:9 and :37 deliberately untouched.** They are V1-scope statements and remain true; changing
  them would be over-reach and would falsify V1's record.

### Risks

- **Low.** No source, no schema, no dependency. The realistic failure modes are (a) forgetting
  `npm run format` (CI-only markdown gate), and (b) the `check-summary` ✅-adjacency rule — both are
  called out at their tasks with executable validations.
- **The one substantive risk is overclaiming in the research doc.** The spike proves *mechanics* on a
  synthetic table. It does **not** prove RLS performance on `events` at real row counts, nor the cost
  of wrapping existing read paths in transactions. Task 3's "what this does NOT establish" section is
  mandatory for that reason — 15.3 will be planned against this document, and an overclaim here
  becomes a wrong decision there.

### Confidence

**9.6 / 10** for one-pass success. Evidence: every RLS behavior the slice documents was executed and
its verbatim output is embedded (no "should work" snippets); every file to edit is cited with verified
line numbers; both gating harnesses (`check-summary.mjs` ✅-adjacency, `repo-health --require-db`
scope) were read and their exact rules quoted; the CI-only markdown format gate is named at the task
that trips it. The residual 0.4 is ordinary prose-quality variance in the research doc — how well the
executor scopes the "does NOT establish" section — which no further spiking can retire.
