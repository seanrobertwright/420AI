# 420AI — Troubleshooting

Common failure modes, what they mean, and how to fix them. Grouped by where they surface. See also
[install](./install.md), [usage](./usage.md), and the desktop build recipe in
[`apps/desktop/README.md`](../../apps/desktop/README.md).

---

## Building the desktop installer

| Symptom                                                       | Cause                                                        | Fix                                                                                                                                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build fails at WiX `light.exe`                                | `bundle.targets` includes MSI; the WiX toolset fails locally | The repo pins `targets: ["nsis"]` — ensure you didn't revert it. NSIS is the supported target; MSI is deferred.                                                                                             |
| `Os { code: 5, PermissionDenied }` during `cargo tauri build` | OneDrive locks freshly built `target/` artifacts             | Redirect the Rust `target-dir` out of OneDrive via `apps/desktop/src-tauri/.cargo/config.toml`, or clone the repo outside OneDrive. Full steps in [`apps/desktop/README.md`](../../apps/desktop/README.md). |
| Build references missing `icons/32x32.png` etc.               | `src-tauri/icons/` is gitignored; a fresh clone has none     | `cd apps/desktop && cargo tauri icon src-tauri/app-icon.png`                                                                                                                                                |
| `warning: The signature seems corrupted!` (postject)          | We patch the signed `node.exe` when building the SEA sidecar | **Expected** — not an error. The build continues and exits 0.                                                                                                                                               |
| `makensis` / `cargo tauri` not found                          | NSIS / Tauri CLI not installed                               | `cargo install tauri-cli`; install NSIS and ensure `makensis` is on `PATH`.                                                                                                                                 |

---

## Pairing

