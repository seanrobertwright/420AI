# Feature: M15 Slice 15.1 — Tenancy Schema (`organizations` + `memberships` + `org_id`)

The following plan should be complete, but it is important that you validate documentation and
codebase patterns and task sanity before you start implementing.

Pay special attention to naming of existing utils, types and models. Import from the right files.

Conventions are **not re-pasted** here — they live in [`CLAUDE.md`](../../CLAUDE.md) (module/TS rules,
invariants, logging boundaries, the Drizzle/SQL gotchas, and the `repo-health` gate). The milestone
definition and the settled decisions D-M15-1…13 live in
[`.agents/plans/m15-multi-user-access-control.md`](./m15-multi-user-access-control.md) — **do not
re-litigate them.** The RLS mechanics this slice must not contradict are in
[`docs/research/m15-rls-spike.md`](../../docs/research/m15-rls-spike.md).

## Feature Description

Introduce the **organization** as the tenancy boundary of the archive (D-M15-1). Two new tables —
`organizations` and `memberships` — plus a `NOT NULL org_id` column on the **15 tenant-owned tables**,
backfilled from the existing ownership chain so that the current single admin becomes the `owner` of an
auto-created personal organization and every existing row lands in it (D-M15-11).

This is the **data-migration foundation** of M15. It is deliberately **behavior-neutral**: no read path
gains an org filter, no auth changes, no route changes, no API shape changes. The column exists, is
populated, is enforced `NOT NULL` + FK, and every write path fills it correctly. Scoping reads by the
request's principal is **15.2**; enforcing isolation in Postgres via RLS is **15.3**.

## User Story

As the **operator of a 420AI archive that is going to become a multi-tenant SaaS**
I want **every tenant-owned row to carry the organization that owns it, backfilled from existing data**
So that **later slices can scope reads and enforce database-level isolation without a downtime
migration on live customer data.**

## Problem Statement

The archive has exactly one real install and zero customers today, but SaaS (M16) is committed scope.
Every tenant-owned table is currently scoped either by `user_id` or by nothing at all:

- `events` and `raw_source_records` carry **no ownership column**. Ownership is only inferable through
  `events.machine_id → machines.user_id`, and `events.machine_id` is **nullable** by design ("most
  recent ingesting machine" — `packages/db/src/schema.ts:147-148`), so that chain is not total.
- `search_documents_entity` is **globally unique** on `(entity_type, entity_id)`
  (`packages/db/src/schema.ts:565`), and for `session`/`event` rows the entity id is a connector-supplied
  session id or an event fingerprint — i.e. **globally scoped strings**. Two tenants can collide on the
  index (audit finding **B.1**).
- There is no `organizations` table at all, so there is nothing for a role, a grant, or an RLS policy to
  reference.

Retrofitting a tenancy column across ~15 tables after customers exist is a downtime migration on live
data. **This is the cheapest this change will ever be.**

## Solution Statement

One hand-authored Drizzle migration (`0014`) that:

1. Creates `organizations` + `memberships` (four fixed roles per D-M15-4 stored as text; **enforcement is
   15.4**).
2. Adds `org_id uuid` **nullable** to the 15 tenant tables (instant — no table rewrite).
3. Creates **one personal org per existing user**, with that user as its `owner` (D-M15-11).
4. Backfills `org_id` along the ownership chain (user → membership; machine → org; commit → files), with a
   deterministic documented fallback for rows whose chain is broken.
5. Promotes every `org_id` to `NOT NULL`, adds the FKs and per-table `*_by_org` indexes.
6. Re-scopes `search_documents_entity` to `(org_id, entity_type, entity_id)` — audit **B.1**.

Application-side, every **write** path learns to fill `org_id`, using the **smallest possible blast
radius**: machine-keyed writes derive the org from `machines.org_id` inside the repository (the DB is the
authority — a machine cannot change orgs), and user-keyed writes resolve it through a new
`getOrgIdForUser` helper. **No public repository signature changes** — see the resolved conflict in
"Design decisions" below.

## Feature Metadata

**Feature Type**: New Capability (schema/data migration)
**Estimated Complexity**: **Medium-High** — mechanically wide (15 tables, 17 insert sites, ~20 int-test
seed blocks) but conceptually narrow and fully spiked.
**Primary Systems Affected**: `packages/db` (schema, migration, 10 repositories), `apps/ingest` (2 route
files), the integration test suite.
**Dependencies**: **None new.** No new npm package. `drizzle-kit@0.31.10` / `drizzle-orm@0.45.2` are
already present (verified: `npm ls drizzle-kit drizzle-orm -w @420ai/db`).

---

## CONTEXT REFERENCES

### Relevant Codebase Files — IMPORTANT: YOU MUST READ THESE BEFORE IMPLEMENTING

- `packages/db/src/schema.ts` (whole file, 571 lines) — Why: every table you touch. Note the column-comment
  style; **match it**. Key lines: `users` 50-58, `machines` 60-83, `events` 132-168 (the fingerprint PK
  comment), `search_documents` 543-570 (the `GENERATED` `search_vector` you must never write, and the
  `search_documents_entity` index at :565).
- `packages/db/src/repositories/ingest.ts` (whole file, 115 lines) — Why: the single most important write
  path. `ingestBatch` opens the transaction at :30; raw insert :35-53; the events upsert :69-108. The
  `onConflictDoUpdate.set` block at :92-106 is where the **"never flip an existing row's org_id"** hazard
  (D-M15-2) lives.
- `packages/db/src/repositories/machines.ts` (whole file, 99 lines) — Why: `createMachine` :14-28,
  `recordHeartbeat` :45-82 (inserts `machine_heartbeats` at :68), and `getMachineUserId` :89-99 — the
  **exact pattern** your new `getMachineOrgId` mirrors.
- `packages/db/src/repositories/users.ts` (whole file, 64 lines) — Why: the only two `users` insert sites
  (`ensureUserByEmail` :22-29, `setUserPassword` :53-64). Personal-org creation hooks in here.
- `packages/db/src/repositories/search.ts` — Why: three separate edits. `upsertDoc` :75-100 (its
  `onConflictDoUpdate` **target** at :89 must change with the index or every write 500s), `DocInput`
  :55-67, `reportDoc` :107-123, `projectDoc` :129+, and `indexSessions` :301-327 — specifically the
  `min(${machines.userId}::text)` aggregate at **:314** whose org twin you add.
- `packages/db/src/repositories/pairing.ts` (whole file, 47 lines) — Why: `createPairingCode` :20-29 and
  `redeemPairingCode` :35-47 (returns `{userId}`; you extend it to `{userId, orgId}`).
- `packages/db/src/repositories/tokens.ts` (whole file, 30 lines) — Why: `issueIngestToken` :10-17 inserts
  `ingest_tokens`; `findMachineIdByToken` :23-30 is the auth hot path — **leave its signature alone**
  (see "auth-boundary" note).
- `packages/db/src/repositories/git.ts` :37 (`git_commits`) and :62 (`git_commit_files`) — Why: the only
  place where a child row's org must come from its just-inserted parent.
- `packages/db/src/repositories/projects.ts` :37, :59 · `workspaces.ts` :44, :76 · `reports.ts` :55 ·
  `attribution.ts` :242, :287 · `alert-firings.ts` :109 — Why: the user-keyed insert sites.
- `packages/db/src/rollback.ts` (whole file, 60 lines) — Why: your `down/` SQL is executed by this. It
  splits on the literal string `--> statement-breakpoint` at :42 and runs each chunk as **one**
  `client.query` inside a single transaction (:40-49).
- `packages/db/drizzle/down/0010_watery_spencer_smythe.down.sql` — Why: the **only** existing multi-statement
  down file; copy its `--> statement-breakpoint` usage exactly.
- `packages/db/drizzle/0013_married_tarot.sql` + its `down/` twin — Why: the most recent migration pair;
  match the down file's header-comment style.
- `packages/db/src/repositories/ingest.int.test.ts` :78-91 — Why: **the canonical int-test seed block**
  (TRUNCATE at :79-81, `users` insert :82-85, `machines` insert :86-90). There is **no shared seed helper
  module** — this block is copy-pasted into ~20 files. Yours must extend the copy in each.
- `packages/db/src/rollback.int.test.ts` — Why: the existing rollback test pattern.
- `vitest.global-setup.ts` (whole file, 15 lines) — Why: migrations run once here against
  `DATABASE_URL_TEST`; you do **not** change this file.
- `packages/db/src/index.ts` — Why: the barrel. Every new exported symbol must be re-exported here or
  `apps/ingest` cannot import it.

### New Files to Create

- `packages/db/drizzle/0014_<drizzle-generated-tag>.sql` — the hand-edited up migration (see Task 3).
- `packages/db/drizzle/down/0014_<same-tag>.down.sql` — the hand-authored down migration.
- `packages/db/drizzle/meta/0014_snapshot.json` — **generated**, do not hand-edit.
- `packages/db/src/repositories/organizations.ts` — `ensurePersonalOrg`, `getOrgIdForUser`,
  `findOrgIdByUserId`.
- `packages/db/src/repositories/organizations.int.test.ts` — idempotency + backfill-shape tests.
- `packages/db/src/repositories/tenancy.int.test.ts` — the slice's headline negative tests (org
  immutability on re-ingest; `search_documents` cross-org non-collision).

