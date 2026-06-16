# Feature: M11 Slice 5 — Packaging & Docs (final slice of the M11 Tauri desktop bundle)

The following plan should be complete, but it's important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to naming of existing
utils, types, and models, and to exact file/line anchors for the doc edits (verify them — the repo
moves).

> **Conventions are NOT re-pasted here.** The single source of truth is
> [`CLAUDE.md`](../../CLAUDE.md) (workspaces, TS/module rules, the **Frontend workspace** treatment,
> **token-never-in-webview**, and **Validation is a GATE**). Build background is
> [`SUMMARY.md`](../../SUMMARY.md); the milestone bundle plan is
> [`.agents/plans/m11-tauri-desktop.md`](./m11-tauri-desktop.md) (this is **Slice 5** — the final slice —
> of that bundle, Slice-5 row line 82 + task line 519). Prior slices:
> [Slice 3](./m11-slice3-pairing-autostart-keychain.md), [Slice 4](./m11-slice4-settings-server-supervision.md).

## Feature Description

Slice 5 is the **packaging + documentation + milestone sign-off** slice that closes out M11. After
Slices 1–4, the desktop app captures, syncs, shows fleet health, manages connectors, pairs from the
GUI (secrets in the Windows Credential Manager), runs on login, and supervises the full local
server-stack (Docker archive + ingest) — all built and committed. What remains is **not new feature
code**: it is (a) making the `tauri build` produce a **runnable installer artifact**, (b) replacing the
**placeholder app icon** with the real 420AI logo, (c) writing down the **clean-checkout build recipe**
(today it depends on two machine-local, gitignored files), and (d) **reconciling the docs** (SUMMARY,
PRD §25, CONTEXT) to what Slices 1–4 *actually shipped*, which overrode the bundle plan in several
places.

This slice touches **only** `apps/desktop` config + icon assets + Markdown docs. **No TypeScript,
collector, ingest, db, or shared code changes** — so the root `tsc -b` graph and the test suite are
unaffected by construction.

## User Story

```
As the developer who self-hosts and ships 420AI
I want a documented, repeatable build that produces a runnable, branded desktop installer, with the
   project docs reflecting what M11 actually shipped
So that anyone (including future-me on a fresh clone) can build the desktop collector in one pass, the
   app looks like a real product, and the M11 milestone can be signed off as DONE
```

## Problem Statement

