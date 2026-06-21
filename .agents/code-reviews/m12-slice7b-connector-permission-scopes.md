# Code Review — M12 Slice 12.7b: Per-connector permission scopes

**Date:** 2026-06-21
**Branch:** `m12-slice7b-connector-permission-scopes`
**Scope:** additive `requiredPermissions` contract field + `connector-approvals` persistence/gate + desktop surface. No DB, no ingest/server, no Rust.

## Stats

- Files Modified: 14 (incl. trivial README.md prettier touch)
- Files Added: 2 (`connector-approvals.ts`, `connector-approvals.test.ts`)
- Files Deleted: 0
- New lines: ~342 insertions
- Deleted lines: ~31

## Verdict

**Code review passed. No technical issues detected.**

All gates green: `npm run typecheck` (0 errors), `npm run typecheck:desktop` (0), `npm run lint` (0),
`npm run format:check` (clean), `npm run repo-health` (PASS — 553 tests, NUL + stray-artifact scans).
Manual Level-4 walkthrough confirmed seed → drift → `needs-approval` → approve over real stdin.

## What was reviewed (and why it's correct)

### 1. `connector-approvals.ts` (new persistence + gate)

- **Logic — fingerprint determinism:** `captureSurfaceFingerprint` copies-then-sorts both
  `watchGlobs(home)` and `requiredPermissions` before hashing (`[...arr].sort()`), so it never mutates
  the connector's arrays and a cosmetic reordering can't spuriously flip the hash. Correct.
- **Logic — default-on invariant:** `approvalStatus` returns `"approved"` for an absent id; `filterByApproval`
  keeps anything not `"needs-approval"`. An absent/corrupt file resolves to `{approved:{}}` (tolerant load,
  mirrors `loadConnectorConfig`). Verified by unit tests (absent file keeps full registry; unrecorded id
  stays approved).
- **Logic — seed never clobbers drift:** `seedMissingApprovals` only writes ids **absent** from `approved`
  (the `if (!approved[c.id])` guard), so a recorded-but-mismatched connector is preserved as the drift to
  surface — not silently re-blessed. `changed` correctly gates the disk write. Test covers idempotent re-seed.
- **Purity:** every function returns a new object (`{...spread}`); `approveConnector` leaves the prior blob
  untouched (test asserts this). `home`/`path` are injected — no hidden global reads.
- **Boundaries:** library file — no `console`/`process.exit`; `node:crypto` is built-in (no new dependency).
  `0o600` write + `mkdirSync(dirname,...)` mirror `saveConnectorConfig`.

### 2. `serve.ts` wiring

- **Seed-at-boot** runs synchronously before the Promise executor arms listeners/timer — respects the
  CLAUDE.md leak-window rule; the registry is already resolved above it. Writes only when `changed`.
- **`startEngine`** composes `filterByApproval(filterConnectors(...), loadApprovals(), home)`: a connector
  must be **enabled AND approved** to capture. Approvals are re-read at each start (mirrors enablement),
  so a mid-session approval takes effect on the next start. Default-on preserved by both filters.
- **`connectors.approve`** mirrors `connectors.set`: stdin-boundary guard (`typeof id === "string"`),
  unknown id → clean `error` event (no throw, capture unaffected), else persist + `ack` + re-emit. Verified.
- **`mapConnectorInfo`** extended 1:1 with `requiredPermissions` + `approval`; the serve test that pins the
  mapping to `ConnectorFidelity` was updated accordingly.
- No new long-lived resources (timers/streams/listeners/fetch) — nothing to tear down.

### 3. Wire schema (`control-protocol.ts`) + connectors

- `ConnectorInfo` gains required `requiredPermissions` + `approval`; `ControlCommand` gains
  `connectors.approve`; `CONTROL_PROTOCOL_VERSION` bumped `m11-control-v2 → m12-control-v3` (the stamp's
  purpose). Leaf module stays pure types — no `apps/collector` import.
- `requiredPermissions` made **required** on `ConnectorFidelity` (intentional — the compiler forced all four
  real connectors + three test fixtures to declare it; all were updated). Each built-in statement was worded
  to honestly match its real `watchGlobs`/`discoverRoots` (verified against the glob literals).

### 4. Desktop `Connectors.tsx` / `bridge.ts`

- `approveConnector` mirrors `setConnector`. The panel renders `requiredPermissions` (no truncation — the
  user reviews the real scope) with the raw globs dimmed beneath, and shows a "needs review" badge + Approve
  button only when `approval === "needs-approval"`. Re-emit on approve refreshes via the existing
  `onControlEvent` listener — no manual refetch. Graceful: an older sidecar omitting `approval` would render
  as not-needs-approval (button hidden), and the toggle still works.

## Observations (non-blocking, no action required)

- `emitConnectors` now does two short-lived file reads (`loadConnectorCfg` + `loadApprovals`) per
  `connectors.list`. This matches the existing per-emit `loadConnectorCfg` pattern and the lists are
  user-triggered/infrequent — acceptable; not worth caching.
- Security: no secrets, no SQL, no network, no user-controlled paths beyond the existing custom-connector
  globs. The approvals file is `0o600`. Nothing flagged.
