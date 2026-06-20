# Code Review — M12 Slice 12.2b (Dashboard Mutating Surfaces + Export + Settings)

Reviewed: feature branch `m12-slice2b-dashboard-mutations` vs `main`.

**Stats:**
- Files Modified: 12
- Files Added: 30 (28 source + 1 test + this review excluded)
- Files Deleted: 0
- New lines: ~192 added in modified files + ~1,500 in new files
- Deleted lines: ~32

## Scope checked
All 30 new files read in full; all 12 modified files read in full context. Focus: logic errors,
security (D8 token discipline + path injection + XSS), resource-teardown leak windows (M9 class),
adherence to the 12.2a/`alerts-panel.tsx` patterns, and codebase conventions.

## Verifications performed
- **D8 token discipline:** no `"use client"` file imports the server-only `@/lib/ingest`/`@/lib/proxy`;
  built client bundles (`.next/static`) contain **0** `ADMIN_TOKEN`; live served HTML grep == 0 on every
  new page; Settings renders booleans (`configured`), never values. **PASS.**
- **Resource teardown (M9 leak class):** no `setInterval`/`setTimeout`/`EventSource`/`addEventListener`
  added; all three export stream proxies pass `req.signal` to `proxyStream` (upstream cancels with the
  client). **PASS.**
- **Path construction:** uuid route params interpolated raw (consistent with 12.2a `projects/[id]/*`,
  `reports/[id]`, `alerts/firings/[id]/ack`; ingest guards every uuid with `isUuid` → 404); text
  `sessionId` is `encodeURIComponent`-d in all three session routes. Convention-consistent. **PASS.**
- **Mutation discipline:** every client mutation checks `res.ok`, disables in-flight (no duplicate POST),
  and refreshes; billable AI interpretation gated behind `window.confirm` with distinct 503/502/404
  messaging. **PASS.**
- **XSS / injection:** no `dangerouslySetInnerHTML`; all values rendered through React auto-escaping;
  export ids/sessionIds `encodeURIComponent`-d into download URLs. **PASS.**
- **Hygiene:** no `console.*`, no `: any`/`as any`, no stray artifacts. **PASS.**
- **Gates:** root `tsc -b` 0 · `typecheck:dashboard` 0 · `npm test` 463 passed (incl. `metrics-diff` 7/7)
  · `build:dashboard` 0 · `repo-health` PASS · live token-leak & export-redaction checks pass.

## Issues

```
severity: low
file: apps/dashboard/src/components/projects/projects-view.tsx
line: 26-60
issue: Card block indentation not adjusted after wrapping in the new <div className="space-y-6">
detail: Wrapping the existing <Card> in the space-y-6 div left <Card>/<CardContent>/</Card> at their
        prior indent depth. JSX is valid (build passes) but the misaligned indentation hurts readability,
        which the repo's hand-authored components otherwise keep tidy.
suggestion: Re-indent the Card subtree one level deeper to sit cleanly inside the wrapper div.
```

No other technical issues detected (no logic errors, no security issues, no performance problems,
no convention violations).
