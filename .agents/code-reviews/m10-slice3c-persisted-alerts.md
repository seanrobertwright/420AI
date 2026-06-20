# Code Review — M10 Slice 3C (Persisted Alert Engine)

Reviewed against `CLAUDE.md` (module/TS/naming, library-no-logging, Drizzle/SQL gotchas,
token-never-in-browser, validation GATE) and the slice plan
`.agents/plans/m10-slice3c-persisted-alerts.md`.

**Stats:**

- Files Modified: 18
- Files Added: 7
- Files Deleted: 0
- New lines: ~643
- Deleted lines: ~69

---

## Findings

```
severity: low
file: apps/dashboard/src/components/monitor/alerts-panel.tsx
line: 53-62
issue: Optimistic "acked" state is not reconciled when the ack POST fails with a non-OK HTTP status (404/502).
detail: fetch() only rejects on a network-level error, NOT on a 4xx/5xx response. The proxy
        returns 502 on an unreachable/erroring ingest and the ingest returns 404 for an
        unknown/other-user firing id. In both cases the promise RESOLVES, so the catch block
        never runs, the id stays in the `acking` set, and the row shows "acked" permanently —
        yet the server never set `acked_at`, so no future SSE snapshot will ever confirm it.
        The optimistic UI then lies about a failed ack.
suggestion: Check `res.ok` and revert the optimistic flag on a non-OK response (treat it the
            same as the network-error catch). Cheap and makes the optimistic state honest.
```

---

## Verified correct (adversarial pass — no issue)

- **Partial-unique reconcile (D3):** `onConflictDoUpdate` carries the mandatory
  `targetWhere: sql\`status = 'open'\`` so it matches the partial index; a resolved row is
  outside the index, so a re-fire inserts a fresh open row. Proven by the idempotent-re-fire
  and re-fire-after-resolve int tests.
- **Concurrency under SSE ticks (D1):** two concurrent reconciles race only on the INSERT, which
  the partial unique index serializes (one inserts, one takes DO UPDATE). The resolve UPDATE is
  idempotent (`where status='open'`). No lost-update or duplicate-open-firing window.
- **Resolve semantics (D5):** `notInArray(alertKey, [])` compiles to `sql\`true\`` (verified in
  the plan spike), so zero derived alerts correctly resolves ALL open firings — confirmed by the
  resolve int test.
- **`first_fired_at` immutability (D4):** the DO UPDATE `set` touches only
  last_seen_at/message/severity/since; first_fired_at is never overwritten — asserted by the int test.
- **userId scoping:** every firing query (`reconcile`/`list`/`ack`) is scoped by userId; the ack
  re-select by PK is reached only after the (id, userId)-scoped update matched. Other-user ack →
  undefined (tested).
- **Drizzle/SQL gotchas:** `machine_heartbeats.ts` is plain timestamptz → `.toISOString()` on read
  (not `mode:"string"`); `recentBacklogSamples` is a raw-row select (no aggregate-text hazard);
  `queue_pending` is plain integer → JS number; `since` stored as text (no Date coercion on write).
- **Token-never-in-browser (D8):** the Ack button hits the same-origin proxy with no auth header;
  `adminHeaders()` adds the bearer server-side only. `lib/ingest.ts` is server-only.
- **No new long-lived resource (the M9 leak class):** reconcile rides the existing read path; no new
  setInterval/stream/listener/proxied upstream fetch was added (the ack proxy is a one-shot fetch).
- **Library-no-logging boundary:** the new repos throw at most; the route catches. No stdout/exit.
- **Migration:** `0006` is generated (not hand-written), purely additive, with the partial index
  `WHERE "alert_firings"."status" = 'open'`; verified live in the test DB.
- **Version stamp:** `MONITOR_VERSION` → `m10-monitor-v2` updated everywhere including the
  `monitor.test.ts` unit assertion and both `app.int.test.ts` assertions.

All gates green: root `tsc -b` (0), `typecheck:dashboard` (0), `build:dashboard` (0),
`repo-health -- --require-db` PASS (410 tests, 104 integration ran, 0 skipped).
```
```
