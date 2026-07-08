# Code Review — M13 Slice 13.5: Alert Delivery Completion

**Reviewed:** working tree on branch `m13-slice5-alert-delivery` (vs `HEAD`)
**Date:** 2026-07-08

## Stats

- Files Modified: 12 source (+ 3 generated: `package-lock.json`, `drizzle/meta/_journal.json`, `.env.example`)
- Files Added: 5 (`smtp-deliverer.ts` + test, `0012_*.sql`, `0012_*.down.sql`, `0012_snapshot.json`)
- New lines: ~445
- Deleted lines: ~37

## Scope reviewed

SMTP deliverer + fan-out (`apps/ingest/src/delivery/`), webhook `kind` derivation, `server.ts`
wiring, migration 0012 (`resolve_delivered_at`), `deliverResolvedFirings` + `monitor.ts` wiring,
`connectorHealthWindowed` projection, `deriveConnectorFailureRateAlerts` + new `AlertCode`, and all
accompanying unit + integration tests.

## Verification performed

- `npm run typecheck` (root `tsc -b`) — exit 0
- `npm run typecheck:dashboard` — exit 0 (new `AlertCode` consumed cleanly)
- `npm run repo-health -- --require-db` — PASS, 695 tests, **183 integration ran, 0 skipped**
- `db:rollback` → `db:migrate` CLI cycle — column dropped then restored
- `prettier --check` on all touched files — clean

## Correctness analysis (deliver-on-resolve lifecycle)

Traced every tick ordering against the four guards
(`status='resolved' AND resolved_at IS NOT NULL AND delivery_attempted_at IS NOT NULL AND resolve_delivered_at IS NULL`):

- **open → deliver → resolve → resolve-deliver**: resolve notice fires exactly once, `resolve_delivered_at` stamped. ✓
- **open-and-resolve within a single tick gap (never observed open)**: `delivery_attempted_at` is NULL → correctly **skipped** (no lone "resolved" with no preceding "firing"). ✓
- **resolved while deliverer was null, deliverer later added**: open notice never fired (firing no longer open) AND resolve notice skipped (`delivery_attempted_at` NULL) — graceful, no orphan notice. ✓
- **within one snapshot tick**: a firing is only ever open XOR resolved, so `deliverPendingFirings` and `deliverResolvedFirings` never both fire for the same firing in the same tick — no double delivery. ✓

The `alert.resolved` envelope kind is derived from `firing.status` on the shared deliverer, so both
webhook and SMTP report resolution without a signature change — the open-firing contract is unchanged
byte-for-byte (existing webhook test still asserts `alert.firing`).

## Findings

**Code review passed. No technical issues detected (no logic errors, security issues, performance
problems, or standards violations).**

### Informational — intentional design, no action required

1. **`low` · Per-firing (not per-channel) at-most-once.**
   `apps/ingest/src/delivery/smtp-deliverer.ts:82-94` — if the webhook succeeds but SMTP throws, the
   fan-out throws an `AggregateError`; the caller logs it and still stamps `delivery_attempted_at`, so
   that one firing's SMTP notice is not retried. This is the documented M12 contract ("at-most-one
   ATTEMPT per firing; the firing row is the durable record"), deliberately mirrored. The healthy
   channel is unaffected (Promise.allSettled). No change.

2. **`low` · Non-transactional select-then-stamp.**
   `alert-firings.ts:264-285` — concurrent snapshot builds (GET + SSE tick) could theoretically select
   the same resolved firing before either stamps `resolve_delivered_at`, yielding a duplicate resolve
   notice. This is the **same** accepted race already present in `deliverPendingFirings` (M12 12.6) and
   is bounded to best-effort delivery on a single-user self-hosted deployment. Mirrored intentionally;
   no new exposure.

3. **`low` · No time bound on resolve-delivery selection.**
   Consistent with `deliverPendingFirings` (which also selects un-attempted firings regardless of age).
   The `delivery_attempted_at IS NOT NULL` guard already screens firings that were never delivered open,
   so a stale resolve notice can only follow a delivered-open firing — the correct pairing. No change.

## Standards adherence

- Libraries throw / never log; `now` is route-owned; deliverers injected behind the interface (CLAUDE.md process boundaries). ✓
- Windowed aggregate uses `gte(events.ts, sinceIso)` mirroring `activeSessions`; terminal-call denominator matches `connectorHealth`. ✓
- Migration generated via `drizzle-kit` + hand-written down mirroring prior downs; `resolve_delivered_at` nullable, additive. ✓
- `deriveAlerts` left FROZEN; new alert is a sibling merged via `sortAlerts`. ✓
