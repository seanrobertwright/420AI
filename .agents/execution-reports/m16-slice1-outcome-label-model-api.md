# Execution Report — M16 Slice 16.1: Outcome Label Model + API

**Plan:** [`.agents/plans/m16-slice1-outcome-label-model-api.md`](../plans/m16-slice1-outcome-label-model-api.md)
**Code review:** [`.agents/code-reviews/m16-slice1-outcome-label-model-api.md`](../code-reviews/m16-slice1-outcome-label-model-api.md)
**Branch:** `m16-slice1-outcome-label-model-api`
**Executed:** 2026-08-03

---

## What shipped

The data model and HTTP API for research plan §4.3's outcome label — a voluntary, editable,
<15-second human judgement of a captured session — as §7 P0.2 requires: a separately auditable
record linked to a session, **never a mutation of a raw record or an event**.

Two STRICT tenant tables behind the M15 15.3/15.4 RLS pattern (migration **0024**, 8 policies):

- **`outcome_labels`** — current state, at most one per `(org_id, session_id)`. The unique index
  takes **both** columns because `session_id` is connector-supplied and globally scoped; a
  `(session_id)`-only index would let one org's label block another's, which is the 15.1
  `search_documents_entity` bug re-shipped.
- **`outcome_label_revisions`** — one immutable snapshot per revision, v1 written at creation. This
  is what makes §7 P0.2's "preserve … edits" a **record** rather than a claim: a `quality_rating`
  revised from 2 to 5 a week later is hindsight, which §4.3's "captures what success meant before
  hindsight" exists to guard against, and a counter cannot detect it.

