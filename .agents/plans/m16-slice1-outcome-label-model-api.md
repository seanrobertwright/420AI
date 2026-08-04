# Feature: M16 Slice 16.1 — Outcome Label Model + API

The following plan should be complete, but it is important that you validate documentation and
codebase patterns and task sanity before you start implementing.

Pay special attention to naming of existing utils, types and models. Import from the right files.

Conventions are **not re-pasted here** — they live in [`CLAUDE.md`](../../CLAUDE.md). Milestone
context lives in [`.agents/plans/m16-dogfood-instrumentation.md`](./m16-dogfood-instrumentation.md);
the research requirements live in
[`.agents/supplemental docs/research-analysis-plan.md`](../supplemental%20docs/research-analysis-plan.md)
§4.3 / §7 P0.2.

---

## Feature Description

Automatic capture answers _what happened_ (tokens, cost, tool calls, commits). It cannot answer
whether the work was **useful**. Research plan §4.3 closes that gap with a voluntary, editable,
<15-second end-of-session label carrying six fields, and §7 **P0.2** makes the label a **separately
auditable record linked to a session — never a mutation of a raw record or an event**.

This slice ships the **data model and the HTTP API**: two new tenant tables, a repository, seven
routes, and the two-role integration proof. The **surfaces** (desktop tray capture, dashboard review
table, §7 P1.5 decision links) are **16.2** and are explicitly out of scope here.

It also resolves a gap that slice 16.0 wrote down rather than hid — `docs/guide/data-boundary.md`
§6 currently states that §7 P0.2's acceptance criterion ("a label can be deleted according to
archive policy") _"assumes an archive policy that does not exist yet."_ This slice writes that
policy, narrowly, for labels only (**D-16.1-6**).

## User Story

As **the operator of a 420AI archive during the 24-week research period**
I want to **record, edit, skip, export and delete a short human outcome label against a captured
session, with its edit history preserved**
So that **16.4's data-quality audit and the Phase 2 hero-workflow selection have real ground truth
to reconcile against, instead of inferring human outcomes from token counts.**

## Problem Statement

There is no place in the archive for a human judgement about a session.

Three consequences, each of which blocks a later M16 slice:

1. **16.4 has no denominator.** Research plan §5.1's metric table and §4.4's ten-session monthly
   reconciliation both need "what the human said happened" to compare the product's numbers
   against. Without it the audit can only check the archive against itself.
2. **16.2 has nothing to write to.** A tray surface with no auditable model behind it is exactly the
   "mutate the raw record" mistake §7 P0.2 exists to prevent (`m16-dogfood-instrumentation.md`
   ordering rationale).
3. **The §5.3 guardrail cannot be honoured.** _"Never infer a human outcome from token count or a
   commit alone without marking confidence"_ presupposes a human-authored outcome to contrast an
   inference with.

A fourth, subtler problem: a label surface that cannot record a **skip** cannot honour §4.3's
_"offer skip and do not nag repeatedly"_ — with no persisted skip, the tray has no way to know it
already asked. See **D-16.1-2**.

## Solution Statement

Two new STRICT tenant tables behind the M15 15.3/15.4 RLS pattern:

- **`outcome_labels`** — the current state, at most one per `(org_id, session_id)`, carrying the six
  §4.3 fields plus `status`, `confidence`, `author_user_id` and a `revision` counter.
- **`outcome_label_revisions`** — an immutable snapshot per revision (v1 at creation, v_n at each
  edit), which is what makes "preserve … edits" a record rather than a claim.

One repository (`packages/db/src/repositories/outcome-labels.ts`), one closed-set module in
`@420ai/shared`, one route file with seven handlers, and two two-role integration suites (one at the
repository layer, one at the HTTP layer) mirroring the M15 15.5 shape exactly.

The label is **neither raw nor derived** — it is a third category, *volunteered human ground truth* —
and it is the first object in this archive a user may retract. That is what earns it a real DELETE
(D-16.1-6), against the repo's "raw records sacred, never deleted" invariant, which it does not
violate because a label is not a raw record.

## Feature Metadata

**Feature Type**: New Capability
**Estimated Complexity**: Medium
**Primary Systems Affected**: `packages/db` (schema, migration 0024, repository, RLS classification),
`packages/shared` (closed sets), `apps/ingest` (routes, schemas, app wiring), `docs/guide`
**Dependencies**: None new. No new npm packages, no new external services.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**Schema + migration pattern**

- `packages/db/src/schema.ts` (lines 642-676, `reportArtifacts`) — Why: the closest existing shape.
  Org-owned, user-owned, versioned, explicit column list downstream. Copy its comment density.
- `packages/db/src/schema.ts` (lines 1080-1157, `auditEvents`) — Why: the most recent table added,
  and the model for a table-header comment that states *which RLS classification it takes and why*.
- `packages/db/src/schema.ts` (lines 439-485, `events`) — Why: `session_id` is a plain TEXT column
  here, **globally scoped and connector-supplied**. This is the reason the new unique index must be
  `(org_id, session_id)` and never `(session_id)` (CLAUDE.md M15 15.2 rule).
- `packages/db/drizzle/0023_silky_longshot.sql` — Why: the exact hand-authored migration format —
  generated `CREATE TABLE`, then `--> statement-breakpoint`, then a hand-appended policy block, with
  the whole rationale as a leading SQL comment. **Read the header comment in full.**
- `packages/db/drizzle/0015_shiny_iron_man.sql` (lines 20-26, 37-49) — Why: the canonical STRICT org
  policy DDL and the `ALTER DEFAULT PRIVILEGES` grant that makes an explicit `GRANT` unnecessary for
  a new table (confirmed live — see SPIKE 1).
- `packages/db/drizzle/0016_strong_magus.sql` (lines 60, 70-73) — Why: the three RESTRICTIVE
  role-write policies, verbatim. Copy the predicate exactly.
- `packages/db/drizzle/down/0023_silky_longshot.down.sql` — Why: the down-migration format, and the
  habit of stating in the down file what rolling back actually destroys.
- `packages/db/src/rollback.ts` (lines 36-40) — Why: the down file MUST be named
  `drizzle/down/<tag>.down.sql` where `<tag>` is the `_journal.json` entry tag, and statements are
  split on `--> statement-breakpoint`.

**Repository pattern**

- `packages/db/src/repositories/reports.ts` (lines 32-53, 139-194) — Why: **the explicit
  `*RowColumns` constant** (CLAUDE.md M15 15.1 rule: rows that reach `reply.send()` must never use a
  bare `select()`), and the `(db, orgId, id)` parameter ordering.
- `packages/db/src/repositories/members.ts` (lines 29-38, 116-196) — Why: the typed error class
  (`MemberError` + `reason` union) that `app.ts` maps to a status code, and the `DbClient`-vs-`Db`
  distinction. Also the "read-then-mutate needs a lock, not merely a transaction" lesson.
