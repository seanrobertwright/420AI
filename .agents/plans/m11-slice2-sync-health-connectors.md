# Feature: M11 Slice 2 — Sync & Health + Connector Management

The following plan should be complete, but it's important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to naming of existing
utils, types, and models. Import from the right files.

> **Conventions are NOT re-pasted here.** The single source of truth is
> [`CLAUDE.md`](../../CLAUDE.md) (workspaces, TS/module rules, the "libraries never write to stdout"
> boundary, the **Frontend workspace** treatment, **token-never-in-webview**, and **Validation is a
> GATE**). Build background is [`SUMMARY.md`](../../SUMMARY.md); the milestone bundle plan is
> [`.agents/plans/m11-tauri-desktop.md`](./m11-tauri-desktop.md) (this is **Slice 2** of that bundle);
> the Slice-1 outcome is [`.agents/code-reviews/m11-slice1-walking-skeleton.md`](../code-reviews/m11-slice1-walking-skeleton.md).

## Feature Description

Slice 2 thickens the M11 desktop walking skeleton with two operational surfaces:

1. **Sync & Health panel** — the webview shows (a) the **local sidecar** capture status (state +
   pending/inflight, already streamed via Slice-1 `status` events) and (b) the **server-side**
   `LiveMonitorSnapshot` (machines/connectors/active-sessions + the already-derived operational
   **alerts**), fetched through a **Rust `#[command]` proxy** that holds the admin token — the webview
   never sees it (the M11 analog of the dashboard's server-side proxy invariant).
2. **Connector management** — **persisted per-connector enable/disable** (new, small collector
   surface) plus a read-only **fidelity + permission-scope review** (what each connector captures and
   which file globs it reads). Exposed over two new control-protocol commands (`connectors.list`,
   `connectors.set`) and a `Connectors.tsx` panel.

The **M3/M4 capture core stays untouched**: enablement is applied by **filtering the `connectors[]`
array passed into `runCaptureEngine`** (it already accepts a `connectors` option —
`capture-engine.ts:24,36`), never by mutating the registry or the watcher.

## User Story

```
As a developer running the 420AI collector desktop app
I want to see my sync backlog + operational alerts at a glance, and turn individual capture connectors
   on or off (and review exactly what each one reads)
So that I can steer capture and spot a stale/offline/failing collector without opening the web dashboard
   or a terminal
```

## Problem Statement

After Slice 1 the desktop shows only the local sidecar's capture state (running/paused, pending/inflight).
It cannot show the server's fleet view (machine liveness, connector health, **operational alerts**) that
the web dashboard surfaces, and there is **no way to enable/disable individual connectors** — capture is
all-or-nothing (`connectors` registry, `connector.ts:73`), with no visibility into which files each
connector reads.

## Solution Statement

Add a Rust `#[command] get_monitor_snapshot` that fetches the existing admin-gated `/v1/monitor` endpoint
with the admin token (Rust-held) and returns the JSON `LiveMonitorSnapshot` to the webview — mirroring
the dashboard's `app/api/monitor/route.ts` proxy, with Rust as the privileged hop. The `SyncHealth.tsx`
panel renders that snapshot's **server-derived `alerts`** (critical-first) beside the live local status.
For connectors, add a tiny persisted config (`~/.420ai/connectors.json`) + a pure
`load/save/filter` module, two new protocol commands, and a `Connectors.tsx` panel; `serve.ts` re-reads
the config at engine-start and passes the **filtered** connector list to the unchanged engine.

## Feature Metadata

**Feature Type**: Enhancement (Slice 2 of the M11 bundle)
**Estimated Complexity**: **Medium** (one new Rust dependency for the HTTP proxy; new but small collector
config surface; webview panels mirror the dashboard)
**Primary Systems Affected**: `apps/desktop` (Rust `proxy.rs` + 2 webview panels + bridge), `apps/collector`
(`serve.ts` + new `connector-config.ts`; capture core untouched), `packages/shared`
(`control-protocol.ts` — 2 commands + 1 event + a `ConnectorInfo` wire type + version bump).
**Dependencies**: **NEW Rust dep `reqwest`** (HTTP client for the proxy — must be added to
`apps/desktop/src-tauri/Cargo.toml` and resolved via `cargo build`). No new Node/npm dependency:
`deriveAlerts` and the monitor types already live in `@420ai/shared`.

---

## ⚠️ TWO CONFLICTS IN THE BUNDLE PLAN — RESOLVED HERE (read before coding)

The bundle plan (`m11-tauri-desktop.md`, Slice 2 rows) contains two loose instructions that are wrong or
ambiguous against the actual code. **These resolutions WIN over the bundle plan's wording:**

1. **The monitor proxy MUST use the ADMIN token, not the saved machine credentials.**
   The bundle plan says proxy `/monitor` "from keychain in Slice 3; **from saved creds for now**." But
   `/v1/monitor` is **admin-gated** (`apps/ingest/src/routes/monitor.ts:73` → `adminAuthorized`), and the
   saved `~/.420ai/credentials.json` `token` is the **per-machine ingest token**, which would get a
   **401** on that route. **Resolution:** Slice 2 sources the admin token + ingest URL exactly like the
   dashboard does — from **process env** read by Rust: `ADMIN_TOKEN` and `INGEST_URL`
   (default `http://localhost:8420`, mirroring `apps/dashboard/src/lib/ingest.ts:11-19`). If `ADMIN_TOKEN`
   is unset the command returns `Err("admin token not configured")` and the panel **degrades gracefully**
   (shows local sidecar status only + a one-line hint that the admin token/Settings land in a later slice).
   Slice 3/4 migrates `ADMIN_TOKEN` into the Windows Credential Manager + the Settings panel. **Do NOT
   pass `creds.token` to `/v1/monitor`.**

2. **Render the snapshot's server-derived `alerts`; do NOT re-run `deriveAlerts` in the webview.**
   The bundle plan says "run `deriveAlerts(snapshot)` in the webview." But `/v1/monitor` **already** folds
   alerts into the snapshot (`monitor.ts:55` `return { ...built, alerts: deriveAlerts(built) }`), and the
   dashboard's `AlertsPanel` renders `snapshot.alerts` **directly** (it imports only the alert *types*, not
   the function — `alerts-panel.tsx:1,40`). **Resolution:** mirror the dashboard — render `snapshot.alerts`.
   The "reuse `deriveAlerts`, no reimplementation" acceptance criterion is satisfied because the **server**
   ran the one canonical `deriveAlerts`. Re-running it client-side is redundant work over identical input.
   (Importing the `OperationalAlert`/`AlertSeverity` *types* from `@420ai/shared` is correct and expected.)

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**Shared contract (in the root `tsc -b` graph):**
- `packages/shared/src/control-protocol.ts` (whole file) — Why: the command/event unions +
  `CONTROL_PROTOCOL_VERSION` you extend. Pure types + a version const; **no runtime logic**. Already
  wildcard-exported from `index.ts:11`.