1. **The build does not produce an installer.** `apps/desktop/src-tauri/tauri.conf.json` sets
   `bundle.targets: "all"`, which on Windows forces an **MSI** build via the WiX toolset. A spike
   (below) proved `cargo tauri build` **fails at the MSI step** (`light.exe`, WiX's linker) — so
   `npm run build:desktop` currently exits **non-zero** and produces **no installer**. Milestone
   sign-off (`build:desktop` is the documented Windows sign-off gate — `scripts/repo-health.mjs:133-148`)
   is impossible until this is fixed.
2. **The app icon is a placeholder.** The tracked source `apps/desktop/src-tauri/app-icon.png` is a
   plain **solid-purple 1024×1024 square** — not a logo. The generated `icons/` set (taskbar, tray,
   installer) all derive from it.
3. **The clean-checkout build is undocumented and depends on gitignored files.** Two prerequisites live
   ONLY in machine-local, gitignored files and a stray comment:
   - `apps/desktop/src-tauri/icons/` is **gitignored** ("produced locally by `cargo tauri icon`"), so a
     fresh clone has **no icons** and `cargo tauri build` fails (it references `icons/32x32.png` etc.).
   - `apps/desktop/src-tauri/.cargo/config.toml` is **gitignored** and redirects the Rust `target-dir`
     **out of OneDrive**; without it, building under `C:\Users\…\OneDrive\…` fails with `Access is
     denied` (OneDrive locks freshly-built artifacts during the tauri-build sidecar re-copy and the WiX
     `light.exe` MSI write). A fresh clone under OneDrive has no recipe for this.
4. **The docs describe M11 as "not yet built" and still list unresolved design points** that Slices 1–4
   actually resolved (control protocol, server supervision, settings scope, secret injection). Left
   as-is, SUMMARY/PRD/CONTEXT misrepresent the shipped system.

## Solution Statement

Four thin, **`apps/desktop`-and-docs-only** changes:

1. **Pin the bundle to NSIS.** Change `bundle.targets` from `"all"` → `["nsis"]` in `tauri.conf.json`.
   Spike-proven: `cargo tauri build --bundles nsis` succeeds and produces a runnable
   `420AI Collector_0.1.0_x64-setup.exe` (~25 MB); the MSI/WiX path is the only one that fails. MSI +
   signed installer + auto-update remain **deferred** (PRD §25 already defers signed distribution).
2. **Brand the icon.** Normalize the user-provided 420AI logo (`420AI.png` at the repo root, dropped in
   the S5 planning session — 1176×1372 transparent RGBA badge) to a **square 1024×1024 transparent
   RGBA** source, replace `app-icon.png`, regenerate the `icons/` set with `cargo tauri icon`. The tray
   inherits it automatically (`tray.rs:35` uses `app.default_window_icon()`).
3. **Document the clean-checkout recipe.** Add `apps/desktop/README.md` with the exact build sequence and
   the two gitignored prerequisites (regenerate icons; the OneDrive `target-dir` redirect or clone
   outside OneDrive). Mirror the SEA recipe note into SUMMARY.
4. **Reconcile the docs + sign off.** Update SUMMARY §0/§3/§4, PRD §25, CONTEXT glossary to what shipped,
   append an inline ADR-style note (no `docs/adr/` exists — SUMMARY §4 is the decision log), and run the
   milestone gate.

## Feature Metadata

**Feature Type**: Enhancement / release engineering (Slice 5 — final slice of the M11 bundle)
**Estimated Complexity**: **Low–Medium.** No new code paths; the only "logic" is a one-line config
change + an asset regeneration + prose. The historical risk (does the build actually produce an
artifact?) has been **retired by a spike**. The residual effort is doc accuracy + the icon
normalization detail.
**Primary Systems Affected**: `apps/desktop` ONLY (config: `tauri.conf.json`; assets: `app-icon.png` +
generated `icons/`; new `apps/desktop/README.md`). Docs: `SUMMARY.md`, `docs/PRD.md`, `docs/CONTEXT.md`.
**No change** to `apps/collector`, `apps/ingest`, `packages/shared`, `packages/db`, or any `*.rs`/`*.ts`
source — so the root `tsc -b` graph, the desktop webview typecheck lane, and the test suite are
untouched.
**Dependencies**: **NONE new.** Uses the already-installed local toolchain: `rustc`/`cargo` 1.95.0,
`tauri-cli` 2.11.2 (`cargo tauri` + `cargo tauri icon`), Node 24.16, NSIS (`makensis`, present). No npm
or crate change.

---

## ⚠️ SPIKE RESULTS — read before coding (these retire the slice's risk)

A real end-to-end build spike was run during planning (branch `m11-slice5-packaging-docs`). Findings,
with the assertions the executor should re-confirm:

| Step | Command | Result |
|---|---|---|
| SEA sidecar | `node apps/collector/scripts/build-sea.mjs` | ✅ 88 MB artifact; `--check` smoke passes. The `warning: The signature seems corrupted!` from postject is **EXPECTED** (documented in the script header). |
| Webview | `npm run build -w @420ai/desktop` (`vite build`) | ✅ 248 KB JS / 18 KB CSS. |
| Rust release | (inside `cargo tauri build`) | ✅ `desktop.exe` (14.4 MB) at the redirected target dir. |
| **Full build, default config** | `npm run build:desktop` (`bundle.targets:"all"`) | ❌ **FAILS — `Error failed to bundle project: failed to run …\WixTools314\light.exe`** (the MSI/WiX linker). Exit code 1, **no installer produced.** |
| **NSIS-only** | `cargo tauri build --bundles nsis` | ✅ **PASS** — `makensis` produces `…\release\bundle\nsis\420AI Collector_0.1.0_x64-setup.exe` (~25 MB). |

**Conclusion that drives Task 1:** the WiX/MSI target is the *only* failing leg; NSIS is robust on this
machine. Pinning `bundle.targets: ["nsis"]` makes `cargo tauri build` (and therefore the existing
`build:desktop` script, which is config-driven) succeed and emit a runnable installer. **Do not "fix
WiX"** — MSI is explicitly out of scope (PRD defers signed distribution); switching targets is the
intended resolution.

**Bundle output path (with the gitignored `.cargo/config.toml` redirect in effect):**
`C:\Users\seanr\.cargo-target\420ai-desktop\release\bundle\nsis\`. Without that redirect the path is
`apps/desktop/src-tauri/target/release/bundle/nsis/` **but the build fails under OneDrive** — see Task 3.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

- `apps/desktop/src-tauri/tauri.conf.json` (whole file, 37 lines) — Why: Task 1 edits `bundle.targets`
  (line 27). Note `bundle.icon` (lines 28-34) lists the generated PNG/ICNS/ICO; `externalBin`
  (line 35) is the SEA sidecar. **Do not touch** the `security.csp` or `externalBin`.
- `apps/desktop/.gitignore` (whole file) — Why: confirms `src-tauri/icons/` (line 12) and
  `src-tauri/binaries/*.exe` are **generated, not committed**; `app-icon.png` is the tracked **source**.
  Task 2 keeps `icons/` gitignored and regenerates it.
- `apps/desktop/src-tauri/app-icon.png` — Why: the tracked **source** icon (currently the placeholder
  purple square). Task 2 replaces it.
- `apps/desktop/src-tauri/src/tray.rs` (lines 34-36) — Why: the tray uses
  `app.default_window_icon()…clone()` and `.tooltip("420AI Collector")`. Confirms **one icon set covers
  both window and tray** — no separate tray asset. **No code change**; read to verify the assumption.
- `apps/collector/scripts/build-sea.mjs` (header lines 1-22 + the `--check` path) — Why: the SEA recipe
  to transcribe into the README; `--check` is the cheap cross-platform smoke.
- `scripts/repo-health.mjs` (lines 133-148, the Check 5 desktop lane) — Why: states `cargo tauri build`
  is **deliberately NOT gated in CI (CI is Linux)** and is a **documented local Windows sign-off
  (`npm run build:desktop`)**. The README + SUMMARY must say this; **do not** try to add the Rust build
  to `repo-health`/CI.
- `package.json` (root, lines 27-30) — Why: `build:desktop` already chains
  `build:collector-sea && build -w @420ai/desktop && cd apps/desktop && cargo tauri build`. It is
  **already correct** once `tauri.conf.json` pins NSIS; **no script edit required** (optionally add a
  clarifying comment — see Task 1 note).
- `apps/desktop/src-tauri/Cargo.toml` — Why: read-only context; the deps (`keyring` windows-native,
  `tauri-plugin-autostart`, `reqwest` rustls) are what CONTEXT glossary terms describe.
- `packages/shared/src/control-protocol.test.ts` (line 18) — Why: pins
  `CONTROL_PROTOCOL_VERSION === "m11-control-v2"`. The PRD/SUMMARY reconciliation must state this value
  is **unchanged through Slices 1–5**. **Do not** edit this test.

### Doc files to edit (exact anchors — re-verify before editing)

- `SUMMARY.md` §0 Status (lines ~18-20: "M11 … **not yet built**"); §3 Build ORDER (lines ~106-108: the
  `⬜` Tauri row + "ready for `/lril:plan-feature`"); §4 Decisions Log (ends ~line 170 — append an M11
  subsection). Also the §0 dated header ("Status — 2026-06-15" → bump to the sign-off date).
- `docs/PRD.md` §25 item 11 (lines 686-707) — the M11 bullet, especially the final **"Design points to
  resolve in planning"** sub-bullet (lines 703-707) which must be replaced with shipped reality.
- `docs/CONTEXT.md` — glossary uses `## Term Name` headers + 1-3 sentence bodies (pattern at lines 3-5,
  "## AI Coding Tool"). Add the 5 missing terms (see Task 6). "Tauri" appears once inline (~line 244)
  but is not a glossary entry.

### New Files to Create

- `apps/desktop/README.md` — the clean-checkout build recipe + prerequisites + sign-off gate. (No README
  exists under `apps/desktop` today.)

### Relevant Documentation — READ BEFORE IMPLEMENTING

- [Tauri v2 — Bundle config / `targets`](https://v2.tauri.app/reference/config/#bundleconfig) — the
  allowed `targets` values (`"all"`, or an array of `"nsis" | "msi" | "app" | …`). Why: Task 1.
- [Tauri v2 — Windows installer (NSIS vs MSI / WiX)](https://v2.tauri.app/distribute/windows-installer/)
  — NSIS needs no WiX; MSI needs the WiX toolset. Why: justifies the NSIS pin.
- [Tauri v2 — `cargo tauri icon`](https://v2.tauri.app/develop/icons/) — generates the full `icons/` set
  (PNG sizes + `icon.ico` + `icon.icns` + Store logos) from one square source ≥1024×1024. Why: Task 2.
- [Node SEA (`node:sea`)](https://nodejs.org/api/single-executable-applications.html) — Why: the CONTEXT
  glossary "Single-Executable Application" term + the README SEA recipe.

### Patterns to Follow

- **Docs voice / decision-log style:** SUMMARY §4 is the inline decision log (bullet per decision with a
  ✅ and a terse rationale). Match it — do **not** create a `docs/adr/` directory (none exists; the repo
  convention is inline). The M11 ADR-style note is a new SUMMARY §4 subsection.
- **Milestone completion marking:** SUMMARY §3 Build ORDER uses `✅`/`⬜`. Mirror the M9 precedent
  (M9 marked ✅, one line describing what shipped + the merging PR). M11's line flips `⬜`→`✅` and
  summarizes Slices 1–5.
- **CONTEXT glossary entry shape** (from lines 3-5):
  ```markdown
  ## AI Coding Tool

  An AI assistant used primarily for software development work, including coding agents, IDE assistants,
  terminal assistants, code review assistants, and repository-aware chat tools.
  ```

> **Spike-snippet fidelity:** the build commands quoted in this plan and in the new README were run
> during planning (see SPIKE RESULTS). If the executor's local run diverges (e.g. NSIS also fails, or a
> different artifact name), STOP and reconcile — do not paper over a divergent build result in the docs.

---

## IMPLEMENTATION PLAN

### Phase 1: Packaging fix + branding (the only "build" work)

Pin NSIS, brand the icon, regenerate the icon set, and prove the installer builds.

### Phase 2: Build-recipe documentation

Write `apps/desktop/README.md` capturing the verified recipe + the two gitignored prerequisites.

### Phase 3: Doc reconciliation

Update SUMMARY, PRD §25, CONTEXT to shipped reality; append the M11 decision note.

### Phase 4: Milestone sign-off

Run the full gate with the DB up; build the installer; manual smoke of all panels; tick acceptance.

---

## STEP-BY-STEP TASKS

Execute in order. Each is atomic and independently checkable.

### 1. UPDATE `apps/desktop/src-tauri/tauri.conf.json` — pin the bundle to NSIS

- **IMPLEMENT**: Change `"targets": "all"` (line 27) to `"targets": ["nsis"]`. Leave `bundle.icon`,
  `externalBin`, `active`, and everything else unchanged.
- **WHY**: SPIKE — `"all"` forces MSI/WiX (`light.exe`) which fails; NSIS succeeds and is sufficient
  (PRD §25 defers MSI/signed installers). The `build:desktop` script is config-driven, so this single
  edit makes it green — **no `package.json` edit required**.
- **GOTCHA**: `targets` accepts the string `"all"` OR an array of strings — use the **array**
  `["nsis"]` (not the bare string `"nsis"`, though Tauri tolerates both; the array is the documented
  multi-target shape and reads as deliberate). Validate the JSON parses (no trailing comma).
- **OPTIONAL**: add a one-line comment is NOT possible in strict JSON (`tauri.conf.json` is plain JSON,
  no comments). Capture the "why NSIS not MSI" rationale in the README/SUMMARY decision note instead.
- **VALIDATE**: `node -e "JSON.parse(require('fs').readFileSync('apps/desktop/src-tauri/tauri.conf.json','utf8')); console.log('config OK')"` → prints `config OK`.

### 2. UPDATE `apps/desktop/src-tauri/app-icon.png` — brand it with the real 420AI logo

- **IMPLEMENT**: Normalize the user-provided logo to a **square 1024×1024 transparent RGBA PNG** and
  overwrite `app-icon.png`. Source: `420AI.png` at the **repo root** (1176×1372 transparent RGBA badge,
  provided in the S5 planning session). It is portrait/non-square, so **center the circular badge on a
  1024×1024 transparent canvas** (do not stretch). Preserve alpha.
  - Suggested tool: `cargo tauri icon` accepts the source directly, but it expects a **square** input;
    pre-square it first. If ImageMagick is available:
    `magick 420AI.png -resize 1024x1024 -background none -gravity center -extent 1024x1024 apps/desktop/src-tauri/app-icon.png`.
    Otherwise pre-square with any image editor / a tiny `sharp`/`jimp` Node script. The end state:
    `app-icon.png` is 1024×1024 RGBA with the badge centered and transparent margins.
- **GOTCHA**: keep the file at the tracked path `apps/desktop/src-tauri/app-icon.png` (this is what's in
  git; `icons/` is gitignored). Remove the stray `420AI.png` from the repo root afterward (don't commit
  a loose root asset) — or move it into `apps/desktop/src-tauri/` if you want the original retained,
  but the **source of record is `app-icon.png`**.
- **VALIDATE**:
  `node -e "const b=require('fs').readFileSync('apps/desktop/src-tauri/app-icon.png'); console.log('PNG '+b.readUInt32BE(16)+'x'+b.readUInt32BE(20)+' colortype='+b[25])"`
  → expect `PNG 1024x1024 colortype=6` (6 = RGBA).

### 3. RUN `cargo tauri icon` — regenerate the icon set from the new source

- **IMPLEMENT**: From `apps/desktop`, run `cargo tauri icon src-tauri/app-icon.png` (regenerates
  `src-tauri/icons/`: the PNG sizes, `icon.ico`, `icon.icns`, and the Square*/StoreLogo set referenced
  by `tauri.conf.json`).