| Symptom                                                      | Cause                                                   | Fix                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pairing failed: HTTP 410`                                   | The pairing code expired or was already used            | Issue a fresh code: `POST /v1/pairing-codes` with the admin token.                                       |
| `ingest unreachable: …` (desktop) / connection refused (CLI) | Ingest isn't running or the URL is wrong                | Confirm `curl localhost:8420/v1/health` returns ok; check the **Archive URL** / `--url`.                 |
| `pairing failed: HTTP 401` on `POST /v1/pairing-codes`       | Wrong/missing `ADMIN_TOKEN`                             | Use the exact `ADMIN_TOKEN` from `.env` (and ensure ingest was started with that same value).            |
| `projects is admin-gated — pass --token <adminToken>`        | You used the saved _machine_ token for an admin command | Pass `--token $ADMIN_TOKEN` explicitly to `collector projects`.                                          |
| Paired but capture does nothing                              | Token revoked, or no connector files yet                | Check **Sync & Health**; a 401 means "re-pair needed". Otherwise see "Connectors capture nothing" below. |

---

## Server stack (archive + ingest)

| Symptom                                                                    | Cause                                                         | Fix                                                                                                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL is not set (copy .env.example to .env)`                      | No `.env` or missing var                                      | `cp .env.example .env` and fill it; the value is read from the **repo-root** `.env`.                                                                                         |
| `ADMIN_TOKEN is not set` / `ARCHIVE_ENCRYPTION_KEY not configured`         | Required secret missing                                       | Generate and set them (see [install](./install.md#one-time-repo-setup-required-for-both-paths)). For the desktop app, set them in **Settings → Server config** and **Save**. |
| `ingest not built — run \`npm run build\` in <serverDir> (missing <dist>)` | Desktop **Start Ingest** needs the compiled ingest            | Run `npm run build` at the repo root (emits `apps/ingest/dist/server.js`), or run ingest manually with `npm run ingest:dev`.                                                 |
| `failed to start ingest: node not found on PATH`                           | Node not visible to the app's process                         | Ensure Node ≥ 24 is installed and on `PATH` for the user the app runs as.                                                                                                    |
| `Docker not installed/not running (docker not found on PATH)`              | Docker Desktop not running                                    | Start Docker Desktop; verify `docker compose ps`.                                                                                                                            |
| Archive health shows `stopped` after Start                                 | Wrong **Server directory**, or compose service didn't come up | Confirm **Server directory** is the repo root containing `docker-compose.yml`; check `docker compose ps` (service `archive`, container `420ai-archive`).                     |
| Archive stuck `starting`                                                   | Postgres still initializing                                   | Wait for the healthcheck (`pg_isready`); **Refresh health** again.                                                                                                           |
| Port already in use (5433 / 8420)                                          | Another process owns the port                                 | Stop the conflicting process, or change `INGEST_PORT` / the compose host port (the archive maps host **5433** → container 5432 deliberately to avoid a local 5432).          |

---

## Migrations & database

| Symptom                        | Cause                                         | Fix                                                                                                                                                                                                         |
| ------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db:migrate` errors connecting | DB not up, or `DATABASE_URL` points elsewhere | `npm run db:up` first; confirm the URL uses host port **5433**.                                                                                                                                             |
| Need a clean slate             | —                                             | `npm run db:down` then remove the `archive-data` volume (`docker volume rm`), then `db:up` + `db:migrate`. **Destroys all archived data.**                                                                  |
| Verify encryption-at-rest      | —                                             | `docker compose exec archive psql -U 420ai -d 420ai -c "SELECT left(payload_ciphertext,40), payload_iv FROM raw_source_records LIMIT 1;"` → base64, not JSON. Token counts/costs in `events` stay readable. |

---

## Connectors capture nothing

1. **Is capture running?** Capture panel should read `running` (not `idle`/`paused`/`error`).
2. **Are the source files there?** Confirm the watched paths exist and you've actually used the tool:
   - Claude Code: `~/.claude/projects/<slug>/<uuid>.jsonl`
   - Codex CLI: `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`
   - Gemini CLI: `~/.gemini/tmp/<hash>/chats/session-*.json`
3. **Is the connector enabled?** Connectors panel — re-enable if you'd toggled it **Disable**
   (`~/.420ai/connectors.json` records disabled ones). Changes apply when capture **restarts**.
4. **Backlog growing but not syncing?** `collector queue` shows `pending`; if it never drains, the
   archive is unreachable or the token was revoked (check **Sync & Health** / a 401).
5. **Gemini sessions unattributed?** Legacy sessions without a `.project_root` sidecar can't be
   mapped to a project — this is a known gap, not a failure; capture still works.

---

## Tests & gates

| Symptom                                               | Cause                                                                            | Fix                                                                                                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Integration tests "skipped" but suite green           | `DATABASE_URL_TEST` unset ⇒ `*.int.test.ts` self-skip                            | For real sign-off: `npm run db:up && npm run db:migrate` then `npm run repo-health -- --require-db` (fails if any int test skipped). |
| `ExperimentalWarning` from `node:sqlite`              | Node 24's `node:sqlite` is experimental                                          | **Expected by design** — does not affect correctness; don't suppress it in a way that breaks tests.                                  |
| `repo-health` fails on NUL-byte / stray-artifact scan | A source file has embedded NULs, or emitted `*.js`/`dist/`/`*.sqlite` got staged | Rewrite the offending file as clean UTF-8; unstage build artifacts (`*.sqlite` and `src/`-emitted JS are gitignored).                |

---

## Where things live

| Path                                        | What                                          | Committed?         |
| ------------------------------------------- | --------------------------------------------- | ------------------ |
| `~/.420ai/credentials.json`                 | CLI pairing (url, token, machineId), `0600`   | no (local state)   |
| `~/.420ai/queue.sqlite`                     | durable capture queue + per-file cursors      | no                 |
| `~/.420ai/connectors.json`                  | which connectors are disabled                 | no                 |
| Windows Credential Manager `ai.420.desktop` | desktop pairing token + server-config secrets | n/a (OS keychain)  |
| repo-root `.env`                            | ingest/db env + secrets                       | no (gitignored)    |
| `apps/desktop/src-tauri/.cargo/config.toml` | OneDrive `target-dir` redirect                | no (machine-local) |
| `apps/desktop/src-tauri/icons/`             | generated icon set                            | no (regenerate)    |

If you're stuck beyond this list, the milestone-by-milestone development notes in the
[README](../../README.md) and the decision log in [`SUMMARY.md`](../../SUMMARY.md) often explain _why_
a piece behaves the way it does.
