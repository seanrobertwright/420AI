# Feature: M11 Slice 4 — Settings + Full Server-Stack Supervision

The following plan should be complete, but it's important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to naming of existing
utils, types, and models. Import from the right files.

> **Conventions are NOT re-pasted here.** The single source of truth is
> [`CLAUDE.md`](../../CLAUDE.md) (workspaces, TS/module rules, the "libraries never write to stdout"
> boundary, the **Frontend workspace** treatment, **token-never-in-webview**, and **Validation is a
> GATE**). Build background is [`SUMMARY.md`](../../SUMMARY.md); the milestone bundle plan is
> [`.agents/plans/m11-tauri-desktop.md`](./m11-tauri-desktop.md) (this is **Slice 4** of that bundle);
> the Slice-3 plan is [`.agents/plans/m11-slice3-pairing-autostart-keychain.md`](./m11-slice3-pairing-autostart-keychain.md).

## Feature Description

Slice 4 gives the desktop app a **Settings panel** and **full local server-stack supervision**, so a
non-terminal user can run the *whole* 420AI archive from one window: configure the server's secrets
(kept in the **Windows Credential Manager**, never plaintext), and **start/stop/health-check** both the
**Docker Postgres archive** and the **ingest API** — all driven from Rust, which is the only thing that
ever holds a secret.

Three deliverables:

1. **Server config in the keychain + a Settings panel.** A second Credential-Manager entry (separate
   from the Slice-3 pairing token) stores a small server-config blob: `ingestUrl`, `adminToken`,
   `databaseUrl`, `archiveEncryptionKey`, the optional `ANALYSIS_*` fields, and a non-secret `serverDir`
   (the repo/server root). A `Settings.tsx` panel edits these (secret fields masked, write-only — their
   values are NEVER returned to the webview), plus a read-only paired-state display and an **Unpair**
   button (keychain `clear()` of the Slice-3 entry).
2. **Full server supervision (Rust-owned).** Rust `#[command]`s start/stop the Docker archive
   (`docker compose -f <serverDir>/docker-compose.yml up -d archive` / `down`) and the **ingest Node
   process** (`node <serverDir>/apps/ingest/dist/server.js`) — injecting the keychain secrets as the
   spawned process's **environment** (which wins over the repo `.env`, so nothing is written to disk).
   Rust supervises the ingest child like the sidecar (managed handle, kill-on-app-exit, no zombie),
   and **health-polls** both the archive (`docker compose ps --format json` → `State`/`Health`) and the
   ingest (`GET <ingestUrl>/v1/health`).
3. **`proxy.rs` migration + health surfaced in UI (and tray).** `get_monitor_snapshot` (Slice 2) now
   reads `adminToken`/`ingestUrl` from the keychain server-config (falling back to process env for
   headless/dev), retiring the env-only debt its own comment flags. Server up/down/health renders in the
   Settings panel and a non-interactive tray status item.

The **CLI path is untouched**, and the **collector/ingest/db/shared code is unchanged** — full
supervision is entirely Rust-side OS orchestration. **No control-protocol change, no version bump, no new
Rust crate.**

## User Story

```
As a developer self-hosting the 420AI archive on my workstation
I want to configure the server's secrets and start/stop/health-check the Postgres archive AND the ingest
   API from the desktop app — without a terminal — with every secret kept in the Windows keychain
So that the whole local stack is a first-class, secret-safe thing I can see and steer from one window,
   and my admin token / DB password / encryption key are never plaintext on disk
```

## Problem Statement

After Slice 3 the desktop app can pair, capture, show fleet health, and manage connectors — but the
**server** side is still terminal-only. `docker compose up -d` + `npm run -w @420ai/ingest dev` are
manual CLI steps; the **admin token + ingest URL still come from process env** (`proxy.rs:30-31`, whose
own comment says "Slice 3/4 migrates it into the Credential Manager + Settings"); and the server's
secrets (`DATABASE_URL`, `ADMIN_TOKEN`, `ARCHIVE_ENCRYPTION_KEY`, `ANALYSIS_*`) live in a plaintext
repo-root `.env` (`.env.example`). A non-terminal user cannot run the archive at all, and the
plaintext-secrets-on-disk posture is the last place the desktop story violates PRD §18 / CLAUDE.md token
discipline.

## Solution Statement

Add three thin, **Rust-owned** OS surfaces (mirroring the Slice-2/3 pattern where Rust is the privileged
token-holder): a **server-config keychain** module (second entry), a **`server.rs`** supervisor that
runs `docker compose` and the ingest process via `std::process::Command` (injecting keychain secrets as
env so they never hit disk — empirically verified, see "PRE-FLIGHT SPIKE"), and a **`Settings.tsx`**
panel + bridge wrappers. `proxy.rs` is migrated to read its token from the keychain (env fallback). The
ingest process is supervised exactly like the sidecar (managed child handle, killed on `RunEvent::Exit`,
restart-with-backoff). **No control-protocol member is added** (supervision is webview↔Rust `#[command]`s
over OS resources, not sidecar control commands), so `CONTROL_PROTOCOL_VERSION` and the root `tsc -b`
graph (`packages/shared` + `apps/collector`) are **unchanged**.

## Feature Metadata

**Feature Type**: Enhancement (Slice 4 of the M11 bundle)
**Estimated Complexity**: **Medium-High** (no new deps and no protocol change, but the largest new Rust
surface yet — process supervision of two external programs + a second keychain entry + a config panel;
the risk is operational, not feasibility — the operational unknowns are **spike-retired** below)
**Primary Systems Affected**: `apps/desktop` ONLY. Rust: NEW `server.rs`; UPDATE `keychain.rs` (+server
entry), `proxy.rs` (read from keychain), `lib.rs` (register commands + `ServerState` + kill-on-exit),
`tray.rs` (server status item). Webview: NEW `Settings.tsx`; UPDATE `bridge.ts`, `App.tsx`. **No change
to `apps/collector`, `apps/ingest`, `packages/shared`, or `packages/db`** (so the root `tsc -b` graph is
untouched — see Resolution #2).
**Dependencies**: **NONE new.** `std::process::Command` is std; `reqwest` (health poll) and `keyring`
(server-config entry) are already in `Cargo.toml` from Slices 2-3. No new npm dep. **This is a confidence
driver** — there is no crate-resolution unknown this slice.

---

## ⚠️ FOUR RESOLUTIONS THAT WIN OVER THE BUNDLE PLAN (read before coding)

The bundle plan (`m11-tauri-desktop.md`, Slice 4 rows) predates Slices 1-3 being built. **These
resolutions WIN (all user-confirmed this session):**

1. **Supervision is RUST-side via `std::process::Command`, NOT the shell plugin / sidecar machinery.**
   The bundle plan says "`std::process::Command`; mirror the sidecar supervision." Confirmed: `docker`
   and `node` are spawned **directly from Rust `#[command]`s**, not as Tauri `externalBin` sidecars and
   not via `tauri-plugin-shell`. Consequence: **NO `capabilities/default.json` change** — app-defined
   `#[command]`s and Rust-side process spawning need no capability entry (proven by Slice 2/3's
   `proxy::get_monitor_snapshot` / `pairing::pair` working with no capability entry).

2. **NO control-protocol change and NO version bump.** Server supervision touches **zero** sidecar
   protocol commands — it orchestrates OS processes (Docker + the ingest Node process), which are
   nothing to do with the collector sidecar's stdio. **Leave `control-protocol.ts` and
   `CONTROL_PROTOCOL_VERSION = "m11-control-v2"` exactly as-is.** The root `tsc -b` graph is UNCHANGED;
   the only TS edits are in the `apps/desktop` webview (its own `typecheck:desktop` lane).

3. **Settings manages SERVER config only — NOT new collector config fields.** The bundle plan listed
   "collector config (dashboard URL, machine name, watch interval, connector paths, DB path)." Per
   user decision, **collector config is OUT of this slice**: URL/`machineId` already arrive via the
   Slice-3 `configure`/keychain path, machine-name is set at pairing, and watch-interval/paths/DB-path
   are not configurable today (adding them would need new protocol commands + a version bump + collector
   changes — explicitly deferred). This slice's Settings panel edits **server** config (the secrets the
   supervised ingest + the monitor proxy need) + an Unpair affordance. The capture core stays untouched.

