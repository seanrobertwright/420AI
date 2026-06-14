# Code Review — M8 AI Interpretation Pipeline

Reviewed against the M8 plan, CLAUDE.md conventions, and the M6/M7 precedents.

**Stats:**

- Files Modified: 10
- Files Added: 12 (6 source + 6 test, excluding the plan file)
- Files Deleted: 0
- New lines: ~2,150 (≈334 in modified files + ≈1,800 in new files)
- Deleted lines: 7

---

## Issues

```
severity: medium
file: packages/shared/src/redaction.ts
line: 152
issue: home_user_path does not mask Windows usernames in verbatim JSON-escaped paths
detail: Raw source records store the verbatim JSONL line (claude-code.ts `payload: line`).
        On Windows, JSON escapes a path separator as `\\`, so the stored/decrypted bytes
        contain TWO backslash characters: `C:\\Users\\sean\\app`. The rule's regex
        `[A-Za-z]:\\Users\\` matches a SINGLE backslash, so against the real
        double-backslash form it fails to match — the home-dir username (`sean`, PII) is
        NOT redacted and leaks into the provider request and the stored bundleChars count.
        Verified with a probe: `home finding? : false` for `C:\\Users\\sean\\app`. The plan's
        intended pattern (Task 1) used the double-backslash form; the implementation used
        single. POSIX `/home/<user>` and `/Users/<user>` are unaffected (correctly masked).
suggestion: Match one-or-more backslashes so BOTH the JSON-escaped (`\\`) and plain (`\`)
        forms are caught: `[A-Za-z]:\\+Users\\+` for the prefix. Add a regression test for
        the double-backslash form.
```

```
severity: low
file: apps/ingest/src/routes/interpretations.ts
line: 50, 78
issue: route re-reads sessionDetail / usageTotals + getProjectName that the orchestrator reads again
detail: The session route calls sessionDetail() for the empty-scope 404 guard, then
        generateSessionInterpretation() calls sessionDetail() again; the project route calls
        getProjectName() + usageTotals() and the orchestrator re-reads both. This is one
        redundant query per request. It is NOT a correctness bug and it deliberately mirrors
        the established M7 pattern (routes/reports.ts guards with getProjectName, and
        generate-report.ts re-reads it inside Promise.all), so the route owns the HTTP guards
        while the orchestrator stays pure. Noting for awareness, not flagged for change —
        changing it would diverge from the M7 convention the plan explicitly mirrors.
suggestion: Leave as-is for consistency with M7; revisit only if these reads become hot.
```

---

## Verified non-issues (checked, sound)

- **Provider circular import** (`provider.ts` ↔ `anthropic.ts`/`openai.ts`): the class
  `AnalysisProviderError` is only referenced inside deferred function bodies, never at module
  top-level, so ESM live bindings resolve it by call time — no TDZ. Confirmed by passing
  `provider.test.ts`.
- **No secret/key leakage in errors**: client error messages carry only status codes / generic
  failure text, never `cfg.apiKey`. Library files are silent (CLAUDE.md). The 502 body relays a
  non-sensitive message on an admin-only endpoint.
- **§18 redact-before-send gate**: the orchestrator redacts each decrypted entry before the
  bundle, then defensively re-redacts the full prompt; the int test asserts the provider's
  received `req.user` contains `[REDACTED:anthropic_key]` and NOT the raw `sk-ant-…` secret.
- **D8 empty-scope → 404, provider NOT called**: int test asserts `interpretCalls` is unchanged
  across the three empty/unknown-scope 404 paths — no billable call escapes.
- **Cap loop** in `sessionTranscript`: global-char-cap slices to the remaining budget and breaks
  cleanly; int test asserts `totalChars <= cap`. No off-by-one / infinite loop.
- **Redaction idempotence**: placeholders are digit-free and the entropy gate requires a digit, so
  re-running `redact()` finds nothing new (unit test passes). Home-path username first-char
  excludes `[` so a prior placeholder is never re-matched.
- **No migration / no new dependency**: `packages/db/drizzle/` unchanged; `package.json` /
  lockfile diffs empty. Reuses the M7 `report_artifacts` store verbatim.

---

## Resolution

- **medium (home_user_path)**: FIXED — regex prefix changed to `[A-Za-z]:\\+Users\\+` so both
  plain and JSON-escaped Windows paths are masked; added a regression test for the
  double-backslash form. Verified: `home finding? : true`, username no longer leaks.
- **low (redundant route reads)**: not changed — intentional, mirrors the M7 route/orchestrator
  guard split.

## Gate status (after fix)

- `npm run typecheck` (root tsc -b): exit 0
- `npm test`: 247 passed
- `npm run repo-health -- --require-db`: PASS — 65 integration tests ran, 0 skipped
