# Code Review — M11 Slice 2: Sync & Health + Connector Management

**Date:** 2026-06-15
**Branch:** `m11-slice2-sync-health-connectors`
**Reviewer:** Claude (lril:code-review)
**Scope:** the diff implementing `.agents/plans/m11-slice2-sync-health-connectors.md`

## Stats

- Files Modified: 9 (`serve.ts`, `serve.test.ts`, `control-protocol.ts`, `control-protocol.test.ts`, `bridge.ts`, `App.tsx`, `lib.rs`, `Cargo.toml`, `Cargo.lock`)
- Files Added: 5 code (`connector-config.ts`, `connector-config.test.ts`, `proxy.rs`, `SyncHealth.tsx`, `Connectors.tsx`) + 1 plan doc
- Files Deleted: 0
- New lines: ~576 (modified) + ~535 (new code files) + 309 (generated `Cargo.lock`)
- Deleted lines: ~10

## Verdict

**Passed with 4 low-severity findings.** No critical, high, or medium issues. The security-critical
surface — the admin token never crossing to the webview — is implemented correctly (token read from
env in Rust, added via `bearer_auth`, never logged, never returned; the webview receives only the
opaque snapshot JSON). All findings below are robustness / defense-in-depth refinements, not blockers.

---

## Findings

```
severity: low
file: apps/collector/src/serve.ts
line: 261-272
issue: `connectors.set` handler does not validate `id`/`enabled`; malformed input silently writes a garbage key instead of erroring.
detail: The handler does `cfg.connectors[c.id] = { enabled: c.enabled }` with no guard. A malformed
        command `{"cmd":"connectors.set"}` (missing `id`) does not throw — JS coerces the key to the
        string "undefined", so the config gets a `"undefined": { enabled: undefined }` entry, then the
        handler emits `ack` + a `connectors` event as if it succeeded. This contradicts the plan's own
        edge-case table (plan line 494: "Malformed connectors.set (missing id) ⇒ the serve dispatch
        .catch emits a {type:error}") — the dispatch `.catch` only fires on a throw, and this path never
        throws. In practice the only command producer is the typed `bridge.ts`, so this is not reachable
        through the real app; the risk is defense-in-depth at the stdin boundary (the Rust relay forwards
        opaque JSON, so a future/buggy producer could reach it) and a doc/code mismatch.
suggestion: Add a guard at the top of the case:
            `if (typeof c.id !== "string" || typeof c.enabled !== "boolean") {
               emit({ type: "error", message: "connectors.set requires id:string + enabled:boolean", cmd: c.cmd }); return; }`
            Optionally add a serve.test.ts case asserting the error event, which would make the plan's
            edge-case claim true.
```

```
severity: low
file: apps/desktop/src/components/Connectors.tsx
line: 44-63
issue: No retry affordance if the initial `listConnectors()` rejects (sidecar restart window) — the panel can get stuck on "Loading connectors…".
detail: On mount the effect calls `listConnectors().catch(setError)`. If the sidecar is mid-restart
        ("sidecar not running"), `connectors` stays `null`, so the panel renders the error line PLUS the
        "Loading connectors…" placeholder, and there is no way to re-request — the `connectors` event only
        arrives in response to a `connectors.list`/`connectors.set`, neither of which can be triggered
        from this state. SyncHealth.tsx has a Refresh button for exactly this reason; Connectors has none.
suggestion: Add a small "Retry" button (shown when `error && connectors === null`) that re-invokes
            `listConnectors()`, mirroring SyncHealth's Refresh. Cheap and matches the established pattern.
```

```
severity: low
file: apps/desktop/src/components/SyncHealth.tsx
line: 81-89
issue: The one-shot `getMonitorSnapshot()` promise calls setState in .then/.catch/.finally without an unmount guard.
detail: If the component unmounts while the proxy fetch is in flight, `setSnapshot`/`setServerError`/
        `setLoading` run on an unmounted component. This is benign in React 19 (no warning, no leak — it
        is a one-shot promise, not a long-lived listener), and it mirrors StatusBar.tsx's `run()` which
        is also unguarded, so it is consistent with the codebase. Noting for completeness only. Same
        shape applies to Connectors.tsx `toggle`/`listConnectors`.
suggestion: Optional — capture the effect's `disposed` flag and skip the setState calls when disposed, if
            you want the panels to be strictly unmount-safe. Not required given the React 19 behavior.
```

```
severity: low
file: apps/desktop/src/components/Connectors.tsx
line: 112-114
issue: `key={g}` on the watch-glob list collides if a connector reports duplicate globs.
detail: `c.watchGlobs.map((g) => <div key={g}>{g}</div>)` uses the glob string as the React key. If a
        connector's `watchGlobs(home)` ever returns the same pattern twice, React warns about duplicate
        keys and may mis-reconcile. Current connectors return distinct globs, so this is latent.
suggestion: Use a composite key: `key={`${g}:${i}`}` with the map index, or dedupe the globs.
```

---

## Positives (verified correct)

- **Admin-token isolation (CRITICAL surface):** `proxy.rs` reads `ADMIN_TOKEN` from env, attaches it via
  `bearer_auth`, never logs it, and returns only `serde_json::Value` (the snapshot) — the token cannot
  reach the webview. Matches Conflict #1 resolution and the dashboard proxy invariant.
- **Empty-set filtering correctness:** `startEngine` passes `connectors: filterConnectors(...)`, and
  `capture-engine.ts:36` uses `opts.connectors ?? defaultConnectors` — `??` (not `||`) preserves an
  empty array, so "disable all" correctly yields an empty connector set rather than silently falling back
  to the full registry. This is the right operator for the documented edge case.
- **Default-on is load-bearing and tested:** `filterConnectors` keeps a connector unless
  `enabled === false`, and `connector-config.test.ts` covers absent-file, unknown-id, and absent-id — so
  a fresh install and any future new connector keep capturing.
- **Single conversion point:** `mapConnectorInfo` is the only `Connector → ConnectorInfo` mapping, and a
  serve test asserts it stays 1:1 with `ConnectorFidelity` — exactly as the plan required to prevent the
  inlined wire shape from drifting.
- **Leak-window discipline:** both new panels arm the `onControlEvent` unlisten before the first `await`
  resolves (`disposed` flag + immediate-unlisten), mirroring StatusBar — no leaked listener if the
  component unmounts during subscription.
- **Conflict #2 honored:** SyncHealth renders `snapshot.alerts` directly and imports only the alert
  *types*; `deriveAlerts` is not re-run client-side.
- **Version stamp bumped deliberately** (`m11-control-v2`) with the pin test updated — the tripwire works.

## Tests / Gate

- `npm run typecheck` (root `tsc -b`) — exit 0
- `npm run typecheck:desktop` — exit 0
- vitest (control-protocol + connector-config + serve) — 18 passed
- `cargo test` (src-tauri) — 5 passed (2 new proxy + 3 relay)
- `cargo build` — reqwest (`rustls-tls`) resolved + compiled
- `vite build -w @420ai/desktop` — 43 modules, no barrel breakage
- `npm run repo-health -- --require-db` — PASS; 311 tests, **73 integration tests ran, 0 skipped**

No finding blocks commit. The `connectors.set` validation gap (finding 1) is the only one with a
behavioral discrepancy worth addressing before sign-off, and it is a ~3-line guard.