- `packages/shared/src/control-protocol.test.ts` (lines 16-18) — Why: the version-pin guard you must
  update to the new version (`m11-control-v2`).
- `packages/shared/src/monitor.ts` (lines 33-65) — Why: `LiveMonitorSnapshot`, `MachineStatusRow`,
  `ActiveSessionRow`, `MonitorStatus`. The proxy returns this shape; the panel consumes it.
- `packages/shared/src/alerts.ts` (lines 26-63) — Why: `OperationalAlert`, `AlertSeverity` (the *types* the
  panel imports). `deriveAlerts` is already run server-side — **do not call it in the webview** (Conflict #2).
- `packages/shared/src/projections.ts` (lines 60-68) — Why: `ConnectorHealthRow` (`sourceConnector`,
  `lastEventAt`, `eventCount`, `toolCalls`, `toolsFailed`, `models`) — the connector rows in the snapshot.

**Collector (in the root `tsc -b` graph):**
- `apps/collector/src/serve.ts` (whole file) — Why: the protocol loop you extend. Note the **seam pattern**
  (`ServeDeps` with injectable `runEngine`/`queueStats`/`loadCreds`/`exit`), the command `dispatch`/`handle`
  switch (lines 183-217), and `startEngine` (110-153) where the engine is spawned **without** a `connectors`
  option today (so it uses the full registry). stdout is **protocol-JSON-only**.
- `apps/collector/src/serve.test.ts` (whole file) — Why: the harness + fake-engine pattern you extend for
  the connector tests (injected streams, `statusIntervalMs:0`, exit seam).
- `apps/collector/src/connectors/connector.ts` (lines 32-77) — Why: `Connector`, `ConnectorFidelity`,
  `Liveness`, and the `connectors[]` registry. `watchGlobs(home)` is the "permission scope" to display.
  **There is NO enable/disable or config persistence today** — Slice 2 adds it alongside, not inside, this file.
- `apps/collector/src/capture-engine.ts` (lines 18-36) — Why: `CaptureEngineOptions.connectors?` already
  exists; `runCaptureEngine` does `opts.connectors ?? defaultConnectors` (line 36). **This is the seam** —
  pass the filtered list here; the engine is otherwise untouched.
- `apps/collector/src/identity.ts` (lines 17-23, 38-55) — Why: `COLLECTOR_HOME`, and the `save/load`
  **tolerant-read + path-seam** pattern to mirror for `connector-config.ts` (absent/corrupt → safe default).
- `apps/collector/src/watcher/file-watcher.ts` (lines 40-54) — Why: confirms the watcher simply iterates
  whatever `connectors[]` it is handed — so filtering upstream (in `serve.ts`/engine opts) is sufficient;
  no watcher change.

**Desktop Rust shell:**
- `apps/desktop/src-tauri/src/lib.rs` (whole file) — Why: where you `mod proxy;` and add the new command to
  `invoke_handler(tauri::generate_handler![...])`. **App-defined `#[command]`s need NO capability entry**
  (Slice-1 `send_command` works without one — capabilities gate *plugin/core* APIs, not your commands).
- `apps/desktop/src-tauri/src/sidecar.rs` (lines 159-177) — Why: the `write_command` + `#[command]`
  pattern to mirror for `get_monitor_snapshot`; the relay passes **opaque JSON** through, so a new
  `connectors` event needs **no Rust parser change** (`parse_event_line:196-205` already passes any object).
- `apps/desktop/src-tauri/Cargo.toml` (whole file) — Why: add the `reqwest` dependency here. Note there is
  **no HTTP client today** — `cargo build` must resolve the new dep (the validation step).
- `apps/desktop/src-tauri/capabilities/default.json` — Why: confirm you do **not** need to touch it (no
  webview `http:` permission — Rust makes the request via reqwest, not the webview).

**Desktop webview (OUT of root `tsc -b`; own `typecheck:desktop` lane):**
- `apps/desktop/src/lib/bridge.ts` (whole file) — Why: add a typed `getMonitorSnapshot()` invoke-wrapper +
  connector command/event helpers here. Mirrors `sendCommand`/`onControlEvent`.
- `apps/desktop/src/components/StatusBar.tsx` (lines 56-96) — Why: the **canonical webview patterns** —
  the `run()` `.catch` helper for invoke rejections, and the `onControlEvent` effect with the
  `disposed`+immediate-unlisten leak-window discipline. Reuse verbatim in the new panels.
- `apps/desktop/src/App.tsx` (whole file) — Why: mount the two new panels under `<StatusBar />`.
- `apps/desktop/src/components/ui/{card,table,badge}.tsx`, `src/lib/utils.ts` (`cn`) — Why: the hand-written
  primitives already copied in Slice 1; the new panels use these, NOT a fresh `shadcn init`.

**Dashboard — the pattern to mirror (read, do not edit):**
- `apps/dashboard/src/app/api/monitor/route.ts` (whole file) — Why: the proxy shape — fetch ingest with the
  admin header, `try/catch` (a refused upstream THROWS), map failure to a clean error. The Rust analog.
- `apps/dashboard/src/lib/ingest.ts` (lines 11-19) — Why: `INGEST_URL` default + `ADMIN_TOKEN` env sourcing —
  the exact env names + default the Rust proxy must reuse (Conflict #1).
- `apps/dashboard/src/components/monitor/alerts-panel.tsx` (whole file) — Why: **copy this component's
  structure** for the alerts table in `SyncHealth.tsx` (severity badge map, `formatAgo`, renders the
  `alerts` array). It imports only the alert *types*.
- `apps/dashboard/src/components/monitor/monitor-view.tsx` (lines 30-39, 133-172) — Why: the `STATUS_BADGE`
  map + the connector-health table layout to mirror for the snapshot's machines/connectors display.

### New Files to Create

- `apps/collector/src/connectors/connector-config.ts` — pure load/save/filter for per-connector enablement
  (`~/.420ai/connectors.json`), mirroring `identity.ts`'s tolerant-read + path-seam style.
- `apps/collector/src/connectors/connector-config.test.ts` — co-located vitest (no infra).
- `apps/desktop/src-tauri/src/proxy.rs` — the `get_monitor_snapshot` `#[command]` (reqwest → `/v1/monitor`).
- `apps/desktop/src/components/SyncHealth.tsx` — local status + server snapshot alerts/machines/connectors.
- `apps/desktop/src/components/Connectors.tsx` — per-connector enable/disable + fidelity + watch-glob review.

### Relevant Documentation — READ BEFORE IMPLEMENTING

- [Tauri v2 — Calling Rust from the Frontend](https://v2.tauri.app/develop/calling-rust/) — `#[command]`,
  async commands, `invoke`. Confirms app commands don't need a capability entry.
- [reqwest docs](https://docs.rs/reqwest/latest/reqwest/) — `Client::get(...).bearer_auth(token).send().await`
  + `.json::<serde_json::Value>()`. Use `features = ["json", "rustls-tls"], default-features = false`
  (rustls avoids an OpenSSL native build on Windows; works for both `http://localhost` and a future `https` archive).
- [Tauri v2 — Calling the Frontend from Rust (events)](https://v2.tauri.app/develop/calling-frontend/) —
  unchanged from Slice 1; the new `connectors` event rides the existing `control-event` relay.

### Patterns to Follow

**Tolerant config read (mirror `identity.ts:48-55`):** absent/corrupt file → a **safe default** (here:
"all connectors enabled" = today's behavior), never throw. Path is a **testability seam** (default const).

**Connector-config shape (new):**
```ts
// apps/collector/src/connectors/connector-config.ts
export interface ConnectorConfig {
  version: string;                                  // CONNECTOR_CONFIG_VERSION stamp (D11-style)
  connectors: Record<string, { enabled: boolean }>; // keyed by Connector.id; missing id ⇒ enabled (default-on)
}
// loadConnectorConfig(path?) → ConnectorConfig         (absent/corrupt ⇒ { version, connectors: {} })
// saveConnectorConfig(cfg, path?) → void               (mkdir + writeFileSync, like saveCredentials)
// filterConnectors(registry, cfg) → Connector[]        (keep c where cfg.connectors[c.id]?.enabled !== false)
```
> **Default-on is load-bearing:** an unknown/missing id MUST be treated as enabled so a fresh install (no
> file) and any future new connector keep capturing — matching today's all-enabled `connectors[]`.

**Control-protocol additions (`packages/shared/src/control-protocol.ts`):**
```ts
// A serializable connector descriptor for the webview (shared stays dependency-free — it can NOT import
// from apps/collector, so the fidelity fields are inlined here and the collector MAPS its Connector → this).
export interface ConnectorInfo {
  id: string;
  enabled: boolean;
  status: "stable" | "experimental" | "planned";
  captureMethod: string;
  liveness: "streaming" | "near-real-time" | "snapshot" | "batch";
  tokens: "exact" | "estimated" | "none";
  cost: "reported" | "computed" | "none";
  knownGaps: string[];
  watchGlobs: string[]; // resolved against home — the "permission scope" (which files it reads)
}
// add to ControlCommand:
//   | { cmd: "connectors.list" }
//   | { cmd: "connectors.set"; id: string; enabled: boolean; config?: Record<string, unknown> }
// add to ControlEvent:
//   | { type: "connectors"; connectors: ConnectorInfo[] }
export const CONTROL_PROTOCOL_VERSION = "m11-control-v2" as const; // bumped from v1
```
> **`config?` is reserved/forward-compat only** — no connector exposes tunable config today, so Slice 2
> **ignores it** (enable/disable is the concrete deliverable). Document it; do not build dead plumbing.
> The inlined fidelity fields must stay a 1:1 mirror of `ConnectorFidelity` (`connector.ts:32-43`); the
> collector's mapper (Task 5) is the single conversion point, and a serve test asserts the mapping.

**Rust proxy (`proxy.rs`) — mirror `app/api/monitor/route.ts` with Rust as the token-holder:**
```rust
#[tauri::command]
pub async fn get_monitor_snapshot() -> Result<serde_json::Value, String> {
    let token = std::env::var("ADMIN_TOKEN").map_err(|_| "admin token not configured".to_string())?;
    let base = std::env::var("INGEST_URL").unwrap_or_else(|_| "http://localhost:8420".to_string());
    let res = reqwest::Client::new()
        .get(format!("{base}/v1/monitor"))
        .bearer_auth(token)               // token never crosses to the webview
        .send().await.map_err(|e| format!("ingest unreachable: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("ingest error: {}", res.status()));
    }
    res.json::<serde_json::Value>().await.map_err(|e| format!("bad snapshot: {e}"))
}
```
> Returns opaque JSON (`serde_json::Value`) — Rust does NOT model the snapshot; the webview casts it to the
> `@420ai/shared` `LiveMonitorSnapshot` type. Never log `token`. (Token in env, never argv/disk/webview.)

**Webview panel patterns (mirror `StatusBar.tsx` + `alerts-panel.tsx`):**
- Invoke wrappers go through a `run()`/`.catch` so a rejected `invoke` surfaces as panel state, not an
  `unhandledrejection` (`StatusBar.tsx:56-59`).
- `onControlEvent` effects attach the listener and tear down with the `disposed`+immediate-unlisten guard
  (`StatusBar.tsx:61-96`).
- The alerts table copies `alerts-panel.tsx` (severity badge map, `formatAgo`, renders `snapshot.alerts`).

> **Spike-snippet fidelity:** the serve/SEA mechanics are unchanged from Slice 1 and remain governed by
> `docs/research/m11-control-protocol-spike.md` — Slice 2 only ADDS commands/events to the proven loop and
> bumps the version stamp. stdout stays protocol-JSON-only.

---

## IMPLEMENTATION PLAN

### Phase 1: Shared contract + collector config (foundation)

Extend the protocol (commands/event/`ConnectorInfo` + version bump) and add the pure connector-config
module + its tests. This is the dependency root — the serve handler and the webview both import these.

### Phase 2: Collector serve wiring

Teach `serve.ts` to answer `connectors.list`/`connectors.set` (persist via the config module, emit a
`connectors` event) and to re-read the config at engine start, passing the **filtered** list to
`runCaptureEngine`. Extend `serve.test.ts`.

### Phase 3: Desktop Rust proxy + webview panels (integration)

Add `proxy.rs` + `reqwest`, register the command, add bridge wrappers, build `SyncHealth.tsx` and
`Connectors.tsx`, mount both in `App.tsx`.

### Phase 4: Testing & validation

vitest (config + serve protocol), `cargo build`/`cargo test`, `typecheck:desktop`, `repo-health`
(incl. `--require-db` because the collector↔ingest capture path is touched), and the manual built-`.exe` smoke.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Each task is atomic and independently validatable.

### UPDATE `packages/shared/src/control-protocol.ts`
- **IMPLEMENT**: Add the `ConnectorInfo` interface; add `{ cmd: "connectors.list" }` and
  `{ cmd: "connectors.set"; id: string; enabled: boolean; config?: Record<string, unknown> }` to
  `ControlCommand`; add `{ type: "connectors"; connectors: ConnectorInfo[] }` to `ControlEvent`; bump
  `CONTROL_PROTOCOL_VERSION` to `"m11-control-v2"`. Add a short doc-comment on each, matching the file's style.
- **PATTERN**: the existing unions + the `MONITOR_VERSION`/`ALERT_VERSION` stamp style (`control-protocol.ts:31-64`).
- **IMPORTS**: none (pure types). It is already re-exported via `index.ts:11` — no index change.
- **GOTCHA**: keep the inlined fidelity fields a 1:1 mirror of `ConnectorFidelity` (`connector.ts:32-43`);
  do NOT import from `apps/collector` (shared is a leaf — that would be a dependency inversion).
- **VALIDATE**: `npm run typecheck` (exit 0).

### UPDATE `packages/shared/src/control-protocol.test.ts`
- **IMPLEMENT**: change the version-pin assertion to `"m11-control-v2"` (line 17); add a type-level case
  constructing a `connectors.set` command and a `connectors` event so the new fields are guarded.
- **PATTERN**: the existing `expectTypeOf`/discriminant tests (`control-protocol.test.ts:20-49`).
- **VALIDATE**: `npx vitest run packages/shared/src/control-protocol.test.ts` (pass).

### CREATE `apps/collector/src/connectors/connector-config.ts`
- **IMPLEMENT**: `CONNECTOR_CONFIG_VERSION` const; `CONNECTOR_CONFIG_PATH = join(COLLECTOR_HOME, "connectors.json")`;
  `ConnectorConfig` interface; `loadConnectorConfig(path?)` (tolerant — absent/corrupt ⇒
  `{ version: CONNECTOR_CONFIG_VERSION, connectors: {} }`); `saveConnectorConfig(cfg, path?)` (mkdir + write,
  mode 0o600); `filterConnectors(registry: Connector[], cfg: ConnectorConfig): Connector[]` keeping a
  connector unless `cfg.connectors[c.id]?.enabled === false` (**default-on**).
- **PATTERN**: `identity.ts:17-55` (path constant, tolerant load, `saveCredentials` write style). Library
  file — **no stdout, no exit**; throw on nothing (return safe default).
- **IMPORTS**: `readFileSync/writeFileSync/mkdirSync/existsSync` from `node:fs`; `join/dirname` from
  `node:path`; `COLLECTOR_HOME` from `../identity.js`; `type Connector` from `./connector.js`.
- **GOTCHA**: relative imports end in `.js` (NodeNext); use `import type` for `Connector`. Do NOT key off
  array index — key by `Connector.id`.
- **VALIDATE**: `npm run typecheck` (exit 0).

### CREATE `apps/collector/src/connectors/connector-config.test.ts`
- **IMPLEMENT**: assert (a) absent file ⇒ default with `connectors: {}` and `filterConnectors` returns the
  FULL registry (default-on); (b) save→load round-trips; (c) a config with `{ "codex-cli": { enabled:false } }`
  filters out only that connector; (d) an **unknown id** in config does not drop a real connector and a
  registry connector **absent** from config stays enabled. Use a temp path (e.g. `node:os` tmpdir + a unique
  filename) as the seam — no writes to the real `~/.420ai`.
- **PATTERN**: co-located vitest, path-seam injection (CLAUDE.md "Testing"; `identity` tests style).
- **GOTCHA**: build tiny fake `Connector` objects (only `id` matters) rather than importing the real registry,
  so the test is independent of how many connectors ship.
- **VALIDATE**: `npx vitest run apps/collector/src/connectors/connector-config.test.ts` (pass).

### UPDATE `apps/collector/src/serve.ts`
- **IMPLEMENT**:
  1. Add seams to `ServeDeps`: `connectorRegistry?: Connector[]` (default `defaultConnectors`),
     `loadConnectorConfig?: () => ConnectorConfig` (default the module fn), `saveConnectorConfig?: (c) => void`
     (default the module fn), `home?: string` (default `homedir()` — for `watchGlobs`).
  2. In `handle`, add cases:
     - `"connectors.list"` → emit a `{ type: "connectors", connectors }` event built from the registry +
       current config (map each `Connector` → `ConnectorInfo`, with `enabled = cfg.connectors[id]?.enabled !== false`
       and `watchGlobs = c.watchGlobs(home)`).
     - `"connectors.set"` → load cfg, set `cfg.connectors[id] = { enabled }`, `saveConnectorConfig(cfg)`,
       then emit the refreshed `connectors` event (so the UI reflects the persisted state). Emit `ack`.
  3. In `startEngine`, load the config + `filterConnectors(registry, cfg)` and pass `connectors: <filtered>`
     in the `runEngine({...})` options (the only engine-call change).
  4. Add a `mapConnectorInfo(c, enabled, home)` helper (single conversion point — Conflict mirror note).
- **PATTERN**: the existing `handle` switch (`serve.ts:183-217`) + `startEngine` (110-153). Engine seam is
  `CaptureEngineOptions.connectors` (`capture-engine.ts:24,36`).
- **IMPORTS**: `homedir` from `node:os`; `type Connector`, `connectors as defaultConnectors` from
  `./connectors/connector.js`; `loadConnectorConfig`, `saveConnectorConfig`, `filterConnectors`,
  `type ConnectorConfig` from `./connectors/connector-config.js`; `type ConnectorInfo` from `@420ai/shared`.
- **GOTCHA**: **stdout protocol-only** — the `connectors` event goes through `emit(...)`, never a raw write.
  Connector changes take effect on the **next engine start/resume** (`startEngine` re-reads); `connectors.set`
  while running persists + re-emits the list but does NOT hot-restart the engine (keep the state machine
  simple; an auto-restart-on-toggle is a deferred refinement — the panel will note "applies on next start").
- **VALIDATE**: `npm run typecheck` (exit 0); manual:
  `echo '{"cmd":"connectors.list"}' | npx tsx apps/collector/src/serve.ts` prints a `connectors` event line.

### UPDATE `apps/collector/src/serve.test.ts`
- **IMPLEMENT**: add cases — (a) `connectors.list` emits a `connectors` event listing all injected
  connectors with `enabled:true` by default; (b) `connectors.set {id, enabled:false}` → `ack` + a follow-up
  `connectors.list` shows that id `enabled:false`; (c) **filtering reaches the engine** — inject a spy
  `runEngine` that records `opts.connectors`, set one connector disabled, `start`, assert the spy received
  the filtered (shorter) list. Inject in-memory `loadConnectorConfig`/`saveConnectorConfig` (a closure over a
  local object) + a small `connectorRegistry` of fake connectors.
- **PATTERN**: the `makeHarness` overrides + fake-engine pattern (`serve.test.ts:25-99`).
- **GOTCHA**: keep `statusIntervalMs: 0`; the spy `runEngine` must idle on the abort signal like the existing
  fake (so `start` doesn't resolve instantly and flip to `error`).
- **VALIDATE**: `npx vitest run apps/collector/src/serve.test.ts` (all pass).

### UPDATE `apps/desktop/src-tauri/Cargo.toml`
- **IMPLEMENT**: add under `[dependencies]`:
  `reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }`.
- **GOTCHA**: `rustls-tls` (not the default native-tls) avoids an OpenSSL native build on Windows; `json`
  enables `.json()`. reqwest's async client runs on Tauri's tokio runtime (the `#[command]` is `async`).
- **VALIDATE**: `cd apps/desktop/src-tauri && cargo build` (resolves + compiles the new dep; `Cargo.lock` updates).

### CREATE `apps/desktop/src-tauri/src/proxy.rs`
- **IMPLEMENT**: `get_monitor_snapshot()` exactly per the Patterns snippet — `ADMIN_TOKEN`/`INGEST_URL` from
  env (default `http://localhost:8420`), reqwest GET `/v1/monitor` with `bearer_auth`, `Result<Value, String>`.
  Optionally add a pure unit-testable helper `fn monitor_url(base: &str) -> String` + a `#[cfg(test)]` test.
- **PATTERN**: `sidecar.rs` `#[command]` style (`sidecar.rs:174-177`) + `app/api/monitor/route.ts` semantics.
- **GOTCHA**: never log the token. Map a refused/!ok upstream to a clear `Err(String)` (the dashboard's 502
  analog) — the panel renders it. Do NOT model the snapshot in Rust (return opaque `serde_json::Value`).
- **VALIDATE**: `cargo build` (in `src-tauri`); `cargo test` if you added the url helper test.

### UPDATE `apps/desktop/src-tauri/src/lib.rs`
- **IMPLEMENT**: add `mod proxy;` and add `proxy::get_monitor_snapshot` to
  `tauri::generate_handler![sidecar::send_command, proxy::get_monitor_snapshot]`.
- **PATTERN**: the existing `invoke_handler` (`lib.rs:12`).
- **GOTCHA**: **no capability edit needed** — app commands are allowed by default (Slice-1 `send_command`
  has no capability entry yet works). Leave `capabilities/default.json` unchanged.
- **VALIDATE**: `cargo build` (in `src-tauri`).

### UPDATE `apps/desktop/src/lib/bridge.ts`
- **IMPLEMENT**: add `getMonitorSnapshot(): Promise<LiveMonitorSnapshot>` (`invoke("get_monitor_snapshot")`);
  add `listConnectors()` / `setConnector(id, enabled)` thin wrappers over `sendCommand({cmd:"connectors.list"})`
  / `sendCommand({cmd:"connectors.set", id, enabled})` (the `connectors` event arrives via the existing
  `onControlEvent` stream — no new listener channel).
- **PATTERN**: the existing `sendCommand`/`onControlEvent` (`bridge.ts:16-28`).
- **IMPORTS**: `invoke` from `@tauri-apps/api/core`; `type LiveMonitorSnapshot`, `type ControlCommand`,
  `type ControlEvent`, `type ConnectorInfo` from `@420ai/shared`.
- **GOTCHA**: cast the proxy result to `LiveMonitorSnapshot` (Rust returned opaque JSON). Use `import type`.
- **VALIDATE**: `npm run typecheck:desktop` (exit 0).

### CREATE `apps/desktop/src/components/SyncHealth.tsx`
- **IMPLEMENT**: a `Card` panel that (a) shows local sidecar state from the latest `status` event (reuse the
  StatusBar view-folding pattern, or lift shared state — for Slice 2 a small local `onControlEvent` effect is
  fine), and (b) on mount + on a refresh button, calls `getMonitorSnapshot()`, stores the snapshot, and renders
  **`snapshot.alerts`** in an alerts table (copy `alerts-panel.tsx`) + a compact machines/connectors summary
  (mirror `monitor-view.tsx` badge maps). On a rejected `getMonitorSnapshot` (e.g. admin token unset / ingest
  down), render the error string + the hint "server view needs ADMIN_TOKEN / Settings (later slice)".
- **PATTERN**: `alerts-panel.tsx` (alerts table, `formatAgo`, `SEVERITY_BADGE`); `monitor-view.tsx:30-39`
  (`STATUS_BADGE`); `StatusBar.tsx:56-96` (the `run()`/`.catch` + `disposed` listener discipline).
- **IMPORTS**: `getMonitorSnapshot`, `onControlEvent` from `@/lib/bridge`; `type LiveMonitorSnapshot`,
  `type OperationalAlert`, `type AlertSeverity`, `type MonitorStatus` from `@420ai/shared`; `cn` from
  `@/lib/utils`; the `Card`/`Table`/`Badge` primitives from `@/components/ui/*`.
- **GOTCHA**: **render `snapshot.alerts`; do NOT call `deriveAlerts`** (Conflict #2). `nowMs` for `formatAgo`:
  use `Date.now()` captured at render (the desktop is a live client; the dashboard injects it server-side —
  here client `Date.now()` is correct and fine).
- **VALIDATE**: `npm run typecheck:desktop` (exit 0).

### CREATE `apps/desktop/src/components/Connectors.tsx`
- **IMPLEMENT**: a `Card` panel that on mount calls `listConnectors()` and subscribes via `onControlEvent` for
  the `connectors` event; renders a `Table` row per `ConnectorInfo` with: id, a `status`/`liveness`/`tokens`/
  `cost` fidelity summary, the `knownGaps` (small text), the `watchGlobs` (the "permission scope" it reads),
  and an enable/disable toggle button calling `setConnector(id, !enabled)`. Show a small note: "changes apply
  when capture (re)starts."
- **PATTERN**: `StatusBar.tsx` (the `run()` + `disposed` listener effect); the dashboard connector table
  (`monitor-view.tsx:133-172`) for table layout.
- **IMPORTS**: `listConnectors`, `setConnector`, `onControlEvent` from `@/lib/bridge`; `type ConnectorInfo`,
  `type ControlEvent` from `@420ai/shared`; primitives + `cn`.
- **GOTCHA**: filter the `onControlEvent` stream to `ev.type === "connectors"`. Route the toggle through a
  `run()`/`.catch` helper (sidecar may be mid-restart). watchGlobs can be long — render in a muted, wrapping
  cell; do not truncate the path so the user can review the real scope.
- **VALIDATE**: `npm run typecheck:desktop` (exit 0).

### UPDATE `apps/desktop/src/App.tsx`
- **IMPLEMENT**: mount `<SyncHealth />` and `<Connectors />` under `<StatusBar />` (stack with the existing
  spacing; e.g. wrap in a `space-y-6` container).
- **PATTERN**: the current single-panel `App` (`App.tsx:8-20`).
- **VALIDATE**: `npm run typecheck:desktop` (exit 0); `npm run build -w @420ai/desktop` produces `dist/`.

### VALIDATE the gate (no new lane needed)
- **IMPLEMENT**: nothing to add — `typecheck:desktop` is already wired into `repo-health` (Slice 1); the
  shared/collector changes are in the root `tsc -b` graph + vitest. Confirm the gate is green.
- **GOTCHA**: Slice 2 touches the **collector capture path** (engine `connectors` filtering), so run the gate
  **with the DB up** so the `capture-engine.int.test.ts` layer actually runs (default = all enabled, so it
  must still pass). A green suite with int tests skipped is NOT evidence.
- **VALIDATE**: `npm run db:up && npm run db:migrate && npm run repo-health -- --require-db` — **PASS, int
  layer ran (0 skipped)**.

---

## TESTING STRATEGY

### Unit Tests (vitest, co-located)
- `connector-config.test.ts` — default-on, round-trip, disable-one, unknown-id/absent-id (default-on) — per Task 4.
- `serve.test.ts` (extended) — `connectors.list` event, `connectors.set` persistence, **filtered list reaches
  the engine spy** — per Task 6.
- `control-protocol.test.ts` (updated) — version pinned to `m11-control-v2` + new-field type guards.

### Rust Tests (`cargo test` in `apps/desktop/src-tauri`)
- The existing `parse_event_line` golden tests still pass (the new `connectors` event is an opaque object →
  passes through unchanged — assert nothing new is needed, or add one golden line for a `connectors` event).
- Optional: a pure `monitor_url(base)` helper test in `proxy.rs`.

### Webview
- The enforced `typecheck:desktop` lane (in `repo-health`). No webview unit-test runner this slice (mirrors
  the dashboard — typecheck + build only).

### Integration (must actually RUN — CLAUDE.md gate)
- `npm run repo-health -- --require-db` with `capture-engine.int.test.ts` running (0 skipped) — proves the
  filtered-connectors engine path still captures→queues→ingests→Postgres end-to-end.

### Edge Cases
- `connectors.json` absent ⇒ all connectors enabled (fresh install unchanged).
- A connector id present in config but **not** in the registry ⇒ ignored (no crash).
- A registry connector **absent** from config ⇒ enabled (default-on; future new connectors keep capturing).
- `connectors.set` while the engine is **running** ⇒ persists + re-emits; takes effect on next start/resume
  (panel notes this).
- `disable ALL` connectors then `start` ⇒ engine runs with an empty connector set (watcher finds nothing;
  no crash) — acceptable; the panel shows 0 enabled.
- `get_monitor_snapshot` with `ADMIN_TOKEN` unset ⇒ `Err("admin token not configured")` → panel degrades to
  local-status-only + hint (does NOT throw an unhandled rejection).
- `get_monitor_snapshot` with ingest down ⇒ `Err("ingest unreachable: ...")` → panel error line.
- The admin token never appears in any webview-reachable surface (assert in DevTools: no token string).
- Malformed `connectors.set` (missing `id`) ⇒ the serve `dispatch` `.catch` emits a `{type:"error"}`, loop survives.

---

## VALIDATION COMMANDS

All runnable from the repo root. Each is a GATE.

### Level 1: Syntax & Style / Typecheck
- `npm run typecheck` — root `tsc -b`, **exit 0** (shared + collector incl. `serve.ts`/`connector-config.ts`).
- `npm run typecheck:desktop` — webview `tsc --noEmit`, **exit 0** (root `tsc -b` cannot see these).

### Level 2: Unit Tests
- `npx vitest run packages/shared/src/control-protocol.test.ts apps/collector/src/connectors/connector-config.test.ts apps/collector/src/serve.test.ts`
  — **all pass**.
- `cd apps/desktop/src-tauri && cargo test` — **pass** (relay parser golden cases + optional url helper).

### Level 3: Integration / Full Gate
- `npm run repo-health` — **PASS** (includes the desktop typecheck lane).
- `npm run db:up && npm run db:migrate && npm run repo-health -- --require-db` — **PASS, the `*.int.test.ts`
  layer ran, 0 skipped** (proves the filtered-connector capture path still works end-to-end).

### Level 4: Manual / Build Validation (local, Windows)
- `npm run build:collector-sea` then launch `npm run build:desktop`; with `ADMIN_TOKEN`/`INGEST_URL` set and
  ingest running:
  - Sync & Health renders the snapshot's alerts + machines/connectors; with `ADMIN_TOKEN` unset it degrades
    to local-status + hint (no crash).
  - Connectors panel lists each connector with fidelity + watch globs; toggling one persists to
    `~/.420ai/connectors.json` and the disabled connector is skipped on the next Start (verify by watching
    `pending` / the captured set).
  - DevTools: the admin token string appears **nowhere** in webview-reachable surfaces.

### Level 5: Additional (optional)
- `cd apps/desktop/src-tauri && cargo clippy` — no warnings (advisory; not in the CI gate).

---

## ACCEPTANCE CRITERIA

- [ ] Sync & Health panel renders the server `LiveMonitorSnapshot`'s **`alerts`** (critical-first) + a
      machines/connectors summary, fetched via the **Rust proxy** (token never in the webview), and degrades
      gracefully when `ADMIN_TOKEN` is unset / ingest is down.
- [ ] The proxy uses the **admin** token from env (`ADMIN_TOKEN`/`INGEST_URL`) — NOT the machine creds
      (Conflict #1); the webview never receives the token.
- [ ] `deriveAlerts` is NOT reimplemented and NOT re-run client-side — the panel renders the
      server-derived `snapshot.alerts` (Conflict #2).
- [ ] Per-connector enable/disable is **persisted** (`~/.420ai/connectors.json`), **default-on** for unknown/
      absent ids, and applied by **filtering the engine's `connectors[]`** — the M3/M4 capture core is unchanged.
- [ ] `connectors.list`/`connectors.set` round-trip over the protocol; `CONTROL_PROTOCOL_VERSION` bumped to
      `m11-control-v2` (+ the test pin updated); the Rust relay needs no parser change.
- [ ] The Connectors panel shows fidelity + **watch globs** (permission-scope review).
- [ ] `npm run typecheck`, `typecheck:desktop`, the listed vitest files, and `cargo build`/`cargo test` all pass.
- [ ] `npm run repo-health -- --require-db` PASSES with the int layer ran (0 skipped).
- [ ] No artifacts staged (SEA `.exe`, Rust `target/`, webview `dist/` all gitignored).

## COMPLETION CHECKLIST

- [ ] All tasks completed in order; each VALIDATE ran and passed immediately.
- [ ] `npm run repo-health` (and `--require-db` at sign-off) PASS.
- [ ] No linting/type errors (root + desktop lanes); `cargo build`/`cargo test` clean.
- [ ] Manual smoke of the built `.exe`: Sync & Health + Connectors panels work; token not in webview.
- [ ] Acceptance criteria all met.
- [ ] Commit independently (this is one slice); the bundle plan's later slices (3–5) are untouched.

## NOTES

**Design decisions locked for this slice:**
1. **Admin token via env (`ADMIN_TOKEN`/`INGEST_URL`), Rust-held** — the only correct source for the
   admin-gated `/v1/monitor` (Conflict #1). Keychain + Settings migration is Slice 3/4.
2. **Render server-derived `snapshot.alerts`** (Conflict #2) — single source of truth, identical to the dashboard.
3. **Connector enablement = a filter over `connectors[]`** (engine seam already exists) — capture core untouched.
4. **`config?` field reserved, not implemented** — no connector exposes tunable config today; enable/disable
   is the concrete deliverable.
5. **Toggle applies on next engine start/resume** — no hot-restart-on-toggle (state-machine simplicity);
   auto-restart is a deferred refinement.

**Deferred to later slices:** GUI pairing + keychain secret storage (Slice 3) — so the admin token lives in
env for now; full Settings (incl. `ADMIN_TOKEN`/`INGEST_URL` management) + server supervision (Slice 4);
per-connector tunable config + a recent-window connector-failure rate (vs the current lifetime ratio in
`alerts.ts:38-48`).

**Risks:** (1) `reqwest` is the one genuinely new dependency — `cargo build` is the resolution check; using
`rustls-tls` avoids the Windows OpenSSL pitfall. (2) The protocol version bump means the Rust serde mirror /
any pinned consumer must move with it — the relay is schema-agnostic (opaque JSON pass-through), so this is
low risk, but the version-pin test enforces deliberateness. (3) Connector-config default-on is load-bearing —
the unit test must cover unknown/absent ids or a future new connector could silently stop capturing.

**Confidence (one-pass for Slice 2): 8/10.** The webview panels mirror the dashboard almost verbatim, the
engine `connectors` seam already exists, and the protocol extension is additive over a proven loop. The −2 is
the new `reqwest` dependency (first Rust HTTP surface) and the small new collector config module — both
well-bounded and unit-tested, but new.
