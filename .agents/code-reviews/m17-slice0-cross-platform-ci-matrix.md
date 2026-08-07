# Code Review — m17-slice0-cross-platform-ci-matrix

Reviewed: 2026-08-07. Scope: the slice diff vs `main` (4 new files + 2 plan-doc edits; **zero
files under `apps/*/src` or `packages/*/src`**, per the slice's own acceptance criterion).

**Stats:**

- Files Modified: 1 (`.agents/plans/m17-cross-platform-collectors.md`, planning-phase edit)
- Files Added: 5 (`cross-platform.yml`, `sidecar-stub.mjs`, `sidecar-stub.test.ts`,
  `m17-slice2-spike-protocol.md`, the slice plan itself)
- Files Deleted: 0
- New lines: 971
- Deleted lines: 4

## Verification actually performed (not assumed)

- `cargo check --locked` precondition: `git ls-files apps/desktop/src-tauri/Cargo.lock` → tracked. ✓
- Entrypoint guard, both directions: direct `node scripts/sidecar-stub.mjs` ran `main()` (rustc
  invoked, no-clobber path exercised against the real 92,779,008-byte sidecar); the vitest import
  ran 6/6 tests with no rustc call and no file write. ✓
- `npm run typecheck -- --force` arg passthrough: args after `--` reach the script verbatim
  (`tsc -b --force`). ✓
- Lockfile carries win32/darwin/linux prebuilts (S6 + grep). ✓
- Prettier, ESLint, root `tsc -b`, full `repo-health` (1714 tests incl. DB layer): all PASS. ✓
- The workflow itself: syntactically accepted by GitHub — run 31178034371 dispatched five lanes.

## Findings

```
severity: low
file: .github/workflows/cross-platform.yml
line: 34
issue: no timeout-minutes on the matrix job (GitHub default is 360)
detail: A hung lane (e.g. a wedged cargo network fetch) idles for 6 hours before failing. Free on
  a public repo, but it delays the signal the slice exists to produce, and concurrency-cancel only
  helps when a NEW push arrives.
suggestion: add `timeout-minutes: 45` under the job — comfortably above a cold cargo check, far
  below the default.
```

```
severity: low
file: scripts/sidecar-stub.mjs
line: 96
issue: entrypoint guard compares resolve(argv[1]) to fileURLToPath(import.meta.url) by exact string
detail: A symlinked or differently-cased invocation path would make the comparison false and main()
  silently not run. Consequence in CI is loud (cargo check fails on the missing sidecar), so this
  cannot produce a false green — but the silent-skip shape is worth knowing about.
suggestion: acceptable as-is for the two real call sites (CI step, direct local run); if it ever
  bites, switch to comparing `realpathSync` of both sides.
```

No critical, high or medium issues. The two lows are hygiene, not defects; neither can corrupt
state or produce a false-green lane.

## Standards check

- Script mirrors `build-sea.mjs` conventions (shebang, why-comment, `ok`/`die`, non-zero exit). ✓
- Test is co-located, plain vitest, covered by the existing `scripts/**/*.test.ts` include —
  no vitest config edit. ✓
- Workflow copies `repo-health.yml`'s `concurrency` + least-privilege `permissions` pattern. ✓
- No library-file logging-rule concerns: `sidecar-stub.mjs` is an entrypoint script, where
  console + `process.exit` are the convention. ✓
- The 680-skipped DB layer is named in the workflow header comment, the PR body and the plan —
  `skipped ≠ passed` is stated, not implied away. ✓
