# Code Review — M12 Slice 12.6: Alert delivery (webhook) + remaining §20 conditions

**Reviewed:** branch `m12-slice5-archive-replay` working tree (12.6 implementation)
**Date:** 2026-06-20
**Reviewer:** technical code review (lril:code-review)

## Stats

- Files Modified: 25
- Files Added: 8 (excludes `.github/workflows/pr-checks.yml` — pre-existing 0-byte stray, NOT part of this slice)
- Files Deleted: 0
- New lines: ~426 (modified files) + new files (deliverer, auth-failures repo, 2 int tests, migration up/down + snapshot)
- Deleted lines: 31

## Verdict

**Code review passed — no critical/high/medium defects detected.** Type-checks clean (`tsc -b` exit 0), full `repo-health --require-db` green (530 tests, 147 integration tests executed, 0 skipped), dashboard build green. The implementation faithfully follows the plan's in-repo precedents (`analysisProvider` injection, `deriveCatalogAlerts` count-and-derive, the M9 heartbeat extension, the hand-authored down-migration). `deriveAlerts` is byte-for-byte unchanged; the two new conditions are siblings merged via `sortAlerts`. No new background loop; delivery rides the existing evaluate-on-read reconcile.

Three LOW-severity observations follow — all are documented design trade-offs or one-time/bounded effects, not regressions. None block commit.

---

## Observations (LOW)

```
severity: low
file: packages/db/src/repositories/alert-firings.ts
line: 306-316 (deliverPendingFirings)
issue: select-then-stamp is non-atomic → at-most-TWICE delivery under concurrent reads
detail: The fn SELECTs open firings WHERE delivery_attempted_at IS NULL, delivers each, then
        UPDATEs the stamp. Two overlapping snapshot reads (a manual GET /v1/monitor racing the
        ~3s SSE push() tick) can both select the same un-stamped row before either UPDATE lands,
        causing two webhook POSTs for one firing.
suggestion: Accepted trade-off per the plan's NOTES ("at-most-once-ATTEMPT … the firing row is the
        durable record"). The deliberate deliver-then-stamp ordering avoids the opposite failure
        mode (a crash between stamp and deliver = a silently-dropped notification). For a
        single-admin self-hosted box (one SSE stream + occasional manual GET) the window is small
        and a duplicate notification is harmless. If true exactly-once is ever needed, switch to a
        claim-first conditional UPDATE … WHERE delivery_attempted_at IS NULL RETURNING and deliver
        only the claimed rows. NOT changed — matches the documented decision.
```

```
severity: low
file: apps/ingest/src/routes/monitor.ts
line: 98-114 (deliverFirings)
issue: first read after deploy delivers ALL currently-open firings in one burst
detail: Migration 0010 adds delivery_attempted_at as NULL for existing rows, so any firing already
        open at deploy time has a null marker and is delivered on the first monitor read after a
        webhook is configured.
suggestion: This is arguably correct (notify the operator of currently-active alerts), one-time, and
        bounded by the small number of concurrently-open firings on a single-admin box. No change
        recommended; noted for awareness.
```

```
severity: low
file: apps/ingest/src/plugins/auth.ts + packages/db/src/repositories/auth-failures.ts
line: auth.ts 55-60; auth-failures.ts recordIngestAuthFailure (prune)
issue: an INSERT + a prune DELETE run per 401 under a credential-probe flood
detail: Every invalid-token 401 fires recordIngestAuthFailure, which inserts one row and then runs a
        DELETE … WHERE ts < (now - 7d). Under a rapid probe this is two writes per rejected request.
suggestion: Mitigated three ways already: (1) fire-and-forget `void …catch(()=>{})` so it never adds
        latency to the 401, (2) the `ingest_auth_failures_by_ts` index keeps the prune cheap, (3)
        12.4c rate limiting caps request volume. Acceptable as-is; a future refinement could prune
        probabilistically or on a cadence rather than every insert.
```

---

## Checks performed (all pass)

- **Logic:** counter increment/reset in `runSyncLoop` verified by a new unit test asserting the exact
  heartbeat-reported sequence `[0,1,2,0]`. `deriveArchiveUnreachableAlerts` offline-suppression + null
  (older-collector) → 0 covered. Threshold boundaries for both new derivatives covered.
- **Security:** webhook URL is operator-configured env (not user input → no SSRF surface); the posted
  firing JSON carries no secrets (no token/cookie); `ADMIN_TOKEN`/`SESSION_SECRET` never leave the
  server. Auth-failure recording stores only `request.ip` (operator's own audit), never logged.
- **Dependency direction:** `deliverPendingFirings` takes an inline structural `{ deliver(...) }` type
  so `@420ai/db` gains no dependency on `@420ai/shared`/`apps/ingest`. Confirmed.
- **Silent-library rule (CLAUDE.md):** the webhook deliverer throws (never logs); the caller swallows +
  logs at the route boundary via `app.log.error`. `recordIngestAuthFailure` throws, never logs.
- **Resource teardown:** no new long-lived resource introduced — delivery rides the existing reconcile;
  the SSE interval teardown is unchanged and still armed before the first await. `AbortSignal.timeout`
  bounds each webhook fetch.
- **Drizzle/SQL gotchas:** `count(*)::int` cast on the auth-failure count; the new `machines` integer
  column is mapped with NO `.toISOString()` (only timestamptz cols get it). Confirmed.
- **Migration:** generated `0010` contains exactly the 3 expected statements; hand-authored down reverses
  them in reverse order and is exercised by the updated `rollback.int.test.ts` (applies down → asserts
  `ingest_auth_failures` gone → re-migrates).
- **Back-compat:** heartbeat field optional in wire type + JSON schema (additionalProperties:false
  satisfied); existing `buildApp` callers omit `alertDeliverer` → null → delivery disabled (no behavior
  change); dashboard `AlertsPanel` switches on severity not code → renders new codes unchanged.

## Note for the committer

`.github/workflows/pr-checks.yml` is an empty 0-byte file created before this work began and unrelated
to this slice. Exclude it from the commit.