- `packages/db/src/org-context.ts` (lines 50-85) — Why: `withOrg(db, orgId, role, fn)`. The `role`
  parameter is REQUIRED and must be `principal.role` here, never `SERVICE_ROLE` (a label is the
  caller's own act — the 15.4 "whose action is this?" test).
- `packages/db/src/repositories/projections.ts` (lines 295-307, `sessionDetail`) — Why: the
  existence check the create path uses. Signature `sessionDetail(db, orgId, sessionId)`; an unknown
  session returns a row whose `eventCount === 0`.

**Route pattern**

- `apps/ingest/src/routes/members.ts` (whole file) — Why: **the template for this slice's route
  file.** Principal → `authorized()` → `withOrg` → repository, discriminated `const` outcomes
  returned out of the transaction and mapped to status codes outside it.
- `apps/ingest/src/routes/reports.ts` (lines 193-233) — Why: the `viewer`-gated read + `isUuid`
  guard + `withOrg`-wrapped repository call, in its simplest form.
- `apps/ingest/src/routes/exports.ts` (lines 1-40, 50-90) — Why: the **§18 redaction gate** — every
  payload passes `redactJson()` before bytes leave the archive — and the CSV column-flattening
  pattern. The label's `intent` and `follow_up_commit_or_pr` are free human text, so this applies
  (D-16.1-7).
- `apps/ingest/src/auth.ts` (lines 68, 300, 310) — Why: exact signatures.
  `resolvePrincipal(app, request): Promise<Principal | null>`, `authorized(principal, minimum: Role)`,
  `isUuid(s: string): boolean`.
- `apps/ingest/src/app.ts` (lines 228-252 registration, 254-311 error handler) — Why: where the
  route file is registered and where the typed repository error is mapped.
- `apps/ingest/src/schemas.ts` (lines 257-267, 466-484) — Why: the `as const` JSON-schema style with
  `additionalProperties: false` and closed-set `enum`s.

**Shared closed-set pattern**

- `packages/shared/src/roles.ts` (whole file, 46 lines) — Why: **the exact template** for the new
  `outcome-labels.ts` closed sets — `as const` array, derived type, `isX` narrowing guard, and a
  header comment that says why it is TEXT rather than a pg enum.
- `packages/shared/src/audit.ts` (whole file, 62 lines) — Why: the second instance of the same
  template, and the model for stating a **boundary rule** ("an act belongs here when…") that the next
  reader can actually apply.
- `packages/shared/src/serialize.ts` (lines 40-86) — Why: `toJsonl(rows)` and
  `toCsv(rows, columns)` exact signatures for the export route.

**Test harness — CONFIRMED to exist, with exact helper names**

- `packages/db/src/repositories/rls.int.test.ts` (lines 96-197 classification constants, 199-265
  fixture, 490-657 policy inventory) — Why: **this file MUST be edited by this slice.** The two new
  tables go into `STRICT_TABLES`; every count in the file is derived from list lengths, so no
  integer literal moves — but the test **title** `"all 17 tenant tables have relrowsecurity AND
  relforcerowsecurity"` and its in-body comment are hand-written and must become **19**.
- `apps/ingest/src/rls.int.test.ts` (lines 116-261 fixture, 264-270 role-identity precondition) —
  Why: the HTTP two-role fixture to mirror, including the `TRUNCATE` list that must gain the two new
  tables.
- `apps/ingest/src/identity.int.test.ts` (lines 1-80) — Why: the M15 15.5 two-role HTTP suite whose
  structure this slice's `outcome-labels.int.test.ts` should copy, including `errorChain` and
  `expectRlsRejection` (copy them; they are per-file helpers, not exported).
- `apps/ingest/src/test-support/bootstrap-key.ts` — Why: `seedBootstrapKey(db, email, label?) =>
  Promise<string>` mints the machine-tier bearer. **Call it in `beforeEach` AFTER the TRUNCATE** —
  `api_keys` FKs to `users` and cascades away.
- `apps/ingest/src/routes/org-scoping.test.ts` (lines 143-229) — Why: the **structural gate this
  slice must satisfy**. A new route file that calls `resolvePrincipal` MUST also contain
  `withOrg(` and `authorized(`, or the suite fails. No allow-list entry is needed or wanted.

**Docs to update**

- `docs/guide/data-boundary.md` §5 (lines 173-191) and §6 (lines 193-234) — Why: the export table
  gains a row and the "no per-session delete API" paragraph plus the closing **Gap** blockquote both
  become **false** when this slice ships. See D-16.1-6.
- `docs/guide/usage.md` §5 "Reports, projections & AI insight (ingest API)" (line 265) — Why: where
  the curl examples for the new endpoints belong.

### New Files to Create

- `packages/shared/src/outcome-labels.ts` — the four closed sets + narrowing guards + the
  `OutcomeLabelFields` type.
- `packages/shared/src/outcome-labels.test.ts` — unit tests for the guards (no infra).
- `packages/db/src/repositories/outcome-labels.ts` — repository + `OutcomeLabelError`.
- `packages/db/src/repositories/outcome-labels.int.test.ts` — **two-role** repository suite.
- `packages/db/drizzle/0024_<generated-name>.sql` — generated `CREATE TABLE` + hand-appended policies.
- `packages/db/drizzle/down/0024_<generated-name>.down.sql` — hand-written.
- `apps/ingest/src/routes/outcome-labels.ts` — the seven handlers.
- `apps/ingest/src/outcome-labels.int.test.ts` — **two-role** HTTP suite.

### Files to Update

- `packages/db/src/schema.ts` — two tables.
- `packages/db/src/index.ts` — barrel exports (tables + repository fns + types + error).
- `packages/db/src/repositories/rls.int.test.ts` — `STRICT_TABLES` + the `17`→`19` title/comment +
  the `TRUNCATE` list.
- `apps/ingest/src/rls.int.test.ts` — the `TRUNCATE` list.
- `packages/shared/src/index.ts` — `export * from "./outcome-labels.js";`
- `apps/ingest/src/schemas.ts` — three schema constants.
- `apps/ingest/src/app.ts` — import + `app.register(outcomeLabelRoutes)` + `OutcomeLabelError` arm.
- `docs/guide/data-boundary.md`, `docs/guide/usage.md`.
- `SUMMARY.md` — flip **16.1** to ✅ in §0 and §6 in the SAME commit as the execution report
  (CLAUDE.md; `scripts/check-summary.mjs` is the backstop).

### Relevant Documentation

- [`.agents/supplemental docs/research-analysis-plan.md`](../supplemental%20docs/research-analysis-plan.md)
  - §4.3 "Add minimum human ground truth" — the **six required fields and their exact value sets**.
    This table is the specification; do not invent values.
  - §7 P0.2 — "separately auditable label linked to a session, not mutation of raw records. Preserve
    author, timestamp, edits, and optional confidence. Acceptance: label can be created, edited,
    skipped, exported, and deleted according to archive policy."
  - §5.3 — "Never infer a human outcome from token count or a commit alone without marking
    confidence."
- [`.agents/plans/m16-dogfood-instrumentation.md`](./m16-dogfood-instrumentation.md) — the slice
  table, the ordering rationale (16.1 before 16.2), the non-goals list, and Risk 4 (the
  `check-summary` interaction).
- [PostgreSQL — Row Security Policies](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)
  - Section: "Policies … PERMISSIVE / RESTRICTIVE" and the `FOR ALL` note.
  - Why: a `FOR ALL` policy with only `USING` applies that expression as the `WITH CHECK` for
    INSERT/UPDATE. **Confirmed by SPIKE 2 check E** — this is what makes a cross-org INSERT loud.
- [PostgreSQL — `set_config`](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-SET)
  - Why: `SET LOCAL x = $1` is rejected; `set_config(name, value, true)` is the parameterizable
    equivalent `withOrg` already uses. Do not re-derive this.

### Patterns to Follow

**Closed sets live in `@420ai/shared`, as TEXT with no CHECK constraint.** Mirror
`packages/shared/src/roles.ts:11-12` and `packages/shared/src/audit.ts:36-49`:

```ts
export const TASK_TYPES = [
  "feature", "bug_fix", "investigation", "refactor", "test", "documentation", "incident", "other",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export function isTaskType(value: string): value is TaskType {
  return (TASK_TYPES as readonly string[]).includes(value);
}
```

**Repository row columns are EXPLICIT, never a bare `select()`.** Mirror
`packages/db/src/repositories/reports.ts:38-53`:

```ts
const outcomeLabelRowColumns = {
  id: outcomeLabels.id,
  sessionId: outcomeLabels.sessionId,
  authorUserId: outcomeLabels.authorUserId,
  status: outcomeLabels.status,
  // … one entry per OutcomeLabelRow field. NOTE: `orgId` is deliberately ABSENT —
  // these rows reach reply.send() and no route declares a Fastify response schema.
};
```

**Every handler is principal → role gate → `withOrg` → repository.** Mirror
`apps/ingest/src/routes/members.ts:76-88`:

```ts
const principal = await resolvePrincipal(app, request);
if (!principal) return reply.code(401).send({ error: "admin authorization required" });
if (!authorized(principal, "viewer")) return reply.code(403).send({ error: "insufficient role" });
const rows = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
  listOutcomeLabels(tx, principal.orgId, { /* filters */ }),
);
```

**A repository refusal is a typed error with a `reason` union, mapped in `app.ts`.** Mirror
`packages/db/src/repositories/members.ts:29-38` + `apps/ingest/src/app.ts:265-272`.

**Migration policy block — copy the DDL character-for-character.** From
`0015_shiny_iron_man.sql:37` and `0016_strong_magus.sql:70-72`:

```sql
ALTER TABLE "outcome_labels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outcome_labels" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "outcome_labels_org_isolation" ON "outcome_labels" USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "outcome_labels_role_write_ins" ON "outcome_labels" AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "outcome_labels_role_write_upd" ON "outcome_labels" AS RESTRICTIVE FOR UPDATE WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "outcome_labels_role_write_del" ON "outcome_labels" AS RESTRICTIVE FOR DELETE USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');
```

> **Spike-snippet fidelity.** The DDL above was executed verbatim (with a `spike_` table prefix)
> against the live `420ai_test` during planning. SPIKE 1 and SPIKE 2 below record the exact
> assertions it satisfied. If your implementation's `pg_policies` output differs from SPIKE 1's
> table, you have drifted — the inventory test in `rls.int.test.ts` will say so.

**DB gotchas that apply to this slice** (CLAUDE.md "Drizzle / SQL gotchas"):

- `created_at` / `updated_at` / `recorded_at` use the **default `Date` mode**
  (`timestamp("...", { withTimezone: true })`), exactly like `reportArtifacts.generatedAt`, and the
  Row interface types them `Date`. **Do NOT use `mode: "string"`** — that mode exists on
  `events.ts` alone, and mixing it in would import the "aggregate over a `mode:"string"` column
  returns Postgres text, not ISO" trap for no benefit. There is no aggregate over a timestamp
  anywhere in this slice, so no ISO normalization is required — and that is a *consequence of the
  design*, not permission to skip normalization if you later add one.
- `quality_rating` is a real `integer` column, so it comes back as a JS number. Nothing here reads a
  `numeric`, so no `Number(...)` wrapper is needed; if you add a count, cast it `::int`.
- No `date_trunc`, no closed-set SQL keyword, therefore no `sql.raw` in this slice. If a later edit
  adds one, inline it via `sql.raw` from a guarded union — never as a bound parameter.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation — shared closed sets

The six §4.3 fields have fixed value sets. They belong in `@420ai/shared` rather than in the route's
JSON-schema enum alone, because **three** consumers need them: this slice's route schema, 16.2's
tray/dashboard, and 16.4's audit report. A value set duplicated across those three is the shape that
drifts.

### Phase 2: Core Implementation — schema, migration, repository

Two tables, migration 0024 (generate then hand-append the policy block), a hand-written down file,
and one repository exporting create / get / update / delete / list / revisions.

### Phase 3: Integration — routes, schemas, app wiring, barrel exports

Seven handlers in one new route file; three JSON schemas; the `OutcomeLabelError` arm in the error
handler; the `@420ai/db` barrel.

### Phase 4: Testing & Validation

Two **two-role** integration suites plus the shared unit tests, plus the `rls.int.test.ts`
classification edit. Then the gate, with `--require-db`.

---

## Decisions

### D-16.1-1 — TWO tables: current state + an immutable revision snapshot

§7 P0.2 requires the label to "preserve author, timestamp, **edits**". A `revision` counter alone
records *that* something changed, not *what* — and the change itself is the research-relevant
signal: a `quality_rating` revised from 2 to 5 a week later is **hindsight**, which is precisely the
bias §4.3's "captures what success meant before hindsight" is guarding against. 16.4 cannot detect
that from a counter.

So: `outcome_labels` holds the current state; `outcome_label_revisions` holds one immutable row per
revision — **v1 written at creation**, v_n at each edit. Reading "the original label" is then a
query, not an archaeology exercise.

The revisions table is a **STRICT tenant table**, deliberately **not** the 15.10 `APPEND_ONLY`
classification, for two reasons that are each independently sufficient: it has a real read path
(16.2 renders the history to its author), and its rows must be **deletable** when the label is
deleted (D-16.1-6). `APPEND_ONLY` gives neither.

### D-16.1-2 — A SKIP IS A ROW. `status` is `labeled | skipped`

§4.3 requires "offer skip and **do not nag repeatedly**". A skip that is not persisted makes the
second half unimplementable — the 16.2 tray would have no way to know it already asked, so it would
ask again on the next session view, which is the exact behaviour §12 names as the thing that kills
label completion.

So a skip writes a row with `status = 'skipped'` and all six §4.3 fields NULL. Consequences,
accepted deliberately:

- The six fields are **nullable columns**. Their required-when-`labeled` shape is enforced in the
  **repository and the route schema**, not by a CHECK constraint — the same choice this repo makes
  for every closed set (`memberships.role`, `report_artifacts.report_type`, `alert_firings.status`
  all carry no CHECK). The TypeScript input type is a discriminated union on `status`, so a
  `labeled` create missing `outcome` is a compile error at every internal call site.
- 16.4's completion metric is `count(status='labeled') / count(*)`, and a skipped session is
  correctly in the denominator of "sessions I was asked about" and out of the numerator of "sessions
  I judged" — which is a more honest pair than an absent row could give.

### D-16.1-3 — ONE label per `(org_id, session_id)`, unique-indexed on BOTH columns

`session_id` is a **connector-supplied, globally-scoped TEXT string** (`events.sessionId`,
schema.ts:462) — two tenants can hold the same value. A unique index on `(session_id)` alone would
therefore let one org's label block another org's, and is the 15.1 `search_documents_entity` bug
re-shipped. The index is `(org_id, session_id)` and every read takes `orgId` as its **second
parameter** (CLAUDE.md 15.2 rule).

The label is per-**session**, not per-`(session, author)`. A captured session belongs to one machine
and one operator; a second person's opinion of it is a different feature (and a research-design
question, not a schema one). A second author is a **409**, not a second row.