- **GOTCHA**: `src-tauri/icons/` is **gitignored** — it stays generated/untracked. That's intentional;
  do NOT `git add -f` it. The committed artifact is `app-icon.png` (the source). This is exactly why the
  README (Task 4) must list "regenerate icons" as a clean-checkout prerequisite.
- **VALIDATE**: `ls apps/desktop/src-tauri/icons/icon.ico apps/desktop/src-tauri/icons/32x32.png` →
  both exist with a fresh mtime; spot-check `icon.png` visually shows the badge (not the purple square).

### 4. CREATE `apps/desktop/README.md` — the clean-checkout build recipe

- **IMPLEMENT**: A concise README with these sections (transcribe the SPIKE-verified commands):
  1. **Prerequisites** — Node ≥24, Rust stable + `cargo tauri` (`cargo install tauri-cli` or it's a
     dev-managed binary), NSIS (`makensis`) for the installer.
  2. **OneDrive gotcha (required if the repo lives under OneDrive)** — create
     `apps/desktop/src-tauri/.cargo/config.toml` (gitignored, machine-local) with:
     ```toml
     [build]
     target-dir = "C:/Users/<you>/.cargo-target/420ai-desktop"
     ```
     Explain WHY (verbatim cause from the existing comment): OneDrive Files-On-Demand reparse-points and
     locks freshly-built `target/` artifacts, so the tauri-build sidecar re-copy hits
     `Os { code: 5, PermissionDenied }` and WiX/NSIS can't write the installer. Alternative: clone the
     repo **outside** OneDrive.
  3. **Regenerate icons (required on a fresh clone — `icons/` is gitignored)**:
     `cd apps/desktop && cargo tauri icon src-tauri/app-icon.png`.
  4. **Build** — from the repo root: `npm install` then `npm run build:desktop`. Document what it chains
     (SEA sidecar → webview → `cargo tauri build`) and the **expected** `postject` "signature seems
     corrupted" warning. State the output artifact:
     `…/release/bundle/nsis/420AI Collector_<version>_x64-setup.exe` (under the redirected target dir if
     the OneDrive workaround is used).
  5. **Sign-off note** — `cargo tauri build` is **not** in CI (CI is Linux; see
     `scripts/repo-health.mjs:133-148`); it is the **local Windows sign-off**. The webview is gated by
     `typecheck:desktop` inside `repo-health`.
  6. **Cheap smoke** — `node apps/collector/scripts/build-sea.mjs --check` (bundles + runs
     `{"cmd":"status"}` under node; no SEA/postject needed).
