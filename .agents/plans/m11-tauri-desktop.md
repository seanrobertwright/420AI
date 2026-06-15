# Feature: M11 — Tauri Desktop / Tray Collector

The following plan should be complete, but it's important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to naming of existing
utils, types, and models. Import from the right files.

> **Conventions are NOT re-pasted here.** The single source of truth is
> [`CLAUDE.md`](../../CLAUDE.md) (workspaces, TS/module rules, the "libraries never write to stdout"
> boundary, the **Frontend workspace** treatment, and **Validation is a GATE**). Read it first. Build
> background is [`SUMMARY.md`](../../SUMMARY.md); domain terms are [`docs/CONTEXT.md`](../../docs/CONTEXT.md);
> the milestone spec is [`docs/PRD.md`](../../docs/PRD.md) §25 item 11.

## Feature Description

A Windows **desktop + system-tray control surface** for the existing headless collector. A Tauri v2
(Rust) shell embeds a webview UI (shadcn/ui + theGridCN — the dashboard's visual layer) and bundles the
**unchanged M3 capture core** (queue, watchers, tailer, sync worker, connectors) as a `node:sea`
**sidecar** (`externalBin`) whose lifecycle Rust supervises. The user gets a tray they can drive
(running/paused/error + start/pause/resume), connector management, sync & health (reusing M10
`deriveAlerts`), GUI pairing + run-on-login, and a settings panel that manages **both** the collector
config **and** the local archive/ingest server config — with secrets in the **Windows Credential
Manager**, never plaintext on disk. The app can also **start/stop/health-check the local server stack**
(Docker Postgres + ingest API).

The CLI (`apps/collector/src/cli.ts`) **coexists unchanged** for headless/server/automation use.

## User Story

```
As a developer running the 420AI collector on my workstation
I want a desktop app + tray icon that controls capture, pairing, connectors, sync health, and my local
   server stack — without touching a terminal
So that the collector is a first-class always-on tool I can see and steer, with secrets kept in the OS
   keychain instead of a plaintext file
```

## Problem Statement

Today the collector is terminal-only: pairing, watching, sync, and discovery are CLI subcommands
(`apps/collector/src/cli.ts`), credentials sit in plaintext `~/.420ai/credentials.json`, and there is no
at-a-glance status, no run-on-login, and no way to manage the local server stack from a UI. There is no
graphical surface for a non-terminal user, and operational alerts (M10) are only visible in the web
dashboard.

## Solution Statement

Add a **sidecar desktop app** (`apps/desktop`): a thin Tauri/Rust shell that supervises the proven Node
collector (packaged via `node:sea`) and relays a **JSON-lines stdio control protocol** to a
shadcn/theGridCN webview via Tauri events. Rust owns all OS-native concerns (tray, keychain, child
supervision, Docker/process control, autostart); the webview owns presentation and reuses
`@420ai/shared` (`deriveAlerts`, wire types); the Node sidecar grows a **`serve` entry** that speaks the
protocol and otherwise reuses the M3 engine verbatim. Both design points were proven end-to-end by the
control-protocol spike.

## Feature Metadata

**Feature Type**: New Capability (first post-V1 milestone; first Rust surface in the repo)
**Estimated Complexity**: **High** (new language, OS-native integration, large control surface)
**Primary Systems Affected**: NEW `apps/desktop` (Rust shell + webview); `apps/collector` (new `serve`
entry + SEA build, capture core untouched); root gate (`scripts/repo-health.mjs`, root `package.json`,
CI workflow); `packages/shared` (reused as-is; possibly one new control-protocol type module).
**Dependencies**: Rust/Cargo (1.95 present), `tauri` v2 + `tauri-cli` 2.11 (present), `node:sea`
(built-in), `esbuild` + `postject` (build-time, add as devDeps), a Tauri keychain plugin
(`tauri-plugin-keyring` or `tauri-plugin-stronghold`), `tauri-plugin-autostart`. WebView2 runtime present.

---

## ⚠️ BUILD AS A BUNDLE OF SLICES (do NOT attempt in one pass)

M11 is too large for a single execute pass. Mirror the **M10 hardening bundle** approach
(`.agents/plans/m10-operational-alerts.md`): ship the *thinnest end-to-end pipe first*, then thicken.
Each slice is independently committable, passes the gate, and is a natural `/lril:execute` unit. **The
first execute pass should target Slice 1 only.** Re-run `/lril:plan-feature` to expand any later slice
into its own task-level plan if needed.

| Slice | Title | Delivers | Gate at end |
|---|---|---|---|
| **1** | **Walking skeleton** | Collector `serve` entry + protocol + SEA build; Tauri shell scaffold (`apps/desktop`) supervising the sidecar; tray with status + start/pause/resume; minimal webview showing live status. Gate lanes wired. | `repo-health` green + local `tauri build` produces a runnable `.exe` that captures & syncs. |
| **2** | **Sync & health + connectors** | Webview Sync & Health panel (local sidecar status + Rust-proxied `/monitor` snapshot → `deriveAlerts`); connector enable/disable + config + permission-scope review. | + connector toggles round-trip; alerts render. |
| **3** | **Pairing & autostart + keychain** | GUI pairing (URL + code) replacing CLI `pair`; secrets → Windows Credential Manager (Rust-owned, injected to sidecar via `configure`); run-on-login. | + paired from GUI, token never on disk, autostart toggles. |
| **4** | **Settings + full server supervision** | Settings for collector AND server env; Rust start/stop/health-check Docker archive + ingest API. | + server stack start/stop/health from UI. |
| **5** | **Packaging & docs** | `tauri build` artifact polish (icons, tray asset), `build:desktop` sign-off lane, SUMMARY/PRD/CONTEXT updates. | + documented local build recipe; milestone sign-off. |

The task list below is **complete across all slices**, grouped by slice and ordered by dependency.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

- `docs/research/m11-tauri-sidecar-spike.md` — Why: toolchain/feasibility, sidecar mechanism, tray
  gotchas (tauri#8982 duplicate tray icons), packaging approach. **Decisions ratified are listed here.**
- `docs/research/m11-control-protocol-spike.md` — Why: the **validated** SEA build recipe, the
  stdin/stdout JSON-lines protocol shape, and four spike-proven constraints (no sqlite flag; stderr/stdout
  discipline; SEA needs an explicit `main()`; bundle from TS source not `dist`). **The serve entry and
  build script below MUST agree with this doc's assertions.**
- `apps/collector/src/cli.ts` (lines 146–170 `runWatch`, 311–482 `main`/`isMain`) — Why: `runWatch`
  already takes `creds` + `signal` + `logger`; the new `serve` entry reuses this. **`isMain()`
  (463–471) does NOT fire under SEA** — the serve entry must call `main()` explicitly.
- `apps/collector/src/capture-engine.ts` (whole file) — Why: `runCaptureEngine({creds, signal, logger,
  collectorVersion, heartbeatIntervalMs})` is the loop the serve mode drives. It is **AbortSignal-driven**
  (pause/resume/stop map to abort/restart) and exposes queue stats. **Reuse unchanged.**
- `apps/collector/src/queue/queue-store.ts` (lines 43–60) — Why: `QueueStats {pending, inflight}` and
  `QueueStore(path, now)` are the `status` event payload source. `node:sqlite`, proven SEA-safe.
- `apps/collector/src/identity.ts` (whole file) — Why: `Credentials {url, token, machineId}`,
  `saveCredentials`/`loadCredentials` (plaintext, mode 0600), `COLLECTOR_HOME`. Slice 3 moves the GUI
  path's secret to keychain; **the CLI path and on-disk shape stay unchanged** (byte-compatible).
- `apps/collector/src/ingest-client.ts` (`postPair`, `postIngest`, `postDiscover`, `getProjects`,
  `isUnauthorized`) — Why: the serve `pair`/`discover` commands reuse these; `runPair`
  (`cli.ts:90–106`) is the pairing primitive.
- `apps/collector/src/connectors/connector.ts` (lines 45–77) — Why: the `Connector` contract +
  `connectors[]` registry are what "connector management" enables/disables and shows fidelity for. **NOTE:
  there is no per-connector enable/disable or config persistence today** — Slice 2 adds it (see Gotcha).
- `packages/shared/src/alerts.ts` (whole file) — Why: `deriveAlerts(snapshot): OperationalAlert[]` is
  **pure + reused as-is** in the webview. Takes a `LiveMonitorSnapshot`.
- `packages/shared/src/monitor.ts` — Why: `LiveMonitorSnapshot`, `MonitorStatus`, `deriveMachineStatus`,
  `isBacklogHigh`, `MONITOR_VERSION`. The serve `status` event and the proxied snapshot use these shapes.
- `apps/ingest/src/routes/monitor.ts` — Why: the `/monitor` endpoint the desktop proxies for `deriveAlerts`.
  **Confirm its auth scope** (admin vs machine token) and proxy with the matching token.
- `apps/dashboard/` — Why: **the pattern to mirror for the webview.** Specifically:
  - `apps/dashboard/tsconfig.json` — the `moduleResolution: bundler` + `jsx` + `paths {@/*}` config to
    copy (the desktop webview tsconfig mirrors this; it stays OUT of root `tsc -b`).
  - `apps/dashboard/src/lib/utils.ts` (`cn`), `src/components/ui/{card,table,badge}.tsx`,
    `src/app/globals.css` — **hand-written shadcn primitives to copy** (CLAUDE.md: hand-write, don't
    `npx shadcn init`).
  - `apps/dashboard/src/lib/ingest.ts` + `src/app/api/monitor/route.ts` — the **server-side proxy that
    holds the token** pattern. In the desktop, the equivalent is a Rust `#[command]` (Rust holds the
    token); the webview never sees it. Same invariant, different transport.
  - `apps/dashboard/src/app/api/monitor/stream/route.ts` + `src/components/live-monitor.tsx` — the SSE
    "arm teardown BEFORE the first await / pass the signal" leak-window pattern (CLAUDE.md "long-lived
    resource"). The Rust↔sidecar relay and the webview event listener are the M11 analog — apply the
    same discipline (attach the stdout listener before the first await; kill the child on app exit).
- `scripts/repo-health.mjs` (lines 117–131 the dashboard lane) — Why: the desktop webview typecheck lane
  is added by **mirroring this exact block**.
- `package.json` (lines 26–27 `typecheck:dashboard`/`build:dashboard`) — Why: add sibling
  `typecheck:desktop`/`build:desktop`/`build:collector-sea` scripts the same way.
- `.github/workflows/repo-health.yml` — Why: CI is `ubuntu-latest` → it runs the webview typecheck lane
  but **NOT** `tauri build` (Windows/WebView2/Rust). The Rust build is a documented local sign-off.

### New Files to Create

**Collector (Slice 1):**
- `apps/collector/src/serve.ts` — the `serve` entry: the JSON-lines stdio protocol loop driving
  `runCaptureEngine`. The SEA `main`.
- `apps/collector/src/serve.test.ts` — unit tests for the protocol state machine (inject stdin/stdout
  streams + a fake engine; assert command→event round-trip, pause holds, stop drains).
- `apps/collector/scripts/build-sea.mjs` — the validated esbuild→`node:sea`→postject pipeline (from the
  control-protocol spike), emitting `apps/desktop/src-tauri/binaries/collector-x86_64-pc-windows-msvc.exe`.
- `packages/shared/src/control-protocol.ts` (+ `.test.ts`) — the command/event union types + a
  `CONTROL_PROTOCOL_VERSION` stamp (so Rust and Node agree on the schema; webview imports the types too).
  Export from `packages/shared/src/index.ts`.

**Desktop app (`apps/desktop`):**
- `apps/desktop/package.json` — webview workspace (Vite + React 19 + Tailwind v4 + shadcn deps, mirroring
  `apps/dashboard`), with `dev`/`build`/`typecheck` scripts.
- `apps/desktop/tsconfig.json` — mirrors `apps/dashboard/tsconfig.json` (bundler + jsx; OUT of root graph).
- `apps/desktop/vite.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx` — the SPA entry.
- `apps/desktop/src/lib/utils.ts`, `src/components/ui/{card,table,badge}.tsx`, `src/styles/globals.css`
  — copied hand-written shadcn primitives.
- `apps/desktop/src/lib/bridge.ts` — typed wrappers over Tauri `invoke`/`listen` (commands + events),
  importing the `@420ai/shared` control-protocol types.
- `apps/desktop/src/components/{StatusBar,SyncHealth,Connectors,Pairing,Settings}.tsx` — the panels
  (added per slice).
- `apps/desktop/src-tauri/` — `Cargo.toml`, `tauri.conf.json`, `build.rs`, `src/main.rs`, `src/lib.rs`,
  `src/sidecar.rs` (spawn/supervise + protocol relay), `src/tray.rs`, `src/keychain.rs` (Slice 3),
  `src/server.rs` (Slice 4 Docker/ingest control), `binaries/.gitkeep`, `icons/`.
- `apps/desktop/.gitignore` — `dist/`, `src-tauri/target/`, `binaries/*.exe` (artifacts; `target/` and
  `src-tauri/target/` are already in the root `.gitignore`).

### Relevant Documentation — READ BEFORE IMPLEMENTING

- [Tauri v2 — Embedding External Binaries (sidecar)](https://v2.tauri.app/develop/sidecar/) — `externalBin`
  config + the `-$TARGET_TRIPLE` suffix requirement (`collector-x86_64-pc-windows-msvc.exe`).
- [Tauri v2 — Node.js as a sidecar](https://v2.tauri.app/learn/sidecar-nodejs/) — the exact pattern;
  spawning from Rust + piping stdio.
- [Tauri v2 — System Tray](https://v2.tauri.app/learn/system-tray/) — `TrayIconBuilder` + `MenuBuilder`
  + `on_menu_event`. **Gotcha:** build the tray once in `setup` (tauri#8982 duplicate icons in dev).
- [Tauri v2 — Calling Rust from the Frontend](https://v2.tauri.app/develop/calling-rust/) — `#[command]`,
  `invoke`, `Channel`/event emission to the webview.
- [Tauri v2 — Calling the Frontend from Rust (events)](https://v2.tauri.app/develop/calling-frontend/) —
  `app.emit(...)` to relay sidecar status events.
- [Tauri v2 — Autostart plugin](https://v2.tauri.app/plugin/autostart/) — run-on-login (Slice 3).
- [tauri-plugin-keyring](https://github.com/HuakunShen/tauri-plugin-keyring) **or**
  [Tauri v2 Stronghold](https://v2.tauri.app/plugin/stronghold/) — OS keychain (Slice 3). **Validate the
  chosen plugin installs/resolves before relying on it** (see Phase-2 gotcha about M9's `server-only`).
- [Node SEA](https://nodejs.org/api/single-executable-applications.html) — the packaging mechanism
  (recipe already validated in the spike).
- [std::process::Command](https://doc.rust-lang.org/std/process/struct.Command.html) — Rust child spawning
  (sidecar + `docker compose`); kill-on-exit, piped stdio.

### Patterns to Follow

**Logging / process boundary (CLAUDE.md "Logging / process boundaries"):** library files never write to
stdout. The serve entry is an **entrypoint** (like `cli.ts`) — it owns argv/stdio — but its **stdout is
reserved for the JSON-lines protocol ONLY**. Everything else (the engine's `logger` callback, warnings)
goes to **stderr** or becomes a `{type:"log"}` event. This is the load-bearing rule from the spike.

**AbortSignal lifecycle (mirror `capture-engine.ts:57–94`):** capture is started/stopped via an
`AbortController`. `pause` = abort the current engine run + retain the queue; `resume` = start a fresh
`runCaptureEngine` with a new controller; `stop` = abort + final drain + exit. Never mutate engine
internals — only the signal.

**Frontend workspace (CLAUDE.md "Frontend workspace"):** `apps/desktop` mirrors `apps/dashboard` — it is
**NOT referenced by the root `tsconfig.json`** (stays out of `tsc -b`), and gets its **own enforced
lanes** wired into `repo-health` (webview typecheck) + a local sign-off (`tauri build`). Hand-write
shadcn primitives; reserve the CLI for registry-only theGridCN components and **build-verify every add**.

**Token never in the webview (mirror dashboard proxy invariant, CLAUDE.md "Frontend workspace"):** the
webview never holds the ingest/admin token. Rust holds secrets (keychain) and is the only thing that adds
the bearer on the Rust→ingest hop. Webview → Rust `#[command]` → ingest. Assert: 0 occurrences of the
token in any webview-reachable surface.

> **Spike-snippet fidelity:** the serve entry and `build-sea.mjs` below encode behavior the
> control-protocol spike proved. The assertions are stated inline next to each — if the transcribed code
> drifts from them, trust the spike doc.

**Control-protocol schema (define in `packages/shared/src/control-protocol.ts`):**

```ts
// Commands: webview → Rust(#[command]) → sidecar stdin (one JSON object per line)
export type ControlCommand =
  | { cmd: "configure"; url: string; token: string; machineId?: string } // Slice 3: inject creds (no disk)
  | { cmd: "start" }                  // begin capture (requires configured creds)
  | { cmd: "pause" }
  | { cmd: "resume" }
  | { cmd: "status" }                 // request an immediate status event
  | { cmd: "pair"; url: string; code: string; name?: string } // Slice 3: GUI pairing
  | { cmd: "discover" }               // optional: trigger M5 discovery
  | { cmd: "stop" };                  // graceful drain + exit

// Events: sidecar stdout → Rust → app.emit → webview listen
export type ControlEvent =
  | { type: "ready"; pid: number; collectorVersion: string; paired: boolean }
  | { type: "status"; state: "running" | "paused" | "idle" | "error";
      pending: number; inflight: number; lastSyncAt?: string | null }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "paired"; machineId: string }
  | { type: "ack"; cmd: string }
  | { type: "stopped" }
  | { type: "error"; message: string; cmd?: string };

export const CONTROL_PROTOCOL_VERSION = "m11-control-v1" as const;
```
> Assertion (spike): under `node` AND the SEA `.exe`, `status` reflects `state` correctly, `pause` holds
> `pending` steady, `resume` advances it, `stop` emits `stopped` then exits 0. stdout carried ONLY these
> JSON lines (the `node:sqlite` ExperimentalWarning went to stderr).

**Validated SEA build recipe (encode in `apps/collector/scripts/build-sea.mjs`):**
```
esbuild apps/collector/src/serve.ts --bundle --platform=node --format=cjs --target=node24 \
  --external:node:* --outfile=<tmp>/collector.cjs        # bundle FROM SOURCE (not dist)
# sea-config: { "main":"<tmp>/collector.cjs", "output":"<tmp>/sea-prep.blob", "disableExperimentalSEAWarning":true }
node --experimental-sea-config <sea-config>
copy process.execPath -> apps/desktop/src-tauri/binaries/collector-x86_64-pc-windows-msvc.exe
postject <exe> NODE_SEA_BLOB <tmp>/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```
> Assertions (spike): `node:sqlite` needs NO runtime flag in Node 24.16; artifact ≈ 88 MB; the
> "signature seems corrupted" postject warning on Windows is EXPECTED (patching signed `node.exe`).
> esbuild must bundle the **TS source** (`dist/cli.js` failed sibling resolution).

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation (Slice 1) — collector `serve` + SEA + Tauri scaffold

Establish the protocol contract, the serve entry, the reproducible SEA build, and a Tauri shell that
supervises the sidecar with a tray. End state: a runnable `.exe` that captures & syncs, driven from the
tray.

**Tasks:** control-protocol types in shared → `serve.ts` reusing `runCaptureEngine` → `serve.test.ts` →
`build-sea.mjs` → `apps/desktop` Vite+React scaffold (copy dashboard primitives) → `src-tauri`
(sidecar spawn/relay + tray) → wire gate lanes.

### Phase 2: Core Implementation (Slices 2–4)

Sync & health (reuse `deriveAlerts` via Rust proxy) + connector management; then GUI pairing + keychain
secrets + autostart; then settings + full server-stack supervision (Docker + ingest).

### Phase 3: Integration

Each slice integrates the webview ↔ Rust ↔ sidecar triangle; Slice 4 integrates Rust ↔ Docker/ingest.
Gate lanes (`typecheck:desktop`, `build:collector-sea`, `build:desktop`) are wired in Slice 1 and remain
green throughout.

### Phase 4: Testing & Validation

Node-side: vitest unit tests for the protocol state machine + the build script's bundle step (assert the
`.cjs` is produced and runs under `node`). Rust-side: `cargo test` for the relay parser. Webview: typecheck
lane. Manual: launch the built `.exe`, exercise each panel; assert token never in webview surface; assert
the integration layer (collector ↔ ingest) still runs under `--require-db`.

---

## STEP-BY-STEP TASKS

Execute in order. **Stop after Slice 1 for the first `/lril:execute` pass.**

### ───────── SLICE 1: WALKING SKELETON ─────────

### CREATE `packages/shared/src/control-protocol.ts`
- **IMPLEMENT**: The `ControlCommand` / `ControlEvent` unions + `CONTROL_PROTOCOL_VERSION` exactly as in
  Patterns above. Pure types + the version const. No runtime logic.
- **PATTERN**: Mirror `packages/shared/src/alerts.ts` header-doc style + the `ALERT_VERSION` stamp
  (`alerts.ts:36`).
- **IMPORTS**: none (or `import type` from `./monitor.js` if you reference snapshot shapes).
- **GOTCHA**: relative import in `index.ts` must end in `.js` (NodeNext); use `import type`.
- **VALIDATE**: add `export * from "./control-protocol.js";` to `packages/shared/src/index.ts`, then
  `npm run typecheck` (exit 0).

### CREATE `apps/collector/src/serve.ts`
- **IMPLEMENT**: The serve entrypoint. Read newline-delimited JSON commands from `process.stdin`
  (`readline.createInterface`); maintain an `AbortController` for the current capture run; map
  `start`/`resume` → spawn `runCaptureEngine({creds, signal, logger, collectorVersion, heartbeatIntervalMs})`,
  `pause`/`stop` → `controller.abort()` (stop also drains + `process.exit(0)`); emit `ControlEvent`s as
  JSON lines on **stdout**; route the engine `logger` callback to a `{type:"log"}` event (NOT stdout text);
  emit a periodic `status` (queue stats) on a timer; emit `ready` on boot. Creds come from `configure`
  (Slice 3) OR fall back to `loadCredentials()` for now (Slice 1 can use the saved pairing).
- **PATTERN**: `cli.ts` `runWatch` (146–170) for the engine call; `capture-engine.ts` (57–94) for the
  abort/drain lifecycle; the spike's `serve-spike.ts` for the stdin/stdout loop shape.
- **IMPORTS**: `runCaptureEngine` from `./capture-engine.js`; `loadCredentials`, `QUEUE_PATH`,
  `type Credentials` from `./identity.js`; `QueueStore` from `./queue/queue-store.js`; control types from
  `@420ai/shared`; `createInterface` from `node:readline`.
- **GOTCHA**: **stdout is protocol-only** — never `process.stdout.write` non-JSON. The `isMain()` guard
  pattern from `cli.ts` will NOT fire under SEA → call `main()` directly when this file is the entry (or
  give it an unconditional bottom-of-file `main()` invocation guarded by a cheap `process.env`-free check).
  Arm the stdin listener + the status timer **before** the first `await` (CLAUDE.md leak-window rule).
- **VALIDATE**: `npx vitest run apps/collector/src/serve.test.ts` (next task) + manual
  `echo '{"cmd":"status"}' | npx tsx apps/collector/src/serve.ts` prints a `status` JSON line.

### CREATE `apps/collector/src/serve.test.ts`
- **IMPLEMENT**: Drive the protocol with injected streams + a **fake engine** (inject a no-op
  `runCaptureEngine` seam, or a fake `QueueStore`): assert `ready` is emitted; `pause` then `status`
  reports `state:"paused"` and steady `pending`; `resume` advances; `stop` emits `stopped`. Mirror the
  spike's supervisor assertions.
- **PATTERN**: co-located vitest, dependency injection for determinism (CLAUDE.md "Testing"; e.g.
  `QueueStore(path, now)`). No infra → always runs.
- **GOTCHA**: do NOT make `serve.ts` `process.exit` in tests — gate the exit behind an injected
  `onStop`/exit seam so the test can assert without killing the runner.
- **VALIDATE**: `npx vitest run apps/collector/src/serve.test.ts` (all pass).

### CREATE `apps/collector/scripts/build-sea.mjs`
- **IMPLEMENT**: The validated recipe (esbuild from `src/serve.ts` → CJS → `node --experimental-sea-config`
  → copy `process.execPath` → postject inject), writing
  `apps/desktop/src-tauri/binaries/collector-x86_64-pc-windows-msvc.exe`. Use a temp dir for intermediates.
  Print a clear success line; exit non-zero on any step failure.
- **PATTERN**: `scripts/repo-health.mjs` style (`execSync`, `--flag` parsing, PASS/FAIL lines).
- **IMPORTS**: add `esbuild` and `postject` as **devDependencies** (root or `apps/collector`). Do NOT rely
  on a transitive esbuild. `postject` is the only genuinely new dep.
- **GOTCHA**: bundle the **TS source** (spike: `dist` sibling resolution failed). The postject "signature
  seems corrupted" warning is EXPECTED on Windows. `--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`.
  The `-x86_64-pc-windows-msvc` suffix is REQUIRED by Tauri sidecar bundling.
- **VALIDATE**: `node apps/collector/scripts/build-sea.mjs` then run the produced `.exe`:
  `echo '{"cmd":"status"}' | apps/desktop/src-tauri/binaries/collector-x86_64-pc-windows-msvc.exe` →
  a `status` JSON line (proves node:sqlite-in-SEA + protocol, exactly as the spike did).

### CREATE `apps/desktop` webview scaffold (`package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`)
- **IMPLEMENT**: A Vite + React 19 + Tailwind v4 SPA. `package.json` name `@420ai/desktop`, `"type":"module"`,
  scripts `dev`/`build`/`typecheck` (`tsc --noEmit`). Deps mirror `apps/dashboard/package.json` (react,
  react-dom, radix-ui, class-variance-authority, clsx, tailwind-merge, lucide-react, `@420ai/shared`,
  `@tauri-apps/api`) minus Next.js; add `@tauri-apps/cli` + `vite` + `@vitejs/plugin-react` as devDeps.
- **PATTERN**: copy `apps/dashboard/tsconfig.json` verbatim minus the `next` plugin + `.next/**` includes;
  keep `moduleResolution:bundler`, `jsx:react-jsx`, `paths {@/*}`, `verbatimModuleSyntax`, `noEmit`.
- **GOTCHA**: **Do NOT add `apps/desktop` to root `tsconfig.json` references** (it would break the
  NodeNext/composite root graph — same reason `apps/dashboard` is excluded). Use **Vite** not Next
  (the webview is a static SPA Tauri serves; Next is server-oriented).
- **VALIDATE**: `npm run typecheck -w @420ai/desktop` (exit 0); `npm run build -w @420ai/desktop` produces
  `apps/desktop/dist/`.

### CREATE `apps/desktop/src/lib/utils.ts` + `src/components/ui/{card,table,badge}.tsx` + `src/styles/globals.css`
- **IMPLEMENT**: Copy the hand-written primitives from `apps/dashboard/src/lib/utils.ts` (the `cn` helper)
  and `apps/dashboard/src/components/ui/*` + `globals.css`.
- **PATTERN**: identical to dashboard (CLAUDE.md: hand-write primitives in automated execution; do not
  `npx shadcn init`).
- **GOTCHA**: reserve the shadcn/theGridCN **CLI for registry-only** components and **build-verify every
  add** (the `@thegridcn/hud` barrel ships broken). Import paths use the `@/*` alias.
- **VALIDATE**: `npm run typecheck -w @420ai/desktop` (exit 0).

### CREATE `apps/desktop/src/lib/bridge.ts` + `src/components/StatusBar.tsx` + wire `App.tsx`
- **IMPLEMENT**: `bridge.ts` exposes typed `invoke`-wrappers (`sendCommand(cmd: ControlCommand)`) and a
  `onControlEvent(cb)` over Tauri `listen`. `StatusBar` shows `state` + pending/inflight from the latest
  `status` event and has Start/Pause/Resume buttons.
- **PATTERN**: `apps/dashboard/src/components/live-monitor.tsx` for the event-subscription + teardown shape
  (attach listener before first await; unlisten on unmount).
- **IMPORTS**: `invoke`, `listen` from `@tauri-apps/api`; control types from `@420ai/shared`.
- **GOTCHA**: register the `listen` handler in a `useEffect` and return its unlisten; mirror the SSE
  leak-window discipline.
- **VALIDATE**: `npm run typecheck -w @420ai/desktop` (exit 0).

### CREATE `apps/desktop/src-tauri/` (`Cargo.toml`, `tauri.conf.json`, `build.rs`, `src/main.rs`, `src/lib.rs`, `src/sidecar.rs`, `src/tray.rs`)
- **IMPLEMENT**: Tauri v2 app. `tauri.conf.json`: `bundle.externalBin = ["binaries/collector"]`,
  `frontendDist = "../dist"`, `devUrl` = Vite dev server, app identifier `ai.420.desktop`.
  `sidecar.rs`: spawn the sidecar via the shell/process API with **piped stdin/stdout**; in a Tokio task,
  read stdout lines, parse as `ControlEvent` (serde), `app.emit("control-event", ev)`. Expose
  `#[command] send_command(state, cmd)` writing a JSON line to the child's stdin. **Own lifecycle**: kill
  the child on app exit; restart-with-backoff on unexpected exit; reflect health in the tray.
  `tray.rs`: `TrayIconBuilder` + menu (Status / Start / Pause / Resume / Quit) built **once in `setup`**.
- **PATTERN**: the two spike docs (sidecar mechanism + tray gotcha); Tauri sidecar-nodejs + system-tray
  guides.
- **GOTCHA**: build the tray ONCE in `setup` (tauri#8982 duplicate icons). Attach the stdout reader
  **before** any `.await` that could miss early lines. `RUST_LINES → stderr` of the sidecar should be
  surfaced as `log` events, not swallowed. The `-$TARGET_TRIPLE` binary must exist before `tauri build`
  (run `build-sea.mjs` first).
- **VALIDATE**: `node apps/collector/scripts/build-sea.mjs && npx tauri build` (from `apps/desktop`, with
  `ADMIN_TOKEN`/`INGEST_URL` or a saved pairing) → a runnable `.exe`; launch it, confirm tray + Start
  begins capture (queue `pending` rises in the StatusBar) and Pause holds.

### UPDATE `package.json` (root) — add gate scripts
- **IMPLEMENT**: add
  `"typecheck:desktop": "npm run typecheck -w @420ai/desktop"`,
  `"build:desktop": "npm run build -w @420ai/desktop && cd apps/desktop && npx tauri build"` (local sign-off),
  `"build:collector-sea": "node apps/collector/scripts/build-sea.mjs"`.
- **PATTERN**: mirror `typecheck:dashboard`/`build:dashboard` (lines 26–27).
- **VALIDATE**: `npm run typecheck:desktop` (exit 0).

### UPDATE `scripts/repo-health.mjs` — add the desktop webview typecheck lane
- **IMPLEMENT**: add a check mirroring the dashboard lane (117–131): run `npm run typecheck:desktop`;
  PASS/FAIL line; renumber the check banners (`[1/6] … [6/6]`).
- **PATTERN**: lines 117–131 verbatim, swapping `dashboard`→`desktop` and the script name.
- **GOTCHA**: this lane is the ONLY enforcement of webview types (root `tsc -b` can't see them — same as
  dashboard). The Rust/`tauri build` is **NOT** added to `repo-health` (CI is Linux; it's a local
  sign-off via `build:desktop`, documented in SUMMARY). Keep the gate Linux-runnable.
- **VALIDATE**: `npm run repo-health` (PASS, now including the desktop lane).

### CREATE `apps/desktop/.gitignore`
- **IMPLEMENT**: ignore `dist/`, `src-tauri/target/`, `src-tauri/binaries/*.exe` (the SEA artifact is
  built, not committed; commit `binaries/.gitkeep`).
- **GOTCHA**: confirm `repo-health`'s stray-artifact scan (scans `*/src/`) does NOT flag the Rust `target/`
  or the webview `dist/` (it only walks `packages|apps/*/src` for emitted JS — Rust/webview build output
  lives outside `src/`, so it's clean; verify after first build).
- **VALIDATE**: `git status` clean after a build (no artifacts staged); `npm run repo-health` PASS.

### ───────── SLICE 2: SYNC & HEALTH + CONNECTORS ─────────

### CREATE `apps/desktop/src-tauri/src/proxy.rs` + `#[command] get_monitor_snapshot`
- **IMPLEMENT**: Rust fetches the configured ingest `/monitor` endpoint with the bearer token (from
  keychain in Slice 3; from saved creds for now), returns the JSON `LiveMonitorSnapshot` to the webview.
- **PATTERN**: the dashboard proxy (`apps/dashboard/src/lib/ingest.ts` + `src/app/api/monitor/route.ts`) —
  **Rust is the token-holder**, webview never sees it.
- **GOTCHA**: confirm `/monitor` auth scope in `apps/ingest/src/routes/monitor.ts` and send the matching
  token. Pass a cancel signal so the fetch aborts with the app.
- **VALIDATE**: `cargo build` (in `src-tauri`); manual: webview receives a snapshot object.

### CREATE `apps/desktop/src/components/SyncHealth.tsx`
- **IMPLEMENT**: render local sidecar status (queue backlog/state from `status` events) + call
  `get_monitor_snapshot`, run **`deriveAlerts(snapshot)`** from `@420ai/shared`, render the alerts
  critical-first (reuse the dashboard's `alerts-panel.tsx` rendering as a guide).
- **PATTERN**: `apps/dashboard/src/components/monitor/alerts-panel.tsx`; `deriveAlerts` is pure + tested
  (`packages/shared/src/alerts.test.ts`) — **do not reimplement alert logic**.
- **VALIDATE**: `npm run typecheck:desktop`; manual: alerts render when a collector is stale/offline.

### ADD connector management (collector + desktop)
- **IMPLEMENT**: add **persisted per-connector enablement/config** to the collector (new field in a
  config file under `COLLECTOR_HOME`, read by the watcher to filter `connectors[]`); expose
  list/enable/disable/edit + fidelity + permission-scope review over the protocol (`{cmd:"connectors.list"}`,
  `{cmd:"connectors.set", id, enabled, config}`) and a `Connectors.tsx` panel.
- **PATTERN**: `connectors/connector.ts` (the `Connector` + `ConnectorFidelity` shape); `FileWatcher`
  consumes the filtered registry.
- **GOTCHA**: **there is NO per-connector enable/disable today** — this is new collector surface. Keep the
  capture core untouched: filter the `connectors[]` passed into `runCaptureEngine` (it already accepts a
  `connectors` option) rather than editing the registry. Extend the control-protocol union + bump
  `CONTROL_PROTOCOL_VERSION` if you add commands.
- **VALIDATE**: unit test the config read/filter; `npm run repo-health`; manual toggle round-trips.

### ───────── SLICE 3: PAIRING & AUTOSTART + KEYCHAIN ─────────

### ADD GUI pairing (`{cmd:"pair"}` in serve.ts + `Pairing.tsx`)
- **IMPLEMENT**: serve handles `{cmd:"pair", url, code, name}` → `runPair({url, code, name, persist:false})`
  (do NOT persist plaintext — hand the token to Rust via a `paired` event for keychain storage) → emit
  `{type:"paired", machineId}`. `Pairing.tsx` collects URL + code.
- **PATTERN**: `cli.ts:runPair` (90–106) + `ingest-client.postPair`.
- **GOTCHA**: `persist:false` so no plaintext `credentials.json` is written on the GUI path; Rust persists
  the token to the keychain instead (next task). The CLI `pair` path is unchanged.
- **VALIDATE**: manual pair against a running ingest; `machineId` returned; no plaintext token on disk.

### ADD keychain (`src-tauri/src/keychain.rs` + secret injection)
- **IMPLEMENT**: Rust stores/reads the ingest token (and Slice-4 server secrets) in Windows Credential
  Manager via the chosen plugin; on sidecar spawn, send `{cmd:"configure", url, token, machineId}` as the
  **first** stdin line (token in-memory only, never argv/disk). serve uses these creds for the engine.
- **PATTERN**: token-outside-the-DB discipline (PRD §18; CLAUDE.md). Mirror the dashboard's "token only on
  the server hop" invariant.
- **GOTCHA**: **validate the keychain plugin installs/resolves** before building on it (M9 lesson: a plan
  snippet imported an uninstalled `server-only`). Never log the token. Token via stdin `configure`, NOT
  argv (argv is visible in the process list).
- **VALIDATE**: `cargo build`; manual: token survives app restart from keychain; `serve` never reads
  `credentials.json` on the GUI path.

### ADD autostart (`tauri-plugin-autostart` + Settings toggle)
- **IMPLEMENT**: register the autostart plugin; a Settings toggle enables run-on-login.
- **PATTERN**: Tauri autostart plugin docs.
- **VALIDATE**: toggle on → entry appears in Windows startup; `cargo build`.

### ───────── SLICE 4: SETTINGS + FULL SERVER SUPERVISION ─────────

### CREATE `apps/desktop/src/components/Settings.tsx` + `#[command]`s for config
- **IMPLEMENT**: edit collector config (dashboard URL, machine name, watch interval, connector paths, DB
  path) AND server env (`DATABASE_URL`, `ADMIN_TOKEN`, `ARCHIVE_ENCRYPTION_KEY`, `ANALYSIS_*`). Non-secret
  prefs → a config file; **secrets → keychain** (never plaintext, per CLAUDE.md/PRD §18).
- **GOTCHA**: writing the ingest `.env` must go to the **server's CWD** (`apps/ingest` or a configured
  path), not the repo root (CLAUDE.md: Next/ingest load env from CWD). Secrets never written plaintext.
- **VALIDATE**: `npm run typecheck:desktop`; manual: settings persist; secrets only in keychain.

### CREATE `apps/desktop/src-tauri/src/server.rs` (Docker + ingest supervision)
- **IMPLEMENT** (the RATIFIED full-supervision decision): Rust `#[command]`s to
  `docker compose -f <configured> up -d` / `down` for the archive (Postgres), start/stop the ingest API
  process, and **health-poll** (`GET <ingestUrl>/health` + `docker compose ps`); surface up/down/health in
  the UI + tray.
- **PATTERN**: `std::process::Command`; mirror the sidecar supervision (Rust owns the child; kill on app
  exit; restart-with-backoff). The spike notes this is the same shape as sidecar supervision — the risk is
  operational, not feasibility.
- **GOTCHA**: assumes a **same-machine server** (the ratified decision). Surface `docker compose` failures
  (Docker not running, port in use) as clear UI errors, not silent. Never leave zombie processes on app
  quit. Make the compose-file path + ingest start command **configurable** (don't hardcode the dev repo
  layout).
- **VALIDATE**: manual: from the UI, start the stack → `db:up` equivalent runs, `/health` goes green;
  stop → containers down, no zombies.

### ───────── SLICE 5: PACKAGING & DOCS ─────────

### POLISH packaging + UPDATE docs
- **IMPLEMENT**: app/tray icons, `tauri build` artifact naming; verify `build:desktop` end-to-end on a
  clean checkout; update `SUMMARY.md` (mark M11 built; record the SEA build recipe + local sign-off),
  `docs/PRD.md` §25 (tick M11), `docs/CONTEXT.md` (any new terms: "sidecar", "control protocol"),
  and append an ADR-style note if a decision changed.
- **PATTERN**: `document-release` discipline; SUMMARY status block.
- **VALIDATE**: full `npm run repo-health -- --require-db` PASS (DB up); `npm run build:desktop` produces a
  runnable installer-less `.exe`; manual end-to-end smoke of all panels.

---

## TESTING STRATEGY

### Unit Tests (vitest, co-located — CLAUDE.md "Testing")
- `serve.test.ts`: protocol state machine via injected streams + fake engine (round-trip, pause-holds,
  stop-drains). Inject the exit seam so tests don't kill the runner.
- `control-protocol.test.ts`: type-level + a `CONTROL_PROTOCOL_VERSION` snapshot guard.
- connector-config read/filter unit test (Slice 2).
- `build-sea.mjs` smoke: a test (or a `--check` mode) asserting the esbuild bundle step produces a `.cjs`
  that runs `{"cmd":"status"}` under `node` (cheap; no postject needed for the unit check).

### Rust Tests (`cargo test` in `src-tauri`)
- the stdout-line → `ControlEvent` serde parser (golden lines incl. a malformed line → `error` event).
- backoff/lifecycle helper (pure logic, no real process).

### Webview
- the enforced `typecheck:desktop` lane (in `repo-health`). No webview unit-test runner is introduced this
  milestone (mirrors the dashboard, which relies on typecheck + build).

### Integration (must actually RUN — CLAUDE.md gate)
- The collector ↔ ingest path is exercised by the existing `*.int.test.ts` suite. Slice changes to the
  collector MUST keep `npm run repo-health -- --require-db` green **with the int layer running (0 skipped)**
  — a green suite with int tests skipped is not evidence.

### Edge Cases
- sidecar crash mid-capture → Rust restart-with-backoff, tray shows `error`, queue intact on restart.
- app quit while capturing → child killed, no zombie, final drain attempted.
- unpaired launch → serve emits `ready{paired:false}`; UI guides to pairing; `start` before `configure`
  → `error` event, not a crash.
- 401 from ingest (revoked token) → engine `onStop` → `status{state:"error"}` + a `log` event; UI prompts
  re-pair.
- Docker not running on "start server" → clear UI error (Slice 4).
- malformed stdin line → `{type:"error"}`, loop survives (proven shape in the spike).
- token never appears in any webview-reachable surface (assert).

---

## VALIDATION COMMANDS

All runnable from the repo root. Each is a GATE.

### Level 1: Syntax & Style / Typecheck
- `npm run typecheck` — root `tsc -b`, **exit 0** (covers shared + collector incl. `serve.ts`).
- `npm run typecheck:desktop` — webview `tsc --noEmit`, **exit 0** (root `tsc -b` cannot see these).

### Level 2: Unit Tests
- `npx vitest run apps/collector/src/serve.test.ts packages/shared/src/control-protocol.test.ts` — pass.
- `cargo test` (in `apps/desktop/src-tauri`) — pass (Rust serde/lifecycle).

### Level 3: Integration / Full Gate
- `npm run repo-health` — **PASS** (now includes the desktop typecheck lane).
- `npm run db:up && npm run db:migrate && npm run repo-health -- --require-db` — **PASS with the
  `*.int.test.ts` layer ran, 0 skipped** (proves the collector↔ingest layer still works).

### Level 4: Manual / Build Validation (local, Windows)
- `npm run build:collector-sea` → run the `.exe`:
  `echo '{"cmd":"status"}' | apps/desktop/src-tauri/binaries/collector-x86_64-pc-windows-msvc.exe`
  → one `status` JSON line (node:sqlite-in-SEA + protocol).
- `npm run build:desktop` → launch the `.exe`; tray Start/Pause/Resume drive capture (StatusBar `pending`
  moves); each panel works; no token visible in the webview (DevTools → check no token string).

### Level 5: Additional
- Rust lint: `cargo clippy` (in `src-tauri`) — no warnings (advisory; not in the CI gate).

---

## ACCEPTANCE CRITERIA

- [ ] Slice 1: a local `tauri build` `.exe` captures & syncs, driven from the tray (Start/Pause/Resume),
      with live status in the webview.
- [ ] The Node capture core (`capture-engine.ts`, watchers, queue, sync, connectors) is **unchanged** —
      only a new `serve` entry + (Slice 2) a connector-enablement filter were added.
- [ ] Control protocol: stdout carries ONLY JSON lines; all logs/warnings go to stderr or `{type:"log"}`.
- [ ] SEA build is reproducible via `build-sea.mjs` (esbuild-from-source → node:sea → postject); the
      `.exe` runs `node:sqlite` flag-free.
- [ ] `apps/desktop` is OUT of root `tsc -b`; its webview typecheck lane is wired into `repo-health` and
      PASSES; `build:desktop` is the documented local sign-off (not in CI).
- [ ] Sync & Health reuses `deriveAlerts` (no reimplementation); the snapshot fetch is Rust-proxied and
      the token never reaches the webview.
- [ ] GUI pairing works; secrets live in Windows Credential Manager, never plaintext on disk (GUI path);
      the CLI `pair`/`credentials.json` path is unchanged and still works.
- [ ] Full server supervision: start/stop/health-check the Docker archive + ingest API from the UI;
      failures surface clearly; no zombies on quit.
- [ ] Run-on-login toggles; tray reflects running/paused/error.
- [ ] `npm run repo-health -- --require-db` PASSES with the int layer ran (0 skipped).
- [ ] SUMMARY/PRD/CONTEXT updated; M11 ticked.

## COMPLETION CHECKLIST

- [ ] Slices executed in order; each committed independently and green at the gate.
- [ ] Each task's VALIDATE ran and passed immediately.
- [ ] `npm run repo-health` (and `--require-db` at sign-off) PASS.
- [ ] No linting/type errors (root + desktop lanes); `cargo build`/`clippy` clean.
- [ ] Manual smoke of the built `.exe` across all panels.
- [ ] No artifacts staged (SEA `.exe`, Rust `target/`, webview `dist/` all gitignored).
- [ ] Acceptance criteria all met.

## NOTES

**Design decisions locked this session (do not re-litigate):**
1. **Full server-stack supervision** (not config-only): the app can start/stop/health-check the local
   Docker archive + ingest. Implies a same-machine server; Slice 4 grows Rust-owned Docker/process control.
2. **JSON-lines over stdio** for the control protocol (not localhost HTTP/WS): one process, no bound port,
   Tauri-idiomatic. Validated end-to-end (both under `node` and a SEA `.exe`) in the control-protocol spike.
3. **Webview build = Vite + React SPA** (not Next.js): the Tauri webview is static; Next is server-oriented.
   Reuses the dashboard's hand-written shadcn primitives + theGridCN, copied (not `npx shadcn init`).
4. **Rust owns secrets** (keychain) and is the sole token-holder on the ingest hop; the token reaches the
   sidecar via an in-memory `configure` stdin message, never argv/disk. Mirrors the dashboard's
   "browser never holds the token" invariant.

**Trade-offs / deferred:** signed installer + auto-update DEFERRED (code-signing cert needed). No webview
unit-test runner this milestone (typecheck + build only, like the dashboard). The connector permission-scope
"grant" UI is review-first; a full per-connector OS-permission model can be a later refinement.

**Risks:** (1) first Rust surface in the repo — keep Rust thin (shell/tray/relay/supervision); all capture
logic stays in tested Node/TS. (2) Server supervision is operationally fiddly (Docker presence, ports,
zombies) — phase it last and surface failures loudly. (3) Keychain plugin choice — validate it
installs/resolves before building on it.

**Confidence (one-pass for SLICE 1): 8/10.** The two hard unknowns (SEA packaging of the real collector +
the stdio control loop) are spike-proven with a reproducible recipe, the capture core is reused untouched,
and the gate-wiring mirrors the existing dashboard lane exactly. The −2 is the first-Rust-surface learning
cost (Tauri config/tray/relay idioms) which docs cover but the repo has no prior example of.
**Confidence for the FULL milestone (all slices): 6/10** — large surface; server supervision (Slice 4) and
keychain (Slice 3) carry the most unknowns. Build it as the slice bundle above, not in one pass.
