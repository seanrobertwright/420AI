# M14 checklist item 3 — desktop auto-update E2E (evidence, 2026-07-22)

Proves the Tauri auto-updater (slice 12.8c) end-to-end: an installed build detects a newer GitHub
release, verifies its signature against the baked-in updater pubkey (from item 1's ceremony),
installs, and relaunches — AND rejects a tampered payload.

## Setup
- Signing key: `.secrets/tauri-updater.key` (item 1, passwordless `--ci`), pubkey `274299A56AD1A676`
  baked into `tauri.conf.json` → `plugins.updater.pubkey`.
- Endpoint: `https://github.com/seanrobertwright/420AI/releases/latest/download/latest.json`.
- Built `0.1.0` baseline + `0.1.1` update with `npm run build:desktop` (NSIS v3.12, signing key in env
  → `.sig` emitted via `createUpdaterArtifacts`). Published `v0.1.1` GitHub release with the installer +
  `latest.json` assets.

## Positive path — PASS
- Installed the `0.1.0` baseline (verified on disk: ProductVersion 0.1.0, real pubkey baked in —
  `grep REPLACE_WITH…` = 0, real-pubkey fragment = 1).
- Launched it → updater checked the endpoint, saw `0.1.1`, verified the signature against the baked
  pubkey, downloaded (27 MB), installed (passive NSIS), relaunched.
- **Result:** on-disk `desktop.exe` flipped **0.1.0 → 0.1.1** (ProductVersion 0.1.1, modified 17:54).

## Negative path — PASS
- Published a tampered `latest.json` (version `0.1.2`, **corrupted signature**, url pointing at the real
  installer) via `gh release upload --clobber`.
- Launched the `0.1.1` app against the tampered feed.
- **Result:** the app **rejected** the payload (signature verification failed) and **stayed on 0.1.1**
  (on-disk version unchanged). The baked-pubkey check is real.
- Restored the valid `0.1.1` `latest.json` afterward (live asset re-verified = 0.1.1).

## Gotcha discovered (recorded for future releases)
The first attempt appeared to do nothing because a **stale June desktop build** (with the
`REPLACE_WITH_TAURI_UPDATER_PUBKEY` placeholder) was still installed — today's installer couldn't
overwrite it while the app was running, so the updater silently failed (`checkForUpdateOnLaunch`
swallows all errors). Fix: kill the running app, cleanly reinstall the freshly-built baseline, and
confirm the real pubkey is baked in (`grep` the installed exe) before testing.

## Verdict
PASS (both paths) — the desktop auto-updater works end-to-end and enforces signature verification.
The `v0.1.1` release is a test artifact; delete with `gh release delete v0.1.1 --cleanup-tag` when done.
