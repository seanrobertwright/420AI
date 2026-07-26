# Feature: M15 Slice 15.2 — Request Principal

The following plan should be complete, but it is important that you validate documentation and
codebase patterns and task sanity before you start implementing.

Pay special attention to naming of existing utils, types and models. Import from the right files.

> Conventions are **not** re-pasted here — they live in [`CLAUDE.md`](../../CLAUDE.md) (module/TS
> rules, silent-library rule, DB gotchas, the `repo-health` gate, the M15 15.1 lessons). Milestone
> decisions D-M15-1…13 live in
> [`.agents/plans/m15-multi-user-access-control.md`](./m15-multi-user-access-control.md) and are
> **settled — do not re-litigate.** The RLS pattern this slice sets up for is in
> [`docs/research/m15-rls-spike.md`](../../docs/research/m15-rls-spike.md).

---

## Feature Description

Slice 15.1 gave every tenant-owned row an `org_id` and filled it on every write path — deliberately
**behavior-neutral**: no read gained an org filter. This slice closes that loop on the **read and
authorization** side. It replaces the boolean admin gate (`adminAuthorized`) with a **request
principal** — `{ userId, orgId, role, email }` resolved from the caller's credential — and threads
that principal's `orgId` through the read paths that currently span tenants.

Today the ingest server authenticates a request and then **throws the identity away**: 20 route
handlers re-resolve "the user" as `findUserIdByEmail(app.db, app.adminEmail)` — the single
env-configured admin — regardless of who actually logged in. The dashboard already carries the
logged-in user's session token on every hop (`apps/dashboard/src/lib/ingest.ts` `adminHeaders()`);
ingest simply discards the `sub` claim. This slice makes ingest **read** that claim.

Four cross-tenant defects were **confirmed by spikes run during planning** (outputs in NOTES). Three
are live data leaks that no amount of RLS-later makes acceptable to leave in application code, given
D-M15-3 names application scoping as the **primary** control and RLS as the backstop.

## User Story

As an **operator of a 420AI archive that holds more than one organization's data**
I want **every request to resolve to a concrete user + organization, and every read to be scoped to
that organization**
So that **one tenant can never see another tenant's sessions, usage, reports or search results —
and the identity the dashboard already sends is actually honoured.**

## Problem Statement

1. **Identity is discarded.** `adminAuthorized(app, request)` returns `boolean`
   (`apps/ingest/src/auth.ts:24`). Every gated route then resolves the actor as the env admin
   (`app.adminEmail`), so a second user's session token grants access **as the admin** —
   authentication without identity. `GET /v1/auth/me` reports `app.adminEmail` no matter who is
   logged in (`routes/auth.ts:48`).
2. **Reads span tenants.** Confirmed by spike, not inferred:
   - `sessionDetail(db, sessionId)` aggregates by connector `session_id` with **no scoping**
     (`projections.ts:247-255`). Two orgs holding the same session id get one merged projection.
   - The five project rollups join `events.project_path = workspace_keys.project_key` — **a path
     string** — with no org predicate. Two tenants whose machines share a path (`C:\dev\app`) have
     their events, tokens and cost merged into whichever org owns the project row.
   - `searchDocuments(db, opts)` (`search.ts:513`) filters on `q`/`type`/`projectId` only — full-text
     search runs over **every tenant's** redacted bodies.
   - `getReportArtifact(db, id)` (`reports.ts:89`) fetches any report by uuid with no owner check.
3. **The report version bump races** (audit B.3). Confirmed: under concurrency only 2–3 of N
   generations succeed; the rest 500 on `report_artifacts_scope_version`.

## Solution Statement

Introduce **one** resolver, `resolvePrincipal(app, request): Promise<Principal | null>`, in
`apps/ingest/src/auth.ts`, backed by a single-query repository function
`findPrincipalByEmail(db, email)` (users ⨝ memberships). **Delete `adminAuthorized` outright** so
every one of the 45 call sites becomes a **compile error** until converted — `tsc -b` becomes the
completeness proof for the widest mechanical edit in this repo's history, rather than a human
checklist. Then thread `principal.orgId` into the read repositories that the spikes proved span
tenants, and fix the version race with a bounded retry loop.

Role is **resolved but not enforced** — enforcement is 15.4 (D-M15-4). Sessions stay stateless HMAC —
statefulness is 15.6 (D-M15-12). `ADMIN_TOKEN` still works, resolving to the bootstrap admin
principal — retirement is 15.9 (D-M15-7). Pairing-code user creation stays — closing it is 15.5
(D-M15-8). **Naming these boundaries in the PR is required.**

## Feature Metadata

**Feature Type**: Refactor (security-bearing) + Bug Fix
**Estimated Complexity**: **High** — widest single edit in the repo's history; mechanically broad but
each step is compiler-checked
**Primary Systems Affected**: `apps/ingest` (auth + all 16 gated route files), `packages/db`
(projection/search/report/transcript repositories)
**Dependencies**: None new. No new npm package, no migration, no schema change, no dashboard change.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

