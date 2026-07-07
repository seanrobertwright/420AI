# 420AI Desktop Collector (Tauri)

The M11 desktop app: a Tauri (Rust + system-webview) shell that bundles and lifecycle-supervises
the headless collector as a single-executable **sidecar**, shows fleet sync/health and connectors,
pairs from the GUI (secrets in the Windows Credential Manager), runs on login, and supervises the
local server-stack (Docker archive + ingest). This file is the **clean-checkout build recipe** —
the sequence that turns a fresh clone into a runnable, branded NSIS installer.

> The webview (TypeScript/React under `src/`) is gated by `typecheck:desktop` inside
> `npm run repo-health`. The Rust / `cargo tauri build` step is **NOT** in CI (CI is Linux — see
> `scripts/repo-health.mjs:133-148`); it is the **local Windows sign-off** (`npm run build:desktop`).

## Prerequisites

- **Node ≥ 24** (the repo pins Node 24; the SEA sidecar relies on Node 24's experimental `node:sqlite`).
- **Rust stable** + the Tauri CLI (`cargo tauri`). Install with `cargo install tauri-cli` (this repo
  was built with `tauri-cli 2.11.2`).
- **NSIS** (`makensis`) on `PATH` — the Windows installer backend. (The WiX/MSI path is intentionally
  **not** used; see "Why NSIS, not MSI" below.)

## 1. OneDrive gotcha (required if the repo lives under OneDrive)

OneDrive Files-On-Demand reparse-points and **locks** freshly built artifacts in `target/` while it
uploads them, so `cargo tauri build` fails mid-build:

- tauri-build's sidecar re-copy → `fs::remove_file(dest)` → `Os { code: 5, PermissionDenied, "Access
is denied." }`
- the installer linker cannot write the bundle under `target/release/bundle`.

Fix: redirect the Rust `target-dir` **out of** OneDrive. Create
`apps/desktop/src-tauri/.cargo/config.toml` (machine-local, **gitignored**) with:

```toml
[build]
target-dir = "C:/Users/<you>/.cargo-target/420ai-desktop"
```

Use forward slashes in the path. The bundle output then lands at
`C:/Users/<you>/.cargo-target/420ai-desktop/release/bundle/nsis/`.

**Alternative:** clone the repo **outside** OneDrive entirely (then `target/` stays under
`apps/desktop/src-tauri/target/release/bundle/nsis/` and no redirect is needed).

## 2. Regenerate icons (required on a fresh clone — `icons/` is gitignored)

The committed source of record is `src-tauri/app-icon.png` (a square 1024×1024 RGBA badge). The
generated `src-tauri/icons/` set (taskbar PNGs, `icon.ico`, `icon.icns`, Store logos) is
**gitignored**, so a fresh clone has none and `cargo tauri build` fails referencing `icons/32x32.png`
etc. Regenerate them:

```bash
cd apps/desktop && cargo tauri icon src-tauri/app-icon.png
```

The tray reuses the window icon (`src/tray.rs` calls `app.default_window_icon()`), so this one set
brands the window, taskbar, and tray together.

## 3. Build

From the **repo root**:

```bash
npm install
npm run build:desktop
```

`build:desktop` chains three stages (`package.json`):

1. **SEA sidecar** — `node apps/collector/scripts/build-sea.mjs` bundles `collector serve` into
   `src-tauri/binaries/collector-x86_64-pc-windows-msvc.exe` (~88 MB). On Windows it prints
   `warning: The signature seems corrupted!` from `postject` — this is **EXPECTED** (we patch the
   signed `node.exe`; documented in the script header) and does not fail the build.
2. **Webview** — `vite build` (`npm run build -w @420ai/desktop`).
3. **`cargo tauri build`** — compiles the Rust shell (release) and emits the NSIS installer.

Output artifact (with the OneDrive redirect above in effect):

```
C:/Users/<you>/.cargo-target/420ai-desktop/release/bundle/nsis/420AI Collector_0.1.0_x64-setup.exe
```

(~25 MB). Without the redirect it is `apps/desktop/src-tauri/target/release/bundle/nsis/`.

## 4. Cheap smoke (cross-platform, no SEA/postject)

```bash
node apps/collector/scripts/build-sea.mjs --check
```

Bundles `serve` and runs `{"cmd":"status"}` under plain `node` — a fast sanity check that the
collector entry packages and responds, without producing the full SEA `.exe`.

## Why NSIS, not MSI

`cargo tauri build` with `bundle.targets: "all"` builds **both** NSIS and MSI on Windows. The MSI leg
goes through the WiX toolset (`light.exe`), which **fails on this machine**; NSIS (`makensis`) is
robust. `tauri.conf.json` therefore pins `"targets": ["nsis"]`. MSI and CA/Authenticode code signing
remain **deferred** (PRD §25 defers signed distribution — a code-signing certificate is required);
NSIS is the V1-desktop distribution. Auto-update is NOT deferred: it ships via the Tauri updater's
own free minisign-style signing key (12.8c) — see
[`docs/guide/operations.md`](../../docs/guide/operations.md#131--updater-signing-key-one-time-ceremony)
for the one-time key-generation ceremony a maintainer must run before cutting the first signed
release.