- **GOTCHA**: write the `.cargo/config.toml` snippet with the Bash heredoc/Write tool, not via a
  PowerShell here-string (CLAUDE.md Windows tooling note) — backslashes/`@` get mangled. Use forward
  slashes in the TOML path.
- **VALIDATE**: README renders (no broken code fences); `npx markdownlint apps/desktop/README.md` if a
  linter is configured, else visual check. Confirm every command in it was actually run (Task 8 re-runs
  the build).

### 5. UPDATE `SUMMARY.md` — flip M11 to built + record the packaging decision

- **IMPLEMENT**:
  - §0 Status header date → the sign-off date.
  - §0 (lines ~18-20): replace "**M11 … not yet built**" with a sentence stating M11 (Tauri
    desktop/tray collector) is **built across Slices 1–5** and summarizing the surface (sidecar-supervised
    headless collector; tray; sync/health + connectors; GUI pairing + autostart + keychain secrets;
    Settings + full server-stack supervision; NSIS installer). Reference the slice plans.
  - §3 Build ORDER (lines ~106-108): change the M11 row `⬜` → `✅`; replace "Planned & in the PRD;
    ready for `/lril:plan-feature`" with the shipped summary (mirror the M9 ✅ line style).
  - §4 Decisions Log: append an **M11 subsection** capturing the resolutions that overrode the bundle
    plan (these are the ADR-style note — see Task 7 for the exact list), INCLUDING the new packaging
    decision: **"NSIS, not MSI — WiX `light.exe` fails locally; MSI/signed installer deferred (PRD
    §25)."** Add the SEA recipe pointer (`build-sea.mjs`) here or reference the README.
