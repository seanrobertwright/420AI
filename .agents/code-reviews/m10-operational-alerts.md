# Code Review — M10 Operational Alerts slice

**Reviewed:** staged working tree on `m10-hardening` (the operational-alerts slice).
**Date:** 2026-06-15

**Stats:**

- Files Modified: 10
- Files Added: 3 (`packages/shared/src/alerts.ts`, `packages/shared/src/alerts.test.ts`, `apps/dashboard/src/components/monitor/alerts-panel.tsx`)
- Files Deleted: 0
- New lines: 431
- Deleted lines: 12

Gates run: `tsc -b` (0), `typecheck:dashboard` (0), `npm test` (288 pass), `repo-health -- --require-db` (PASS, 73 int tests, 0 skipped), `build:dashboard` (0).

---

## Findings

```
severity: medium
file: packages/db/src/repositories/projections.ts
line: 268
issue: connector.failing ratio denominator double-counts — `tool.call.%` includes `tool.call.started`, so the alert effectively only fires near a 100% failure rate.
detail: `toolCalls` is `count(*) filter (where event_type like 'tool.call.%')`, which matches `started` + `completed` + `failed`. All three connectors (claude-code.ts:247, gemini-cli.ts:178, codex-cli.ts:231) emit a `tool.call.started` for EVERY tool call plus a terminal `completed`/`failed`, so in production `toolCalls ≈ 2× the real number of calls. The numerator `toolsFailed` counts only `tool.call.failed` (terminal). Therefore `toolsFailed / toolCalls ≈ failureRate / 2`: a connector that fails 100% of calls lands at exactly 0.5 (the threshold, inclusive → fires), but one failing 80% computes 0.4 and stays SILENT. The feature misses clearly-failing connectors. The int test (projections.int.test.ts:255) passes only because its seed (line 140) omits `tool.call.started`, so the seed is not representative of real connector output — `tool.call.%` and "terminal events only" are indistinguishable on that seed.
suggestion: Make the denominator the count of TERMINAL calls so numerator and denominator share a population: `count(*) filter (where ${events.eventType} in ('tool.call.completed','tool.call.failed'))::int`. This keeps `toolsFailed/toolCalls` a true failure ratio and leaves the existing int test green (seed has 1 completed + 1 failed → still 2). Optionally extend the int seed with a `tool.call.started` and assert `toolCalls` still equals the terminal count, to lock the semantics. (Note: the pre-existing M6 `sessionAggregateColumns.toolCalls` has the same `tool.call.%` definition, but it is only ever displayed as a count — it is not used as a ratio denominator, so the skew is harmless there. The bug is specific to the new ratio use.)
```

```
severity: low
file: apps/dashboard/src/components/monitor/alerts-panel.tsx
line: 15
issue: `formatAgo` is duplicated verbatim from monitor-view.tsx (DRY).
detail: An identical `formatAgo(iso, nowMs)` already lives in monitor-view.tsx (module-local, not exported). Two copies drift independently — a future change to the relative-time format (e.g. "just now" under 5s) would have to be made in both.
suggestion: Extract `formatAgo` to a shared frontend util (e.g. `apps/dashboard/src/lib/format.ts`) and import it in both components. Low priority — the function is small and pure; acceptable to defer, but worth a tracking note.
```

```
severity: low
file: packages/shared/src/alerts.ts
line: 85
issue: Alert messages hardcode threshold values (">5 min", ">90 s", "5 min") that are actually owned by MONITOR_THRESHOLDS.
detail: `MONITOR_THRESHOLDS.offlineMs` (300000 = 5 min) and `staleMs` (90000 = 90 s) are the source of truth, but the human-readable message strings restate them literally. If a threshold is tuned, the messages silently become wrong.
suggestion: Either derive the phrasing from the threshold constants, or accept the coupling and add a short comment at MONITOR_THRESHOLDS noting that alerts.ts messages mirror these values. Minor — the plan specified these exact strings.
```

---

## What was checked and is correct

- **Divide-by-zero guard** — the `c.toolCalls >= connectorFailMinCalls` short-circuit precedes the `toolsFailed / toolCalls` divide; 0-call connectors never divide. Covered by alerts.test.ts:119.
- **Offline-suppresses-backlog rule** — `m.backlogHigh && status !== "offline"` correctly emits one alert for an offline+backlog machine. Covered by alerts.test.ts:80.
- **Critical-first stable sort** — `SEVERITY_RANK` map + `slice().sort(...)` is stable (Node ≥ 24); a stale-before-offline snapshot still ranks critical first. Covered by alerts.test.ts:139.
- **Clock-free purity** — no `new Date()`/`Date.now()` in `alerts.ts`; `deriveAlerts` is a pure function of the snapshot, honoring the "don't recompute liveness" guidance. Correct.
- **Version-stamp ripple** — `MONITOR_VERSION` bump fanned out to all three test assertions (monitor.test.ts:111, app.int.test.ts:1023/1086). No stragglers.
- **No security surface** — no SQL string interpolation (the only new SQL is a parameterized `sql` template with a static literal filter), no new token exposure (alerts ride the existing admin-gated proxy), no XSS (React escapes the message text). The token-leak invariant is unaffected — `deriveAlerts` adds no client-held secret.
- **No long-lived resource** — `deriveAlerts` is pure; the M9 SSE-leak class does not apply.
- **`emptyMonitorSnapshot` carries `alerts: []`** — the no-user / unreachable paths return a valid shape.
- **React key uniqueness** in alerts-panel.tsx — `${code}:${machineId ?? connector ?? i}` is unique per (machine-liveness OR backlog OR connector) row.

## Recommendation

The medium finding is the one worth fixing before merge — it's a one-line SQL change that makes the headline `connector.failing` heuristic actually fire at its documented 50% threshold, and it keeps every test green. The two low findings are safe to defer with a tracking note.
