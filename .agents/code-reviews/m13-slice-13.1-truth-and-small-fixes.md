# Code Review — M13 Slice 13.1 (Truth & small fixes)

Reviewed against: `git diff HEAD` on branch `m13-capability-gap-closure`, prior to commit.

**Stats:**

- Files Modified: 9
- Files Added: 0
- Files Deleted: 0
- New lines: 152
- Deleted lines: 21

## Issues Found

```
severity: medium
file: docs/guide/operations.md
line: 397-399 (as originally written, before fix)
issue: New "13.1" key-ceremony runbook wrote the signing key to a path its own later step couldn't find
detail: Step 1 said `cd apps/desktop` then `cargo tauri signer generate -w .secrets/tauri-updater.key --ci`,
  which writes the private key to `apps/desktop/.secrets/tauri-updater.key` (CWD-relative). Step 3
  ("Cut a release") and step 4 (verify) have no `cd` note, so per the file's own stated convention
  ("All commands run from the repo root unless noted", line 8) they resolve `.secrets/tauri-updater.key`
  against the repo root instead — a different, empty directory. A maintainer following the runbook
  literally would generate a key in one place and then fail to find it (or silently pick up a stale/
  wrong file) two steps later.
suggestion: Fixed — step 1 now writes to `../../.secrets/tauri-updater.key` from `apps/desktop`, landing
  the key at the repo-root `.secrets/` (same home as the other signing keys in this repo, e.g.
  `.secrets/connector-catalog-private-key.pem`), so steps 3/4 correctly find it at
  `.secrets/tauri-updater.key` from the repo root.
```

## Verification performed

- Re-read `docs/guide/operations.md` top note ("All commands run from the repo root unless noted",
  line 8) and confirmed the `Cut a release` block (step 2, `export TAURI_SIGNING_PRIVATE_KEY=...`)
  carries no `cd` note, i.e. it is repo-root-relative — confirming the mismatch before fixing it.
- Confirmed the anchor link `apps/desktop/README.md` → `operations.md#131--updater-signing-key-one-time-ceremony`
  matches this repo's existing GitHub-anchor convention for an em-dash heading by comparing against the
  existing, already-working link in `docs/guide/custom-connectors.md:229` →
  `operations.md#127c--connector-catalog-management` (heading `## 12.7c — Connector catalog management`).
  Same em-dash-heading → double-hyphen-slug pattern. Not a bug.
- Re-ran `npx prettier --check` on all three touched Markdown files after the fix — clean.
- Re-ran `git check-ignore .secrets/tauri-updater.key` from the repo root — exits 0, confirming the
  corrected path is still covered by the gitignore rule.
- Read `apps/collector/src/sync/sync-worker.ts`, `capture-engine.ts`, and `serve.ts` in full: the
  `onSync`/`onSyncSuccess` callback threading is consistent with the existing `onStop` /
  `consecutiveSyncFailures` seam patterns already in the file; no leaked timers/listeners, no new
  long-lived resources introduced.
- Re-ran the full gate after the fix: `npm run repo-health -- --require-db` — PASS (typecheck ×3
  lanes, NUL/artifact scans, 625/625 tests, 159 integration tests ran with 0 skipped).

## Non-issues considered and ruled out

- `onSync` firing on every "ok" outcome, including the empty-queue no-op drain (not just a real
  network round-trip) — this is the plan's literal, deliberate design (mirrors how
  `consecutiveSyncFailures` already resets on the same condition) and is covered by a dedicated test
  distinguishing it from the "retry" (real failure) case. Not a defect.
- Minor duplication of the `deps.now ?? (() => new Date())` fallback (once in `sendHeartbeat`, once
  inline for `onSync`) — cosmetic only, well under the threshold of a real DRY violation; not worth
  a refactor for two call sites in a already-small function.
- Two pre-existing untracked files in the working tree (`.agents/plans/m13-capability-gap-closure.md`,
  and a stray `uat-events.parquet\`` with a literal trailing backtick in its name) are unrelated to
  this diff — present before this slice's edits began, not staged, not part of "recently changed
  files." Left untouched; flagged here only for visibility, not treated as a review finding.

## Conclusion

One real (documentation) issue found and fixed. No logic errors, security issues, performance
problems, or code-quality violations found in the TypeScript changes. Full gate green after the fix.
