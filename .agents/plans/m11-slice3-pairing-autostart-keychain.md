# Feature: M11 Slice 3 — GUI Pairing & Autostart + Keychain Secrets

The following plan should be complete, but it's important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to naming of existing
utils, types, and models. Import from the right files.

> **Conventions are NOT re-pasted here.** The single source of truth is
> [`CLAUDE.md`](../../CLAUDE.md) (workspaces, TS/module rules, the "libraries never write to stdout"
> boundary, the **Frontend workspace** treatment, **token-never-in-webview**, and **Validation is a
> GATE**). Build background is [`SUMMARY.md`](../../SUMMARY.md); the milestone bundle plan is
> [`.agents/plans/m11-tauri-desktop.md`](./m11-tauri-desktop.md) (this is **Slice 3** of that bundle);
> the Slice-2 plan is [`.agents/plans/m11-slice2-sync-health-connectors.md`](./m11-slice2-sync-health-connectors.md).

## Feature Description

Slice 3 gives the desktop app a **graphical pairing flow**, **OS-keychain secret storage**, and
**run-on-login**, so a non-terminal user can connect the collector to an archive and have it start
automatically — with the ingest token kept in the **Windows Credential Manager**, never in a plaintext
file and never reachable from the webview.

Three deliverables:

1. **GUI pairing** — a `Pairing.tsx` panel collects the archive **URL + pairing code + machine name**.
   A Rust `#[command] pair(...)` POSTs the (unauthenticated) `/v1/pair` endpoint via the already-present
   `reqwest`, receives `{token, machineId}`, **stores it in the Windows Credential Manager**, returns
   only `{machineId}` to the webview, and injects the credentials into the running sidecar via the
   **already-implemented** `configure` control command. The token is **born in Rust and never crosses
   stdout or the webview**.
2. **Keychain secret storage** — a Rust `keychain.rs` over the `keyring` crate (Windows-native backend)
   stores/loads/clears the credentials blob. On every sidecar (re)spawn, Rust reads the keychain and, if
   present, auto-`configure`s the sidecar (so capture survives restarts without re-pairing).
3. **Autostart** — `tauri-plugin-autostart` + two Rust `#[command]`s (`get_autostart`/`set_autostart`)
   wrap the `HKCU\…\Run` registry mechanism; a toggle on the Pairing panel turns run-on-login on/off.

The **CLI pairing path is untouched**: `collector pair` + `~/.420ai/credentials.json` (plaintext, mode
0600) still work for headless/server use. The GUI path is an *alternative* that writes no plaintext token.

## User Story

```
As a developer running the 420AI collector desktop app
I want to pair with my archive from a window (URL + code), have the token kept in the Windows keychain,
   and have the collector launch on login
So that I never touch a terminal to connect, my ingest token is never a plaintext file, and capture
   resumes automatically after a reboot
```

## Problem Statement

After Slice 2 the desktop app can drive capture, show fleet health/alerts, and manage connectors — but
pairing is still **CLI-only** (`collector pair <code>`, `cli.ts`), the ingest token lives in **plaintext**
`~/.420ai/credentials.json` (`identity.ts:38-42`), and there is **no run-on-login**. A non-terminal user
cannot connect the collector at all, and the token-on-disk is the one place the desktop story violates the
repo's "secrets outside untrusted surfaces" posture (PRD §18; CLAUDE.md token discipline).

## Solution Statement

Keep the proven Node capture core and the M2 ingest contract **unchanged**. Add three thin, Rust-owned
OS-native surfaces (mirroring the Slice-2 `proxy.rs` token-holder pattern): a keychain module, a pairing
`#[command]` that does the HTTP handshake in Rust and stores the token in the keychain, and autostart
`#[command]`s. The sidecar receives credentials only through the **existing in-memory `configure` stdin
command** (`serve.ts:239-247`), so the token never touches a file or the webview. The webview adds a
`Pairing.tsx` panel + bridge wrappers. **No control-protocol change and no version bump** — `configure`,
`pair`, and `paired` already exist in the schema (`control-protocol.ts:31-41,79`), and the GUI path uses
the Rust `#[command]`, not the sidecar `pair` command.

## Feature Metadata

