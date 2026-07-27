# Feature: M15 Slice 15.3 — RLS Enforcement

The following plan should be complete, but it is important that you validate documentation and
codebase patterns and task sanity before you start implementing.

Pay special attention to naming of existing utils, types and models. Import from the right files.

Conventions are **not re-pasted** here — they live in [`CLAUDE.md`](../../CLAUDE.md). This plan links
to them. The milestone definition is
[`.agents/plans/m15-multi-user-access-control.md`](./m15-multi-user-access-control.md); the gating
spike is [`docs/research/m15-rls-spike.md`](../../docs/research/m15-rls-spike.md).

## Feature Description

Slice 15.2 threaded an `orgId` into every tenant-touching read at the **application** layer. That is
D-M15-3's PRIMARY defence, and it is only as good as the reviewer who last looked at a query. This
slice adds the **BACKSTOP**: Postgres Row-Level Security, so a read that forgets its `orgId`
predicate returns **zero rows** instead of another tenant's data.

The 15.0 spike proved this cannot work by adding policies alone: the role in `DATABASE_URL` is a
superuser with `rolbypassrls`, against which RLS is **inert** and `FORCE ROW LEVEL SECURITY` changes
nothing. So the slice has four inseparable parts:

1. A **non-owner application role** (`420ai_app`) that the ingest server connects as.
2. **RLS policies** on the 15 tenant tables, driven by a transaction-local `app.current_org`.
3. A **`withOrg` wrapper** that sets that context, applied at every route handler — because a plain
   `SET` leaks tenant context across pooled connection checkouts (proven in 15.0, Finding 3).
4. A **two-role integration suite** whose cross-tenant negative tests are the milestone's proof, plus
   a role-identity assertion so the gate cannot report green while testing as a bypassing role.

## User Story

As **an operator of a multi-tenant 420AI archive**
I want **the database itself to refuse cross-tenant reads and writes**
So that **a single forgotten `orgId` predicate in application code is an empty result set, not a
silent disclosure of another organisation's sessions, costs and decrypted content**

## Problem Statement

After 15.2, tenant isolation rests entirely on ~40 repository functions each remembering to apply
`eq(<table>.orgId, orgId)`. Milestone Risk 1 states the consequence plainly: 15.2 was the widest edit
in this repo's history, and **"a missed site is a silent wrong-tenant read until 15.3's RLS backstop
lands."** The failure mode is not an error — it is quiet over-disclosure that no test asserts and no
log records.

Three concrete gaps this slice closes, each **measured, not hypothesised** (spike outputs below):

- **A cross-tenant write silently succeeds today.** Spike 6 proved that when org A ingests a
  fingerprint already owned by org B, the `ON CONFLICT DO UPDATE` **updates org B's row with org A's
  data**. D-M15-2's `set:`-block omission protects the `org_id` column (ownership does not flip) but
  protects nothing else — `parser_version`, `tokens`, `cost` and `machine_id` are all overwritten
  across the tenancy boundary. RLS converts this into a hard rejection.
- **An unset context reads everything.** With the current superuser role there is no such thing as
  "unset context" — every query sees all rows regardless.
- **Nothing proves isolation.** `repo-health --require-db` asserts integration tests *ran*; it cannot
  assert they ran as a **non-bypassing** role (15.0 spike, Input 4).

## Solution Statement

Provision a non-owner role, put every tenant table behind a policy keyed on a transaction-local
setting, and route every request through `withOrg` so that setting is always populated and never
escapes onto a pooled connection.

The decisive planning finding is that **this is cheap, because 15.2 already did the hard part.**
Spike 3 showed the policy predicate collapsing to a `One-Time Filter` when the query already carries
an explicit `org_id = <literal>` — the planner proves the policy once instead of per row. Warm-cache
cost on the real 413,765-event archive is **+1.3 to +3.9 ms on a ~16 ms aggregate (≈ +10–20 %)**, with
**index usage unchanged**. Milestone Risk 2's escape hatch (RLS on four tables only) is therefore
**not exercised** — and independently, it is dominated: those four tables are read by 12 of ~20
repository files reached by nearly every route, so narrowing the policy set would save essentially
zero wrapping work while protecting 8 fewer tables.

## Feature Metadata

**Feature Type**: New Capability (security enforcement layer)
**Estimated Complexity**: High — broad but mechanical; the design risk was retired by the spikes below
**Primary Systems Affected**: `packages/db` (migration, `withOrg`, provisioning CLI, 3 repo
signatures), `apps/ingest` (53 handlers across 18 route files, `server.ts`), `apps/desktop`
(`server.rs` env injection), `scripts/repo-health.mjs`, ops docs
**Dependencies**: **None new.** `drizzle-orm`, `pg`, `dotenv`, `tsx` and `vitest` are all already
dependencies of `@420ai/db` (verified — every snippet in this plan imports only from those).

---

## SCOPE DECISIONS MADE DURING PLANNING (do not re-litigate)

| # | Decision | Rationale |
| --- | --- | --- |
| **D-15.3-1** | **Full-coverage RLS on all 15 tenant tables**, not Risk 2's four-table fallback. | Spike 5 retired the perf premise (+10–20 %, index usage preserved). Narrowing saves ~0 wrapping work (the 4 tables are read by 12 of ~20 repos reached by nearly every route) and protects 8 fewer tables — strictly dominated. |
| **D-15.3-2** | **The server hard-fails without `DATABASE_URL_APP`** (user decision, 2026-07-26). | Booting on the owner role leaves every policy decorative and the failure mode is silent over-disclosure — the repo's "skipped ≠ passed" shape. Mirrors the existing `DATABASE_URL` / `SESSION_SECRET` startup throws. Consequence: `apps/desktop/src-tauri/src/server.rs` must inject the new var (Task 12). |
| **D-15.3-3** | **Two policy strengths.** 12 tables get a STRICT policy (unset context ⇒ 0 rows). 3 bootstrap tables (`machines`, `ingest_tokens`, `pairing_codes`) get a BOOTSTRAP-PERMISSIVE policy: enforced when a context is set, permissive when it is not. | Credential lookups are **circular** under a strict policy: `findMachineIdByToken` reads `ingest_tokens`→`machines` *in order to* discover the org, and `redeemPairingCode` runs before any principal exists. A strict policy there 401s every collector. The permissive form is a **strict improvement over no RLS** (which is always open): inside a `withOrg` block it enforces; outside it behaves as today. Pinned by Task 10's test so the exemption cannot silently grow. |
| **D-15.3-4** | **`users`, `organizations`, `memberships` get NO RLS.** | These are the identity tables `resolvePrincipal` reads to *establish* the org. A policy on them is the same circularity as D-15.3-3, with no bootstrap-permissive middle ground worth the complexity. They carry no tenant content. (`pricing_catalogs`, `connector_catalogs`, `ingest_auth_failures` are deployment-global per **D-M15-9** and likewise get none.) |
| **D-15.3-5** | **Deployment-wide maintenance ops iterate PER ORG** rather than getting a privileged bypass connection. | `/v1/replay/reprice`, `/v1/replay/reparse`, `/v1/search/reindex` scan all orgs. Under the app role they would see zero rows and **silently report `{repriced: 0}`** — the worst failure mode. Looping over `listOrganizations` inside `withOrg` keeps **zero privileged seams in the server** ("the ingest server can never see across orgs, full stop") and is the shape 15.4 needs anyway. |
| **D-15.3-6** | **`insertReportArtifact` keeps its `Db` parameter and calls `withOrg` INTERNALLY, once per retry attempt.** Its route does NOT wrap it. | 15.2's own comment (`reports.ts:80-85`) is load-bearing: *"The retry MUST wrap the WHOLE transaction — a failed statement aborts the surrounding one… Hence `Db`, not `DbClient`."* Wrapping the route would pass a `Tx` (a compile error) and, if forced, would break the retry: a unique violation inside an outer transaction poisons it. |
| **D-15.3-7** | **Audit B.4 (alert-reconcile throttle) moves to 15.4** (user decision, 2026-07-26). | It is a performance refinement with no isolation content. 15.3 stays a security slice with a single review lens. Update the milestone plan + SUMMARY accordingly (Task 14). |

