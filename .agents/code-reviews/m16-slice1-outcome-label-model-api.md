# Code Review — M16 Slice 16.1: Outcome Label Model + API

**Reviewed:** commit `a1f5df7` on `m16-slice1-outcome-label-model-api`
**Reviewed against:** `.agents/plans/m16-slice1-outcome-label-model-api.md` acceptance criteria,
`CLAUDE.md` invariants, research plan §4.3 / §7 P0.2.

**Stats:**

- Files Modified: 14
- Files Added: 10
- Files Deleted: 0
- New lines: 8,390 (includes the 1,124-line plan file)
- Deleted lines: 45

---

## Summary

The slice delivers what the plan promised: two STRICT tenant tables, migration 0024 with 8 policies,
a repository, seven routes, and two two-role integration suites. The tenancy work is sound — the
`(org_id, session_id)` unique index, `orgId`-second parameter ordering, explicit row-column lists,
and the `FOR UPDATE` lock were each verified by a mutation check rather than asserted.

**Three real defects were found, all in the PATCH path, and all three share one root cause: the
create path enforces the `labeled`/`skipped` invariant and the edit path does not.** Two were
confirmed empirically against a live database before being written up here; the third is a
comment/implementation mismatch verified by reading the schema.

The severity is higher than "a nullable field is inconsistent" because of what this table is *for*.
These rows are the ground truth 16.4 reconciles the product's own numbers against. An incoherent
label is not a cosmetic data-quality issue — it is a corrupted denominator in the one measurement
this milestone exists to make trustworthy.

---

## Issues

```
severity: high
file: packages/db/src/repositories/outcome-labels.ts
line: 320
issue: PATCH to `status: "skipped"` leaves all six §4.3 fields populated
detail: `updateOutcomeLabel`'s merge treats `status` like any other field, so patching a labeled
  row to `skipped` keeps `taskType`, `intent`, `outcome`, `qualityRating` and `primaryFriction`
  at their old values. VERIFIED against a live DB — the resulting row is
  `{"status":"skipped","taskType":"feature","intent":"did a thing","outcome":"shipped",
  "qualityRating":4,"primaryFriction":"none"}`. This directly contradicts D-16.1-2 and the
  header comment on `schema.ts` `outcomeLabels`, which states a skipped row "carries none of
  them" — so the comment is now false, which CLAUDE.md's M15 15.5 lesson calls out as the worse
  half of the defect (the next reader trusts it instead of re-deriving it).
  Consequence for 16.4: `count(status='labeled')/count(*)` still computes, but any per-outcome or
  per-friction histogram silently counts a session the operator explicitly declined to judge.
suggestion: In `updateOutcomeLabel`, when the MERGED status is `skipped`, force all seven optional
  fields to NULL rather than merging them — the same normalization `fieldsFromCreate` already does
  for the create path. Extract that normalization so both paths share it, since the invariant is a
  property of the row and not of the entry point.
```

```
severity: high
file: packages/db/src/repositories/outcome-labels.ts
line: 320
issue: PATCH to `status: "labeled"` produces a labeled row with no judgement in it
detail: The mirror image of the above, and the more damaging direction. Patching a `skipped` row to
  `labeled` passes no §4.3 fields, so the row becomes `status: "labeled"` with `taskType`,
  `intent`, `outcome`, `qualityRating` and `primaryFriction` all NULL. VERIFIED against a live DB.
  The POST path guards exactly this (`routes/outcome-labels.ts:137-147` returns 400 naming the
  missing fields); the PATCH path has no equivalent check at either the route or the repository.
  Consequence for 16.4: this row lands in the NUMERATOR of "sessions I judged" while containing
  nothing a human decided — the completion metric reports a judgement that does not exist. That is
  strictly worse than the previous finding, which only mislabels an existing judgement.
  It is also reachable from HTTP in one call: `PATCH {"status":"labeled"}` passes
  `patchOutcomeLabelBodySchema` (`minProperties: 1` is satisfied) and returns 200.
suggestion: Enforce the required-when-`labeled` shape on the MERGED result, not on the patch body —
  checking the body alone would wrongly reject a partial edit of an already-complete labeled row.
  The repository is the right layer (it is the only place that knows the merged state, and it holds
  the guard for any future caller); add an `OutcomeLabelError` reason such as `incomplete_label`
  mapped to 400 in `app.ts`, mirroring how the last-owner guard lives in `repositories/members.ts`
  rather than in the route.
```