- **GOTCHA**: keep edits surgical; do not reflow unrelated paragraphs (clean diff).
- **VALIDATE**: `grep -n "not yet built" SUMMARY.md` → **0 hits**; `grep -n "✅.*Tauri\|✅.*M11" SUMMARY.md`
  → the flipped row present.

### 6. UPDATE `docs/PRD.md` §25 — reconcile the M11 bullet to shipped reality

- **IMPLEMENT**: In item 11 (lines 686-707):
  - Mark M11 as built (match the PRD's milestone-status convention — the PRD uses prose, not checkboxes;
    add a leading "**Built (Slices 1–5).**" or equivalent consistent with how other shipped milestones
    read).
  - **Replace** the final "**Design points to resolve in planning**" sub-bullet (lines 703-707) with a
    "**Resolved in implementation**" note stating: (1) the control protocol is JSON-lines over the
    sidecar's stdio relayed via Rust events, **`CONTROL_PROTOCOL_VERSION = "m11-control-v2"`,
    unchanged**; (2) the app **does** supervise the local server-stack (Docker archive + ingest) — via
    **Rust `std::process::Command`**, NOT `tauri-plugin-shell` — injecting keychain secrets as the child
    process env (no `.env` written); Settings manages **server** config only (collector config deferred).
  - Update the **Packaging** sub-bullet (lines 701-702) to: local **NSIS** `tauri build` artifact;
    MSI + signed installer + auto-update remain deferred.
