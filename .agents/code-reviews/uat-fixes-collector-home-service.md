# Code Review — UAT fixes + `--home` + WinSW service

Branch `uat-fixes`. Reviews the uncommitted working tree: the C-series collector fixes (C.6/C.8/C.11),
F.5 reprice, the D.3 dashboard session-secret fix, the G.4/G.5 Tauri sidecar-path fix, the new
`--home` flag, and the WinSW service files.

**Stats:**

- Files Modified: 17
- Files Added: 9 code/docs (+ 4 throwaway UAT artifacts — see INFO-2)
- Files Deleted: 0
- New lines: ~465 insertions
- Deleted lines: ~58

**Verification run during review:** `npm run typecheck` (tsc -b, exit 0); `npm run repo-health`
(620 tests, 0 skipped, PASS); `prettier --check` on all committed-relevant files (clean).

---

## Summary

The changes are high quality: each fix has a co-located regression test that fails without it, the
full gate is green, and the diffs are tight and well-commented. No correctness, security, or
performance defects found. Findings below are all **low / informational** — refinements and
commit-hygiene, not bugs.

---

## Findings

```
severity: low
file: apps/collector/src/sync/sync-worker.ts
line: 45-54 (syncOnce catch)
issue: A SIGINT-triggered fetch abort is treated as a generic network failure (markFailed).
detail: When the engine aborts mid-flight (the C.8 path), fetch rejects with an AbortError. syncOnce's
  catch does not special-case it, so it calls markFailed(item, attempts) — bumping each in-flight
  item's attempt count and applying exponential backoff (up to BACKOFF_CAP_MS=30s). On a CLEAN
  shutdown those items are not really "failed"; on the next start they needlessly wait out a backoff
  before retrying. Bounded and self-healing (delivery still happens, cap 30s), hence low.
suggestion: Detect the abort (deps.signal?.aborted, or err?.name === "AbortError"/"TimeoutError") and
  releaseInflight(ids) instead of markFailed — return to pending with no attempt bump, mirroring the
  401 path. Keeps next-start delivery immediate after a graceful stop.
```

```
severity: low
file: apps/collector/src/capture-engine.ts
line: 196-209 (drainBeforeExit call)
issue: Shutdown-drain worst case is ~2× SHUTDOWN_DRAIN_MS, not a hard 5s.
detail: Each drain syncOnce is bounded by timeoutMs=SHUTDOWN_DRAIN_MS (5s) AND the loop checks the
  absolute deadline (start+5s) BETWEEN calls. A call that begins at t=4.9s can still run its full 5s
  request timeout before the next deadline check stops the loop → up to ~10s. This still fixes the
  original UNBOUNDED hang (the only correctness goal), so it is informational, not a regression.
suggestion: If a hard bound matters, derive the per-call timeout from the remaining budget
  (max(0, deadline - now())) so call + loop share one 5s envelope. Optional.
```

```
severity: low
file: packages/db/src/reprice-cli.ts
line: 18 (`let outcome;`)
issue: `outcome` is declared without a type annotation.
detail: It relies on TS control-flow ("evolving any") — it compiles and is always assigned before use
  (the try assigns it; a throw propagates past the access). But the intent reads clearer with the type.
suggestion: `let outcome: RepriceOutcome;` (import the type from ./reprice-run.js). Style only.
```