```
severity: medium
file: packages/db/src/repositories/outcome-labels.ts
line: 156
issue: `PatchOutcomeLabelInput`'s documented "null means CLEAR" is unreachable over HTTP
detail: The interface comment states "`undefined` means LEAVE ALONE — distinct from `null`, which
  means CLEAR", and the repository does implement that (verified: patching
  `{followUpCommitOrPr: null}` clears the column). But every field in
  `patchOutcomeLabelBodySchema` is declared `{ type: "string" }` / `{ type: "integer" }` with no
  `"null"` in the type union, so ajv rejects an explicit `null` with a 400 before the handler runs.
  The capability exists in the repository, is documented as part of the contract, and cannot be
  invoked by the only caller. A comment describing behaviour the system does not expose is the
  same class of defect as the 15.5 header that asserted a guarantee it did not have.
suggestion: Either widen the two genuinely optional fields to `{ type: ["string", "null"] }`
  (`followUpCommitOrPr`, `confidence` — the five required-when-labeled fields should NOT be
  clearable while `labeled`, which is the previous finding's guard), or narrow the interface comment
  to say null-clearing is repository-only and not part of the HTTP contract. The first is preferable:
  a follow-up PR link pasted in error is exactly the thing a user will want to remove.
```

```
severity: low
file: apps/ingest/src/routes/outcome-labels.ts
line: 148
issue: local variable `outcome` shadows the domain meaning of `outcome`
detail: The POST handler names its `withOrg` result `outcome` (the discriminated
  "no_such_session" | OutcomeLabelRow value), in a file where `outcome` is also one of the six §4.3
  field names with a fixed closed set. `routes/members.ts` uses the same `outcome` idiom, so the
  convention is real — but it does not collide with a domain term there.
suggestion: Rename to `created` or `result`. Cosmetic, but this is the one file in the repo where
  the word is already taken.
```

```
severity: low
file: apps/ingest/src/routes/outcome-labels.ts
line: 372
issue: the label export has no row cap, unlike every other export route
detail: `GET /v1/labels/export` calls `listOutcomeLabels` with no `limit` and hard-codes
  `truncated: false`, where `exportEvents` bounds at `EXPORT_MAX_ROWS` (100,000). The route comment
  states the reasoning — labels are bounded by the number of sessions a human volunteered an opinion
  on, a few hundred over the research period — and that reasoning is correct for the stated use.
  Flagged because it is an unbounded read that loads every row into memory before serializing, and
  the honest `truncated: false` becomes a lie the moment a cap is added without also wiring the flag.
suggestion: No change required for 16.1's scope. If 16.4 or M20 ever loosens the one-label-per-session
  rule, add the cap and the flag together — CLAUDE.md's "no silent caps".
```

```
severity: low
file: apps/ingest/src/routes/outcome-labels.ts
line: 74
issue: `safeScopeKey` is duplicated from `routes/exports.ts`
detail: Byte-identical helper in two route files. The repo does tolerate deliberate per-file
  duplication (`errorChain`/`expectRlsRejection` are copied across three test files by decision), so
  this is consistent with local precedent rather than a clear violation.
suggestion: Leave as-is, or lift both into a shared route helper if a third export route appears.
  Not worth a change in this slice.
```

---

## What was checked and found correct

- **Tenancy.** `(org_id, session_id)` unique index; `orgId` is the second parameter of all six
  repository functions; both org predicates on the revisions join; no aggregate over an ownership
  column. Cross-tenant reads, writes and deletes are covered by the repository suite's tests 3, 11
  and 13.
- **The RLS classification is right and was measured.** 8 policies (2 PERMISSIVE/ALL + 6
  RESTRICTIVE), ENABLE + FORCE on both tables, app role privileges present with no explicit GRANT.
  The mutation check (org policy → `USING (true)`) turned the repository suite red at 2/16, which is
  the expected number: the other 14 assertions go through functions carrying explicit `orgId`
  predicates, i.e. 15.2's primary defence working as designed.
- **The `FOR UPDATE` lock is real.** Removing it makes two concurrent patches both write revision 2
  and raise `23505` on `outcome_label_revisions_label_revision` — the exact failure the comment
  predicts. The concurrency test is at the repository layer with two hand-held transactions, which
  is the layer where it can actually fail (M15 15.5), and it releases in a `finally`.
- **No row exposes `org_id`.** Explicit `*RowColumns` constants on both row types, asserted by
  repository test 15 and HTTP test 1.
