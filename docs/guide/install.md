# 420AI — Install & Setup

This guide gets you from a fresh machine to a running 420AI install that captures your AI
coding-tool sessions. It is **desktop-first**: the [420AI Collector desktop app](../../apps/desktop/README.md)
is the primary control surface (pair, run capture, manage connectors, start/stop the server stack).
A **Manual / headless** path (Docker + CLI) follows for power users and servers.

> New to the project? Read the [README](../../README.md) for *what* 420AI is and the
> [domain glossary](../CONTEXT.md) for the vocabulary (Collector, Sidecar, Ingest API, etc.).

---

## How the pieces fit together

```
┌─ your Windows machine ─────────────────┐        ┌─ self-hosted archive ──────────┐
│  Desktop app (Tauri)                   │        │  Ingest API (Fastify, node)    │
│   ├─ Collector sidecar (node:sea exe)  │ ──────▶│   :8420  /v1/ingest etc.       │
│   │   tails Claude Code / Codex / Gemini│ paired │            │                   │
│   ├─ durable queue (~/.420ai)          │  token │            ▼                   │
│   └─ Settings → starts/stops ──────────┼───────▶│  Postgres archive (Docker)     │
│        the archive + ingest            │        │   :5433  (container 5432)      │
└────────────────────────────────────────┘        └────────────────────────────────┘
                                                              │
                                          Web Dashboard (Next.js) ── Live Monitor (read-only)
```

| Component | What it is | Where it runs |
|---|---|---|
| **Collector** | Headless Node/TS capture agent; tails connector files, buffers to a durable queue, syncs to the archive. Packaged as a single `.exe` **sidecar** inside the desktop app. | Your machine |
| **Desktop app** | Tauri (Rust + webview) shell. Pairing, tray controls, connector toggles, Sync & Health, and a Settings panel that **supervises the server stack**. | Your machine |
| **Ingest API** | Fastify service; per-token auth, idempotent batch writes, field-level encryption, projections, reports, AI interpretation. | Archive host (port **8420**) |
| **Central Archive** | Postgres 17 in Docker. Raw records + events + projects + reports. | Archive host (host port **5433**) |
| **Web Dashboard** | Next.js app. **Ships only the Live Monitor** today; reports/projects/analysis are ingest-API endpoints (see [usage](./usage.md)). | Archive host |

The archive + ingest can run on the **same machine** as the collector (the common single-machine
self-host) or a separate home server.

---

## Prerequisites