### Relevant Documentation — READ BEFORE IMPLEMENTING

- [PostgreSQL 17 — `ALTER TABLE`](https://www.postgresql.org/docs/17/sql-altertable.html#SQL-ALTERTABLE-DESC-SET-NOT-NULL)
  - Section: `SET NOT NULL` / `ADD COLUMN`
  - Why: explains why `ADD COLUMN … NOT NULL` without a default **fails on a non-empty table**, which is
    exactly what `drizzle-kit` emits and why this migration must be hand-edited. (Proven by spike — see
    NOTES.)
- [PostgreSQL 17 — `CREATE INDEX` / unique indexes](https://www.postgresql.org/docs/17/indexes-unique.html)
  - Why: the `search_documents_entity` re-scope; and why the **down** migration can legitimately fail if
    two orgs hold the same `(entity_type, entity_id)`.
- [PostgreSQL 17 — `INSERT … ON CONFLICT`](https://www.postgresql.org/docs/17/sql-insert.html#SQL-ON-CONFLICT)
  - Section: "conflict_target"
  - Why: `upsertDoc`'s conflict target must exactly match the new unique index's column list, or Postgres
    raises `there is no unique or exclusion constraint matching the ON CONFLICT specification`.
- [Drizzle ORM — `drizzle-kit generate`](https://orm.drizzle.team/docs/drizzle-kit-generate)
  - Why: confirms `generate` is a pure schema-diff (it does not read the DB) and that editing the emitted
    `.sql` before it is ever applied is supported.
- [`docs/research/m15-rls-spike.md`](../../docs/research/m15-rls-spike.md) — Findings 1-4 + "DECIDED".
  - Why: 15.3 will put RLS policies on the very columns you add. Nothing here may contradict the
    `withOrg` + `set_config(…, true)` pattern, and you must **not** implement it in this slice.

### Patterns to Follow

**Naming.** `snake_case` SQL columns / `camelCase` TS fields (`org_id` ↔ `orgId`), `kebab-case.ts` files,
relative imports ending `.js`, `import type` for type-only imports. Index names follow the existing
`<table>_by_<key>` (non-unique) and `<table>_<keys>` (unique) convention — e.g. `events_by_org`,
`memberships_org_user`.

**Column-comment style.** Every non-obvious column in `schema.ts` carries a comment naming the milestone
and the decision. Mirror it:

```ts
// M15 15.1 tenancy (D-M15-1/D-M15-2). Fixed at capture time and never re-derived —
// which is exactly why it is a COLUMN here while project attribution stays a JOIN.
// NEVER included in the fingerprint, and never overwritten by a re-ingest.
orgId: uuid("org_id")
  .notNull()
  .references(() => organizations.id),
```

**Repository style.** Silent libraries: throw typed/plain errors, never log, never `process.exit`
(CLAUDE.md "Logging / process boundaries"). Accept `DbClient` (`Db | Tx`) so functions compose inside a
caller's transaction — see `packages/db/src/client.ts:15`. Mirror `getMachineUserId`
(`machines.ts:89-99`) verbatim in shape:

```ts
/** Resolve the owning org for a machine (M15 15.1). Undefined for an unknown machine id. */
export async function getMachineOrgId(db: DbClient, machineId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ orgId: machines.orgId })
    .from(machines)
    .where(eq(machines.id, machineId))
    .limit(1);
  return row?.orgId;
}
```

**Migration style.** Statements separated by `--> statement-breakpoint`; drizzle emits it both
inline-appended (`…;--> statement-breakpoint`) and on its own line — both are accepted by
`rollback.ts:42`. Down files open with a comment naming the migration and what it reverses
(`down/0009_exotic_ben_grimm.down.sql:1`).

**Int-test seed style.** `TRUNCATE … RESTART IDENTITY CASCADE` then inline inserts, in a `beforeEach`.
Every seed block gains an org. The canonical extension:

```ts
await dbh.db.execute(
  sql`TRUNCATE raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
);
const [u] = await dbh.db
  .insert(users)
  .values({ email: "test@example.com" })
  .returning({ id: users.id });
// M15 15.1: every user has exactly one personal org; machines/events hang off it.
orgId = await ensurePersonalOrg(dbh.db, u!.id, "test@example.com");
const [m] = await dbh.db
  .insert(machines)
  .values({ orgId, userId: u!.id, name: "test-machine" })
  .returning({ id: machines.id });
machineId = m!.id;
```

> **Spike-snippet fidelity.** The migration SQL reproduced in Task 3/4 below is **verbatim the SQL that
> was executed during planning** against a clone of the real 413,765-event archive, and its assertions
> (0 nulls, 1 org, index re-scoped, down+re-up cycle green) are recorded in NOTES. If you change a
> statement, you have left the spiked path — re-run the drill.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation — schema + migration

Declare the two new tables and the 15 `org_id` columns in `schema.ts`, generate the migration with
`drizzle-kit`, then **hand-edit** the generated SQL into the four-step
add-nullable → backfill → `SET NOT NULL` → FK/index sequence, and hand-author the `down/` twin.

### Phase 2: Core Implementation — the organizations repository

`ensurePersonalOrg` (idempotent create of org + `owner` membership) and `getOrgIdForUser` /
`getMachineOrgId` resolvers. Wire personal-org creation into the two `users` insert sites so the
invariant "every user has exactly one org" holds by construction going forward, exactly as the backfill
made it hold for history.

### Phase 3: Integration — fill `org_id` at all 17 insert sites

Machine-keyed writes derive from `machines.org_id`; user-keyed writes resolve via `getOrgIdForUser`;
`git_commit_files` inherits from its parent commit; `search_documents` gets org through the three doc
builders **and** its `ON CONFLICT` target is re-pointed at the new index.

### Phase 4: Testing & Validation

Extend ~20 int-test seed blocks; add the two headline negative tests (org immutability across re-ingest;
cross-org `search_documents` non-collision); prove the `db:rollback → db:migrate` cycle; run the gate
with `--require-db`.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom.

### 1. UPDATE `packages/db/src/schema.ts` — add `organizations` + `memberships`

- **IMPLEMENT**: Two new `pgTable`s, placed **above** `users` (Drizzle's `references(() => …)` callbacks
  are lazy, so declaration order is free; put them first because they are now the root of the ownership
  graph). `organizations`: `id` uuid PK defaultRandom, `name` text notNull, `isPersonal` boolean notNull
  default false, `createdAt` timestamptz notNull defaultNow. `memberships`: `id`, `orgId` → organizations,
  `userId` → users, `role` text notNull default `"member"`, `createdAt`; indexes
  `uniqueIndex("memberships_org_user").on(t.orgId, t.userId)` and `index("memberships_by_user").on(t.userId)`.
- **PATTERN**: `packages/db/src/schema.ts:183-196` (`projects` — a table with FK + a unique index).
- **IMPORTS**: none new — `pgTable, uuid, text, boolean, timestamp, index, uniqueIndex` are already imported
  at `schema.ts:1-12`.
- **GOTCHA**: `role` is **text, not a pg enum** — the repo uses text + a comment for closed sets everywhere
  (`report_artifacts.reportType` :272, `alert_firings.status` :451). Comment the four legal values
  (`owner | admin | member | viewer`, D-M15-4) and state that **enforcement is 15.4**, not here. Do **not**
  add a CHECK constraint — a fifth role in 15.4 would then need another migration.
- **VALIDATE**: `npm run typecheck` → exit 0.

### 2. UPDATE `packages/db/src/schema.ts` — add `orgId` to the 15 tenant tables + re-scope one index

- **IMPLEMENT**: Add the `orgId` column (notNull, `.references(() => organizations.id)`) to exactly these
  **15** tables, and a `index("<table>_by_org").on(t.orgId)` to each **except** `search_documents` (which
  gets org coverage from the leading column of its re-scoped unique index):

  | # | Table | Backfill source |
  | --- | --- | --- |
  | 1 | `machines` | `memberships` via `user_id` |
  | 2 | `pairing_codes` | `memberships` via `user_id` |
  | 3 | `ingest_tokens` | `machines.org_id` |
  | 4 | `raw_source_records` | `machines.org_id` |
  | 5 | `events` | `machines.org_id` (+ fallback) |
  | 6 | `projects` | `memberships` via `user_id` |
  | 7 | `workspaces` | `memberships` via `user_id` |
  | 8 | `workspace_keys` | `memberships` via `user_id` |
  | 9 | `report_artifacts` | `memberships` via `user_id` |
  | 10 | `git_commits` | `machines.org_id` |
  | 11 | `git_commit_files` | parent `git_commits.org_id` |
  | 12 | `session_git_links` | `memberships` via `user_id` |
  | 13 | `machine_heartbeats` | `machines.org_id` |
  | 14 | `alert_firings` | `memberships` via `user_id` |
  | 15 | `search_documents` | `memberships` via `user_id` (+ fallback) |

  Then change `uniqueIndex("search_documents_entity").on(t.entityType, t.entityId)` (`schema.ts:565`) to
  `.on(t.orgId, t.entityType, t.entityId)`.

- **PATTERN**: the existing `userId` column declarations, e.g. `schema.ts:186-188`.
- **GOTCHA — tables that must NOT get `org_id`** (do not "finish the set"): `users` (an identity, not
  tenant data — a user reaches orgs through `memberships`); `pricing_catalogs` and `connector_catalogs`
  (**global by D-M15-9** — they apply to every machine in the deployment, and any admin may approve);
  `ingest_auth_failures` (documented global at `schema.ts:416-417` — the token never resolved to a
  machine, so there is no org to attribute it to).
- **GOTCHA — `events` primary key is NOT composited.** Leave `fingerprint` as the sole PK. See the
  resolved conflict in "Design decisions". Adding `org_id` to the PK would change the dedup key and
  violate the CLAUDE.md fingerprint invariant.
- **VALIDATE**: `npm run typecheck` → exit 0 (it will pass; the DB does not have the columns yet, which
  is fine — Drizzle does not check the live DB at compile time).

### 3. CREATE the up migration — generate, then HAND-EDIT

- **IMPLEMENT**: Run `npm run db:generate`. It emits `packages/db/drizzle/0014_<random-tag>.sql`,
  `meta/0014_snapshot.json`, and appends to `meta/_journal.json`. **Keep the snapshot and journal exactly
  as generated. Rewrite the `.sql`.**
- **GOTCHA — this is the whole reason the task exists.** `drizzle-kit` emits
  `ALTER TABLE "events" ADD COLUMN "org_id" uuid NOT NULL;`. Against the populated archive that fails with
  `ERROR: column "org_id" of relation "events" contains null values` (**verified during planning** — see
  NOTES, Spike C). Drizzle **cannot** generate a data backfill; this is the repo's **first** migration
  containing DML, and it must be hand-written.
- **IMPLEMENT (the rewrite)**: replace the generated body with the sequence below. This is the SQL that was
  executed against a real-size clone during planning. Keep drizzle's `--> statement-breakpoint` separators
  between statements.

```sql
-- M15 15.1 tenancy (D-M15-1/2/11). HAND-EDITED after drizzle-kit generate:
-- drizzle emits `ADD COLUMN ... NOT NULL`, which fails on a populated table, and cannot
-- emit a backfill. Sequence: add nullable -> seed orgs -> backfill -> SET NOT NULL -> FK/index.
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_personal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user" ON "memberships" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_by_user" ON "memberships" USING btree ("user_id");--> statement-breakpoint

-- STEP 1: add org_id NULLABLE everywhere (metadata-only, no table rewrite).
ALTER TABLE "machines" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "ingest_tokens" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "raw_source_records" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_keys" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "report_artifacts" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "git_commits" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "git_commit_files" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "session_git_links" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "machine_heartbeats" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "alert_firings" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "search_documents" ADD COLUMN "org_id" uuid;--> statement-breakpoint

-- STEP 2: one PERSONAL org per existing user; that user is its owner (D-M15-11).
-- The join back on email is safe because users.email is UNIQUE (schema.ts:52) and the
-- org name is seeded from it; this is the only statement where org name is load-bearing.
WITH new_orgs AS (
  INSERT INTO "organizations" ("name", "is_personal")
  SELECT u.email, true FROM "users" u
  RETURNING "id", "name"
)
INSERT INTO "memberships" ("org_id", "user_id", "role")
SELECT o.id, u.id, 'owner' FROM new_orgs o JOIN "users" u ON u.email = o.name;--> statement-breakpoint

-- STEP 3: backfill along the ownership chain. machines FIRST (it is the source for the
-- machine-keyed tables below).
UPDATE "machines" m SET "org_id" = ms."org_id" FROM "memberships" ms WHERE ms."user_id" = m."user_id";--> statement-breakpoint
UPDATE "pairing_codes" p SET "org_id" = ms."org_id" FROM "memberships" ms WHERE ms."user_id" = p."user_id";--> statement-breakpoint
UPDATE "projects" p SET "org_id" = ms."org_id" FROM "memberships" ms WHERE ms."user_id" = p."user_id";--> statement-breakpoint
UPDATE "workspaces" w SET "org_id" = ms."org_id" FROM "memberships" ms WHERE ms."user_id" = w."user_id";--> statement-breakpoint
UPDATE "workspace_keys" k SET "org_id" = ms."org_id" FROM "memberships" ms WHERE ms."user_id" = k."user_id";--> statement-breakpoint
UPDATE "report_artifacts" r SET "org_id" = ms."org_id" FROM "memberships" ms WHERE ms."user_id" = r."user_id";--> statement-breakpoint
UPDATE "session_git_links" l SET "org_id" = ms."org_id" FROM "memberships" ms WHERE ms."user_id" = l."user_id";--> statement-breakpoint
UPDATE "alert_firings" a SET "org_id" = ms."org_id" FROM "memberships" ms WHERE ms."user_id" = a."user_id";--> statement-breakpoint
UPDATE "search_documents" s SET "org_id" = ms."org_id" FROM "memberships" ms WHERE ms."user_id" = s."user_id";--> statement-breakpoint
UPDATE "ingest_tokens" t SET "org_id" = m."org_id" FROM "machines" m WHERE m."id" = t."machine_id";--> statement-breakpoint
UPDATE "raw_source_records" r SET "org_id" = m."org_id" FROM "machines" m WHERE m."id" = r."machine_id";--> statement-breakpoint
UPDATE "machine_heartbeats" h SET "org_id" = m."org_id" FROM "machines" m WHERE m."id" = h."machine_id";--> statement-breakpoint
UPDATE "git_commits" g SET "org_id" = m."org_id" FROM "machines" m WHERE m."id" = g."machine_id";--> statement-breakpoint
UPDATE "events" e SET "org_id" = m."org_id" FROM "machines" m WHERE m."id" = e."machine_id";--> statement-breakpoint
UPDATE "git_commit_files" f SET "org_id" = g."org_id" FROM "git_commits" g WHERE g."id" = f."commit_id";--> statement-breakpoint

-- STEP 3b: deterministic fallback. events.machine_id is NULLABLE by design (schema.ts:148),
-- and a search_documents row could outlive its user's rows. Oldest personal org wins. On the
-- real archive this matched ZERO rows (413765/413765 events already had a machine) — it exists
-- so the SET NOT NULL below can never fail on an install whose chain is broken.
UPDATE "events" SET "org_id" = (SELECT "id" FROM "organizations" ORDER BY "created_at","id" LIMIT 1) WHERE "org_id" IS NULL;--> statement-breakpoint
UPDATE "search_documents" SET "org_id" = (SELECT "id" FROM "organizations" ORDER BY "created_at","id" LIMIT 1) WHERE "org_id" IS NULL;--> statement-breakpoint

-- STEP 4: enforce NOT NULL (one line per table — 15 total).
ALTER TABLE "machines" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
-- … repeat verbatim for: pairing_codes, ingest_tokens, raw_source_records, events, projects,
-- workspaces, workspace_keys, report_artifacts, git_commits, git_commit_files,
-- session_git_links, machine_heartbeats, alert_firings, search_documents …
--> statement-breakpoint

-- STEP 5: FKs (one per table, drizzle's exact naming: <table>_org_id_organizations_id_fk).
ALTER TABLE "machines" ADD CONSTRAINT "machines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- … repeat for the other 14 …

-- STEP 6: per-table org indexes (14 — search_documents is covered by its unique index below).
CREATE INDEX "machines_by_org" ON "machines" USING btree ("org_id");--> statement-breakpoint
-- … repeat for the other 13 …

-- STEP 7: audit B.1 — search_documents_entity was GLOBALLY unique on (entity_type, entity_id),
-- and for session/event rows entity_id is a connector session id / event fingerprint, i.e. a
-- globally-scoped string. Two orgs could collide. Re-scope it to the org.
DROP INDEX "search_documents_entity";--> statement-breakpoint
CREATE UNIQUE INDEX "search_documents_entity" ON "search_documents" USING btree ("org_id","entity_type","entity_id");
```

- **GOTCHA**: `DROP INDEX "search_documents_entity"` must come **before** the new one is created (same
  name). drizzle already orders it first in the generated file; keep it wherever it lands **before** Step 7's
  `CREATE`, and do not let it land after `ALTER TABLE search_documents DROP …` in the down file.
- **VALIDATE**: `npm run db:up && npm run db:migrate` → exits 0. Then
  `docker exec -i 420ai-archive psql -U 420ai -d 420ai -c "SELECT count(*) FROM events WHERE org_id IS NULL;"`
  → **0**.

### 4. CREATE `packages/db/drizzle/down/0014_<same-tag>.down.sql`

- **IMPLEMENT**: Reverse in the mirror order. `DROP COLUMN` cascades away that column's FK **and** its
  `*_by_org` index automatically, so the down file only needs the index re-scope, the 15 drops, and the two
  table drops:

```sql
-- Down-migration for 0014_<tag> (M15 15.1). Reverses: the org-scoped search index, the 15
-- org_id columns (their FKs and *_by_org indexes drop with the column), and both new tables.
-- WARNING: this DESTROYS tenancy data. Restoring the globally-unique search_documents_entity
-- index FAILS LOUDLY if two orgs hold the same (entity_type, entity_id) — which is correct:
-- rolling back a genuinely multi-tenant archive must not silently discard rows.
DROP INDEX "search_documents_entity";--> statement-breakpoint
ALTER TABLE "machines" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "pairing_codes" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "ingest_tokens" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "raw_source_records" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "workspace_keys" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "report_artifacts" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "git_commits" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "git_commit_files" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "session_git_links" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "machine_heartbeats" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "alert_firings" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "search_documents" DROP COLUMN "org_id";--> statement-breakpoint
CREATE UNIQUE INDEX "search_documents_entity" ON "search_documents" USING btree ("entity_type","entity_id");--> statement-breakpoint
DROP TABLE "memberships";--> statement-breakpoint
DROP TABLE "organizations";
```

- **GOTCHA**: `rollback.ts:42` splits on the literal `--> statement-breakpoint` and runs each chunk as one
  query. Do **not** use a bare `;` as your only separator — chunks would run as multi-statement queries and
  the per-statement failure attribution is lost.
- **VALIDATE**: `npm run db:rollback` then `npm run db:migrate`, both exit 0 (Task 15 does this against a
  real-size copy).

### 5. CREATE `packages/db/src/repositories/organizations.ts`

- **IMPLEMENT**: three functions.
  - `findOrgIdByUserId(db, userId): Promise<string | undefined>` — the user's membership org, **deterministic**:
    `orderBy(memberships.createdAt, memberships.id).limit(1)`.
  - `getOrgIdForUser(db, userId): Promise<string>` — as above but throws
    `new Error(\`user ${userId} has no organization\`)` when absent. This is the resolver every user-keyed
    write path calls.
  - `ensurePersonalOrg(db, userId, name): Promise<string>` — returns the existing membership's org if there
    is one; otherwise inserts an `organizations` row (`isPersonal: true`, `name`) **and** a `memberships`
    row with `role: "owner"`, returning the new org id. Idempotent.
- **PATTERN**: `packages/db/src/repositories/users.ts` (whole file) for shape/doc-comment density;
  `machines.ts:89-99` for the single-row select.
- **IMPORTS**: `import { and, asc, eq } from "drizzle-orm";`,
  `import type { DbClient } from "../client.js";`,
  `import { memberships, organizations } from "../schema.js";`
- **GOTCHA — documented, accepted race.** Two concurrent first-ever calls for the same user could create two
  personal orgs (nothing constrains "≤1 membership per user", and adding such a constraint would block the
  multi-org support 15.10 needs). Mitigation: `findOrgIdByUserId` is **deterministic** (`ORDER BY created_at,
  id LIMIT 1`), so a duplicate never produces a *flapping* answer. Both call sites are admin-gated and
  low-frequency. **Write this in the doc comment** — do not leave it implicit.
- **GOTCHA**: takes `DbClient`, not `Db` — it must compose inside `pair.ts`'s existing transaction.
- **VALIDATE**: `npm run typecheck` → exit 0.

### 6. UPDATE `packages/db/src/index.ts` — export the new symbols

- **IMPLEMENT**: `export { ensurePersonalOrg, getOrgIdForUser, findOrgIdByUserId } from "./repositories/organizations.js";`
  and add `getMachineOrgId` to the existing `machines.js` export line. Export the `organizations` /
  `memberships` tables from the schema re-export if tables are individually re-exported (check the file —
  mirror however `machines`/`users` are exposed).
- **GOTCHA**: `apps/ingest` imports **only** from `@420ai/db` (the barrel), never by deep path. A missing
  re-export surfaces as a confusing "has no exported member" at the route, not here.
- **VALIDATE**: `npm run typecheck` → exit 0.

### 7. UPDATE `packages/db/src/repositories/users.ts` — create the personal org with the user

- **IMPLEMENT**: after the upsert in **both** `ensureUserByEmail` (:22-29) and `setUserPassword` (:53-64),
  call `await ensurePersonalOrg(db, id, email)` before returning the id.
- **PATTERN**: the existing return-the-id shape; keep both functions' signatures **unchanged**.
- **GOTCHA**: `setUserPassword` runs on **every** server boot when `ADMIN_PASSWORD` is set
  (`apps/ingest/src/server.ts:124`) — `ensurePersonalOrg` must be idempotent or every restart creates an
  org. This is the single most important reason Task 5 returns-existing-first.
- **GOTCHA**: there is a **third**, inline `users` insert that bypasses this repo entirely —
  `apps/ingest/src/routes/pairing-codes.ts:29`. Task 11 handles it. (D-M15-8 deletes that whole primitive,
  but that is **15.5**, not here — do not remove it now.)
- **VALIDATE**: `npx vitest run packages/db/src/repositories/organizations.int.test.ts` (after Task 16).

### 8. UPDATE `packages/db/src/repositories/machines.ts` — `getMachineOrgId` + fill two tables

- **IMPLEMENT**: (a) add `getMachineOrgId` exactly as in "Patterns to Follow"; (b) `createMachine` gains
  `orgId` in its `input` object and writes it; (c) `recordHeartbeat` derives the org itself —
  `const orgId = await getMachineOrgId(db, machineId)` — and includes it in the `machine_heartbeats` insert
  at :68, throwing if undefined.
- **PATTERN**: `getMachineUserId` at :89-99.
- **GOTCHA**: `createMachine` is called from exactly **one** place (`apps/ingest/src/routes/pair.ts:19`), so
  extending its `input` object is a one-line ripple — that is why it takes an explicit param while
  `recordHeartbeat` (called from routes **and** two int-test suites) derives instead.
- **VALIDATE**: `npm run typecheck` → exit 0.

### 9. UPDATE `packages/db/src/repositories/ingest.ts` — the events/raw write path

- **IMPLEMENT**: inside the existing `db.transaction` (:30), first resolve
  `const orgId = await getMachineOrgId(tx, machineId)`; throw a clear `Error` if undefined. Add `orgId` to
  the `rawSourceRecords` values (:36-44) and the `events` values (:71-90). **Do NOT add `orgId` to the
  `onConflictDoUpdate.set` block (:92-106).**
- **PATTERN**: the existing `machineId` threading in the same two value blocks.
- **GOTCHA — the D-M15-2 hazard, and the reason for the negative test in Task 17.** `events.fingerprint` is
  machine-independent by design, so the same logical event ingested from two machines converges to **one
  row**. Including `orgId` in the `set:` block would let a second org's ingest **silently flip an existing
  row's owner** — a cross-tenant write. Omitting it means the **first** writer's org wins and later ingests
  update only the payload/parser/cost fields, exactly as today. Add a comment saying so; the test in Task 17
  pins it.
- **GOTCHA**: keep the signature `ingestBatch(db, machineId, batch, repricing?)` **unchanged** — there are
  **25** call sites (1 route, 1 in `reparse.ts:206`, 23 in int tests). Deriving the org inside is what keeps
  this a 3-line edit instead of a 25-file one, and it makes passing the *wrong* org structurally impossible.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/ingest.int.test.ts` (after Task 16).

### 10. UPDATE the remaining machine-keyed + user-keyed repositories

- **IMPLEMENT**, each filling `orgId`:
  - `tokens.ts:15` `issueIngestToken` — derive via `getMachineOrgId`. **Leave `findMachineIdByToken`
    (:23-30) alone** (see the auth-boundary gotcha).
  - `pairing.ts:27` `createPairingCode` — resolve via `getOrgIdForUser(db, userId)`;
    `redeemPairingCode` (:35-47) returns `{ userId, orgId: row.orgId }` so `pair.ts` can pass `orgId`
    straight into `createMachine`.
  - `git.ts:37` `recordGitCommits` — derive once via `getMachineOrgId`; `git.ts:62` `git_commit_files`
    reuses that same `orgId` (it is the parent commit's org by construction).
  - `projects.ts:37, :59`, `workspaces.ts:44, :76`, `reports.ts:55`, `attribution.ts:242, :287`,
    `alert-firings.ts:109` — each already has `userId` in scope; resolve with `getOrgIdForUser`.
- **GOTCHA — auth boundary.** `findMachineIdByToken` and the pairing-code lookup are read **before any org
  context exists**. They must stay org-agnostic. When 15.3 enables RLS, these two tables need a policy that
  permits the pre-context lookup (or must be excluded) — **note it in the code comment for 15.3; do not
  attempt it here.**
- **GOTCHA**: `getOrgIdForUser` is a **temporary** seam. 15.2 introduces the request principal and replaces
  these per-call-site lookups with `principal.orgId`. Mark each with
  `// M15 15.1: superseded by the 15.2 request principal.` so 15.2 can find them with one grep.
- **VALIDATE**: `npm run typecheck` → exit 0.

### 11. UPDATE `apps/ingest/src/routes/pair.ts` and `routes/pairing-codes.ts`

- **IMPLEMENT**: `pair.ts` — take `orgId` from the extended `redeemPairingCode` result (:18) and pass it into
  `createMachine` (:19). `pairing-codes.ts` — after the inline `users` upsert (:29), call
  `ensurePersonalOrg(app.db, userId, email)` so a user created by that path also gets an org before
  `createPairingCode` (:36) needs one.
- **PATTERN**: `pair.ts` already runs inside a transaction — keep the new calls inside it.
- **GOTCHA**: these are the **only two** `apps/ingest` files this slice touches. If you find yourself
  editing a third route, you have drifted into 15.2.
- **VALIDATE**: `npx vitest run apps/ingest/src/app.int.test.ts` (after Task 16).

### 12. UPDATE `packages/db/src/repositories/search.ts` — three coordinated edits

- **IMPLEMENT**:
  1. `DocInput` (:55-67) gains `orgId: string`.
  2. `upsertDoc` (:75-100): write `orgId` in `.values()`, and change the `onConflictDoUpdate` **target**
     (:89) from `[searchDocumentsTbl.entityType, searchDocumentsTbl.entityId]` to
     `[searchDocumentsTbl.orgId, searchDocumentsTbl.entityType, searchDocumentsTbl.entityId]`. Do **not**
     put `orgId` in the `set:` block (:90-98) — same reasoning as Task 9.
  3. `indexSessions` (:310-319): add an org twin beside the existing user aggregate —
     `orgId: sql<string>\`min(${machines.orgId}::text)\`` — and thread it through `indexOneSession` into
     both the session doc (:274) and the per-event docs (:219). `reportDoc`/`projectDoc` take org from
     `reportArtifacts.orgId` / `projects.orgId`, which you add to the selects at :368/:400 and :338/:414.
- **GOTCHA — this is the highest-risk edit in the slice.** If the `ON CONFLICT` target does not exactly match
  the new unique index's column list, **every** search-index write fails at runtime with
  `there is no unique or exclusion constraint matching the ON CONFLICT specification`. Unit tests will not
  catch it — `search.int.test.ts` will.
- **GOTCHA**: `min(<uuid col>::text)` returns **text**, matching the existing `userId` aggregate at :314 —
  no ISO/`Number()` normalization applies here (this is neither a timestamp nor a `numeric`), but keep the
  `::text` cast: `min()` has no uuid overload in Postgres.
- **GOTCHA**: never write `search_vector` — it is `GENERATED ALWAYS` (`schema.ts:559-561`) and an explicit
  write errors.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/search.int.test.ts` (after Task 16).

### 13. UPDATE `CLAUDE.md` — amend the invariants block

- **IMPLEMENT**: In "Invariants — do NOT change without a milestone-level decision", amend the
  events/attribution rule with the D-M15-2 distinguishing test, verbatim in spirit:

  > A column belongs on `events` if it is **fixed at capture time and never re-derived**. `org_id` passes
  > (whose data it is, fixed by which machine uploaded it) and is therefore a column as of M15 15.1.
  > `project_id` fails (attribution changes when a workspace is remapped) and stays a JOIN. The
  > **fingerprint is unchanged** — `org_id` is never a fingerprint input, and a re-ingest never overwrites
  > an existing row's `org_id`.

- **PATTERN**: the existing invariant bullets.
- **GOTCHA**: the milestone plan schedules this amendment for **this** slice ("Invariant amendments — land
  with the slice that makes them true"). The *second* amendment (two-role integration testing) belongs to
  **15.3** — do not add it now.
- **VALIDATE**: `npx prettier --check CLAUDE.md` → passes.

### 14. UPDATE the ~20 integration-test seed blocks

- **IMPLEMENT**: in each file below, add `memberships, organizations` to the `TRUNCATE` list and insert an
  org via `ensurePersonalOrg` between the `users` and `machines` inserts, then pass `orgId` to every direct
  `machines` / `events` / `report_artifacts` / `machine_heartbeats` insert in that file.
  Files (from the enumeration): `packages/db/src/repositories/{ingest,alert-firings,git,key-rotation,monitor,pairing,pricing-catalogs,projections,reports,reprice,search,transcript,workspaces}.int.test.ts`,
  `apps/ingest/src/{reparse,replay,app,auth,catalog,delivery,search}.int.test.ts`,
  `apps/ingest/src/reports/reports-m13.int.test.ts`,
  `apps/collector/src/{capture-engine,push}.int.test.ts`.
- **PATTERN**: the canonical block in "Patterns to Follow" (derived from `ingest.int.test.ts:78-91`).
- **GOTCHA**: `TRUNCATE users … CASCADE` cascades to `memberships` (FK) but **not** to `organizations`
  (nothing in `organizations` references `users`). Omit `organizations` from the list and orgs accumulate
  across tests — a slow leak that makes the "oldest org" fallback non-deterministic between runs. **Add
  both table names explicitly.**
- **GOTCHA**: tests that TRUNCATE only a subset (e.g. `connector-catalogs.int.test.ts:42`,
  `auth-failures.int.test.ts:24`) touch no tenant table — **leave them alone**.
- **VALIDATE**: `npm run repo-health -- --require-db` (Task 18).

### 15. VALIDATE the migration against a real-size copy (the D-M15-13 rollback drill)

- **IMPLEMENT**: clone the live archive and run the full cycle. Commands, verified during planning:

```bash
docker exec -i 420ai-archive psql -U 420ai -d postgres -c 'CREATE DATABASE "420ai_drill" TEMPLATE "420ai";'
DATABASE_URL='postgres://420ai:<pw>@localhost:5433/420ai_drill' npm run db:migrate
docker exec -i 420ai-archive psql -U 420ai -d 420ai_drill -c \
  "SELECT (SELECT count(*) FROM events WHERE org_id IS NULL) ev_null,
          (SELECT count(*) FROM raw_source_records WHERE org_id IS NULL) raw_null,
          (SELECT count(*) FROM organizations) orgs;"
DATABASE_URL='postgres://420ai:<pw>@localhost:5433/420ai_drill' npm run db:rollback
DATABASE_URL='postgres://420ai:<pw>@localhost:5433/420ai_drill' npm run db:migrate
docker exec -i 420ai-archive psql -U 420ai -d postgres -c 'DROP DATABASE "420ai_drill";'
```

- **GOTCHA**: `CREATE DATABASE … TEMPLATE` fails if **any** connection to the source database is open — stop
  the ingest server and any dashboard first.
- **GOTCHA**: capture the output into `.agents/qa/m15-signoff/` — this is a **D-M15-13 pre-sign-off
  checklist item** ("Migration + `db:rollback` → `db:migrate` cycle proven on a copy of the real archive"),
  and Risk 4 of the milestone plan names it specifically.
- **EXPECTED** (planning spike numbers on 413,765 events / 256,085 raw / 30,361 search docs): up ≈ **20 s**,
  down ≈ **0.9 s**, `ev_null = 0`, `raw_null = 0`, `orgs = 1`.
- **VALIDATE**: all three counts as above; both `npm run db:migrate` runs exit 0.

### 16. RUN the migration against the test database

- **IMPLEMENT**: `DATABASE_URL=$DATABASE_URL_TEST npm run db:migrate`.
- **GOTCHA**: **`npm run db:migrate` migrates `DATABASE_URL` only — `420ai_test` is a separate database and
  is NOT migrated by it.** `vitest.global-setup.ts` does migrate it when `DATABASE_URL_TEST` is set, so a
  plain suite run also works; either way, do this **before** expecting any int test to pass.
- **VALIDATE**: `docker exec -i 420ai-archive psql -U 420ai -d 420ai_test -c "\d events"` shows `org_id`.

### 17. CREATE `packages/db/src/repositories/tenancy.int.test.ts` — the headline negative tests

- **IMPLEMENT**: two orgs, two users, one machine each, then:
  1. **Org immutability across converging re-ingest (D-M15-2).** Ingest a batch as machine A (org A). Ingest
     **the same fingerprints** as machine B (org B). Assert: the event row count is unchanged (they
     converged), `events.machine_id` **did** move to B (today's documented behavior), and `events.org_id` is
     **still org A**. This is the test the milestone plan calls "a dedicated negative test".
  2. **`search_documents` cross-org non-collision (audit B.1).** Insert a doc for org A and one for org B
     with the **same** `(entity_type, entity_id)`. Assert both rows exist (2 rows) — under the old global
     index this was impossible.
  3. **Backfill shape.** Assert every tenant table's rows for a seeded org all carry that org id (a loop over
     the 15 table names via raw `sql` is fine and reads well).
- **PATTERN**: `packages/db/src/repositories/ingest.int.test.ts` (`describe.skipIf(!TEST_URL)`, `beforeAll`
  `createDb`, `afterAll` `pool.end()`, `beforeEach` TRUNCATE+seed).
- **GOTCHA**: guard with `describe.skipIf(!process.env.DATABASE_URL_TEST)` like every other `*.int.test.ts`,
  and name the file `*.int.test.ts` so it is excluded from `tsc -b` (`packages/db/tsconfig.json`) and
  counted by the `--require-db` gate.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/tenancy.int.test.ts` → all pass, 0 skipped
  (with the test DB up).

### 18. UPDATE `SUMMARY.md` + run the full gate

- **IMPLEMENT**: flip **15.1** to ✅ with a `DONE <date> (PR #NN)` note in **both** the §0 status block and
  the §6 M15 slice list, per the CLAUDE.md "SUMMARY.md is a rebuildable projection" rule. Then run the gate.
- **GOTCHA**: `scripts/check-summary.mjs` **fails the gate** if an execution report exists for a slice that
  is not marked done — this is not optional bookkeeping.
- **GOTCHA**: CI runs `format:check` over `.md`, which local `repo-health` does not — run
  `npm run format` before pushing. CI also runs `npm run lint`, which `repo-health` does not.
- **VALIDATE**: `npm run repo-health -- --require-db` → PASS with **0 skipped** int tests.

---

## TESTING STRATEGY

### Unit Tests

Little of this slice is pure — the value is in the DB layer. Do **not** invent unit tests for SQL. The one
genuinely unit-testable seam is `organizations.ts`'s deterministic ordering, and that needs a DB anyway.
Keep unit-test churn at zero; the existing `*.test.ts` files must keep passing untouched (if one breaks,
you changed behavior — investigate rather than edit the test).

### Integration Tests

- **New** `organizations.int.test.ts`: `ensurePersonalOrg` is idempotent (calling it twice returns the same
  org id and leaves exactly 1 org + 1 membership); the membership role is `owner`; `getOrgIdForUser` throws
  for a user with no org; `findOrgIdByUserId` returns `undefined` rather than throwing.
- **New** `tenancy.int.test.ts`: the three assertions in Task 17.
- **Extended**: all ~20 existing int suites, which now prove that every write path fills a `NOT NULL`
  column — the `NOT NULL` constraint turns each existing test into an implicit org-coverage test. **That is
  the main safety net of this slice**: if a write path was missed, its int test fails with
  `null value in column "org_id" violates not-null constraint`.

### Edge Cases

- An `events` row with `machine_id IS NULL` at backfill time → Step 3b fallback (matched 0 rows on the real
  archive; the test suite should still seed one such row and assert it lands in the oldest org).
- `setUserPassword` on **every** boot → `ensurePersonalOrg` must not create a second org.
- A converging re-ingest from a second org → `org_id` must not flip (Task 17.1).
- Two orgs indexing the same session id / fingerprint → both rows coexist (Task 17.2).
- `db:rollback` on a database where two orgs share an `(entity_type, entity_id)` → must **fail loudly**;
  assert the error rather than "fixing" it.
- A user with no membership reaching a user-keyed write → `getOrgIdForUser` throws a clear message rather
  than inserting `null` and hitting a constraint error.

---

## VALIDATION COMMANDS

All runnable from the repo root. Every command's pass signal is stated.

### Level 1: Syntax & Style

```bash
npm run typecheck        # root `tsc -b` across the four backend workspaces — MUST exit 0
npm run lint             # eslint — exit 0 (CI runs this; repo-health does NOT)
npm run format:check     # prettier over ts/tsx/js/mjs/json/md — exit 0 (CI runs this; repo-health does NOT)
```

### Level 2: Unit Tests

```bash
npx vitest run packages/db          # all @420ai/db unit tests pass, 0 failures
npx vitest run                      # full suite; int layer self-skips without DATABASE_URL_TEST
```

### Level 3: Integration Tests

```bash
npm run db:up
npm run db:migrate                                     # migrates DATABASE_URL (the 420ai archive)
DATABASE_URL=$DATABASE_URL_TEST npm run db:migrate     # 420ai_test is a SEPARATE db — migrate it too
npm run repo-health -- --require-db                    # PASS, and it must report 0 SKIPPED int tests
```

`repo-health -- --require-db` is **the gate**: it fails if `DATABASE_URL_TEST` is unconfigured or if any
`*.int.test.ts` self-skipped (`scripts/repo-health.mjs:183-233` asserts `ran > 0 && skipped === 0`). A plain
`repo-health` PASS does **not** prove this slice works — the whole slice is the DB layer.

### Level 4: Manual Validation

1. **Rollback drill on a real-size copy** — Task 15, verbatim. Save the transcript to
   `.agents/qa/m15-signoff/migration-rollback-drill-<date>.txt`. This clears one D-M15-13 checklist box.
2. **Live archive sanity** after `npm run db:migrate`:
   ```bash
   docker exec -i 420ai-archive psql -U 420ai -d 420ai -c \
     "SELECT o.name, o.is_personal, m.role,
             (SELECT count(*) FROM events e WHERE e.org_id = o.id) AS events
      FROM organizations o JOIN memberships m ON m.org_id = o.id;"
   ```
   Expect exactly **one** row: the admin's email, `is_personal = t`, `role = owner`, `events = 413765`
   (or the current count).
3. **End-to-end write path**: start ingest (`npm run ingest:dev`), run `collector sync` from a paired
   machine, then confirm the newly-ingested rows carry the org:
   ```bash
   docker exec -i 420ai-archive psql -U 420ai -d 420ai -c \
     "SELECT count(*) FROM events WHERE ingested_at > now() - interval '10 min' AND org_id IS NULL;"
   ```
   Expect **0**. (`raw_source_records.ingested_at`; for `events` use a fresh-session filter.)
4. **Dashboard smoke**: `npm run dashboard:dev`, load `/monitor`, `/projects`, `/search`. Everything must
   look **identical** to before — this slice is behavior-neutral. Any visible change is a bug.

### Level 5: Additional Validation (Optional)

`npm run build:dashboard` — not strictly needed (no dashboard file changes) but cheap insurance that no
shared type leaked across the boundary.

---

## ACCEPTANCE CRITERIA

- [ ] `organizations` + `memberships` exist, with `memberships_org_user` unique and `memberships_by_user`.
- [ ] All **15** tenant tables carry `org_id uuid NOT NULL` with an FK to `organizations.id`; the 14
      `*_by_org` indexes exist.
- [ ] `users`, `pricing_catalogs`, `connector_catalogs`, `ingest_auth_failures` **do not** have `org_id`.
- [ ] `search_documents_entity` is unique on `(org_id, entity_type, entity_id)`, and `upsertDoc`'s
      `ON CONFLICT` target matches it exactly.
- [ ] `events` primary key is **still** `fingerprint` alone; the fingerprint computation is untouched
      (`packages/shared/src/fingerprint.ts` has **zero** diff).
- [ ] Backfill leaves **0** NULL `org_id` on a copy of the real archive; the existing admin is `owner` of a
      single `is_personal` org.
- [ ] A converging re-ingest from another org does **not** change an existing event's `org_id` (pinned by an
      int test).
- [ ] Two orgs can hold the same `(entity_type, entity_id)` search doc (pinned by an int test).
- [ ] `db:rollback` → `db:migrate` cycle proven on a real-size copy, evidence in `.agents/qa/m15-signoff/`.
- [ ] `npm run repo-health -- --require-db` PASSES with **0 skipped**.
- [ ] `npm run lint` and `npm run format:check` pass.
- [ ] No read path gained an org filter; no route/API shape changed; the dashboard renders identically.
- [ ] `CLAUDE.md` invariants amended with the D-M15-2 fixed-at-capture test.
- [ ] `SUMMARY.md` marks 15.1 ✅ in both §0 and §6, in the same commit as the execution report.

---

## COMPLETION CHECKLIST

- [ ] All tasks completed in order
- [ ] Each task validation passed immediately
- [ ] All validation commands executed successfully
- [ ] Full test suite passes (unit + integration, 0 skipped with `--require-db`)
- [ ] No linting, formatting, or type errors
- [ ] Manual rollback drill on a real-size copy confirms the migration
- [ ] Acceptance criteria all met
- [ ] Code reviewed via `/lril:code-review` before commit

---

## NOTES

### Design decisions — including two explicitly resolved conflicts

**Conflict 1 — "scope every unique key by org" (tenancy hygiene) vs. "the fingerprint is the machine-
independent dedup key" (CLAUDE.md invariant). THE FINGERPRINT WINS.** `events` keeps `fingerprint` as its
sole primary key; `org_id` is a plain column and is **never** a fingerprint input. The tenancy hygiene
concern is real but is addressed differently: by *omitting* `org_id` from the `ON CONFLICT DO UPDATE set:`
block so a converging cross-org ingest can never flip an existing row's owner, plus a dedicated negative
test (Task 17.1). This is exactly what D-M15-2 asks for ("a hazard to test, not merely comment"). Do **not**
composite the primary key.

**Conflict 2 — D-M15-3 says "repositories KEEP their explicit `orgId`/`userId` parameters" vs. this plan's
"derive `orgId` inside machine-keyed repositories". BOTH APPLY, to different things.** D-M15-3 is about
**scoping reads** — a read must not silently trust ambient context, which is 15.2/15.3's subject. For
**machine-keyed writes**, `machines.org_id` is the *authority*: a machine belongs to exactly one org and
cannot change orgs, so deriving is strictly safer than passing (it makes "caller passed the wrong org"
unrepresentable) and avoids editing **25** `ingestBatch` call sites. Explicit parameters stay for
user-keyed writes (`getOrgIdForUser`) and for **all reads**, which this slice does not touch. If 15.2 later
wants `ingestBatch` to accept an explicit org, that is an easy additive change on a proven base.

**`getOrgIdForUser` is a knowingly temporary seam.** It answers "the org of a user who has exactly one
membership". That is true today and is made true by construction for every new user (Task 7), but it is not
the multi-org answer. 15.2's request principal replaces it. Every call site is marked with a grep-able
comment. This is a *sequencing* choice, not hidden debt — the alternative (threading a principal now) is
literally the definition of slice 15.2 and would merge the two largest slices of the milestone.

**Personal-org naming.** The org's `name` is seeded from the user's email, and the backfill's
`JOIN … ON u.email = o.name` depends on it for that one statement only. `users.email` is UNIQUE
(`schema.ts:52`), so the join is exact. No `slug` column is added — URL/tenant-slug concerns belong to
M16 hosted SaaS, and an unused unique column is a migration liability.

**No RLS, no policies, no app role in this slice.** 15.0 proved the `DATABASE_URL` role is a superuser with
`rolbypassrls`, so any policy written now would be inert and would give false assurance. 15.3 creates the
non-owner app role and the policies. Resist adding "just the `ENABLE ROW LEVEL SECURITY` part" here.

### Spikes actually run during planning (with results)

All four ran against real infrastructure; all throwaway artifacts were deleted and the repo left clean
(`git status --porcelain` empty), matching 15.0's discipline.

- **Spike A — data-shape reconnaissance** (live `420ai` archive, read-only). `users` = **1**
  (`seanrobertwright@gmail.com`, `password_hash` set), `machines` = **5** (all that one user),
  `events` = **413,765** of which **413,765 have a non-null `machine_id`** (0 orphans), `raw_source_records`
  = **256,085**, `search_documents` = **30,361**. *Consequence:* the Step-3b fallback matches zero rows on
  this install — it exists for robustness, not for this archive; and the backfill is genuinely
  single-org, so D-M15-11 is satisfiable exactly as written.

- **Spike B — the full migration + rollback cycle on a real-size clone.** `CREATE DATABASE "420ai_spike151"
  TEMPLATE "420ai"` (9.7 s), then the complete up SQL from Task 3, the down SQL from Task 4, and the up
  again. Results: **up ≈ 19.5 s**, **down ≈ 0.83 s**, and after the up: `events.org_id IS NULL` = **0**,
  `raw_source_records.org_id IS NULL` = **0**, `machines` = 0 null, `search_documents` = 0 null over all
  30,361 rows, `organizations` = **1**, `memberships` = **1** with `role = owner`, `is_personal = t`, and
  `search_documents_entity` verified as
  `CREATE UNIQUE INDEX … USING btree (org_id, entity_type, entity_id)`. After the down: the events row count
  was intact at **413,765** and the index was back to `(entity_type, entity_id)` with
  `to_regclass('organizations')` NULL. The spike database was **dropped** and its absence verified.
  *This is the evidence that Task 3/4's SQL is correct and that Risk 4 of the milestone plan is retired.*

- **Spike C — `drizzle-kit generate` behavior** (the fact the whole hand-edit design rests on). A
  representative subset of the schema change (both new tables + `org_id` on `events` and
  `search_documents` + the re-scoped unique index) was written into `schema.ts` and `npm run db:generate`
  was run with **stdin closed**. Results: (1) it is **non-interactive** — no rename/ambiguity prompt, exit 0,
  `[✓] Your SQL migration file ➜ drizzle\0014_worried_lizard.sql`; (2) it emits
  `ALTER TABLE "events" ADD COLUMN "org_id" uuid NOT NULL;` — i.e. **exactly the statement that cannot work
  on a populated table**; (3) it emits the index change correctly as `DROP INDEX` (early) + `CREATE UNIQUE
  INDEX … (org_id, entity_type, entity_id)` (last); (4) it emits `CREATE TABLE "memberships"` *before*
  `"organizations"` but adds all FKs afterwards, so the ordering is safe. The generated `.sql`, the
  `0014_snapshot.json`, the `_journal.json` edit, and the `schema.ts` edits were **all reverted**.

- **Spike D — the failure mode, proven rather than assumed.**
  `CREATE TEMP TABLE t(x int); INSERT INTO t VALUES (1); ALTER TABLE t ADD COLUMN "org_id" uuid NOT NULL;`
  → `ERROR: column "org_id" of relation "t" contains null values`. This is why Task 3 says "hand-edit" in
  bold rather than "review the generated file".

### Symbols and harness verified by reading source (not from memory)

`ingestBatch(db, machineId, batch, repricing?)` `ingest.ts:18-29` · `createMachine(tx, {userId,name,os?,hostname?})`
`machines.ts:14-17` · `recordHeartbeat(db, machineId, hb)` `machines.ts:45-55` · `getMachineUserId(db, machineId)`
`machines.ts:89-92` · `issueIngestToken(tx, machineId)` `tokens.ts:10-13` · `findMachineIdByToken(db, token)`
`tokens.ts:23` · `createPairingCode(db, userId, ttlMs?)` `pairing.ts:20-24` · `redeemPairingCode(tx, code) →
{userId}` `pairing.ts:35` · `ensureUserByEmail(db, email)` `users.ts:22` · `setUserPassword(db, email, hash)`
`users.ts:53` · `upsertDoc` + its conflict target `search.ts:75-99` · `min(machines.userId::text)`
`search.ts:314` · `Db`/`Tx`/`DbClient` `client.ts:5-15` · `rollbackLast` + the `--> statement-breakpoint`
split `rollback.ts:21-49` · `runMigrations` `migrate.ts:10` · the vitest global setup `vitest.global-setup.ts:9-15`.
**Test harness confirmed:** there is **no shared seed-helper module**; the seed block is copy-pasted per file,
canonical instance `packages/db/src/repositories/ingest.int.test.ts:78-91` — which is why Task 14 enumerates
files instead of pointing at a helper.

### Confidence

**9.5 / 10.** The migration SQL, the backfill, the down SQL, and the rollback cycle were **executed against a
clone of the real 413k-event archive** and asserted, not reasoned about; the `drizzle-kit` behavior the plan
depends on was observed with stdin closed and then reverted; the "generated SQL fails" claim was reproduced as
an actual Postgres error; every referenced symbol and line number was read from source in this session; and
the absence of a shared test-seed helper was confirmed, so the plan enumerates the ~20 files rather than
hand-waving at a fixture.

The residual 0.5 is **mechanical breadth, not unknowns**: ~20 int-test seed blocks and 17 insert sites are
edited by hand, and a missed one surfaces as a `not-null constraint` failure in the gate rather than as a
silent defect — cheap to find, tedious to fix. The one judgement call that could attract review discussion is
Conflict 2 (derive-vs-pass `orgId` for machine-keyed writes); it is argued explicitly above so a reviewer can
overturn it deliberately rather than discover it.