4. **Secrets injected as ENV, never written to a `.env`.** The bundle plan's Slice-4 row said "writing
   the ingest `.env` must go to the server's CWD." **Resolution (user-confirmed):** do NOT write a
   `.env`. Rust reads the secrets from the keychain and passes them as the spawned ingest process's
   **environment**; `apps/ingest/src/server.ts:8` loads the repo `.env` with dotenv's default
   `override:false`, so **injected env wins** and no plaintext token is ever written (empirically proven
   — see PRE-FLIGHT SPIKE result #2). This is the secret-safe analog of Slice 3's "token born in Rust".

---

## PRE-FLIGHT SPIKE — RESULTS (verified on this machine 2026-06-16, do not re-litigate)

A non-destructive spike on Windows 11 / Docker 29.5.2 / Compose v2 / Node v24.16.0 empirically confirmed
the full-supervision mechanics (the dominant unknown the bundle plan rated 6/10):

- **Docker Compose v2 control + parse:** `docker compose version` → v2 plugin; `docker compose config
  --services` → `archive`; `docker compose ps --format json` → one JSON object per running service with
  parseable `"State":"running"`, `"Health":"healthy"`, `"Service":"archive"`, `"Name":"420ai-archive"`.
  So Rust can `up -d` / `down` and parse health.
- **Ingest launch with injected env (THE LINCHPIN):** `node apps/ingest/dist/server.js` spawned with
  `DATABASE_URL`/`ADMIN_TOKEN`/`ARCHIVE_ENCRYPTION_KEY`/`INGEST_PORT` injected as **process env** booted
  cleanly; `GET /v1/health` → `{"status":"ok",...}`. With a **unique injected `ADMIN_TOKEN`**,
  `GET /v1/monitor` with that token → **200**, and with a wrong token → **401** — proving the
  injected env **won over the repo `.env`** (dotenv `override:false`). **Keychain secrets reach ingest
  with ZERO plaintext written.**
- **Clean kill / no zombie:** killing the child → `GET /v1/health` immediately refused (process gone).
  Mirrors the sidecar `child.kill()` on exit.
- **No new Rust crate:** the whole feature is `std::process::Command` (std) + `reqwest` (present) +
  `keyring` (present). Nothing to resolve.
- **Prerequisite surfaced:** launching ingest requires the **repo present + `apps/ingest/dist/` built
  (`tsc -b`/`npm run build`) + `node` on PATH**. This is the "same-machine server" assumption made
  concrete; the plan makes `serverDir` configurable and surfaces a clear error when `dist`/`docker`/
  `node` is missing (it does not fail silently).

> **The plan therefore commits to the verified launch mechanism** (`node <serverDir>/apps/ingest/dist/
> server.js`, cwd `serverDir`, secrets injected as env) and the verified compose invocations. If a
> command shape later differs from the spike, STOP and reconcile against this result.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**Desktop Rust shell (the surfaces you extend):**
- `apps/desktop/src-tauri/src/keychain.rs` (whole file) — Why: the **exact pattern to extend** for the
  server-config entry. It already has `Stored {url, token, machineId}` under `(SERVICE="ai.420.desktop",
  USER="ingest-credentials")` with `store`/`load`/`clear` + service-parameterized cores
  (`store_in`/`load_from`/`clear_in`) + a test-service round-trip test. Add a **`ServerConfig` struct**
  and a **second USER** (`"server-config"`) with `store_server`/`load_server`/`clear_server`, reusing the
  same `(SERVICE, user)` + `Entry` + JSON-blob shape. The blob stays one small entry (well under the
  ~2560-byte CredMan limit). Funnel all keychain ops through this module (CredMan does not serialize
  concurrent writes).
- `apps/desktop/src-tauri/src/proxy.rs` (whole file) — Why: **migrate it.** Today `get_monitor_snapshot`
  reads `ADMIN_TOKEN`/`INGEST_URL` from `std::env::var` (lines 30-31) and its doc-comment explicitly says
  "Slice 3/4 migrates it into the Credential Manager + Settings." Change it to read `adminToken`/
  `ingestUrl` from `keychain::load_server()` first, **falling back to env** when the keychain has no
  server-config (preserves headless/dev). Keep the pure `monitor_url` helper + its 2 tests; the token is
  still never logged/returned. This is the smallest, lowest-risk win in the slice.
- `apps/desktop/src-tauri/src/sidecar.rs` (lines 20-77, 159-232) — Why: **the supervision pattern to
  mirror** for the ingest process — `SidecarState { child: Mutex<Option<CommandChild>>, shutting_down:
  AtomicBool }`, the restart-with-backoff loop (`RESTART_BACKOFF_BASE_MS`=1000, `_CAP_MS`=30000,
  `HEALTHY_UPTIME_SECS`=5, `MAX_CONSECUTIVE_FAILURES`=6), `store_child`/`clear_child`, and `shutdown()`
  (kill on `RunEvent::Exit`, latch `shutting_down` so the loop stops). `server.rs` reuses this shape for
  the ingest child (NB: `std::process::Child`, not Tauri's `CommandChild` — see Gotcha). **No sidecar.rs
  edit this slice.**
- `apps/desktop/src-tauri/src/lib.rs` (whole file) — Why: where you `mod server;`, register the new
  `#[command]`s in `generate_handler!`, `.manage(server::ServerState::default())`, and extend the
  `RunEvent::Exit` arm to also `server::shutdown(app_handle)` (kill the ingest child — no zombie). The
  autostart plugin + `SidecarState` registration show the exact builder idiom.
- `apps/desktop/src-tauri/src/tray.rs` (whole file) — Why: add a **non-interactive** server-status menu
  item (`MenuItem` with `enabled=false`, updated via a handle) OR a tooltip update — the acceptance
  criterion is "surface health in UI + tray". Keep the tray built ONCE in `setup` (tauri#8982). The
  existing menu (start/pause/resume/quit drives the sidecar) is unchanged.
- `apps/desktop/src-tauri/src/pairing.rs` (lines 57-61, 157-170) — Why: the **pure-helper + `#[cfg(test)]`
  idiom** to mirror for `server.rs` helpers (`compose_args`, `health_url`, `parse_archive_health`).
- `apps/desktop/src-tauri/Cargo.toml` (whole file) — Why: **confirm NO new dep is needed.** `reqwest`
  (line 26) + `keyring` (line 31) + `serde`/`serde_json` are present; `std::process::Command` is std.
- `apps/desktop/src-tauri/capabilities/default.json` — Why: **confirm you do NOT touch it** (Resolution
  #1 — Rust-side process spawning needs no capability).

**The deployment surface (read, do not edit — Rust orchestrates it):**
- `docker-compose.yml` (whole file) — Why: the single service is **`archive`** (postgres:17, host port
  **5433**, container_name `420ai-archive`, a `healthcheck` → `ps` reports `Health:"healthy"`). Rust
  targets `docker compose -f <serverDir>/docker-compose.yml`. `up -d archive` / `down` are the verified
  invocations. Volume `archive-data` persists across `down` (data is safe).
- `apps/ingest/package.json` (lines 13-17) — Why: `"start": "node dist/server.js"` is the production
  launch (needs `build` = `tsc -b` first); `"dev": "tsx watch src/server.ts"`. **The supervisor spawns
  `node <serverDir>/apps/ingest/dist/server.js`** (the spike-verified path), NOT `npm run dev` (tsx-watch
  is a dev affordance, not a supervised process).
- `apps/ingest/src/server.ts` (lines 1-13, 60) — Why: it `config({ path: <repo>/.env })` (dotenv,
  default `override:false` → **injected env wins**, the linchpin), then **throws** if `DATABASE_URL` or
  `ADMIN_TOKEN` is unset, and listens on `INGEST_PORT ?? 8420`. So the required injected env is
  `DATABASE_URL` + `ADMIN_TOKEN` + `ARCHIVE_ENCRYPTION_KEY` (field encryption, PRD §18.1); optional:
  `INGEST_PORT`, `ANALYSIS_*`, `MONITOR_STREAM_INTERVAL_MS`. Spawn with **cwd = `serverDir`** so
  `node_modules` (`@420ai/db`, `@420ai/shared`, `fastify`) resolve.
- `apps/ingest/src/routes/health.ts` (whole file) — Why: `GET /v1/health` is **unauthenticated** and
  returns `{status:"ok", time}` — the ingest liveness probe Rust polls (no bearer needed).
- `.env.example` (whole file) — Why: the **canonical env var names + generation recipes** the Settings
  panel mirrors (`DATABASE_URL`, `ADMIN_TOKEN`, `ARCHIVE_ENCRYPTION_KEY` = 32-byte base64, `INGEST_PORT`,
  `ANALYSIS_PROVIDER`/`_API_KEY`/`_MODEL`/`_BASE_URL`/`_MAX_OUTPUT_TOKENS`/`_TIMEOUT_MS`,
  `MONITOR_STREAM_INTERVAL_MS`, `INGEST_URL`). Field names must match EXACTLY when injected as env.

**Desktop webview (OUT of root `tsc -b`; its own `typecheck:desktop` lane):**
- `apps/desktop/src/components/Pairing.tsx` (whole file) — Why: the **canonical panel pattern** to
  mirror — the leak-safe mount effect (`disposed` flag + immediate-unlisten), the `run()`-style
  `.catch`→panel-state for rejected invokes, the form + button-disabled-while-in-flight idiom, and the
  Card/Badge primitives. Settings is a sibling panel of the same shape. NB: Settings needs **no
  `onControlEvent` subscription** (it talks to Rust `#[command]`s, not the sidecar stream) — keep it
  listener-free like the Slice-3 Pairing panel's pairing calls.
- `apps/desktop/src/components/SyncHealth.tsx` (lines 73-118) — Why: the Rust-command-call + `Err`-surface
  + `Refresh`/`loading` idiom to reuse for the health-poll display.
- `apps/desktop/src/lib/bridge.ts` (whole file) — Why: add typed `invoke` wrappers mirroring the existing
  `pair`/`getPairingStatus`/`getMonitorSnapshot` ones. The token-never-returned discipline (`PairResult`
  has no `token`) applies: `getServerConfig()` returns a **masked** view (presence booleans + non-secret
  fields), never secret values.
- `apps/desktop/src/App.tsx` (whole file) — Why: mount `<Settings />` in the `space-y-6` stack (place it
  **last**, after `<Connectors />` — server admin is the most advanced surface). Update the doc-comment
  ("A later slice adds Settings" → "Slice 4 adds Settings + server supervision").
- `apps/desktop/src/components/ui/{card,table,badge}.tsx`, `src/lib/utils.ts` (`cn`) — Why: the
  hand-written primitives; Settings uses these, NOT a fresh `shadcn init`.

### New Files to Create

- `apps/desktop/src-tauri/src/server.rs` — the supervisor: `ServerState` (managed ingest child +
  shutting-down latch), `#[command]`s `start_archive`/`stop_archive`/`start_ingest`/`stop_ingest`/
  `get_server_health`, `shutdown(app)`, and pure helpers (`compose_args`, `health_url`,
  `parse_archive_health`, `ingest_env`) with `#[cfg(test)]` tests.
- `apps/desktop/src/components/Settings.tsx` — the server-config form (masked secrets) + server-stack
  start/stop/health controls + Unpair button.

### Relevant Documentation — READ BEFORE IMPLEMENTING

- [Rust `std::process::Command`](https://doc.rust-lang.org/std/process/struct.Command.html) — `.env()`/
  `.envs()` to inject secrets, `.current_dir()` for cwd, `.spawn()` → `Child`, `child.kill()`,
  `child.id()`. `.output()`/`.status()` for one-shot `docker` calls.
- [Docker Compose CLI v2](https://docs.docker.com/reference/cli/docker/compose/) — `docker compose -f
  <file> up -d <service>`, `down`, `ps --format json`. **`ps --format json` emits one JSON object per
  line (NDJSON)** when multiple services run — parse line-by-line (verified in the spike).
- [reqwest 0.12](https://docs.rs/reqwest/0.12/reqwest/) — already used in `proxy.rs`; the health poll is
  `client.get(health_url).send().await` + `.status().is_success()` (no bearer — `/v1/health` is open).
- [keyring v3](https://docs.rs/keyring/3.6.3/keyring/) — `Entry::new(service, user)` (second `user` =
  `"server-config"`), `set_password`/`get_password`/`delete_credential`. Already proven in Slice 3.
- `apps/ingest/src/server.ts` + `.env.example` — the live env contract the injected env must satisfy.

### Patterns to Follow

**Server-config keychain (extend `keychain.rs` — second entry):**
```rust
/// Second Credential-Manager entry: the supervised server's config/secrets. Separate
/// USER from the pairing creds so the two never collide.
const SERVER_USER: &str = "server-config";

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub server_dir: String,            // repo/server root (non-secret) — derives compose + ingest paths
    pub ingest_url: String,            // for the monitor proxy + health poll (non-secret)
    pub admin_token: String,           // SECRET
    pub database_url: String,          // SECRET
    pub archive_encryption_key: String,// SECRET
    #[serde(default)] pub ingest_port: Option<u16>,
    #[serde(default)] pub analysis_provider: Option<String>,
    #[serde(default)] pub analysis_api_key: Option<String>,    // SECRET
    #[serde(default)] pub analysis_model: Option<String>,
    #[serde(default)] pub analysis_base_url: Option<String>,
}

pub fn store_server(c: &ServerConfig) -> Result<(), String> { store_in_user(SERVICE, SERVER_USER, c) }
pub fn load_server() -> Option<ServerConfig> { load_from_user(SERVICE, SERVER_USER) }
```
> Generalize the existing `store_in`/`load_from` to take the `user` (keep the `Stored` ones working).
> One small JSON blob, well under CredMan's ~2560 bytes.

**Ingest supervision (mirror `sidecar.rs`, but `std::process::Child`):**
```rust
use std::process::{Child, Command, Stdio};

#[derive(Default)]
pub struct ServerState { ingest: Mutex<Option<Child>>, shutting_down: AtomicBool }

#[tauri::command]
pub async fn start_ingest(app: tauri::AppHandle) -> Result<(), String> {
    let cfg = crate::keychain::load_server().ok_or("server not configured")?;
    let dist = format!("{}/apps/ingest/dist/server.js", cfg.server_dir);
    if !std::path::Path::new(&dist).exists() {
        return Err(format!("ingest not built — run `npm run build` in {} (missing {dist})", cfg.server_dir));
    }
    let child = Command::new("node")
        .arg(&dist)
        .current_dir(&cfg.server_dir)         // so node_modules resolve
        .envs(ingest_env(&cfg))               // SECRETS injected as env — win over .env, never on disk
        .stdout(Stdio::null()).stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start ingest (is node on PATH?): {e}"))?;
    *app.state::<ServerState>().ingest.lock().map_err(|e| e.to_string())? = Some(child);
    Ok(())
}
```
> Assertion (spike): `node <serverDir>/apps/ingest/dist/server.js` with injected `DATABASE_URL`+
> `ADMIN_TOKEN`+`ARCHIVE_ENCRYPTION_KEY` env booted and served `/v1/health`=ok; the injected `ADMIN_TOKEN`
> beat the repo `.env` (dotenv `override:false`). `child.kill()` left no zombie. **Never log the env.**

**Docker archive control (one-shot `Command`):**
```rust
fn compose_args<'a>(server_dir: &str, tail: &[&'a str]) -> Vec<String> {
    let mut v = vec!["compose".into(),
        "-f".into(), format!("{server_dir}/docker-compose.yml")];
    v.extend(tail.iter().map(|s| s.to_string()));
    v   // e.g. ["compose","-f",".../docker-compose.yml","up","-d","archive"]
}
#[tauri::command]
pub async fn start_archive() -> Result<(), String> {
    let cfg = crate::keychain::load_server().ok_or("server not configured")?;
    run_docker(&compose_args(&cfg.server_dir, &["up","-d","archive"])).await
}
```
> `run_docker` spawns `docker` with the args, captures status+stderr, maps a non-zero exit (or "program
> not found" → Docker not installed/running) to a clean `Err(stderr)` the panel shows. NEVER silent.

**Health (`docker compose ps --format json` line-parse + reqwest `/v1/health`):**
```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerHealth { archive: String /* running|healthy|stopped|unknown */, ingest: bool }

fn parse_archive_health(ps_json_lines: &str) -> String {
    for line in ps_json_lines.lines().filter(|l| !l.trim().is_empty()) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if v.get("Service").and_then(|s| s.as_str()) == Some("archive") {
                // prefer Health ("healthy") else State ("running")
                return v.get("Health").and_then(|h| h.as_str()).filter(|h| !h.is_empty())
                    .or_else(|| v.get("State").and_then(|s| s.as_str()))
                    .unwrap_or("unknown").to_string();
            }
        }
    }
    "stopped".into()  // no archive line ⇒ not up
}
```
> Assertion (spike): real `ps --format json` for the archive contained `"Service":"archive"`,
> `"State":"running"`, `"Health":"healthy"` (NDJSON, one object per line). `health_url(base)` mirrors
> `proxy.rs::monitor_url`: `format!("{}/v1/health", base.trim_end_matches('/'))`.

**Webview invoke wrappers (mirror `bridge.ts` Slice-3 wrappers):**
```ts
export interface ServerConfigView {              // NB: NO secret values — masked, write-only
  serverDir: string; ingestUrl: string;
  hasAdminToken: boolean; hasDatabaseUrl: boolean; hasArchiveEncryptionKey: boolean;
  analysisProvider: string | null; analysisModel: string | null; analysisBaseUrl: string | null;
}
export interface ServerConfigInput {             // what the form SENDS (secrets optional → unchanged if blank)
  serverDir: string; ingestUrl: string;
  adminToken?: string; databaseUrl?: string; archiveEncryptionKey?: string;
  ingestPort?: number;
  analysisProvider?: string; analysisApiKey?: string; analysisModel?: string; analysisBaseUrl?: string;
}
export interface ServerHealth { archive: string; ingest: boolean }
export function getServerConfig(): Promise<ServerConfigView | null> { return invoke("get_server_config"); }
export function setServerConfig(cfg: ServerConfigInput): Promise<void> { return invoke("set_server_config", { cfg }); }
export function startArchive(): Promise<void> { return invoke("start_archive"); }
export function stopArchive(): Promise<void> { return invoke("stop_archive"); }
export function startIngest(): Promise<void> { return invoke("start_ingest"); }
export function stopIngest(): Promise<void> { return invoke("stop_ingest"); }
export function getServerHealth(): Promise<ServerHealth> { return invoke("get_server_health"); }
export function unpair(): Promise<void> { return invoke("unpair"); }
```
> `get_server_config` returns presence booleans for secrets, never the secret strings (token-isolation
> invariant, same discipline as `PairResult` having no `token`). `set_server_config` treats a **blank**
> secret field as "leave unchanged" (merge against the loaded blob) so re-saving non-secret prefs doesn't
> wipe a secret the webview can't see.

---

## IMPLEMENTATION PLAN

### Phase 1: Keychain server-config (foundation)

Extend `keychain.rs` with the second `(service, "server-config")` entry + `ServerConfig` struct +
generalized cores + a round-trip test. This is the dependency root for the proxy migration and
supervision (both read it).

### Phase 2: Rust supervision + proxy migration

Create `server.rs` (config commands + archive/ingest start/stop + health + pure helpers + tests);
migrate `proxy.rs` to read the keychain (env fallback); register everything in `lib.rs` (+`ServerState`
+ kill-on-exit); add the tray server-status item.

### Phase 3: Webview integration

Add the bridge wrappers, build `Settings.tsx` (config form + stack controls + health + unpair), mount it
in `App.tsx`.

### Phase 4: Testing & validation

`cargo build`/`cargo test` (server-config keychain round-trip + `compose_args`/`health_url`/
`parse_archive_health` pure tests + existing `monitor_url`/`pair_url`/`parse_event_line`),
`typecheck:desktop`, `repo-health` (unchanged root graph still green), and the manual built-`.exe` smoke
(configure → start archive → start ingest → health green → monitor proxy works → stop → no zombie →
secrets not in webview → no plaintext `.env` written).

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Each task is atomic and independently validatable.

### UPDATE `apps/desktop/src-tauri/src/keychain.rs` — add the server-config entry
- **IMPLEMENT**: Add `const SERVER_USER: &str = "server-config";`, the `ServerConfig` struct (per the
  Patterns snippet, `#[serde(rename_all = "camelCase")]`, secrets as plain `String`, optionals as
  `Option`), and `store_server`/`load_server`/`clear_server`. Generalize the existing private cores to
  take a `user` param (`store_in_user(service, user, &T)` / `load_from_user::<T>(service, user)` /
  `clear_in_user(service, user)`) and keep the existing `Stored`-based `store_in`/`load_from`/`clear_in`
  working (have them delegate with `USER`). Add a `#[cfg(test)]` round-trip for `ServerConfig` under a
  **test service** (`"ai.420.desktop.test"`) + the existing test `USER`/a test server user.
