# Execution Report — M15 Slice 15.1: Tenancy Schema

## Meta Information

- **Plan file:** [`.agents/plans/m15-slice1-tenancy-schema.md`](../plans/m15-slice1-tenancy-schema.md)
- **Code review:** [`.agents/code-reviews/m15-slice1-tenancy-schema.md`](../code-reviews/m15-slice1-tenancy-schema.md)
- **Branch:** `m15-slice1-tenancy-schema` (base `e659c5e`)
- **Lines changed:** +695 −167 across 46 modified files, plus 9 added files

**Files added**

- `packages/db/drizzle/0014_loose_pyro.sql` — hand-edited up migration (the repo's **first** with DML)
- `packages/db/drizzle/down/0014_loose_pyro.down.sql`
- `packages/db/drizzle/meta/0014_snapshot.json` — generated, unedited
- `packages/db/src/repositories/organizations.ts`
- `packages/db/src/repositories/organizations.int.test.ts`
- `packages/db/src/repositories/tenancy.int.test.ts`
- `.agents/qa/m15-signoff/migration-rollback-drill-2026-07-26.txt` (D-M15-13 evidence)
- `.agents/plans/…` + `.agents/code-reviews/…`

**Files modified (46)** — `packages/db/src/schema.ts` (2 new tables, `org_id` + FK on 15 tables,
14 `*_by_org` indexes, `search_documents_entity` re-scoped); repositories `ingest`, `machines`,
`users`, `search`, `pairing`, `tokens`, `git`, `projects`, `workspaces`, `reports`, `attribution`,
`alert-firings`; `packages/db/src/index.ts`; `apps/ingest/src/routes/{pair,pairing-codes}.ts`;
26 int-test seed blocks; `rollback.int.test.ts`; `CLAUDE.md`; `SUMMARY.md`.

## Validation Results

| Gate                                  | Result                                                    |
| ------------------------------------- | --------------------------------------------------------- |
| Syntax & Linting (`npm run lint`)     | ✓ exit 0                                                   |
| Formatting (`npm run format:check`)   | ✓ exit 0                                                   |
| Type Checking (root `tsc -b`)         | ✓ exit 0                                                   |
| Unit + Integration (`vitest run`)     | ✓ **841 passed / 841**, 111 files                          |
| `repo-health -- --require-db`         | ✓ **PASS** — 200 integration tests ran, **0 skipped**      |
| `build:dashboard`                     | ✓ exit 0                                                   |

**D-M15-13 rollback drill** on a `TEMPLATE` clone of the real archive (413,765 events /
256,085 raw / 30,361 search docs): up ≈22.1 s → down ≈8.8 s → re-up ≈22.7 s. After up:
`ev_null=0 raw_null=0 sd_null=0 m_null=0 orgs=1`. After down: row counts intact, 0 `org_id`
columns remaining, both tables gone, index restored. Drill DB dropped and verified absent.

**Live archive after migration:** one personal org, `role=owner`, all 413,765 events /
256,085 raw / 30,361 search docs / 5 machines attributed, zero nulls.

## What Went Well

- **`NOT NULL` as the checklist.** Making `org_id` non-nullable turned `tsc -b` into an
  exhaustive enumeration of all 17 insert sites and every affected test seed — it refused to
  compile them until each was handled. At run time the same constraint turned ~20 pre-existing
  int suites into implicit org-coverage tests. No write path was missed, and no discipline or
  convention was required to achieve that.
- **Derive-vs-pass (plan Conflict 2) paid off exactly as argued.** Reading the org from
  `machines.org_id` inside `ingestBatch`'s transaction kept all **25** call sites untouched and
  made "the caller passed the wrong org" unrepresentable. Same for `recordGitCommits`,
  `issueIngestToken`, `recordHeartbeat`.
- **The plan's spike numbers were exact.** `drizzle-kit` emitted `ADD COLUMN … NOT NULL`
  verbatim as predicted, ran non-interactively, ordered the index `DROP`/`CREATE` correctly,
  and the migration timings matched the planning spike to within a second.
- **Hand-writing the migration was the right call**, and the `--> statement-breakpoint`
  separator made the down file work with the existing `rollback.ts` engine with zero changes.

## Challenges Encountered

- **Mechanical breadth, as the plan predicted (its residual 0.5 confidence).** 26 int-test seed
  blocks needed the same three-part edit. I scripted it with a throwaway codemod, which was the
  right instinct but over-matched: its "shape B" regex also hit *secondary* `other@example.com`
  user inserts, generating `orgId = await ensurePersonalOrg(dbh.db, u!.id, …)` where `u` was out
  of scope and where the assignment clobbered the seed's `orgId`. `tsc` caught every instance.
  Lesson: a codemod over test fixtures needs the typechecker as its acceptance gate, not its
  own confidence.
- **A cwd trap.** An earlier `cd packages/db` persisted in the Bash tool, so the codemod's second
  pass ran against relative paths that didn't match its `packages/db/src/repositories` branch and
  wrote `import … from "@420ai/db"` — a self-import — into 13 files in that package. Typecheck
  passed (it resolves), so only reading the output caught it. Normalized to `./organizations.js`.
- **The highest-severity defect was invisible to every gate.** See below.

## Divergences from Plan

**1. `indexSessions` re-scoped to `(org_id, session_id)` — beyond the plan's 3 edits to `search.ts`**

- **Planned:** Task 12 specified three edits — `DocInput` gains `orgId`, `upsertDoc`'s conflict
  target changes, and `indexSessions` adds `orgId: min(machines.org_id::text)` as "an org twin
  beside the existing user aggregate".
- **Actual:** `org_id` is selected as a real `GROUP BY` column (not `min()`), the grouping is
  `(org_id, session_id)`, and `indexOneSession` / `indexSessionEvents` / the attribution join are
  scoped by that org.
- **Reason:** The planned version is a **cross-tenant content leak**, found in code review and
  reproduced against the test DB. Grouping by `session_id` alone collapses two tenants that share
  a connector session id (a globally-scoped string — precisely audit B.1's premise) into ONE
  document owned by `min(org_id)`, and the unscoped content reads concatenate both orgs' decrypted
  payloads into it. The probe printed `sessions:1`, `orgs:['A']`, `containsA=true containsB=true`.
  It also meant the slice's headline B.1 acceptance criterion was only true of the *index*: the
  builder could never emit the second row, so the hand-inserted B.1 test passed over a broken code
  path. Now pinned by a test that drives the real builder.
- **Type:** Security concern (cross-tenant leak) + Plan assumption wrong.

**2. Explicit row-column constants in `projects.ts` / `workspaces.ts` / `reports.ts`**

- **Planned:** Not mentioned. The plan asserted "no route/API shape changed."
- **Actual:** Added `projectRowColumns` / `workspaceRowColumns` / `reportArtifactRowColumns` and
  used them in every `select()` / `returning()`.
- **Reason:** Those functions used bare `select()`, no ingest route declares a Fastify `response`
  schema, and rows go straight to `reply.send()` — so adding `org_id` to the tables silently put it
  on the wire in six endpoints (verified by probing the serialized shapes). It also made the
  declared `ProjectRow`/`WorkspaceRow`/`ReportArtifactRow` interfaces lie about their runtime shape.
  Narrowing restores the stated neutrality and closes the type lie in one move.
- **Type:** Plan assumption wrong.

**3. `recordHeartbeat` derives the org from `UPDATE … RETURNING` rather than a separate SELECT**

- **Planned:** Task 8 said `const orgId = await getMachineOrgId(db, machineId)`.
- **Actual:** `.returning({ orgId })` on the `UPDATE machines` the function already ran.
- **Reason:** Same row, same statement — the extra SELECT was free to remove on a ~30 s-cadence
  path, and an empty result gives the unknown-machine guard before any heartbeat row is written.
  `getMachineOrgId` still exists and is used by the four other derive sites.
- **Type:** Better approach found.

**4. `rollback.int.test.ts` retargeted from 0013 to 0014**

- **Planned:** Not mentioned.
- **Actual:** Updated the migration count 14→15 and the probe from `search_documents.session_id`
  to `events.org_id` + the index column list, plus assertions that both new tables are dropped.
- **Reason:** The test pins "the latest migration" by number, so it is version-coupled by
  construction. Editing it is correct maintenance, not a test being bent to fit — and it now
  exercises the 0014 down/up cycle on every run.
- **Type:** Other (expected maintenance).

## Skipped Items

- **Level 4.3, live collector sync.** Not run — it writes test rows into the production archive.
  The identical path (`pairing-codes` → `pair` → `ingestBatch` over a real socket) is covered by
  `apps/collector/src/push.int.test.ts` and `apps/ingest/src/app.int.test.ts`, both of which ran
  against the test DB with 0 skipped. Flagged to the user rather than done silently.
- **The plan's edge case "seed an `events` row with `machine_id IS NULL` at backfill time and
  assert it lands in the oldest org."** Not testable post-migration — Step 3b only executes during
  `0014`, and it matched zero rows on the real archive. Substituted the going-forward invariant:
  `tenancy.int.test.ts` asserts a null-machine event is rejected without an org and accepted with one.
- **Review finding 3 (`POST /v1/discover` N+1), 5 (`rebuildSearchIndex` global delete), 6
  (explicit-`userId` pairing-code 500).** Consciously accepted with reasons recorded in the review;
  3 and 5 belong to 15.2 (the request principal deletes the `getOrgIdForUser` seam outright), 6 is
  unreachable through the app and 15.5 deletes the endpoint.

## Recommendations

**Plan command improvements**

- **A plan that re-scopes a uniqueness key must also check every BUILDER that writes that key.**
  This plan correctly identified audit B.1 and correctly re-scoped the index, but its `search.ts`
  task treated `indexSessions` as a mechanical "add an org twin beside the userId aggregate" —
  copying the shape of a line that was only safe because the system was single-tenant. The generic
  lesson: when a plan changes a unique index from `(X)` to `(org, X)`, it should require an explicit
  audit of every `GROUP BY` and every `WHERE` on `X` in the write path, because those are exactly
  the places that silently assumed `X` was globally unique.
- **"Behavior-neutral" needs to be verified, not asserted.** The plan's acceptance criteria said
  "no API shape changed"; nothing in the plan told the executor to *check* a serialized response.
  A plan that adds a column to tables whose rows are returned by bare `select()` should include a
  one-line probe of the wire shape.

**Execute command improvements**

- The instruction to run `/lril:code-review` before commit earned its keep here in a class the
  command's own description doesn't name. Its example (M9 SSE/timer teardown leaks) is one instance
  of a broader rule worth stating: **`tsc` + a green suite cannot catch a defect whose test was
  written against the schema instead of the code path.** The B.1 test inserted rows by hand and
  passed while the builder was broken. Suggest adding: "for any test that asserts a capability,
  check whether it exercises the real code path or merely the data model."

**CLAUDE.md additions**

- Under the Drizzle/SQL gotchas, add: **an aggregate over a tenancy column is a smell.**
  `min(org_id)` in a `GROUP BY` that does not include `org_id` collapses tenants into one row and
  silently picks a winner. If a column is a tenancy or ownership key, it belongs in the `GROUP BY`,
  never in an aggregate.
- Under the same section, add: **repository functions whose rows reach `reply.send()` must use
  explicit column lists.** No ingest route declares a Fastify `response` schema, so a bare
  `select()` / `returning()` makes every future column an unannounced API addition. The three
  `*RowColumns` constants added in this slice are the pattern to copy.
