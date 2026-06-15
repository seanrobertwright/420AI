# M11 Tauri Desktop/Tray Collector — Feasibility Spike

**Date:** 2026-06-14
**Type:** Read-only feasibility + toolchain spike for the post-V1 Tauri desktop/tray collector.
**Goal:** De-risk the **sidecar** architecture (Tauri shell supervises the existing headless
Node/TS collector) before writing the M11 plan — confirm the toolchain, the sidecar mechanism,
how to package the Node collector, tray support, and surface the one real design point.

> Decisions ratified with the user this session: **sidecar** architecture; control surface =
> tray+capture, connector management, sync & health, pairing & autostart, **settings managing
> both collector AND archive/server config**; secrets in the **OS keychain**; **local build only**
> this milestone (distribution deferred); **CLI coexists**; UI = **shadcn/ui + theGridCN**.

---

## Headline: feasible, low-risk, greenfield

The sidecar approach is well-trodden and the local toolchain is already complete. The proven M3
collector core is reused unchanged; the new surface is a Rust shell + a webview UI + a control
protocol between them.

## Toolchain — all present on this machine

| Tool | Version / status | Note |
|---|---|---|
| `rustc` | 1.95.0 | Tauri v2 build host |
| `cargo` | 1.95.0 | |
| `tauri-cli` | 2.11.2 | Tauri v2 line |
| `node:sea` | available (Node 24) | package the collector as a single executable — **no new dependency** |
| WebView2 runtime | 149.x present | Tauri's Windows webview dependency |
| Existing Tauri config | none | greenfield — new `apps/desktop` (or `src-tauri`) |

## Sidecar mechanism (Tauri v2) — VERIFIED via docs

- Configure `bundle.externalBin` in `tauri.conf.json` with the binary path; Tauri bundles it.
- Each sidecar binary must exist with a **`-$TARGET_TRIPLE` suffix** — on Windows:
  `...-x86_64-pc-windows-msvc.exe`.
- The sidecar is spawned/supervised from **Rust** (preferred for a long-running supervised process)
  or from JS via the shell-plugin `Command.sidecar(...)`.
- Tauri publishes a dedicated **"Node.js as a sidecar"** guide — this exact pattern.

## Packaging the Node collector — `node:sea` (preferred over `pkg`)

The Tauri docs suggest `pkg`, but **`node:sea` (Node ≥ 20, present on Node 24) is built-in**, so we
produce a self-contained collector executable with **zero new dependency** (consistent with the
project's no-dependency-creep run M4–M8). Build step: bundle the collector entry to a single JS
file, then `node:sea` → a `.exe`, copied to `src-tauri/binaries/collector-x86_64-pc-windows-msvc.exe`.

## Tray — VERIFIED via docs

`TrayIconBuilder` + `MenuBuilder` / `MenuItemBuilder` + `on_menu_event` (pattern-match on item ids).
- **Gotcha:** dev hot-reload can spawn **duplicate tray icons** (tauri#8982) — build the tray once
  in `setup`, guard against re-creation.
- Menu items can be updated at runtime to reflect status (e.g. "Status: running / paused").

## The one real design point — UI ↔ sidecar control protocol

The collector is **long-running** (watchers + sync loop), so the UI needs **bidirectional control +
live status** (start/pause/resume, connector health, queue backlog), not fire-and-forget spawning.

- **Recommended:** a **JSON-lines protocol over the sidecar's stdin/stdout** — the Rust shell writes
  commands to stdin, reads status events from stdout, and relays them to the webview via Tauri events;
  the webview renders and sends commands back through Rust `#[command]`s. This is the Tauri-idiomatic
  shape and keeps one process, no extra port.
- **Alternative:** the collector exposes a tiny **localhost HTTP/WebSocket** control server the webview
  talks to directly. Decouples UI from the sidecar but adds a bound port + a second surface to secure.
- **To finalize in the M11 plan** (may warrant a tiny control-protocol spike): the exact command/event
  schema and whether the collector grows a `serve`/`daemon` mode that speaks it.

## Settings scope (expanded per user) — manages collector AND server config

The settings panel manages **both** this machine's collector config (dashboard URL, machine name,
ingest token, watch interval, connector paths/enablement, DB path) **and** the archive/ingest server
config (env: `ARCHIVE_ENCRYPTION_KEY`, `ANALYSIS_*`, `ADMIN_TOKEN`, `DATABASE_URL`).

- **Secrets → OS keychain (Windows Credential Manager)** via a Tauri secure-store plugin
  (stronghold / keyring), **not** plaintext. Non-secret prefs go in a normal config file.
- **Open design point (planning):** does the app also **supervise the local server-stack lifecycle**
  (Docker Supabase/Postgres + ingest API up/down) — implying it assumes a same-machine server — or
  only **write the server's config/env**? This determines whether M11 grows process/Docker control.
  Resolve in the M11 plan.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| First Rust/Tauri surface in the repo (new language) | Sidecar keeps Rust thin (shell + tray + relay); all capture logic stays in tested Node/TS |
| `node:sea` packaging on Windows (icon/asset edge cases) | Validate the `.exe` runs standalone early; fall back to `pkg` only if blocked |
| Long-running sidecar supervision (crash/restart, zombie on app quit) | Rust owns lifecycle; kill sidecar on app exit; restart-with-backoff; surface health in tray |
| Managing server secrets from a workstation app | OS keychain only; never log; mirror the §18 "key outside the DB" discipline |
| Duplicate tray icons in dev | Build tray once in `setup` (tauri#8982) |

## Conclusion

**Architecture confirmed: sidecar.** No blockers. Toolchain ready, mechanism documented, Node
packaging available dependency-free, tray standard. The M11 plan's main new design work is the
**control protocol** and the **server-lifecycle-vs-config-only** decision; everything else reuses
M3 (capture) and the existing pairing/ingest contracts.

## Sources

- Tauri v2 — Embedding External Binaries (sidecar): https://v2.tauri.app/develop/sidecar/
- Tauri v2 — Node.js as a sidecar: https://v2.tauri.app/learn/sidecar-nodejs/
- Tauri v2 — System Tray: https://v2.tauri.app/learn/system-tray/
- `TrayIconBuilder` API: https://docs.rs/tauri/latest/tauri/tray/struct.TrayIconBuilder.html
- Node SEA (single executable applications): https://nodejs.org/api/single-executable-applications.html
