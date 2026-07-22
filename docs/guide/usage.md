# 420AI — Usage & How-To

Day-to-day operation once you've [installed](./install.md): running capture, managing connectors,
mapping projects, and pulling reports/insights. Desktop-app workflows come first, then the full CLI
and API reference.

---

## 1. The desktop app, panel by panel

The app window stacks five panels (top to bottom): **Pairing**, **Capture**, **Sync & Health**,
**Connectors**, **Settings**.

### Pairing

- Shows `paired` / `not paired` and, when paired, `paired as <machineId>`.
- To (re)pair: set **Archive URL**, paste a **Pairing code** from the dashboard/API, optionally a
  **Machine name** (defaults to the computer name), click **Pair** / **Re-pair**.
- **Run on login** toggle (`On`/`Off`) — registers the app under Windows
  `HKCU\…\CurrentVersion\Run` via the autostart plugin so the collector launches at sign-in.

### Capture

The capture state machine and queue at a glance.

- **State badge:** `running` / `paused` / `idle` / `error` / `connecting…`.
- **Buttons:** **Start** (when idle/error), **Pause** (when running), **Resume** (when paused).
- **Stats:** `pending`, `inflight`, `last sync`. `pending` = events buffered locally; `inflight` =
  events claimed for a sync attempt.

These same controls live in the **system tray** (see below), so you can drive capture without
opening the window.

### Sync & Health

- **Local** backlog: `local state`, `pending`, `inflight`.
- **Server fleet view** (needs the admin token, configured in Settings): `Collectors` with
  `online`/`stale`/`offline` counts, `server backlog`, `connectors`, `active sessions`.
- **Alerts** table (`Severity` / `Alert` / `Scope` / `Since`); `No active alerts.` when clear.
- **Refresh** re-pulls the snapshot.

### Connectors

Enable or disable individual capture sources. Changes apply **when capture (re)starts**.