**Feature Type**: Enhancement (Slice 3 of the M11 bundle)
**Estimated Complexity**: **Medium** (two genuinely-new Rust deps — both **pre-flight-spike-verified**;
new but small Rust surface; one new webview panel)
**Primary Systems Affected**: `apps/desktop` (Rust: `keychain.rs` + `pairing.rs` + `autostart.rs` +
`Cargo.toml` + `lib.rs` + `sidecar.rs` auto-configure hook; webview: `bridge.ts` + `Pairing.tsx` +
`App.tsx`). **No change to `apps/collector` or `packages/shared`** (so the root `tsc -b` graph is
untouched — see Conflict #1).
**Dependencies**: **NEW Rust deps** — `keyring = { version = "3", default-features = false, features =
["windows-native"] }` (v3.6.3) and `tauri-plugin-autostart = "2"` (v2.5.1). **Both were added,
compiled, and (keyring) round-tripped against the Windows Credential Manager in a pre-flight spike on
this machine** (see "PRE-FLIGHT SPIKE — RESULTS"). No new Node/npm dependency: `reqwest` is already in
`Cargo.toml` (Slice 2), and autostart is called from Rust so the `@tauri-apps/plugin-autostart` npm
package is **not** needed.

---

## ⚠️ THREE RESOLUTIONS THAT WIN OVER THE BUNDLE PLAN (read before coding)

The bundle plan (`m11-tauri-desktop.md`, Slice 3 rows) predates Slices 1–2 being built and contains
instructions that are now wrong or contradictory against the shipped code. **These resolutions WIN:**

1. **Pairing runs in RUST (reqwest), NOT in the sidecar.** The bundle plan says "serve handles
   `{cmd:'pair'}` → `runPair(persist:false)` → emit `{type:'paired', machineId}` … Rust persists the
   token to the keychain." This has an unfixable gap: the relay (`sidecar.rs:96`) forwards **every**
   sidecar stdout object to the webview, so a token emitted on stdout would reach the webview. There is
   **no channel** from the sidecar to Rust that doesn't cross that relay. **Resolution (user-confirmed):**
   the webview calls a Rust `#[command] pair(url, code, name)`; Rust POSTs the **unauthenticated**
   `/v1/pair` (`pair.ts:15-18` — "the code IS the credential, no bearer") via `reqwest`, stores the
   `{url, token, machineId}` blob in the keychain, returns **only `{machineId}`** to the webview, and
   injects the creds into the sidecar via the existing `configure` command. The token is born in Rust and
   never touches stdout/the webview/disk. The sidecar's `pair` command **stays reserved/unsupported**
   (`serve.ts:283-285` already returns a clean "not supported" error) — do NOT implement it.

2. **NO control-protocol change and NO version bump.** The bundle plan's Slice-2 note said "bump
   `CONTROL_PROTOCOL_VERSION` if you add commands." Slice 3 adds **zero** protocol commands/events:
   `configure` (`control-protocol.ts:32`) is already implemented in `serve.ts:239-247`, and `pair`/`paired`
   already exist as reserved members. Pairing and autostart are Rust `#[command]`s (the webview↔Rust IPC
   layer, `invoke`), **not** sidecar control commands. **Leave `control-protocol.ts` and
   `CONTROL_PROTOCOL_VERSION = "m11-control-v2"` exactly as-is.** Consequently the **root `tsc -b` graph
   (`packages/shared` + `apps/collector`) is UNCHANGED by this slice** — the only TS edits are in the
   `apps/desktop` webview (its own `typecheck:desktop` lane).

3. **Keychain = the `keyring` crate used DIRECTLY from Rust, NOT a Tauri plugin.** The bundle plan listed
   "`tauri-plugin-keyring` **or** Stronghold." Stronghold is an *encrypted file vault*, not the OS
   keychain (diverges from PRD/CLAUDE.md "Windows Credential Manager"); `tauri-plugin-keyring` exposes the
   keychain to the *webview*, which we explicitly do not want. **Resolution (user-confirmed):** add the
   `keyring` crate as a direct Rust dependency; Rust owns the secret and the webview never calls it, so
   **no Tauri plugin and no `keyring`/`autostart` capability entry are needed** (app-defined `#[command]`s
   are allowed by default — confirmed by Slice 1's `send_command` working with no capability entry).

---

## PRE-FLIGHT SPIKE — RESULTS (verified on this machine, do not re-litigate)

A throwaway spike (added the deps + a scratch `spike.rs`, built, ran a keychain test, then fully reverted
— nothing committed) **empirically confirmed** the two new deps on Windows 11 / cargo 1.95 against the
existing tauri v2 stack:

- `cargo add keyring --no-default-features --features windows-native` → resolved **keyring v3.6.3**
  (cargo reported "available: v4.0.1" — **we intentionally pin v3**, see Gotcha below).
- `cargo add tauri-plugin-autostart` → resolved **v2.5.1** (+ transitive `auto-launch v0.5.0`,
  `winreg v0.10.1`, `dirs v4.0.0`).
- `cargo build` → **Finished in 23.7s** (warm `target/`); no errors against `tauri = "2"`,
  `tauri-plugin-shell`, `reqwest 0.12 rustls-tls`.
- `cargo test` of a keychain round-trip (`Entry::new` → `set_password` → `get_password` → assert eq →
  `delete_credential`) → **`test … keychain_set_get_delete_roundtrips … ok`** — the secret really
  persisted to and read back from the **Windows Credential Manager**, and the existing 5 Rust tests
  (`parse_event_line`, `monitor_url`) still passed.

> **The plan therefore commits to verified versions and the verified v3 API.** If `cargo add` later
> pulls a different major, STOP and reconcile against this spike result.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**The ingest pairing contract (read, do not edit — Rust mirrors it):**
- `apps/ingest/src/routes/pair.ts` (whole file) — Why: `POST /v1/pair` is **unauthenticated** (line 12-14
  comment: "the code IS the credential — no bearer"); body `{ code, machine }`, success `200 {token,
  machineId}`, an expired/invalid code → **`410`** (line 35-37). The Rust `pair` command mirrors exactly
  this request/response and maps non-2xx → `Err`.
- `packages/shared/src/ingest.ts` (lines 49-57) — Why: `PairRequest { code: string; machine: { name:
  string; os?: string; hostname?: string } }` and `PairResponse { token: string; machineId: string }`.
  The Rust serde structs mirror these field names **exactly** (serde is case-sensitive; use `machineId`,
  not `machine_id`, via `#[serde(rename_all = "camelCase")]` or explicit renames).
- `apps/collector/src/ingest-client.ts` (lines 48-56) — Why: `postPair` is the Node analog (URL is
  `${base}/v1/pair`, trailing-slash trimmed); the Rust command reproduces this URL shape. **Do NOT call
  this from Rust** — Rust re-implements the single POST (the contract is two fields each).

**The credentials seam (read — Rust replaces the GUI path's storage):**
- `apps/collector/src/identity.ts` (whole file) — Why: `Credentials { url, token, machineId }`,
  `loadCredentials`/`saveCredentials` (plaintext, mode 0600), `COLLECTOR_HOME`. The **CLI path is
  unchanged**; the GUI path must NOT call `saveCredentials` (no plaintext token). The keychain stores the
  same three fields.
- `apps/collector/src/serve.ts` (lines 105-128, 239-247, 341) — Why: `configure` is **already
  implemented** (239-247: sets in-memory `creds`, acks). `loadCreds` defaults to `loadCredentials()` so a
  pre-existing CLI `credentials.json` still configures the sidecar; a Rust `configure` **overrides** it.
  `ready.paired` (341) is `Boolean(creds)` at boot — it reflects `credentials.json` only, NOT the keychain
  (so the Pairing panel reads keychain state via a Rust command, see Gotcha). **No serve.ts edit in this
  slice.**

**Desktop Rust shell (the surfaces you extend):**
- `apps/desktop/src-tauri/src/proxy.rs` (whole file) — Why: **the exact reqwest pattern to mirror** for
  the pairing command — `reqwest::Client::builder().timeout(..).redirect(Policy::none()).build()`,
  `.send().await.map_err(|e| format!("ingest unreachable: {e}"))`, `if !res.status().is_success() {
  return Err(...) }`, `res.json::<T>().await.map_err(...)`. Also the pure-helper + `#[cfg(test)]` pattern
  (`monitor_url` + 2 tests) to mirror for a `pair_url(base)` helper. **`#[command]` async, returns
  `Result<_, String>`; token never logged.**
- `apps/desktop/src-tauri/src/sidecar.rs` (lines 36-143, 82-97, 159-168) — Why: `write_command(app, json)`
  (159-168) writes one JSON line to the sidecar stdin — this is how Rust sends `configure`. The relay's
  `Stdout` branch (91-97) parses each line; you add the **auto-configure-on-`ready`** hook here (parse the
  event; if `type=="ready"` and the keychain has creds, `write_command(configure)`). `store_child`
  (145-149) is already called before the read loop, so the child stdin handle exists when `ready` arrives.
- `apps/desktop/src-tauri/src/lib.rs` (whole file) — Why: where you `.plugin(tauri_plugin_autostart::
  init(...))`, add `mod keychain; mod pairing; mod autostart;`, and append the new commands to
  `tauri::generate_handler![sidecar::send_command, proxy::get_monitor_snapshot, …]`.
- `apps/desktop/src-tauri/src/tray.rs` (whole file) — Why: confirms the tray is built once in `setup`; no
  tray change this slice (autostart is a webview toggle, not a tray item — keep the tray menu as-is).
- `apps/desktop/src-tauri/Cargo.toml` (whole file) — Why: add the two new deps under `[dependencies]`
  (after `reqwest`, line 26). `reqwest` is already present.
- `apps/desktop/src-tauri/capabilities/default.json` — Why: **confirm you do NOT touch it.** No
  `autostart:` permission, no extra `shell:` permission — the new commands are app-defined and
  autostart is called from Rust (Conflict #3).

**Desktop webview (OUT of root `tsc -b`; its own `typecheck:desktop` lane):**
- `apps/desktop/src/lib/bridge.ts` (whole file) — Why: add typed `invoke` wrappers: `pair(url, code,
  name)`, `getPairingStatus()`, `getAutostart()`, `setAutostart(enabled)`. Mirrors the existing
  `getMonitorSnapshot` wrapper (lines 36-38).
- `apps/desktop/src/components/StatusBar.tsx` (lines 53-96) — Why: **the canonical webview patterns** to
  reuse verbatim — the `run()` `.catch` helper for rejected invokes (53-59) and the `onControlEvent`
  effect with the `disposed`+immediate-unlisten leak-window discipline (61-96). The Card/Badge/Button
  primitives + the `ControlButton`/`Stat` sub-components (139-167) show the styling idiom.
- `apps/desktop/src/components/SyncHealth.tsx` — Why: the Slice-2 panel that already calls a Rust
  `#[command]` (`getMonitorSnapshot`) through `run()`/`.catch` and degrades on `Err` — mirror its
  error-surface shape for the pairing call.
- `apps/desktop/src/App.tsx` (whole file) — Why: mount `<Pairing />` in the `space-y-6` stack (lines
  21-25). Place it **above** `<StatusBar />` (pairing precedes capture in the flow).
- `apps/desktop/src/components/ui/{card,table,badge}.tsx`, `src/lib/utils.ts` (`cn`) — Why: the
  hand-written primitives already copied in Slice 1; the Pairing panel uses these, NOT a fresh
  `shadcn init`.

### New Files to Create

- `apps/desktop/src-tauri/src/keychain.rs` — `keyring`-backed store/load/clear of the `{url, token,
  machineId}` blob; constants for the service/user; a `#[cfg(test)]` round-trip test.
- `apps/desktop/src-tauri/src/pairing.rs` — `#[command] pair(...)` (reqwest → keychain → `configure`),
  `#[command] get_pairing_status()` (reads keychain), a pure `pair_url(base)` helper + tests.
- `apps/desktop/src-tauri/src/autostart.rs` — `#[command] get_autostart(app)` / `#[command]
  set_autostart(app, enabled)` over `tauri_plugin_autostart::ManagerExt`.
- `apps/desktop/src/components/Pairing.tsx` — the pairing form (URL + code + name) + paired-state display
  + the run-on-login toggle.

### Relevant Documentation — READ BEFORE IMPLEMENTING

- [keyring v3 docs](https://docs.rs/keyring/3.6.3/keyring/) — `Entry::new(service, user)`,
  `set_password`/`get_password`/**`delete_credential`** (renamed from v2's `delete_password`),
  `Error::NoEntry`. **Pin v3** (see Gotcha).
- [Tauri v2 Autostart plugin](https://v2.tauri.app/plugin/autostart/) — `init(MacosLauncher, Option<Vec<
  &str>>)` registration; `use tauri_plugin_autostart::ManagerExt;` → `app.autolaunch().enable()/.disable()
  /.is_enabled()`.
- [Tauri v2 — Calling Rust from the Frontend](https://v2.tauri.app/develop/calling-rust/) — `#[command]`,
  async commands, `invoke`. Confirms app commands need no capability entry.
- [reqwest 0.12](https://docs.rs/reqwest/0.12/reqwest/) — `Client::post(url).json(&body).send().await` +
  `.json::<T>()`. **Non-2xx does NOT error** — check `.status().is_success()` (as `proxy.rs:43` does).
- `apps/ingest/src/routes/pair.ts` — the live contract the Rust command targets (already listed above).

### Patterns to Follow

**Rust reqwest command (mirror `proxy.rs:28-49`, with POST + json body):**
```rust
#[tauri::command]
pub async fn pair(app: tauri::AppHandle, url: String, code: String, name: String)
    -> Result<PairResult, String>
{
    let body = PairRequest {
        code,
        machine: Machine { name, os: Some(std::env::consts::OS.to_string()),
                           hostname: std::env::var("COMPUTERNAME").ok() },
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build().map_err(|e| format!("http client init failed: {e}"))?;
    let res = client.post(pair_url(&url)).json(&body).send().await
        .map_err(|e| format!("ingest unreachable: {e}"))?;
    if !res.status().is_success() {
        // /v1/pair returns 410 for an expired/invalid code (pair.ts:35-37)
        return Err(format!("pairing failed: HTTP {}", res.status()));
    }
    let paired: PairResponse = res.json().await.map_err(|e| format!("bad pair response: {e}"))?;
    // Store the secret in the OS keychain — NEVER on disk, NEVER returned to the webview.
    keychain::store(&Stored { url: trim(&url), token: paired.token, machine_id: paired.machine_id.clone() })?;
    // Inject into the running sidecar (the already-implemented `configure` command).
    let _ = sidecar::write_command(&app, serde_json::json!({
        "cmd": "configure", "url": trim(&url), "token": "<from keychain, not here>", "machineId": paired.machine_id
    })); // NOTE: read the token back from keychain to build this — do not keep it in a long-lived var; see Task 4
    Ok(PairResult { machine_id: paired.machine_id }) // token intentionally absent
}
```
> Assertion (spike): `reqwest 0.12 default-features=false features=["json","rustls-tls"]` does async POST
> + JSON parse on Tauri's tokio runtime. **4xx/5xx is NOT an error** — the explicit `is_success()` check is
> load-bearing (a 410 would otherwise fall through to a JSON-parse error).

**Keychain blob (one JSON entry, `keychain.rs`):**
```rust
use keyring::Entry;
const SERVICE: &str = "ai.420.desktop";   // matches the app identifier
const USER: &str = "ingest-credentials";  // non-empty (empty is a wildcard on macOS — keep portable)

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct Stored { pub url: String, pub token: String,
    #[serde(rename = "machineId")] pub machine_id: String }

pub fn store(c: &Stored) -> Result<(), String> {
    let json = serde_json::to_string(c).map_err(|e| e.to_string())?;
    Entry::new(SERVICE, USER).map_err(|e| e.to_string())?
        .set_password(&json).map_err(|e| e.to_string())
}
pub fn load() -> Option<Stored> {
    let e = Entry::new(SERVICE, USER).ok()?;
    let json = e.get_password().ok()?;     // Err(NoEntry) when unpaired → None
    serde_json::from_str(&json).ok()
}
pub fn clear() -> Result<(), String> {
    Entry::new(SERVICE, USER).map_err(|e| e.to_string())?
        .delete_credential().map_err(|e| e.to_string())  // v3 name, NOT delete_password()
}
```
> Assertion (spike): this exact `Entry::new/set_password/get_password/delete_credential` shape compiled on
> keyring **v3.6.3 + features=["windows-native"]** and round-tripped through the Windows Credential
> Manager. A single small JSON blob is well under the ~2560-byte CredMan limit.

**Autostart commands (`autostart.rs`):**
```rust
use tauri_plugin_autostart::ManagerExt;
#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let m = app.autolaunch();
    if enabled { m.enable() } else { m.disable() }.map_err(|e| e.to_string())
}
```
> Assertion (spike): `ManagerExt` + `app.autolaunch().enable()/.disable()/.is_enabled()` compiled against
> `tauri-plugin-autostart v2.5.1`. The plugin must be registered in the builder
> (`init(MacosLauncher::LaunchAgent, None)`) or `autolaunch()` panics at runtime.

**Webview invoke wrappers (mirror `bridge.ts:36-38`):**
```ts
import { invoke } from "@tauri-apps/api/core";
export interface PairResult { machineId: string }                 // NB: no `token` field — by design
export interface PairingStatus { paired: boolean; machineId: string | null }
export function pair(url: string, code: string, name: string): Promise<PairResult> {
  return invoke<PairResult>("pair", { url, code, name });
}
export function getPairingStatus(): Promise<PairingStatus> { return invoke("get_pairing_status"); }
export function getAutostart(): Promise<boolean> { return invoke("get_autostart"); }
export function setAutostart(enabled: boolean): Promise<void> { return invoke("set_autostart", { enabled }); }
```

**Webview panel (mirror `StatusBar.tsx:53-96` for `run()`/`.catch` + the effect):** every `invoke` goes
through a `run()` helper so a rejection becomes panel state, not an `unhandledrejection`; read
`getPairingStatus()`/`getAutostart()` on mount inside the leak-safe effect.

---

## IMPLEMENTATION PLAN

### Phase 1: Rust dependencies + keychain (foundation)

Add the two spike-verified deps, register the autostart plugin, and create the keychain module + its
round-trip test. This is the dependency root for pairing and autostart.

### Phase 2: Rust pairing + autostart commands

Add `pairing.rs` (reqwest → keychain → `configure`) and `autostart.rs`, register all new commands in
`lib.rs`, and add the auto-configure-on-`ready` hook in `sidecar.rs` so a (re)spawned sidecar picks up
keychain creds.

### Phase 3: Webview integration

Add the bridge wrappers, build `Pairing.tsx` (form + paired-state + autostart toggle), mount it in
`App.tsx`.

### Phase 4: Testing & validation

`cargo build`/`cargo test` (keychain round-trip + `pair_url` helper), `typecheck:desktop`, `repo-health`
(unchanged root graph still green), and the manual built-`.exe` smoke (pair, keychain, no-plaintext,
restart-resume, autostart toggle, token-not-in-webview).

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Each task is atomic and independently validatable.

### UPDATE `apps/desktop/src-tauri/Cargo.toml`
- **IMPLEMENT**: under `[dependencies]` (after `reqwest`, line 26) add:
  `keyring = { version = "3", default-features = false, features = ["windows-native"] }` and
  `tauri-plugin-autostart = "2"`.
- **PATTERN**: the existing dep block (`Cargo.toml:18-26`); the inline-comment style for non-obvious flags.
- **GOTCHA**: **pin `version = "3"`** — `cargo` reports v4.0.1 available, but v4 split into
  `keyring-core` + separate store crates with **no default store** (every call silently no-ops without a
  `set_default_store()` startup call). v3.6.3 is the spike-verified line. `default-features = false` +
  explicit `windows-native` is required (v3 with **no** backend feature falls back to an in-memory **mock**
  store that "succeeds" but persists nothing).
- **VALIDATE**: `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml` (resolves keyring v3.6.3 +
  tauri-plugin-autostart v2.5.1; compiles — though `autolaunch()` isn't wired until lib.rs is updated).

### CREATE `apps/desktop/src-tauri/src/keychain.rs`
- **IMPLEMENT**: the `Stored` struct (`url`, `token`, `machineId` via `#[serde(rename)]`), `SERVICE`/`USER`
  consts, and `store(&Stored) -> Result<(),String>`, `load() -> Option<Stored>`, `clear() ->
  Result<(),String>` exactly per the Patterns snippet. Add a `#[cfg(test)]` round-trip test using a
  **distinct test service name** (e.g. `"ai.420.desktop.test"`) so it never clobbers a real credential:
  store → load → assert eq → clear → assert `load()` is `None`.
- **PATTERN**: `proxy.rs:51-64` `#[cfg(test)] mod tests` style; the spike's verified `Entry` API.
- **IMPORTS**: `use keyring::Entry;`, `serde::{Serialize, Deserialize}`, `serde_json`.
- **GOTCHA**: use **`delete_credential()`** (v3), NOT `delete_password()` (v2 — won't compile). Keep
  `USER` non-empty. Funnel all keychain ops through this module (Windows CredMan does not serialize
  concurrent ops; single-module access from the `#[command]` handlers is the safe pattern).
- **VALIDATE**: after the lib.rs `mod keychain;` (next-but-one task) →
  `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml keychain` (round-trip passes — the secret
  hits the real Credential Manager, as the spike proved).

### CREATE `apps/desktop/src-tauri/src/autostart.rs`
- **IMPLEMENT**: `#[command] get_autostart(app) -> Result<bool,String>` and `#[command] set_autostart(app,
  enabled: bool) -> Result<(),String>` over `ManagerExt`, exactly per the Patterns snippet.
- **PATTERN**: the `#[command]` + `Result<_,String>` shape from `proxy.rs` / `sidecar.rs:174-177`.
- **IMPORTS**: `use tauri_plugin_autostart::ManagerExt;`.
- **GOTCHA**: `autolaunch()` **panics if the plugin is not registered** — the lib.rs registration (next
  task) is a hard prerequisite. No capability entry needed (app-defined command).
- **VALIDATE**: `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml` (after lib.rs wires it).

### CREATE `apps/desktop/src-tauri/src/pairing.rs`
- **IMPLEMENT**: serde structs mirroring the shared contract — `PairRequest { code, machine: Machine }`,
  `Machine { name, os: Option<String>, hostname: Option<String> }`, `PairResponse { token, machine_id }`
  (with `#[serde(rename_all = "camelCase")]` so `machine_id` ⇄ `machineId`), and the webview-facing
  `PairResult { machine_id }` + `PairingStatus { paired: bool, machine_id: Option<String> }`. A pure
  `pair_url(base) -> String` helper (`format!("{}/v1/pair", base.trim_end_matches('/'))`) + 2 tests
  (mirror `monitor_url`). `#[command] pair(...)` per the Patterns snippet: build request → reqwest POST →
  `is_success()` guard (410 → `Err`) → parse → `keychain::store(...)` → read the token **back from
  keychain** to build the `configure` JSON → `sidecar::write_command(&app, configure)` → return
  `PairResult` (no token). `#[command] get_pairing_status()` → `keychain::load()` → `{ paired:
  is_some, machineId }` (token never included).
- **PATTERN**: `proxy.rs:28-49` (reqwest + error mapping + pure helper + tests); `pair.ts` (the contract);
  `ingest-client.ts:48-56` (URL shape).
- **IMPORTS**: `crate::{keychain, sidecar}`; `serde::{Serialize, Deserialize}`; `reqwest`; `serde_json::json`.
- **GOTCHA**: serde field names must match the wire **exactly** (`machineId`, `os`, `hostname`, `name`,
  `code`) — a mismatch is a silent 400 from ingest's `pairBodySchema`. Do **not** call
  `saveCredentials`/write any file (GUI path = no plaintext token). Do **not** keep the token in a
  long-lived variable: store it, then read it back from the keychain when building `configure` (the
  keychain is the single source of truth). **Never log the token.** The `configure` command already exists
  in `serve.ts:239-247` — do not add a protocol member.
- **VALIDATE**: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml pairing` (the `pair_url`
  tests pass; `cargo build` confirms the reqwest/keychain/sidecar wiring compiles).

### UPDATE `apps/desktop/src-tauri/src/lib.rs`
- **IMPLEMENT**: (1) add `mod autostart; mod keychain; mod pairing;` beside the existing mods; (2)
  register the plugin: `.plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::
  LaunchAgent, None))`; (3) append the new commands to `generate_handler!`: `sidecar::send_command,
  proxy::get_monitor_snapshot, pairing::pair, pairing::get_pairing_status, autostart::get_autostart,
  autostart::set_autostart`.
- **PATTERN**: the existing builder chain (`lib.rs:10-22`).
- **GOTCHA**: `MacosLauncher` is a **required positional arg even on Windows** (it's a macOS no-op there);
  pass `None` for launch args (start-minimized polish is deferred to Slice 5). Register the plugin
  **before** `.setup(...)`. No `capabilities/default.json` change (Conflict #3).
- **VALIDATE**: `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml` (exit 0; all commands
  registered).

### UPDATE `apps/desktop/src-tauri/src/sidecar.rs` — auto-configure on `ready`
- **IMPLEMENT**: in the `CommandEvent::Stdout` branch (lines 91-97), after `app.emit(EVENT_NAME,
  parse_event_line(&line))`, parse the line; if it's an object with `type == "ready"`, call
  `crate::keychain::load()` and, if `Some(c)`, `let _ = write_command(app, json!({ "cmd":"configure",
  "url": c.url, "token": c.token, "machineId": c.machine_id }))`. This makes a (re)spawned sidecar pick up
  keychain creds without a re-pair — and works even though `store_child` already ran (the stdin handle
  exists by the time `ready` arrives).
- **PATTERN**: the existing relay loop (`sidecar.rs:89-126`); `write_command` (159-168).
- **GOTCHA**: keychain `load()` is sync I/O inside an async task — it is a single fast CredMan read, so an
  inline call is acceptable (wrap in `tauri::async_runtime::spawn_blocking` only if you want to be strict;
  not required). Trigger on **`ready` only** (not `status`) so it fires once per spawn. The token rides
  sidecar **stdin** (Rust→sidecar), never stdout — so it never reaches the webview. Do not log it.
- **VALIDATE**: `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`; manual: with a paired
  keychain, relaunch the app → the sidecar logs no "not configured" on `start` (it was auto-configured).

### UPDATE `apps/desktop/src/lib/bridge.ts`
- **IMPLEMENT**: add `PairResult`/`PairingStatus` interfaces and the `pair`, `getPairingStatus`,
  `getAutostart`, `setAutostart` invoke wrappers per the Patterns snippet.
- **PATTERN**: the existing `getMonitorSnapshot` wrapper (`bridge.ts:36-38`).
- **IMPORTS**: `invoke` from `@tauri-apps/api/core` (already imported, line 1).
- **GOTCHA**: `PairResult` has **no `token` field** — the Rust command never returns it (assert this in
  the manual DevTools check). Use `import type` only if importing shared types (these are local interfaces).
- **VALIDATE**: `npm run typecheck:desktop` (exit 0).

### CREATE `apps/desktop/src/components/Pairing.tsx`
- **IMPLEMENT**: a `Card` panel with (a) a small form — URL (default `http://localhost:8420`), code, and
  machine name (default empty → Rust falls back to `COMPUTERNAME`); a **Pair** button → `run(() =>
  pair(url, code, name))` that on success shows "paired as `<machineId>`" and clears the code; on `Err`
  renders the message (e.g. "pairing failed: HTTP 410" for an expired code). (b) On mount (leak-safe
  effect) call `getPairingStatus()` to show the current paired state, and `getAutostart()` to seed the
  toggle. (c) A **Run on login** toggle → `run(() => setAutostart(next))` then re-read `getAutostart()`.
- **PATTERN**: `StatusBar.tsx:53-96` (the `run()`/`.catch` helper — adapt it to wrap an arbitrary
  `() => Promise<unknown>` since these invokes aren't `ControlCommand`s; the `disposed`+immediate-unlisten
  is only needed if you also subscribe to `onControlEvent`, which this panel does **not** require);
  `SyncHealth.tsx` (Rust-command call + `Err` surface); the Card/Badge/Button idiom (`StatusBar.tsx:103-167`).
- **IMPORTS**: `pair`, `getPairingStatus`, `getAutostart`, `setAutostart` (+ types) from `@/lib/bridge`;
  `Card`/`CardHeader`/`CardTitle`/`CardContent` from `@/components/ui/card`; `Badge`; `cn` from
  `@/lib/utils`.
- **GOTCHA**: this panel needs **no `onControlEvent` subscription** (it talks to Rust `#[command]`s, not
  the sidecar event stream) — keep it simple, no listener teardown. The token is never in any prop/state
  (only `machineId`). Disable the Pair button while a request is in flight.
- **VALIDATE**: `npm run typecheck:desktop` (exit 0).

### UPDATE `apps/desktop/src/App.tsx`
- **IMPLEMENT**: import and mount `<Pairing />` as the **first** child of the `space-y-6` stack (above
  `<StatusBar />`). Update the doc-comment's "Later slices add Pairing and Settings" to reflect Pairing
  shipped here.
- **PATTERN**: the current stack (`App.tsx:21-25`).
- **VALIDATE**: `npm run typecheck:desktop` (exit 0); `npm run build -w @420ai/desktop` produces `dist/`.

### VALIDATE the gate (no new lane needed)
- **IMPLEMENT**: nothing to add — `typecheck:desktop` is already wired into `repo-health` (Slice 1). The
  root `tsc -b` graph is **unchanged** by this slice (Conflict #2), so it stays green trivially. `cargo`
  is NOT in `repo-health` (CI is Linux; `windows-native` keyring + `tauri build` are **local** sign-off,
  like `build:desktop`).
- **GOTCHA**: Slice 3 adds **no** collector/DB code, so `--require-db` is not strictly required by a
  capture-path change — but run it at sign-off anyway (milestone hygiene; it proves the unchanged
  collector↔ingest layer still passes, 0 skipped).
- **VALIDATE**: `npm run repo-health` (PASS, incl. the desktop typecheck lane).

---

## TESTING STRATEGY

### Rust Tests (`cargo test` in `apps/desktop/src-tauri` — LOCAL gate, not CI)
- `keychain.rs`: round-trip — store → load → assert eq → clear → assert `None`, using a **test-only**
  service name so it never touches the real credential. (Spike already proved this passes against the
  real Credential Manager.)
- `pairing.rs`: `pair_url(base)` pure-helper tests (with/without trailing slash), mirroring
  `proxy.rs:55-63`.
- Existing `sidecar.rs` `parse_event_line` + `proxy.rs` `monitor_url` tests must still pass (the
  auto-configure hook only adds to the `Stdout` branch; the `ready` line still passes through to the
  webview unchanged — add one golden assertion if you want, but the pass-through is unchanged).

### Webview
- The enforced `typecheck:desktop` lane (in `repo-health`). No webview unit-test runner this slice
  (mirrors the dashboard + Slices 1-2 — typecheck + build only).

### Integration (must actually RUN — CLAUDE.md gate)
- `npm run repo-health -- --require-db` with the `*.int.test.ts` layer **running (0 skipped)** at sign-off.
  Slice 3 changes **no** DB-backed or collector code, so this is regression insurance (it proves the
  existing pairing route + capture path still pass), not new coverage. A green suite with int tests
  **skipped is not evidence** — bring the test DB up (`npm run db:up && npm run db:migrate`) first.

### Edge Cases
- **Expired/invalid code** → ingest `410` → `is_success()` false → `Err("pairing failed: HTTP 410
  Gone")` → panel shows it (no crash, no keychain write).
- **Ingest unreachable** → reqwest error → `Err("ingest unreachable: …")` → panel error line.
- **Unpaired launch** → `get_pairing_status()` returns `{paired:false}` → panel prompts to pair;
  `start` before any creds → sidecar emits the existing "not configured" `error` (serve.ts:164-166), not a
  crash.
- **Paired keychain, app relaunch** → sidecar `ready` → Rust auto-`configure`s from keychain → `start`
  captures with no re-pair and **no plaintext `credentials.json`** written by the GUI path.
- **CLI-paired machine (existing `credentials.json`)** → unchanged: the sidecar `loadCredentials()`
  fallback still configures it; a later GUI pair stores to keychain and `configure`-overrides in-session.
- **Autostart enable then disable** → `HKCU\…\Run` entry appears then disappears (`reg query`); toggle
  reflects `is_enabled()`.
- **Token isolation** → the `pair`/`get_pairing_status` results contain **only `machineId`**; assert in
  DevTools that no token string is reachable from any webview surface (mirrors the Slice-2 admin-token
  assertion).

---

## VALIDATION COMMANDS

All runnable from the repo root. Each is a GATE.

### Level 1: Syntax & Style / Typecheck
- `npm run typecheck` — root `tsc -b`, **exit 0** (UNCHANGED by this slice — sanity that nothing in the
  root graph regressed).
- `npm run typecheck:desktop` — webview `tsc --noEmit`, **exit 0** (`bridge.ts` + `Pairing.tsx` + `App.tsx`).

### Level 2: Unit Tests
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` — **pass** (keychain round-trip +
  `pair_url` + `monitor_url` + `parse_event_line`). *Local/Windows gate — keyring uses `windows-native`.*
- `npx vitest run packages/shared apps/collector` — **pass** (no new TS tests, but confirms no regression
  in the unchanged root graph).

### Level 3: Integration / Full Gate
- `npm run repo-health` — **PASS** (includes the desktop typecheck lane; root graph unchanged).
- `npm run db:up && npm run db:migrate && npm run repo-health -- --require-db` — **PASS, the
  `*.int.test.ts` layer ran, 0 skipped** (regression insurance — Slice 3 adds no DB code).

### Level 4: Manual / Build Validation (local, Windows)
- `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml` — resolves keyring v3.6.3 +
  tauri-plugin-autostart v2.5.1; compiles clean.
- `npm run build:collector-sea` then `npm run build:desktop`; with `ingest` running:
  - **Pair**: enter URL + a fresh pairing code → "paired as `<machineId>`"; `cmdkey /list | findstr 420ai`
    (or Credential Manager UI) shows the stored entry; **no** `~/.420ai/credentials.json` created by the
    GUI path; **DevTools shows no token string** anywhere webview-reachable.
  - **Restart-resume**: quit + relaunch the app → Start captures with no re-pair (auto-configured from
    keychain; `pending` rises in StatusBar).
  - **Autostart**: toggle Run-on-login on → `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run"`
    shows the app; toggle off → entry gone; the toggle reflects `is_enabled()` on relaunch.
  - **Bad code**: enter an expired code → panel shows "pairing failed: HTTP 410", no keychain write.

### Level 5: Additional (optional)
- `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml` — no warnings (advisory; not in CI).

---

## ACCEPTANCE CRITERIA

- [ ] GUI pairing works end-to-end from the webview: URL + code + name → paired; the panel shows the
      `machineId`; an expired code surfaces a clean error (no crash).
- [ ] The ingest token is stored in the **Windows Credential Manager** (keyring v3 `windows-native`),
      **never** in a plaintext file on the GUI path, and **never** returned to / reachable from the webview
      (the `pair`/`get_pairing_status` results carry only `machineId`).
- [ ] Pairing runs in **Rust** via `reqwest` against the unauthenticated `/v1/pair`; the token is injected
      into the sidecar via the existing `configure` command (Conflict #1). The sidecar `pair` command stays
      reserved/unsupported.
- [ ] A (re)spawned sidecar **auto-configures** from the keychain on `ready` — capture resumes after an app
      restart with no re-pair.
- [ ] Run-on-login toggles via `tauri-plugin-autostart` Rust `#[command]`s; the `HKCU\…\Run` entry
      appears/disappears; the toggle reflects `is_enabled()`.
- [ ] **No control-protocol change and no version bump** — `CONTROL_PROTOCOL_VERSION` stays
      `"m11-control-v2"`; the root `tsc -b` graph (`packages/shared` + `apps/collector`) is unchanged
      (Conflict #2).
- [ ] **No capability edit** — `capabilities/default.json` is unchanged (Conflict #3).
- [ ] The CLI `pair` + `~/.420ai/credentials.json` path still works unchanged (headless use).
- [ ] `npm run typecheck`, `npm run typecheck:desktop`, `cargo build`, and `cargo test` all pass.
- [ ] `npm run repo-health -- --require-db` PASSES with the int layer ran (0 skipped).
- [ ] No artifacts staged (SEA `.exe`, Rust `target/`, webview `dist/`, and **no `spike.rs`** all
      gitignored/absent).

## COMPLETION CHECKLIST

- [ ] All tasks completed in order; each VALIDATE ran and passed immediately.
- [ ] `npm run repo-health` (and `--require-db` at sign-off) PASS.
- [ ] No linting/type errors (root + desktop lanes); `cargo build`/`cargo test` clean.
- [ ] Manual smoke of the built `.exe`: pair, keychain entry present, no plaintext token, restart-resume,
      autostart toggle, token not in webview.
- [ ] Acceptance criteria all met.
- [ ] Commit independently (this is one slice); the bundle plan's later slices (4–5) are untouched.

## NOTES

**Design decisions locked for this slice (user-confirmed):**
1. **Rust does the pairing HTTP call** (reqwest, already present) — the token is born in Rust, stored in
   the keychain, and injected via `configure`; it never crosses stdout or the webview (Conflict #1).
2. **`keyring` crate used directly from Rust** (Windows Credential Manager), **pinned to v3** — no Tauri
   keychain plugin, no Stronghold file vault, no webview keychain access, no capability entry (Conflict #3).
3. **No control-protocol change / no version bump** — `configure`/`pair`/`paired` already exist; pairing
   + autostart are webview↔Rust `#[command]`s, not sidecar control commands (Conflict #2).
4. **Autostart called from Rust** via `#[command]` wrappers over `ManagerExt` — no `@tauri-apps/plugin-
   autostart` npm package and no `autostart:` capability needed.
5. **Single JSON keychain blob** (`{url, token, machineId}`) under one `(service, user)` entry — small,
   well under the ~2560-byte Windows CredMan limit; the keychain is the single source of truth (read the
   token back from it when building `configure`; don't hold it in a long-lived var).

**Deferred to later slices:** full **Settings** panel (collector + server env management) and **server-
stack supervision** (Docker archive + ingest start/stop/health) are Slice 4; packaging polish (icons,
start-minimized arg, signed installer) + docs/sign-off are Slice 5. A "clear/unpair" button (keychain
`clear()`) is trivial to add now if desired but is not a Slice-3 requirement.

**Risks:** (1) the two new Rust deps were the bundle plan's −2 confidence — **now spike-verified** (v3.6.3
+ v2.5.1 compile and the keychain round-trips on this machine), so this risk is retired. (2) keyring **v4**
is the cargo "latest" and would silently no-op — the `version = "3"` pin + `windows-native` feature is
load-bearing; the v3 `delete_credential()` rename must be used. (3) serde field-name drift vs the ingest
`pairBodySchema` would be a silent 400 — mirror `PairRequest`/`PairResponse` field names exactly.

**Confidence (one-pass for Slice 3): 9/10.** The hard unknowns (do the keychain + autostart crates resolve
and compile here, does keyring reach the real Credential Manager) are **empirically retired by the
pre-flight spike**; `configure` already exists; the reqwest command mirrors Slice-2's `proxy.rs` almost
verbatim; and the slice touches **no** collector/shared/protocol code. The −1 is the manual-only Windows
build/keychain/autostart smoke (not reproducible in CI) and the first use of the autostart plugin's
runtime `autolaunch()` (compile-verified, but `enable()`'s registry write is only exercised manually).
