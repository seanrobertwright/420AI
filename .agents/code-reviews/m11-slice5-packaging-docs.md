# Code Review — M11 Slice 5: Packaging & Docs

**Reviewed:** 2026-06-16
**Branch:** `m11-slice3-pairing-autostart-keychain` (Slice 5 work staged on top)
**Scope:** `apps/desktop` config + icon assets + Markdown docs only. No TS/Rust/SQL source changed.

## Stats

- Files Modified: 5 (`SUMMARY.md`, `docs/PRD.md`, `docs/CONTEXT.md`,
  `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/app-icon.png`)
- Files Added: 2 (`apps/desktop/README.md`, `.agents/plans/m11-slice5-packaging-docs.md`)
- Files Deleted: 1 untracked (`420AI.png` stray root asset — never committed)
- New lines (text): ~72 insertions / ~19 deletions across docs (per `git diff --stat`)
- Binary: `app-icon.png` 6.5 KB placeholder → 1.48 MB branded 1024×1024 RGBA
- Generated (gitignored, untracked): `apps/desktop/src-tauri/icons/` regenerated

## Verification performed (claims checked against code, not assumed)

| Claim in docs | Source of truth | Verdict |
|---|---|---|
| `CONTROL_PROTOCOL_VERSION = "m11-control-v2"`, unchanged | `packages/shared/src/control-protocol.ts:86` + `.test.ts:18` | ✅ accurate |
| Server-stack supervised via `std::process::Command`, NOT `tauri-plugin-shell` | `server.rs:225/248/342` spawn `docker`/`node` with `std::process::Command`; `tauri-plugin-shell` is used only for the **sidecar** (`sidecar.rs:83`) | ✅ accurate (scoped to server-stack) |
| Secrets via `keyring` crate (windows-native) | `Cargo.toml:31` | ✅ accurate |
| One icon set covers window + tray | `tray.rs:35` `app.default_window_icon()` | ✅ accurate |
| `bundle.targets` pinned to `["nsis"]`; build emits installer | rebuilt → `420AI Collector_0.1.0_x64-setup.exe` (26 MB) | ✅ build exit 0 |

## Issues found & resolved during review

```
severity: medium
file: apps/desktop/src-tauri/app-icon.png
line: n/a (binary)
issue: First recompression pass produced an indexed-palette PNG (colortype 3), not RGBA.
detail: Recompressing the squared icon with sharp `effort:10` triggered palette quantization
        (256-color), which is lossy on the green→blue gradient (banding) AND violates the
        acceptance criterion "1024×1024 RGBA" (the plan's VALIDATE checks colortype=6).
suggestion: Regenerate true-color RGBA from the master logo with `palette:false`.
status: FIXED — re-derived the badge from the high-res master
        (OneDrive/Pictures/AI Logos/420AI.png, 2816×1536) via a precise badge crop
        (extract 143,268,1048×1048 + uniform 46px transparent margin), resized to 1024×1024,
        encoded `png({compressionLevel:9, palette:false})` → colortype=6 confirmed.
        Icons regenerated; installer rebuilt green.
```

```
severity: low
file: SUMMARY.md
line: ~23 (§0)
issue: Slice-plan reference cited `m11-slice{3,4,5}-*.md`, omitting the existing
        `m11-slice2-sync-health-connectors.md` plan while claiming "built across Slices 1–5".
detail: Doc-accuracy gap — the whole point of this slice is reconciling docs to reality;
        a reader following the pointer would not find the Slice-2 plan.
suggestion: Reference the bundle plan (covers Slices 1–2) plus `m11-slice{2,3,4,5}-*.md`.
status: FIXED.
```

## Observations (not blocking, no fix applied)

```
severity: low
file: apps/desktop/src-tauri/src/keychain.rs
line: ~189 (test keychain_set_get_delete_roundtrips)
issue: Flaky under `cargo test`'s default parallel execution — one run failed "load after
        store"; passed in isolation and on rerun (26 passed, 0 failed).
detail: The keychain tests write to the REAL Windows Credential Manager (no mock). A
        CredWrite→CredRead on the same service has no cross-thread visibility guarantee, so a
        transient miss is possible under parallel load. Pre-existing; this slice changed no Rust.
suggestion: Out of Slice-5 scope (docs/packaging only). Future hardening: run keychain tests
        single-threaded (`--test-threads=1` for that module) or mock the store. Logged here so
        it is not mistaken for a Slice-5 regression.
```

```
severity: low (accepted)
file: apps/desktop/src-tauri/app-icon.png
issue: 1.48 MB committed source asset.
detail: This is the floor for a true-color 1024² RGBA gradient at compressionLevel 9. Palette
        quantization would shrink it but is lossy and violates the RGBA acceptance criterion.
suggestion: Accept — RGBA is mandated; the generated icons/ (all ≤512, gitignored) carry no cost.
```

## Validation results

```
Level 1  JSON config parse ............................. config OK
Level 1  root tsc -b ................................... exit 0
Level 2  typecheck:desktop ............................. 0 errors
Level 2  cargo test .................................... 26 passed, 0 failed
Level 2  build-sea --check ............................. PASS
Level 3  repo-health -- --require-db ................... PASS (73 int tests ran, 0 skipped)
Level 4  npm run build:desktop ......................... exit 0 → NSIS installer 26 MB
Level 5  grep "not yet built" SUMMARY.md ............... 0
Level 5  grep "Design points to resolve" docs/PRD.md ... 0
Level 5  grep 5 new CONTEXT terms ...................... 5
```

## Verdict

**PASS.** Two issues found during review (one medium icon-format regression introduced while
optimizing, one low doc-accuracy gap) — both fixed and re-verified. The one flaky Rust test is
pre-existing, outside this docs/packaging slice's scope, and confirmed green on rerun. All
automated gates pass; the only outstanding item is the human manual GUI smoke (Task 8.3).
