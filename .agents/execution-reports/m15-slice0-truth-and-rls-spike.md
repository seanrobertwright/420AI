# Execution Report — M15 Slice 15.0 (Truth fixes + RLS spike write-up)

## Meta Information

- **Plan file:** `.agents/plans/m15-slice0-truth-and-rls-spike.md`
- **Milestone:** M15 — Multi-user & Access Control (promoted 2026-07-25). **This slice gates 15.3.**
- **Shipped surfaces:** documentation + research only. **Zero production code, zero schema, zero
  dependency.** The deliverable is `docs/research/m15-rls-spike.md`, which decides the
  transaction-wrapping pattern 15.3 implements, plus three truth corrections.
- **Files added (5):**
  - `docs/research/m15-rls-spike.md` — the RLS spike write-up
  - `.agents/plans/m15-multi-user-access-control.md` — the milestone definition (was untracked)
  - `.agents/plans/m15-slice0-truth-and-rls-spike.md` — this slice's plan (was untracked)
  - `.agents/code-reviews/m15-slice0-truth-and-rls-spike.md` — pre-PR review
  - `.agents/execution-reports/m15-slice0-truth-and-rls-spike.md` — this file
- **Files modified (3):**
  - `docs/PRD.md` — §25 V2-roadmap framing corrected; §25 item 15 marked **PROMOTED** with the
    settled decisions and a link to the milestone plan
  - `SUMMARY.md` — the same correction in §0 and §3; M15 flipped to **IN PROGRESS** with its
    15.0–15.10 slice list; §6 "NEXT" replaced with the M15 entry carrying **15.0** ✅; one
    pre-existing broken relative link repaired
  - `docs/CONTEXT.md` — "V2 Scope" refreshed (stale since before the 2026-07-21 V2 commitment)
- **Lines changed:** +1305 / −38 in `27c2aa5`, plus the code-review follow-up commit.

## Validation Results

- **Syntax & Linting:** ✓ `npm run lint` (eslint .) exit 0. ✓ `npm run format:check` → "All matched
  files use Prettier code style!"
- **Type Checking:** ✓ root `tsc -b` 0 errors; dashboard and desktop `tsc --noEmit` lanes 0 errors.
  No source changed, so this is a no-regression check — **except** for the one place it was made to
  do real work: the `withOrg` snippet was written into `packages/db/src/` and typechecked before
  being deleted (see Divergences).
- **Unit Tests:** ✓ 827 passed / 0 failed (109 files) via `npm run repo-health`. **No tests added** —
  this slice ships prose, and asserting on prose would be theatre.
- **Integration Tests:** **intentionally not run** (`--require-db` not used). No DB-backed behavior
  changed; the slice touches neither `@420ai/db` nor `apps/ingest`. Per `CLAUDE.md` that gate is for
  milestone sign-off and for slices touching those workspaces. 15.3 is where the DB assertions land.
- **Gate:** ✓ `npm run repo-health` PASS, including `check-summary`, which now enforces this slice
  (`m15-slice0-*.md` → `15.0` must carry an adjacent ✅ in SUMMARY) and reported
  "1 in-progress slice(s) marked done".
- **Manual (Level 4):** ✓ Finding 1 re-verified live against `420ai-archive`
  (`rolname=420ai, rolsuper=t, rolbypassrls=t`). ✓ No spike residue: `rls_spike_app` role `0`,
  `rls_spike` schema `0`, no stray files at repo root. ✓ Relative-link check across all touched
  markdown: 0 broken.

## What Went Well

- **The spike was already run, and the one finding that mattered was re-verifiable in one command.**
  The plan embedded verbatim output rather than descriptions, so the write-up was transcription plus
  framing — and the load-bearing claim (`rolsuper`/`rolbypassrls`) was cheap enough to re-run rather
  than trust.
- **The milestone plan and the spike doc were already consistent.** D-M15-3 had already been
  corrected by the spike (it explicitly notes it "disproved the original wording of this bullet"),
  so Task 2's stop-and-report condition never triggered.
- **The `check-summary` ✅-adjacency rule was satisfied by construction, not luck.** Both `**15.0**`
  occurrences were written with the ✅ immediately adjacent, and adjacency was re-checked *after*
  Prettier reflowed the file — the ordering the plan called out.
- **The code review found real defects in a doc-only slice.** Worth recording, because the tempting
  assumption is that a slice with no source cannot be reviewed. It could, and it had two genuine
  problems — one of them in the exact snippet the slice exists to hand to 15.3.

## Challenges Encountered

- **`npm run format` was not idempotent in one pass.** After the first `--write`, `format:check`
  still flagged `SUMMARY.md`; a second pass reached the fixpoint (nested-list reflow). Following the
  plan's `format && format:check` chain and stopping at the first green-looking output would have
  pushed the failure to CI. Sharpens the known "CI lints markdown, local repo-health doesn't"
  gotcha: running `format` is necessary, running `format:check` afterwards is what proves it.
- **Deciding how much of the glossary to touch.** `docs/CONTEXT.md` is the naming source of truth,
  so adding **Organization** / **Membership** / **Role** entries here would fix the canonical names
  for 15.1's schema. Resolved per the plan's gotcha: the V2 Scope paragraph names **Organization** as
  the tenancy boundary (consistent with D-M15-1) and explicitly defers the glossary *entries* to
  15.1. No near-miss synonym ("Team", "Tenant") was introduced.