- **`author_user_id` is NOT NULL with no service-role write path** — §5.3's guarantee is structural,
  as D-16.1-8 claims.
- **The §7 P0.2 core claim is asserted, not assumed** — `events` and `raw_source_records` counts are
  checked unchanged across the full lifecycle at both layers.
- **Structural gates.** `org-scoping.test.ts` passes with no allow-list entry; the route file
  contains both `withOrg(` and `authorized(`.
- **Two lists the plan did not mention were correctly updated** — `tenancy.int.test.ts`'s
  `TENANT_TABLES` and `rollback.int.test.ts`'s drill (retargeted 0023 → 0024, policy counts
  60 → 68, RESTRICTIVE 42 → 48, with a shape assertion that fails if either table is later converted
  to append-only).
- **No security issues.** No SQL injection surface (all predicates are drizzle-bound; no `sql.raw`
  in this slice); no secrets; the export redacts and the in-app read deliberately does not, asserted
  in both directions.

## Verification performed

- Confirmed findings 1 and 2 by running a temporary two-role integration test against the live
  `420ai_test` database and printing the resulting rows. The scratch file was deleted afterwards;
  the working tree is clean.
- Confirmed finding 3 by reading `patchOutcomeLabelBodySchema` against the repository's merge logic.
- `npm run repo-health -- --require-db` — PASS, 543 integration tests, 0 skipped.

---

## Resolution (second pass)

Maintainer disposition at the triage gate: **fix 1, 2, 3 · won't-fix 4, 5, 6.**

| #   | Severity | Issue                                          | File                                              | Disposition | What was done                                                                                                                                                                                                                     | Status    |
| --- | -------- | ---------------------------------------------- | ------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | High     | PATCH→`skipped` leaves §4.3 fields populated    | `packages/db/src/repositories/outcome-labels.ts:320` | Fix         | A merged status of `skipped` now blanks all seven fields via a shared `EMPTY_LABEL_FIELDS`. Deliberate data loss on the current row, safe because D-16.1-1 keeps every prior revision — it is a retraction, not an erasure.        | Fixed     |
| 2   | High     | PATCH→`labeled` yields a row with no judgement  | `packages/db/src/repositories/outcome-labels.ts:320` | Fix         | New `assertLabelShape` guard on the MERGED row throws `incomplete_label` → **400** naming the missing fields. Run by BOTH create and edit; the route's duplicate check was deleted so the invariant has one owner.                | Fixed     |
| 3   | Medium   | "null means CLEAR" undocumented/unreachable     | `packages/db/src/repositories/outcome-labels.ts:156` | Fix         | `followUpCommitOrPr` and `confidence` widened to `["string","null"]` in the PATCH schema (the two §4.3 marks optional). The five required fields stay non-nullable by design. Interface comment rewritten to state which is which. | Fixed     |
| 4   | Low      | local `outcome` shadows the domain term         | `apps/ingest/src/routes/outcome-labels.ts:148`       | Won't fix   | Renamed to `created` anyway as a side effect of the #2 fix — the surrounding block was rewritten.                                                                                                                                  | Fixed     |
| 5   | Low      | label export has no row cap                     | `apps/ingest/src/routes/outcome-labels.ts:372`       | Won't fix   | Unchanged. Reasoning documented in the route comment; revisit only if the one-label-per-session rule loosens.                                                                                                                      | No change |
| 6   | Low      | `safeScopeKey` duplicated from `exports.ts`     | `apps/ingest/src/routes/outcome-labels.ts:74`        | Won't fix   | Unchanged. Consistent with the repo's existing per-file-helper precedent.                                                                                                                                                         | No change |

**One further stale comment was found and fixed while applying the above**, and it is worth
recording because it is the same defect class as finding 3: `LabelFieldValues`' header still said
the required-when-`labeled` shape "lives in `CreateOutcomeLabelInput`'s discriminated union and in
the route's JSON schema". After the fix it lives in `assertLabelShape`, and neither of those two
layers can see a merged PATCH — which is exactly why they were never the enforcement. Corrected.

**Six regression tests added** (4 repository, 2 HTTP), each pinning a direction that was measured
broken: skip-clears-and-keeps-history, upgrade-without-judgement-refused, the positive control that
a *complete* upgrade still works (or the guard would have broken the feature it protects), required
vs optional null-clearing at both layers, and the HTTP 400 shape.

**Second review pass over the fixed code found no new defects.** Suite grew 27 → 33 label tests;
1352 → 1358 repo-wide.

