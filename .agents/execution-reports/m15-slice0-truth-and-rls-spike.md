# Execution Report — M15 Slice 15.0 (Truth fixes + RLS spike write-up)

## Meta Information

- **Plan file:** `.agents/plans/m15-slice0-truth-and-rls-spike.md`
- **Milestone:** M15 — Multi-user & Access Control (promoted 2026-07-25). **This slice gates 15.3.**
- **Shipped surfaces:** documentation + research only. **Zero production code, zero schema, zero
  dependency.** The slice's deliverable is `docs/research/m15-rls-spike.md` (which decides the
  transaction-wrapping pattern 15.3 implements) plus three truth corrections.
- **Files added (3):**
  - `docs/research/m15-rls-spike.md` — the RLS spike write-up: headline superuser/`BYPASSRLS`
    finding, Findings 1–4 with verbatim output, the decided `withOrg` pattern, five numbered inputs
    for 15.3, and an explicit "what this does NOT establish" section
  - `.agents/plans/m15-multi-user-access-control.md` — the milestone definition (was untracked)
  - `.agents/plans/m15-slice0-truth-and-rls-spike.md` — this slice's plan (was untracked)
- **Files modified (3):**
  - `docs/PRD.md` — §25 V2-roadmap framing corrected (the "product-surface build rather than a data
    migration" claim); §25 item 15 marked **PROMOTED** with the settled decisions and a link to the
    milestone plan
  - `SUMMARY.md` — the same correction in §0 and §3; M15 flipped to **IN PROGRESS** with its
    15.0–15.10 slice list; §6 "NEXT" replaced with the M15 entry carrying **15.0** ✅
  - `docs/CONTEXT.md` — "V2 Scope" refreshed (was stale since before the 2026-07-21 V2 commitment)

## Validation Results

- **Syntax & Formatting:** ✓ `npm run format` then `npm run format:check` → "All matched files use
  Prettier code style!". **Note:** the first `--write` pass left `SUMMARY.md` still failing
  `--check`; a second pass reached the fixpoint (nested-list reflow). Worth knowing — a single
  `format` run is not always sufficient, so `format:check` must actually be run, not assumed.
- **Linting:** ✓ `npm run lint` (eslint .) exit 0.
- **Type Checking:** ✓ root `tsc -b` 0 errors (via `repo-health`). No source changed, so this is a
  no-regression check rather than a meaningful assertion for this slice.
- **Unit Tests:** ✓ full `vitest run` green via `repo-health`. **No tests were added** — this slice
  ships prose, and asserting on prose would be theatre.
- **Integration Tests:** **intentionally not run** (`--require-db` not used). No DB-backed behavior
  changed; the slice touches neither `@420ai/db` nor `apps/ingest`. Per `CLAUDE.md`, `--require-db` is
  a milestone-sign-off gate and a per-slice gate only for slices touching those workspaces. 15.3 is
  where the DB assertions land.
- **Gate:** ✓ `npm run repo-health` PASS — including `check-summary`, which now enforces this slice
  (`m15-slice0-*.md` → `15.0` must carry an adjacent ✅ in SUMMARY).
- **Manual (Level 4):** ✓ Finding 1 re-verified live against `420ai-archive`
  (`rolname=420ai, rolsuper=t, rolbypassrls=t`). ✓ No spike residue: `rls_spike_app` role count `0`,
  `rls_spike` schema count `0`, no stray files at repo root.

## What Went Well

- **The spike was already run, and re-verifying it was one command.** The plan embedded verbatim
  output rather than descriptions, so the write-up was transcription plus framing — and the one
  check that mattered (`rolsuper`/`rolbypassrls`) was cheap enough to re-run rather than trust.
- **The milestone plan and the spike doc were already consistent.** D-M15-3 in
  `m15-multi-user-access-control.md` had already been corrected by the spike (it explicitly notes
  "corrected 2026-07-25 by the 15.0 spike, which disproved the original wording of this bullet"), so
  Task 2's stop-and-report condition never triggered and no reconciliation was needed.
- **The `check-summary` ✅-adjacency rule was handled by construction, not by luck.** Both `**15.0**`
  occurrences were written with the ✅ immediately adjacent, and adjacency was re-checked *after*
  Prettier reflowed the file — which is exactly the ordering the plan called out.

## Challenges Encountered

- **`npm run format` was not idempotent in one pass.** After the first `--write`, `format:check`
  still flagged `SUMMARY.md`; a second run fixed it. Had the report followed the plan's literal
  `format && format:check` chain and stopped at the first green-looking output, CI would have caught
  it instead. This is a mild sharpening of the known "CI lints markdown, local repo-health doesn't"
  gotcha: running `format` is necessary but running `format:check` afterwards is what proves it.
- **Deciding how much of the glossary to touch.** `docs/CONTEXT.md` is the naming source of truth,
  so introducing **Organization** / **Membership** / **Role** entries here would fix the canonical
  names for 15.1's schema. Resolved per the plan's gotcha: the V2 Scope paragraph names
  **Organization** as the tenancy boundary (consistent with D-M15-1) and explicitly defers the
  glossary *entries* to 15.1 — no near-miss synonym ("Team", "Tenant") was introduced.

## Divergences from Plan

- **The slice's own plan file was staged too.** Task 2 named only
  `m15-multi-user-access-control.md`, but `m15-slice0-truth-and-rls-spike.md` was equally untracked
  and every prior slice commits its plan alongside its work. Both were staged.
- **`grep -c "not a data migration" SUMMARY.md` returns 2, not 0.** Both matches are inside the
  explicitly-marked "Corrected 2026-07-25 (slice 15.0)" superseded notes, which the acceptance
  criterion permits ("0 outside a superseded note"). This is the M13.1/M14.1 truth-slice precedent
  working as intended: the false sentence is quoted so a reader who remembers it can see what
  replaced it, rather than being silently deleted.
- **PR number written before the PR existed.** SUMMARY's 15.0 entry cites PR #60, derived from the
  latest existing PR being #59. If the actual number differs, SUMMARY needs a one-line fix.

## Skipped Items

- **Integration tests / `--require-db`** — deliberately, per the plan's Level 3 note and `CLAUDE.md`'s
  scoping of that gate. Justification above.
- **New unit tests** — none applicable. `scripts/check-summary.test.ts` already covers the checker,
  and the plan explicitly says not to extend it.
- **Re-running spike Findings 2–4** — only Finding 1 was re-verified (it is read-only and one
  command). Findings 2–4 require re-creating the `rls_spike` role and schema, i.e. re-introducing
  exactly the residue the slice asserts is gone. The verbatim output is preserved in the plan and the
  research doc; re-deriving it was judged worse than trusting it, given Finding 1 — the load-bearing
  one — was confirmed.

## Recommendations

- **15.3 must not treat `repo-health --require-db` as proof of RLS.** The gate gets stricter every
  milestone and it is easy to read green as "enforced". It proves int tests *ran*; it cannot prove
  they ran as a **non-bypassing role**. The role-identity assertion (input 4 in the research doc) is
  the missing half, and it should land in the *same* slice as the first policy, not after.
- **Add `format:check` to the pre-commit hook, or at least to `repo-health`.** This is the third
  recorded instance of the CI-only markdown format gate being a live failure mode. It is pure and
  fast; the only reason it is not in the local gate is history.
- **15.1 should own the CONTEXT.md glossary entries for Organization / Membership / Role**, in the
  same commit that names them in schema — that is the convention `CLAUDE.md` states (code is named
  after glossary terms), and splitting the two invites a divergence.
