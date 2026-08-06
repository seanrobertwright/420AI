# M16 16.6 — capture-liveness detection: manual validation evidence

Captured **2026-08-06**. Level 4 item 1 of
[`.agents/plans/m16-slice6-capture-liveness-detection.md`](../../plans/m16-slice6-capture-liveness-detection.md):
_"The evaluator delivers with nobody watching."_

## What was run

A real `apps/ingest/src/server.ts` process — not `app.inject`, not a hand-called tick — with:

```
ALERT_EVALUATOR_INTERVAL_MS=5000
ALERT_WEBHOOK_URL=http://localhost:9971/hook
ALERT_SMTP_URL=   SMTP_URL=            # blanked: no outbound mail from a validation run
INGEST_PORT=8477
DATABASE_URL / DATABASE_URL_APP -> the TEST database
```

The **test** database rather than the dogfood archive, deliberately: this run writes `alert_firings`
rows and stamps delivery markers, and a validation exercise must not leave those in the research
archive the milestone is measuring. The seeded fixture is one machine named
`manual-validation-collector` whose last heartbeat is 10 minutes old (`deriveMachineStatus` →
`offline`) carrying `queuePending: 159828` — INC-2026-07's own number.

**The dashboard was never opened.** No `GET /v1/monitor`, no `GET /v1/monitor/stream`, no request of
any kind reached the server: `grep -cE '"req"|/v1/monitor'` over the server log returns **0** for the
whole run. That is the entire claim of the slice, so it is asserted rather than assumed — and it is
also pinned in code by `alert-evaluator.int.test.ts`, which counts requests through an `onRequest`
hook and expects 0 at the moment the firing is delivered.

## Result — [`webhook-deliveries.txt`](./webhook-deliveries.txt)

| # | t | kind | code | severity |
| - | - | ---- | ---- | -------- |
| 1 | `19:32:57Z` | `alert.firing` | `collector.offline` | critical |
| 2 | `19:33:42Z` | `alert.resolved` | `collector.offline` | critical |

1. **Open.** Within one 5 s tick of boot, a critical `collector.offline` firing was POSTed to the
   webhook. `firstFiredAt` `19:32:57.060Z`; `since` carries the stale heartbeat's timestamp
   (`19:22:33.084Z`), i.e. evidence-time, not fired-time — `alerts.ts`'s stateless contract intact.
2. **At-most-once, not once per tick.** The process was left running for a further ~6 ticks and
   delivered **nothing more** — `delivery_attempted_at` did its job. This is the property that makes
   a 60 s production cadence safe rather than a mail-flood: 1 delivery, not 7.
3. **Self-resolving.** A fresh heartbeat was recorded at `19:33:37Z`; the next tick derived the
   alert away, `reconcileAlertFirings` resolved the row (`resolvedAt` `19:33:42.135Z`) and
   `deliverResolvedFirings` sent the `alert.resolved` notice. So the unattended path completes the
   full open→resolve cycle, not just the half that raises an alarm.

Errors logged during the run: **0**.

## What this does NOT cover

Stated rather than quietly absorbed, on the same terms as the M16 pre-sign-off notes:

- **Level 4 items 2 and 3 (the collector's 401 path) were NOT exercised end to end here.** Proving
  them needs a paired collector, a revoked machine row, and a WinSW service install to observe
  `<onfailure action="restart"/>` and the Windows Event Log. The behaviour is covered at the unit
  level — `cli.test.ts` asserts the fault file is written and the fatal flag reported, `fault.test.ts`
  asserts `faultPathFor` honours `--home` and that the record carries no token, and
  `capture-engine.test.ts` drives a real `runCaptureEngine` with an always-401 `post` — but the
  service-manager half is an operator exercise on a real machine and remains open.
- The webhook here is a local sink. SMTP fan-out is unchanged by this slice (workstream C adds no
  code) and was blanked for the run.