| File | Lines | Why |
| --- | --- | --- |
| `apps/ingest/src/auth.ts` | 1–44 | The gate being replaced. `bearerToken` + the service-token `timingSafeEqual` ladder + `isUuid` all stay; only `adminAuthorized` goes. |
| `apps/ingest/src/session.ts` | 12–54 | `SessionPayload.sub` is the **email** (`signSession(email, …)` at `routes/auth.ts:39`). `verifySession` returns the payload or null, never throws. |
| `apps/ingest/src/plugins/auth.ts` | 9–40, 50–71 | The `declare module "fastify"` augmentation block — add `principal` to `FastifyRequest` here, next to `machineId`. Also the machine-auth `authenticate` preHandler, which this slice does **not** touch. |
| `apps/ingest/src/app.ts` | 82–171 | `buildApp` decorators + route registration order. No new decorator is needed. |
| `apps/ingest/src/routes/projections.ts` | 23–95 | 7 gates; the densest conversion; also the `connectorHealth` `findUserIdByEmail` site. |
| `apps/ingest/src/routes/projects.ts` | 35–102 | Canonical guard ladder (`adminAuthorized → isUuid → repo → 404`) + both `findUserIdByEmail` and `ensureUserByEmail` shapes. |
| `apps/ingest/src/routes/reports.ts` | 54–183 | 4 gates, both user-resolution shapes, and the unscoped `GET /v1/reports/:id`. |
| `apps/ingest/src/routes/monitor.ts` | 140–190 | 2 gates; `buildSnapshot(db, userId, now)` + `deliverFirings`; the SSE handler holds `userId` across the stream loop. **Long-lived resource — CLAUDE.md teardown rule applies; do not restructure the stream.** |
| `apps/ingest/src/routes/search.ts` | 20–50 | Both search endpoints; neither passes a user today. |
| `apps/ingest/src/routes/workspaces.ts` | 33–98 vs 100–140 | Shows the split this slice must preserve: `POST /v1/workspaces/discover` is **machine-authed** (`request.machineId` → `getMachineUserId`) and must NOT change; only the two admin-gated handlers convert. |
| `packages/db/src/repositories/organizations.ts` | 1–76 | `findOrgIdByUserId` / `getOrgIdForUser` / `ensurePersonalOrg`, and the header comment that explicitly names 15.2 as the slice that supersedes the temporary seam. |
| `packages/db/src/repositories/users.ts` | 12–37 | `findUserIdByEmail` / `ensureUserByEmail` — the functions the principal replaces at 20 call sites. |
| `packages/db/src/repositories/projections.ts` | 77–361 | All five project rollups + `sessionDetail` + `connectorHealth`. Note `connectorHealth`/`connectorHealthWindowed` are already correctly scoped via the `machines` join. |
| `packages/db/src/repositories/workspaces.ts` | 131–200 | `listWorkspaces(db, userId)` (already user-scoped) and `projectEventSummary` (the M5 join — **same path-collision defect** as the five rollups). |
| `packages/db/src/repositories/search.ts` | 344–436, 513–560 | `indexSessions`/`rebuildSearchIndex` (writers, already org-correct after 15.1) and `searchDocuments` (reader, **unscoped**). |
| `packages/db/src/repositories/reports.ts` | 38–99 | `reportArtifactRowColumns` (the explicit-column-list pattern — keep it), the racing `insertReportArtifact`, and the unscoped `getReportArtifact`. |
| `packages/db/src/repositories/tenancy.int.test.ts` | 1–142 | **THE test harness to mirror.** Two-org/two-machine seeding via `ensurePersonalOrg` + direct `machines` inserts, and the exact `TRUNCATE … RESTART IDENTITY CASCADE` list. |
| `apps/ingest/src/auth.int.test.ts` | 26–63, 96–130 | The `buildApp` + `app.inject()` HTTP harness, the `login()` helper, and the service-token vs session-token assertions. |
| `apps/dashboard/src/lib/ingest.ts` | whole file | Proof the dashboard **already** sends the user's session token — confirms zero dashboard change in this slice. |

### New Files to Create

- `packages/db/src/repositories/principal.ts` — `findPrincipalByEmail`, the one-query
  users ⨝ memberships resolve.
- `apps/ingest/src/principal.int.test.ts` — HTTP-level cross-tenant negative tests through
  `app.inject()` (two orgs, two session tokens).
- `packages/db/src/repositories/principal.int.test.ts` — repository-level org-scoping tests
  (the four confirmed leaks, each pinned).

### Relevant Documentation