- **PATTERN**: the current `keychain.rs` cores (lines 55-74) + the round-trip test (83-100); the generic
  blob shape proven in Slice 3.
- **IMPORTS**: existing (`keyring::Entry`, serde, serde_json). Make the cores **generic** over
  `T: Serialize`/`DeserializeOwned` (or write a second concrete pair) — whichever keeps it simplest.
- **GOTCHA**: keep `USER` ("ingest-credentials") and `SERVER_USER` ("server-config") **distinct** so the
  pairing token and the server secrets never overwrite each other. `delete_credential()` (v3), not
  `delete_password()`. The `clear` of the **pairing** entry powers Unpair (Task: server.rs `unpair`),
  NOT the server-config entry.
- **VALIDATE**: after `lib.rs` wires the module (it already compiles `keychain`), `cargo test
  --manifest-path apps/desktop/src-tauri/Cargo.toml keychain` (both round-trips pass against real CredMan).

### CREATE `apps/desktop/src-tauri/src/server.rs` — supervisor + config commands
- **IMPLEMENT**:
  - `ServerState { ingest: Mutex<Option<std::process::Child>>, shutting_down: AtomicBool }` (`#[derive(Default)]`).
  - Pure helpers + `#[cfg(test)]` tests: `compose_args(server_dir, tail) -> Vec<String>`;
    `health_url(base) -> String` (mirror `proxy::monitor_url`, trailing-slash trim); `parse_archive_health
    (ps_json) -> String` (golden NDJSON line → `"healthy"`; empty → `"stopped"`); `ingest_env(&ServerConfig)
    -> Vec<(String,String)>` (asserts `DATABASE_URL`/`ADMIN_TOKEN`/`ARCHIVE_ENCRYPTION_KEY` present, adds
    `INGEST_PORT` + `ANALYSIS_*` when set — test that a secret value never appears in any `Debug`/log path).
  - `#[command] get_server_config() -> Option<ServerConfigView>` → `keychain::load_server()` mapped to the
    **masked** view (presence booleans for secrets; never secret strings).
  - `#[command] set_server_config(cfg: ServerConfigInput) -> Result<(),String>` → load existing blob,
    **merge** (blank secret field ⇒ keep existing), validate `server_dir` non-empty + `ingest_url` parses,
    `keychain::store_server`.
  - `#[command] start_archive()/stop_archive() -> Result<(),String>` → `run_docker(compose_args(dir, ["up","-d","archive"] / ["down"]))`.
  - `#[command] start_ingest(app)/stop_ingest(app) -> Result<(),String>` → spawn `node <dist>` with
    `.envs(ingest_env)` + `.current_dir(server_dir)` (per snippet) / `child.kill()` + clear the handle.
    `start_ingest` errors clearly if `dist` missing ("ingest not built") or `node` not found.
  - `#[command] get_server_health() -> ServerHealth` → `docker compose ps --format json` → `parse_archive
    _health`; `reqwest GET health_url` → `.is_success()` → `ingest: bool`. Both probes are best-effort
    (a failed probe ⇒ `stopped`/`false`, never an `Err`).
  - `#[command] unpair() -> Result<(),String>` → `keychain::clear()` (the **pairing** entry) so the user
    can disconnect the collector from the GUI (Slice-3 deferred this).
  - `pub fn shutdown(app)` → latch `shutting_down`, `child.kill()` the ingest if present (no zombie).