### D-16.1-4 — EDIT is author-only; DELETE is author-or-admin

A label is an opinion with a name on it. Rewriting someone else's answer is **falsification of
ground truth**, and 16.4 reads these rows as evidence — so no rung, including `owner`, may PATCH a
label it did not author.

DELETE is different: it is retraction, not rewriting, and an org admin needs a data-hygiene lever
(a mis-scoped bulk label, a departed colleague's rows). So `admin`+ may DELETE any label in their
org; anyone at `member`+ may delete their own.

Read/list/export stay **org-scoped at `viewer`** (D-15.4-2: every member sees every project and
machine in their org), because 16.4's aggregate needs the whole org's rows and a research cohort of
one makes any narrower rule untestable.

### D-16.1-5 — The label is NOT an `AUDIT_ACTIONS` entry

The instinct to audit these writes is wrong, and `packages/shared/src/audit.ts:14-24` states the
boundary explicitly: an act belongs in `AUDIT_ACTIONS` when it **(1)** changes another principal's
standing, or **(2)** mints or destroys a long-lived credential. Labelling does neither.

Adding it would also break the classification the audit table depends on: `audit_events` is
`APPEND_ONLY` precisely because *nothing reads it per-tenant*, and a label edit-history that the
author must be able to read is the opposite requirement. **`outcome_label_revisions` is this
feature's audit trail**, and it is a tenant table because its reader is the tenant.

### D-16.1-6 — Labels are the FIRST deletable object, and this slice writes the policy

`docs/guide/data-boundary.md` §6 today says there is _"no delete-my-data button, and no per-session
delete API"_, and closes with a **Gap** blockquote naming §7 P0.2's "deleted according to archive
policy" as assuming a policy that does not exist.

This slice writes that policy for labels only:

> **A `DELETE` of an outcome label is a HARD delete of the label row and all of its revision rows,
> in one transaction. Nothing is retained, and nothing else is touched — the session's raw records,
> events, reports and search documents are unaffected.**

This does **not** weaken the "raw records sacred" invariant, and the reason it does not is the whole
argument: a label is neither raw nor derived. Raw records are permanent because they are *captured
evidence you cannot recreate*; events are disposable because they are *re-derivable*. A label is a
third thing — **volunteered human ground truth** — which is re-creatable only by the human who gave
it, and is therefore the one object in the archive they are entitled to retract. §7 P0.4's
acceptance ("a design partner can make an informed decision before pairing a machine") is much
easier to satisfy when the answer to "can I take my judgements back?" is yes.

FKs stay `no action` like every other FK in this schema; the repository deletes revisions **then**
the label inside one `withOrg` transaction, so the cascade is visible in code rather than hidden in
DDL. Update the data-boundary §6 paragraph **and delete the now-false Gap blockquote's first
clause** in the same commit.

### D-16.1-7 — The export path REDACTS, because `intent` is free human text

`apps/ingest/src/routes/exports.ts:33` states the §18 gate: redaction applies before any bytes leave
the archive. `intent` (200 chars, free text) and `follow_up_commit_or_pr` are typed by a human who
may paste a token, a URL with a credential in it, or a customer name. So `GET /v1/labels/export`
passes its rows through `redactJson()` and emits the same `X-Export-*` headers and manifest shape as
the three existing export routes.

The read routes (`GET /v1/sessions/:id/label`, `GET /v1/labels`) do **not** redact — they are
authenticated in-app reads by the label's own org, exactly like `GET /v1/reports/:id`, which is
likewise unredacted while its `/export` sibling is not.

### D-16.1-8 — `confidence` is nullable and human-set; there is NO inference path

§7 P0.2 says "optional confidence" and §5.3 says never to infer a human outcome without marking it.
`confidence` is `low | medium | high`, NULL by default (= not stated), and `author_user_id` is
`NOT NULL` with no service-role write path anywhere in this slice. There is therefore **no way for
this API to produce a label no human authored**, which is the strongest form of the §5.3 guarantee —
stronger than a flag, because it is unrepresentable rather than merely unset.

If 16.4 ever wants to *suggest* a label from git/commit evidence, that is a different table or an
explicit `author_user_id = <service identity>` decision taken there, with its own record.

---

## STEP-BY-STEP TASKS

Execute in order. Each task is atomic and independently validated.

### 1. CREATE `packages/shared/src/outcome-labels.ts`

- **IMPLEMENT**: Four `as const` arrays with derived types and narrowing guards, plus the
  `OutcomeLabelFields` interface. Values come **verbatim** from research plan §4.3:
  - `TASK_TYPES` = `feature | bug_fix | investigation | refactor | test | documentation | incident | other`
  - `OUTCOMES` = `shipped | useful_partial | blocked | abandoned | incorrect`
  - `FRICTIONS` = `none | context | model_tool | tool_failure | unclear_task | verification | non_ai`
    (§4.3 writes the third value as `model/tool`; a `/` is not a legal identifier in a URL path,
    a CSV header or a TS union member's ergonomic form — **normalize to `model_tool` and say so in
    the header comment**, since the research plan wins on *what* to measure and this plan wins on
    *how it is built*.)
  - `LABEL_CONFIDENCE` = `low | medium | high`
  - `LABEL_STATUSES` = `labeled | skipped`
  - `INTENT_MAX_LENGTH = 200` (§4.3 "max 200 characters")
- **PATTERN**: `packages/shared/src/roles.ts:11-12,43-46` — array, type, `isX` guard.
  Header comment in the style of `packages/shared/src/audit.ts:1-35`, stating (a) TEXT not pg enum,
  (b) the `model/tool` → `model_tool` normalization and why, (c) that these are the research plan's
  values and changing one is a research decision-log entry (§11), not a refactor.
- **IMPORTS**: none.
- **GOTCHA**: do NOT add a `CHECK` constraint later to mirror these — no closed set in this repo has
  one, and adding a value must stay a code change rather than a migration.
- **VALIDATE**: `npx tsc -b packages/shared`

### 2. CREATE `packages/shared/src/outcome-labels.test.ts`

- **IMPLEMENT**: guards accept every member and reject a near-miss (`"model/tool"`, `"bugfix"`,
  `"Feature"`); the arrays have the expected lengths; `INTENT_MAX_LENGTH === 200`.
- **PATTERN**: co-located vitest, no infra (CLAUDE.md testing section).
- **VALIDATE**: `npx vitest run packages/shared/src/outcome-labels.test.ts`

### 3. UPDATE `packages/shared/src/index.ts`

- **IMPLEMENT**: `export * from "./outcome-labels.js";` beside `./roles.js` / `./audit.js`.
- **VALIDATE**: `npx tsc -b`

### 4. UPDATE `packages/db/src/schema.ts` — add both tables

- **IMPLEMENT**: `outcomeLabels` and `outcomeLabelRevisions`, placed after `auditEvents` at the end
  of the file.

```ts
export const outcomeLabels = pgTable(
  "outcome_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    // Connector-supplied and GLOBALLY SCOPED (see events.session_id) — hence the unique index
    // below is (org_id, session_id) and never (session_id) alone. No FK: there is no sessions
    // table; a session is a projection over `events`.
    sessionId: text("session_id").notNull(),
    authorUserId: uuid("author_user_id").notNull().references(() => users.id),
    // `labeled` | `skipped` (D-16.1-2). TEXT, no CHECK — LABEL_STATUSES in @420ai/shared is the set.
    status: text("status").notNull(),
    // The six research-plan §4.3 fields. ALL NULLABLE because a `skipped` row carries none of
    // them; the required-when-`labeled` shape is enforced by the repository's discriminated input
    // type and the route's JSON schema, not by a constraint.
    taskType: text("task_type"),
    intent: text("intent"),
    outcome: text("outcome"),
    qualityRating: integer("quality_rating"),
    primaryFriction: text("primary_friction"),
    followUpCommitOrPr: text("follow_up_commit_or_pr"),
    // §7 P0.2 "optional confidence" — NULL means "not stated" (D-16.1-8).
    confidence: text("confidence"),
    // 1 at creation, +1 per edit. The SNAPSHOTS live in outcome_label_revisions (D-16.1-1);
    // this counter is the join key, not the history.
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("outcome_labels_org_session").on(t.orgId, t.sessionId),
    // Leading `org_id` means this index also serves every org-prefix scan, so there is
    // deliberately no separate `outcome_labels_by_org`.
    index("outcome_labels_by_org_updated").on(t.orgId, t.updatedAt),
  ],
);
```

  `outcomeLabelRevisions`: `id`, `orgId` (FK), `labelId` (FK → `outcomeLabels.id`), `revision`
  (integer notNull), `authorUserId` (FK), the same eight nullable snapshot fields **plus `status`**,
  `recordedAt` (timestamptz notNull defaultNow); indexes
  `uniqueIndex("outcome_label_revisions_label_revision").on(t.labelId, t.revision)` and
  `index("outcome_label_revisions_by_org").on(t.orgId)`.
- **PATTERN**: `packages/db/src/schema.ts:642-676` (`reportArtifacts`) for shape;
  `schema.ts:1080-1157` (`auditEvents`) for the header-comment style. Write a header comment on
  `outcomeLabels` stating: it is a STRICT tenant table; it is **not** a mutation of raw or events
  (§7 P0.2); the skip decision (D-16.1-2); and that the revisions table takes STRICT rather than
  APPEND_ONLY and why (D-16.1-1).
- **IMPORTS**: `integer` is already imported at `schema.ts:5`; no new drizzle imports needed.
- **GOTCHA**: default (`Date`) timestamp mode, **not** `mode: "string"`. See "DB gotchas" above.
- **VALIDATE**: `npx tsc -b`

### 5. GENERATE migration 0024, then HAND-APPEND the policy block

- **IMPLEMENT**:
  1. `npm run db:generate` → produces `packages/db/drizzle/0024_<name>.sql` (CREATE TABLE + FKs +
     indexes), updates `drizzle/meta/_journal.json` (new entry `idx: 24`) and the snapshot.
  2. **Hand-append**, after the generated statements, the ENABLE/FORCE + 4 policies **per table**
     (8 policies total), copying the DDL from the "Patterns to Follow" block above verbatim and
     substituting `outcome_label_revisions` for the second table.
  3. **Hand-prepend** a leading `--` comment block, in the style of
     `0023_silky_longshot.sql:1-40`, stating: why the policy block is hand-appended (drizzle-kit
     cannot emit `CREATE POLICY`), that re-running `db:generate` will not preserve it, which
     classification each table takes and why (D-16.1-1), and that **no `GRANT` is needed** because
     0015's `ALTER DEFAULT PRIVILEGES` covers tables created by the migration owner — **re-verified
     live for this exact table shape during planning (SPIKE 1: the app role received
     SELECT/INSERT/UPDATE/DELETE with no explicit grant).**
- **PATTERN**: `packages/db/drizzle/0023_silky_longshot.sql` end-to-end.
- **GOTCHA**: `FORCE ROW LEVEL SECURITY` **IS** required here (both tables are tenant tables read
  per-tenant), unlike `audit_events` which deliberately omits it. Getting this backwards fails
  `rls.int.test.ts` test 9.
- **GOTCHA**: `db:generate` reads `DATABASE_URL` (the **dev** DB) from the repo-root `.env`
  (`packages/db/drizzle.config.ts:7`). It does not touch the test DB.
- **VALIDATE**: `npm run db:migrate` then, separately, migrate the test DB (it is **not** migrated by
  `db:migrate` — see below), then:
  `docker exec -i 420ai-archive psql -U 420ai -d 420ai_test -c "select tablename, policyname, permissive, cmd from pg_policies where tablename like 'outcome_label%' order by 1,2"`
  → expect **8 rows**: per table one `PERMISSIVE/ALL` + three `RESTRICTIVE` (INSERT, UPDATE, DELETE).

### 6. CREATE `packages/db/drizzle/down/0024_<name>.down.sql`

- **IMPLEMENT**: `DROP TABLE IF EXISTS "outcome_label_revisions";--> statement-breakpoint` then
  `DROP TABLE IF EXISTS "outcome_labels";` (revisions first — it FKs the labels table). Header
  comment stating what is destroyed: **all human ground truth, irrecoverably** — unlike every other
  destructive down in this repo, these rows are derived from **nothing** and cannot be rebuilt from
  raw records. `pg_dump -t outcome_labels -t outcome_label_revisions` first if it matters. Also
  state that a post-16.1 server against a pre-16.1 schema 500s on every label route.
- **PATTERN**: `packages/db/drizzle/down/0023_silky_longshot.down.sql` — including its habit of
  naming the roll-forward consequence.
- **GOTCHA**: the filename tag must exactly match the `_journal.json` entry's `tag`
  (`packages/db/src/rollback.ts:36`), or rollback fails with "no journal entry".
- **VALIDATE**: `npm run db:rollback` then `npm run db:migrate` on the **dev** DB; assert both tables
  disappear and return.

### 7. CREATE `packages/db/src/repositories/outcome-labels.ts`

- **IMPLEMENT**:
  - `export class OutcomeLabelError extends Error` with
    `reason: "already_labeled" | "not_found" | "not_author"`. (Mirrors `MemberError`.)
  - `export interface OutcomeLabelRow` — `id, sessionId, authorUserId, status, taskType, intent,
    outcome, qualityRating, primaryFriction, followUpCommitOrPr, confidence, revision, createdAt,
    updatedAt`. **No `orgId`** (it must not reach the wire).
  - `export interface OutcomeLabelRevisionRow` — the snapshot shape + `revision`, `authorUserId`,
    `recordedAt`.
  - `const outcomeLabelRowColumns = { … }` and `const outcomeLabelRevisionRowColumns = { … }`,
    each keeping `== ` its Row interface.
  - `export type CreateOutcomeLabelInput` — a **discriminated union on `status`**:
    `{ status: "skipped" }` | `{ status: "labeled"; taskType: TaskType; intent: string;
    outcome: LabelOutcome; qualityRating: number; primaryFriction: Friction;
    followUpCommitOrPr?: string | null; confidence?: LabelConfidence | null }`.
  - `createOutcomeLabel(tx: DbClient, orgId: string, input: { sessionId; authorUserId } &
    CreateOutcomeLabelInput): Promise<OutcomeLabelRow>` — inserts the label at `revision: 1` **and**
    its v1 revision row, in the caller's transaction. Translates the `outcome_labels_org_session`
    unique violation into `OutcomeLabelError("…", "already_labeled")` using the
    `isVersionConflict`-style `.cause.code === "23505"` check (`repositories/reports.ts:68-71`).
  - `getOutcomeLabel(tx, orgId, sessionId): Promise<OutcomeLabelRow | undefined>`
  - `updateOutcomeLabel(tx, orgId, sessionId, authorUserId, patch): Promise<OutcomeLabelRow>` —
    reads the current row **`FOR UPDATE`**, throws `not_found` / `not_author`, snapshots the
    **pre-edit** state into `outcome_label_revisions` at the OLD revision number if v1 is somehow
    absent (it never is — v1 is written at creation), writes the merged row with
    `revision: current + 1`, `updatedAt: now()`, and inserts the NEW state as revision `current + 1`.
  - `deleteOutcomeLabel(tx, orgId, sessionId, opts: { requesterUserId: string; force: boolean }):
    Promise<boolean>` — `force` is the admin lever (D-16.1-4); deletes revisions then the label;
    returns false when no row matched.
  - `listOutcomeLabels(tx, orgId, filter?: { status?; outcome?; taskType?; sessionId?; limit?;
    offset? }): Promise<OutcomeLabelRow[]>` — ordered `desc(updatedAt), desc(id)`; `limit`/`offset`
    applied only when provided (mirrors `listReportArtifacts`).
  - `listOutcomeLabelRevisions(tx, orgId, sessionId): Promise<OutcomeLabelRevisionRow[]>` — ordered
    `asc(revision)`.
- **PATTERN**: `packages/db/src/repositories/reports.ts` (row columns, `$dynamic()` paging,
  unique-violation detection) + `packages/db/src/repositories/members.ts` (typed error,
  `DbClient` parameter, `.for("update")` on the read-then-mutate guard).
- **IMPORTS**: `import { and, asc, desc, eq } from "drizzle-orm";`,
  `import type { DbClient } from "../client.js";`,
  `import { outcomeLabels, outcomeLabelRevisions } from "../schema.js";`,
  `import type { TaskType, LabelOutcome, Friction, LabelConfidence } from "@420ai/shared";`
- **GOTCHA — `DbClient`, not `Db`.** Every caller reaches these from inside `withOrg`, which is
  already a transaction; taking a `Tx`-compatible type is what makes the `FOR UPDATE` lock in
  `updateOutcomeLabel` actually hold across the mutation. `withOrg` takes a `Db` and passes a `Tx` —
  do not call `withOrg` *inside* these functions (that is `insertReportArtifact`'s deliberate
  exception, and it exists only for its retry loop; there is no retry here).
- **GOTCHA — the lock is what serialises, not the transaction.** `SELECT` without `FOR UPDATE` takes
  no locks under READ COMMITTED, so two concurrent PATCHes would both read `revision = 3` and both
  write 4, violating the revisions unique index (one would 500). Name the mechanism in the comment:
  `FOR UPDATE` on the label row. (CLAUDE.md M15 15.5.)
- **GOTCHA — silent library.** Never `console.*`, never `process.exit`.
- **VALIDATE**: `npx tsc -b`

### 8. UPDATE `packages/db/src/index.ts` — barrel

- **IMPLEMENT**: add `outcomeLabels, outcomeLabelRevisions` to the schema re-export block, and a new
  export block for the repository functions + `OutcomeLabelError` + the three types, with a
  one-paragraph comment in the style of the `members.ts` / `audit.ts` blocks stating that these are
  STRICT tenant tables with an RLS backstop behind the explicit `orgId` predicate.
- **VALIDATE**: `npx tsc -b`

### 9. UPDATE `packages/db/src/repositories/rls.int.test.ts` — classification

- **IMPLEMENT**:
  - Add `"outcome_labels"` and `"outcome_label_revisions"` to `STRICT_TABLES` (lines 97-112), with a
    short comment in the style of the `project_grants` entry naming the slice (M16 16.1).
  - Change the test **title** at line 614 from `"all 17 tenant tables …"` to `"all 19 tenant tables
    …"` and update the in-body comment at lines 615-620 that says "The count in the title is 17 as of
    15.5". **These two are the only hand-written integers in the file** — every other count is
    derived from list lengths, so adding two entries moves nothing else.
  - Add both tables to the `beforeEach` `TRUNCATE` list (line 225), before `report_artifacts`.
- **GOTCHA**: do NOT add them to `NO_RLS_TABLES`, `BOOTSTRAP_TABLES`,
  `ROLE_GATED_BOOTSTRAP_TABLES` or `APPEND_ONLY_TABLES`. The inventory test (line 567) asserts each
  table belongs to exactly one classification.
- **VALIDATE**: (deferred to task 15's `--require-db` run)

### 10. UPDATE `apps/ingest/src/schemas.ts`

- **IMPLEMENT**: three `as const` JSON schemas, appended at the end of the file with a section
  comment:
  - `createOutcomeLabelBodySchema` — `required: ["status"]`, `additionalProperties: false`,
    `status: { enum: ["labeled","skipped"] }`, `taskType`/`outcome`/`primaryFriction`/`confidence`
    as enums built from the shared arrays, `intent: { type: "string", maxLength: 200 }`,
    `qualityRating: { type: "integer", minimum: 1, maximum: 5 }`,
    `followUpCommitOrPr: { type: "string", maxLength: 500 }`.
  - `patchOutcomeLabelBodySchema` — same properties, **no `required`**, `minProperties: 1` so an
    empty PATCH is a 400 rather than a no-op revision bump.
  - `listOutcomeLabelsQuerySchema` — `status`, `outcome`, `taskType`, `sessionId`,
    `limit: {integer, 1..200}`, `offset: {integer, min 0}`.
  - `exportOutcomeLabelsQuerySchema` — `required: ["format"]`,
    `format: { enum: ["json","jsonl","csv"] }` plus the same filters.
- **PATTERN**: `apps/ingest/src/schemas.ts:258-267` (list query) and `466-484` (enum body).
- **GOTCHA**: bound every free-text field at the edge, per the file's stated habit
  (`schemas.ts:486-493`) — `intent` at 200 (§4.3's own limit), `followUpCommitOrPr` at 500. The
  columns are unbounded `text`; a 10 KB `intent` would land in the 16.2 dashboard table and every
  export.
- **GOTCHA**: build the enums from the shared arrays where the JSON-schema type permits
  (`[...TASK_TYPES]`), so a value added in `@420ai/shared` cannot be silently rejected here.
- **VALIDATE**: `npx tsc -b`

### 11. CREATE `apps/ingest/src/routes/outcome-labels.ts`

- **IMPLEMENT**: seven handlers, each `resolvePrincipal` → `authorized` → `withOrg(app.db,
  principal.orgId, principal.role, …)`:

  | Method | Path | Gate | Notes |
  |---|---|---|---|
  | POST | `/v1/sessions/:sessionId/label` | `member` | 404 if `sessionDetail(...).eventCount === 0`; 409 on `already_labeled`; **201** |
  | GET | `/v1/sessions/:sessionId/label` | `viewer` | 404 when absent |
  | PATCH | `/v1/sessions/:sessionId/label` | `member` | author-only (403 `not_author`); bumps revision; **200** |
  | DELETE | `/v1/sessions/:sessionId/label` | `member` | `force = authorized(principal, "admin")`; **204**, 404 when absent |
  | GET | `/v1/sessions/:sessionId/label/revisions` | `viewer` | `{ revisions: [...] }` |
  | GET | `/v1/labels` | `viewer` | paged list |
  | GET | `/v1/labels/export` | `viewer` | `redactJson` + `X-Export-*` headers + manifest |

- **PATTERN**: `apps/ingest/src/routes/members.ts` for the whole file's shape (including returning
  discriminated `const` outcomes out of the `withOrg` callback and mapping them to status codes
  outside it); `apps/ingest/src/routes/exports.ts:100-200` for the export handler's headers,
  manifest and CSV column flattening.
- **IMPORTS**: `import { withOrg, createOutcomeLabel, getOutcomeLabel, updateOutcomeLabel,
  deleteOutcomeLabel, listOutcomeLabels, listOutcomeLabelRevisions, sessionDetail } from
  "@420ai/db";` · `import { redactJson, toCsv, toJsonl, REDACTION_VERSION } from "@420ai/shared";` ·
  `import { resolvePrincipal, authorized } from "../auth.js";`
- **GOTCHA — `sessionId` is NOT a uuid.** Do **not** call `isUuid` on it (`routes/reports.ts:171`
  makes exactly this note for `/v1/sessions/:sessionId/reports`). The existence guard is
  `sessionDetail`, not a format check.
- **GOTCHA — the existence check is a WRITE-path guard even though there is no FK.** There is no
  `sessions` table, so a bad `sessionId` cannot raise an FK violation — it would instead create a
  permanent orphan label that silently corrupts 16.4's denominator. Guard it anyway; state that
  reason in the comment so nobody "simplifies" it away on the grounds that no constraint requires it.
- **GOTCHA — `principal.role`, never `SERVICE_ROLE`.** Labelling is the caller's own act, so the
  0016 restrictive backstop is a genuine layer here (the 15.4 "whose action is this?" test). A
  `viewer` reaching the write path must be stopped by the route gate first; the RLS rejection is the
  backstop, not the primary defence.
- **GOTCHA — this file must contain BOTH `withOrg(` and `authorized(`** or
  `routes/org-scoping.test.ts` fails. It needs **no** allow-list entry; do not add one.
- **VALIDATE**: `npx tsc -b`

### 12. UPDATE `apps/ingest/src/app.ts`

- **IMPLEMENT**: `import outcomeLabelRoutes from "./routes/outcome-labels.js";` beside the other
  route imports; `app.register(outcomeLabelRoutes);` after `app.register(searchRoutes);`; and an
  `OutcomeLabelError` arm in the error handler:
  `not_found` → 404, `not_author` → 403, `already_labeled` → 409, each sending
  `{ error: err.message, reason: err.reason }`.
- **PATTERN**: `apps/ingest/src/app.ts:265-272` (`MemberError`), including its comment explaining why
  the reasons are mapped rather than collapsed.
- **GOTCHA**: place the new arm **before** the `status >= 500` masking branch, like every other typed
  arm.
- **VALIDATE**: `npx tsc -b`

### 13. CREATE `packages/db/src/repositories/outcome-labels.int.test.ts` — TWO-ROLE

- **IMPLEMENT**, mirroring `packages/db/src/repositories/rls.int.test.ts`'s fixture:
  - `describe.skipIf(!TEST_URL || !APP_URL)`; `owner` handle for TRUNCATE + seeding only, `appRole`
    for **every** assertion; both pools closed in `afterAll`.
  - **Test 1 — role identity.** `current_setting('is_superuser') === 'off'` AND
    `rolbypassrls === false` AND `current_user === '420ai_app'`. Without it the file is theatre.
  - Cross-tenant: two orgs holding the **same `session_id`** each get their own label; org A's
    `getOutcomeLabel` never returns org B's row; `listOutcomeLabels` for A has length 1.
  - No context ⇒ 0 rows from both tables (fails closed, does not error).
  - A `viewer` role context: INSERT **rejects loudly** (`expectRlsRejection`); DELETE is a **silent
    0-row no-op** — assert the silence explicitly so nobody later "fixes" it into an expectation
    Postgres cannot meet (CLAUDE.md M15 15.4).
  - Revision history: create → patch twice → `listOutcomeLabelRevisions` has 3 rows with
    `revision` 1,2,3 and the v1 snapshot still carries the ORIGINAL `qualityRating`.
  - `already_labeled`: a second create for the same `(org, session)` throws
    `OutcomeLabelError` with `reason === "already_labeled"`.
  - `not_author`: user B patching user A's label throws `not_author`.
  - Delete removes the label **and every revision row** (assert both counts are 0 on the owner
    handle), and leaves that org's `events` count unchanged.
- **PATTERN**: copy `errorChain` and `expectRlsRejection` from
  `packages/db/src/repositories/rls.int.test.ts:57-87` (they are per-file helpers, not exported).
  Seed users via `owner.db.insert(users)` + `ensurePersonalOrg(owner.db, userId, email)` exactly as
  that file's `beforeEach` does (lines 227-235).
- **GOTCHA**: this file is excluded from `tsc -b` (it imports across app boundaries) — vitest
  type-strips it. So a type error here surfaces only when the test runs.
- **GOTCHA**: seed `events` rows for the sessions you label **only** in the HTTP suite. The
  repository functions do not call `sessionDetail`; the existence guard lives at the route.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/outcome-labels.int.test.ts`

### 14. CREATE `apps/ingest/src/outcome-labels.int.test.ts` — TWO-ROLE HTTP

- **IMPLEMENT**, mirroring `apps/ingest/src/rls.int.test.ts`'s fixture (`buildApp({ db: appRole.db,
  reconcileThrottleMs: 0, adminEmail, sessionSecret, analysisProvider: stubProvider, logger: false
  })`, `login()` helper, `asUser()`):
  - **Test 1 — role identity** (`current_user === '420ai_app'`, `rolbypassrls === false`).
  - Full lifecycle through HTTP: POST 201 → GET 200 → PATCH 200 (revision 2) → GET revisions →
    export → DELETE 204 → GET 404.
  - **Skip**: `POST { status: "skipped" }` → 201 with all six fields null; a second POST → **409**
    (this is what makes "never nag" implementable — assert it).
  - **Unknown session** → POST 404, and assert **no row was created** with a `count(*)` on the owner
    handle (a status code alone would not prove it).
  - **RBAC**: a `viewer` gets 403 on POST/PATCH/DELETE and 200 on GET/list/export. Seed the viewer by
    **MOVING** the existing membership, not by inserting a second one — `setUserPassword`
    auto-creates a personal `owner` membership via `ensurePersonalOrg` and
    `findPrincipalByEmail` resolves the FIRST by `(created_at, id)`, so an INSERTed second membership
    is silently shadowed and the "viewer" test would assert against an owner (CLAUDE.md M15 15.4).
  - **Cross-tenant**: org B's `GET /v1/sessions/<A's session>/label` is **404**, never A's content;
    `GET /v1/labels` for B does not contain A's `intent` string.
  - **Redaction**: put a token-shaped string in `intent`, then assert
    `GET /v1/labels/export?format=json` body does **not** contain it, while `GET /v1/labels` (the
    in-app read) does. That asserts D-16.1-7 in both directions.
  - **Author-only edit** through HTTP: user B (a `member` of the same org, moved membership) PATCHing
    A's label → **403**; DELETing it → **404/204 per D-16.1-4** (a plain `member` who is not the
    author gets 404 — the label is not theirs to delete; an `admin` gets 204).
- **PATTERN**: `apps/ingest/src/identity.int.test.ts:1-80` and `apps/ingest/src/rls.int.test.ts:116-270`.
- **GOTCHA**: call `seedBootstrapKey(owner.db, ADMIN_EMAIL)` in `beforeEach` **after** the TRUNCATE.
- **GOTCHA**: seed real `events` for each labelled session (via `ingestBatch(owner.db, machineId,
  batch(...))`, copying the `batch()` helper at `apps/ingest/src/rls.int.test.ts:82-114`) or every
  POST 404s on the existence guard.
- **VALIDATE**: `npx vitest run apps/ingest/src/outcome-labels.int.test.ts`

### 15. UPDATE `apps/ingest/src/rls.int.test.ts` — TRUNCATE list

- **IMPLEMENT**: add `outcome_label_revisions, outcome_labels` to the `beforeEach` TRUNCATE (line
  167), before `report_artifacts`.
- **GOTCHA**: `TRUNCATE … CASCADE` from `users`/`organizations` would reach them anyway via FK; they
  are listed explicitly because every other tenant table is, and an implicit cascade is exactly the
  kind of thing that stops being true when an FK changes.
- **VALIDATE**: `npm run repo-health -- --require-db`

### 16. UPDATE `docs/guide/data-boundary.md`

- **IMPLEMENT**:
  - §5 export table: add the `GET /v1/labels/export` row with its redaction call site.
  - §6: add an "Outcome labels" row to the automatic-deletion table? **No** — deletion is
    user-initiated, not automatic. Instead add a short subsection stating D-16.1-6's policy verbatim,
    and **correct** the paragraph that says _"There is no delete-my-data button, and no per-session
    delete API"_ — it is now true only of captured data.
  - The closing **Gap** blockquote: strike the §7 P0.2 clause (that half is now closed) and keep the
    §6 Phase 6 step 5 clause (still open).
- **GOTCHA**: this file cites `file:line` references. Re-verify the two you touch rather than
  copying the numbers from here.
- **VALIDATE**: `npx prettier --check docs/guide/data-boundary.md`

### 17. UPDATE `docs/guide/usage.md`

- **IMPLEMENT**: a short "Outcome labels (ingest API)" subsection under §5 with curl examples for
  create / skip / get / patch / list / export / delete, in the style of the existing "Reports,
  projections & AI insight" block (line 265).
- **VALIDATE**: `npx prettier --check docs/guide/usage.md`

### 18. UPDATE `SUMMARY.md`

- **IMPLEMENT**: flip **16.1** to ✅ with a one-line "DONE `<date>` (PR #NN)" in **both** §0 and the
  §6 M16 bullet. **Leave the milestone status as IN PROGRESS** — writing `**M16 …** is **DONE**`
  would disable per-slice checking for 16.2–16.4 (`m16-dogfood-instrumentation.md` Risk 4).
- **VALIDATE**: `node scripts/check-summary.mjs`

---

## TESTING STRATEGY

### Unit Tests

`packages/shared/src/outcome-labels.test.ts` — no infra, always runs. Guards accept every member,
reject near-misses, and the arrays match research plan §4.3 exactly (this test is what stops a
value drifting away from the specification it is supposed to implement).

### Integration Tests

**Both new suites are TWO-ROLE, and that is not optional.** This slice adds tenant tables, so
CLAUDE.md's rule applies verbatim: _"any slice that touches tenancy MUST carry a TWO-ROLE suite"_,
with a role-identity assertion as the **first test**. An owner-connected suite would report green
while enforcing nothing (`bypassed ≠ enforced`).

- **Repository layer** (`packages/db/.../outcome-labels.int.test.ts`) — proves the **predicates and
  the policies**. This is where dropping a policy must turn the file red.
- **HTTP layer** (`apps/ingest/src/outcome-labels.int.test.ts`) — proves the **routes carry a
  context**, plus RBAC, redaction and the full lifecycle. Note the 15.3 measurement: an HTTP suite
  validates the PRIMARY defence (the explicit `orgId` predicates), not the backstop — which is
  exactly why both layers are required.

**Mutation check (run it, record the result in the execution report):** replace
`outcome_labels_org_isolation` with `USING (true)` and re-run the repository suite. It must go red.
Remove the policy the RIGHT way — **replace** it, do not drop it, because dropping a policy while
RLS stays ENABLED makes Postgres deny everything and the tests then fail for the wrong reason
(CLAUDE.md M15 15.3 corollary). Restore afterwards.

### Edge Cases

- Two orgs holding the **same connector `session_id`** — each labels it independently; neither sees
  the other. (The 15.1/15.2 bug shape.)
- A second POST to an already-labelled session → 409, **not** a silent overwrite.
- A POST for a session with **zero events** → 404 and **zero rows created**.
- An empty PATCH body → **400** from the schema (`minProperties: 1`), not a no-op revision bump.
- `intent` at exactly 200 chars → accepted; 201 chars → 400.
- `qualityRating` of `0` or `6` → 400.
- Concurrent PATCHes on one label → the `FOR UPDATE` lock serialises them; revisions are contiguous.
  (Assert at the **repository** layer with two hand-held transactions — two concurrent HTTP requests
  serialise on their own at that granularity and the test would pass with or without the lock, which
  is the M15 15.5 "concurrency test at the wrong layer cannot fail" trap.)
- A `viewer` DELETE that reaches the database → `DELETE 0`, silently. Asserted explicitly.
- Deleting a label leaves the session's `events` and `raw_source_records` **untouched** — the §7
  P0.2 "never a mutation of a raw record" claim, asserted rather than assumed.

---

## VALIDATION COMMANDS

All runnable from the **repo root**.

### Level 1: Syntax & Style

```bash
npm run typecheck          # root `tsc -b` — MUST exit 0. Not a per-workspace build.
npm run lint               # ESLint — CI runs it; repo-health does NOT.
npm run format:check       # CI lints .md too; format before pushing.
```

Pass signal: all three exit 0.

### Level 2: Unit Tests

```bash
npx vitest run packages/shared/src/outcome-labels.test.ts
npm test                   # full vitest run; int layer self-skips without DATABASE_URL_TEST
```

Pass signal: 0 failures; the shared suite reports its own tests as passed.

### Level 3: Integration Tests — THE GATE FOR THIS SLICE

```bash
npm run db:up
npm run db:migrate                                   # dev DB (DATABASE_URL)
# The TEST database is NOT migrated by db:migrate — migrate it explicitly:
DATABASE_URL=postgres://420ai:420ai@localhost:5433/420ai_test npm run db:migrate
npm run repo-health -- --require-db
```

Pass signal: **`--require-db` exits 0 with `0 skipped`**, and its pre-flight prints
`RLS test role '420ai_app' is non-superuser with rolbypassrls=false`. A plain `repo-health` PASS is
**not** acceptable evidence for this slice — a skipped DB layer reports green
(`skipped ≠ passed`).

Policy inventory spot-check:

```bash
docker exec -i 420ai-archive psql -U 420ai -d 420ai_test \
  -c "select tablename, policyname, permissive, cmd from pg_policies where tablename like 'outcome_label%' order by 1,2"
```

Pass signal: **8 rows** — per table, one `PERMISSIVE | ALL` and three `RESTRICTIVE`
(INSERT / UPDATE / DELETE).

### Level 4: Manual Validation

```bash
# Terminal 1
npm run ingest:dev
# Terminal 2 — mint a key first (M15 15.9: there is no ADMIN_TOKEN any more)
curl.exe -s -X POST http://localhost:3000/v1/sessions/<real-session-id>/label \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  --data-binary "@label.json"          # PowerShell: file-based body, curl.exe (see memory)
curl.exe -s http://localhost:3000/v1/labels -H "authorization: Bearer $KEY"
curl.exe -s "http://localhost:3000/v1/labels/export?format=csv" -H "authorization: Bearer $KEY"
```

Then verify the §7 P0.2 core claim directly:

```bash
docker exec -i 420ai-archive psql -U 420ai -d 420ai \
  -c "select count(*) from raw_source_records where session_id = '<real-session-id>'"
```

Pass signal: the count is **identical before and after** creating, editing and deleting the label.

### Level 5: Additional Validation

`node scripts/check-summary.mjs` — passes only once SUMMARY marks **16.1** ✅ (required in the same
commit as the execution report).

---

## ACCEPTANCE CRITERIA

Research plan §7 P0.2's acceptance is _"label can be created, edited, skipped, exported, and deleted
according to archive policy."_ Each maps to a checkbox:

- [ ] **Created** — `POST /v1/sessions/:id/label` returns 201 with the full row; a second POST is 409.
- [ ] **Edited** — `PATCH` returns 200, bumps `revision`, and `GET …/revisions` shows the pre-edit
      snapshot with its original values.
- [ ] **Skipped** — `POST { status: "skipped" }` persists a row, so 16.2 can implement "never nag".
- [ ] **Exported** — `GET /v1/labels/export?format=json|jsonl|csv` works and is **redacted**
      (a token-shaped `intent` does not appear in the export body but does in the in-app read).
- [ ] **Deleted** — `DELETE` removes the label and every revision row; the policy is written into
      `docs/guide/data-boundary.md` §6 and the stale "no per-session delete API" sentence corrected.
- [ ] **Never a mutation of a raw record** — a repository-layer test asserts `raw_source_records` and
      `events` counts are unchanged across the whole label lifecycle.
- [ ] All six §4.3 fields exist with the specified value sets (the `model/tool` → `model_tool`
      normalization is the only deviation, and it is documented in the shared module's header).
- [ ] `author_user_id` is NOT NULL and no code path writes a label without a human principal (§5.3).
- [ ] Both new tables are in `STRICT_TABLES`; the `rls.int.test.ts` tenant-table count reads **19**.
- [ ] The mutation check was run: replacing the org policy with `USING (true)` turns the repository
      suite red. Result recorded in the execution report.
- [ ] `npm run repo-health -- --require-db` green with **0 skipped**.
- [ ] `npm run lint` and `npm run format:check` green (CI runs both; `repo-health` runs neither).
- [ ] No regressions: the existing 15.3/15.4/15.5 suites still pass unchanged.

---

## COMPLETION CHECKLIST

- [ ] All 18 tasks completed in order
- [ ] Each task's validation ran and passed immediately
- [ ] Root `tsc -b` exits 0
- [ ] `npm run repo-health -- --require-db` green, 0 skipped, RLS role verified non-bypassing
- [ ] Both two-role suites lead with a role-identity assertion
- [ ] Mutation check run and recorded
- [ ] Manual curl lifecycle confirms raw-record counts unchanged
- [ ] `docs/guide/data-boundary.md` and `docs/guide/usage.md` updated
- [ ] `SUMMARY.md` flips **16.1** ✅ in §0 and §6, milestone stays **IN PROGRESS**
- [ ] Acceptance criteria all met

---

## NOTES

### Non-goals — name these in the PR, do NOT build them here

From `m16-dogfood-instrumentation.md`'s non-goals plus this slice's own shape:

- **The 15-second tray surface and the dashboard review table** — that is **16.2**. This slice ships
  no UI, touches no `apps/dashboard` or `apps/desktop` file, and adds no collector code.
- **§7 P1.5 decision links** ("I changed X because this evidence showed Y") — folded into **16.2**,
  deliberately, because the label surface and the decision link are the same interaction at
  different granularity.
- **§7 P1.6 hero-workflow evidence panel** — not an M16 slice at all until Phase 2's gate G2 names
  the winner. Do not add it thinking it was forgotten.
- **Any aggregate over labels** (completion rate, outcome distribution) — that is **16.4**'s
  data-quality audit report. This slice ships the raw list and export it will read.
- **A retention policy for anything other than labels** — D-16.1-6 is deliberately narrow.

### Spikes RUN during planning, with their results

**SPIKE 1 — the exact DDL, executed against the live `420ai_test`.** A throwaway
`spike_outcome_labels` table was created with the proposed shape (uuid PK, `org_id`, `session_id`,
`status`, `quality_rating`, unique index on `(org_id, session_id)`), then ENABLE + FORCE + the one
PERMISSIVE org policy + the three RESTRICTIVE role policies, copied from 0015/0016. Results:

| Check | Result |
|---|---|
| App-role privileges after `CREATE TABLE`, with **no** explicit `GRANT` | `DELETE, INSERT, SELECT, UPDATE` — 0015's `ALTER DEFAULT PRIVILEGES` covers it, confirming 0023's claim for **this** table shape |
| `pg_policies` shape | `_org` = `PERMISSIVE/ALL`, qual set, no with_check · `_role_insert`/`_role_update` = `RESTRICTIVE`, **with_check** set, qual null · `_role_delete` = `RESTRICTIVE`, **qual** set, with_check null |
| `pg_class` | `relrowsecurity = t`, `relforcerowsecurity = t` |

That shape satisfies every assertion in `rls.int.test.ts`'s inventory test (lines 519-609) by
construction. **The throwaway table was dropped.**

**SPIKE 2 — behaviour, as the non-bypassing app role** (`SET ROLE "420ai_app"` inside a
transaction, which is exactly the role the server connects as):

| Check | Result |
|---|---|
| A — no org context, app role | `count = 0`, **no error** — fails closed and quiet (the `nullif(…,'')` guard) |
| B — org-A context | 1 row, org A's; org B's row invisible |
| C — `app.current_role = 'viewer'`, INSERT | **LOUD**: `new row violates row-level security policy "spike_labels_role_insert"` |
| D — `viewer`, DELETE | **SILENT `DELETE 0`** — reproduces the 15.4 lesson; the route gate is the only loud layer for deletes |
| E — org-A context, INSERT with org B's `org_id` | **LOUD**: `new row violates row-level security policy` — a `FOR ALL` policy applies `USING` as the INSERT `WITH CHECK` |
| F — duplicate `(org_id, session_id)` under a valid context | `duplicate key value violates unique constraint` → the `23505` the repository maps to `already_labeled` |
| G — owner, no context | 2 rows — `FORCE` removes the table-owner exemption but **not** the superuser one (15.0 Finding 1, unchanged) |

E is the one worth flagging: it means the STRICT org policy already blocks a cross-org INSERT
without any extra `WITH CHECK` clause, so **do not add one** — an explicit `WITH CHECK` would make
this table's policy shape differ from the other 13 and break the inventory test's uniformity.

**SPIKE 3 — symbols verified by reading source, not memory.**

| Symbol | Verified signature | Source |
|---|---|---|
| `withOrg` | `(db: Db, orgId: string, role: string, fn: (tx: Tx) => Promise<T>) => Promise<T>` | `packages/db/src/org-context.ts:50` |
| `resolvePrincipal` | `(app, request) => Promise<Principal \| null>` | `apps/ingest/src/auth.ts:68` |
| `authorized` | `(principal: Principal, minimum: Role) => boolean` | `apps/ingest/src/auth.ts:300` |
| `isUuid` | `(s: string) => boolean` | `apps/ingest/src/auth.ts:310` |
| `hasRole` | `(role: string, minimum: Role) => boolean`, fails closed via `Object.hasOwn` | `packages/shared/src/roles.ts:38` |
| `sessionDetail` | `(db: DbClient, orgId: string, sessionId: string)`; unknown ⇒ `eventCount === 0` | `packages/db/src/repositories/projections.ts:295-307` |
| `toJsonl` / `toCsv` | `(rows: readonly unknown[]) => string` / `(rows: readonly Record<string,unknown>[], columns: readonly string[]) => string` | `packages/shared/src/serialize.ts:45,77` |
| `seedBootstrapKey` | `(db: Db \| Tx, email: string, label?: string) => Promise<string>` | `apps/ingest/src/test-support/bootstrap-key.ts:34` |
| `MemberError` mapping | `not_a_member` → 404, else 409 | `apps/ingest/src/app.ts:268-272` |
| rollback down-file naming | `drizzle/down/<journal tag>.down.sql`, split on `--> statement-breakpoint` | `packages/db/src/rollback.ts:36-40` |
| journal state | 24 entries, latest `0023_silky_longshot` ⇒ this slice is **0024** | `packages/db/drizzle/meta/_journal.json` |

**SPIKE 4 — infrastructure confirmed live.** `420ai-archive` container up and healthy on host port
5433; `.env` carries `DATABASE_URL_TEST` (owner) and `DATABASE_URL_TEST_APP` (`420ai_app`), so the
two-role suites will actually run rather than self-skip. Confirmed that `420ai_app` has
`rolbypassrls = false` by executing the assertion this slice's Test 1 makes.

### Trade-offs taken

- **Two tables instead of one versioned table.** `report_artifacts` models history by appending a
  new row per version, and this slice deliberately does not copy that: the tray needs "the current
  label for session X" as a single-row lookup on every session view, and a `max(version)` subquery
  on the hot path buys nothing here. The cost is one extra table; the benefit is that both the
  current-state read and the history read are trivial.
- **Nullable §4.3 columns.** The price of D-16.1-2's persisted skip. Mitigated by a discriminated
  union at the TS boundary and a JSON-schema enum at the HTTP boundary, which is the same
  "enforcement in code, not in a CHECK constraint" trade the whole repo already makes.
- **Author-only edit.** Slightly more code than "any member may edit", and it will look like
  over-engineering in a one-person deployment. It is not: 16.4 reads these rows as *evidence*, and
  an evidence store where anyone can rewrite anyone's answer is not evidence. It also costs nothing
  to keep once written.

### Residual risk (the one deduction below a perfect score)

The migration's generated half comes from `npm run db:generate`, whose exact output filename is
random (`0024_<two-random-words>`) and whose emitted SQL I have not seen for **these specific**
columns — I verified the DDL shape by hand-writing and executing the equivalent, not by generating
it. The risk is cosmetic (a differently-named file, or drizzle ordering the FK statements
differently) and the down-file naming rule in SPIKE 3 covers the one way it could actually break.
Task 5's `psql` policy-count check catches any divergence immediately.

### Confidence

**9.5 / 10** for one-pass success. Evidence: SPIKE 1 and 2 executed the exact policy DDL against the
live test database and measured all seven behaviours the design depends on (including the two
counter-intuitive ones — the silent viewer DELETE and the `FOR ALL` implicit `WITH CHECK`); every
imported symbol in SPIKE 3 was read from source with its file:line; the test harness
(`seedBootstrapKey`, the two-role fixtures, `errorChain`/`expectRlsRejection`) was confirmed to
exist with exact names; the structural gates this slice must satisfy (`org-scoping.test.ts`,
`rls.int.test.ts`'s derived counts and its two hand-written integers, `check-summary.mjs`) were each
read and their requirements written into specific tasks.