- [Fastify — Decorators](https://fastify.dev/docs/latest/Reference/Decorators/#decoraterequest)
  — `decorateRequest` with a **reference type** must use `null` + per-request assignment (see GOTCHA
  in Task 3); the existing `machineId` decorator uses a primitive `""` and is the in-repo precedent.
- [Fastify — TypeScript module augmentation](https://fastify.dev/docs/latest/Reference/TypeScript/#module-augmentation)
  — the `declare module "fastify"` pattern already used in `plugins/auth.ts:9-40`.
- [PostgreSQL — Transaction Isolation, READ COMMITTED](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED)
  — why `max(version)+1` inside a transaction still races and why a retry loop (not a bigger
  transaction) is the fix.
- [node-postgres — error fields](https://node-postgres.com/apis/pool#error-handling) — the driver
  error carries `code`/`constraint`; **Drizzle wraps it, so they live on `.cause`** (proven in
  `tenancy.int.test.ts:196-205`).

### Patterns to Follow

**The guard ladder** — every gated route keeps its documented shape; only the first rung changes:

```ts
// BEFORE (routes/projects.ts:92-101)
app.get<{ Params: { id: string } }>("/v1/projects/:id/summary", async (request, reply) => {
  if (!adminAuthorized(app, request)) {
    return reply.code(401).send({ error: "admin authorization required" });
  }
  if (!isUuid(request.params.id)) {
    return reply.code(404).send({ error: "project not found" });
  }
  const summary = await projectEventSummary(app.db, request.params.id);
  return reply.code(200).send(summary);
});

// AFTER — same ladder, same status codes, same error strings
app.get<{ Params: { id: string } }>("/v1/projects/:id/summary", async (request, reply) => {
  const principal = await resolvePrincipal(app, request);
  if (!principal) {
    return reply.code(401).send({ error: "admin authorization required" });
  }
  if (!isUuid(request.params.id)) {
    return reply.code(404).send({ error: "project not found" });
  }
  const summary = await projectEventSummary(app.db, principal.orgId, request.params.id);
  return reply.code(200).send(summary);
});
```

> **The 401 body string `"admin authorization required"` MUST NOT change.** It is asserted across the
> existing int suites and rendered by the dashboard. This slice changes *who* a request is, never
> *what a rejection looks like*.

**Org-scoping a project rollup** — add ONE predicate; do not restructure the query:

```ts
// packages/db/src/repositories/projections.ts — usageTotals
export async function usageTotals(
  db: DbClient,
  orgId: string,           // ← NEW, always the SECOND parameter (see D-15.2-4)
  projectId: string,
): Promise<UsageTotals> {
  const [row] = await db
    .select({ ...tokenColumns, costUsd: costSum, confidences: costConfidences,
              eventCount: sql<number>`count(${events.fingerprint})::int` })
    .from(events)
    .innerJoin(workspaceKeys, eq(events.projectPath, workspaceKeys.projectKey))
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    .where(and(eq(workspaces.projectId, projectId), eq(events.orgId, orgId))); // ← the fix
  ...
}
```

> **Spike-snippet fidelity.** The `eq(events.orgId, orgId)` predicate above is exactly "FIX A",
> verified during planning: with org A holding 2 events and org B holding 3 on the same
> `project_path`, the unpatched query returned **5** and the patched query returned **2**. A
> join-level variant ("FIX B") also returned 2; FIX A is chosen because it scopes to the *principal's*
> org rather than to a value derived from the row, so it also enforces "you cannot read another org's
> project" — one predicate, both properties.

**Aggregates + DB gotchas** (CLAUDE.md) — the queries you touch already obey these; **keep them that
way**: `min/max(ts)` over a `mode:"string"` column comes back as Postgres text (`sessionAggregateColumns`
types them `sql<string | null>` and consumers pass them through — do not add a `new Date()` coercion
that was not there); `costSum` is `numeric` → **string** → already wrapped in `Number(...)`; the
`date_trunc` unit in `usageOverTime` is inlined via `sql.raw` from a guarded union and **must stay a
raw literal, never a bound parameter**. Adding an org predicate changes none of this.

**Silent libraries** (CLAUDE.md): repository functions throw typed/plain errors and never log.
`findPrincipalByEmail` returns `undefined` for "no such user/membership" — it does **not** throw
(mirrors `findUserIdByEmail`); only `getOrgIdForUser` throws, and this slice does not add throwers.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation — the principal type + resolver

Build the resolver and its repository query, with unit + int coverage, **before** touching any route.
At the end of this phase the codebase still compiles with `adminAuthorized` intact and every test
green — the new code is simply unused.

### Phase 2: Core — delete the old gate, convert all 16 route files

Delete `adminAuthorized`. The build breaks in 45 places. Convert file-by-file, running `tsc -b` after
each file, until the error count reaches zero. **The compiler is the checklist.**

### Phase 3: Integration — thread `orgId` into the leaking repositories

Change the repository signatures the spikes proved unsafe. Each signature change breaks its callers →
`tsc -b` again enumerates the work.

### Phase 4: Correctness — the report version race

Bounded retry loop around `insertReportArtifact`'s transaction.

### Phase 5: Testing & docs

Cross-tenant negative tests at both layers, plus the SUMMARY/CLAUDE.md updates in the same commit.

---

## STEP-BY-STEP TASKS

Execute in order. Run the stated VALIDATE after each task.

### Task 1 — CREATE `packages/db/src/repositories/principal.ts`

- **IMPLEMENT**: `Principal` interface + `findPrincipalByEmail(db, email): Promise<Principal | undefined>`
  resolving `{ userId, email, orgId, role }` in ONE query.
- **PATTERN**: `repositories/users.ts:13-20` (shape of a `find…` returning `undefined`);
  `repositories/organizations.ts:31-39` (the deterministic `ORDER BY created_at, id LIMIT 1` that
  makes a multi-membership user resolve stably).
- **IMPORTS**: `import { asc, eq } from "drizzle-orm";` · `import type { DbClient } from "../client.js";`
  · `import { memberships, users } from "../schema.js";`
- **IMPLEMENT (verified query — this exact shape was run during planning and returned
  `{userId, email, orgId, role:"owner"}`):**

```ts
export interface Principal {
  userId: string;
  email: string;
  orgId: string;
  /** owner | admin | member | viewer (D-M15-4). RESOLVED here, ENFORCED in 15.4 — never gate on it in this slice. */
  role: string;
}

export async function findPrincipalByEmail(
  db: DbClient,
  email: string,
): Promise<Principal | undefined> {
  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      orgId: memberships.orgId,
      role: memberships.role,
    })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(eq(users.email, email))
    .orderBy(asc(memberships.createdAt), asc(memberships.id))
    .limit(1);
  return row;
}
```

- **GOTCHA**: `innerJoin` is deliberate — a user with **no** membership resolves to `undefined`
  (verified: unknown email → `undefined`, no throw). Do **not** use a left join and default the org;
  an ownerless principal must fail closed. The `ORDER BY` mirrors `findOrgIdByUserId` so a
  two-membership user (possible by design — 15.10 needs it) resolves to the same org from both
  functions rather than flapping.
- **GOTCHA**: this returns an **explicit column list**, not `select()` — CLAUDE.md's 15.1 lesson.
  The principal is never sent on the wire, but the habit is the rule.
- **VALIDATE**: `npx tsc -b` (exit 0)

### Task 2 — UPDATE `packages/db/src/index.ts`

- **IMPLEMENT**: export `findPrincipalByEmail` and `type Principal` from the new module.
- **PATTERN**: the existing grouped re-exports, e.g. `index.ts:39-43` (the organizations block).
- **VALIDATE**: `npx tsc -b` (exit 0)

### Task 3 — UPDATE `apps/ingest/src/plugins/auth.ts` (type augmentation only)

- **IMPLEMENT**: add to the existing `declare module "fastify"` block, inside `interface FastifyRequest`:

```ts
interface FastifyRequest {
  machineId: string;
  /** M15 15.2 — the resolved caller (user + org + role), or null before/without resolution.
   *  Set by resolvePrincipal(); read by handlers that need it after their own gate. */
  principal: import("@420ai/db").Principal | null;
}
```

  and in the plugin body, beside `app.decorateRequest("machineId", "")`:
  `app.decorateRequest("principal", null);`
- **PATTERN**: `plugins/auth.ts:9-40` (the augmentation block) and `:51` (the `decorateRequest` call).
- **GOTCHA**: decorating with `null` (not an object literal) is required — Fastify shares a
  reference-type decorator default across every request; `null` + per-request assignment is the safe
  form. The existing `machineId` uses `""` for the same reason.
- **GOTCHA**: this task does **not** change `app.authenticate`. Machine auth (collector → `/v1/ingest`,
  `/v1/git`, `/v1/heartbeat`, `/v1/workspaces/discover`) is a separate credential tier (D-M15-7) and is
  **out of scope**; those routes already derive the org from `machines.org_id` (15.1).
- **VALIDATE**: `npx tsc -b` (exit 0)

### Task 4 — UPDATE `apps/ingest/src/auth.ts` — add `resolvePrincipal`, DELETE `adminAuthorized`

- **IMPLEMENT**: keep `bearerToken` and `isUuid` verbatim. Replace `adminAuthorized` with:

```ts
/**
 * M15 15.2 — resolve the request's PRINCIPAL (user + org + role), or null when the
 * credential is absent/invalid. Replaces the 12.3 boolean `adminAuthorized`: the gate now
 * yields an identity instead of a yes/no, so a handler scopes to `principal.orgId` rather
 * than re-resolving the env admin.
 *
 * Two credential paths, service-first (a machine client never pays for an HMAC):
 *  (1) ADMIN_TOKEN — the bootstrap service token. Resolves to the BOOTSTRAP ADMIN principal
 *      (app.adminEmail), preserving today's behavior exactly. D-M15-7 retires this in 15.9.
 *  (2) A 12.3 HMAC session token — `sub` is the user's EMAIL (routes/auth.ts signs it that
 *      way). 15.2 is where ingest finally READS that claim instead of discarding it.
 *
 * Returns null (⇒ the caller sends 401) when: no bearer, a bad MAC/expired session, or the
 * resolved email has no user OR no membership. An ownerless identity fails CLOSED.
 */
export async function resolvePrincipal(
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<Principal | null> {
  const token = bearerToken(request);
  if (!token) return null;

  let email: string | null = null;
  // (1) Service token — the length guard before timingSafeEqual is mandatory (it throws on
  // a length mismatch).
  const presented = Buffer.from(token);
  const expected = Buffer.from(app.adminToken);
  if (presented.length === expected.length && timingSafeEqual(presented, expected)) {
    email = app.adminEmail;
  } else {
    // (2) Human session token.
    const payload = verifySession(token, app.sessionSecret);
    if (payload) email = payload.sub;
  }
  if (!email) return null;

  const principal = await findPrincipalByEmail(app.db, email);
  if (!principal) return null;
  request.principal = principal;
  return principal;
}
```

- **IMPORTS**: add `import { findPrincipalByEmail, type Principal } from "@420ai/db";` and
  `import type { Principal as _P } from "@420ai/db";` is **not** needed — one import suffices.
  Keep `timingSafeEqual` from `node:crypto` and `verifySession` from `./session.js`.
- **GOTCHA — the behavioral change to name in the PR**: `adminAuthorized` returned `true` for a
  valid session token **even if no matching user row existed**. `resolvePrincipal` returns `null`
  in that case (401). This is intended (fail closed) but it **is** a semantic change: a token signed
  for a since-deleted user now 401s instead of acting as admin.
- **GOTCHA**: `resolvePrincipal` is **async** — every call site becomes `await`. Handlers are already
  `async`, so this is mechanical.
- **GOTCHA**: it sets `request.principal` as a side effect *and* returns the value. Handlers should
  use the **returned** value (narrowed non-null); `request.principal` exists for future middleware
  and for 15.3's transaction wrapper.
- **VALIDATE**: `npx tsc -b` — **expected to FAIL with ~45 errors** ("Cannot find name
  'adminAuthorized'"). Capture the count: `npx tsc -b 2>&1 | grep -c "adminAuthorized"`. That number
  is your worklist for Task 5.

### Task 5 — UPDATE all 16 gated route files (the mechanical conversion)

Convert each file, then re-run `tsc -b`. Exact inventory (verified by grep during planning —
**45 gates across 16 files**, and **20 `app.adminEmail` user-resolutions across 11 files**):

| Route file | Gates | `adminEmail` resolutions | Notes |
| --- | --- | --- | --- |
| `routes/projections.ts` | 7 | 1 (`connectorHealth`) | Densest. 5 project-keyed reads + `sessionDetail` + connector health. |
| `routes/git.ts` | 5 | 4 | `POST /v1/git` is **machine-authed** — leave it alone. |
| `routes/catalog.ts` | 4 | 0 | Global resource (D-M15-9) — gate converts, **no org scoping**. |
| `routes/connector-catalog.ts` | 4 | 0 | Same; note `GET …/active` is machine-authed. |
| `routes/projects.ts` | 4 | 2 | Both `findUserIdByEmail` and `ensureUserByEmail` shapes. |
| `routes/reports.ts` | 4 | 3 | Plus the unscoped `GET /v1/reports/:id` (Task 7). |
| `routes/exports.ts` | 3 | 1 | |
| `routes/monitor.ts` | 2 | 2 | **SSE — see GOTCHA below.** |
| `routes/interpretations.ts` | 2 | 2 (`ensureUserByEmail`) | |
| `routes/replay.ts` | 2 | 0 | Deployment-wide admin ops. |
| `routes/search.ts` | 2 | 0 | Both need `orgId` added (Task 8). |
| `routes/workspaces.ts` | 2 | 2 | `POST /discover` is machine-authed — leave it. |
| `routes/alerts.ts` | 1 | 1 | |
| `routes/auth.ts` | 1 | 1 | `GET /v1/auth/me` — see below. |
| `routes/metrics.ts` | 1 | 0 | |
| `routes/pairing-codes.ts` | 1 | 1 | See D-15.2-5. |

- **IMPLEMENT (per gate)**: replace

  ```ts
  if (!adminAuthorized(app, request)) {
    return reply.code(401).send({ error: "admin authorization required" });
  }
  ```

  with

  ```ts
  const principal = await resolvePrincipal(app, request);
  if (!principal) {
    return reply.code(401).send({ error: "admin authorization required" });
  }
  ```

- **IMPLEMENT (per user-resolution)**: **delete** every
  `const userId = await findUserIdByEmail(app.db, app.adminEmail);` and its
  `if (!userId) return …` guard, and use `principal.userId`. The `if (!userId)` empty-result branches
  (`return reply.code(200).send({ projects: [] })` etc.) become **dead code** — a principal always
  has a user — so remove them. Where `ensureUserByEmail(app.db, app.adminEmail)` was used
  (projects POST, reports ×2, interpretations ×2), use `principal.userId`: the user provably exists,
  so the find-or-create is no longer needed.
- **GOTCHA — `routes/auth.ts:48`**: `GET /v1/auth/me` must now return the **principal's** email, not
  `app.adminEmail`: `return reply.code(200).send({ email: principal.email });`. This is a genuine bug
  fix (a second user currently sees the admin's address) and the dashboard nav renders it
  (`/api/auth/me`). Response **shape** is unchanged, so no dashboard edit.
- **GOTCHA — `routes/monitor.ts` SSE (`/v1/monitor/stream`)**: resolve the principal **once, before
  the stream starts**, and close over `principal.userId`/`principal.orgId` for the interval loop —
  exactly as the current code closes over `userId`. Do **not** re-resolve per tick (a DB round trip
  per SSE frame). **Do not restructure the stream's teardown**: CLAUDE.md's long-lived-resource rule
  says the teardown is armed before the first `await`; keep that ordering intact. The `userId
  ? … : empty` ternary at `:181` collapses to the non-null branch once the gate guarantees a
  principal — simplify it, but leave the `closed` flag and listener wiring untouched.
- **GOTCHA — machine-authed routes must NOT be converted.** These use `request.machineId` via
  `app.authenticate` and already derive org from `machines.org_id`: `POST /v1/ingest`,
  `POST /v1/git`, `POST /v1/heartbeat`, `POST /v1/workspaces/discover`,
  `GET /v1/connector-catalog/active`, and the pairing routes. If a file mixes both (git.ts,
  workspaces.ts, connector-catalog.ts), convert **only** the `adminAuthorized` handlers.
- **GOTCHA**: remove the now-unused `findUserIdByEmail` / `ensureUserByEmail` imports as they become
  dead, or `eslint` (`npm run lint`, CI-only) fails on unused imports even though `tsc` may not.
- **VALIDATE (per file)**: `npx tsc -b 2>&1 | grep -c "adminAuthorized"` — strictly decreasing.
- **VALIDATE (end of task)**: `npx tsc -b` exits 0 **and**
  `grep -rn "adminAuthorized\|app.adminEmail" apps/ingest/src/routes/ | wc -l` returns **0**
  (`app.adminEmail` survives only in `auth.ts`'s service-token branch and `app.ts`'s decorator).

### Task 6 — UPDATE `packages/db/src/repositories/projections.ts` + `workspaces.ts` (the path-collision fix)

- **IMPLEMENT**: add `orgId: string` as the **second parameter** and `eq(events.orgId, orgId)` to the
  `where(and(...))` of each of these six functions:
  - `projections.ts`: `usageTotals`, `usageByModel`, `usageOverTime`, `sessionProjections`,
    `projectGitMetadata`
  - `workspaces.ts:160`: `projectEventSummary` (the original M5 join — **same defect**)
- **IMPLEMENT**: `sessionDetail(db, orgId, sessionId)` — add `eq(events.orgId, orgId)` to its
  `where`, which currently filters on `sessionId` alone:
  `.where(and(eq(events.sessionId, sessionId), eq(events.orgId, orgId)))`.
- **PATTERN**: the snippet in "Patterns to Follow" above (verified by spike).
- **GOTCHA**: `usageByModel` already wraps its `where` in `and(...)` with an `inArray` — add the
  predicate to the existing `and`, do not nest a second one.
- **GOTCHA**: **do not** change `connectorHealth` / `connectorHealthWindowed`. They join
  `machines` and filter `machines.userId` — already tenant-correct (verified by spike: org A saw 3
  events, org B saw 5, no bleed). Changing them risks the `deriveAlerts`-adjacent behavior for zero
  security gain. If you want defense-in-depth here, that is **15.3's** RLS backstop, not this slice.
- **GOTCHA**: leave the aggregate column definitions alone — `min/max(ts)` stays `sql<string | null>`
  and is passed through un-coerced (CLAUDE.md DB gotcha: it is Postgres **text**, and the existing
  consumers already expect that); `costSum` stays `numeric`→string→`Number()`; `usageOverTime`'s
  `date_trunc` unit stays a `sql.raw` literal.
- **VALIDATE**: `npx tsc -b` — fails at every caller (routes + reports/interpretation generators);
  fix each by passing `principal.orgId`. Then exit 0.

### Task 7 — UPDATE `packages/db/src/repositories/reports.ts` (scope + the version race)

- **IMPLEMENT (a)**: `getReportArtifact(db, orgId, id)` — add `eq(reportArtifacts.orgId, orgId)` to
  the `where`. An unknown-or-other-org id then returns `undefined` → the route's existing
  `if (!row) return 404` yields **404, not 403** (do not leak existence).
- **IMPLEMENT (b)**: `listReportArtifacts` — add `eq(reportArtifacts.orgId, orgId)` alongside the
  existing `userId` condition (defense in depth; the route passes both from one principal).
- **IMPLEMENT (c)** — the version race. Wrap the existing transaction in a bounded retry:

```ts
/** Attempts before a version conflict surfaces. 12 absorbs ≥16-way concurrent generation
 *  (measured); 6 did not (6 of 16 still failed). See NOTES → Spike 2. */
const MAX_VERSION_ATTEMPTS = 12;

/** True for the `report_artifacts_scope_version` unique violation. Drizzle WRAPS the driver
 *  error, so the pg fields live on `.cause` (same shape asserted in tenancy.int.test.ts:196-205). */
function isVersionConflict(e: unknown): boolean {
  const c = (e as { cause?: { code?: string; constraint?: string } })?.cause;
  return c?.code === "23505" && c?.constraint === "report_artifacts_scope_version";
}

export async function insertReportArtifact(
  db: Db,                                   // ← NOTE: Db, not DbClient (it opens a transaction)
  a: Omit<ReportArtifactRow, "id" | "version" | "generatedAt">,
): Promise<ReportArtifactRow> {
  for (let attempt = 1; attempt <= MAX_VERSION_ATTEMPTS; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        /* …existing body verbatim: max(version)+1, getOrgIdForUser, insert, returning… */
      });
    } catch (e) {
      if (!isVersionConflict(e) || attempt === MAX_VERSION_ATTEMPTS) throw e;
      // Lost the race — another generation took this version. Re-read and retry.
    }
  }
  throw new Error("unreachable");
}
```

- **GOTCHA**: the retry **must wrap the whole transaction**, not sit inside it — a failed statement
  aborts the surrounding transaction, so retrying within it errors with
  `current transaction is aborted`.
- **GOTCHA**: `insertReportArtifact` currently takes `DbClient`. A retry needs to re-open the
  transaction, which a `Tx` cannot do. Verify no caller passes a `Tx` (grep during planning found
  only `Db` callers, in `reports/generate-report.ts` and `generate-report-m13.ts`); if `tsc` says
  otherwise, keep `DbClient` and retry only when the handle is a `Db`.
- **GOTCHA — org scoping and this function**: the `getOrgIdForUser(tx, a.userId)` line inside the
  transaction is one of 15.1's marked seams. With a principal available you may pass `orgId` in on
  `a` instead. **Prefer that** — it removes a query per generation and removes the temporary seam the
  15.1 comment flags. Update the `Omit<…>` type accordingly.
- **VALIDATE**: `npx tsc -b` exit 0, then the new int test from Task 11.

### Task 8 — UPDATE `packages/db/src/repositories/search.ts` + `routes/search.ts`

- **IMPLEMENT**: `searchDocuments(db, opts)` gains a **required** `orgId: string` on `opts`, and
  `conditions.push(eq(searchDocumentsTbl.orgId, opts.orgId))`.
- **IMPLEMENT**: `routes/search.ts` passes `orgId: principal.orgId`.
- **GOTCHA — required, not optional.** An optional `orgId?` that a caller forgets is a silent
  full-index read; a required field is a compile error. This is the whole reason the slice deletes
  `adminAuthorized` rather than deprecating it.
- **GOTCHA — `POST /v1/search/reindex` (`rebuildSearchIndex(db)`) is deliberately NOT org-scoped.**
  It is a deployment-wide maintenance operation, and after 15.1 its writers already stamp the correct
  per-row `org_id` (pinned by `tenancy.int.test.ts` "indexSessions emits ONE doc PER ORG"). Add a
  comment saying so; **restricting who may run it is 15.4's RBAC job**, not this slice's.
- **VALIDATE**: `npx tsc -b` exit 0.

### Task 9 — UPDATE `packages/db/src/repositories/transcript.ts` and session-keyed attribution reads

- **IMPLEMENT**: `sessionTranscript(db, orgId, sessionId, caps?)` — add `eq(events.orgId, orgId)` to
  its `where`. Same defect class as `sessionDetail`: keyed by a connector-supplied, globally-scoped
  session id, and it **decrypts payloads**, so a collision leaks plaintext.
- **IMPLEMENT**: apply the same treatment to the session-keyed readers in
  `repositories/attribution.ts` — `sessionModifiedPaths` (`:70`), `sessionEndTs` (`:102`),
  `computeSessionGitSuggestions` (`:180`). Functions already taking `userId`
  (`addManualLink`, `setLinkStatus`, `listProjectLinks`) additionally gain the org predicate.
- **RULE to apply generally** (state it in the code comment): *a repository read keyed by a
  connector-supplied string — `session_id`, `project_path`, `fingerprint` — MUST take `orgId`.
  Those keys are globally scoped and two tenants can share them.* A read keyed by an org-owned uuid
  gets the predicate too, as defense in depth.
- **GOTCHA**: `attribution.ts:215` and `:292` carry 15.1's `getOrgIdForUser` markers — replace those
  with the passed-in `orgId` and delete the marker comments.
- **VALIDATE**: `npx tsc -b` exit 0 and
  `grep -rn "superseded by the 15.2 request principal" packages/db/src | wc -l` — should be **0**
  once every marked seam is retired (9 markers found during planning; if one legitimately survives,
  say why in the execution report).

### Task 10 — CREATE `packages/db/src/repositories/principal.int.test.ts`

- **IMPLEMENT**: mirror `tenancy.int.test.ts` seeding **exactly** (two users → `ensurePersonalOrg`
  ×2 → two `machines` rows → the same `TRUNCATE … RESTART IDENTITY CASCADE` list). Tests:
  1. `findPrincipalByEmail` returns `{userId, email, orgId, role}`; `role` reflects the membership
     (seed one `owner`); unknown email → `undefined`; a user with no membership → `undefined`.
  2. **`sessionDetail` no longer merges orgs** — ingest 3 events for org A and 5 for org B under the
     same `sessionId`; assert `sessionDetail(db, orgA, id).eventCount === 3` and `orgB → 5`.
     *(Unpatched this returned 8 — see NOTES → Spike 1.)*
  3. **The path-collision fix** — org A owns project P with a `workspace_keys` row for
     `C:\dev\app`; both orgs ingest events with that `projectPath`; assert
     `usageTotals(db, orgA, P).eventCount === 2` (org A's own), not 5.
     *(Unpatched this returned 5 / 500 tokens — see NOTES → Spike 4.)*
  4. **`searchDocuments` is org-scoped** — two orgs' docs matching the same query; each principal
     sees only its own hits.
  5. **`getReportArtifact` cross-org returns `undefined`.**
  6. **The version race** — `Promise.allSettled` over **8** concurrent `insertReportArtifact` calls
     for the same `(userId, reportType, scopeId)`; assert **0 rejected** and versions are the
     contiguous set `1..8`. *(Unpatched: 2 fulfilled / 6 rejected — see NOTES → Spike 2.)*
- **PATTERN**: `tenancy.int.test.ts:38-72` (the `IngestBatch` factory), `:118-142` (seeding),
  `:196-205` (asserting a pg error code through Drizzle's `.cause`).
- **GOTCHA**: `workspace_keys` requires `userId` **and** `sourceConnector` in addition to `orgId`,
  `workspaceId`, `projectKey` — omitting them fails with a `23502` not-null violation (hit during
  planning). Same for `workspaces`: `orgId`, `userId`, `projectId`, `machineId`, `rootPath`.
- **GOTCHA**: name the file `*.int.test.ts` so it self-skips without `DATABASE_URL_TEST` and is
  excluded from `tsc -b` (CLAUDE.md).
- **VALIDATE**: `npx vitest run packages/db/src/repositories/principal.int.test.ts` — all pass,
  **0 skipped**.

### Task 11 — CREATE `apps/ingest/src/principal.int.test.ts`

- **IMPLEMENT**: the HTTP-layer proof, via `buildApp` + `app.inject()`. Seed **two** users with
  passwords (`setUserPassword` + `hashPassword`), each with a personal org and a machine; ingest
  distinguishable data into each. Then:
  1. Log in as each user (`POST /v1/auth/login`) → two session tokens.
  2. `GET /v1/auth/me` with user B's token returns **B's** email (today it returns the admin's).
  3. `GET /v1/projects` with A's token lists **only** A's projects; same for B.
  4. `GET /v1/sessions/:sessionId` for a session id both orgs share returns each org's own counts.
  5. `GET /v1/search?q=…` returns only the caller's org's hits.
  6. `GET /v1/reports/:id` for **another org's** report id → **404**.
  7. The **service token** still authorizes and resolves to the bootstrap admin principal
     (regression guard for the desktop app / `reports:generate`, which still carry `ADMIN_TOKEN`
     until 15.9).
  8. A session token whose `sub` has no user row → **401** (the intended fail-closed change).
- **PATTERN**: `auth.int.test.ts:26-63` (`buildApp` opts, the `login()` helper, `TRUNCATE` in
  `beforeEach`) and `:96-130` (session-token vs service-token assertions).
- **GOTCHA**: pass a fixed `sessionSecret` and `adminEmail` to `buildApp` as `auth.int.test.ts` does;
  the default is a random per-process secret.
- **GOTCHA**: `buildApp` requires an `analysisProvider` — reuse the `stubProvider` shape from
  `auth.int.test.ts:20-24`.
- **VALIDATE**: `npx vitest run apps/ingest/src/principal.int.test.ts` — all pass, 0 skipped.

### Task 12 — UPDATE docs in the SAME commit

- **UPDATE** `SUMMARY.md`: flip **15.2** to ✅ with a one-line "DONE `<date>` (PR #NN)" in **both**
  the §0 status block and the §6 roadmap list. (`scripts/check-summary.mjs` **fails the gate** if
  you write the execution report without this.)
- **UPDATE** `CLAUDE.md` — add to the M15 block of the "Drizzle / SQL gotchas" section: *a read keyed
  by a connector-supplied string (`session_id`, `project_path`, `fingerprint`) must take `orgId` —
  those keys are globally scoped and two tenants can share them; the `project_path` join in the M5/M6
  rollups merged two orgs' usage before 15.2.*
- **UPDATE** `packages/db/src/repositories/organizations.ts` header — the "SCOPE NOTE" says 15.2
  "replaces every call site". Correct it to reflect what actually remains (`ensurePersonalOrg` stays;
  `getOrgIdForUser` survives only where a principal is genuinely unavailable, e.g. machine-keyed
  writes — or delete the note if nothing remains).
- **GOTCHA**: run `npm run format` before pushing — CI runs `format:check` over `.md`, which local
  `repo-health` does not.
- **VALIDATE**: `node scripts/check-summary.mjs` (exit 0)

---

## TESTING STRATEGY

### Unit Tests

`resolvePrincipal` is DB-backed, so its natural home is the int layer. Add pure unit coverage only
for logic that has no DB dependency — if you extract a helper such as `isVersionConflict`, unit-test
it against a synthetic `{cause:{code,constraint}}` object (co-located `*.test.ts`, no infra, per
CLAUDE.md).

### Integration Tests

The two new `*.int.test.ts` files above are the slice's proof. Both must run against a real Postgres
(`DATABASE_URL_TEST`), and the milestone rule applies: **skipped ≠ passed**.

Existing int suites will need mechanical updates wherever they call a changed repository signature
(`projections.int.test.ts`, `reports.int.test.ts`, `search.int.test.ts`, `workspaces.int.test.ts`,
`app.int.test.ts`, `transcript.int.test.ts`). `tsc` will not catch these (int tests are excluded from
`tsc -b`) — **vitest will, at runtime.** Budget for it and run the full suite often.

### Edge Cases

- Valid session token, user row deleted → **401** (intended change; assert it).
- Valid session token, user exists but has **no membership** → 401 (fail closed).
- User with **two** memberships → deterministic org (`ORDER BY created_at, id`), not flapping.
- Service token + a `adminEmail` user that does not exist yet (fresh boot before the seed) → 401
  rather than a 500. `server.ts:124` seeds via `setUserPassword` on boot, which also calls
  `ensurePersonalOrg`, so this is a startup-ordering edge, not a steady-state one — assert it anyway.
- Two orgs sharing a `session_id` (proven real) — the headline negative test.
- Two orgs sharing a `project_path` (proven real) — the second headline negative test.
- Unknown/other-org uuid on every `:id` route → **404**, never 403 and never a DB-cast 500 (the
  repo-wide invariant in CLAUDE.md).
- Concurrent report generation ×8 → all succeed, contiguous versions.

---

## VALIDATION COMMANDS

Run from the repo root. Every command must pass before the slice is done.

### Level 1: Syntax & Style

```bash
npx tsc -b            # root typecheck — MUST exit 0 (per-workspace build is NOT a substitute)
npm run lint          # ESLint — CI runs it; repo-health does NOT
npm run format        # Prettier write — CI runs format:check over .md too
```

### Level 2: Unit Tests

```bash
npx vitest run        # full suite; units always run, int layer self-skips without DATABASE_URL_TEST
```

### Level 3: Integration Tests (REQUIRED — this slice touches @420ai/db and apps/ingest)

```bash
npm run db:up
npm run db:migrate
# NOTE: db:migrate does NOT migrate 420ai_test — migrate the test DB separately before --require-db.
npm run repo-health -- --require-db
```

Expected pass signal: `repo-health` exits 0 **and** reports the `*.int.test.ts` layer actually ran
with **0 skipped**. A plain `repo-health` PASS does not prove the DB layer ran.

### Level 4: Manual Validation

1. Boot the stack (`npm run db:up`, `npm run ingest:dev`, `npm run dashboard:dev`).
2. Log in through the dashboard; confirm the nav shows **your** email (`/api/auth/me`).
3. Seed a second user + org directly in Postgres; log in as them in a private window; confirm
   Projects / Reports / Search show **only** that org's data.
4. Confirm `ADMIN_TOKEN` still works for a machine client:
   `curl.exe -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:8420/v1/projects`
   (PowerShell: use `curl.exe` and a file-based JSON body, never bare `curl`).
5. Confirm no token leaks into served HTML: page source `grep -c "$ADMIN_TOKEN"` == **0**.

### Level 5: Additional Validation

```bash
grep -rn "adminAuthorized" apps packages --include=*.ts | grep -v /dist/     # expect 0
grep -rn "app.adminEmail" apps/ingest/src/routes | wc -l                     # expect 0
grep -rn "superseded by the 15.2 request principal" packages/db/src | wc -l  # expect 0
```

---

## ACCEPTANCE CRITERIA

- [ ] `adminAuthorized` no longer exists anywhere; all 45 gates use `resolvePrincipal`
- [ ] `app.adminEmail` appears in **no** route file (only `auth.ts`'s service branch + `app.ts`)
- [ ] `GET /v1/auth/me` returns the **caller's** email
- [ ] `sessionDetail`, the five project rollups, `projectEventSummary`, `sessionTranscript`,
      `searchDocuments`, `getReportArtifact` and the session-keyed attribution reads all take and
      apply `orgId`
- [ ] Cross-tenant negative tests pass at **both** the repository and HTTP layers
- [ ] Concurrent report generation ×8 produces 8 contiguous versions, 0 failures
- [ ] `ADMIN_TOKEN` (desktop app, `reports:generate`) still authorizes — no regression
- [ ] No migration, no schema change, no dashboard change, no `apps/collector` change
- [ ] `npm run repo-health -- --require-db` passes with **0 skipped** int tests
- [ ] `npm run lint` and `npm run format:check` pass
- [ ] `SUMMARY.md` flips 15.2 to ✅ in §0 and §6 **in the same commit**
- [ ] The PR names the non-goals: role **enforcement** (15.4), stateful sessions (15.6),
      `ADMIN_TOKEN` retirement (15.9), pairing-code user creation (15.5), RLS (15.3)

---

## COMPLETION CHECKLIST

- [ ] All tasks completed in order; each task's VALIDATE run immediately
- [ ] `tsc -b` error count went to zero by conversion, not by suppression (no `@ts-ignore`, no `any`)
- [ ] Full suite green including the integration layer, 0 skipped
- [ ] Manual two-user isolation check performed and recorded
- [ ] `/lril:code-review` run and clean before commit
- [ ] Execution report written; `SUMMARY.md` updated in the same commit

---

## NOTES

### Design decisions settled in this plan (do not re-litigate mid-slice)

**D-15.2-1 — `resolvePrincipal` replaces `adminAuthorized` by DELETION, not deprecation.** Keeping
the old function alongside the new one would let a missed call site compile and silently read across
tenants — precisely the milestone-plan Risk #1 ("a missed site is a silent wrong-tenant read until
15.3's RLS backstop lands"). Deleting it converts that silent risk into 45 compile errors. **`tsc -b`
is the completeness proof for this slice.**

**D-15.2-2 — Inline gate, not a `preHandler`.** A `preHandler`-based gate reads more cleanly, but a
route that *forgets* the hook fails **open**. The inline call keeps the repo's documented guard-ladder
shape (`gate → isUuid → repo → 404`) and, combined with D-15.2-1, fails **closed** at compile time.

**D-15.2-3 — The service token resolves to the bootstrap admin principal.** `ADMIN_TOKEN` carries no
identity, so it maps to `app.adminEmail`'s user + org. This preserves today's behavior exactly for
the desktop app and `scripts/generate-reports.mjs`. D-M15-7 retires it in **15.9** — not here.

**D-15.2-4 — `orgId` is always the SECOND parameter**, right after `db`, in every repository
signature it is added to. A consistent position makes the ~30 call-site edits mechanical and makes a
transposed-argument bug (two adjacent `string` params) visually obvious in review.

**D-15.2-5 — `POST /v1/pairing-codes` keeps its `body.email` user-upsert.** Closing that
account-pre-seeding primitive is **D-M15-8 / slice 15.5**, explicitly sequenced before SSO in 15.7.
This slice converts its gate and nothing else. Do not pull 15.5's work forward.

**D-15.2-6 — Role is resolved, never enforced.** `Principal.role` is populated from
`memberships.role` and carried on the request, but **no route branches on it** in this slice.
Enforcement is 15.4 (D-M15-4). Resolving it now means 15.4 is a pure policy addition, not another
plumbing pass.

**D-15.2-7 — Global resources stay global.** `pricing_catalogs` and `connector_catalogs` have no
`org_id` by decision (D-M15-9). Their routes convert the gate but gain **no** org filter. Likewise
`POST /v1/search/reindex` and the `/v1/replay/*` operations are deployment-wide; who may invoke them
is 15.4's question.

### Spikes RUN DURING PLANNING (evidence, not intentions)

All four ran against the real test database (`420ai_test`, migration `0014` confirmed applied — 16
tables carry `org_id`). Throwaway files were deleted; the working tree is clean.

**Spike 1 — `sessionDetail` merges tenants. CONFIRMED.** Ingested 3 events for org A and 5 for org B
under the same connector `sessionId`, then called the shipped `sessionDetail`. It returned
`eventCount === 8`. A control assertion confirmed `connectorHealth` is **not** affected (org A → 3,
org B → 5) because it joins `machines`. A direct org-filtered count returned 3, confirming
`events.org_id` is the fix.

**Spike 2 — the report version race. CONFIRMED, with a measured envelope.** Concurrent
`insertReportArtifact` calls for the same `(userId, reportType, scopeId)`:

| Concurrency | Fulfilled | Rejected | Versions |
| --- | --- | --- | --- |
| 2 | 2 | 0 | `[1,2]` |
| 4 | 2 | **2** | `[1,2]` |
| 8 | 2 | **6** | `[1,2]` |
| 16 | 3 | **13** | `[1,3,2]` |

Every rejection was `code=23505 constraint=report_artifacts_scope_version`, which reaches the client
as a **500** (`app.ts:186-190` masks any `status >= 500`). Note the race does **not** reproduce at
concurrency 2 — the milestone plan's "two concurrent generations" framing understates it.

Then the prescribed fix was verified. With a bounded retry loop around the transaction:

| Attempts | N=4 | N=8 | N=16 |
| --- | --- | --- | --- |
| 6 | 4/4 ✅ | 8/8 ✅ | 10/16 ❌ (6 rejected) |
| **12** | 4/4 ✅ | 8/8 ✅ | **16/16 ✅ contiguous `1..16`** |

Hence `MAX_VERSION_ATTEMPTS = 12` in Task 7 — chosen from measurement, not taste.

**Spike 3 — the one-query principal resolve. CONFIRMED.** The exact `users ⨝ memberships` select in
Task 1 returned `{userId, email:"a@x.io", orgId, role:"owner"}` for a seeded owner, and `undefined`
for an unknown email (no throw). One round trip — and for the 20 routes that currently do
gate-then-`findUserIdByEmail`, it is a net **reduction** of one query per request.

**Spike 4 — the `project_path` join merges tenants. CONFIRMED — this one was not in the audit.**
Org A owned project P with a `workspace_keys` row for `C:\dev\app`. Both orgs' machines then ingested
`usage.reported` events carrying that same `projectPath` (org A: 2 events / 200 input tokens; org B:
3 / 300). The shipped `usageTotals(db, P)` returned **`eventCount: 5`, `input: 500`** — org B's usage
and cost merged into org A's project rollup. Two candidate fixes were then verified, both returning
the correct **2**:

- **FIX A** — `eq(events.orgId, orgId)` in the `WHERE`, using the principal's org ✅ *(chosen)*
- **FIX B** — constraining the join itself: `and(eq(events.projectPath, workspaceKeys.projectKey), eq(workspaceKeys.orgId, events.orgId))` ✅

FIX A wins because it scopes to the **caller's** org rather than a value derived from the row, so the
single predicate delivers both isolation *and* "you cannot read another org's project".

**Why this matters for scoping the slice:** a route-layer "does this project belong to your org?"
check would **not** have fixed Spike 4 — the project genuinely belongs to org A; the leak is inside
the join. That is what makes the six repository signature changes in Task 6 non-optional.

### Verified facts (read from source during planning, not recalled)

- **45** `adminAuthorized` gates across **16** route files; **20** `app.adminEmail` user-resolutions
  across **11** route files. *(The milestone plan's "~60 call sites, 11 route files" conflated the
  two counts — corrected here.)*
- `SessionPayload.sub` is the **email** — `signSession(email, …)` at `routes/auth.ts:39`.
- The dashboard already forwards the user's session token (`lib/ingest.ts` `adminHeaders()`), so
  **zero dashboard changes** are needed. Identity is already on the wire; ingest just ignores it.
- **9** `// M15 15.1: superseded by the 15.2 request principal.` markers exist in `packages/db`
  (`alert-firings.ts:109`, `attribution.ts:215,292`, `pairing.ts:30`, `projects.ts:52,76`,
  `reports.ts:78`, `workspaces.ts:61,96`) — 15.1 left this slice an explicit worklist.
- Tenant tables carrying `org_id`: **15** + `memberships`. Global (no `org_id`): `users`,
  `pricing_catalogs`, `connector_catalogs`, `ingest_auth_failures`.
- `report_artifacts_scope_version` is `uniqueIndex(userId, reportType, scopeId, version)`
  (`schema.ts:404`).
- Drizzle wraps driver errors: pg `code`/`constraint` live on `.cause` (`tenancy.int.test.ts:196-205`).
- `workspace_keys` inserts require `userId` **and** `sourceConnector` beyond the obvious columns
  (hit as a `23502` during Spike 4 — saved for the test-writing task).
- `insertReportArtifact`'s only callers pass a `Db` (not a `Tx`), so widening it to require `Db` for
  the retry is safe.

### Trade-offs accepted

- **One extra DB round trip** on the ~25 routes that did not previously resolve a user (catalog,
  metrics, replay, search). Acceptable: these are admin-gated, low-frequency endpoints, and the 20
  routes that *did* resolve a user get **faster**. If profiling ever objects, the fix is a
  per-request memo, not a return to a boolean gate.
- **`connectorHealth` keeps user-scoping rather than org-scoping.** It is correct today (verified),
  and the alert-derivation path (`deriveAlerts`, FROZEN) hangs off it. Converting it is churn with
  no security gain; 15.3's RLS covers it as a backstop.
- **The alert-reconcile-per-SSE-tick cost (audit B.4) is NOT addressed here.** It is explicitly
  assigned to **15.3** in the milestone plan. Do not pull it forward — this slice is already the
  widest edit in the repo's history.

### Sequencing note

The milestone plan's Risk #1 requires **15.3 to land immediately after this slice**: until RLS is on,
application scoping is the *only* isolation. Do not release 15.2 and defer 15.3 across releases.
