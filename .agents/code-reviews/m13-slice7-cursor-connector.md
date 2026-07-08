# Code Review — M13 Slice 13.7: Cursor connector (SQLite poll capture mode)

**Reviewed:** 2026-07-08 · branch `m13-slice7-cursor-connector`
**Scope:** the Cursor poll-mode connector, its store read layer, the engine poll loop,
the poll change-memory in `QueueStore`, and the poll capability contract additions.

## Stats

- Files Modified: 9
- Files Added: 4
- Files Deleted: 0
- New lines: ~360 (incl. tests)
- Deleted lines: ~13

**Added:** `cursor.ts`, `cursor.test.ts`, `cursor-store.ts`, `cursor-store.test.ts` (all under
`apps/collector/src/connectors/`).
**Modified:** `connector.ts` (poll capability types + registry), `capture-engine.ts` (`pollLoop`),
`queue/queue-store.ts` (`poll_state` + `pollChanged`/`pollCommit`), `connector-approvals.ts`
(poll sources in the capture-surface fingerprint), `connector-catalog.ts` (`captureMode` widened
to include `"poll"`), plus their tests and `docs/CONTEXT.md`.

## Findings

### 1. [FIXED] Poll change gate recorded the observation before enqueue succeeded

```
severity: medium
file: apps/collector/src/connectors/cursor.ts (runCursorPoll) + queue-store.ts (pollObserve)
line: 262-286 (cursor.ts), pollObserve (queue-store.ts)
issue: The change gate recorded a composer's content hash as a side effect of the change
       CHECK, before the bubbles were fetched and the parse was enqueued.
detail: `QueueStore.pollObserve` both compared AND recorded the hash in one call. If
        `store.bubblesFor` or `ctx.enqueue` threw after the check (a transient SQLite/queue
        error), the composer was already marked "seen" and would NOT be re-processed until
        its content changed again — the composer's events could be silently lost. This
        violates the FileWatcher's load-bearing commit-point ordering ("save the cursor only
        AFTER onChange succeeds", file-watcher.ts), which the collector treats as a rule.
suggestion: Split the gate into a READ-ONLY `pollChanged` and a `pollCommit` that records the
        hash, and call `pollCommit` only AFTER a successful `enqueue`. A throw in between now
        leaves the composer un-committed → retried next tick.
```

**Applied fix:**

- `QueueStore.pollObserve` → split into `pollChanged(connectorId, key, content): boolean`
  (pure compare, no write) and `pollCommit(connectorId, key, content): void` (records the hash).
- `PollContext` gains a `commit(key, content)` seam; `changed` is now documented read-only.
- `runCursorPoll` commits only after `ctx.enqueue` returns.
- Regression tests added: `cursor.test.ts` "does NOT commit a composer whose enqueue fails
  (commit-point ordering → retried next tick)"; `queue-store.test.ts` "pollChanged is read-only:
  repeated checks stay true until pollCommit records the hash".

## Items considered and cleared (not defects)

- **`cursorConnector.parse` is effectively dead code** (empty `watchGlobs` → the FileWatcher
  never calls it; the re-parse engine skips `"cursor"` into `skipped.other`, verified at
  `packages/db/src/repositories/reparse.ts:156`). Kept as `parseCursorComposer(text, [])` — a
  coherent (not silently-lossy) fallback rather than a stub. **OK.**
- **CLI `collector watch` polls Cursor without approval filtering.** Consistent with existing
  behavior — approval filtering (`filterByApproval`) is applied in the desktop `serve.ts` path
  only; the CLI captures all built-ins by default, and seed-on-first-sight makes a new connector
  approved. Not a regression. **OK.**
- **`captureMode: "poll"` allowed on a catalog overlay for a connector with no `poll` capability.**
  A signed/trusted catalog could set it; the effect is a no-op (engine polls only connectors with
  a `poll` capability). Edge case, low value to guard. **OK.**
- **Synchronous poll pass blocks the event loop.** Spike-measured at 383 composers / 14.3 MB;
  `node:sqlite` is synchronous by design and the cadence is 5 min. Acceptable at this scale. **OK.**
- **`pollChanged` + `pollCommit` hash the content twice per changed composer.** Negligible (only
  for changed composers, 5-min cadence). **OK.**
- **Secret handling:** `cursor-store.ts` reads `cursorDiskKV` ONLY; `ItemTable` (43 secret-ish
  keys) is never queried — enforced by construction and asserted by a test seeding a secret into
  `ItemTable` and proving it never surfaces. Verified live against the real 1.9 GB store (no
  `aiSettings` leak). **OK.**
- **NaN-timestamp fall-through** (the M9 class): `epochMsToIso` guards non-finite epoch values and
  falls back to `ingestedAt`; tested. **OK.**
- **Resource teardown:** the poll loop uses the existing leak-safe `abortableDelay` (timer +
  listener armed synchronously) and is included in the engine's `Promise.allSettled`. **OK.**

## Verification

- `npm run typecheck` (root `tsc -b`) — 0 errors.
- `npm run repo-health` — PASS, 743 tests (was 622 baseline; +59 net across the milestone,
  +21 for this slice's units).
- Live read + parse against the real `%APPDATA%\Cursor\…\state.vscdb` (read-only): 92 composers
  swept, 30 parsed → 6950 raw records / 18934 events, 0 with `cost.estimated` (confirms the
  "model usually 'default' → uncosted" fidelity label on real data), no ItemTable leak.

**Result:** one medium finding, fixed. No outstanding issues.