### Conflict resolutions (Phase 4 — explicit winners)

These two pairs of instructions **would otherwise contradict**. The winner is stated:

1. *"Wrap every handler in `withOrg`"* vs *"`insertReportArtifact` takes `Db` and owns its retry."*
   → **D-15.3-6 wins**: the report-generation route wraps only its READ calls; the insert stays
   unwrapped and wraps itself internally. Do not "fix" the `Db` parameter to `DbClient`.
2. *"Every tenant read must run inside `withOrg`"* vs *"reindex/reprice/reparse are deliberately
   deployment-wide (D-15.2-7)"* → **D-15.3-5 wins**: they stay deployment-wide in *effect* by
   iterating orgs, not by escaping the policy. Their response shapes are unchanged (counts are
   summed across orgs).

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

- `packages/db/src/client.ts` (all 25 lines) — Why: `createDb`, and the exact `Db` / `Tx` /
  `DbClient` type definitions `withOrg` is built on. `Tx` is
  `Parameters<Parameters<Db["transaction"]>[0]>[0]`.
- `docs/research/m15-rls-spike.md` (Findings 1–4 + the DECIDED block, lines 160–195) — Why: the
  `withOrg` snippet in Task 3 is transcribed from its DECIDED block. **Do not re-derive it**; in
  particular never write `SET LOCAL app.current_org = ${orgId}` (Postgres rejects it, and the naive
  fix interpolates the org id into SQL — an injection vector inside the isolation primitive).
- `packages/db/drizzle/0014_loose_pyro.sql` (lines 1–8 header, and the `--> statement-breakpoint`
  style throughout) — Why: the exact hand-edited-migration format Task 2 mirrors, including the
  header comment convention explaining why it is hand-authored.
- `packages/db/drizzle/down/0014_loose_pyro.down.sql` (28 lines) — Why: the `down/` SQL convention
  `db:rollback` consumes.
- `packages/db/drizzle/meta/_journal.json` (tail) — Why: Task 2 appends entry `idx: 15`; the
  `{idx, version:"7", when, tag, breakpoints:true}` shape must match exactly or `db:rollback`
  cannot find the entry (`rollback.ts:34` matches on `when === created_at`).
- `packages/db/src/migrate-cli.ts` (all 13 lines) and `packages/db/src/rollback-cli.ts` (all 23
  lines) — Why: the entrypoint pattern Task 4's provisioning CLI mirrors exactly (dotenv from the
  repo root via `fileURLToPath(new URL("../../../.env", import.meta.url))`, read env, throw if
  missing, run, log, exit).
- `packages/db/src/repositories/tenancy.int.test.ts` (all 402 lines) — Why: **this is the harness
  Task 10 mirrors.** Confirmed to exist. Reuse verbatim: the `describe.skipIf(!TEST_URL)` guard
  (line 101), the `TRUNCATE … RESTART IDENTITY CASCADE` statement (line 120 — copy the table list
  exactly), and the `ensurePersonalOrg` + two-machine seed in `beforeEach` (lines 118–142).
- `packages/db/src/repositories/reports.ts` (lines 72–122) — Why: `insertReportArtifact`'s retry
  loop and the comment that makes D-15.3-6 non-negotiable.
- `packages/db/src/repositories/machines.ts` (lines 115–131) — Why: `getMachineOrgId(db, machineId)`
  **already exists** (added in 15.1) and is already exported from `index.ts:36`. Machine-authed
  routes use it to resolve the org before wrapping. Do not write a new helper.
- `packages/db/src/repositories/organizations.ts` (lines 47–77) — Why: `findOrgIdByUserId` /
  `getOrgIdForUser` / `ensurePersonalOrg` live here; Task 5 adds `listOrganizations` alongside them.
- `packages/db/src/index.ts` (lines 25–46) — Why: the export-barrel style every new symbol follows
  (named value export, then a separate `export type`).
- `apps/ingest/src/routes/projections.ts` (all 108 lines) — Why: **the canonical handler shape.**
  Seven handlers, all identical: `resolvePrincipal` → `if (!principal) 401` → `isUuid` guard →
  `repo(app.db, principal.orgId, …)`. Task 7's mechanical transform is defined against this file.
- `apps/ingest/src/routes/monitor.ts` (all 207 lines) — Why: the SSE handler. Its teardown wiring
  (`close` listener armed before the first `await push()`, the `closed` guard, `clearInterval`) is
  **load-bearing** per CLAUDE.md's long-lived-resource rule and must survive the wrap untouched.
- `apps/ingest/src/routes/replay.ts` (52 lines) + `apps/ingest/src/routes/search.ts` (62 lines) —
  Why: the three deployment-wide handlers D-15.3-5 converts to per-org loops. Note
  `search.ts:56-59`'s existing D-15.2-7 comment — extend it, don't delete it.
- `apps/ingest/src/plugins/auth.ts` (all 77 lines) — Why: `app.authenticate` calls
  `findMachineIdByToken` + `touchLastSeen` **before** any org context exists — the circularity
  D-15.3-3 resolves. Also the `declare module "fastify"` block Task 6 does not need to change
  (`request.principal` was already added in 15.2 "for 15.3's transaction wrapper", line 39–41).
- `apps/ingest/src/server.ts` (lines 13–16 and 118–139) — Why: the startup-throw pattern Task 11
  mirrors, and the `createDb(databaseUrl)` call plus the two bootstrap writes
  (`ensureUserByEmail`, `setUserPassword`) that must keep working under the app role.
- `apps/desktop/src-tauri/src/server.rs` (lines 136–168 `ingest_env`, plus the tests at 596–636) —
  Why: Task 12's env injection. The "required trio" assertion at line 625 must become a quartet.
- `scripts/repo-health.mjs` (lines 183–233) — Why: the `--require-db` block Task 13 extends with the
  role-identity assertion.

### New Files to Create

- `packages/db/src/org-context.ts` — `withOrg` (the transaction + `set_config` wrapper) and the
  `APP_ROLE_NAME` constant.
- `packages/db/src/org-context.test.ts` — pure unit test for the SQL text `withOrg` emits (no DB).
- `packages/db/src/provision-app-role.ts` — the idempotent role-provisioning engine (library: throws,
  never logs, never exits — CLAUDE.md process-boundary rule).
- `packages/db/src/provision-app-role-cli.ts` — the entrypoint (logs + exits), mirroring
  `rollback-cli.ts`.
- `packages/db/drizzle/0015_<drizzle_tag>.sql` — role + grants + RLS + policies.
- `packages/db/drizzle/down/0015_<drizzle_tag>.down.sql` — the reversal.
- `packages/db/src/repositories/rls.int.test.ts` — the **two-role** suite; the milestone's proof.
- `apps/ingest/src/rls.int.test.ts` — HTTP-level cross-tenant negative tests through `buildApp`.
- `apps/ingest/src/routes/org-scoping.test.ts` — the source-level assertion that no handler reaches
  `app.db` outside the allowed list (see Task 9 and the GOTCHA on `tsc` being file-level).

### Relevant Documentation — READ BEFORE IMPLEMENTING

- [PostgreSQL 17 — Row Security Policies](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)
  - Section: "superusers and roles with the `BYPASSRLS` attribute always bypass the row security
    system" — Why: this is why the app role is load-bearing and not a hardening nicety.
  - Section: policy `USING` vs `WITH CHECK` — Why: a `USING`-only policy is applied as the
    `WITH CHECK` when the latter is omitted, which is what blocks cross-tenant writes
    (confirmed by Spike 6).