- Table columns: **Connector**, **Fidelity** (liveness + `tokens:` + `cost:` + any `gaps:`),
  **Reads (permission scope)**, **Capture** (a **Disable**/**Enable** toggle).
- Disabling writes `~/.420ai/connectors.json` (records which connectors you turned **off**; everything
  is on by default). There's no CLI for this toggle — it's the app (or the engine option).

### Settings

Three sections:

1. **Server config** — the archive/ingest connection + secrets (see [install A3](./install.md#a3-configure-the-server-stack-in-the-app)). **Save** stores secrets in the Windows Credential Manager.
2. **Server stack** — **Start/Stop Archive** (`docker compose … up -d archive` / `down`),
   **Start/Stop Ingest** (spawns the built ingest with secrets injected), **Refresh health**
   (Archive: `healthy`/`running`/`starting`/`stopped`; Ingest: `up`/`down` via `GET /v1/health`).
3. **Pairing** (read-only) — current pairing + an **Unpair** button.

### System tray

Right-click the tray icon (tooltip **420AI Collector**):

| Item                               | Action                                                  |
| ---------------------------------- | ------------------------------------------------------- |
| **Start** / **Pause** / **Resume** | drive the collector sidecar (same as the Capture panel) |
| **Server: manage in Settings**     | display-only label (server controls live in Settings)   |
| **Quit**                           | exits the app (tears the sidecar down cleanly)          |

---

## 2. Connectors — what gets captured

All three required connectors are **stable**, capture **exact tokens**, and **compute cost** from
tokens × the pricing catalog. They watch your local tool stores read-only.

| Connector            | `id`          | Watches                                   | Mode                          | Liveness       |
| -------------------- | ------------- | ----------------------------------------- | ----------------------------- | -------------- |
| **Claude Code**      | `claude-code` | `~/.claude/projects/*/*.jsonl`            | tail                          | streaming      |
| **OpenAI Codex CLI** | `codex-cli`   | `~/.codex/sessions/*/*/*/rollout-*.jsonl` | tail                          | streaming      |
| **Gemini CLI**       | `gemini-cli`  | `~/.gemini/tmp/*/chats/session-*.json`    | snapshot (whole-file re-read) | near-real-time |

Known gaps (surfaced as `gaps:` badges):

- **Claude Code** — `file.referenced` not emitted (no reliable structured signal); `session.ended`
  timestamp settles only once the file stops growing.
- **Codex CLI** — tool-call _failure_ classification deferred (outputs carry no structured
  `is_error`). Validated against CLI `0.137.x`.
- **Gemini CLI** — sessions are keyed by an opaque `projectHash`; project attribution needs the
  `.project_root` sidecar. Legacy hash-only sessions stay **unattributed** (a reported gap, not an
  error).

Capture is **idempotent and resumable**: per-file byte-offset cursors mean a restart re-sends
nothing already captured; content-hash dedup + server-side fingerprint upsert make re-sends no-ops.
Offline? The durable queue buffers and retries with backoff; a revoked token (401) stops the sync
loop with a clear "re-pair needed" rather than spinning.

### Importing chat exports (Claude web) — experimental (M14 14.5)

Chat conversations (as opposed to coding-tool sessions) live only server-side — there is no local
store to watch — so they are captured from the surface's **official data export**, dropped into an
import directory the collector watches:

| Connector         | `id`             | Drop file into                         | Mode     | Liveness |
| ----------------- | ---------------- | -------------------------------------- | -------- | -------- |
| **Claude (web)**  | `claude-export`  | `~/.420ai/chat-imports/claude/*.json`  | snapshot | batch    |
| **ChatGPT (web)** | `chatgpt-export` | `~/.420ai/chat-imports/chatgpt/*.json` | snapshot | batch    |
| **Gemini (web)**  | `gemini-export`  | `~/.420ai/chat-imports/gemini/*.json`  | snapshot | batch    |

To import your chat history:

- **Claude** — in **claude.ai → Settings → Privacy → Export data**, request the export and wait for
  the email; unzip and find **`conversations.json`**. Drop it into `~/.420ai/chat-imports/claude/`.
- **ChatGPT** — in **ChatGPT → Settings → Data controls → Export data**, request the export and wait
  for the email; unzip and find **`conversations.json`**. Drop it into `~/.420ai/chat-imports/chatgpt/`.
- **Gemini** — in **Google Takeout**, select **My Activity → Gemini Apps** in **JSON** format, download
  the archive, and find **`MyActivity.json`**. Drop it into `~/.420ai/chat-imports/gemini/`.

Create the folder if absent, then run (or leave running) `collector watch`. The whole-file snapshot
parser picks each file up on the next tick.

Chat-export capture is deliberately **honest about its lower fidelity** (`gaps:` badges):

- **`experimental`** status, **`batch`** liveness — the data is days-stale between manual exports.
- **Uncosted** — the exports carry **no token counts**, so no `usage`/`cost` events are emitted
  (`tokens: none`, `cost: none`). This is intentional, not a bug. ChatGPT additionally carries a
  **model** (`model_slug`), so its chat events ARE model-attributed; Claude and Gemini carry no model.
- **Non-repo attribution** — a chat has no cwd/git, so each conversation is attributed to a stable
  synthetic topic key: `chat:claude:<conversation-uuid>`, `chat:chatgpt:<conversation-id>`, or
  `chat:gemini:<derived-key>`. Group several conversations under one workspace by aliasing those keys
  via the normal `workspace_keys` mapping (§4) — no code needed.
- Re-importing the same export is a **no-op** (stable-id-keyed fingerprints dedup server-side).
- **Gemini** is a Google Takeout "My Activity" **flat activity log** with no conversation threading —
  each "Prompted" record becomes its own single-turn session (keyed by a derived `time`+prompt hash,
  since Takeout records carry no native id); non-conversation activity (canvas, feedback, image
  generation) is skipped, and attachments are deferred.
- ChatGPT `thoughts`/`reasoning_recap` reasoning nodes and `multimodal_text` attachments, and Claude
  `tool_use`/`thinking` blocks and files, are stored as raw records but **not yet** turned into
  normalized tool/file events (deferred).

---

## 3. Collector CLI reference

Run with `tsx` (no build needed). `--url`/`--token` default to your saved pairing
(`~/.420ai/credentials.json`) unless overridden.

```bash
collector ingest   <file> [--db <path>]
collector report   <sessionId> [--db <path>] [--out <file>]
collector pair     <code> --url <baseUrl> [--name <n>] [--os <os>] [--hostname <h>]
collector push     <file> [--url <baseUrl>] [--token <token>]
collector watch    [--url <baseUrl>] [--token <token>] [--interval <ms>]
collector sync     [--url <baseUrl>] [--token <token>]
collector queue
collector discover [--url <baseUrl>] [--token <token>]
collector projects [--url <baseUrl>] [--token <adminToken>]
```

Invoke as `npx tsx apps/collector/src/cli.ts <command> …`. Running with no command prints this usage
plus, if a local DB exists, the stored sessions.

| Command                     | What it does                                                                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`pair`**                  | Redeems a one-time code; saves `{url, token, machineId}` to `~/.420ai/credentials.json`. `--url` is **required**; `--name`/`--hostname` default to the computer name, `--os` to `process.platform`. Prints the ingest token once — store it securely.                    |
| **`watch`**                 | The continuous capture agent: discover → tail → queue → sync, until Ctrl-C (graceful final drain). Unpaired ⇒ prints "run `collector pair …`" and exits. `--interval` sets the poll cadence; `--heartbeat-interval` (or `HEARTBEAT_INTERVAL_MS`) sets the liveness ping. |
| **`sync`**                  | One-shot drain of the durable queue to the archive (ops/testing). Prints `pending`/`inflight` after.                                                                                                                                                                     |
| **`queue`**                 | Prints the queue backlog: `pending=… , inflight=…`.                                                                                                                                                                                                                      |
| **`discover`**              | Enumerates project roots across all connectors, enriches with git metadata + Gemini's `.project_root`, and POSTs them — upserting workspaces and auto-creating one project per workspace. Idempotent.                                                                    |
| **`projects`**              | Lists the archive's projects. **Admin-gated** — pass `--token <adminToken>` (the saved pairing is a _machine_ token; a machine token gets a friendly 401 hint).                                                                                                          |
| **`push`**                  | One-shot: parse one Claude Code session file and POST it (the manual precursor to `watch`). Idempotent (`recordsInserted: 0` on re-push).                                                                                                                                |
| **`ingest`** / **`report`** | Local-only (SQLite) helpers: parse a session file into a local DB, and render a Markdown session report from it. `--db` defaults to `./420ai.sqlite`.                                                                                                                    |

**Typical headless loop:**

```bash
npx tsx apps/collector/src/cli.ts pair <code> --url http://localhost:8420
npx tsx apps/collector/src/cli.ts discover                 # map repos → projects (one-time / when repos change)
npx tsx apps/collector/src/cli.ts watch                    # leave running
# in another shell, anytime:
npx tsx apps/collector/src/cli.ts queue                    # check backlog
npx tsx apps/collector/src/cli.ts projects --token $ADMIN_TOKEN
```

---

## 4. Mapping sessions to projects

Capture records carry a workspace path; **discovery** turns those into named projects.

- Desktop app: capture runs discovery as part of `watch`. To force it headless: `collector discover`.
- It reads each connector's project roots, parses `.git/config` + `.git/HEAD` (no `git` subprocess),
  reverse-maps Gemini's `projectHash` via the `.project_root` sidecar, and **auto-creates one project
  per workspace**, unifying across machines by git remote.
- The auto-mapping is an editable default. Rename or remap via the admin API:

```bash
ADMIN=$ADMIN_TOKEN; BASE=http://localhost:8420
curl -s "$BASE/v1/projects" -H "authorization: Bearer $ADMIN"                       # list
curl -s -X PATCH "$BASE/v1/projects/<id>" -H "authorization: Bearer $ADMIN" \
  -H "content-type: application/json" -d '{"name":"My Project"}'                    # rename
curl -s -X PATCH "$BASE/v1/workspaces/<id>" -H "authorization: Bearer $ADMIN" \
  -H "content-type: application/json" -d '{"projectId":"<otherProjectId>"}'         # remap
```

Re-running discovery preserves a manual remap.

---

## 5. Viewing your data

### Live Monitor (dashboard UI)

Run the dashboard ([install B](./install.md#optional-the-web-dashboard-live-monitor)), open it, and it
lands on `/monitor`: machines (online/stale/offline), connector health, active sessions, backlog, and
operational alerts — updating live over SSE.

### Dashboard read surfaces

Beyond the Live Monitor, the dashboard adds **read-only** pages over the same admin ingest APIs, reached
from the persistent top nav:

- **Projects** (`/projects`) — every project, each linking to a detail page with usage tiles (cost,
  tokens, events), a by-model breakdown, usage over time, the session list, and git metadata.
- **Reports** (`/reports`) — the versioned report artifacts; select one to read its Markdown (shown as
  preformatted text in this slice). The **Compare versions** panel diffs two versions of the same report.
- **Search** (`/search`) — the redacted full-text index (12.1): query box plus entity-type and project
  filters; snippets are content-safe (masked before storage).
- **Machines** (`/machines`) — collector health, sync backlog, heartbeat, and the workspace→project
  mapping.

The browser never holds `ADMIN_TOKEN`: every page renders server-side and every browser→ingest call goes
through a same-origin proxy Route Handler that adds the admin bearer on the server→ingest hop only.

### Dashboard mutating surfaces (12.2b)

The same proxy discipline backs the admin **mutation** surfaces — each control POSTs/PATCHes a same-origin
Route Handler, checks the result, disables in-flight to avoid duplicate writes, and refreshes the page:

- **Reports** — on a project's detail page, **Generate cost report** / **Generate AI interpretation**; each
  session row has **Autopsy** / **AI** generate buttons. AI interpretation calls a **billable** provider, so
  it confirms first and surfaces "provider not configured" (503) vs "provider error" (502) distinctly.
  **Compare versions** (on `/reports`) renders two versions of one report side-by-side plus a numeric delta
  table over the `metrics` blob.
- **Projects** — **New project** form on `/projects`; inline **Rename** on the detail page.
- **Machines** — each workspace row has a **Remap** picker to move it to another project (chosen from the
  project list, so the id is always valid).
- **Catalog** (`/catalog`) — pricing-catalog versions with **Approve** / **Reject** on pending rows.
  Approve atomically supersedes the current active version. **Upload is offline-signed (CLI) only** — there
  is deliberately no upload form; the dashboard manages the approval gate.
- **Search** (`/search`) — a **Reindex** button rebuilds the full-text index and reports the row counts.
- **Pairing** (`/pairing`) — **Generate pairing code** mints a short-lived code (with expiry + copy) to
  pair a new collector machine.
- **Export** (`/export`) — download **redacted** events (JSON/JSONL/CSV), a report artifact (MD/JSON), or a
  session transcript (MD/JSON/JSONL). Downloads stream through the proxy, so the file saves with no token in
  the browser and the bytes are already redaction-versioned.
- **Settings** (`/settings`) — **read-only** system status: ingest health, the monitor version, the active
  pricing-catalog version, and whether the server env is configured (shown as "configured", never the
  value). Editable settings arrive in a later M12 slice.

Deferred to a later slice: rich Markdown/Mermaid report rendering, catalog **upload** UI, machine/token
**revoke**, and a typed per-report-type metrics diff.

### Reports, projections & AI insight (ingest API)

Everything else is admin-gated HTTP on the ingest API. Set `ADMIN=$ADMIN_TOKEN` and
`BASE=http://localhost:8420`.

**Projections (read-only metrics over the event log):**

```bash
curl -s "$BASE/v1/projects/<id>/summary"           -H "authorization: Bearer $ADMIN"
curl -s "$BASE/v1/projects/<id>/usage"             -H "authorization: Bearer $ADMIN"
curl -s "$BASE/v1/projects/<id>/usage/by-model"    -H "authorization: Bearer $ADMIN"
curl -s "$BASE/v1/projects/<id>/usage/over-time?bucket=week" -H "authorization: Bearer $ADMIN"
curl -s "$BASE/v1/projects/<id>/sessions"          -H "authorization: Bearer $ADMIN"
curl -s "$BASE/v1/projects/<id>/git"               -H "authorization: Bearer $ADMIN"
curl -s "$BASE/v1/sessions/<sessionId>"            -H "authorization: Bearer $ADMIN"
curl -s "$BASE/v1/connectors/health"               -H "authorization: Bearer $ADMIN"
```

**Markdown reports (durable, versioned artifacts):**

```bash
# Generate (201) — project cost-over-time, or a session metrics-autopsy:
curl -s -X POST "$BASE/v1/projects/<id>/reports"           -H "authorization: Bearer $ADMIN"
curl -s -X POST "$BASE/v1/sessions/<sessionId>/reports"    -H "authorization: Bearer $ADMIN"

# List & fetch:
curl -s "$BASE/v1/reports?type=<type>&scopeId=<id>"        -H "authorization: Bearer $ADMIN"
curl -s "$BASE/v1/reports/<reportId>"                      -H "authorization: Bearer $ADMIN"
```

Reports render from the plaintext projections only — they never decrypt payloads. Each generation
appends a new **version** of the artifact.

**AI interpretation (optional — requires the analysis provider env):**

```bash
curl -s -X POST "$BASE/v1/sessions/<sessionId>/interpretations" -H "authorization: Bearer $ADMIN"
curl -s -X POST "$BASE/v1/projects/<id>/interpretations"        -H "authorization: Bearer $ADMIN"
```

Content is **redacted** (regex + entropy secret-masking) before anything leaves the archive. With no
provider configured these return `503 not_configured`; an empty scope returns `404`.

**Full-text search (admin):**

```bash
# Reindex first — builds the redacted search projection from reports, projects, and
# sessions (decrypts session content, redacts it, then indexes). Run after capture
# to refresh; reindex is manual in this slice and is idempotent (full rebuild).
curl -s -X POST "$BASE/v1/search/reindex"                 -H "authorization: Bearer $ADMIN"
# → {"reports":N,"projects":N,"sessions":N,"total":N}

# Search — ranked hits across sessions/reports/projects:
curl -s "$BASE/v1/search?q=anthropic%20spend"             -H "authorization: Bearer $ADMIN"
# Optional filters: &type=session|report|project  &projectId=<uuid>  &limit=1..100
```

Hits come from a **redacted projection** — every title and snippet was masked before it was stored, so
search never exposes a secret and never touches the encrypted originals. Supports plain terms,
`"quoted phrases"`, and `-negation` (`websearch_to_tsquery`). Advanced semantic/vector search is V2.

---

## 6. Stopping & maintenance

- **Pause/stop capture:** Capture/tray **Pause**, or Ctrl-C the `watch` process.
- **Stop the stack (desktop):** Settings → **Stop Ingest**, **Stop Archive**. The `archive-data`
  Docker volume persists your data across `down`.
- **Stop the stack (manual):** Ctrl-C `ingest:dev`; `npm run db:down`.
- **Unpair:** Settings → **Unpair** (desktop) clears the keychain credentials. (CLI path: delete
  `~/.420ai/credentials.json`.) Re-pair with a fresh code afterward.
- **Revoke a machine:** admin-side, ingest tokens are revocable; the collector surfaces a 401 as a
  "re-pair needed" and stops syncing.

See [troubleshooting](./troubleshooting.md) for failure modes and fixes.