| Need | For | Notes |
|---|---|---|
| **Node ≥ 24** | everything (collector uses Node 24's built-in `node:sqlite`) | see `.nvmrc` |
| **Docker** | the Postgres archive | Docker Desktop on Windows |
| **Rust stable + `cargo tauri`** | *building* the desktop installer | `cargo install tauri-cli` |
| **NSIS** (`makensis`) | *building* the desktop installer | on `PATH` |

If someone hands you a prebuilt `420AI Collector_*_x64-setup.exe`, you don't need Rust/NSIS — but
you **still need the cloned repo** for the archive (`docker-compose.yml`) and the built ingest, and
**Node + Docker** to run them. See "Why the repo is still required" below.

---

## One-time repo setup (required for both paths)

The server stack — Postgres archive and the ingest API — lives in this repo. Even the desktop app
*starts* those from the repo (its **Server directory** = the repo root). So set the repo up once:

```bash
git clone <your-fork> 420AI && cd 420AI
npm install                         # wires the npm workspaces

cp .env.example .env                # then fill the two secrets below
```

Generate the two required secrets and paste them into `.env`:

```bash
# ARCHIVE_ENCRYPTION_KEY — 32 bytes, base64 (field encryption; never stored in the DB)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# ADMIN_TOKEN — gates POST /v1/pairing-codes and every admin read (incl. the dashboard)
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Then bring the database up and apply migrations (migrations read `DATABASE_URL` from the repo-root
`.env`, so this step is the same on both paths):

```bash
npm run db:up        # docker compose up -d  → postgres:17 on host port 5433
npm run db:migrate   # apply Drizzle migrations (10 application tables)
```

> **Ports.** The archive listens on host **5433** (container 5432) because a local Postgres on 5432
> is common. `DATABASE_URL`/`DATABASE_URL_TEST` in `.env.example` already point at 5433. The ingest
> API listens on **8420** (`INGEST_PORT`).

### Environment variables reference

All ingest/db vars load from the **repo-root `.env`**. Required ones are marked ●.

| Var | Purpose | Default |
|---|---|---|
| ● `DATABASE_URL` | Archive connection (dev DB) | `postgres://420ai:420ai@localhost:5433/420ai` |
| ● `ADMIN_TOKEN` | Admin bearer for pairing-code issuance + all admin reads | *(you generate)* |
| ● `ARCHIVE_ENCRYPTION_KEY` | 32-byte base64 field-encryption key | *(you generate)* |
| `DATABASE_URL_TEST` | Integration-test DB (self-skips if unset) | `…/420ai_test` |
| `INGEST_PORT` | Ingest API port | `8420` |
| `ANALYSIS_PROVIDER` | `anthropic` or `openai` (AI interpretation) | `anthropic` |
| `ANALYSIS_API_KEY` | Provider API key | *(empty)* |
| `ANALYSIS_MODEL` | Model id | `claude-sonnet-4-6` |
| `ANALYSIS_BASE_URL` | OpenAI-compatible base URL (e.g. Ollama `http://localhost:11434/v1`) | *(empty)* |
| `ANALYSIS_MAX_OUTPUT_TOKENS` | Max output tokens per interpretation | `4096` |
| `ANALYSIS_TIMEOUT_MS` | Per-call timeout | `60000` |
| `MONITOR_STREAM_INTERVAL_MS` | Live-Monitor SSE cadence | `3000` |
| `HEARTBEAT_INTERVAL_MS` | Collector heartbeat cadence | `30000` |
| `INGEST_URL` | Where the dashboard proxy reaches ingest | `http://localhost:8420` |

The analysis vars are optional — leave them blank and capture/reporting still work; only the AI
interpretation endpoints return `503 not_configured`.

---

## Path A — Desktop app (recommended)

### A1. Get the desktop installer

Build it from this repo (full recipe, including the OneDrive and icon prerequisites, lives in
[`apps/desktop/README.md`](../../apps/desktop/README.md)):

```bash
npm run build:desktop
```

This chains the SEA sidecar build → the webview build → `cargo tauri build`, and emits:

```
…/release/bundle/nsis/420AI Collector_<version>_x64-setup.exe   (~26 MB)
```

Run the installer and launch **420AI Collector**.

> The `postject` `warning: The signature seems corrupted!` during the build is **expected** (we
> patch the signed `node.exe`); it does not fail the build.

### A2. Build the ingest server (so the app can start it)

The desktop Settings panel's **Start Ingest** runs `node {serverDir}/apps/ingest/dist/server.js`, so
the ingest must be compiled to `dist/` once:

```bash
npm run build       # tsc -b across the backend workspaces → apps/ingest/dist/server.js
```

(If you prefer to run ingest yourself with hot-reload, skip this and use the Manual path's
`npm run ingest:dev` instead — then just leave the desktop "Start/Stop Ingest" buttons unused.)

### A3. Configure the server stack in the app

Open **Settings** in the app. Under **Server config**, fill:

| Field | Value |
|---|---|
| **Server directory (repo root)** | the absolute path to your cloned `420AI` repo |
| **Ingest URL** | `http://localhost:8420` |
| **Ingest port (optional)** | `8420` |
| **Admin token** | the `ADMIN_TOKEN` you generated |
| **Database URL** | `postgres://420ai:420ai@localhost:5433/420ai` |
| **Archive encryption key** | the `ARCHIVE_ENCRYPTION_KEY` you generated |

(Optional **Analysis provider** section for AI interpretation: provider/API key/model/base URL.)

Click **Save** — secrets go into the **Windows Credential Manager** (never a plaintext file; the app
injects them into the ingest process env at launch). Stored secret fields show `•••• set — leave
blank to keep` afterward; leave them blank to preserve the saved value.

> These values are the same as your `.env`. The app holds them in the keychain so it can launch
> ingest with them injected as env — you do **not** need ingest to read `.env` when the app starts it.
> (Migrations in A-setup still used `.env`.)

### A4. Start the stack and pair

In **Settings → Server stack**:

1. **Start Archive** → runs `docker compose -f <serverDir>/docker-compose.yml up -d archive`.
2. **Start Ingest** → spawns the built ingest with your keychain secrets injected.
3. **Refresh health** → **Archive** should read `healthy`/`running`, **Ingest** `up`.

Then create a pairing code and pair:

```bash
# Issue a one-time pairing code (admin-gated) from the repo, against the running ingest:
curl -s -X POST localhost:8420/v1/pairing-codes \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d '{}'
```

In the app's **Pairing** panel: **Archive URL** = `http://localhost:8420`, paste the **Pairing code**,
optionally set a **Machine name**, click **Pair**. The badge flips to `paired`. The ingest token is
stored in the keychain — never shown to the UI.

Flip **Run on login** to **On** in the Pairing panel if you want the collector to start at sign-in.

### A5. Capture

Press **Start** (Capture panel, or the tray menu). The collector discovers and tails your connector
files and syncs to the archive. See [usage](./usage.md) for the daily-use details.

---

## Path B — Manual / headless (CLI + your own servers)

No desktop app. You run each piece yourself — good for a headless server, CI, or development.

After the [one-time repo setup](#one-time-repo-setup-required-for-both-paths) (incl. `db:up` +
`db:migrate`):

```bash
# 1. Start the ingest API (hot-reload via tsx; reads .env automatically)
npm run ingest:dev                     # → http://localhost:8420
curl -s localhost:8420/v1/health       # {"status":"ok",...}

# 2. Issue a pairing code (admin-gated)
curl -s -X POST localhost:8420/v1/pairing-codes \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d '{}'

# 3. Pair this machine (writes ~/.420ai/credentials.json — plaintext, mode 0600)
npx tsx apps/collector/src/cli.ts pair <code> --url http://localhost:8420 --name win-dev

# 4. Run continuous capture (Ctrl-C stops with a graceful final drain)
npx tsx apps/collector/src/cli.ts watch
```

`watch` reads the saved credentials from `~/.420ai/credentials.json`. Full CLI reference (sync,
queue, discover, projects, push, report) is in [usage](./usage.md).

> **CLI vs desktop secrets.** The CLI path stores credentials in plaintext at
> `~/.420ai/credentials.json` (owner-only `0600`). The desktop app stores them in the Windows
> Credential Manager instead and never touches that file. Pick one path per machine.

### Optional: the Web Dashboard (Live Monitor)

```bash
npm run dashboard:dev      # Next.js dev server
```

Next loads env from the dashboard CWD, so pass the token inline or via `apps/dashboard/.env.local`:

```bash
INGEST_URL=http://localhost:8420 ADMIN_TOKEN=<your-admin-token> npm run dashboard:dev
```

Open the dashboard and it redirects to `/monitor` (the Live Monitor). The browser never holds
`ADMIN_TOKEN` — it talks to ingest only through same-origin proxy routes that add the bearer
server-side. The dashboard ships **only** this page today; everything else is via the API.

---

## Verify the install

```bash
curl -s localhost:8420/v1/health                      # ingest is up
docker compose ps                                      # archive container healthy
npx tsx apps/collector/src/cli.ts queue                # queue backlog (pending/inflight)
```

In the desktop app: **Sync & Health → Refresh** should show your collector online and (once you've
used an AI tool) a non-zero processed count. Confirm the branded icon appears in the window,
taskbar, and tray.

Hitting a snag? See [troubleshooting](./troubleshooting.md). Day-to-day operation and the full
command/endpoint reference are in [usage](./usage.md).
