# Execution Report — M12 Slice 12.7b: Per-connector permission scopes (§8.1)

## Meta Information

- **Plan file:** `.agents/plans/m12-slice7b-connector-permission-scopes.md`
- **Branch:** `m12-slice7b-connector-permission-scopes` (based on `main`; independent of sibling 12.7a)
- **Files added (2):**
  - `apps/collector/src/connectors/connector-approvals.ts` (160 lines)
  - `apps/collector/src/connectors/connector-approvals.test.ts` (139 lines)
- **Files modified (14):**
  - `packages/shared/src/control-protocol.ts` — `ConnectorInfo.requiredPermissions`/`approval`,
    `connectors.approve` command, version bump `m11-control-v2 → m12-control-v3`
  - `packages/shared/src/control-protocol.test.ts` — version pin + new fields/command
  - `apps/collector/src/connectors/connector.ts` — `ConnectorFidelity.requiredPermissions` (required)
  - `apps/collector/src/connectors/claude-code.ts`, `codex-cli.ts`, `gemini-cli.ts` — scope statements
  - `apps/collector/src/connectors/custom-connector.ts` — derive scope from user globs
  - `apps/collector/src/serve.ts` — seams, seed-at-boot, `mapConnectorInfo`/`emitConnectors`,
    approval filter in `startEngine`, `connectors.approve` case
  - `apps/collector/src/serve.test.ts` — updated mapping assertion, default in-memory approval seam,
    4 new approval tests
  - `apps/collector/src/discovery/discover-engine.test.ts`, `git-capture.test.ts` — fixture fidelity
    objects updated for the new required field
  - `apps/desktop/src/lib/bridge.ts` — `approveConnector`
  - `apps/desktop/src/components/Connectors.tsx` — render permissions + Approve affordance
  - `README.md` — trivial prettier-format only (pre-existing non-conformance; see Divergences)
- **Lines changed:** +342 / −31 in tracked files, plus +299 in the two new files.

## Validation Results

- **Syntax & Linting:** ✓ `npm run lint` exit 0; `npm run format:check` clean (whole tree).
- **Type Checking:** ✓ `npm run typecheck` (root `tsc -b`) 0 errors; `npm run typecheck:desktop` 0 errors.
- **Unit Tests:** ✓ full `vitest run` — **553 passed / 0 failed** (79 files). New `connector-approvals.test.ts`
  (8 cases) + 4 new serve approval cases + updated control-protocol cases all green.
- **Integration Tests:** Not applicable — this slice touches **no** `@420ai/db` / `apps/ingest` code and
  adds **no** `*.int.test.ts`. Per the plan, `--require-db` was **not** run; no DB-backed layer exists for
  this slice to exercise. (Stated explicitly so this is not mistaken for a skipped-but-green DB layer.)
- **Full gate:** ✓ `npm run repo-health` PASS (NUL scan, stray-artifact scan, root typecheck, dashboard +
  desktop lanes, full vitest).
- **Manual Level-4:** ✓ Drove the sidecar over stdin. Fresh boot auto-seeds every connector
  `approval:"approved"` with `requiredPermissions` populated. Tampering one fingerprint →
  `needs-approval`; `connectors.approve` → back to `approved`. (Approvals file restored afterward.)

## What Went Well

- **Pattern-mirroring paid off.** `connector-approvals.ts` is a near-1:1 structural copy of
  `connector-config.ts` (version stamp, tolerant load, `0o600` write, pure filter), and its test mirrors
  `connector-config.test.ts`. The serve seams dropped in beside the existing config seams with no surprises.
- **The "required field" forcing function worked as intended.** Making `requiredPermissions` non-optional on
  `ConnectorFidelity` turned "did I update every connector?" into a compile error — `tsc -b` enumerated the
  exact fixtures that still needed it (three test stubs across two discovery test files).
- **No Rust touched.** The plan's spike was right: the relay is opaque, so a new command + a new
  `ConnectorInfo` field shipped TS-only.