- **GOTCHA**: don't delete the architecture/scope sub-bullets that remain accurate — only the
  *unresolved-design-points* and *packaging* sub-bullets change.
- **VALIDATE**: `grep -n "Design points to resolve" docs/PRD.md` → **0 hits**;
  `grep -n "m11-control-v2\|std::process::Command\|nsis\|NSIS" docs/PRD.md` → present.

### 7. UPDATE `docs/CONTEXT.md` — add the 5 missing glossary terms

- **IMPLEMENT**: Add `## Term` entries (1-3 sentences each, matching the existing shape) for:
  - **Sidecar** — the headless Node/TS collector packaged as a single executable and bundled +
    lifecycle-supervised by the Tauri Rust shell as an `externalBin`; the Rust layer stays off the
    capture path.
  - **Control Protocol** — the JSON-lines command/event protocol over the sidecar's stdio (relayed to
    the webview via Rust events); versioned by `CONTROL_PROTOCOL_VERSION` (currently `m11-control-v2`).
  - **Tauri** — the Rust + system-webview desktop framework hosting the M11 desktop/tray app (formalize
    the existing inline mention).
  - **Keychain (Windows Credential Manager)** — the OS-native secret store the Rust shell uses (via the
    `keyring` crate) to hold the pairing token and server-config secrets; the webview never reads them.
  - **Single-Executable Application (SEA)** — Node's `node:sea` mechanism that packages the collector
    `serve` entry into one `.exe` for the Tauri sidecar.
