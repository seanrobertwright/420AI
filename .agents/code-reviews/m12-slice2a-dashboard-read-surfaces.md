# Code Review — M12 Slice 12.2a (Dashboard Foundation + Read Surfaces)

Reviewed: working tree on branch `m12-slice2-dashboard-surfaces` (additive `apps/dashboard`
files + 3 doc updates + 1 test-infra alias). Reviewed each new file in full and each changed
file in full context against `CLAUDE.md` (Frontend workspace, D8 token discipline, M9 leak
windows, logging boundaries) and the plan.

**Stats:**

- Files Modified: 6 (`layout.tsx`, `monitor/alerts-panel.tsx`, `monitor/monitor-view.tsx`,
  `vitest.config.ts`, `SUMMARY.md`, `docs/PRD.md`, `docs/guide/usage.md`)
- Files Added: 28 (`apps/dashboard/src/**`: 1 proxy + 11 API routes, 5 pages, 6 views,
  2 components, `types.ts`, `format.ts`, + `proxy.test.ts`, `format.test.ts`)
- Files Deleted: 0
- New lines: ~1,361 (new dashboard files) + doc/config edits
- Deleted lines: ~28 (duplicate `formatAgo` removed from 2 components)

## Verification performed

- `npm run typecheck:dashboard` → 0 errors. `npm run typecheck` (root `tsc -b`) → 0 (unaffected).
- `npm run build:dashboard` (`next build`) → builds; 22 routes emitted.
- `npm run repo-health` → PASS (456 tests / 63 files green; dashboard typecheck lane green).
- `npx vitest run` of the two new lib tests → 15 passed.
- **D8 token-leak (runtime):** served the production build with a canary `ADMIN_TOKEN` + a dead
  `INGEST_URL`; `grep -c "$CANARY"` on `/monitor`, `/projects`, `/reports`, `/search`,
  `/machines`, and `/api/projects` → **0** on every page. All `ADMIN_TOKEN`/`process.env` reads
  are confined to server-only `lib/ingest.ts` + `lib/proxy.ts` (+ tests); no `NEXT_PUBLIC_*`, no
  `"use client"` env read.
- **Empty-fallback edge case:** with ingest unreachable every page still rendered its nav shell +
  heading (HTTP-layer assertion), confirming the try/catch fallbacks.

## Issues found & resolved

```
severity: low
file: apps/dashboard/src/components/monitor/monitor-view.tsx
line: 16-28 (pre-fix)
issue: Duplicate formatAgo retained after lib/format.ts extraction (DRY).
detail: The slice extracts formatAgo into lib/format.ts and points alerts-panel at it, but
        monitor-view.tsx kept its own byte-identical copy — leaving two definitions and defeating
        the extraction's purpose.
suggestion: Import { formatAgo } from "@/lib/format" and delete the local copy (verified
        byte-identical first; behavior unchanged).
status: FIXED — consolidated; build:dashboard re-verified (touches the live monitor render path).
```

```
severity: low
file: apps/dashboard/src/components/search/search-view.tsx
line: runSearch signature
issue: Implicit global React.FormEvent type used without importing the React namespace.
detail: Compiles only via @types/react's global `React` namespace; less explicit than the repo's
        verbatimModuleSyntax style (other files import what they use).
suggestion: import { useState, type FormEvent } from "react" and annotate e: FormEvent.
status: FIXED.
```

## Considered, not issues (rationale)

- **Resource/leak windows (the M9 class):** no `setInterval`/`setTimeout`, no SSE/EventSource, no
  long-lived listeners in any new file. `proxyStream` correctly threads `signal` to the upstream
  fetch (ready for 12.2b). `search-view`'s fetch is a one-shot, user-initiated submit (not an
  effect-owned long-lived resource) — an AbortController would be over-engineering; worst case is
  a benign post-unmount state set, which React 18+ does not warn on.
- **Project-detail extra `/v1/projects` fetch** (to resolve name + confirm existence): one extra
  call per detail view, not per-row — correct because a well-formed-but-unknown uuid returns
  *zeroed* projections (200), so the list is the only existence authority. Acceptable for the
  single-user model.
- **`vitest.config.ts` `@` alias:** required so dashboard `*.test.ts` resolve `@/`-imports under
  Vite (vitest ignores tsconfig `paths`). Safe beside `@420ai/*`: `@rollup/plugin-alias` requires a
  `/` immediately after the matched key, so `@` matches only `@/...`, never `@420ai/...`.
- **Search snippet rendering:** snippet is already redacted server-side; rendered as React text
  (auto-escaped) with `<b>` markup stripped → XSS-safe, no `dangerouslySetInnerHTML`.
- **Markdown as `<pre>` / unused `proxyStream`:** intentional per plan (rich render + exports are
  12.2b; `proxyStream` defined now so the foundation is complete in one place).
- **Clickable `<tr>` for report selection:** a minor a11y nit (keyboard focus), consistent with the
  existing monitor table patterns; out of scope for this read slice.

## Verdict

Two low-severity DRY/style issues found and fixed. No logic, security, performance, or
convention-violation issues remain. Code review passed.
