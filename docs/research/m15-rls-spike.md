# Spike: Postgres Row-Level Security mechanics (M15 slice 15.0)

**Date:** 2026-07-25 · **Target:** the live `420ai-archive` container (postgres:17, host port 5433),
database `420ai_test` · **Method:** executed SQL + two Node harnesses (`pg` and `drizzle-orm`, both
already dependencies of `@420ai/db` — **no new dependency was introduced**). Every result below is
**verbatim output of a command that was run**, not reasoned-about behavior.

All spike objects — the `rls_spike` schema and the `rls_spike_app` role — were **dropped after the
run**, and their absence verified (`SELECT count(*) FROM pg_roles WHERE rolname='rls_spike_app'` →
`0`; same for the schema). The throwaway harness scripts were deleted. If you re-run anything here,
drop them again.

This document **gates Slice 15.3** (see
[`.agents/plans/m15-multi-user-access-control.md`](../../.agents/plans/m15-multi-user-access-control.md),
D-M15-3): 15.3 cannot be planned until the mechanics below are settled.

## Headline finding

> **The role in `DATABASE_URL` / `DATABASE_URL_TEST` is a Postgres SUPERUSER with `rolbypassrls`.
> RLS is currently INERT against it, and `FORCE ROW LEVEL SECURITY` does not change that.**