- **GOTCHA**: place them in the file's existing alphabetical/topical ordering if one exists; otherwise
  group near the existing Tauri/desktop mention. Match the exact `## ` header + blank-line + paragraph
  shape.
- **VALIDATE**: `grep -nE "^## (Sidecar|Control Protocol|Tauri|Keychain|Single-Executable)" docs/CONTEXT.md`
  → 5 hits.

### 8. SIGN-OFF — build the installer + run the gate + manual smoke

- **IMPLEMENT** (run, capture evidence; this is the milestone gate, not a code change):
  1. `npm run build:desktop` from the repo root → must exit **0** and produce
     `…/release/bundle/nsis/420AI Collector_0.1.0_x64-setup.exe`. (With Task 1, `cargo tauri build`
     emits NSIS.)
  2. DB-backed gate: `npm run db:up && npm run db:migrate` then
     `npm run repo-health -- --require-db` → **PASS** with the integration layer actually running
     (N int tests, **0 skipped**). NOTE: this slice changes no backend code, so this proves "no
     regression," not new behavior — but CLAUDE.md requires it for milestone sign-off.
  3. Manual end-to-end smoke of the installed app: pair, capture, Sync & Health panel, connector
     toggle, Settings (server start/stop/health), tray status + start/pause/resume, autostart toggle —
     confirm the **new icon** shows in the window, taskbar, and tray.
- **GOTCHA**: per CLAUDE.md, a green `repo-health` with int tests **skipped** is NOT evidence —
  `--require-db` fails if `DATABASE_URL_TEST` is unset or any `*.int.test.ts` self-skipped.
- **VALIDATE**: NSIS artifact exists (`ls "<bundle>/nsis/"*.exe`); `repo-health -- --require-db` prints
  `repo-health: PASS` and `… (N integration tests ran, 0 skipped)`.

---

## TESTING STRATEGY

This slice ships **no executable code**, so there are no new unit/integration tests. "Testing" is the
build + gate + manual smoke:

### Unit / Integration Tests
- **Unchanged.** No `*.test.ts`/`*.int.test.ts` added or modified. The existing suite must stay green
  (regression check) via `repo-health -- --require-db` (Task 8.2) — int layer runs, 0 skipped.
- `cargo test` in `src-tauri` (the existing protocol-parser/backoff tests) must still pass — run
  `cd apps/desktop && cargo test` as a no-regression check (no Rust source changed, so this is a sanity
  pass).

### Build verification (the real gate)
- `node apps/collector/scripts/build-sea.mjs --check` — cheap SEA smoke (cross-platform).
- `npm run build:desktop` — full Windows sign-off; must produce the NSIS installer (Task 8.1).

### Edge Cases
- **Non-square logo** → if `app-icon.png` is left non-square, `cargo tauri icon` distorts/letterboxes
  the output; Task 2 pre-squares to 1024² to prevent this (verify via the colortype/dimension check).
- **Fresh clone under OneDrive without `.cargo/config.toml`** → `cargo tauri build` fails with `Access
  is denied`; the README documents the redirect/clone-elsewhere fix (Task 4.2).
- **Fresh clone without regenerated icons** → `cargo tauri build` fails referencing missing
  `icons/*.png`; README documents `cargo tauri icon` as a prerequisite (Task 4.3).