- **Default-on stayed intact** end to end — verified both by unit tests and the live walkthrough (fresh
  machine seeds approved and keeps capturing; only a later drift gates).

## Challenges Encountered

- **Two self-inflicted test bugs, both caught immediately by the suite:**
  1. My edit to the existing control-protocol test accidentally **dropped `custom: true`** from the sample
     `customInfo` while inserting the two new fields — the existing `custom` assertion failed and pointed
     right at it. Restored.
  2. A **listener race** in the new `connectors.approve` serve test: I waited for the `ack`, then attached a
     listener for the trailing `connectors` event — but both fire synchronously from one command, so the
     `connectors` event was already gone (`waitFor` timed out). Fixed by waiting for the `connectors` event
     directly and asserting the `ack` from the captured `events` array.
- **`replace_all` indentation mismatch.** Two fidelity fixtures in `discover-engine.test.ts` had different
  indentation depths; a single `replace_all` only matched one, so `tsc` flagged the other on the next run.
  Fixed with an indentation-specific edit. (Lesson: `replace_all` is only safe when the block is byte-identical
  everywhere, including leading whitespace.)

## Divergences from Plan

**1. Test harness: default in-memory approval seam in `makeHarness`**

- **Planned:** Pass the two new approval seams "the same way" as the config seams (per-test).
- **Actual:** Defaulted `loadConnectorApprovals`/`saveConnectorApprovals` to an in-memory store inside
  `makeHarness`, with per-test overrides for the drift tests.
- **Reason:** Seed-at-boot runs on **every** `runServe`, including the ~12 pre-existing serve tests that don't
  inject approval seams. Without an in-memory default, those tests would read/write the **real**
  `~/.420ai/connector-approvals.json` during the run. The default seam keeps the suite hermetic.
- **Type:** Better approach found (preserves test isolation).

**2. `README.md` prettier-format included**

- **Planned:** Nothing about README (out of slice scope).
- **Actual:** Ran `prettier --write README.md` (a 6-line formatting touch) and included it.
- **Reason:** A prior direct-to-`main` commit ("Add licensing and create new readme from new readme skill")
  landed a non-prettier-conformant `README.md` **bypassing PR CI**. CI's `format:check` runs over the whole
  repo (`**/*.{...,md}`), so my PR would be the first to surface it and would fail "Check formatting". Formatting
  it (the enforced repo style) is the minimal change to get CI green.
- **Type:** Plan assumption wrong (pre-existing repo state outside the slice).

**3. Branch base**

- **Planned/expected:** session started on `m12-slice7-connector-hardening`.
- **Actual:** The working tree had been moved to `main` (a prior session checked out main, pulled, committed
  the readme). I created a fresh `m12-slice7b-connector-permission-scopes` branch off `main` and carried the
  uncommitted changes onto it — matching the plan's "12.7b ships independently of 12.7a" guidance.
- **Type:** Other (environment drift; resolved without losing work).

## Skipped Items

- **`npm run repo-health -- --require-db`** — intentionally skipped (no DB/ingest code, no int tests). Stated
  in the plan as not required for this slice.
- **`npm run build:desktop`** (full SEA + `cargo tauri build`) — optional smoke per the plan; no Rust changed,
  so `typecheck:desktop` is the required webview gate (passed).

## Recommendations

- **CLAUDE.md addition:** note that `format:check` lints the **whole repo** over `*.md`, so a non-conformant
  doc committed directly to `main` (bypassing PR CI) becomes the *next* PR's failure. Consider a pre-commit
  prettier pass on staged `.md`, or running `prettier --write` in the readme/doc-generating skills. (A memory
  already captures the "format markdown before push" gotcha — this is a concrete recurrence.)
- **Execute-command improvement:** when a plan makes a contract field **required**, proactively grep for every
  literal of that interface (incl. test fixtures) *before* the first typecheck, rather than discovering them
  one `tsc` run at a time.
- **Plan strength worth keeping:** the plan's explicit "default-on wins for initial scope; approval gates only
  a CHANGE" conflict-resolution paragraph removed all ambiguity — the single most useful part of the plan.
