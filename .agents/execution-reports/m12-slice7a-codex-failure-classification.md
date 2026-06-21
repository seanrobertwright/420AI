# Execution Report — M12 Slice 12.7a: Codex CLI tool-call failure classification

## Meta Information

- **Plan file:** `.agents/plans/m12-slice7a-codex-failure-classification.md`
- **Files added:** none
- **Files modified:**
  - `apps/collector/src/connectors/codex-cli.ts` (+94 / −16)
  - `apps/collector/src/connectors/codex-cli.test.ts` (+93 / −5)
  - `apps/collector/src/fixtures/sample-codex-rollout.jsonl` (+6 / −0)
- **Lines changed:** +193 / −21 (code files only)
- **Planning artifacts also touched (not code):** `SUMMARY.md` (§3 M12.7 sub-slicing note),
  `.agents/plans/m12-slice7{a..d}-*.md`, `.agents/code-reviews/…`, this report.

## Validation Results

- **Syntax & Linting:** ✓ `prettier --check` clean (after one `--write` to wrap long test assertions).
- **Type Checking:** ✓ `npm run typecheck` (root `tsc -b`, 4 backend workspaces) exit 0; dashboard +
  desktop `tsc --noEmit` lanes 0 errors inside `repo-health`.
- **Unit Tests:** ✓ `npx vitest run codex-cli.test.ts` → 20 passed (was 11; +9 new). Full suite via
  `repo-health`: **540 passed / 0 failed** across 78 files.
- **Integration Tests:** N/A — this slice touches neither `@420ai/db` nor `apps/ingest`, so no
  `*.int.test.ts` exercises Codex classification. `--require-db` was therefore **not required** for
  sign-off (stated explicitly per plan §Level 3). The DB-backed layer is unaffected: `event_type` is
  stored as free text and `payload` is encrypted, so emitting `tool.call.failed` needs no schema/server
  change.

## What Went Well

- **The plan was exceptionally precise** (self-rated 9.5/10) and held up: every cited symbol and line
  number matched the real files (`PARSER_VERSION` at :22, the output branch at :232, `EventType` carrying
  `tool.call.failed` at `events.ts:33`, `NormalizedEvent.payload?: unknown` at :74). No re-derivation of
  facts was needed.
- **The blessed mirror pattern made the emit trivial** — branching `failed`/`completed` on a detected
  signal and emitting on the terminal record is exactly what `claude-code.ts:205-213` already does, so the
  shape was a known-good precedent, not an invention.
- **Deterministic expected counts** (started 3 / completed 2 / failed 4 / file.modified 1) were stated in
  the plan and matched first-run after the fixture edit — no count-chasing.
- **Tolerant-parsing discipline** dropped straight in: `JSON.parse` wrapped in try/catch with a non-object
  guard, non-string → `{ failed: false }`. The full suite went green on the first `repo-health` run.

## Challenges Encountered

- **Prettier print-width on test assertions** — the `failed.find((e) => (e.payload as Record<…>)?.…)`
  matchers exceeded the line limit and tripped `prettier --check`. Resolved with a single `--write`; no
  logic impact. Minor, expected.
- **Distinguishing the two `state-mismatch` failure sources in the new test** — both the `call-5`
  apply_patch text output and the defensive `patch_apply_end success:false` produce
  `failureClass: "state-mismatch"`, but only the former carries a `call_id`. Asserted them separately
  (the defensive one via `failureClass === "state-mismatch" && !call_id`) so the test pins both paths
  rather than conflating them.

## Divergences from Plan

**Exported `classifyCodexOutput` (the plan left this optional)**

- **Planned:** "If you `export` `classifyCodexOutput` (recommended for direct testing)…" — presented as
  optional.
- **Actual:** Exported it (and `CodexFailureClass`) and added a 9-case direct unit suite covering every
  spike-table row plus the metadata-less-envelope and non-string edges.
- **Reason:** Direct classifier coverage is cheaper and more legible than asserting the classification only
  through full-parse event counts, and the connector already exports parser internals — consistent.
- **Type:** Better approach found (within the plan's stated recommendation).

No other divergences. Blast radius, file set, `PARSER_VERSION` bump, `knownGaps` rewrite, and fixture
records all matched the plan exactly.

## Skipped Items

- **Level 4 manual re-parse of a real on-disk rollout** (`~/.codex/sessions/.../rollout-*.jsonl`) was not
  run. It is marked "optional, high-value" in the plan. The classifier is exercised against the verified
  *real-shaped* envelope/bare-string forms in the fixture (modeled byte-for-byte on the 112-rollout spike),
  and the spike evidence is folded into the plan, so the fixture is a faithful proxy. Recommend a one-off
  manual eyeball post-merge if a real failing session is handy, but it is not a sign-off blocker.

## Recommendations

- **Plan command:** This plan is a model for thin connector slices — verbatim spike-table with expected
  classification + deterministic event-count deltas removed all ambiguity. Keep that format.
- **Execute command:** No change. The "read the real file, confirm the cited lines, then edit" loop caught
  nothing wrong here precisely because the plan had already done it — which is the point.
- **CLAUDE.md addition (candidate):** A one-liner under the connector conventions — *"a parser change that
  alters an event's `eventType` (e.g. completed→failed) changes its fingerprint; bump `PARSER_VERSION` and
  note the re-parse stale-event interaction; payload-only additions are fingerprint-safe."* This is now the
  second connector (Claude, then Codex) to live with the reclassification-fingerprint property; codifying
  it would save the next connector author the re-derivation.
- **Follow-up tracking:** When a second connector needs failure classes, promote `CodexFailureClass` to
  `@420ai/shared` (PRD §14 is cross-connector). 12.5b must own stale-typed-event GC on re-parse. Both are
  already flagged in the plan NOTES.