- **Verifying a snippet in a document.** The plan's spike-snippet-fidelity rule says a snippet
  contradicting its own spike is worse than no snippet — but a markdown code block is never
  compiled, so nothing in the gate can catch a wrong import. It took a deliberate throwaway
  typecheck to find one.

## Divergences from Plan

**Typechecked the `withOrg` snippet by temporarily materializing it as source**

- Planned: transcribe the snippet from SPIKE RESULTS into the research doc.
- Actual: wrote it verbatim into `packages/db/src/__scratch-withorg.ts`, ran root `tsc -b`, then
  deleted the file and verified the tree was clean.
- Reason: the snippet is the slice's handoff to 15.3, and markdown code blocks are invisible to
  every gate in the repo. The check paid for itself immediately — it proved `tx.execute(sql\`…\`)`
  composes with the real `Db`/`Tx` types (0 errors) **and** exposed that the doc's accompanying
  prose misattributed `sql` to `packages/db/src/client.ts`, which does not export it.
- Type: Better approach found.

**The slice's own plan file was staged too**

- Planned: Task 2 named only `.agents/plans/m15-multi-user-access-control.md`.
- Actual: `m15-slice0-truth-and-rls-spike.md` was staged as well.
- Reason: it was equally untracked, and every prior slice commits its plan alongside its work.
- Type: Other (plan omission).

**`grep -c "not a data migration" SUMMARY.md` returns 2, not 0**

- Planned: acceptance criterion "→ 0 outside a superseded note".
- Actual: 2 matches, both inside explicitly-marked "Corrected 2026-07-25 (slice 15.0)" blocks.
- Reason: the criterion permits this, and it is the M13.1/M14.1 truth-slice precedent working as
  designed — the false sentence is quoted so a reader who remembers it sees what replaced it,
  rather than being silently deleted. Recorded because the raw grep looks like a failure.
- Type: Other (expected-by-design, non-obvious from the command alone).

**Corrected the `db.transaction()` call-site count from 11 to 10 in the milestone plan**

- Planned: "do not rewrite the D-M15-* decisions."
- Actual: edited the D-M15-3 bullet to change the count and cite the command that derives it.
- Reason: the code review re-derived the count as **10** (8 repositories + 2 route handlers); a bare
  `grep "db.transaction("` returns 12 because it matches two prose comments in `client.ts`. Neither
  is 11. This is a measurement, not a decision — the decision (transaction wrapping is required)
  is untouched. Flagged rather than done silently because it edits a "do not re-litigate" file.
- Type: Plan assumption wrong.

**Repaired a pre-existing broken link in SUMMARY.md**

- Planned: not in scope.
- Actual: `SUMMARY.md:677`'s `../.agents/qa/m14-signoff/` → `./.agents/qa/m14-signoff/` (SUMMARY is
  at the repo root, so `../` escaped it).
- Reason: M14-era defect surfaced by the review's link check. A truth slice is where doc defects get
  swept, and the fix is three characters with no behavioral surface.
- Type: Other (opportunistic in-scope-by-category fix).

## Skipped Items

- **Integration tests / `--require-db`** — deliberately, per the plan's Level 3 note and `CLAUDE.md`'s
  scoping of that gate. Justification in Validation Results.
- **New unit tests** — none applicable. `scripts/check-summary.test.ts` already covers the checker,
  and the plan explicitly says not to extend it.
- **Re-running spike Findings 2–4** — only Finding 1 was re-verified (read-only, one command).
  Findings 2–4 require re-creating the `rls_spike` role and schema, i.e. re-introducing exactly the
  residue the slice asserts is gone. Verbatim output is preserved in the plan and the research doc;
  re-deriving it was judged worse than trusting it, given the load-bearing finding was confirmed.

## Recommendations

**CLAUDE.md additions**

- **Add `format:check` to `repo-health`.** This is now the third recorded instance of the CI-only
  markdown format gate being a live failure mode. It is pure and fast; the only reason it is not in
  the local gate is history. Note the two-pass behavior when adding it — `format` is the fix,
  `format:check` is the proof, and they are not interchangeable.
- **Record the two-role rule before 15.3 needs it** — the milestone plan already schedules the
  "Validation is a GATE" amendment for 15.3. Nothing to do now; noting it so it is not forgotten.

**Plan command improvements**

- **A plan that ships a code snippet should say how the snippet is verified.** This plan had a
  strong spike-snippet-fidelity rule ("re-run the spike if you change it") but no way to catch a
  snippet that was faithful to the spike and still wrong about the codebase around it. A one-line
  "materialize and typecheck any snippet a later slice will transcribe" instruction would have
  caught the `sql` misattribution at authoring time.

**Execute command improvements**

- **`grep`-based acceptance criteria need their expected exit stated.** Two criteria here
  (`grep -c "not a data migration"` → 0; `grep -n "product-surface build"` → no match) are satisfied
  by matches inside superseded notes, so the literal command "fails" while the criterion passes. The
  plan said so in prose, but the command is what gets run.

**For 15.3 specifically**

- **Do not treat `repo-health --require-db` as proof of RLS.** It proves int tests *ran*; it cannot
  prove they ran as a **non-bypassing role**. The role-identity assertion (input 4 in the research
  doc) should land in the *same* slice as the first policy, not after.
- **15.1 should own the CONTEXT.md glossary entries** for Organization / Membership / Role, in the
  same commit that names them in schema — `CLAUDE.md` says code is named after glossary terms, and
  splitting the two invites divergence.
