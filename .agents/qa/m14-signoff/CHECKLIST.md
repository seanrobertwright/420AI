# M14 pre-sign-off checklist — maintainer runbook

> **Purpose.** M14 is code-complete (slices 14.0–14.7 merged, PRs #51–#57). The only thing between
> it and sign-off is the **D-M14-4 pre-sign-off checklist** — seven **maintainer manual actions**
> (no code). This file turns each box into an executable procedure: exact commands, the evidence to
> capture, and where to file it. Source of the boxes:
> [`.agents/plans/m14-general-ai-chat-capture.md`](../../plans/m14-general-ai-chat-capture.md)
> "Pre-sign-off checklist".
>
> **The milestone does not sign off while any box is unchecked.** Check a box here _and_ in the plan
> as you complete it, and drop the named evidence file alongside.
>
> All commands run **from the repo root** in **Git Bash** (`C:\Program Files\Git\bin\bash.exe`)
> unless noted. The local stack must be up: `docker compose up -d archive` + a running ingest
> (`npm run -w apps/ingest dev`, or the desktop app's Server-stack supervisor). Default
> `INGEST_URL=http://localhost:8420`.

Prereqs common to several items:

```sh
export INGEST_URL=http://localhost:8420
export ADMIN_TOKEN="<your admin token>"     # the retained machine/service credential (12.3)
```

---

## Progress

| # | Item | Evidence artifact | Status |
|---|------|-------------------|--------|
| 1 | Updater signing-key ceremony | `tauri.conf.json` pubkey replaced + `.secrets/tauri-updater.key` exists | ✅ (key `274299A5…`, pending commit + offline backup) |
| 2 | Restore-from-backup drill (scratch DB) | `restore-drill-<date>.txt` (script output) | ✅ (2026-07-22 — exact-match fidelity, 224126 events) |
| 3 | Live auto-update E2E | `auto-update-e2e-<date>.md` + screenshots | ⬜ |
| 4 | 12.3 auth live QA | screenshots in `.agents/qa/m12-slice3/` | ⬜ |
| 5 | Live SMTP alert send | `smtp-send-<date>.txt` (received email header/body) | ✅ (2026-07-22 — Mailpit captured the auth_failure email) |
| 6 | Scheduled-reports cold run | `reports-generate-<date>.txt` | ✅ (2026-07-22 — 390 reports, 0 fail, all 6 types) |
| 7 | Cursor live round-trip | screenshot of a Cursor session in Monitor | ⬜ |

Recommended order: **1 → 3** (3 needs 1), then **2, 4, 5, 6, 7** in any order. Item 1 is the
critical path; item 5 has a helper script that forces the alert.

---

## 1. Updater signing-key ceremony  ✅ _(done 2026-07-22 — key id `274299A56AD1A676`)_

**Why it's blocking:** `apps/desktop/src-tauri/tauri.conf.json` still carries
`REPLACE_WITH_TAURI_UPDATER_PUBKEY` (line 41) → the desktop auto-updater cannot verify any release
payload, so auto-update is non-functional. This is a **one-time identity ceremony** — only you can
hold the private key.

Full runbook: [`docs/guide/operations.md`](../../../docs/guide/operations.md) **§13.1**. Condensed:

```sh
# 1. generate the keypair (cargo tauri must run from apps/desktop; key written to repo-root .secrets/)
cd apps/desktop
cargo tauri signer generate -w ../../.secrets/tauri-updater.key --ci
cd ../..
# → writes PRIVATE key to .secrets/tauri-updater.key, prints PUBLIC key to stdout
```

2. Paste the printed **public** key into `apps/desktop/src-tauri/tauri.conf.json` →
   `plugins.updater.pubkey`, replacing the placeholder. (This file is committed — the public key is
   safe to ship.)

3. Verify the private key can never be tracked:

```sh
git check-ignore .secrets/tauri-updater.key   # MUST exit 0
```

**Evidence / done when:** `grep pubkey apps/desktop/src-tauri/tauri.conf.json` no longer shows
`REPLACE_WITH_...`, and `.secrets/tauri-updater.key` exists and is git-ignored. Commit the
`tauri.conf.json` change. Back up the private key offline (losing it = every install rejects all
future updates).

---

## 2. Restore-from-backup drill (into a scratch DB)  ✅ _(done 2026-07-22 — evidence: `restore-drill-20260722.txt`)_

**Why it's blocking:** the backup path (`npm run backup`) is proven by tests, but a **restore** has
never been exercised end-to-end. Verify it **non-destructively** against a scratch DB so the live
archive is never touched.

Helper script provided: [`scripts/restore-drill.sh`](../../../scripts/restore-drill.sh) — it does a
`gunzip -t` integrity check, restores into a throwaway `scratch` DB (drop-if-exists, so re-runnable),
and prints row counts. It never touches the live `420ai` DB.

```sh
# take a fresh backup first (or reuse a recent one from ./backups/)
BACKUP_DIR=./backups npm run backup            # → wrote ./backups/420ai-<stamp>.sql.gz

# drill the restore into a scratch DB and tee the evidence
sh scripts/restore-drill.sh ./backups/420ai-<stamp>.sql.gz | tee .agents/qa/m14-signoff/restore-drill-$(date -u +%Y%m%d).txt
```

**Evidence / done when:** the script prints non-zero `raw_source_records` (and `events`) counts from
the scratch DB matching the live archive's scale, with no error. Save the teed output as the artifact.

---

## 3. Live auto-update E2E  ⬜  _(needs item 1 first)_

**Why it's blocking:** proves the whole updater loop — an installed older build detects a newer
GitHub release, verifies its signature against the baked pubkey, installs, and relaunches.

Full release runbook: [`docs/guide/operations.md`](../../../docs/guide/operations.md) **§12.8c**.
E2E shape:

1. With version `A` installed (e.g. build the current NSIS, install it).
2. Bump the version in **both** `apps/desktop/src-tauri/tauri.conf.json` and
   `apps/desktop/src-tauri/Cargo.toml` (e.g. `0.1.0 → 0.1.1`).
3. Export the signing key and build the signed bundle (`.sig` emitted since
   `createUpdaterArtifacts: true`):
   ```sh
   export TAURI_SIGNING_PRIVATE_KEY="$(cat .secrets/tauri-updater.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""   # empty if --ci made it passwordless
   npm run build:desktop
   ```
4. Author `latest.json` (paste the `.sig` content + release-asset URL — shape in §12.8c) and publish:
   ```sh
   gh release create v0.1.1 "<path to _x64-setup.exe>" latest.json --title "420AI Collector 0.1.1" --notes "…"
   ```
5. Launch the installed `A` build → it should detect `0.1.1`, verify, install, relaunch on `0.1.1`.

**Evidence / done when:** a short `auto-update-e2e-<date>.md` noting the from/to versions + a
screenshot of the app running the new version after the auto-relaunch. Also confirm the negative:
a **tampered** `latest.json` is rejected and the app stays on the current version.

---

## 4. 12.3 auth live QA + screenshots  ⬜

**Why it's blocking:** M12 12.3 replaced the static `ADMIN_TOKEN`/`DEFAULT_EMAIL` with a real
single-user admin login, but there is **no live QA evidence** — `.agents/qa/` only had `m9/`. The
destination folder now exists: [`.agents/qa/m12-slice3/`](../m12-slice3/) (see its README for the
exact shot list). Capture the shots there.

Run the dashboard + ingest, then walk the login surface. Shot list (details in
`.agents/qa/m12-slice3/README.md`):

1. `/login` page rendered.
2. Wrong password → **401**/error shown, no session set.
3. Correct password → redirect to an authed page.
4. `GET /api/auth/me` (or the nav element) showing the **admin email** — proves the session cookie
   resolves server-side.
5. Logout → back to `/login`; a protected route now redirects to login.
6. **Token-never-in-browser** proof: on any authed page,
   `curl -s <dashboard-url>/<page> | grep -c "$ADMIN_TOKEN"` **== 0** (paste the `0`).

**Evidence / done when:** the six PNGs (+ the grep==0 note) land in `.agents/qa/m12-slice3/`.

---

## 5. Live SMTP alert send  ✅ _(done 2026-07-22 — Mailpit local catcher; evidence: `smtp-send-20260722.txt`)_

**Why it's blocking:** M13.5 shipped SMTP alert delivery (`createSmtpDeliverer`), but a **real
email** has never been observed. Set the opt-in env, force one alert firing, confirm the email
arrives.

**a. Configure SMTP** (nodemailer URL — e.g. an app-password Gmail relay or Mailtrap sandbox) and
restart ingest so it loads the env:

```sh
export ALERT_SMTP_URL="smtps://user:app-password@smtp.example.com:465"
export ALERT_EMAIL_FROM="420ai-alerts@example.com"
export ALERT_EMAIL_TO="you@example.com"
# restart ingest (npm run -w apps/ingest dev), or via the desktop Server-stack supervisor
```

**b. Force one real firing** with the helper — it lands ≥3 `ingest_auth_failures` (bad-bearer GETs
to a bodyless machine-authed route) then polls `/v1/monitor` to run the evaluate-on-read reconcile,
which opens the `ingest.auth_failure` firing and triggers delivery:

```sh
sh scripts/smoke-alert.sh
```

(The firing auto-resolves as the failures age out of the 15-min window — no cleanup needed.)

**Evidence / done when:** the `ALERT_EMAIL_TO` inbox receives the `ingest.auth_failure` alert email;
save `smtp-send-<date>.md` with the received message's subject/header (or a screenshot). Also confirm
the firing appears in the dashboard AlertsPanel.

> **Validated path (2026-07-22): Mailpit** — a fully local SMTP catcher, no account/credentials:
> `docker run -d --name mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit`, then
> `ALERT_SMTP_URL=smtp://localhost:1025` with any `FROM`/`TO` addresses; view captured mail at
> `http://localhost:8025`. Mailtrap/Ethereal also work if you prefer a hosted sandbox.
>
> **Gotcha:** SMTP config is read at ingest **boot** — fully stop the old ingest and confirm port
> 8420 is free before restarting, or the new (SMTP-configured) process silently `EADDRINUSE`s and
> the old no-SMTP process keeps serving (delivery never fires).

---

## 6. Scheduled-reports cold run  ✅ _(done 2026-07-22 — evidence: `reports-generate-20260722.txt`)_

**Why it's blocking:** `scripts/generate-reports.mjs` (M13.6) is the OS-cron report generator; it has
never been run against a live stack. Do one cold run.

Full runbook: [`docs/guide/operations.md`](../../../docs/guide/operations.md) **§13.6**.

```sh
INGEST_URL=http://localhost:8420 ADMIN_TOKEN="$ADMIN_TOKEN" \
  npm run reports:generate 2>&1 | tee .agents/qa/m14-signoff/reports-generate-$(date -u +%Y%m%d).txt
```

(Use a `.txt` extension, not `.log` — `*.log` is git-ignored, so the evidence wouldn't be trackable.)

**Evidence / done when:** the log shows one line per generated artifact across your projects and the
process exits **0** (it exits non-zero if any call fails). Save the teed log. (Optional: scope with
`-- --types project.efficiency --project <uuid>` for a faster smoke run first.)

---

## 7. Cursor live round-trip  ⬜

**Why it's blocking:** the Cursor connector (M13.7, SQLite poll mode) passed a read-only local spike,
but the full `collector watch → archive → Monitor` path with a real Cursor session has never been
shown live.

1. Ensure you have recent Cursor chat activity (`%APPDATA%\Cursor\…\state.vscdb`).
2. Run the collector against your real home so the poll loop picks up Cursor:
   ```sh
   npm run -w apps/collector dev -- watch --home "C:\Users\seanr"
   ```
   (Approve the Cursor capture surface if prompted — poll sources fold into the approval fingerprint.)
3. Let it sync, then open the dashboard **Monitor** and confirm a **Cursor** session appears
   (fidelity `experimental`, likely uncosted).

**Evidence / done when:** a screenshot of the Monitor (or a project detail) showing a captured Cursor
session, saved as `cursor-roundtrip-<date>.png` here.

---

## Sign-off

When all seven boxes are checked here **and** in the milestone plan, update `SUMMARY.md`: flip M14
from "AWAITING MAINTAINER SIGN-OFF" to **DONE**, note the date, and clear the two "hard not-done"
warnings in §0. That closes M14 and unblocks V2 (M15–M19) planning.
