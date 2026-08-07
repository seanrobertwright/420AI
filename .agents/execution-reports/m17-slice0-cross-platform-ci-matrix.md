# Execution Report — M17 slice 17.0: Cross-platform CI matrix + spike protocol

**Date:** 2026-08-07 · **Branch:** `m17-slice0-cross-platform-ci-matrix` · **PR:** #82

## Meta Information

- **Plan file:** `.agents/plans/m17-slice0-cross-platform-ci-matrix.md`
- **Files added (5):**
  - `.github/workflows/cross-platform.yml` (90) — five-lane matrix: `ubuntu-latest`,
    `ubuntu-24.04-arm`, `macos-15-intel`, `macos-latest`, `windows-latest`; each runs
    `npm ci` → root `tsc -b --force` → `npx vitest run` → `cargo check --locked`; `fail-fast: false`
  - `scripts/sidecar-stub.mjs` (99) — writes the 0-byte triple-suffixed sidecar
    `tauri_build::build()`'s externalBin existence check requires; pure `sidecarFileName()` export;
    never clobbers a real (non-empty) sidecar; entrypoint-guarded so the test import is side-effect-free
  - `scripts/sidecar-stub.test.ts` (50) — 6 unit tests covering all five lane triples + the
    only-win32-gets-a-suffix property
  - `.agents/research/m17-slice2-spike-protocol.md` (153) — 17.2's real-hardware measurement
    protocol (three targets, INC-2026-01 caveat, macOS Gatekeeper section, D-M17-5 discipline)
  - `apps/desktop/src-tauri/icons/{32x32,128x128,128x128@2x}.png`, `icon.icns`, `icon.ico`
    (~2.1 MB, binary) — see Finding 1
- **Files modified (3):** `apps/desktop/.gitignore` (icons dir ignore → `dir/*` + five negations),
  `.agents/plans/m17-cross-platform-collectors.md` (ground-truth row 9 retired; "Measured by 17.0"
  table added), `SUMMARY.md` (17.0 → ✅, same commit as this report)
- **Product code changed:** **NONE** — zero files under `apps/*/src` or `packages/*/src`, per the
  slice's acceptance criterion.

## The deliverable — the measured table (run 31178775260)

| Lane                        | typecheck | `npx vitest run`              | `cargo check --locked` |
| --------------------------- | --------- | ----------------------------- | ---------------------- |
| `ubuntu-latest` (linux-x64) | ✅ 10 s   | ✅ 1034 passed \| 680 skipped | ✅ 81 s                |
| `ubuntu-24.04-arm`          | ✅ 10 s   | ✅ 1034 passed \| 680 skipped | ✅ 76 s                |
| `macos-15-intel`            | ✅ 16 s   | ✅ 1034 passed \| 680 skipped | ✅ 209 s               |
| `macos-latest` (arm64)      | ✅ 13 s   | ✅ 1034 passed \| 680 skipped | ✅ 120 s               |
| `windows-latest`            | ✅ 12 s   | ✅ 1034 passed \| 680 skipped | ✅ 177 s               |

**The 680 skipped per lane are the Postgres-gated `*.int.test.ts` layer (61 files) — `skipped ≠
passed`.** These lanes have no DB (GitHub service containers are Linux-runner-only); that layer is
proven only by `repo-health.yml` on `ubuntu-latest`. "All platforms green" without this caveat is a
misreport.

## Findings (the first run was all-red, and that was the instrument working)

1. **`apps/desktop/.gitignore` ignored `src-tauri/icons/` wholesale** ("generated locally by
   `cargo tauri icon`"), so no CI checkout had the five icons `tauri.conf.json` references —
   `tauri_build` hard-fails without them, and **all five lanes failed `cargo check` identically**
   (Windows in the winres step on `icon.ico`; Linux/macOS in `tauri::generate_context!` on
   `32x32.png`). The crate was unbuildable on every machine except the one that generated the
   icons, and nothing could know because CI had never built it. Fixed in-slice: this is CI
   infrastructure (assets + a `.gitignore`), not product code, and with it broken the matrix
   measured nothing platform-specific. Gitignore mechanics note: files under an ignored
   *directory* cannot be re-included, hence the `icons/*` + five-negation form.
2. **The anticipated `keyring` red cell did NOT materialize.** `keyring v3.6.3` compiles clean on
   all five lanes, so ground-truth row 3 is a **runtime-only** concern (the off-Windows mock
   backend persists nothing). 17.5 still owns it; no compile barrier exists.
3. **Spike S2's prediction was exact:** 1028 + 6 new = 1034 passed | 680 skipped on every lane.

## Validation Results

- **Prettier / ESLint:** ✓ both clean (including the new YAML + markdown)
- **Type checking:** ✓ root `tsc -b` exit 0; dashboard + desktop lanes 0 errors (pre-commit hook)
- **Unit tests:** ✓ `scripts/sidecar-stub.test.ts` 6/6
- **Full gate:** ✓ `npm run repo-health` PASS — 171 files / **1714 tests, 0 failures**, integration
  layer RAN (local `.env` supplies the DB; this slice touches neither `@420ai/db` nor `apps/ingest`,
  so `--require-db` was belt-and-braces, satisfied by the local run)
- **The real thing:** ✓ run 31178775260 read lane-by-lane, table above; `fail-fast: false` verified
  the hard way — the first run produced **five** red cells, not one
- **No-clobber:** ✓ stub helper run locally against the real 92,779,008-byte sidecar — left intact

## What Went Well

- The plan's spike-first discipline paid for itself twice: S3b's "existence-only check" made the
  stub design safe, and S2's skip-count prediction matched to the test.
- The first run being red on all five lanes was exactly the failure mode the slice exists to
  surface — a latent "works only on the authoring machine" defect, found by a machine on a PR
  instead of by a user on hardware nobody owns.

## What Was Unexpected

- The icons, not `keyring`, were the wall. The plan's anticipated red cell (keyring feature gating)
  compiled clean everywhere, while an unanticipated one (a two-year-old `.gitignore` line) took out
  the entire Rust matrix. Inference about *where* a platform break lives is unreliable even when
  inference *that* one exists is right — which is the milestone's whole thesis.

## Recommendation

Promote `cross-platform` to a required status check once it has been green on ~3 consecutive PRs
(it has 1 as of this report). Branch protection is the maintainer's call (deliberately out of
slice scope).