```
severity: low
file: apps/collector/service/README.md + .gitignore
line: README "Notes" — "Don't commit WinSW-x64.exe / the renamed wrapper"
issue: The "don't commit the third-party exe" rule is documented but not enforced.
detail: Users drop 420ai-collector.exe (WinSW) and a copy of collector.exe into apps/collector/service/.
  Nothing stops `git add` from staging those ~90MB binaries. The artifact-scan in repo-health targets
  emitted *.js/*.d.ts/dist, not these.
suggestion: Add `apps/collector/service/*.exe` and `apps/collector/service/*.log` to .gitignore so the
  wrapper/binary/log files can't be committed by accident.
```

```
severity: info
file: (working tree) login.json, login-bad.json, uat-events.parquet, UAT.md
line: n/a (untracked)
issue: Throwaway UAT artifacts sit in the working tree.
detail: login.json/login-bad.json contain a test email + password ("Test-Password-123"); uat-events.parquet
  is binary; UAT.md is the tester's working checklist. All are untracked, so CI does not lint them and
  they won't commit unless explicitly added — but they're easy to `git add -A` by mistake. (login.json
  also explains the earlier prettier --check noise; UAT.md's `[✅FIXED]`-style checkboxes make prettier
  non-idempotent, harmless since it's untracked.)
suggestion: Before committing, remove them or add to .gitignore (`*.parquet`, `login*.json`, `UAT.md`).
  Do NOT commit login*.json (even test creds).
```

---

## Notes on what was checked and is correct

- **ingest-client.ts `requestSignal`** — `AbortSignal.any([external, AbortSignal.timeout(ms)])` is the
  right Node 24 idiom; the timeout timer is unref'd (no event-loop leak), and the drain path passes only
  `timeoutMs` (no aborted signal), so the post-abort drain actually runs rather than self-cancelling.
- **C.8 regression test** (sync-worker.test.ts) genuinely exercises the bug: a real `node:http` server
  that accepts-then-never-responds would hang to the vitest timeout without the threaded abort signal.
- **chunkCommitsBySize** — order-preserving, lossless, isolates an over-ceiling commit into its own
  batch; 4 MiB chunk vs 16 MiB server bodyLimit leaves ample headroom for the JSON wrapper bytes.
- **`--home` is comprehensive** — `credentialsPathFor`/`queuePathFor`/connector-home move together;
  `…For(homedir())` is byte-identical to the legacy constants (asserted in cli-home.test.ts), so no-flag
  behavior is unchanged. QueueStore now mkdirs its parent (node:sqlite won't), guarded for `:memory:`.
- **Dashboard D.3 fix** — login-form reads the response body once (success returns early; `.catch`
  guards the error branch); the same-origin `next` redirect guard is intact; `sessionConfigError()` is
  a pure check that fails loud in both the login route (500) and middleware (log).
- **Tauri sidecar fix** — one-line `SIDECAR_NAME` basename change matches tauri-plugin-shell's
  `relative_command_path` (joins the name verbatim onto exe dir; bundler installs at root). Capability
  scope reverted to original (Rust spawn bypasses IPC scope).

**Verdict:** ship-ready. Address the low items at your discretion; INFO-2 (don't commit login*.json /
artifacts) is the one to action before `/lril:commit`.

---

## Resolution (all findings fixed)

All five findings were addressed; gate re-run green (typecheck 0 errors; repo-health 622 tests, 0
skipped, PASS; prettier clean).

- **#1 (sync-worker.ts)** — `syncOnce` now distinguishes a shutdown/timeout abort (`AbortError`/
  `TimeoutError`, or `deps.signal.aborted`) and calls `releaseInflight` (no attempt bump) instead of
  `markFailed`. New test: an aborted POST leaves the item pending, immediately claimable, `attempts === 0`.
- **#2 (capture-engine.ts)** — `drainBeforeExit` now passes each call the budget REMAINING until the
  deadline (`sync(timeoutMs)`), hard-bounding the whole drain to `deadlineMs` (closes the ~2× window).
  New test asserts the per-call timeout starts at the full budget and shrinks toward 0.
- **#3 (reprice-cli.ts)** — annotated `let outcome: RepriceOutcome;` (imported the type).
- **#4 + #5 (.gitignore)** — added `apps/collector/service/*.exe` and `/login.json` `/login-bad.json`
  `/UAT.md` (`*.parquet` + `*.log` were already covered). `git check-ignore` confirms all five artifacts
  are now ignored, so the WinSW/collector binaries and test-credential files can't be committed.