- **PATTERN**: `proxy.rs` (reqwest + pure helper + tests), `pairing.rs` (serde structs + `#[cfg(test)]`),
  `sidecar.rs:159-232` (`store_child`/`clear_child`/`shutdown` shape — adapt to `std::process::Child`).
- **IMPORTS**: `std::process::{Command, Child, Stdio}`, `std::sync::{Mutex, atomic::{AtomicBool, Ordering}}`,
  `tauri::Manager`, `crate::keychain`, `serde::{Serialize, Deserialize}`, `serde_json`, `reqwest`.
- **GOTCHA**: (1) `docker`/`node` are spawned with `std::process::Command` **from Rust** — NOT via the
  shell plugin and NOT a sidecar (Resolution #1) → **no capability entry**. (2) On Windows, `child.kill()`
  is `TerminateProcess` (no graceful drain) — acceptable for a local server (mirrors `sidecar.rs`
  kill-on-exit); a `docker compose down` separately stops Postgres cleanly. (3) **Never log the env / the
  secrets**; `ingest_env` must not be `Debug`-printed. (4) `Command::new("docker")`/`("node")` relies on
  PATH — map the "program not found" `io::Error` (`ErrorKind::NotFound`) to a friendly Err ("Docker not
  installed/not running" / "node not on PATH"). (5) Use `tokio::process`/`spawn_blocking` only if you want
  to keep the async fn non-blocking; a short `Command::output()` inline is acceptable (mirrors the spike).
  (6) the supervised ingest is NOT auto-restarted with backoff this slice (a one-shot managed child kept in
  `ServerState`, killed on exit) — **simpler than the sidecar loop and sufficient**; note this in the panel
  ("ingest stopped" shows on next health poll). Restart-with-backoff is a deferred polish.
- **VALIDATE**: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml server` (pure-helper tests
  pass); `cargo build` confirms the command wiring compiles (after lib.rs registers it).

### UPDATE `apps/desktop/src-tauri/src/proxy.rs` — read the keychain (env fallback)
- **IMPLEMENT**: In `get_monitor_snapshot`, replace the two `std::env::var` reads with: load
  `keychain::load_server()`; if present and `admin_token`/`ingest_url` non-empty, use them; else fall back
  to `ADMIN_TOKEN`/`INGEST_URL` env (today's behavior). Keep `monitor_url` + its tests + the
  never-log/never-return discipline. Update the doc-comment (the "Slice 3/4 migrates it" note is now done).
- **PATTERN**: the existing function (lines 28-49); `keychain::load_server()` from Task 1.
- **GOTCHA**: keep the **env fallback** — a headless/dev run (no keychain server-config) must still work
  exactly as before (CLAUDE.md: the dashboard/proxy env path is unchanged). Empty keychain strings ⇒ treat
  as unset (fall back), don't send an empty bearer.
- **VALIDATE**: `cargo build`; `cargo test ... proxy` (the 2 `monitor_url` tests still pass).

### UPDATE `apps/desktop/src-tauri/src/lib.rs` — register commands + state + kill-on-exit
- **IMPLEMENT**: (1) add `mod server;`; (2) `.manage(server::ServerState::default())`; (3) append to
  `generate_handler!`: `server::get_server_config, server::set_server_config, server::start_archive,
  server::stop_archive, server::start_ingest, server::stop_ingest, server::get_server_health,
  server::unpair`; (4) in the `RunEvent::Exit` arm, call `server::shutdown(app_handle)` alongside the
  existing `sidecar::shutdown(app_handle)` (kill the ingest child — no zombie).
- **PATTERN**: the existing builder chain (`lib.rs:13-43`).
- **GOTCHA**: register `ServerState` via `.manage(...)` BEFORE `.run(...)` (same as `SidecarState`). The
  `RunEvent::Exit` arm currently only tears down the sidecar — extend it, don't replace it. No capability
  edit (Resolution #1).
- **VALIDATE**: `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml` (exit 0; all commands
  registered).

### UPDATE `apps/desktop/src-tauri/src/tray.rs` — non-interactive server-status item
- **IMPLEMENT**: add a **disabled** `MenuItem` (e.g. id `"server_status"`, enabled `false`) showing the
  last-known server state (e.g. "Server: archive healthy · ingest up"); update its text from a periodic
  health poll OR leave it static-labeled ("Server status — see Settings") if a live tray update is more
  Rust than this slice warrants. Keep the existing start/pause/resume/quit items unchanged.
- **PATTERN**: `tray.rs` `MenuItem::with_id` (lines 15-19); the tray is built ONCE in `setup` (tauri#8982).
- **GOTCHA**: a `false`-enabled item is display-only (no `on_menu_event` branch needed). Do NOT add a
  second `TrayIconBuilder` (duplicate-icon bug). If a live label update needs a stored `MenuItem` handle,
  thread it through `setup`; if that balloons, ship the static label + the full health in the UI (the
  acceptance "+ tray" is satisfied by a visible server-status line).
- **VALIDATE**: `cargo build`; manual: the tray menu shows a server-status line.

### UPDATE `apps/desktop/src/lib/bridge.ts` — server wrappers
- **IMPLEMENT**: add `ServerConfigView`/`ServerConfigInput`/`ServerHealth` interfaces + the
  `getServerConfig`/`setServerConfig`/`startArchive`/`stopArchive`/`startIngest`/`stopIngest`/
  `getServerHealth`/`unpair` invoke wrappers per the Patterns snippet.
- **PATTERN**: the existing Slice-3 wrappers (`bridge.ts:55-83`).
- **IMPORTS**: `invoke` from `@tauri-apps/api/core` (already imported).
- **GOTCHA**: `ServerConfigView` has **no secret value fields** — only presence booleans + non-secret
  strings (token-isolation, same as `PairResult` carrying no `token`). `getServerConfig` can return
  `null` (unconfigured) — type it `ServerConfigView | null`.
- **VALIDATE**: `npm run typecheck:desktop` (exit 0).

### CREATE `apps/desktop/src/components/Settings.tsx`
- **IMPLEMENT**: a `Card` with three sections: (a) **Server config form** — `serverDir`, `ingestUrl`
  (default `http://localhost:8420`), `adminToken`/`databaseUrl`/`archiveEncryptionKey` as `type=password`
  inputs (placeholder "•••• set — leave blank to keep" when the view's presence bool is true), optional
  `ANALYSIS_*` fields; a **Save** button → `run(() => setServerConfig(input))`. (b) **Server stack** —
  Start/Stop Archive + Start/Stop Ingest buttons (each through the `run()`/`.catch`→panel-state helper,
  disabled while in flight) + a **Refresh health** button rendering `getServerHealth()` (archive badge +
  ingest up/down badge). (c) **Pairing** — read-only paired `machineId` (from `getPairingStatus`, Slice 3)
  + an **Unpair** button → `run(() => unpair())`. On mount (leak-safe effect, mirror Pairing.tsx) load
  `getServerConfig()` + `getServerHealth()` + `getPairingStatus()`.
- **PATTERN**: `Pairing.tsx` (form + `run()`/`.catch` + leak-safe mount effect + Card/Badge idiom);
  `SyncHealth.tsx` (the `Refresh`/`loading` + `Err`-surface health display).
- **IMPORTS**: the new bridge fns + types; `getPairingStatus` (Slice 3); `Card`/`CardHeader`/`CardTitle`/
  `CardContent`/`CardDescription`; `Badge`; `cn`.
- **GOTCHA**: NO `onControlEvent` subscription (Rust `#[command]`s only — keep it listener-free like
  Pairing's pairing calls). A secret value is NEVER in any prop/state read back from Rust (only what the
  user typed locally, cleared on save). Disable Save/Start/Stop while a request is in flight. Surface
  every `Err` (e.g. "Docker not installed/not running", "ingest not built — run npm run build", "node not
  on PATH") as a visible line, not a console error.
- **VALIDATE**: `npm run typecheck:desktop` (exit 0).

### UPDATE `apps/desktop/src/App.tsx` — mount `<Settings />`
- **IMPLEMENT**: import + mount `<Settings />` as the **last** child of the `space-y-6` stack (after
  `<Connectors />`). Update the doc-comment ("A later slice adds Settings" → "Slice 4 adds Settings +
  full server-stack supervision").
- **PATTERN**: the current stack (`App.tsx:22-27`).
- **VALIDATE**: `npm run typecheck:desktop` (exit 0); `npm run build -w @420ai/desktop` produces `dist/`.

### VALIDATE the gate (no new lane needed)
- **IMPLEMENT**: nothing to add — `typecheck:desktop` is already in `repo-health` (Slice 1). The root
  `tsc -b` graph is **unchanged** (Resolution #2), so it stays green trivially. `cargo`/`tauri build` are
  NOT in `repo-health` (CI is Linux; the Windows Rust build + Docker/process supervision are **local**
  sign-off, like `build:desktop`).
- **GOTCHA**: Slice 4 adds **no** collector/DB code, so `--require-db` proves only regression — run it at
  sign-off anyway (milestone hygiene; it proves the unchanged collector↔ingest layer still passes,
  0 skipped).
- **VALIDATE**: `npm run repo-health` (PASS, incl. the desktop typecheck lane).

---

## TESTING STRATEGY

### Rust Tests (`cargo test` in `apps/desktop/src-tauri` — LOCAL gate, not CI)
- `keychain.rs`: a `ServerConfig` round-trip under a test service (store → load → assert eq → clear →
  assert `None`), alongside the existing `Stored` round-trip — never touching a real credential.
- `server.rs`: pure-helper tests — `compose_args` (builds `["compose","-f","<dir>/docker-compose.yml",
  "up","-d","archive"]`), `health_url` (with/without trailing slash, mirror `monitor_url`),
  `parse_archive_health` (golden NDJSON `{"Service":"archive","State":"running","Health":"healthy"}` →
  `"healthy"`; a line for a different service → ignored; empty → `"stopped"`), and `ingest_env` (required
  trio present; optionals included only when set; **a test asserting a secret value is not leaked** by any
  formatting/Debug path).
- Existing `proxy.rs` `monitor_url`, `pairing.rs` `pair_url`, `sidecar.rs` `parse_event_line`, and the
  `keychain` `Stored` round-trip MUST still pass (the proxy change only swaps the var source; helpers are
  untouched).

### Webview
- The enforced `typecheck:desktop` lane (in `repo-health`). No webview unit-test runner this slice
  (mirrors the dashboard + Slices 1-3 — typecheck + build only).

### Integration (must actually RUN — CLAUDE.md gate)
- `npm run repo-health -- --require-db` with the `*.int.test.ts` layer **running (0 skipped)** at sign-off.
  Slice 4 changes **no** DB-backed or collector code, so this is regression insurance (it proves the
  existing pairing route + capture path + projections still pass), not new coverage. A green suite with
  int tests **skipped is not evidence** — bring the test DB up (`npm run db:up && npm run db:migrate`)
  first, then assert N int tests ran, 0 skipped.

### Edge Cases
- **Docker not installed / daemon down** → `Command::new("docker")` `NotFound` or non-zero exit →
  `Err("Docker not installed/not running: …")` → panel shows it (no crash, no silent failure).
- **`serverDir` wrong / ingest not built** → `dist/server.js` missing → `Err("ingest not built — run
  npm run build in <serverDir>")`; **`node` not on PATH** → friendly `Err`.
- **Start ingest before config set** → `keychain::load_server()` is `None` → `Err("server not
  configured")` → panel guides to fill Settings.
- **Injected env wins over `.env`** → the supervised ingest uses the keychain `ADMIN_TOKEN`/`DATABASE_URL`
  even if a stale repo `.env` differs (spike-proven) → the monitor proxy (same keychain token) authes 200.
- **App quit while ingest running** → `RunEvent::Exit` → `server::shutdown` kills the child → no zombie
  node process; `docker compose` containers keep running (data persists) unless the user `Stop Archive`d.
- **Secret isolation** → `get_server_config` returns only presence booleans + non-secret fields; assert
  in DevTools that no secret string is reachable from any webview surface (mirrors the Slice-2/3 token
  assertion). **No plaintext `.env` is written by the GUI path.**
- **Re-save non-secret prefs** → blank secret fields merge to the existing keychain values (a secret the
  webview can't see is not wiped).

---

## VALIDATION COMMANDS

All runnable from the repo root. Each is a GATE.

### Level 1: Syntax & Style / Typecheck
- `npm run typecheck` — root `tsc -b`, **exit 0** (UNCHANGED by this slice — sanity that the root graph
  didn't regress).
- `npm run typecheck:desktop` — webview `tsc --noEmit`, **exit 0** (`bridge.ts` + `Settings.tsx` + `App.tsx`).

### Level 2: Unit Tests
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` — **pass** (server-config + `Stored`
  keychain round-trips, `compose_args`/`health_url`/`parse_archive_health`/`ingest_env`, plus the existing
  `monitor_url`/`pair_url`/`parse_event_line`). *Local/Windows gate.*
- `npx vitest run packages/shared apps/collector` — **pass** (no new TS tests; confirms no regression in
  the unchanged root graph).

### Level 3: Integration / Full Gate
- `npm run repo-health` — **PASS** (includes the desktop typecheck lane; root graph unchanged).
- `npm run db:up && npm run db:migrate && npm run repo-health -- --require-db` — **PASS, the
  `*.int.test.ts` layer ran, 0 skipped** (regression insurance — Slice 4 adds no DB code).

### Level 4: Manual / Build Validation (local, Windows)
- `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml` — compiles clean (no new dep).
- `npm run build:desktop` (= `build:collector-sea` + webview build + `cargo tauri build`); launch the `.exe`:
  - **Configure**: open Settings → set `serverDir` (repo root), `ingestUrl`, `adminToken`, `databaseUrl`
    (`postgres://420ai:420ai@localhost:5433/420ai`), `archiveEncryptionKey` → Save → `cmdkey /list |
    findstr 420ai` (or Credential Manager UI) shows TWO entries; **DevTools shows no secret string**
    webview-reachable; **no `.env` written by the app**.
  - **Start stack**: Start Archive → `docker compose ps` shows `420ai-archive` healthy; Start Ingest →
    Refresh health → archive `healthy` + ingest `up`; `GET http://localhost:8420/v1/health` → ok.
  - **Monitor proxy via keychain**: the Sync & Health panel now renders the server snapshot using the
    **keychain** admin token (no `ADMIN_TOKEN` env set) — proves the `proxy.rs` migration.
  - **Stop + no zombie**: Stop Ingest → health ingest `false`; quit the app while ingest is running →
    `tasklist | findstr node` shows no orphaned ingest; Stop Archive → containers down (data persists).
  - **Unpair**: click Unpair → `get_pairing_status` → `paired:false`; the pairing keychain entry is gone.
  - **Failure surfaces**: stop Docker Desktop → Start Archive → panel shows "Docker not running"; point
    `serverDir` at a non-built tree → Start Ingest → "ingest not built — run npm run build".

### Level 5: Additional (optional)
- `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml` — no warnings (advisory; not in CI).

---

## ACCEPTANCE CRITERIA

- [ ] The Settings panel edits server config; secrets are stored in the **Windows Credential Manager**
      (a SECOND entry, separate from the Slice-3 pairing token), **never** in a plaintext file, and
      **never** returned to / reachable from the webview (`get_server_config` carries only presence
      booleans + non-secret fields).
- [ ] Full supervision works from the UI: **Start/Stop Archive** (`docker compose up -d archive`/`down`)
      and **Start/Stop Ingest** (`node <serverDir>/apps/ingest/dist/server.js` with keychain secrets
      injected as env); **Refresh health** shows archive (`docker compose ps`) + ingest (`/v1/health`).
- [ ] The supervised ingest receives its secrets as **injected env that wins over the repo `.env`** — no
      plaintext `.env` is written by the app (Resolution #4, spike-proven).
- [ ] Quitting the app **kills the ingest child** (no zombie `node`); `docker` containers persist until
      Stop Archive (data volume safe).
- [ ] `proxy.rs` `get_monitor_snapshot` reads the admin token + ingest URL from the **keychain**
      (env fallback preserved); the token never reaches the webview.
- [ ] **No control-protocol change and no version bump** — `CONTROL_PROTOCOL_VERSION` stays
      `"m11-control-v2"`; the root `tsc -b` graph (`packages/shared` + `apps/collector` + db/ingest) is
      unchanged (Resolution #2).
- [ ] **No capability edit** — `capabilities/default.json` is unchanged (Resolution #1); **no new Rust
      crate** in `Cargo.toml`.
- [ ] Failures surface clearly (Docker down, ingest not built, node missing, server not configured) — no
      silent failure, no crash.
- [ ] Unpair clears the pairing keychain entry; the CLI `pair` + `~/.420ai/credentials.json` path is
      still untouched.
- [ ] `npm run typecheck`, `npm run typecheck:desktop`, `cargo build`, and `cargo test` all pass.
- [ ] `npm run repo-health -- --require-db` PASSES with the int layer ran (0 skipped).
- [ ] No artifacts staged (SEA `.exe`, Rust `target/`, webview `dist/` all gitignored/absent).

## COMPLETION CHECKLIST

- [ ] All tasks completed in order; each VALIDATE ran and passed immediately.
- [ ] `npm run repo-health` (and `--require-db` at sign-off) PASS.
- [ ] No linting/type errors (root + desktop lanes); `cargo build`/`cargo test` clean.
- [ ] Manual smoke of the built `.exe`: configure (2 keychain entries, no secret in webview, no `.env`
      written), start archive + ingest, health green, monitor proxy via keychain, stop + no zombie,
      unpair, failure surfaces.
- [ ] Acceptance criteria all met.
- [ ] Commit independently (this is one slice); the bundle plan's Slice 5 (packaging & docs) is untouched.

## NOTES

**Design decisions locked for this slice (user-confirmed 2026-06-16):**
1. **Full server supervision** (Rust owns Docker archive AND the ingest Node process AND health) — the
   ratified bundle decision; mechanics are spike-retired (Docker v2 control, `node dist/server.js`
   launch, injected-env-wins-over-`.env`, clean kill).
2. **Settings = server config only** — NO new collector config fields (watch interval / paths / DB path
   deferred), so no control-protocol change and no version bump (Resolution #2/#3).
3. **Secrets in the keychain, a SECOND entry**; `proxy.rs` reads keychain with env fallback; Rust injects
   secrets as the spawned ingest's env (no plaintext `.env`) (Resolution #4).
4. **Supervision is Rust-side `std::process::Command`** (not the shell plugin / not a sidecar) → no
   capability entry, no new crate.

**Documented assumptions (surfaced, not silently assumed):**
- The supervised ingest is launched as **`node <serverDir>/apps/ingest/dist/server.js`** — this requires
  the **repo present + `apps/ingest/dist/` built (`npm run build`/`tsc -b`) + `node` on PATH**. The app
  makes `serverDir` configurable and surfaces a clear error when any prerequisite is missing; it does NOT
  build ingest for the user (a "build ingest from the UI" affordance is out of scope). If you'd prefer
  `tsx`/dev launch or an auto-build step, that's a scope change — flag before implementing.
- The supervised ingest is a **one-shot managed child** (kept in `ServerState`, killed on app exit), NOT
  restart-with-backoff like the sidecar — simpler and sufficient; a backoff loop is a deferred polish.

**Deferred to Slice 5 (packaging & docs):** app/tray icon polish, `build:desktop` clean-checkout sign-off,
SUMMARY/PRD/CONTEXT updates (mark M11 built; record the SEA recipe + the supervision model), and any ADR
note. A "build ingest from the UI" button and ingest restart-with-backoff are post-M11 refinements.

**Risks:** (1) the operational unknowns (Docker control, ingest launch + injected env, clean kill) are
**spike-retired** on this machine. (2) The Windows-only manual smoke (Docker + two processes) is not
reproducible in CI — it is the inherent −risk of this slice (same as Slices 1-3's local build/keychain
smoke). (3) `serverDir`/PATH assumptions are mitigated by explicit, friendly error surfaces.

**Confidence (one-pass for Slice 4): 9.4/10.** The dominant unknown (full-supervision feasibility) is
empirically retired by the pre-flight spike (Docker v2 control + JSON parse, `node dist/server.js` launch,
**injected env beats `.env`** so secrets stay off disk, clean kill / no zombie); there is **no new Rust
crate** and **no protocol/collector/db change** (root `tsc -b` untouched); `proxy.rs`/`keychain.rs`/
`Settings.tsx` mirror Slice-2/3 patterns almost verbatim; and the supervisor reuses the proven
`sidecar.rs` managed-child shape. The −0.6 is the manual-only Windows smoke (Docker + two live processes,
not reproducible in CI) and the first-ever Rust process-supervision of *external* programs (compile- and
spike-verified, but `child.kill()`/`docker down` are only exercised by hand).
