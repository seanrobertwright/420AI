# Quickstart — self-hosted 420AI (guided onboarding)

The cold-start walkthrough for a fresh clone, mapping the PRD §19 onboarding flow to the real
commands. It gets you from `git clone` to a Live Monitor showing captured sessions and a first
report. All commands run from the repo root unless noted; deeper ops (backups, key rotation,
scheduled reports) live in [`operations.md`](./operations.md).

**Prerequisites:** Node ≥ 24, Docker (for the Postgres archive), and at least one supported AI CLI
already used on this machine (Claude Code, Codex, or Gemini) so there are sessions to capture.

---

## 1. Generate secrets and env files (guided setup)

```sh
npm install
npm run setup
```

`npm run setup` ([`scripts/setup-env.mjs`](../../scripts/setup-env.mjs)) copies `.env.example` →
`.env`, generating the three secrets a fresh clone must create itself — `ARCHIVE_ENCRYPTION_KEY`
(the AES-256-GCM field key), `ADMIN_TOKEN` (the machine/service bearer), and `SESSION_SECRET` (the
login-cookie HMAC). It also writes `apps/dashboard/.env.local` with the **same** `SESSION_SECRET`
(the dashboard verifies the login cookie with it — a mismatch fails every login). It **refuses to
overwrite an existing `.env`** — delete it first if you truly mean to regenerate (that rotates every
secret and invalidates live sessions).

To enable the dashboard login now, set `ADMIN_PASSWORD` in `.env` (and `ADMIN_EMAIL` if you don't
want the default). Left blank, the API still works via `ADMIN_TOKEN` for machine clients and login
is disabled.

## 2. Start the archive and apply migrations (create the admin user)

```sh
npm run db:up        # Postgres via docker-compose (host port 5433)
npm run db:migrate   # apply all migrations
```

The admin user is seeded from `ADMIN_EMAIL`/`ADMIN_PASSWORD` on every ingest boot (next step) —
there is no separate "create user" command.

## 3. Start the ingest API and dashboard

```sh
npm run ingest:dev        # terminal 1 → http://localhost:8420
npm run dashboard:dev     # terminal 2 → http://localhost:3000
```

Open the dashboard at `http://localhost:3000`. With `ADMIN_PASSWORD` set, log in at `/login`. The
Live Monitor greets a fresh install with an **onboarding card** (no machines paired yet) — the
next steps fill it in.

## 4. Generate a machine pairing code

In the dashboard, open the **Pairing** page (`/pairing`) and click **Generate pairing code**. Codes
are short-lived — pair promptly.

## 5–6. Install/start the collector, pair it, and register the machine

Pairing registers the machine and issues its ingest token in one step. In dev, run the collector
CLI from the repo root:

```sh
npm run -w @420ai/collector start -- pair <code> --url http://localhost:8420
```

It saves credentials to `~/.420ai/credentials.json` and prints the `machineId` + ingest token. For
a headless always-on install, see the WinSW service under `apps/collector/service/` (and the
`--home` note in [`operations.md`](./operations.md) for running under a Windows service account).

## 7–8. Discover repositories/workspaces and map them to projects

```sh
npm run -w @420ai/collector start -- discover
```

`discover` scans your machine for AI-CLI sessions and git workspaces, upserts them, and
auto-creates projects. Rename or re-map projects from the dashboard **Projects** page.

## 9–11. Select connectors, review permissions/fidelity, and test

Connectors are auto-detected from the sessions on disk; review each connector's fidelity label and
permission scope on the **Catalog** page. A connector whose capture surface widens flips to
`needs-approval` and must be approved there before it captures (the §10.4 gate). Capture git history
once to seed outcome proxies:

```sh
npm run -w @420ai/collector start -- git
```

## 12. Start the background collector

```sh
npm run -w @420ai/collector start -- watch      # Ctrl-C for a graceful drain
```

`watch` runs the durable capture loop (watcher + sync + git sweep). It streams new session events
into the archive and sends a liveness heartbeat.

## 13. Open the Live Monitor and run your first report

Back on `/monitor`, the onboarding card is replaced by live tables — machines, connectors, and
active sessions — within a few seconds of the first captured event. Open a **Project**, then
**Generate report** (start with _Cost over time_ or _Efficiency_) to render your first versioned
Markdown + Mermaid report.

---

## Next steps

- **Scheduled reports:** automate the report suite via the OS scheduler — see
  [`operations.md` §13.6](./operations.md#136--scheduled-reports-opt-in).
- **Backups & restore, key rotation, migration rollback, alert delivery:** all in
  [`operations.md`](./operations.md).
- **Desktop app:** the Tauri tray app supervises the stack and auto-updates — see
  [`apps/desktop/README.md`](../../apps/desktop/README.md).