- **`bundle.targets` left as `"all"`** → build fails at WiX `light.exe` (the spike's failure mode);
  Task 1 is the fix and Task 8.1 re-proves it.

---

## VALIDATION COMMANDS

Run from the repo root. Each is a GATE with an explicit pass signal.

### Level 1: Syntax & config
- `node -e "JSON.parse(require('fs').readFileSync('apps/desktop/src-tauri/tauri.conf.json','utf8'));console.log('config OK')"` → prints `config OK`.
- `npm run typecheck` → root `tsc -b` exits 0 (no TS changed; proves no accidental breakage).

### Level 2: Webview + Rust no-regression
- `npm run typecheck:desktop` → desktop webview `tsc --noEmit` 0 errors.
- `cd apps/desktop && cargo test` → existing Rust tests pass.
- `node apps/collector/scripts/build-sea.mjs --check` → `build-sea --check: PASS`.

### Level 3: Full gate (DB up — milestone sign-off)
- `npm run db:up && npm run db:migrate`
- `npm run repo-health -- --require-db` → `repo-health: PASS` AND `(N integration tests ran, 0 skipped)`.

### Level 4: Installer build + manual
- `npm run build:desktop` → exit 0; artifact at `…/release/bundle/nsis/420AI Collector_0.1.0_x64-setup.exe`.
- Manual smoke per Task 8.3 (icon visible window/taskbar/tray; all panels work).

### Level 5: Doc-accuracy assertions
- `grep -n "not yet built" SUMMARY.md` → 0 hits.
- `grep -n "Design points to resolve" docs/PRD.md` → 0 hits.
- `grep -nE "^## (Sidecar|Control Protocol|Tauri|Keychain|Single-Executable)" docs/CONTEXT.md` → 5 hits.

---

## ACCEPTANCE CRITERIA

- [ ] `tauri.conf.json` `bundle.targets` is `["nsis"]`; JSON parses.
- [ ] `app-icon.png` is the branded 420AI logo, 1024×1024 RGBA; `icons/` regenerated (still gitignored).
- [ ] `npm run build:desktop` exits 0 and produces the NSIS installer `.exe`.
- [ ] `apps/desktop/README.md` documents prerequisites (OneDrive `target-dir` redirect; `cargo tauri
      icon` regeneration), the build sequence, the expected postject warning, and the local-sign-off note.
- [ ] `SUMMARY.md` shows M11 ✅ (Slices 1–5), §0 reworded, §4 has the M11 decision note incl. NSIS-vs-MSI.
- [ ] `docs/PRD.md` §25 marks M11 built and replaces the "design points to resolve" with the resolved
      decisions (`m11-control-v2` unchanged; Rust `std::process::Command` supervision; server-config-only
      Settings; NSIS packaging).
- [ ] `docs/CONTEXT.md` has the 5 new glossary terms in the house style.
- [ ] `npm run repo-health -- --require-db` PASS with 0 int tests skipped (no regression).
- [ ] Manual smoke: new icon in window/taskbar/tray; pairing, capture, sync/health, connectors,
      settings/server-supervision, tray controls, autostart all work.
- [ ] The stray root `420AI.png` is removed (or relocated as the retained original); no loose asset
      committed at the repo root.

## COMPLETION CHECKLIST

- [ ] All tasks 1-8 completed in order; each task's VALIDATE passed.
- [ ] Level 1-5 validation commands all pass.
- [ ] NSIS installer built and the app launches from it.
- [ ] Docs reconciled; Level-5 grep assertions all pass.
- [ ] `repo-health -- --require-db` green with int layer exercised.
- [ ] Committed (per the build loop, `/lril:commit`) with a `feat(m11): slice 5 — packaging & docs`
      message; M11 signed off.

---

## NOTES

- **Why a spike was run (and what it changed):** the original slice-5 row assumed `build:desktop`
  "produces a runnable installer." The spike proved it **does not** with the default `targets:"all"`
  (WiX `light.exe` fails) and that **NSIS works** — turning a latent sign-off blocker into a one-line
  config fix *before* execution. The spike also surfaced two gitignored clean-checkout prerequisites
  (icon regeneration; the OneDrive `target-dir` redirect) that the README now captures. This is the
  difference between a plan that signs off and one that hits a wall at the gate.
- **Scope discipline:** no `tauri-plugin` added, no `capabilities/default.json` change, no protocol
  bump, no TS/Rust source edit. If implementation seems to require any of those, STOP — it's out of
  Slice 5's scope (and likely post-M11).
- **MSI deferral is intentional**, not a workaround to revisit casually: PRD §25 already defers signed
  installers + auto-update (code-signing cert required). NSIS is the V1-desktop distribution; MSI/signing
  is a future distribution milestone.
- **Confidence: 9.5/10.** The build pipeline is spike-proven end-to-end (installer artifact in hand),
  the icon source is provided, the doc anchors are located with exact line numbers, and the slice
  touches no executable code (so no test/typecheck risk). Residual 0.5: the icon **normalization**
  (squaring/centering the badge) is a manual visual-quality step, and the exact doc-anchor line numbers
  may have drifted a few lines (re-verify before editing) — neither can block the build or the gate.
