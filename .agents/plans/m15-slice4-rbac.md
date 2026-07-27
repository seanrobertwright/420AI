# Feature: M15 Slice 15.4 — RBAC (roles, project grants, org-predicate backlog, reconcile throttle)

The following plan should be complete, but it is important that you validate documentation and
codebase patterns and task sanity before you start implementing.

Pay special attention to naming of existing utils, types and models. Import from the right files.

Conventions are **not** re-pasted here — they live in [`CLAUDE.md`](../../CLAUDE.md). The milestone
definition and settled decisions live in
[`.agents/plans/m15-multi-user-access-control.md`](./m15-multi-user-access-control.md); the RLS
findings this slice builds on live in [`docs/research/m15-rls-spike.md`](../../docs/research/m15-rls-spike.md).

## Feature Description

15.4 is the slice that makes an organization able to hold **more than one user**. It does three
things that must land together, because each is only safe in the presence of the others:

1. **Roles become real.** `memberships.role` has existed since 15.1 and been resolved by
   `resolvePrincipal` since 15.2, but nothing has ever *read* it. This slice adds a route-layer
   authorization gate across all 45 principal gates, plus a **per-project grant** that elevates a
   user's capability on a single project, plus an **RLS write backstop** so a role check the route
   forgets still cannot write (the same backstop logic 15.3 applied to tenancy).
2. **It closes the `userId`-only read backlog.** Twelve repository reads still scope by `userId`
   with no `org_id` predicate. They are correct **only** while every org is personal and
   single-user — which is precisely the property this slice ends. They must be converted **before**
   the second user can exist, not after.
3. **It moves the alert reconcile off the SSE hot path** (audit B.4, inherited from 15.3 per
   D-15.3-7). 15.3 made each SSE tick a transaction; the reconcile WRITE inside it now runs once
   per 3 s per connected client per org.

## User Story

As an **organization owner running 420AI for a team**
I want to **invite people with different levels of access — and be certain a read-only member
cannot mutate my archive, and that no query can serve one org's data to another**
So that **I can add a second person to my install without that act itself being the security
event.**

## Problem Statement

Three concrete problems, in descending severity:

- **The tenancy predicate backlog inverts D-M15-3.** `machineStatuses`, `connectorHealth`,
  `connectorHealthWindowed`, `activeSessions`, `recentBacklogSamples`, `listProjects`,
  `createProject`, `listWorkspaces`, `remapWorkspace`, `gitCommitDetail`, `resolveWorkspaceId` and
  `listAlertFirings` filter on `userId` alone. D-M15-3 says application scoping is the PRIMARY
  defence and RLS is the BACKSTOP. For these twelve it is the other way round — RLS is the only
  thing standing between tenants. The moment an org holds two users, `userId` and `orgId` stop
  being 1:1 and these reads start returning **partial** results for the org (a member cannot see
  their colleague's machines) while still relying on RLS for isolation.
- **`memberships.role` is decorative.** Every authenticated caller has full admin power over their
  org. A `viewer` can `POST /v1/replay/reparse` and rewrite the archive.
- **The reconcile write runs on every SSE tick.** `buildSnapshot` calls `reconcileAlertFirings`
  (an upsert loop + an update) every `monitorStreamIntervalMs` (default **3000 ms**,
  `apps/ingest/src/app.ts:33`) for every connected client. 15.3 measured a +10–20 % single-query
  RLS cost but explicitly did **not** measure connection-pool pressure, and this is where it
  surfaces first.

## Solution Statement

- **Role ladder, not role equality.** A four-rung ordered ladder `viewer < member < admin < owner`
  in `@420ai/shared`, with one pure `hasRole(role, minimum)` predicate. Routes gate with a single
  added line; the ladder means "admin or better" is expressible without enumerating roles.
- **Grants ELEVATE, never restrict** (decided — see D-15.4-2). Every org member sees every org
  project. A `project_grants` row raises one user's capability on one project. Consequence, and the
  reason this option was chosen: **no read path gains a grants JOIN**, no RLS policy becomes a
  correlated subquery (the shape D-M15-2 rejected on performance grounds), and a solo org has zero
  grant rows and therefore byte-identical behaviour to today (D-M15-10).
- **An RLS *write* backstop via RESTRICTIVE policies** (decided — see D-15.4-3, proven by Spike 1).
  `withOrg` also sets a transaction-local `app.current_role`; migration `0016` adds three
  RESTRICTIVE policies per strict table covering INSERT/UPDATE/DELETE only. **The 15 existing org
  policies are not modified at all** — restrictive policies AND with permissive ones, so the
  tenancy layer 15.3 proved stays untouched. SELECT carries no restrictive policy, so reads are
  unaffected.
- **`orgId` as the second parameter**, per the 15.2 convention, for all twelve reads.
- **A throttle keyed on `(orgId, userId)`** that degrades the SSE tick from
  reconcile-write to list-read when the last reconcile was recent.

## Feature Metadata

**Feature Type**: Enhancement (security/authorization) + Refactor (tenancy predicates)
**Estimated Complexity**: **High** — wide but mechanical. 63 `withOrg` call sites, 45 route gates,
12 repository signatures, 1 migration, 1 new table.
**Primary Systems Affected**: `packages/db` (org-context, schema, migration, 6 repositories),
`apps/ingest` (auth, 16 route files, monitor), `packages/shared` (role ladder), `apps/dashboard`
(403 surfacing only)
**Dependencies**: **None new.** No package is added. Everything used here already resolves —
verified by Spike 3.

---

## DECISIONS SETTLED FOR THIS SLICE (do not re-litigate)

- **D-15.4-1 — One slice, not sub-sliced.** Confirmed by the maintainer. The four workstreams
  (org predicates, roles, authority items, throttle) ship together. Mitigation for the width: the
  task order below is strictly dependency-ordered, and each phase ends at a green gate.
- **D-15.4-2 — Per-project grants ELEVATE; org membership is open-by-default.** Every org member
  sees every org project; a grant raises capability on one project. Effective project capability =
  `max(org role, grant role)`. Rejected alternative: grant-required visibility for member/viewer —
  it forces a grants JOIN onto every project-scoped read and a correlated subquery into RLS.
- **D-15.4-3 — RLS enforces roles for WRITES ONLY, via RESTRICTIVE policies, on the 12 strict
  tables.** Reads stay org-keyed. Rationale: a role predicate on SELECT buys nothing the org
  predicate does not already give (a viewer is entitled to read their org), and would make every
  read policy more expensive. Bootstrap tables (`machines`, `ingest_tokens`, `pairing_codes`) get
  **no** restrictive policy — they are written by machine/bootstrap paths that have no principal.
- **D-15.4-4 — `withOrg` gains a REQUIRED fourth parameter.** Not optional. An optional role would
  default to permissive at every site the executor forgot, which is silent. A required parameter
  makes `tsc` visit all 63 call sites — and unlike the 15.2 `adminAuthorized` deletion (which
  reported one error per FILE because a failed import binds as an error type), an **arity change on
  a successfully-imported function reports one error per CALL SITE.** This is the one place the
  CLAUDE.md "tsc is a file-level checklist" lesson does *not* bite; it is still paired with a grep
  assertion below, because the lesson is cheap to honour.
- **D-15.4-5 — Audit B.7 (connector-approval authority) is resolved as NOT an org-RBAC concern.**
  Investigated during planning: connector approval is entirely collector-local
  (`apps/collector/src/connectors/connector-approvals.ts`, driven by `connectors.approve` over the
  M11 desktop control protocol). **There is no HTTP approval endpoint**, and the approval is a
  machine-local trust decision made by whoever physically runs that machine — the same person who
  could edit the connector config directly. Elevating it to an org role would be security theatre.
  **Deliverable: a documented decision** (in `docs/guide/operations.md` and the connector-approvals
  file header), not code.
- **D-15.4-6 — Audit B.5's per-org firing fan-out is ALREADY SATISFIED; only the approver identity
  remains.** Investigated during planning: `deriveCatalogAlerts` is called inside `buildSnapshot`,
  which 15.3 made per-`(org, user)`. Each org therefore already reconciles its own
  `catalog.update_requires_approval` firing. The residue is real but small:
  `routes/catalog.ts:68` and its connector-catalog twin record the approver as the **hardcoded
  string `"admin"`**. Replace with `principal.email` and gate on `admin`.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — IMPORTANT: YOU MUST READ THESE BEFORE IMPLEMENTING

| File | Why |
| --- | --- |
| `packages/db/src/org-context.ts` (all 67 lines) | `withOrg` + `APP_ROLE_NAME` + `ORG_SETTING`. The function you are changing. Its header documents WHY `set_config(...,true)` and not `SET LOCAL`, and why the param is `Db` not `DbClient` — **preserve both**. |
| `packages/db/src/repositories/principal.ts` (all 54 lines) | `Principal { userId, email, orgId, role }`. Line 20 says role is "RESOLVED here, ENFORCED in 15.4" — this slice. |
| `apps/ingest/src/auth.ts` (lines 36–63) | `resolvePrincipal`. Every gate goes through it. |
| `apps/ingest/src/routes/org-scoping.test.ts` (all 155 lines) | The structural grep suite. You will ADD to it. Read the header: it documents the file-granular blind spot and why a behavioural test sits beside it. |
| `packages/db/src/repositories/rls.int.test.ts` (lines 404–429) | **Test 8 will break.** It builds `new Map(rows.map(r => [r.tablename, r.qual]))` and asserts `byTable.size === 15`. Adding 36 restrictive policies gives duplicate `tablename` keys, which the Map silently collapses — the size assertion would still pass while `qual` becomes whichever row came last. Must be re-keyed on `(tablename, policyname)`. |
| `apps/ingest/src/rls.int.test.ts` (lines 106–205, 415–456) | The HTTP two-role harness you will extend. Note `login(email, password)` (line 139) and `asUser(token)` (line 150). |
| `packages/db/drizzle/0015_shiny_iron_man.sql` (all 95 lines) | The policy style to mirror exactly, including the `nullif(...,'')` guard rationale. |
| `packages/db/src/repositories/monitor.ts` (all 136 lines) | `machineStatuses`, `activeSessions`, `recentBacklogSamples` — 3 of the 12 reads. |
| `packages/db/src/repositories/alert-firings.ts` (lines 101–214) | `reconcileAlertFirings` (has `orgId`, but its UPDATE and its `listAlertFirings` call drop it) and `listAlertFirings` (no `orgId` at all). |
| `apps/ingest/src/routes/monitor.ts` (all 252 lines) | `buildSnapshot` + the SSE loop. Read the M15 15.3 comments at lines 61–66, 191–199 and 214–222 before touching anything — the `inFlight` guard and the teardown ordering are load-bearing and must survive. |
| `packages/db/src/repositories/projects.ts`, `workspaces.ts` | `listProjects`/`createProject`; `listWorkspaces`/`remapWorkspace`/`resolveWorkspaceId`. Both show the `*RowColumns` explicit-column-list convention. |
| `packages/db/src/repositories/projections.ts` (lines 312, 353) | `connectorHealth`, `connectorHealthWindowed`. |
| `packages/db/src/repositories/git.ts` (lines 146–156) | `gitCommitDetail`. |
| `packages/db/src/repositories/organizations.ts` (all 115 lines) | `getOrgIdForUser` / `listOrganizations` and the rule about which org a row belongs to. |
| `apps/ingest/src/plugins/auth.ts` (lines 8–45) | The `declare module "fastify"` augmentation block — add the throttle decorator's type here. |
| `apps/ingest/src/app.ts` (lines 33, 101–129) | `DEFAULT_MONITOR_STREAM_INTERVAL_MS = 3000` and the `app.decorate` pattern. |
| `apps/ingest/src/routes/catalog.ts` (line 68) | `approveCatalog(app.db, id, "admin", new Date())` — the hardcoded approver. |

### New Files to Create

- `packages/shared/src/roles.ts` — the role ladder + `hasRole` + `ROLES` + sentinel roles.
- `packages/shared/src/roles.test.ts` — pure unit tests for the ladder.
- `packages/db/drizzle/0016_<drizzle-name>.sql` — `project_grants` table + 36 restrictive policies.
- `packages/db/drizzle/down/0016_<drizzle-name>.down.sql` — the rollback.
- `packages/db/src/repositories/project-grants.ts` — grant CRUD + `effectiveProjectRole`.
- `packages/db/src/repositories/project-grants.int.test.ts` — grant repo integration tests.
- `apps/ingest/src/authorize.test.ts` — unit tests for the route gate helper.
- `apps/ingest/src/rbac.int.test.ts` — **the slice's proof**: two-role, two-user, per-role HTTP tests.

### Relevant Documentation

- [PostgreSQL — Row Security Policies](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)
  - Section: *Policies applied as PERMISSIVE vs RESTRICTIVE* — restrictive policies are combined
    with `AND`, permissive with `OR`. Why adding restrictive policies cannot weaken 15.3's tenancy.
  - Why: the entire D-15.4-3 design rests on this combination rule.
- [PostgreSQL — `CREATE POLICY`](https://www.postgresql.org/docs/17/sql-createpolicy.html)
  - Section: *`USING` vs `WITH CHECK`* — "`WITH CHECK` … is not applied to `DELETE`", and `USING`
    filters rows silently rather than raising.
  - Why: this is exactly what Spike 1 measured; it dictates INSERT/UPDATE→`WITH CHECK` (loud) and
    DELETE→`USING` (silent). Do not try to make DELETE loud; Postgres offers no mechanism.
- [PostgreSQL — `set_config`](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-SET)
  - Why: `is_local = true` gives `SET LOCAL` semantics while allowing a bound parameter. Already
    load-bearing in `withOrg`; the new `app.current_role` uses the identical call.

### Patterns to Follow

**Silent library (CLAUDE.md).** Repositories throw typed errors, never log, never `process.exit`.
Only `apps/ingest/src/server.ts` logs.

**Explicit column lists.** No route declares a Fastify `response` schema, so a bare `select()` /
`returning()` puts every future column on the wire. `project-grants.ts` must define a
`projectGrantRowColumns` constant mirroring its exported `ProjectGrantRow`, exactly as
`projects.ts:27-34` does.

**`orgId` is always the SECOND parameter**, immediately after `db` — so a transposed argument
between two adjacent `string` params is visible in review (the 15.2 convention). All twelve
converted reads follow it: `f(db, orgId, userId, …)`.

**Aggregate timestamps must be ISO-normalized.** Confirmed live by **Spike 2** (output below):
`max(events.ts)` returns Postgres text `"2026-07-22 22:35:19.274+00"`, **not** ISO — even though
`events.ts` is `mode:"string"`. Any snippet you write that aggregates a timestamp must pass through
`new Date(v).toISOString()`, as `monitor.ts:69`'s `toIso` helper does.

**Role-gate call shape** — one added line per handler, immediately after the existing null check,
so the diff is greppable and uniform:

```ts
const principal = await resolvePrincipal(app, request);
if (!principal) {
  return reply.code(401).send({ error: "admin authorization required" });
}
if (!hasRole(principal.role, "admin")) {
  return reply.code(403).send({ error: "insufficient role" });
}
```

> **Spike-snippet fidelity.** The policy SQL below is transcribed from Spike 1/1b, which ran
> against the real test database. Its stated assertions are: viewer INSERT → **named RLS error**;
> viewer UPDATE → **named RLS error** (only because the role test is in `WITH CHECK`, not `USING`);
> viewer DELETE → **silent `DELETE 0`**; viewer SELECT → **unaffected**; unset role → **permissive**;
> the role setting → **does not survive COMMIT**. If your implementation disagrees with any of
> these, the implementation is wrong, not the spike.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation — the role vocabulary

Pure, dependency-free, no DB. Everything later imports from here.

**Tasks:** the ordered role ladder, `hasRole`, the service sentinel, and the barrel export.

### Phase 2: Schema — grants table + the write backstop

The migration is **hand-authored** (drizzle-kit cannot emit `CREATE POLICY`), mirroring 0015's
convention. `project_grants` itself is drizzle-generated; the policies are appended by hand.

### Phase 3: Core — `withOrg` gains a role, repositories gain `orgId`

The two wide mechanical edits. Do the `withOrg` arity change **first** so `tsc` gives you the
complete call-site worklist, then the twelve repository signatures.

### Phase 4: Integration — route gates, throttle, approver identity

The 45 role gates, the reconcile throttle, and the catalog approver.

### Phase 5: Testing & validation

Unit tests for the ladder; two-role integration tests for both the policy backstop and the route
gate; the structural grep additions; the full gate with `--require-db`.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Each task is atomic and independently validated.

### 1. CREATE `packages/shared/src/roles.ts`

- **IMPLEMENT**: the ordered ladder and its predicate.

  ```ts
  /**
   * M15 15.4 — the four FIXED roles (D-M15-4). No user-defined roles: that is an M16
   * enterprise concern. TEXT, not a pg enum, matching `memberships.role` (schema.ts:87)
   * and every other closed set in this repo — adding a value is a code change, not a
   * migration.
   *
   * ORDERED, and the order is the whole point: gates express "admin or better" as a rank
   * comparison rather than enumerating `role === "admin" || role === "owner"`, which is
   * the form that silently omits `owner` when someone adds a rung.
   */
  export const ROLES = ["viewer", "member", "admin", "owner"] as const;
  export type Role = (typeof ROLES)[number];

  const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

  /**
   * The NON-PRINCIPAL role. Machine-authed writes (collector ingest/heartbeat/git/discover)
   * and the three deployment-wide maintenance ops have no request principal and therefore no
   * membership role, but they are legitimate writers. They pass this sentinel to `withOrg`.
   *
   * It is deliberately NOT a member of `Role`: it must never satisfy `hasRole`, so it can
   * never be mistaken for an authorization decision. The RLS backstop only asks
   * "is the context `viewer`?", so any non-viewer string permits the write.
   */
  export const SERVICE_ROLE = "service";

  /** True when `role` is at least `minimum` on the ladder. An unknown role fails CLOSED. */
  export function hasRole(role: string, minimum: Role): boolean {
    const actual = RANK[role as Role];
    return actual !== undefined && actual >= RANK[minimum];
  }

  /** Narrowing guard for values arriving from the database as plain TEXT. */
  export function isRole(value: string): value is Role {
    return (ROLES as readonly string[]).includes(value);
  }
  ```

- **PATTERN**: mirrors the closed-set-as-string-union style of
  `packages/shared/src/alerts.ts` (`AlertSeverity`) and `alert-firings.ts` (`AlertFiringStatus`).
- **GOTCHA**: `hasRole` must fail closed on an unknown string. `RANK[unknown]` is `undefined`, and
  `undefined >= 0` is `false` in JS — but only because of the explicit `!== undefined` guard;
  **do not** simplify it away, because `undefined >= 0` coerces to `NaN >= 0` → `false` by accident
  rather than by design, and a future `RANK` change could make that luck run out.
- **VALIDATE**: `npx vitest run packages/shared/src/roles.test.ts`

### 2. CREATE `packages/shared/src/roles.test.ts`

- **IMPLEMENT**: pure table-driven tests. Every rung satisfies itself and everything below it;
  no rung satisfies anything above it; `SERVICE_ROLE` satisfies **nothing**; unknown/empty/`"Admin"`
  (wrong case) all fail closed; `ROLES` order matches `RANK` order.
- **PATTERN**: `packages/shared/src/alerts.test.ts`.
- **VALIDATE**: `npx vitest run packages/shared/src/roles.test.ts`

### 3. UPDATE `packages/shared/src/index.ts`

- **IMPLEMENT**: re-export `ROLES`, `Role`, `SERVICE_ROLE`, `hasRole`, `isRole`.
- **PATTERN**: the existing barrel; follow its `export type` vs `export` split
  (`verbatimModuleSyntax` requires `export type` for type-only names).
- **VALIDATE**: `npm run typecheck`

### 4. ADD `projectGrants` to `packages/db/src/schema.ts`

- **IMPLEMENT**: place it immediately after `projects` so the tenancy tables stay grouped.

  ```ts
  /**
   * M15 15.4 — per-project capability ELEVATION (D-M15-4, D-15.4-2).
   *
   * Grants ADD capability; they never restrict it. Every member of an org already sees every
   * project in that org, so this table is empty in a solo install and behaviour is identical
   * to pre-15.4 (D-M15-10). A row raises ONE user's capability on ONE project:
   * effective role = max(org membership role, grant role).
   *
   * That direction is the load-bearing choice. The alternative — grants as the SOURCE of
   * visibility — forces a grants JOIN onto every project-scoped read and turns each RLS policy
   * into a correlated subquery, the exact shape D-M15-2 rejected for `events` on performance
   * grounds.
   *
   * `org_id` is carried (not merely reachable via `project_id`) so the row is coverable by the
   * same one-column policy as every other tenant table — a policy keyed through a join would
   * be that correlated subquery again.
   */
  export const projectGrants = pgTable(
    "project_grants",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull().references(() => organizations.id),
      projectId: uuid("project_id").notNull().references(() => projects.id),
      userId: uuid("user_id").notNull().references(() => users.id),
      role: text("role").notNull(), // viewer | member | admin | owner (D-M15-4)
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      uniqueIndex("project_grants_project_user").on(t.projectId, t.userId),
      index("project_grants_by_org").on(t.orgId),
      index("project_grants_by_user").on(t.userId),
    ],
  );
  ```

- **PATTERN**: `memberships` (schema.ts:77-94) — same `uniqueIndex` + `index` shape, same
  "TEXT not enum, no CHECK constraint" reasoning.
- **GOTCHA**: unique on `(project_id, user_id)`, **not** `(org_id, project_id, user_id)` — a
  project belongs to exactly one org, so adding `org_id` to the key would permit two grants for the
  same (project, user) pair under different orgs, which is unrepresentable and would only weaken
  the constraint.
- **VALIDATE**: `npm run typecheck`

### 5. GENERATE then HAND-EDIT the migration `packages/db/drizzle/0016_*.sql`

- **IMPLEMENT**: run `npm run db:generate` to emit the `project_grants` DDL, then **append by
  hand** the grant to the app role and the 36 restrictive policies. Header comment must mirror
  0015's (state that it is hand-authored and why).

  Append, for **each** of the 12 STRICT tables — `raw_source_records`, `events`, `projects`,
  `workspaces`, `workspace_keys`, `report_artifacts`, `git_commits`, `git_commit_files`,
  `session_git_links`, `machine_heartbeats`, `alert_firings`, `search_documents` — **plus the new
  `project_grants`** (13 tables × 3 = **39 policies**):

  ```sql
  -- M15 15.4 — the ROLE WRITE BACKSTOP (D-15.4-3). RESTRICTIVE, so these AND with the 15.3
  -- org policies rather than replacing them: the tenancy layer 0015 proved is UNTOUCHED here.
  --
  -- Three policies, not one, because Postgres treats the write commands differently and Spike 1
  -- measured exactly how:
  --   INSERT -> WITH CHECK  -> raises "new row violates row-level security policy" (LOUD)
  --   UPDATE -> WITH CHECK  -> also LOUD. Using USING here instead would silently report
  --                            "UPDATE 0", which is a far worse failure to debug.
  --   DELETE -> USING only  -> Postgres has NO WITH CHECK for DELETE, so a blocked delete is
  --                            unavoidably a silent "DELETE 0". The route gate is the loud
  --                            layer; this is only the backstop.
  --
  -- NO restrictive policy FOR SELECT, on purpose: a viewer is entitled to READ their own org,
  -- so a role predicate on SELECT would buy nothing the org policy does not already give while
  -- making every read more expensive.
  --
  -- The coalesce default is PERMISSIVE ('member') and that is deliberate: machine-authed writes
  -- and the deployment-wide maintenance ops pass SERVICE_ROLE, and any non-'viewer' value must
  -- permit the write. Failing closed on an unset role would 500 every collector ingest.
  CREATE POLICY "events_role_write_ins" ON "events" AS RESTRICTIVE FOR INSERT
    WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
  CREATE POLICY "events_role_write_upd" ON "events" AS RESTRICTIVE FOR UPDATE
    WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
  CREATE POLICY "events_role_write_del" ON "events" AS RESTRICTIVE FOR DELETE
    USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
  ```

  `project_grants` additionally needs the 15.3-style **org** policy (it is a new tenant table):

  ```sql
  ALTER TABLE "project_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
  ALTER TABLE "project_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
  CREATE POLICY "project_grants_org_isolation" ON "project_grants" USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
  ```

- **PATTERN**: `packages/db/drizzle/0015_shiny_iron_man.sql` — same `--> statement-breakpoint`
  separator, same comment density, same `nullif(...,'')` guard.
- **GOTCHA 1**: `0015` already ran `ALTER DEFAULT PRIVILEGES … GRANT … ON TABLES TO "420ai_app"`
  with no `FOR ROLE` clause, which applies to objects created by the role running the migration
  (`420ai`, the owner) — i.e. this one. So `project_grants` is granted **automatically**. Add an
  explicit `GRANT` anyway as a belt-and-braces line; it is idempotent and costs nothing, and 0015's
  own comment calls the default-privileges mechanism "a time-bomb that would surface in a later
  slice" — this is that later slice, and the assertion is cheap.
- **GOTCHA 2**: do **not** modify the existing 15 permissive policies. Restrictive policies combine
  with `AND` automatically; editing the permissive ones risks regressing 15.3's proof.
- **GOTCHA 3**: `\set ON_ERROR_STOP` is a psql-ism — never put it in a drizzle migration.
- **VALIDATE**:
  `npm run db:migrate && MSYS_NO_PATHCONV=1 docker exec -i 420ai-archive psql -U 420ai -d 420ai -tAc "select count(*) from pg_policies where schemaname='public'"`
  → expect **55** (15 pre-existing + 1 new org policy + 39 restrictive).

### 6. CREATE `packages/db/drizzle/down/0016_*.down.sql`

- **IMPLEMENT**: `DROP POLICY IF EXISTS` for all 40 new policies, then
  `ALTER TABLE project_grants DISABLE ROW LEVEL SECURITY`, then `DROP TABLE project_grants`.
- **PATTERN**: `packages/db/drizzle/down/0015_shiny_iron_man.down.sql` — read it and mirror the
  ordering discipline exactly (policies before table drops).
- **GOTCHA**: D-M15-13 requires the rollback drill on a **copy of the real archive**. Unlike 0014,
  0016's down does not drop a column carrying data (`project_grants` is empty in a solo install),
  so this drill is cheap — but it is still on the pre-sign-off checklist.
- **VALIDATE**: `npm run db:rollback && npm run db:migrate` — both exit 0; policy count returns to
  55 after the re-up.

### 7. UPDATE `packages/db/src/org-context.ts` — `withOrg` takes a role

- **IMPLEMENT**: a **required** fourth parameter, set as a second transaction-local.

  ```ts
  /** The transaction-local role setting the 15.4 restrictive policies read. */
  export const ROLE_SETTING = "app.current_role";

  export async function withOrg<T>(
    db: Db,
    orgId: string,
    role: string,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    if (!orgId.trim()) {
      throw new Error("withOrg requires a non-empty orgId — a blank org context is not scoping");
    }
    // M15 15.4: a blank ROLE is rejected for the mirror-image reason a blank org is. The
    // policies coalesce '' to 'member' (permissive, so machine writes work), which means a
    // blank role silently grants WRITE capability to a caller whose real role may be viewer.
    // Callers with no membership role pass SERVICE_ROLE explicitly; nobody passes "".
    if (!role.trim()) {
      throw new Error("withOrg requires a non-empty role — pass SERVICE_ROLE for machine paths");
    }
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_org', ${orgId}, true)`);
      await tx.execute(sql`SELECT set_config('app.current_role', ${role}, true)`);
      return fn(tx);
    });
  }
  ```

- **PATTERN**: the existing function — **preserve its entire header comment** (the `SET LOCAL`
  rejection, the pooled-connection leak, the `Db`-not-`DbClient` note) and extend it rather than
  replacing it.
- **IMPORTS**: none new in this file; `SERVICE_ROLE` is imported by the *callers*, from
  `@420ai/shared`.
- **GOTCHA**: two `tx.execute` calls, sequentially awaited — **not** `Promise.all`. A transaction is
  one connection; node-postgres queues concurrent queries on it and emits a deprecation warning
  (removed in `pg@9`). This is the same lesson `monitor.ts:61-66` records.
- **VALIDATE**: `npm run typecheck` — expect **~63 errors**, one per call site. That list *is* your
  worklist for task 8. Capture it: `npm run typecheck 2>&1 | grep -c "error TS"`.

### 8. UPDATE all 63 `withOrg` call sites

- **IMPLEMENT**: pass the correct role at each site. The rule:
  - **Principal-authed handlers** → `principal.role`.
  - **Machine-authed writes** (`ingest.ts`, `heartbeat.ts`, `git.ts` capture, `workspaces.ts`
    discover) → `SERVICE_ROLE`.
  - **Deployment-wide maintenance loops** (`replay.ts`, `search.ts` per-org loops) → `SERVICE_ROLE`.
  - **Repository-internal** (`alert-firings.ts` `deliverPendingFirings` / `deliverResolvedFirings`,
    `reports.ts`) → these take an explicit `role` parameter threaded from their caller; do **not**
    hardcode. Alert delivery is a background-ish write on behalf of the org, so its route caller
    (`monitor.ts` `deliverFirings`) passes `SERVICE_ROLE` — a viewer merely *viewing* the monitor
    must not suppress the org's outbound alerts.
- **PATTERN**: the 17 files listed by `grep -rln "withOrg(" --include=*.ts apps/*/src packages/*/src`.
- **GOTCHA**: the `deliverFirings` decision above is subtle and load-bearing. Delivery is triggered
  by whoever happens to load the monitor, but the *action* belongs to the org, not the viewer. If
  you pass `principal.role` there, an org whose only active user is a viewer silently stops
  delivering every webhook and email — reviving exactly the class of bug the 15.3 code review
  caught (`alert_firings` reads returning zero with no error, no log, and a 200 response).
- **VALIDATE**: `npm run typecheck` → 0 errors. Then the grep pair (the CLAUDE.md rule that `tsc`
  alone is not proof):
  `grep -rn "withOrg(" --include=*.ts apps/*/src packages/*/src | grep -v "\.test\.ts" | grep -vc "SERVICE_ROLE\|\.role\|role," ` → expect **0**.

### 9. UPDATE the twelve `userId`-only repository reads

- **IMPLEMENT**: add `orgId` as the **second** parameter and an `eq(<table>.orgId, orgId)`
  predicate alongside the existing `userId` predicate (both, never one — D-M15-3 keeps application
  scoping as the primary and the org predicate is what makes it total).

  | File | Function | New signature |
  | --- | --- | --- |
  | `repositories/monitor.ts` | `machineStatuses` | `(db, orgId, userId)` |
  | | `activeSessions` | `(db, orgId, userId, sinceIso)` |
  | | `recentBacklogSamples` | `(db, orgId, userId, since)` |
  | `repositories/projections.ts` | `connectorHealth` | `(db, orgId, userId)` |
  | | `connectorHealthWindowed` | `(db, orgId, userId, sinceIso)` |
  | `repositories/projects.ts` | `listProjects` | `(db, orgId, userId, page?)` |
  | | `createProject` | `(db, orgId, userId, name, gitRemote?)` |
  | `repositories/workspaces.ts` | `listWorkspaces` | `(db, orgId, userId)` |
  | | `remapWorkspace` | `(db, orgId, userId, workspaceId, projectId)` |
  | | `resolveWorkspaceId` | `(db, orgId, userId, projectKey)` |
  | `repositories/git.ts` | `gitCommitDetail` | `(db, orgId, userId, commitSha)` |
  | `repositories/alert-firings.ts` | `listAlertFirings` | `(db, orgId, userId, now)` |

- **GOTCHA 1 — `connectorHealthWindowed` is a TWELFTH read the milestone plan does not name.** The
  PR #63 review listed eleven; `connectorHealthWindowed` (`projections.ts:353`) has the identical
  `(db, userId, sinceIso)` shape as `connectorHealth` and the identical defect. Convert it too.
- **GOTCHA 2 — `createProject` already resolves an org internally** via
  `getOrgIdForUser(db, userId)` (`projects.ts:85`), as does `findOrCreateProjectByRemote`. Both are
  reached **only** from the machine-authed discover path, and `organizations.ts:23-27` documents
  that this survival is deliberate. Adding an explicit `orgId` parameter to `createProject` means
  the caller must now supply it — for the discover path that value is exactly
  `getOrgIdForUser(db, userId)` resolved *once* at the route, which is strictly better (one query
  instead of one per project). Do **not** delete `getOrgIdForUser`; `findOrCreateProjectByRemote`,
  `upsertWorkspace` and `addWorkspaceKey` still need it, and `createPairingCode` must keep it
  (D-15.2-5: it writes a row for a TARGET user who may not be the caller).
- **GOTCHA 3 — the join-based reads scope through `machines`.** `activeSessions`,
  `recentBacklogSamples`, `connectorHealth*` and `gitCommitDetail` all reach the user via
  `innerJoin(machines, …)`. Put the org predicate on the **fact** table where one exists
  (`events.orgId`, `machineHeartbeats.orgId`, `gitCommits.orgId`) **and** on `machines.orgId`.
  This is the 15.2 lesson stated verbatim in CLAUDE.md: *"The org predicate on the FACT table gives
  isolation, not ownership"* — you need both sides of the join scoped, or one tenant gets a
  non-empty rollup of its own rows attributed through another tenant's machine.
- **GOTCHA 4 — do NOT "fix" the aggregate timestamps while you are in these files.** See NOTES:
  `projectEventSummary.lastActivity` and `connectorHealth.lastEventAt` return unnormalized Postgres
  text. It is a real, confirmed, pre-existing wire-contract bug — and it is **out of scope**. Fixing
  it here would mix a behaviour change into a security slice and muddy the review lens. Log it.
- **VALIDATE**: `npm run typecheck` → 0 errors; then
  `npx vitest run packages/db/src/repositories`

### 10. UPDATE the call sites of those twelve reads

- **IMPLEMENT**: thread `principal.orgId` through. Highest-traffic caller is
  `apps/ingest/src/routes/monitor.ts` `buildSnapshot`, which already receives `orgId` — pass it on.
- **PATTERN**: `monitor.ts:67-76`, the sequential-await block.
- **GOTCHA**: keep the awaits sequential. Do not "optimize" them into `Promise.all` — see the
  comment at `monitor.ts:61-66`.
- **VALIDATE**: `npm run typecheck && npx vitest run apps/ingest`

### 11. CREATE `packages/db/src/repositories/project-grants.ts`

- **IMPLEMENT**: `ProjectGrantRow` + `projectGrantRowColumns` + `listProjectGrants(db, orgId,
  projectId)`, `grantProjectRole(db, orgId, projectId, userId, role)` (upsert on the unique index),
  `revokeProjectGrant(db, orgId, projectId, userId)`, and the resolver:

  ```ts
  /**
   * The effective capability a user has on ONE project: the HIGHER of their org membership role
   * and any project grant (D-15.4-2 — grants ELEVATE, never restrict). No grant row ⇒ the org
   * role, unchanged, which is why a solo install behaves exactly as it did before 15.4.
   */
  export async function effectiveProjectRole(
    db: DbClient,
    orgId: string,
    projectId: string,
    userId: string,
    orgRole: string,
  ): Promise<string> {
    const [row] = await db
      .select({ role: projectGrants.role })
      .from(projectGrants)
      .where(
        and(
          eq(projectGrants.orgId, orgId),
          eq(projectGrants.projectId, projectId),
          eq(projectGrants.userId, userId),
        ),
      )
      .limit(1);
    if (!row) return orgRole;
    return hasRole(row.role, orgRole as Role) ? row.role : orgRole;
  }
  ```

- **PATTERN**: `repositories/organizations.ts` (silent, `DbClient` not `Db` so it composes inside a
  caller's transaction) and `projects.ts` for the explicit column list.
- **IMPORTS**: `import { hasRole, type Role } from "@420ai/shared";`
- **GOTCHA**: `DbClient`, not `Db` — every caller reaches it inside an existing `withOrg`
  transaction, and `project_grants` carries a strict org policy, so an unwrapped call reads zero
  rows and silently reports "no grant" (which degrades to the org role — safe, but invisible).
- **VALIDATE**: `npx vitest run packages/db/src/repositories/project-grants.int.test.ts`

### 12. UPDATE `packages/db/src/index.ts`

- **IMPLEMENT**: export the grant repo functions, `ProjectGrantRow`, `ROLE_SETTING`, `projectGrants`.
- **VALIDATE**: `npm run typecheck`

### 13. CREATE the route gate helper in `apps/ingest/src/auth.ts`

- **IMPLEMENT**: keep `resolvePrincipal` exactly as-is (do not fold authorization into it — the
  401 and 403 paths are different decisions and the 45 sites read better with both visible), and add:

  ```ts
  /**
   * M15 15.4 — the ROUTE-LAYER authorization gate (D-M15-4). The PRIMARY defence; the RLS
   * restrictive policies (migration 0016) are the backstop behind it, and they only cover
   * WRITES and only fire loudly for INSERT/UPDATE. So this must be complete on its own:
   * a missed gate on a DELETE path is silent at both layers.
   *
   * Deliberately NOT folded into resolvePrincipal: 401 (who are you?) and 403 (you may not)
   * are different answers, and keeping the two `if` blocks adjacent at every call site is
   * what makes the grep in org-scoping.test.ts able to see them.
   */
  export function authorized(principal: Principal, minimum: Role): boolean {
    return hasRole(principal.role, minimum);
  }
  ```

- **IMPORTS**: `import { hasRole, type Role } from "@420ai/shared";` and the existing
  `type Principal` import from `@420ai/db`.
- **GOTCHA**: `Principal.role` is typed `string` (`principal.ts:21`), not `Role` — it comes from a
  TEXT column with no CHECK constraint. Do not cast it; `hasRole` takes `string` and fails closed,
  which is the correct handling for a row someone edited by hand.
- **VALIDATE**: `npx vitest run apps/ingest/src/authorize.test.ts`

### 14. UPDATE all 45 route gates with the role check

- **IMPLEMENT**: add the `authorized(...)` check per the matrix below, using the exact snippet
  shape from "Patterns to Follow".

  | Minimum role | Endpoints |
  | --- | --- |
  | **viewer** (any member) | `GET /v1/auth/me` · `GET /v1/monitor` · `GET /v1/monitor/stream` · `GET /v1/projects` · `GET /v1/projects/:id/{summary,usage,usage/by-model,usage/over-time,sessions,git,git/commits,git/links}` · `GET /v1/sessions/:sessionId` · `GET /v1/reports` · `GET /v1/reports/:id` · `GET /v1/search` · `GET /v1/workspaces` · `GET /v1/connectors/health` · `GET /v1/exports/*` (3) · `GET /v1/catalog` · `GET /v1/connector-catalog` |
  | **member** | `POST /v1/projects` · `PATCH /v1/projects/:id` · `PATCH /v1/workspaces/:id` · `POST /v1/projects/:id/reports` · `POST /v1/sessions/:sessionId/reports` · `POST /v1/projects/:id/interpretations` · `POST /v1/sessions/:sessionId/interpretations` · `POST /v1/alerts/firings/:id/ack` · `POST /v1/sessions/:sessionId/git-link` · `PATCH /v1/git/links/:id` |
  | **admin** | `POST /v1/catalog` · `POST /v1/catalog/:id/{approve,reject}` · `POST /v1/connector-catalog` · `POST /v1/connector-catalog/:id/{approve,reject}` · `POST /v1/pairing-codes` · `POST /v1/replay/reprice` · `POST /v1/replay/reparse` · `POST /v1/search/reindex` · `GET /v1/metrics` |
  | **(none — machine-authed)** | `POST /v1/ingest` · `POST /v1/heartbeat` · `POST /v1/git` · `POST /v1/pair` · `POST /v1/workspaces/discover` · `GET /v1/connector-catalog/active` · `GET /v1/health` |

- **GOTCHA 1**: `GET /v1/auth/me` gates at `viewer` — i.e. any resolved principal. It must **not**
  gate higher: a viewer needs to know who they are to render the dashboard at all.
- **GOTCHA 2**: `GET /v1/monitor/stream` — the role check must run **before** `reply.hijack()`,
  with the other guards (D7, `monitor.ts:171`). After hijack the error handler no longer applies and
  a 403 cannot be sent.
- **GOTCHA 3**: the three interpretation/report **generate** endpoints are billable-call paths. They
  gate at `member`, not `viewer` — a read-only account must not be able to spend money.
- **GOTCHA 4**: `POST /v1/pairing-codes` gates at `admin`. It writes a row for a **target** user
  (D-15.2-5) and is the account-pre-seeding primitive audit C.9 flagged; 15.5 closes it entirely,
  but until then it must not be reachable by a member.
- **VALIDATE**: `npm run typecheck && npx vitest run apps/ingest` and the completeness grep in
  task 19.

### 15. UPDATE `routes/catalog.ts` + `routes/connector-catalog.ts` — real approver identity

- **IMPLEMENT**: replace the hardcoded `"admin"` approver with `principal.email`
  (`catalog.ts:68` and the connector-catalog twin).
- **PATTERN**: the surrounding `resolvePrincipal → isUuid → repo → undefined→404` ladder; do not
  disturb it.
- **GOTCHA**: these two files are on `ALLOWED_WITHOUT_WITHORG` (`org-scoping.test.ts:45-46`) because
  the catalogs are deployment-global with no `org_id` and no policy (D-M15-9). Adding a role gate
  does **not** change that — do not wrap them in `withOrg`, and do not remove their allow-list
  entries.
- **VALIDATE**: `npx vitest run apps/ingest/src/catalog.int.test.ts apps/ingest/src/connector-catalog.int.test.ts`

### 16. ADD the reconcile throttle (audit B.4)

- **IMPLEMENT**: three parts.
  1. In `apps/ingest/src/app.ts`: `const DEFAULT_RECONCILE_THROTTLE_MS = 30_000;` and
     `app.decorate("reconcileThrottleMs", opts.reconcileThrottleMs ?? DEFAULT_RECONCILE_THROTTLE_MS)`
     plus `app.decorate("reconcileLastRunAt", new Map<string, number>())`.
  2. In `apps/ingest/src/plugins/auth.ts`: add both to the `declare module "fastify"` block, with
     a doc comment matching the style of the `monitorStreamIntervalMs` entry.
  3. In `routes/monitor.ts` `buildSnapshot`: take a `reconcile: boolean` argument. When `true`, call
     `reconcileAlertFirings` as today; when `false`, call `listAlertFirings(db, orgId, userId, now)`
     instead. The route decides:

  ```ts
  // M15 15.4 (audit B.4) — the reconcile is a WRITE (an upsert per derived alert plus a bulk
  // update). 15.3 made every SSE tick a transaction, so before this throttle a single connected
  // dashboard produced that write every 3 s, forever, per org. Alert state does not change
  // meaningfully at 3 s granularity, so we reconcile at most once per reconcileThrottleMs and
  // serve the persisted firing list in between — the frame the client receives is identical in
  // shape either way.
  //
  // The map is keyed on org+user (the same grain as the firing rows themselves) and lives on the
  // app, so it is per-process and resets on restart. That is fine: a missed throttle window costs
  // one extra reconcile, never a wrong result.
  const key = `${principal.orgId}:${userId}`;
  const last = app.reconcileLastRunAt.get(key) ?? 0;
  const reconcile = now.getTime() - last >= app.reconcileThrottleMs;
  if (reconcile) app.reconcileLastRunAt.set(key, now.getTime());
  ```

- **PATTERN**: `app.decorate("metrics", createMetrics(Date.now()))` (`app.ts:129`) — an in-memory
  per-process store on the app, injectable for tests.
- **GOTCHA 1**: the throttle must be **injectable and settable to 0** so existing tests that assert
  firing reconciliation still work deterministically. Every current test that expects a firing to
  appear on the first `GET /v1/monitor` must keep passing — with `0`, every tick reconciles, which
  is today's behaviour exactly.
- **GOTCHA 2**: set the timestamp **before** the await, not after, or two overlapping requests both
  see a stale `last`. (The SSE path's `inFlight` guard prevents this within one stream, but two
  browser tabs are two streams.)
- **GOTCHA 3**: `listAlertFirings` now takes `orgId` (task 9) — use the new signature.
- **GOTCHA 4**: do not touch the `inFlight` guard, the `closed` guard, the close-listener ordering
  or the `clearInterval`. Those are the M9 long-lived-resource lesson and the M15 15.3 deadlock fix
  (`monitor.ts:191-203, 242-245`).
- **VALIDATE**: `npx vitest run apps/ingest/src/observability.int.test.ts apps/ingest/src/delivery.int.test.ts`

### 17. UPDATE `packages/db/src/repositories/alert-firings.ts` — finish the org scoping

- **IMPLEMENT**: `listAlertFirings` gains `orgId`; `reconcileAlertFirings`'s bulk-resolve `UPDATE`
  (currently `eq(alertFirings.userId, userId)` only, line 141-147) gains `eq(alertFirings.orgId,
  orgId)`; its `listAlertFirings` call (line 148) passes `orgId`.
- **GOTCHA**: leave the `onConflictDoUpdate` `set:` block **without** `orgId` (line 131-133). That
  omission is deliberate and load-bearing — an existing open firing keeps the org it was opened
  under, mirroring the ingest upsert (D-M15-2). Do not "complete" it.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/alert-firings.int.test.ts`

### 18. CREATE `apps/ingest/src/rbac.int.test.ts` — the slice's proof

- **IMPLEMENT**: a **two-role, multi-user** suite. Mirror `apps/ingest/src/rls.int.test.ts`
  lines 106–205 exactly for the harness, then diverge:
  - `beforeAll`: `owner = createDb(TEST_URL!)`, `appRole = createDb(APP_URL!)`,
    `app = buildApp({ db: appRole.db, … , reconcileThrottleMs: 0 })`.
  - **Test 1 — role identity** (non-negotiable, first test in the file): assert
    `current_setting('is_superuser') = 'off'` AND `rolbypassrls = false` AND
    `current_user = '420ai_app'` on the app handle. Copy from
    `packages/db/src/repositories/rls.int.test.ts:170-184`. Without it the file is theatre.
  - `beforeEach`: seed **two users in ONE org** (this is the configuration that has never existed
    before and is the whole point):
    ```ts
    userOwner = await setUserPassword(owner.db, "owner@example.com", hashPassword(PASSWORD));
    userViewer = await setUserPassword(owner.db, "viewer@example.com", hashPassword(PASSWORD));
    orgA = await ensurePersonalOrg(owner.db, userOwner, "owner@example.com");
    // ensurePersonalOrg gives 'owner'; add the SECOND member explicitly at a lower rung.
    await owner.db.insert(memberships).values({ orgId: orgA, userId: userViewer, role: "viewer" });
    ```
  - Then, using `login()` (line 139) and `asUser()` (line 150):
    1. a **viewer GET** succeeds (200) — reads are unaffected by role;
    2. a **viewer POST `/v1/projects`** is **403**;
    3. a **viewer POST `/v1/replay/reparse`** is **403**;
    4. a **member POST `/v1/projects`** is 200 and a **member POST `/v1/search/reindex`** is 403;
    5. an **admin** may approve a catalog and the stored `approved_by` is **their email**, not
       `"admin"`;
    6. **the backstop, with the route gate bypassed** — call `withOrg(appRole.db, orgA, "viewer",
       tx => tx.insert(projects)…)` directly and assert an RLS rejection using the `errorChain` /
       `expectRlsRejection` helpers (`repositories/rls.int.test.ts:67-87`). This is the test that
       proves the second layer exists;
    7. **the silent DELETE**: `withOrg(…, "viewer", tx => tx.delete(alertFirings)…)` affects
       **0 rows** and does **not** throw — assert the silence explicitly, so nobody later "fixes"
       it into an expectation of an error that Postgres cannot produce;
    8. **the two members see the SAME org data** — the regression this slice's org-predicate work
       exists to prevent. Seed a machine owned by `userOwner`, then assert `GET /v1/monitor` as
       `userViewer` lists it. Under the old `userId`-only `machineStatuses` this returns empty.
  - **A per-org firing fan-out test**: two orgs both pending the same catalog approval each get
    their own `catalog.update_requires_approval` firing (D-M15-6 — confirm the existing behaviour
    rather than assuming it).
- **PATTERN**: `apps/ingest/src/rls.int.test.ts` throughout.
- **GOTCHA 1**: `describe.skipIf(!TEST_URL || !APP_URL)` — mandatory, or `npm test` breaks without
  Docker.
- **GOTCHA 2**: `afterAll` must `await app.close()` **and** end **both** pools, or vitest hangs on
  an open handle (`rls.int.test.ts:133-137`).
- **GOTCHA 3**: test 8 is the one that fails **before** task 9 and passes after. Write it first and
  watch it fail — a test that never failed proves nothing.
- **VALIDATE**: `npx vitest run apps/ingest/src/rbac.int.test.ts`

### 19. UPDATE `apps/ingest/src/routes/org-scoping.test.ts` — extend the structural net

- **IMPLEMENT**: add a test asserting that **every route file containing `resolvePrincipal` also
  contains `authorized(`**, with the same explicit, commented allow-list shape the file already
  uses. Allow-list only `auth.ts` (the login route itself issues the credential) and `health.ts`.
- **PATTERN**: the existing `it("each principal-authed handler file that reads tenant data calls
  withOrg")` block (lines 104–116) — copy its structure verbatim.
- **GOTCHA**: state the **same known limit** in a comment. This is file-granular too: one
  `authorized(` anywhere exempts the whole file, and a file with four handlers and one gate passes.
  That is precisely the `monitor.ts` blind spot the header already documents. The behavioural
  counterpart is `rbac.int.test.ts` — reference it by name, as the existing comment does for
  `rls.int.test.ts` test 9.
- **VALIDATE**: `npx vitest run apps/ingest/src/routes/org-scoping.test.ts`

### 20. UPDATE `packages/db/src/repositories/rls.int.test.ts` — fix the policy inventory test

- **IMPLEMENT**: re-key test 8 (lines 406–429) on `(tablename, policyname)`, and add assertions for
  the new layer: each of the 13 tables carries exactly 3 restrictive policies; no restrictive policy
  exists `FOR SELECT`; `project_grants` carries the strict org policy. Query
  `pg_policies.permissive` (`'PERMISSIVE'` / `'RESTRICTIVE'`) and `pg_policies.cmd`.
- **GOTCHA**: the current `new Map(rows.map(r => [r.tablename, r.qual]))` **silently collapses**
  duplicate table names, so `byTable.size` would still read 15 after this migration while `qual`
  became an arbitrary one of four policies. The test would stay green and mean nothing — the exact
  failure mode this file exists to prevent. Fix the keying; do not merely bump the expected number.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/rls.int.test.ts`

### 21. UPDATE the dashboard for 403

- **IMPLEMENT**: **CONFIRMED during planning** — `apps/dashboard/src/lib/proxy.ts:39` forwards
  `res.status` verbatim (`// forward 400/401/404 so the UI can react`), so a 403 reaches the browser
  unchanged and **no proxy change is needed**. The work is UI-only: ensure the mutation components
  surface 403 as a readable refusal rather than a silent no-op. Every mutation already checks
  `res.ok` (the 12.2b convention), so the minimum is a distinguishable message for 403.
- **GOTCHA (proxy asymmetry)**: `proxyStream` (`proxy.ts:69`) forwards `upstream.status || 502`, but
  the **monitor** proxy deliberately collapses everything to 502 (`proxy.ts:20-21`). That is
  harmless here only because `GET /v1/monitor/stream` gates at `viewer` — every member can read it,
  so it never returns 403. If a later slice raises that gate, the dashboard would show "ingest down"
  for what is actually a permission refusal.
- **GOTCHA**: no `ADMIN_TOKEN` may appear in served HTML — the standing assertion. Adding role UI
  must not introduce a `NEXT_PUBLIC_*` leak.
- **VALIDATE**: `npm run typecheck:dashboard && npm run build:dashboard`

### 22. UPDATE documentation + invariants

- **IMPLEMENT**:
  - `docs/guide/operations.md` — the four roles and what each may do; **D-15.4-5** (connector
    approval is machine-local, not org RBAC, with the reasoning); the `app.current_role` context.
  - `apps/collector/src/connectors/connector-approvals.ts` header — record D-15.4-5 where the next
    reader will be.
  - `CLAUDE.md` — add the 15.4 lesson to the "Validation is a GATE" section: *a RESTRICTIVE RLS
    policy blocks INSERT/UPDATE loudly but filters DELETE silently, so a role backstop is not a
    substitute for a complete route gate; and a `pg_policies` assertion keyed on `tablename` alone
    silently collapses multiple policies per table.*
  - `SUMMARY.md` — flip **15.4** to ✅ with a one-line "DONE `<date>` (PR #NN)" note in **both** the
    §0 status block and the §6 roadmap. **Same commit** as the execution report (CLAUDE.md makes
    this a gate, check 5, not an honour-system step).
- **VALIDATE**: `node scripts/check-summary.mjs`

---

## TESTING STRATEGY

### Unit Tests

- `packages/shared/src/roles.test.ts` — the ladder, exhaustively. Table-driven over all
  4 × 4 (role, minimum) pairs plus the failure inputs (`""`, `"Admin"`, `"root"`, `SERVICE_ROLE`).
- `apps/ingest/src/authorize.test.ts` — `authorized()` over a synthetic `Principal`.
- Existing `monitor` / `alert-firings` unit tests must keep passing unchanged.

### Integration Tests

All `*.int.test.ts`, gated on `DATABASE_URL_TEST`; the two-role files additionally on
`DATABASE_URL_TEST_APP`.

- `apps/ingest/src/rbac.int.test.ts` — **the proof** (task 18). Two users, one org, both layers.
- `packages/db/src/repositories/project-grants.int.test.ts` — grant upsert idempotence; a grant
  ELEVATES but never demotes (`effectiveProjectRole` with a `viewer` grant and an `admin` org role
  returns `admin`); cross-org grant reads return nothing under the app role.
- `packages/db/src/repositories/rls.int.test.ts` — updated inventory (task 20).

### Edge Cases

Each must have a named test:

1. **Unset role ⇒ writes permitted.** The machine-authed ingest path passes `SERVICE_ROLE`; a
   context with no role at all (a legacy/unconverted caller) must still write, or every collector
   breaks. Proven by Spike 1 step 1; pin it.
2. **Viewer DELETE is silent.** `DELETE 0`, no throw. Asserted explicitly (task 18.7).
3. **Viewer SELECT unaffected.** A role-gated write policy must not degrade any read.
4. **Unknown role string fails closed.** A hand-edited `memberships.role = 'superadmin'` grants
   nothing (`hasRole` returns false) — but the RLS backstop treats it as non-viewer and permits
   writes. **State this asymmetry in a test comment**: the route layer is the strict one; the
   backstop only ever asks "is this a viewer?".
5. **Role context does not leak across pooled checkouts.** The 15.0 Finding-3 shape, for the new
   setting. Proven by Spike 1 step 9 and Spike 3(b); pin it in `org-context.test.ts`.
6. **`withOrg` rejects a blank role**, mirroring the blank-org rejection.
7. **Two members of one org see the same data** (task 18.8) — the org-predicate regression test.
8. **Alert delivery survives a viewer-only org** — the `SERVICE_ROLE` decision in task 8. Assert a
   firing is delivered when the only user loading the monitor is a viewer.
9. **Throttle correctness** — with `reconcileThrottleMs: 60_000`, two consecutive `GET /v1/monitor`
   calls produce one reconcile; the second still returns the full firing list.

---

## VALIDATION COMMANDS

All runnable from the repo root. Every one is a **gate**.

### Level 1: Syntax & Style

```sh
npm run typecheck          # root `tsc -b` — MUST exit 0. Per-workspace build is NOT a substitute.
npm run typecheck:dashboard
npm run lint               # NOT part of repo-health; CI runs it (memory: ci-lint-not-in-repo-health)
npm run format:check       # CI lints .md too (memory: ci-prettier-checks-markdown)
```

Pass signal: all exit 0.

### Level 2: Unit Tests

```sh
npx vitest run packages/shared/src/roles.test.ts
npx vitest run apps/ingest/src/authorize.test.ts
npx vitest run apps/ingest/src/routes/org-scoping.test.ts
npm test                   # full vitest run; integration self-skips without a DB
```

Pass signal: 0 failures. Note the suite stood at **743+** tests entering M15; it must only grow.

### Level 3: Integration Tests — MUST ACTUALLY RUN

```sh
npm run db:up
npm run db:migrate
npm run db:provision-app-role                 # required: without it DATABASE_URL_TEST_APP is dead
# The test DB is migrated SEPARATELY from the dev DB (memory: test-db-not-migrated-by-db-migrate)
npm run repo-health -- --require-db
```

Pass signal: green **with 0 skipped**. A plain `repo-health` PASS does **not** prove this layer ran
(`skipped ≠ passed`), and an owner-only run does not prove the policies enforce
(`bypassed ≠ enforced`). `--require-db` asserts both — it already checks the RLS role is
non-bypassing.

Explicitly required evidence for sign-off: **"ran the gate with the test DB up; the `*.int.test.ts`
layer executed (N tests, 0 skipped), including `rbac.int.test.ts` and `rls.int.test.ts` on the
non-owner role."**

### Level 4: Manual Validation

1. **Prove the negative test can fail.** Temporarily replace one restrictive policy with
   `WITH CHECK (true)` and re-run `rbac.int.test.ts` — the backstop tests must go **red**. Restore
   it. (The 15.3 corollary: verify a negative test fails with the policy removed, and remove it the
   RIGHT way — replacing with `true`, not dropping, because dropping while RLS stays enabled makes
   Postgres deny everything and the tests fail for the wrong reason.)
2. **Live 403.** With the stack running, log in as a seeded viewer and confirm the dashboard shows a
   readable refusal on a mutation rather than a silent no-op.
3. **Rollback drill** (D-M15-13): `npm run db:rollback && npm run db:migrate` on a copy of the real
   archive; policy count returns to 55.
4. **`grep -c "$ADMIN_TOKEN"` on served page source == 0** — the standing assertion.

### Level 5: Additional Validation

```sh
# Policy inventory, live:
MSYS_NO_PATHCONV=1 docker exec -i 420ai-archive psql -U 420ai -d 420ai_test \
  -c "select tablename, policyname, permissive, cmd from pg_policies where schemaname='public' order by tablename, policyname"
# Completeness greps (tsc is not proof — CLAUDE.md):
grep -rn "resolvePrincipal" --include=*.ts apps/ingest/src/routes | grep -v test | wc -l   # 45
grep -rn "authorized(" --include=*.ts apps/ingest/src/routes | grep -v test | wc -l        # 43 (45 − auth.ts − health.ts)
```

---

## ACCEPTANCE CRITERIA

- [ ] Four roles enforced at the route layer across all 45 principal gates, per the matrix
- [ ] `project_grants` table ships; grants ELEVATE and never demote (`effectiveProjectRole` tested)
- [ ] RLS restrictive write-backstop live on 13 tables (39 policies); the 15 pre-existing org
      policies are **byte-identical** to before
- [ ] All **twelve** `userId`-only reads take `orgId` as their second parameter and filter on it
- [ ] Two members of one org see the same org data (the regression test fails before the change)
- [ ] Alert reconcile throttled off the SSE hot path; injectable; `0` reproduces today's behaviour
- [ ] Catalog approval records the real approver email, gated at `admin`
- [ ] D-15.4-5 (connector approval is machine-local) documented in `operations.md` + the source header
- [ ] `npm run repo-health -- --require-db` green with **0 skipped**
- [ ] `rbac.int.test.ts` test 1 asserts the app handle is non-superuser, non-bypassing
- [ ] Backstop tests proven to fail when a policy is neutralized to `WITH CHECK (true)`
- [ ] `SUMMARY.md` flipped to ✅ in **both** §0 and §6, in the same commit as the execution report
- [ ] No new dependency added
- [ ] No regression: full suite green, `build:dashboard` green

---

## COMPLETION CHECKLIST

- [ ] All 22 tasks completed in order
- [ ] Each task's validation ran immediately after it
- [ ] Level 1–3 commands all pass; Level 4 manual steps evidenced under `.agents/qa/m15-signoff/`
- [ ] Full suite passes (unit + integration, 0 skipped)
- [ ] No lint / typecheck / format errors
- [ ] Acceptance criteria all met
- [ ] `/lril:code-review` run before commit (it is the gate that has historically caught the
      long-lived-resource and unwrapped-handle classes `tsc` and tests cannot)

---

## NOTES

### Spikes ACTUALLY RUN during planning (with output)

**Spike 1 — the RLS role backstop** (`psql` against `420ai_test`, real app role, scratch table
mirroring a strict table; table dropped afterwards). Results:

| Step | Result |
| --- | --- |
| RLS enforced after `SET ROLE 420ai_app`? | **yes** — 0 rows with no context |
| Unset role, INSERT/UPDATE | **permitted** (`coalesce → 'member'`) — machine paths safe |
| Viewer SELECT | **2 rows** — reads unaffected |
| Viewer INSERT | `ERROR: new row violates row-level security policy "sp_no_viewer_ins"` |
| Viewer UPDATE (role test in `USING`) | **`UPDATE 0` — SILENT, no error** |
| Viewer DELETE (`USING`) | **`DELETE 0` — SILENT, no error** |
| Admin INSERT | permitted |
| Cross-org INSERT under `member` | still rejected by the **unchanged** org policy |
| `app.current_role` after COMMIT | `[]` — does not leak |

**Spike 1b — making UPDATE loud.** Moving the role test from `USING` to `WITH CHECK` changed the
viewer UPDATE result from a silent `UPDATE 0` to
`ERROR: new row violates row-level security policy "sp2_no_viewer_upd"`, with member UPDATE still
`UPDATE 1`. **This is why the migration uses `WITH CHECK` for INSERT and UPDATE, and `USING` only
for DELETE** — Postgres has no `WITH CHECK` for DELETE, so that one silence is unavoidable and is
called out in the tests rather than hidden.

**Spike 2 — the aggregate-timestamp gotcha, at the node/drizzle level** (`tsx --env-file=.env`
against the real 413,765-event archive; throwaway deleted):

```
(a) max(ts) raw   : "2026-07-22 22:35:19.274+00"  typeof: string
(a) is already ISO: false
(a) normalized    : 2026-07-22T22:35:19.274Z
(a) plain column  : "2026-07-16 01:36:03.332+00"  typeof: string
(b) in-tx context : { org: '1111...', role: 'viewer' }
(b) after commit  : { role: '<unset>' }
```

Two consequences. **(i)** `set_config('app.current_role', …, true)` round-trips correctly through
drizzle's `tx.execute` with a bound parameter and does **not** survive the commit — the design in
task 7 works as written. **(ii)** The CLAUDE.md aggregate gotcha is confirmed live, and it exposes
a **pre-existing, still-unfixed bug that is OUT OF SCOPE for this slice**:

> `packages/db/src/repositories/workspaces.ts:179-192` — `projectEventSummary.lastActivity` returns
> `max(events.ts)` with **no** ISO normalization, and its comment at line 179 asserts the opposite
> ("events.ts is mode:string — max(ts) comes back as an ISO string, not a Date"). Spike 2 shows the
> comment is false. This value goes straight to the wire via
> `GET /v1/projects/:id/summary` (`routes/projects.ts:115`). This is the *same* M5 `lastActivity`
> bug CLAUDE.md describes in the past tense — it was fixed in `activeSessions` (M9, via `toIso`) but
> **never** in `projectEventSummary`. Spike 2 further shows that even a **plain** `events.ts` column
> read returns Postgres text, not ISO, so the wire contract is inconsistent more broadly.
>
> **Do not fix it in this slice.** File it as the next truth-slice item. Mixing a wire-contract
> behaviour change into a security slice muddies the review lens — the same reasoning D-15.3-7 used
> to move the throttle *out* of 15.3.

**Spike 3 — environment/tooling presence.** Verified before writing any snippet: the archive
container `420ai-archive` is up and healthy; `420ai_test` carries **16** applied migrations and
**15** policies; role `420ai_app` exists with `rolcanlogin=t, rolbypassrls=f, rolsuper=f`;
`DATABASE_URL_TEST` and `DATABASE_URL_TEST_APP` are both configured in `.env`. **No new package is
introduced by this plan**, so there is no dependency-resolution risk to retire.

### Symbols verified by reading source (not from memory)

`withOrg` / `APP_ROLE_NAME` / `ORG_SETTING` (`org-context.ts:36,63,66`) · `Principal` +
`findPrincipalByEmail` (`principal.ts:16,36`) · `resolvePrincipal` / `isUuid` (`auth.ts:36,71`) ·
`getOrgIdForUser` / `findOrgIdByUserId` / `listOrganizations` / `ensurePersonalOrg`
(`organizations.ts:62,47,83,99`) · `machineStatuses` / `activeSessions` / `recentBacklogSamples`
(`monitor.ts:22,70,112`) · `connectorHealth` / `connectorHealthWindowed`
(`projections.ts:312,353`) · `gitCommitDetail` (`git.ts:146`) · `listProjects` / `createProject` /
`getProjectName` / `renameProject` / `archiveProject` (`projects.ts:102,74,143,119,157`) ·
`listWorkspaces` / `remapWorkspace` / `resolveWorkspaceId` / `projectEventSummary`
(`workspaces.ts:139,124,148,171`) · `reconcileAlertFirings` / `listAlertFirings` / `ackAlertFiring`
/ `deliverPendingFirings` / `deliverResolvedFirings` (`alert-firings.ts:101,157,191,242,295`) ·
`organizations` / `memberships` / `users` / `machines` schema (`schema.ts:59,77,96,106`) ·
`DEFAULT_MONITOR_STREAM_INTERVAL_MS = 3000` (`app.ts:33`) · the fastify augmentation block
(`plugins/auth.ts:8-45`).

### Test harness confirmed to exist

`login(email, password)` (`apps/ingest/src/rls.int.test.ts:139`) · `asUser(token)` (:150) ·
`setUserPassword` + `hashPassword` + `ensurePersonalOrg` seeding (:157-162) · the TRUNCATE list
(:154-156) · `errorChain` / `expectRlsRejection`
(`packages/db/src/repositories/rls.int.test.ts:67,78`) · the role-identity assertion (:170-184) ·
`STRICT_TABLES` / `BOOTSTRAP_TABLES` / `NO_RLS_TABLES` (:90,106,109). Nothing in this plan asks the
executor to invent a fixture.

### Conflicting-guidance resolutions (stated so the executor never has to guess)

1. **"Mirror `withOrg` everywhere" vs "catalog routes must not be wrapped."** The catalog and
   connector-catalog routes gain a **role gate but no `withOrg`**. Deployment-global tables have no
   `org_id` and no policy (D-M15-9 / D-15.3-4). **The allow-list entries stay.**
2. **"Gate every route by principal role" vs "alert delivery must keep working."** Delivery is
   scoped with `SERVICE_ROLE`, **not** `principal.role`. The action belongs to the org, not the
   viewer who happened to open the dashboard. Passing `principal.role` there would silently kill
   outbound alerts for any org whose active user is a viewer — the 15.3 code-review bug class,
   revived.
3. **"RLS is the backstop" vs "a viewer must be refused."** The route gate is the **only** loud
   layer for DELETE, and the only layer at all for reads. The RLS layer is genuinely a backstop
   here, not a substitute — the plan never lets a route skip its gate because "RLS will catch it".
4. **"`tsc` proves the conversion" vs the CLAUDE.md file-level lesson.** For the `withOrg` **arity**
   change `tsc` genuinely does report per call site (D-15.4-4), unlike the 15.2 deleted-import case.
   It is still paired with a grep (task 8 VALIDATE), because the lesson is cheap to honour and the
   next signature change may not be an arity change.

### Risks

1. **Width.** 63 + 45 + 12 edit sites in one slice (D-15.4-1, maintainer's call). Mitigation:
   strict task ordering, a gate after each phase, and `tsc` producing the complete worklist at
   task 7 before any of it is done by hand.
2. **The silent DELETE.** The backstop cannot make a blocked DELETE loud. If the route gate misses a
   delete path, a viewer's delete is a silent no-op at both layers — the user sees "nothing
   happened". This is why task 19's grep and task 18's per-role tests both exist.
3. **`pg_policies` test collapse** (task 20). Called out explicitly because it is the kind of green
   that means nothing — the same shape as `skipped ≠ passed` and `bypassed ≠ enforced`.
4. **Throttle vs test determinism.** Any existing test asserting immediate firing reconciliation
   will break unless `reconcileThrottleMs: 0` is injected. Sweep `buildApp({` call sites in tests.

### Non-goals (name in the PR)

Billing / quotas / per-tenant rate limits · hosted multi-tenancy (**M16**) · user-defined or custom
roles · an audit-log table or UI (**15.10**) · user CRUD, invites, self-signup (**15.5**) ·
sessions/revocation (**15.6**) · SSO (**15.7**) · MFA (**15.8**) · API keys and retiring
`ADMIN_TOKEN` (**15.9**) · an org switcher or any team-management UI (**15.10**, and D-M15-10 keeps
it hidden for a solo org) · fixing the `projectEventSummary` ISO bug (next truth slice).