Without a dedicated **non-owner application role**, Slice 15.3 would ship policies that pass review,
pass every test, and enforce **nothing**. The separate app role is therefore **load-bearing, not a
hardening nicety** — it is the thing that makes RLS real. This is documented behavior, not a quirk of
this install: PostgreSQL's
[Row Security Policies](https://www.postgresql.org/docs/17/ddl-rowsecurity.html) states that
"superusers and roles with the `BYPASSRLS` attribute always bypass the row security system when
accessing a table."

This is the repo's "skipped ≠ passed" failure shape in a new place: the query runs, the suite is
green, and the mechanism under test was never engaged.

---

## Finding 1 — the connection role is a superuser with BYPASSRLS. RLS is inert against it.

```
$ docker exec -i 420ai-archive psql -U 420ai -d 420ai_test \
    -c "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='420ai';"
    rolname    | rolsuper | rolbypassrls
---------------+----------+--------------
 420ai         | t        | t
```

`.env` sets both `DATABASE_URL` and `DATABASE_URL_TEST` to `postgres://420ai:...`. Against a scratch
table carrying two org-tagged rows, with `ENABLE ROW LEVEL SECURITY` **and** a policy that matched no
rows (no org context set):

```
--- (1) OWNER, RLS enabled but NOT forced, no org set:   owner_sees = 2   ← policy ignored
--- (2) OWNER after FORCE ROW LEVEL SECURITY, no org set: owner_sees = 2   ← FORCE did NOT help
```

**`FORCE ROW LEVEL SECURITY` constrains the table _owner_; it does not constrain a _superuser_.**
Those are two distinct exemptions with two distinct switches:
[`ALTER TABLE … FORCE ROW LEVEL SECURITY`](https://www.postgresql.org/docs/17/sql-altertable.html)
removes the owner exemption only. Nothing an `ALTER TABLE` can say removes the superuser/`BYPASSRLS`
exemption — only connecting as a different role does.

## Finding 2 — a non-owner role gives correct isolation, and fails closed.

Role created as `CREATE ROLE rls_spike_app LOGIN PASSWORD '...'` — **no** superuser, **no**
`BYPASSRLS` — then granted `USAGE` on the schema and `SELECT, INSERT, UPDATE` on the table. Policy:

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

Two sub-findings that 15.3 must carry forward:

- **The `nullif(…, '')` guard is mandatory, not defensive styling.** `current_setting(x, true)`
  returns `''` (an empty string) — _not_ `NULL` — after a `RESET`, and `''::uuid` raises
  `invalid input syntax for type uuid`. Without `nullif`, an un-set org context turns every query
  into a **500** instead of an empty result. The whole point of a backstop is to fail closed and
  quiet, not to fail loud and wrong.
- **A policy with only `USING` also guards writes.** Result (9) blocked a cross-tenant `INSERT`
  even though no `WITH CHECK` clause was written — Postgres applies `USING` as the `WITH CHECK` when
  the latter is omitted. This is what enforces the **D-M15-2** hazard ("an ingest must never flip an
  existing row's `org_id`") **at the database**. 15.3 should still write the explicit negative test:
  relying on an implicit clause without a test that names the behavior is how the guarantee gets
  deleted by a later refactor.

## Finding 3 — plain `SET` LEAKS across pooled checkouts. `SET LOCAL` does not.

`createDb` builds a **shared** `new Pool({ connectionString })` — see
[`packages/db/src/client.ts:21-25`](../../packages/db/src/client.ts). Connections are borrowed and
returned; session-scoped state therefore outlives the request that set it. This harness ran through
`pg.Pool({ max: 1 })` — which forces every checkout onto the same physical connection, making the
hazard **deterministic** rather than intermittent — as the non-superuser app role, with a fresh pool
per scenario:

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
cross-tenant leak in its minimal form — no error, no log line, just the wrong rows.

Worse, it is not limited to the immediately-following checkout: during an earlier contaminated run a
plain `SET` from one scenario survived into a **later, unrelated** scenario on the same physical
connection. The context persists for the lifetime of the connection, not merely until the next
borrow.

**Consequence (the largest mechanical cost in M15):** every request touching tenant data must run
**inside a transaction** — reads included, not only writes. Only **10** `db.transaction()` call sites
exist in the repo today — 8 in `packages/db/src/repositories/` (`connector-catalogs`, `git`,
`ingest`, `key-rotation`, `pricing-catalogs`, `reports`, `reprice`, `search`) and 2 route handlers
(`apps/ingest/src/routes/pair.ts`, `workspaces.ts`). Re-derive with:

```bash
grep -rn "\.transaction(async" --include=*.ts packages apps scripts | grep -v node_modules | grep -v "/dist/"
```

(A bare `grep "db.transaction("` returns 12 — it also matches two prose comments in
`client.ts:7` and `:12`.)

## Finding 4 — the decided pattern works through Drizzle's `transaction()`, with a BOUND parameter.

```
1. SET LOCAL with bound param: REJECTED — Failed query: SET LOCAL app.current_org = $1
2. set_config bound, in tx (org A): 1 row(s)
   set_config bound, in tx (org B): 1 row(s)
3. OUTSIDE any tx (expect 0 = contained): 0 row(s)
4. after a rolled-back tx (expect 0): 0 row(s)
5. next tx WITHOUT set_config (expect 0): 0 row(s)
```

**`SET LOCAL app.current_org = $1` is rejected by Postgres.**
[`SET`](https://www.postgresql.org/docs/17/sql-set.html) takes a literal value, not a bind parameter.
Writing the isolation primitive the naive way therefore requires **interpolating the org id into
SQL** — an injection vector inside the very mechanism whose job is isolation.

[`set_config(setting_name, new_value, is_local)`](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-SET)
is an ordinary function call, so it **is** parameterizable, and `is_local = true` gives exactly
`SET LOCAL` semantics — transaction-scoped, reverted on `COMMIT` **and** on `ROLLBACK`. It works
unchanged inside `db.transaction()`.

Assertions 3–5 prove containment: no context escapes onto the pooled connection after a commit,
after a thrown/rolled-back transaction, or into a subsequent transaction.

---

## DECIDED (15.0) — the transaction-wrapping pattern 15.3 implements

The `Db` / `Tx` types come from [`packages/db/src/client.ts`](../../packages/db/src/client.ts)
(`DbClient = Db | Tx`); `sql` comes from **`drizzle-orm`**, as everywhere else in the repo
(e.g. `packages/db/src/schema.ts:13`). The snippet below is copy-complete and was **verified to
compile**: written into `packages/db/src/` verbatim, root `tsc -b` exits 0.

```ts
// DECIDED (15.0) — 15.3 implements this. Proven by Findings 2-4.
import { sql } from "drizzle-orm";
import type { Db, Tx } from "./client.js";

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

Asserted by the spike:

1. An org-A context sees only org-A rows; an unset context sees **zero** rows (fails closed).
2. The context does **not** survive `COMMIT`, `ROLLBACK`, or a thrown callback.
3. A subsequent transaction that does not call `set_config` sees **zero** rows.

Per **D-M15-3**, RLS is the **backstop**; application-level `orgId` scoping stays the **primary**.
Repositories keep their explicit `orgId`/`userId` parameters — `withOrg` catches what the code
forgets, it does not replace the code.

---

## Inputs for Slice 15.3

1. **A non-owner app role must exist in every environment** — dev, test, and any deployment. It is
   **not** optional; it is what makes RLS real (Finding 1).
2. **`docker/init-test-db.sql` cannot deliver it.** That file runs **only on first boot of an empty
   data volume** (see its own header comment); the archive volume has been initialized since M2, so
   an edit there is **inert for every existing install**. 15.3 must create the role by an
   **idempotent** path — a migration, or a documented `docs/guide/operations.md` step — that works
   against an already-provisioned database.
3. **`vitest.global-setup.ts` migrates as the superuser**, and that is correct and should stay:
   migrations need owner rights. It is the **tests** that must connect as the app role. The two-role
   suite has to coexist with this global setup.
4. **`repo-health --require-db` is necessary but NOT sufficient for RLS.** The gate asserts
   `ran > 0 && skipped === 0` over `*.int.test.ts` (`scripts/repo-health.mjs:183-233`) — it proves
   the integration tests **ran**; it cannot prove they ran **as a non-bypassing role**. If the suite
   keeps connecting as `420ai`, every policy is untested and the gate still reports green. 15.3 must
   add a **role-identity assertion** (e.g. a test asserting `current_setting('is_superuser') = 'off'`
   on the connection the RLS tests use).
5. **Transaction wrapping is required on every tenant-touching read**, not just writes (Finding 3).
   Only **10** `db.transaction()` call sites exist today (enumerated under Finding 3, with the
   command that re-derives the count). If 15.3's planning finds this cost
   prohibitive, the fallback — RLS on `events`, `raw_source_records`, `report_artifacts`, and
   `search_documents` only, with application scoping everywhere else — is decided in the
   **milestone plan** (Risk 2), **not** mid-implementation.

---

## What this spike does NOT establish

Stated explicitly, because 15.3 will be planned against this document and an overclaim here becomes a
wrong decision there.

- **It ran against a synthetic two-row table** (`rls_spike.ev`), not the real schema. It establishes
  **mechanics** — role behavior, context propagation, parameter binding, containment — and nothing
  about this repo's actual tables.
- **No performance claim.** It says nothing about RLS policy cost on `events` at real row counts,
  index usage under a policy predicate, or planner behavior on the projection queries. 15.3 measures
  that.
- **No cost estimate for transaction wrapping.** The mechanical blast radius (how many read paths
  must move inside a transaction, and what that does to latency and connection-pool pressure) was
  counted (11 existing call sites) but not measured.
- **Nothing about RBAC.** Roles/grants per D-M15-4 are 15.4's problem; this spike only proved that a
  role **without** `BYPASSRLS` is subject to policy.
- **Nothing about the backfill.** Adding `org_id` across ~15 tables (D-M15-1/15.1) and its `down/`
  SQL is untouched here.