- [PostgreSQL 17 — `ALTER TABLE … FORCE ROW LEVEL SECURITY`](https://www.postgresql.org/docs/17/sql-altertable.html)
  - Why: FORCE removes the **table-owner** exemption only. It does **not** remove the superuser
    exemption — two distinct exemptions, two distinct switches (15.0 Finding 1).
- [PostgreSQL 17 — `set_config(setting, value, is_local)`](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-SET)
  - Why: an ordinary function call, therefore **parameterizable**, with `is_local = true` giving
    exact `SET LOCAL` semantics. `SET LOCAL x = $1` is rejected by Postgres (15.0 Finding 4).
- [PostgreSQL 17 — `ALTER DEFAULT PRIVILEGES`](https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html)
  - Why: without it, **every future migration's new table is unreadable by the app role** — a
    time-bomb that would surface in 15.4, not here.

### Patterns to Follow

**The `withOrg` primitive** — transcribed verbatim from the 15.0 spike's DECIDED block
(`docs/research/m15-rls-spike.md:169-183`), which was itself verified to compile. Its assertions,
stated next to it so drift is detectable:

> Spike assertions this snippet must keep satisfying: (1) an org-A context sees only org-A rows and
> an unset context sees **zero** rows; (2) the context does not survive `COMMIT`, `ROLLBACK`, or a
> thrown callback; (3) a subsequent transaction that does not call `set_config` sees zero rows.

```ts
// packages/db/src/org-context.ts
import { sql } from "drizzle-orm";
import type { Db, Tx } from "./client.js";

export async function withOrg<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // set_config(..., true) == SET LOCAL, but PARAMETERIZED.
    // `SET LOCAL app.current_org = ${orgId}` is REJECTED by Postgres (15.0 Finding 4.1) and
    // would require string interpolation — never write it that way.
    await tx.execute(sql`SELECT set_config('app.current_org', ${orgId}, true)`);
    return fn(tx);
  });
}
```

**The policy shape** — the `nullif(…, '')` guard is mandatory, not defensive styling:
`current_setting(x, true)` returns `''` (not `NULL`) after a `RESET`, and `''::uuid` raises
`invalid input syntax for type uuid`. Without it an un-set context turns every query into a **500**
instead of an empty result — a backstop must fail closed and *quiet*, not loud and wrong.

```sql
-- STRICT (12 tables): unset context ⇒ 0 rows.
CREATE POLICY "<table>_org_isolation" ON "<table>"
  USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);

-- BOOTSTRAP-PERMISSIVE (3 tables, D-15.3-3): enforced when a context is set,
-- permissive when it is not, because the credential lookup that DISCOVERS the org
-- must itself be able to run. Strictly better than no RLS, which is always open.
CREATE POLICY "<table>_org_isolation" ON "<table>"
  USING (
    nullif(current_setting('app.current_org', true), '') IS NULL
    OR org_id = nullif(current_setting('app.current_org', true), '')::uuid
  );
```

**The handler transform** (Task 7) — mechanical, mirrors `routes/projections.ts`:

```ts
// BEFORE (15.2)
app.get<{ Params: { id: string } }>("/v1/projects/:id/usage", async (request, reply) => {
  const principal = await resolvePrincipal(app, request);
  if (!principal) return reply.code(401).send({ error: "admin authorization required" });
  if (!isUuid(request.params.id)) return reply.code(404).send({ error: "project not found" });
  return reply.code(200).send(await usageTotals(app.db, principal.orgId, request.params.id));
});

// AFTER (15.3) — guards stay OUTSIDE the transaction; only the DB work moves inside.
app.get<{ Params: { id: string } }>("/v1/projects/:id/usage", async (request, reply) => {
  const principal = await resolvePrincipal(app, request);
  if (!principal) return reply.code(401).send({ error: "admin authorization required" });
  if (!isUuid(request.params.id)) return reply.code(404).send({ error: "project not found" });
  const result = await withOrg(app.db, principal.orgId, (tx) =>
    usageTotals(tx, principal.orgId, request.params.id),
  );
  return reply.code(200).send(result);
});
```

Note both are kept: `withOrg` sets the **backstop** context and the repo keeps its explicit `orgId`
argument (the **primary** scoping) — per **D-M15-3**, RLS does not replace application scoping.
Keeping the explicit predicate is also what makes the policy collapse to a `One-Time Filter`
(Spike 3), so removing it would be a correctness *and* a performance regression.

**Naming / logging / testing conventions**: unchanged — see
[`CLAUDE.md`](../../CLAUDE.md) ("Module / TS / naming", "Logging / process boundaries", "Testing").
The two new library files throw typed errors and never log; the CLI entrypoint logs and exits.

**DB gotchas that apply to this slice's SQL** (CLAUDE.md "Drizzle / SQL gotchas"): no aggregate
timestamps, `numeric`s or closed-set keywords appear in this slice's queries, so those three do not
bite here. The one that **does** apply is *"an aggregate over a tenancy/ownership column is a
SMELL"* — Task 8's per-org loops must `GROUP BY`/filter on `org_id`, never aggregate over it.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation — the role, the policies, the primitive

Nothing can be wrapped until `withOrg` exists, and no policy can be granted to a role that does not
exist. Order matters: the migration creates the role `NOLOGIN` **and then** grants to it, so the
migration is self-sufficient and works whether or not the provisioning CLI has run.

**Tasks:** create `withOrg`; author migration `0015` + its `down/`; add the provisioning CLI and its
npm script; add `listOrganizations`.

### Phase 2: Core Implementation — wrapping the request paths

Every principal-authed handler wraps its DB work; every machine-authed handler resolves the org from
`getMachineOrgId` first, then wraps. The three transaction-owning repositories and the three
deployment-wide ops get their decided special-case treatment (D-15.3-5, D-15.3-6).

### Phase 3: Integration — the server actually connects as the app role

`server.ts` reads `DATABASE_URL_APP` and hard-fails without it (D-15.3-2). `.env.example`,
`setup-env.mjs`, the desktop `server.rs` env injection and the ops guide all follow.

### Phase 4: Testing & Validation — proving the backstop is real

The two-role suite, the HTTP-level negative tests, the source-level no-`app.db` assertion, and the
`repo-health` role-identity check that stops the gate reporting green against a bypassing role.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Each task is atomic and independently testable.

### 1. CREATE `packages/db/src/org-context.ts`

- **IMPLEMENT**: `withOrg<T>(db, orgId, fn)` exactly as in "Patterns to Follow" above, plus
  `export const APP_ROLE_NAME = "420ai_app";` and `export const ORG_SETTING = "app.current_org";`
  so the migration, the CLI and the tests share one spelling. Doc-comment must cite
  `docs/research/m15-rls-spike.md` Findings 3–4 and state why `SET LOCAL` with a bind parameter is
  forbidden.
- **PATTERN**: `docs/research/m15-rls-spike.md:169-183` (verified to compile); typing style from
  `packages/db/src/client.ts:5-15`.
- **IMPORTS**: `import { sql } from "drizzle-orm";` · `import type { Db, Tx } from "./client.js";`
  (relative import ends in `.js` — CLAUDE.md).
- **GOTCHA**: `withOrg` takes `Db`, not `DbClient` — a `Tx` cannot open a top-level transaction, and
  accepting one would silently produce a savepoint whose `set_config` scope is the OUTER
  transaction. Confirmed by compile-probe: `DbClient.transaction()` *does* typecheck (nested
  savepoints are typed), so the compiler will **not** catch this for you — the `Db` parameter is the
  only guard.
- **VALIDATE**: `npx tsc -b` → exit 0

### 2. CREATE migration `packages/db/drizzle/0015_<tag>.sql` + `down/0015_<tag>.down.sql`

- **IMPLEMENT**: hand-author (do **not** run `drizzle-kit generate` — it cannot emit `CREATE ROLE`,
  `GRANT` or `CREATE POLICY`). Statements in this order, separated by `--> statement-breakpoint`:
  1. `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '420ai_app')
     THEN CREATE ROLE "420ai_app" NOLOGIN; END IF; END $$;`
  2. `GRANT USAGE ON SCHEMA public TO "420ai_app";`
  3. `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "420ai_app";`
  4. `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "420ai_app";`
  5. For each of the **12 strict** tables — `raw_source_records`, `events`, `projects`, `workspaces`,
     `workspace_keys`, `report_artifacts`, `git_commits`, `git_commit_files`, `session_git_links`,
     `machine_heartbeats`, `alert_firings`, `search_documents` — `ENABLE` + `FORCE ROW LEVEL
     SECURITY` + the STRICT policy.
  6. For each of the **3 bootstrap** tables — `machines`, `ingest_tokens`, `pairing_codes` —
     `ENABLE` + `FORCE ROW LEVEL SECURITY` + the BOOTSTRAP-PERMISSIVE policy.
  7. **No** RLS on `users`, `organizations`, `memberships`, `pricing_catalogs`,
     `connector_catalogs`, `ingest_auth_failures` (D-15.3-4).
  Header comment mirrors 0014's: state that it is hand-authored and why.
  The `down/` file drops all 15 policies, `DISABLE` + `NO FORCE` all 15 tables, reverses the
  `ALTER DEFAULT PRIVILEGES` and the grants, and `DROP ROLE IF EXISTS "420ai_app";` **last**
  (a role cannot be dropped while it holds privileges).
  Append the journal entry to `packages/db/drizzle/meta/_journal.json`:
  `{"idx":15,"version":"7","when":<epoch_ms>,"tag":"0015_<tag>","breakpoints":true}`.
- **PATTERN**: `packages/db/drizzle/0014_loose_pyro.sql` (header + breakpoint style);
  `packages/db/drizzle/down/0014_loose_pyro.down.sql`.
- **GOTCHA**: the `DO $$ … $$` block contains internal semicolons. **Confirmed safe** — Spike 7 ran
  this exact block through Drizzle's real `migrate()` runner and it applied cleanly (the runner
  splits on `--> statement-breakpoint`, never on `;`), created the role `NOLOGIN` with
  `rolbypassrls = f`, applied `relrowsecurity = t` / `relforcerowsecurity = t`, and a re-run was a
  clean no-op. **Do not "simplify" it into bare `CREATE ROLE`** — that is not idempotent and
  breaks the second `db:migrate`.