Plus one closed-set module in `@420ai/shared` (built from §4.3's own value table), one repository,
four JSON schemas, seven routes, and two two-role integration suites.

**No UI.** The tray and dashboard surfaces, and §7 P1.5 decision links, are 16.2.

## Decisions settled

| ID        | Decision                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| D-16.1-1  | Two tables: current state + immutable revision snapshots. A counter records *that*, not *what*.                |
| D-16.1-2  | A skip is a ROW. Without one, §4.3's "do not nag repeatedly" is unimplementable.                               |
| D-16.1-3  | One label per `(org_id, session_id)`; a second author is 409, not a second row.                                |
| D-16.1-4  | Edits are author-only at **every** rung including `owner`; DELETE is author-or-`admin`.                        |
| D-16.1-5  | Labelling is **not** an `AUDIT_ACTIONS` entry — the revisions table is this feature's audit trail.             |
| D-16.1-6  | Labels are the first deletable object in the archive, and this slice writes that policy.                       |
| D-16.1-7  | The export redacts; the in-app reads do not. `intent` is free human text.                                      |
| D-16.1-8  | `author_user_id` NOT NULL with no service-role write path — an unauthored label is unrepresentable.            |

**D-16.1-6 closes half of a gap 16.0 wrote down rather than hid.** `docs/guide/data-boundary.md` §6
said §7 P0.2's "deleted according to archive policy" assumed a policy that did not exist. It exists
now, for labels only, and the reason it does not weaken "raw records sacred" is the whole argument: a
label is neither raw nor derived but *volunteered human ground truth*, re-creatable only by the
person who gave it, and therefore the one object in the archive they are entitled to retract.

## Files

**Added (10):** `packages/shared/src/outcome-labels.{ts,test.ts}` ·
`packages/db/src/repositories/outcome-labels.{ts,int.test.ts}` ·
`packages/db/drizzle/0024_lowly_logan.sql` + `down/` + `meta/0024_snapshot.json` ·
`apps/ingest/src/routes/outcome-labels.ts` · `apps/ingest/src/outcome-labels.int.test.ts` · the plan.

**Modified (14):** `schema.ts` (2 tables) · both barrels · `schemas.ts` · `app.ts` ·
`rls.int.test.ts` ×2 · `tenancy.int.test.ts` · `rollback.int.test.ts` · `serialize.ts` ·
`docs/guide/{data-boundary,usage}.md` · `SUMMARY.md`.

## Deviations from the plan

1. **Omitted the "backfill v1 if somehow absent" branch** in `updateOutcomeLabel` (plan task 7).
   `createOutcomeLabel` writes v1 in the same transaction, making the case unrepresentable; the
   branch would be permanently untestable dead code asserting a repair that cannot be needed.
2. **`ExportManifest.subject` needed widening** to `"labels"` — the union is closed and the plan did
   not flag it.
3. **Two files the plan did not list required updating**, both caught only by the full gate:
   - `tenancy.int.test.ts`'s `TENANT_TABLES` — a *different* question from `rls.int.test.ts` ("does
     every `org_id` column carry NOT NULL + an FK?"), so both files needed the tables for different
     reasons.
   - `rollback.int.test.ts` — the D-M15-13 drill is pinned to *the latest* migration and retargets
     0023 → 0024. Policy counts move 60 → **68**, RESTRICTIVE 42 → **48** (its first movement since
     0016). A policy-shape assertion was added so converting either table to append-only fails the
     drill before `rls.int.test.ts` runs.

## What the review found, and what it cost

The code review found **three real defects, all in the PATCH path, all one root cause**: the create
path enforced the `labeled`/`skipped` invariant and the edit path did not. Two were confirmed against
a live database before being written up.

- `PATCH {"status":"skipped"}` on a judged session returned 200 with `outcome: "shipped"` and
  `qualityRating: 4` still set — a skip carrying a full judgement.
- `PATCH {"status":"labeled"}` on a skipped session returned 200 with all five fields NULL — a row in
  the **numerator** of "sessions I judged" containing nothing a human decided.

**This is the lesson worth carrying forward, because it is not a coding slip.** The create path had
three layers of protection — a discriminated union making an incomplete create a compile error, a
JSON-schema `required`, and an explicit route check — and every one of them is blind to a *merged*
PATCH. Checking the patch body would not have helped either: a partial edit of a complete label
legitimately sends one field. **The invariant was a property of the ROW, and every guard was written
against an INPUT.** The fix moves it to `assertLabelShape`, run on the merged state by both paths,
and deletes the route's now-duplicate check so there is exactly one owner.

The third finding is the same shape at the documentation layer: `PatchOutcomeLabelInput` documented
`null`-means-clear, the repository implemented it, and the JSON schema 400'd it — a contract
describing behaviour the system would reject. Fixed by widening the two §4.3-optional fields
(`followUpCommitOrPr`, `confidence`) to `["string","null"]` and leaving the five required ones
non-nullable by design.

Six regression tests were added, including a **positive control** that a *complete* skip→labeled
upgrade still works — without it, a guard that simply refused the transition would have passed the
negative test while breaking the §4.3 feature it protects.

## Validation

```
npm run typecheck                    EXIT=0   (root tsc -b)
npm run lint                         EXIT=0
npm run format:check                 EXIT=0
node scripts/check-summary.mjs       PASS
npm run repo-health -- --require-db  PASS
  ✓ RLS test role '420ai_app' is non-superuser with rolbypassrls=false
  ✓ all tests passed (543 integration tests ran, 0 skipped)
```

**Policy inventory** — exactly 8 rows (2 `PERMISSIVE/ALL` + 6 `RESTRICTIVE`), `relrowsecurity` and
`relforcerowsecurity` both true on both tables, app role holding `SELECT/INSERT/UPDATE/DELETE` with
**no explicit GRANT** (0015's `ALTER DEFAULT PRIVILEGES` re-verified live for this table shape).

**Mutation check (required by the plan).** Replacing `outcome_labels_org_isolation` with
`USING (true)` — *replaced*, not dropped, since dropping it while RLS stays enabled denies everything
and fails for the wrong reason — turned the repository suite **red at 2 of 16**: the fail-closed test
and the cross-org INSERT. That is the honest number, not a weak suite: the other 14 assertions run
through repository functions carrying explicit `eq(outcomeLabels.orgId, orgId)` predicates, so they
scope correctly on their own. This is 15.2's primary defence working and 15.3's finding restated —
**RLS backstops application scoping, it does not replace it.** Policy restored and re-verified.

**Lock check.** Removing `.for("update")` made two concurrent patches both write revision 2 and raise
`23505` on `outcome_label_revisions_label_revision` — the exact failure the code comment predicts.
Getting that test to fail *for the right reason* took two fixes of its own, both instances of M15
15.5 reproducing one level down: without waiting for transaction 1 to actually take the lock,
transaction 2 could win the race; and without releasing the held transaction in `finally`, a failed
assertion hung `pool.end()` and surfaced as a 5-second timeout instead of the assertion.

**Rollback drill** — dev DB round-tripped twice: 2 tables + 8 policies → 0 → 2 + 8.

**Manual lifecycle** against a live server (one session seeded into the dev DB, rows removed
afterwards): POST 201 → POST 409 → unknown-session 404 → PATCH 200 (revision 2, v1 keeps rating 4) →
revisions 200 → empty PATCH 400 → `model/tool` 400 → list + export json/jsonl/csv with correct
`X-Export-*` headers → DELETE 204 → GET 404 → skip 201 (all fields null) → second skip 409.
**`raw_source_records` 1 → 1 and `events` 1 → 1 across the entire lifecycle** while labels went
1 → 0 and revisions 2 → 0 — §7 P0.2's central claim, measured rather than assumed.

## Acceptance criteria (§7 P0.2)

- [x] **Created** — 201 with the full row; a second POST is 409.
- [x] **Edited** — PATCH 200, bumps `revision`, `GET …/revisions` shows the pre-edit snapshot.
- [x] **Skipped** — persists a row, so 16.2 can implement "never nag".
- [x] **Exported** — json/jsonl/csv, redacted (token-shaped `intent` absent from the export, present
      in the in-app read — asserted in both directions).
- [x] **Deleted** — removes the label and every revision; policy written into `data-boundary.md` §6
      and the stale "no per-session delete API" sentence corrected.
- [x] **Never a mutation of a raw record** — asserted at both layers.
- [x] All six §4.3 fields with the specified value sets (`model/tool` → `model_tool` is the only
      deviation, documented in the shared module's header and asserted from both sides).
- [x] `author_user_id` NOT NULL, no path writes a label without a human principal.
- [x] Both tables in `STRICT_TABLES`; `rls.int.test.ts` tenant count reads **19**.
- [x] Mutation check run and recorded.
- [x] `repo-health -- --require-db` green, 0 skipped.
- [x] `lint` and `format:check` green.
- [x] No regressions.

## Notes for 16.2

- The label surface must send a **complete** `labeled` body or a `skipped` one — a partial upgrade is
  now a 400 with `reason: "incomplete_label"` and the missing field names in `error`, which the tray
  can render directly against its own form fields.
- To let a user retract a judgement, PATCH `status: "skipped"` — it clears all seven fields at once
  and the prior judgement stays readable at `GET …/label/revisions`. Do **not** clear fields
  individually; the five required ones are non-nullable while `labeled`.
- `GET /v1/labels` is org-scoped at `viewer`, so a read-only account can render the review table.