- **GOTCHA**: `ALTER DEFAULT PRIVILEGES` without `FOR ROLE` applies to objects created by the role
  running the migration (`420ai`, the owner). That is correct here — keep it that way; adding
  `FOR ROLE` to a different role silently no-ops for future migrations.
- **VALIDATE**: `npm run db:migrate` → exit 0, then re-run → exit 0 (idempotent), then
  `docker exec 420ai-archive psql -U 420ai -d 420ai -t -c "select count(*) from pg_policies where schemaname='public';"`
  → `15`

### 3. CREATE `packages/db/src/provision-app-role.ts` + `provision-app-role-cli.ts`

- **IMPLEMENT**: `provisionAppRole(ownerUrl: string, password: string): Promise<void>` — opens a
  `pg` `Pool` on the owner URL and runs the idempotent `DO $$ … CREATE ROLE … $$` (in case the
  migration has not run yet) followed by
  `ALTER ROLE "420ai_app" LOGIN PASSWORD $1`. **Parameterize the password** — never interpolate it
  into the SQL string. Library file: throws, never logs, never `process.exit`. The CLI reads
  `DATABASE_URL` (owner) + `APP_DB_PASSWORD` from the repo-root `.env`, throws a clear message if
  either is missing, calls the engine, prints a **secret-free** confirmation, and exits.
- **PATTERN**: `packages/db/src/rollback-cli.ts` (all 23 lines) — dotenv path, env read, throw,
  run, log, exit. `packages/db/src/rollback.ts:26` for the `new Pool({connectionString})` +
  `try/finally { await pool.end() }` shape.
- **IMPORTS**: `import { Pool } from "pg";` · `import { config } from "dotenv";` ·
  `import { fileURLToPath } from "node:url";` · `import { APP_ROLE_NAME } from "./org-context.js";`
- **GOTCHA**: `ALTER ROLE … PASSWORD $1` — Postgres accepts a bind parameter here (unlike `SET
  LOCAL`). Verify with a re-run; the operation must be idempotent so rotating `APP_DB_PASSWORD` and
  re-running is the documented rotation path.
- **GOTCHA**: **never log the password or the resulting URL.** Print only
  `provisioned app role: 420ai_app (LOGIN enabled)`.
- **ADD** to `packages/db/package.json` scripts: `"db:provision-app-role": "tsx src/provision-app-role-cli.ts"`,
  and to the root `package.json`: `"db:provision-app-role": "npm run -w @420ai/db db:provision-app-role"`
  (mirroring the six existing `db:*` passthroughs).
- **VALIDATE**: `npm run db:provision-app-role` twice → exit 0 both times; then
  `docker exec 420ai-archive psql -U 420ai -d 420ai -t -c "select rolcanlogin, rolbypassrls, rolsuper from pg_roles where rolname='420ai_app';"`
  → `t | f | f`

### 4. ADD `listOrganizations` to `packages/db/src/repositories/organizations.ts`

- **IMPLEMENT**: `listOrganizations(db: DbClient): Promise<{ id: string }[]>` — an explicit column
  list (`{ id: organizations.id }`), ordered by `asc(organizations.createdAt)` for determinism.
  Used only by the three deployment-wide loops (Task 8).
- **PATTERN**: `findOrgIdByUserId` at `organizations.ts:47` (explicit select, `DbClient` param).
- **GOTCHA**: **explicit column list, never a bare `select()`** — CLAUDE.md's 15.1 lesson (rows that
  can reach `reply.send()` must not carry unannounced columns).
- **EXPORT** from `packages/db/src/index.ts` alongside `ensurePersonalOrg` (line 39-43).
- **VALIDATE**: `npx tsc -b` → exit 0

### 5. UPDATE `packages/db/src/index.ts`

- **IMPLEMENT**: `export { withOrg, APP_ROLE_NAME, ORG_SETTING } from "./org-context.js";` and
  `export { provisionAppRole } from "./provision-app-role.js";`
- **PATTERN**: the barrel style at `index.ts:25-46` (named value export, `export type` separately).
- **VALIDATE**: `npx tsc -b` → exit 0

### 6. UPDATE the 15 principal-authed route files — wrap with `withOrg`

- **IMPLEMENT**: apply the "handler transform" from Patterns to every handler in
  `projections.ts` (7), `reports.ts` (4), `projects.ts` (4), `catalog.ts` (4)†,
  `connector-catalog.ts` (5)†, `exports.ts` (3), `workspaces.ts` (3), `interpretations.ts` (2),
  `monitor.ts` (2), `auth.ts` (2)†, `search.ts` (2), `replay.ts` (2)‡, `alerts.ts` (1),
  `pairing-codes.ts` (1), `git.ts` (6, see Task 7).
  † `catalog.ts`, `connector-catalog.ts` and `auth.ts` operate on **global** tables
  (`pricing_catalogs`, `connector_catalogs`, `users`) which have **no policy** — they still resolve a
  principal but need **no** `withOrg`. Leave them unwrapped and add a one-line comment saying so.
  ‡ `replay.ts` + the reindex handler in `search.ts` are Task 8, not this task.
- **PATTERN**: `apps/ingest/src/routes/projections.ts` — the before/after in Patterns to Follow.
- **IMPORTS**: add `withOrg` to the existing `@420ai/db` import block in each file.
- **GOTCHA**: keep **all guards outside** the transaction — `resolvePrincipal`, `isUuid`, body
  validation and the 401/404/400 replies. Opening a transaction to then 404 wastes a connection, and
  a `reply.code(…).send()` inside the callback makes the transaction's commit/rollback depend on
  serialization order.
- **GOTCHA — the SSE route (`monitor.ts`)**: wrap **inside** `push()`, around the `buildSnapshot`
  call only — one short transaction per tick. Do **not** wrap the stream, the `writeHead`, the
  `reply.hijack()`, or the interval. The `close` listener must stay armed before the first
  `await push()`, the `closed` guard and `clearInterval` must stay intact (CLAUDE.md long-lived-
  resource rule; `/lril:code-review` caught exactly this class in M9). `deliverFirings` stays
  **outside** `withOrg` — it is best-effort I/O that must never hold a transaction open on a webhook
  or SMTP round-trip.
- **VALIDATE**: `npx tsc -b` → exit 0 · `npx vitest run apps/ingest` → all pass

### 7. UPDATE the 5 machine-authed handlers — resolve org, then wrap

- **IMPLEMENT**: in `ingest.ts` (1), `git.ts` (1 machine-authed of its 6), `heartbeat.ts` (1),
  `workspaces.ts` (the `discover` handler), `connector-catalog.ts` (`GET …/active`): after
  `app.authenticate` has set `request.machineId`, call
  `const orgId = await getMachineOrgId(app.db, request.machineId)` **outside** any transaction
  (`machines` is bootstrap-permissive, so this read works with no context), 401/500 if undefined,
  then wrap the repository call in `withOrg(app.db, orgId, …)`.
  `GET /v1/connector-catalog/active` reads only the **global** `connector_catalogs` table — resolve
  nothing, wrap nothing; add a comment.
- **PATTERN**: `apps/ingest/src/routes/git.ts:39` already calls
  `getMachineUserId(app.db, request.machineId)` in exactly this position — mirror it.
- **IMPORTS**: `getMachineOrgId` from `@420ai/db` (already exported, `index.ts:36`).
- **GOTCHA**: `ingestBatch(db: Db, …)` and `recordGitCommits(db: Db, …)` **open their own
  transactions** and derive the org internally from `getMachineOrgId` (15.1). Change their first
  parameter to `DbClient` so they nest as a savepoint inside `withOrg` — **confirmed to typecheck**
  (compile-probe: `DbClient.transaction()` compiles; drizzle emits `SAVEPOINT`). Do **not** delete
  their internal org derivation — it is the D-M15-2 seam that makes a caller-supplied wrong org
  unrepresentable.
- **GOTCHA — behaviour change to pin, not to fix**: under RLS a converging **cross-org** ingest now
  raises `new row violates row-level security policy (USING expression) for table "events"` instead
  of silently overwriting the other org's row (Spike 6). This is the slice working as intended.
  D-M15-2 notes such convergence is effectively impossible in practice (distinct machines yield
  distinct `raw_record_id`s). Add the negative test (Task 10) rather than a catch-and-ignore.
- **VALIDATE**: `npx tsc -b` → exit 0 ·
  `npx vitest run packages/db/src/repositories/tenancy.int.test.ts` → all pass (proves the
  machine-keyed write paths still stamp the right org through the new wrapper)

### 8. UPDATE the 3 deployment-wide handlers — per-org iteration (D-15.3-5)

- **IMPLEMENT**: in `routes/replay.ts` (`reprice`, `reparse`) and `routes/search.ts` (`reindex`):
  `const orgs = await listOrganizations(app.db);` then loop, running each op inside
  `withOrg(app.db, org.id, (tx) => op(tx, …))`, **summing the per-org counts** into the existing
  response shape. `getActiveCatalog` stays outside the loop (global table, one read).
- **PATTERN**: the per-chunk count summation described in CLAUDE.md's "Collector outbound HTTP"
  section ("Endpoints that dedup server-side make chunking exact: sum the per-chunk inserted
  counts") — same arithmetic, per org instead of per chunk.
- **IMPORTS**: `listOrganizations`, `withOrg` from `@420ai/db`.
- **GOTCHA**: change `repriceAll` and `reparseAll`'s first parameter from `Db` to `DbClient`
  (`rebuildSearchIndex` already takes `DbClient` — `search.ts:436`). Their internal
  `db.transaction()` then nests as a savepoint. Verified to typecheck.
- **GOTCHA**: `rebuildSearchIndex` begins with `await tx.delete(searchDocumentsTbl)` — a **full**
  delete. Inside `withOrg` the policy scopes it to the current org, which is exactly right, but it
  means the function is no longer safe to call **unwrapped** (it would delete nothing under the app
  role, or everything under the owner). Add a doc-comment saying it must be called inside `withOrg`.
- **GOTCHA**: **do not aggregate over `org_id`** to build the summary — sum the per-org return
  values in TypeScript. CLAUDE.md: "an aggregate over a tenancy/ownership column is a SMELL."
- **GOTCHA**: extend, do **not** delete, the D-15.2-7 comment at `search.ts:56-59` — the operation
  is still deployment-wide; only its *mechanism* changed from "one unscoped pass" to "a pass per
  org."
- **VALIDATE**: `npx tsc -b` → exit 0 · `npx vitest run apps/ingest/src/search.int.test.ts apps/ingest/src/reparse.int.test.ts apps/ingest/src/replay.int.test.ts`
  → all pass with unchanged response shapes

### 9. UPDATE `packages/db/src/repositories/reports.ts` — `withOrg` per retry attempt (D-15.3-6)

- **IMPLEMENT**: inside `insertReportArtifact`'s existing `for` loop, replace
  `db.transaction(async (tx) => {…})` with `withOrg(db, a.orgId, async (tx) => {…})`. The body,
  the retry loop, the `isVersionConflict` check and the `Db` parameter are **unchanged**.
- **PATTERN**: `reports.ts:95-116` — change one call, nothing else.
- **GOTCHA**: the retry **must** stay outside `withOrg`, exactly as it is outside `db.transaction`
  today. `withOrg` opens the transaction, so each attempt gets a fresh transaction **and** a fresh
  `set_config` — which is precisely why the retry keeps working. Moving the retry inside would
  reproduce the `current transaction is aborted` failure 15.2's comment documents.
- **GOTCHA**: do **not** wrap the report-generation route handler in `withOrg` (Task 6 already
  excludes it for the insert path) — it would pass a `Tx` where `Db` is required. Its *read* calls
  are wrapped normally.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/reports.int.test.ts` → all pass,
  including the existing 8-concurrent-generations race test (8 contiguous versions, 0 failures)

### 10. UPDATE `apps/ingest/src/server.ts` — connect as the app role (D-15.3-2)

- **IMPLEMENT**:

  ```ts
  const databaseUrl = process.env.DATABASE_URL; // owner — migrations + db:* CLIs
  const appDatabaseUrl = process.env.DATABASE_URL_APP;
  if (!appDatabaseUrl) {
    throw new Error(
      "DATABASE_URL_APP is not set — run `npm run db:provision-app-role` and set it. " +
        "Booting on the owner role leaves RLS inert (M15 15.3).",
    );
  }
  const { db } = createDb(appDatabaseUrl);
  ```

- **PATTERN**: the existing throws at `server.ts:15-16` and `:24` — same shape, same voice.
- **GOTCHA**: the two bootstrap writes that follow (`ensureUserByEmail`, `setUserPassword`,
  `server.ts:128-138`) write to `users` / `organizations` / `memberships`, which have **no RLS**
  (D-15.3-4) and are covered by the Task 2 `GRANT`. They keep working unwrapped — verify this, do
  not wrap them.
- **GOTCHA**: `DATABASE_URL` is still read and still required — the migrate/rollback/reprice/
  reparse/rotate-key CLIs and the break-glass path all use the **owner** URL. Do not repoint them.
- **UPDATE** `.env.example`: add `DATABASE_URL_APP=postgres://420ai_app:<password>@localhost:5433/420ai`
  and `APP_DB_PASSWORD=` directly under the existing `DATABASE_URL` block (line 5-9), with a comment
  naming `npm run db:provision-app-role` as the way to create the role. Add
  `DATABASE_URL_TEST_APP=postgres://420ai_app:<password>@localhost:5433/420ai_test` beside
  `DATABASE_URL_TEST`.
- **UPDATE** `scripts/setup-env.mjs` to emit the new keys (and `scripts/setup-env.test.ts` to expect
  them).
- **VALIDATE**: `npx vitest run scripts/setup-env.test.ts` → pass ·
  start the server with `DATABASE_URL_APP` unset → it throws with the message above ·
  with it set → boots and `GET /v1/health` returns 200

### 11. UPDATE `apps/desktop/src-tauri/src/server.rs` — inject the new var

- **IMPLEMENT**: add `database_url_app: String` to `ServerConfig`; add the fourth
  `if cfg.database_url_app.trim().is_empty() { return Err("DATABASE_URL_APP not configured".into()); }`
  guard in `ingest_env`; push `("DATABASE_URL_APP", …)` into the env vec; add the corresponding
  `has_database_url_app` field to `ServerConfigView` in `to_view`; surface an input in
  `apps/desktop/src/components/Settings.tsx` mirroring the existing DATABASE_URL field.
- **PATTERN**: `server.rs:138-168` (`ingest_env`) — the required-trio guards and the `env` vec.
- **GOTCHA**: the Rust tests at `server.rs:596-636` assert the **required trio**; line 625's
  `assert_eq!(keys, vec!["DATABASE_URL", "ADMIN_TOKEN", "ARCHIVE_ENCRYPTION_KEY"])` must become a
  quartet **in the same order the vec pushes them**, and the `sample_config()` helper needs the new
  field or every test in the file fails to compile.
- **GOTCHA**: this is a **secret** — it goes through the Windows Credential Manager like the others
  and must never be logged or returned by `to_view` (only `has_*`).
- **VALIDATE**: `cd apps/desktop/src-tauri && cargo test` → all pass ·
  `npm run typecheck:desktop` → exit 0

### 12. CREATE `packages/db/src/repositories/rls.int.test.ts` — the two-role suite

- **IMPLEMENT**: two `createDb` handles — `owner` from `DATABASE_URL_TEST` (setup, `TRUNCATE`,
  seeding) and `appRole` from `DATABASE_URL_TEST_APP` (every assertion). Guard with
  `describe.skipIf(!TEST_URL || !APP_URL)`. Seed org A + org B exactly as
  `tenancy.int.test.ts:118-142` does (`ensurePersonalOrg` + two machines). Tests:
  1. **role identity** — `select current_setting('is_superuser')` on the app handle → `"off"`, and
     `select rolbypassrls from pg_roles where rolname = current_user` → `false`.
     *This test is the reason the whole suite means anything.*
  2. **fails closed** — outside any `withOrg`, `select … from events` on the app handle → **0 rows**
     (with org A's rows present and visible to the owner handle).
  3. **cross-tenant read** — `withOrg(appRole.db, orgA, …)` sees only org A's events; org B's count
     is 0. Repeat for `search_documents` and `report_artifacts`.
  4. **containment** — after a `withOrg` that COMMITs, and after one that THROWS, a subsequent bare
     read on the same pool returns 0 rows (the 15.0 Finding 3 leak, pinned).
  5. **cross-tenant write** — inside `withOrg(…, orgA)`, inserting a row with `orgId: orgB` is
     rejected. Assert the error, not just that it throws.
  6. **cross-org converging ingest is rejected** — org A ingests a fingerprint owned by org B →
     rejected (the Spike-6 behaviour change). Pair it with the positive case: a **same-org**
     converging re-ingest still upserts cleanly.
  7. **bootstrap-permissive tables** — with **no** context, `findMachineIdByToken` resolves (the
     credential lookup works); with org A's context set, org B's machines are invisible.
  8. **the policy inventory is exactly as decided** — query `pg_policies` and assert the 12 strict +
     3 bootstrap table names, and that the 6 no-RLS tables have none. Mirrors
     `tenancy.int.test.ts:326` ("the 15 tenant tables carry NOT NULL org_id"), which is the
     precedent for asserting schema-level decisions in a test.
- **PATTERN**: `packages/db/src/repositories/tenancy.int.test.ts` — **confirmed to exist**; copy its
  `describe.skipIf` guard (line 101), its `TRUNCATE … RESTART IDENTITY CASCADE` list (line 120) and
  its `beforeEach` seed (lines 118–142) verbatim.
- **GOTCHA**: `TRUNCATE` requires table ownership — it **must** run on the `owner` handle.
  Attempting it on the app handle fails with a permissions error, not an RLS error, which is a
  confusing way to discover the rule.
- **GOTCHA**: `afterAll` must `await` **both** `pool.end()` calls or vitest hangs.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/rls.int.test.ts` → all pass, 0 skipped

### 13. CREATE `apps/ingest/src/rls.int.test.ts` — HTTP-level negative tests

- **IMPLEMENT**: build the app with `buildApp({ db: appRoleDb, … })` and assert that org A's session
  token cannot read org B's data through the real endpoints — at minimum `GET /v1/sessions/:id`
  (shared connector session id), `GET /v1/projects/:id/usage`, `GET /v1/search`,
  `GET /v1/reports/:id` and `GET /v1/exports/events`. Each must return an empty/zeroed projection or
  404 — **never** org B's rows.
- **PATTERN**: `apps/ingest/src/principal.int.test.ts` (added in 15.2) — the same
  build-app-and-inject shape, including its "never serialises another org's event rows" assertion
  style.
- **GOTCHA**: **verify each new test FAILS with the policy dropped** before you trust it. 15.2's
  code-review resolution did exactly this for its two regression tests, and it is the only way to
  tell a real regression test from one that merely asserts current behaviour.
- **VALIDATE**: `npx vitest run apps/ingest/src/rls.int.test.ts` → all pass, 0 skipped

### 14. CREATE `apps/ingest/src/routes/org-scoping.test.ts` — source-level completeness assertion

- **IMPLEMENT**: a **pure** unit test (no DB) that reads every file in `apps/ingest/src/routes/`,
  and asserts that any file containing `resolvePrincipal` and a tenant-table repository call also
  contains `withOrg` — with an explicit, commented allow-list for the global-table handlers
  (`catalog.ts`, `connector-catalog.ts`, `auth.ts`, `health.ts`, `metrics.ts`, `pair.ts`).
- **PATTERN**: `scripts/check-summary.test.ts` — the precedent for a pure test that asserts a
  repo-wide structural property.
- **GOTCHA — this task exists because of a documented lesson**: CLAUDE.md records that deleting
  `adminAuthorized` in 15.2 raised **16** errors, not the ~45 expected, because *"TypeScript binds a
  failed import as an error type and stops re-reporting at each usage"* — `tsc -b` exiting 0 does
  **not** prove every call site was converted. Wrapping 53 handlers has the identical failure shape:
  a missed handler compiles perfectly and silently reads with no org context. This test is the
  `grep` half of that lesson's "pair it with a grep assertion" rule.
- **VALIDATE**: `npx vitest run apps/ingest/src/routes/org-scoping.test.ts` → pass; temporarily
  remove one `withOrg` → it fails

### 15. UPDATE `scripts/repo-health.mjs` — role-identity assertion under `--require-db`

- **IMPLEMENT**: in the `--require-db` branch, before running vitest, assert
  `DATABASE_URL_TEST_APP` is configured and that connecting with it yields
  `current_setting('is_superuser') = 'off'`. Fail with guidance naming
  `npm run db:provision-app-role` otherwise.
- **PATTERN**: `scripts/repo-health.mjs:187-196` — the existing `hasTestDbConfigured()` failure
  block, same `fail(summary, guidance)` shape.
- **GOTCHA**: 15.0 Input 4 is explicit that `--require-db` is *necessary but not sufficient* for
  RLS: it proves the integration tests **ran**, never that they ran as a non-bypassing role. Without
  this check the gate stays green while every policy is untested.
- **GOTCHA**: keep it out of `--fast` (it needs a live DB).
- **VALIDATE**: `npm run repo-health -- --require-db` → passes with the app URL set; with
  `DATABASE_URL_TEST_APP` pointed at the **owner** URL → fails with the new message

### 16. UPDATE documentation + milestone bookkeeping

- **IMPLEMENT**:
  - `docs/guide/operations.md` — a new "Application role & RLS (M15 15.3)" section: why the app role
    exists (RLS is inert against the owner), `npm run db:provision-app-role`, password rotation,
    the `DATABASE_URL` (owner) vs `DATABASE_URL_APP` (app) split, and the corrected **break-glass**
    procedure (direct DB access with the owner URL, never an HTTP god-token — D-M15-7).
  - `CLAUDE.md` "Validation is a GATE" — add the **two-role integration requirement** (an owner-only
    suite reports green while enforcing nothing). This is the invariant amendment the milestone plan
    schedules for 15.3.
  - `.agents/plans/m15-multi-user-access-control.md` — record D-15.3-7 (audit B.4 moved to 15.4) in
    the 15.3/15.4 slice rows.
  - `SUMMARY.md` — flip **15.3** to ✅ with a one-line "DONE `<date>` (PR #NN)" in **both** the §0
    status block and the §6 roadmap, per CLAUDE.md's same-commit rule.
- **GOTCHA**: CI runs `format:check` over `**/*.md` but local `repo-health` does not — run
  `npm run format` before pushing or CI fails on markdown alone.
- **VALIDATE**: `node scripts/check-summary.mjs` → exit 0 · `npm run format:check` → exit 0

---

## TESTING STRATEGY

### Unit Tests

- `packages/db/src/org-context.test.ts` — assert the SQL `withOrg` emits contains
  `set_config('app.current_org'` with a **bound parameter** and `true` for `is_local`, and that it
  does **not** contain the string `SET LOCAL`. No DB required. Inject a fake `Db` whose
  `transaction` captures the executed `sql` object (the repo's existing dependency-injection
  discipline — CLAUDE.md "Inject clocks/dependencies for determinism").
- `apps/ingest/src/routes/org-scoping.test.ts` — Task 14's structural assertion.
- `scripts/setup-env.test.ts` — extended for the new keys.

### Integration Tests

- `packages/db/src/repositories/rls.int.test.ts` — the two-role suite (Task 12). **This is the
  milestone's proof.**
- `apps/ingest/src/rls.int.test.ts` — HTTP-level cross-tenant negatives (Task 13).
- Every existing `*.int.test.ts` must keep passing. They connect as the **owner**, so they continue
  to bypass RLS — that is correct and intentional (they test application scoping, the PRIMARY
  defence). Only the two new suites use the app role.

### Edge Cases

- Unset org context (no `withOrg`) → 0 rows, **not** a 500 (this is what the `nullif` guard buys).
- Empty-string org context (after a `RESET`) → 0 rows, not an `invalid input syntax for type uuid`.
- Context does not survive `COMMIT`, `ROLLBACK`, or a **thrown** callback.
- A subsequent transaction that does not call `set_config` sees 0 rows.
- Cross-tenant `INSERT` → rejected by the implicit `WITH CHECK`.
- Cross-org **converging** ingest (same fingerprint, different org) → rejected; same-org converging
  ingest → still upserts cleanly.
- Bootstrap lookups (`findMachineIdByToken`, `redeemPairingCode`) succeed with **no** context.
- A machine whose org cannot be resolved → clean error, never a null-org insert (already pinned by
  `tenancy.int.test.ts:317`).
- Nested transaction (a repo's own `db.transaction` inside `withOrg`) → savepoint, context inherited.
- Report version-bump race under `withOrg` → 8 concurrent generations still yield 8 contiguous
  versions.

---

## VALIDATION COMMANDS

All runnable from the repo root. Expected pass signal stated for each.

### Level 1: Syntax & Style

```bash
npm run typecheck          # root tsc -b  → exit 0  (NOT a per-workspace build)
npm run lint               # eslint       → exit 0  (CI runs it; repo-health does not)
npm run format:check       # prettier     → exit 0  (includes markdown)
npm run typecheck:dashboard
cd apps/desktop/src-tauri && cargo test   # → all pass
```

### Level 2: Unit Tests

```bash
npx vitest run packages/db/src/org-context.test.ts
npx vitest run apps/ingest/src/routes/org-scoping.test.ts
npx vitest run scripts/setup-env.test.ts
# → all pass
```

### Level 3: Integration Tests

```bash
npm run db:up && npm run db:migrate
npm run db:provision-app-role
# migrate the TEST db too — db:migrate only touches DATABASE_URL
DATABASE_URL=$DATABASE_URL_TEST npm run db:migrate

npx vitest run packages/db/src/repositories/rls.int.test.ts
npx vitest run apps/ingest/src/rls.int.test.ts
# → all pass, 0 skipped
```

### The gate

```bash
npm run repo-health -- --require-db
# → PASS, "N integration tests ran, 0 skipped", and the NEW role-identity check green
```

`repo-health` alone is **not** sufficient for this slice: integration tests self-skip without
`DATABASE_URL_TEST` and a skipped layer still reports green. `--require-db` is mandatory here, and
Task 15 adds the assertion that the RLS tests ran as a **non-bypassing** role.

### Level 4: Manual Validation (evidence → `.agents/qa/m15-signoff/`)

1. **Cross-tenant negative, live** — connect as `420ai_app`, set org A's context, attempt to read
   org B's events, observe **0 rows**. Capture the psql transcript.
2. **`FORCE ROW LEVEL SECURITY` confirmed on every tenant table**:
   ```bash
   docker exec 420ai-archive psql -U 420ai -d 420ai -c \
     "select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relname in ('events','raw_source_records','report_artifacts','search_documents',
                        'projects','workspaces','workspace_keys','git_commits','git_commit_files',
                        'session_git_links','machine_heartbeats','alert_firings',
                        'machines','ingest_tokens','pairing_codes') order by relname;"
   # → 15 rows, relrowsecurity = t AND relforcerowsecurity = t for all
   ```
3. **Owner-bypass proven closed** — as `420ai_app` with no context, `select count(*) from events`
   → `0`.
4. **Rollback drill on a COPY of the real archive** (milestone Risk 4): `db:rollback` → `db:migrate`
   cycle over migration `0015`, on a clone — never the live DB.
5. **Collector round-trip** — pair a collector, `watch`, confirm events land and appear in Monitor
   (proves the bootstrap-permissive tables and the machine-authed wrap both work end to end).
6. **Desktop app** — start the server stack from Settings with `DATABASE_URL_APP` configured;
   confirm ingest boots and Monitor renders.

### Level 5: Additional Validation

```bash
# no handler reaches app.db outside the allow-list (the "pair tsc with a grep" rule)
grep -rn "app\.db" apps/ingest/src/routes/ | grep -v "withOrg\|getMachineOrgId\|resolvePrincipal\|listOrganizations\|getActiveCatalog"
# → only the documented global-table handlers

# the app role never gained a bypass
docker exec 420ai-archive psql -U 420ai -d 420ai -t -c \
  "select rolsuper, rolbypassrls from pg_roles where rolname='420ai_app';"
# → f | f
```

---

## ACCEPTANCE CRITERIA

- [ ] A non-owner role `420ai_app` exists, with `rolsuper = f` and `rolbypassrls = f`, created by an
      **idempotent** path that works against an already-provisioned database
- [ ] All 15 tenant tables have `relrowsecurity = t` **and** `relforcerowsecurity = t`
- [ ] `pg_policies` contains exactly the 12 strict + 3 bootstrap-permissive policies, and none on the
      6 no-RLS tables
- [ ] The ingest server connects as the app role and **refuses to start** without `DATABASE_URL_APP`
- [ ] Every principal-authed handler runs its tenant DB work inside `withOrg`; the exceptions are
      exactly the documented global-table and deployment-wide handlers
- [ ] With no org context, a tenant-table read returns **0 rows** — not an error, not data
- [ ] The org context does not survive `COMMIT`, `ROLLBACK`, or a thrown callback
- [ ] A cross-tenant `INSERT`/`UPDATE` is rejected by the database
- [ ] The two-role suite passes, including the `is_superuser = 'off'` role-identity assertion
- [ ] Each new negative test was verified to **FAIL** with the policy dropped
- [ ] `repo-health -- --require-db` passes with 0 skipped **and** the new role-identity check green
- [ ] `db:rollback` → `db:migrate` proven on a copy of the real archive
- [ ] Existing endpoint response shapes are unchanged (the three deployment-wide ops sum per-org
      counts into their existing shapes)
- [ ] The SSE stream's teardown wiring is byte-for-byte intact
- [ ] `docs/guide/operations.md`, `CLAUDE.md` (two-role gate rule) and `SUMMARY.md` updated in the
      same commit

---

## COMPLETION CHECKLIST

- [ ] All 16 tasks completed in order
- [ ] Each task's validation command passed immediately after that task
- [ ] Level 1–3 validation commands all pass
- [ ] `npm run repo-health -- --require-db` green, 0 skipped
- [ ] `npm run lint` and `npm run format:check` green (CI-only gates)
- [ ] `cargo test` + `npm run typecheck:desktop` green
- [ ] Level 4 manual evidence captured under `.agents/qa/m15-signoff/`
- [ ] Acceptance criteria all met
- [ ] `/lril:code-review` run and clean before commit

---

## NOTES

### Spikes actually RUN during planning (2026-07-26) — evidence for the confidence score

All seven ran against the **live** `420ai-archive` container. Every mutation was reverted and the
database verified pristine afterwards (**413,765 events, 1 organization, 0 roles, 0 RLS, 0 policies**
— confirmed by a post-cleanup query). All throwaway scripts were deleted and `git status` is clean.

| # | Spike | Result |
| --- | --- | --- |
| **1** | Idempotent `DO $$ … CREATE ROLE … $$` + `GRANT` + `ALTER DEFAULT PRIVILEGES`, run **twice** | Both runs exit 0. Role created `rolsuper=f, rolbypassrls=f, rolcanlogin=t`. Idempotency confirmed. |
| **2** | `ENABLE` + `FORCE ROW LEVEL SECURITY` + policies on the **real** `events` / `workspace_keys` / `workspaces` | `relrowsecurity=t, relforcerowsecurity=t` on all three. |
| **3** | Correctness + `EXPLAIN (ANALYZE, BUFFERS)` of the **real `usageTotals` query shape** as the app role over 413,765 events | No context → **0 rows** (fails closed). With context → 413,765 visible, aggregate over 29,249 joined rows. **The policy predicate collapsed to a `One-Time Filter`** — evaluated once, not per row, because 15.2's explicit `org_id = <literal>` lets the planner substitute. Index usage **unchanged** (`Bitmap Index Scan on events_by_project_path`). Context did not survive `COMMIT`; a wrong org → 0 rows; cross-tenant `INSERT` → `ERROR: new row violates row-level security policy`. |
| **4** | Same query **without** an explicit org predicate (a pre-15.2 shape) | The policy becomes a per-row `Filter:` but the planner **still uses `events_by_session`** — RLS does not force a sequential scan. |
| **5** | Warm-cache A/B, 3 runs each | Owner (RLS bypassed): **15.591 / 15.886 / 15.778 ms**. App role under RLS: **18.903 / 16.944 / 19.724 ms**. ⇒ **≈ +10–20 % (+1.3 to +3.9 ms)**. This is what retires Milestone Risk 2. |
| **6** | `ON CONFLICT DO UPDATE` where the conflicting row belongs to **another org** | **Superuser (today): the upsert SILENTLY SUCCEEDS** and writes org A's `parser_version` into org B's row. **App role under RLS: `ERROR: new row violates row-level security policy (USING expression)`.** This is the slice's sharpest justification — a live cross-tenant write that D-M15-2's `set:`-block omission does **not** cover. |
| **7** | A `DO $$ … $$` block through Drizzle's **real** `migrate()` runner, on a scratch database | `MIGRATE OK` — the block survived (the runner splits on `--> statement-breakpoint`, not `;`). Role created `NOLOGIN`, `rolbypassrls=f`; `relrowsecurity=t`/`relforcerowsecurity=t`; policy registered with `cmd=ALL`. **Re-running `migrate()` was a clean no-op.** Scratch DB and role dropped. |

**Compile-probe (also run):** a throwaway `packages/db/src/__probe-nested.ts` containing the exact
`withOrg` implementation plus a `DbClient.transaction()` call — root `tsc -b` **exit 0**. This
confirms (a) the `withOrg` snippet compiles verbatim against the real `Db`/`Tx`/`DbClient` types, and
(b) nested transactions (savepoints) are typed, which is what makes Tasks 7 and 8's `Db → DbClient`
signature changes safe. The probe was deleted and `tsc -b` re-run clean.

**Symbols verified by reading source (not from memory):** `createDb`/`Db`/`Tx`/`DbClient`
(`client.ts:5-25`) · `getMachineOrgId` (`machines.ts:122`, exported `index.ts:36`) ·
`getMachineUserId` (`machines.ts:102`) · `findOrgIdByUserId`/`getOrgIdForUser`/`ensurePersonalOrg`
(`organizations.ts:47,62,77`) · `resolvePrincipal`/`isUuid` (`apps/ingest/src/auth.ts:36,71`) ·
`Principal` (`principal.ts:16`) · `insertReportArtifact` (`reports.ts:92`) ·
`rebuildSearchIndex(db: DbClient)` (`search.ts:436`) · `repriceAll(db: Db)` (`reprice.ts:27`) ·
`reparseAll(db: Db)` (`reparse.ts:127`) · `ingestBatch(db: Db)` (`ingest.ts:23`) ·
`recordGitCommits(db: Db)` (`git.ts:27`) · `rollbackLast` (`rollback.ts:21`) · `runMigrations`
(`migrate.ts:10`).

**Harness confirmed to exist:** `packages/db/src/repositories/tenancy.int.test.ts` (402 lines) —
`describe.skipIf(!TEST_URL)` at line 101, the `TRUNCATE … RESTART IDENTITY CASCADE` list at line 120,
and the `ensurePersonalOrg` + two-machine `beforeEach` seed at lines 118–142. Task 12 mirrors these
verbatim; no fixtures need inventing.

**Blast radius measured, not estimated:** 53 handler registrations across 18 route files; 85
`app.db` references; 9 existing `db.transaction(async` call sites in production code (matching the
15.0 spike's count of 10 including the two route handlers).

### Design notes and trade-offs

- **Why `withOrg` takes `Db` and not `DbClient`.** A `Tx` cannot open a top-level transaction, and
  passing one would create a savepoint whose `set_config` silently scoped to the *outer*
  transaction. The compile-probe showed `DbClient.transaction()` **does** typecheck, so the compiler
  will not catch this — the parameter type is the only guard.

- **Why the bootstrap-permissive policy is not a cop-out.** It is strictly better than the
  alternative it replaces. Without RLS on `machines` / `ingest_tokens` / `pairing_codes`, those
  tables are open *always*. With it, they are enforced inside every `withOrg` block and open only
  during the credential lookup that has no org yet. The residual hole is identical in shape to the
  no-RLS option and strictly smaller in extent.

- **The `One-Time Filter` result is the slice's happiest finding, and it is load-bearing.** The
  policy is cheap *because* 15.2 kept an explicit `org_id` predicate on every query. That makes
  D-M15-3's "keep both layers" a **performance** argument as well as a security one: an executor who
  "simplifies" by deleting the explicit predicate now that RLS exists would convert a one-time filter
  into a per-row filter across the whole event log. Do not do that.

- **Residual risks, named honestly.** (1) Wrapping 53 handlers is broad and a missed one is silent —
  mitigated by Task 14's source-level assertion, which exists precisely because CLAUDE.md documents
  that `tsc -b` is a *file*-level checklist, not a call-site one. (2) The perf measurement is
  single-query; connection-pool pressure from every read now holding a transaction was **not**
  measured, and the SSE path (one transaction per tick per connected client) is where it would show
  first — worth a look during 15.4's throttle work (D-15.3-7). (3) `ALTER DEFAULT PRIVILEGES` is a
  quiet dependency: if a future migration is ever applied by a different role, its new tables will be
  invisible to the app role.

### Confidence

**9.5 / 10** for one-pass success. What earns it: seven spikes run against the real 413k-row archive
with outputs folded back into the plan (not deferred to the executor); the `withOrg` snippet and the
nested-transaction signature changes verified by an actual `tsc -b`; every imported symbol read from
source; the test harness confirmed to exist with exact line references; and the four genuinely
ambiguous forks — full-vs-partial RLS, startup posture, the report-retry conflict, and the
deployment-wide ops — decided in writing (D-15.3-1…7) rather than left for implementation time.

The half-point deduction is Task 6's breadth: 53 mechanical edits where a missed one compiles
cleanly. It is mitigated but not eliminated by Task 14.
