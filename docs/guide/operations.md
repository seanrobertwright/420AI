# Operations runbook (M12 12.4)

The "genuinely-production" ops baseline for the self-hosted, single-admin 420AI archive: a
blocking CI gate, backups you can restore from, server logs/metrics, ingest rate limiting, a
safe encryption-key rotation, and a migration rollback path. Everything here is an **ops script
or a one-time setting** — no new long-lived server resource is introduced.

All commands run from the repo root unless noted. Bring the stack up with `npm run db:up`.

---

## 12.4a — CI as a required (blocking) check

`repo-health` (`.github/workflows/repo-health.yml`) runs the full gate on every PR to `main`:
repo-root `tsc -b`, NUL/stray-artifact scans, and the full vitest suite **including** the
Postgres integration layer (`--require-db`, asserts 0 int tests skipped).

The repo is **public**, so branch protection is free. Make `repo-health` blocking once it has
reported on at least one PR:

**UI (recommended):** Settings → Branches → Add branch protection rule for `main` →

- ☑ Require a pull request before merging
- ☑ Require status checks to pass before merging → select **`repo-health`**
- ☑ Do not allow bypassing the above settings

**Scripted equivalent** (the check must have run once so its name is known):

```sh
gh api -X PUT repos/seanrobertwright/420AI/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["repo-health"] },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

Verify: open a throwaway PR with a deliberately failing change → merge is blocked until
`repo-health` is green. (Closes the M8 / PR #7 honor-system gap.)

---

## 12.4b — Server logging & metrics

**Logging.** The ingest server uses structured pino logging at `LOG_LEVEL` (default `info`;
`trace|debug|info|warn|error|fatal`). The `authorization` and `cookie` request headers are
**removed** from every log line (`redact … remove:true`) — a bearer/session cookie never lands
in a log. Example: `LOG_LEVEL=debug npm run ingest:dev`.

**Metrics.** `GET /v1/metrics` is **admin-gated** (service token _or_ a session bearer) and
returns a JSON snapshot — not Prometheus; a single-user box runs no scraper:

```sh
curl -s localhost:8420/v1/metrics -H "authorization: Bearer $API_KEY" | jq
# { "uptimeSeconds": 1234, "requests": 42, "byStatusClass": {"2xx":40,"4xx":2},
#   "ingest": {"recordsInserted":0,"eventsUpserted":0}, "memory": 81000000 }
```

Counters are in-memory and **reset on restart** — `uptimeSeconds` shows the window they cover.

---

## 12.4c — Ingest rate limiting

`@fastify/rate-limit` is registered when rate limiting is enabled (default on). A **strict limit
on `POST /v1/auth/login`** is the brute-force guard (deferred here from 12.3); the global limit
is generous so the ingest hot path isn't throttled in normal single-user use. Tune via env
(see `.env.example`): `RATE_LIMIT_ENABLED`, `RATE_LIMIT_GLOBAL_MAX`, `RATE_LIMIT_WINDOW`,
`RATE_LIMIT_LOGIN_MAX`, `RATE_LIMIT_LOGIN_WINDOW`. Past the login limit the server returns
**429** with a `retry-after` header. Keys are per `request.ip` (fine for self-hosted).

---

## 12.4d — Backups, retention & restore

**Back up** (timestamped, gzipped `pg_dump` via the compose container + retention prune):

```sh
BACKUP_DIR=./backups RETENTION_DAYS=14 npm run backup
# wrote ./backups/420ai-20260620T232959Z.sql.gz
```

`backups/` is gitignored — dumps contain ciphertext **and** plaintext metadata; never commit
them. The prune deletes only this script's own `420ai-*.sql.gz` older than `RETENTION_DAYS`.

**Restore** (DESTRUCTIVE on a populated DB — prefer a scratch DB first):

```sh
npm run restore -- ./backups/420ai-20260620T232959Z.sql.gz
# or verify into a scratch DB:
docker compose exec -T archive psql -U 420ai -c 'CREATE DATABASE scratch;'
gunzip -c ./backups/420ai-<stamp>.sql.gz | docker compose exec -T archive psql -U 420ai -d scratch
docker compose exec -T archive psql -U 420ai -d scratch -c 'select count(*) from raw_source_records;'
```

**Scheduling** (no in-server scheduler — use the OS):

- **Windows Task Scheduler:** a daily task running
  `"C:\Program Files\Git\bin\sh.exe" -lc "cd /c/Users/seanr/OneDrive/Documents/420AI && npm run backup"`.
- **cron (Linux/macOS):** `0 3 * * * cd /path/to/420AI && npm run backup >> backups/backup.log 2>&1`

**Optional row prune (default OFF).** Raw records are **never pruned** (PRD §8.5 "raw sacred").
_Re-buildable_ rows (events, report_artifacts older than N days) MAY be pruned by an operator who
opts in — they re-derive from raw via the §23 replay engine. The in-DB precedent is
`recordHeartbeat` (`packages/db/src/repositories/machines.ts`), which appends then
`delete … where ts < now - retention`. **`raw_source_records` is never pruned.**

---

## 12.4e — Encryption-key rotation

`crypto.ts` is a **keyring**: the keyId rides inside the ciphertext string (`"<keyId>.<base64>"`),
so old and new keys coexist with **no schema change**. A legacy deployment with only
`ARCHIVE_ENCRYPTION_KEY` is byte-for-byte unchanged (un-prefixed ciphertext). To rotate, switch
to keyring env and re-encrypt every row under the new active key.

**Rotation procedure — order matters (never remove the old key before rotation finishes, or
un-rotated rows become undecryptable):**

1. **Back up first:** `npm run backup`.
2. **Add the new key to the keyring and set it active.** Keep the OLD key in the ring:
   ```
   ARCHIVE_ENCRYPTION_KEYS={"legacy":"<old-base64>","v2":"<new-base64>"}
   ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID=v2
   ```
   (Generate a key with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.)
3. **Restart ingest** so it loads the new keyring.
4. **Re-encrypt every encrypted row** under the active key:
   ```sh
   npm run db:rotate-key
   # re-encrypted under the active key: raw_source_records=…, events=…, git_commits=…
   ```
5. **Verify:** a previously-stored session still renders in the dashboard (the decrypt-for-render
   path works), and a second `npm run db:rotate-key` reports all-zero counts (nothing left to do).
6. **Optionally drop the old key** from `ARCHIVE_ENCRYPTION_KEYS` — only AFTER step 5 confirms
   every row is rotated.

`db:rotate-key` **refuses to run in legacy single-key mode** (it throws "keyring mode required")
so a misconfiguration can't silently no-op.

---

## 12.4f — Migration rollback

Drizzle generates up-only SQL. Hand-authored down-migrations live in
`packages/db/drizzle/down/NNNN_*.down.sql` (one per `0000`–`0009`). `db:rollback` reverses the
**single latest-applied** migration: it finds it in Drizzle's `drizzle.__drizzle_migrations`
table, runs the matching down SQL in a transaction, and deletes the tracking row.

```sh
npm run db:rollback     # → "rolled back: 0009_exotic_ben_grimm"
npm run db:migrate      # re-applies it (idempotent)
```

**Down-migration is DESTRUCTIVE** (a `DROP TABLE`/`DROP COLUMN` discards data). **Back up first**
(`npm run backup`) and prefer running it against a scratch/test DB. With no applied migrations,
`db:rollback` prints a reason and exits 1 (it never crashes). To roll back multiple migrations,
run it repeatedly (newest → oldest).

---

## 12.5a — Retroactive re-pricing (archive replay)

Approving a corrected pricing catalog (`POST /v1/catalog/:id/approve`) only re-prices events **as
they are (re-)ingested** going forward — events already in the archive keep the cost they were
priced under at capture time. Retroactive re-pricing applies the **active** catalog to those
existing rows: it walks every cost-bearing event (`cost` + `tokens` + `model` all present),
recomputes `cost = tokens × catalog rate`, and re-stamps `catalog_version`. This makes the
"projections are re-derivable" promise real for `cost` — the projection most likely to need
correcting (PRD §23/§25 12.5).

It is a **pure data pass over `events`**: no decrypt, no re-parse, **raw records and the event
fingerprint are untouched**, and there is no schema change. It only ever _recomputes_ an existing
cost — it never _adds_ a cost to a costless event (`usage.reported`/`message.*` pass through).

**Run it (CLI — for cron/manual ops):**

```sh
npm run db:reprice
# re-priced 42 events under catalog v-2026-06
# a second run prints "re-priced 0 events …" (idempotent)
```

**Or over HTTP** (admin-gated; the dashboard would reach it via the server-side proxy):

```sh
curl -X POST localhost:8420/v1/replay/reprice -H "authorization: Bearer $API_KEY"
# 200 {"repriced":42,"catalogVersion":"v-2026-06"}
# no active catalog → 409; no/invalid bearer → 401
```

**Caveats:**

- **Back up first** (`npm run backup`, 12.4d) — re-pricing overwrites the `cost` column in place.
- It re-prices only when a catalog is **active**. With none active (`409` / the CLI throws), events
  are already at the bundled baseline from capture, so there is nothing to apply.
- An **incomplete uploaded catalog zeroes** the cost of any model it omits (`usd 0`,
  `estimated-model-unknown`) — identical to the going-forward ingest path (the same `computeCost`
  call), which looks up _only_ the active catalog with no fallback to the bundled baseline. Upload a
  complete catalog.
- It is **idempotent** — safe to re-run; rows already at the active version are skipped (so a second
  run reprices 0). Run it after each catalog approval.

---

## 12.7c — Connector catalog management

The **connector catalog** updates connector **metadata + watch locations** (a corrected glob, a new
fidelity label, a tightened/loosened permission scope, an enable/disable, or a whole new data-only
custom connector) **without an app release** — the same signed-and-approved channel as the pricing
catalog, but for connector definitions. Parsers stay in code (PRD §39); the catalog overlays metadata
and locations by connector `id`, and a data-only entry compiles through the custom-connector factory.

Full workflow (sign → upload → approve → collector pull) is in
[`scripts/CATALOG-SIGNING.md`](../../scripts/CATALOG-SIGNING.md#signing--applying-a-connector-catalog-update-m12-127c--prd-104).
In short:

```sh
# 1. sign offline with the CONNECTOR private key (note --connector)
npx tsx scripts/sign-catalog.ts --connector connector-catalog.json --key .secrets/connector-catalog-private-key.pem > signed.json
# 2. upload (admin) → pending; a bad/tampered signature → 400
curl -X POST "$INGEST_URL/v1/connector-catalog" -H "authorization: Bearer $API_KEY" -H "content-type: application/json" -d @signed.json
# 3. approve (admin) → active (prior active atomically superseded)
curl -X POST "$INGEST_URL/v1/connector-catalog/<id>/approve" -H "authorization: Bearer $API_KEY"
```

The collector pulls the active catalog at startup via the **machine-authed** `GET
/v1/connector-catalog/active` (its ingest token), re-verifies the ed25519 signature against the bundled
key, caches it at `~/.420ai/connector-catalog.json`, and overlays it onto the registry.

**Caveats:**

- **No active catalog ⇒ the registry is byte-identical to today** (the bundled
  `CONNECTOR_CATALOG_BASELINE` is the floor). **Offline-first:** a failed pull falls back to the cache,
  then the baseline — capture never blocks.
- A catalog update that **widens** a connector's `watchGlobs`/`requiredPermissions` flips it to
  **`needs-approval`** (the §10.4 capture-surface-change gate, 12.7b) until the user approves it in the
  desktop app. A narrowing/disable needs no approval (a capture-surface reduction).
- The collector **re-verifies** the signature even though the server only serves approved catalogs — a
  tampered local cache file is ignored (defense-in-depth).
- The connector catalog uses a **separate** ed25519 keypair from pricing
  (`.secrets/connector-catalog-private-key.pem`); losing it has the same recovery path as the pricing
  key (regenerate + re-bundle the public PEM + ship).

---

## 12.6 — Alerts & delivery

Operational alerts (PRD §20) are derived on every read of the Live Monitor and persisted as **Alert
Firings** (M10 3c). 12.6 adds **push delivery** of newly-opened firings plus two new conditions.

### Webhook delivery

Set `ALERT_WEBHOOK_URL` and the ingest server POSTs the firing JSON to it the moment a firing newly
opens (a Slack/Discord/n8n/email-bridge target). The body is `{"kind":"alert.firing","firing":{…}}`.

```sh
ALERT_WEBHOOK_URL=https://hooks.example.com/420ai
ALERT_WEBHOOK_TIMEOUT_MS=5000   # optional; per-delivery timeout, defaults to 5000
```

- **Disabled by default** — unset `ALERT_WEBHOOK_URL` and delivery is off (no behavior change; the
  firing still appears in the dashboard). The dashboard firing is the **durable record**; the webhook
  is a convenience notification.
- **At-most-one ATTEMPT per firing.** `alert_firings.delivery_attempted_at` is stamped on success OR
  failure, so a misconfigured/dead webhook is never retried on the 3 s monitor tick. (Retry-with-cap is
  a future option.) **Open-only**: a firing that opens and resolves within one tick is not delivered.
- **No new background loop** — delivery rides the existing evaluate-on-read reconcile (a webhook
  problem never 500s `GET /v1/monitor` or breaks the SSE stream; it is logged and swallowed).

### New §20 conditions

- **`ingest.auth_failure`** (global warning) — fires when **≥3** invalid/revoked-token ingest attempts
  occur within **15 min** (a revoked collector still POSTing, or a probe). Each 401 records an
  `ingest_auth_failures` row (best-effort — recording never alters the 401); the count is windowed and
  resolves as failures age out.
- **`archive.unreachable`** (per-machine warning) — fires when a collector reports **≥3 consecutive
  sync failures** (it can reach ingest but its batch POSTs keep failing). The collector's sync worker is
  the only component that observes this, so the count rides the heartbeat. **Suppressed when the machine
  is offline** (`collector.offline` already covers a total outage), and back-compat with older collectors
  that don't send the field (treated as 0).

**Deferred → 12.6b:** the windowed connector-failure _rate_ (the existing `connector.failing` stays a
lifetime ratio), SMTP/email delivery, and deliver-on-resolve.

---

## 12.8 — Export, restore & releases

The final M12 slice: three independent "polish" capabilities — a Parquet export format, a
restore-from-backup button in the desktop app, and desktop auto-update via GitHub Releases.

### Parquet events export

The events export (`GET /v1/exports/events`) now offers **`format=parquet`** alongside
`json`/`jsonl`/`csv` — a binary, columnar, SNAPPY-compressed file that loads natively into DuckDB,
pandas, or Spark. It is the **same flattened, redacted row schema as CSV** (`EVENT_CSV_COLUMNS`); the
export manifest rides the `X-Export-*` response headers exactly as it does for CSV (the binary stays a
pure event table). Parquet is **events-only** — the report and transcript exports are document-shaped
and stay text (`md`/`json`/`jsonl`).

```sh
curl -s -H "authorization: Bearer $API_KEY" \
  "$INGEST_URL/v1/exports/events?format=parquet&projectId=<uuid>" -o events.parquet
# then, in DuckDB:  SELECT count(*) FROM 'events.parquet';
```

The dashboard **Export** panel offers **Parquet** in the events format dropdown; the download proxies
through the same server hop (no token in the browser) and streams the `.parquet` bytes verbatim.

### Restore from the desktop (12.8b)

The desktop **Settings → Server stack → Restore from backup** field takes the absolute path to a
`420ai-<stamp>.sql.gz` backup (produced by [`scripts/backup-archive.sh`](../../scripts/backup-archive.sh))
and, **after a confirm**, overwrites the live archive — the same flow as
[`scripts/restore-archive.sh`](../../scripts/restore-archive.sh), driven from the UI. Rust decompresses
the gzip **in-process** (a corrupt/truncated archive is rejected before a single SQL statement runs, so
a partial restore is impossible) and streams the plain SQL into `psql` inside the compose `archive`
container — no host `gunzip`/`sh` is required (Windows-safe).

> **The restore OVERWRITES the current archive.** It is a direct restore after a single confirm. For
> maximum safety on a populated DB, restore into a **scratch database** first to verify, via the CLI
> `sh scripts/restore-archive.sh <backup.sql.gz>` (point it at a throwaway DB) — then promote. The UI
> path is the convenience flow for the single-admin self-hosted case.

The dashboard (browser) deliberately offers **no** restore — it has no shell/Docker access. Restore
lives only in the Tauri desktop app, which already supervises the stack.

### Releasing a desktop update (12.8c)

The installed desktop app checks **GitHub Releases** on launch, verifies the update payload against a
baked-in **updater public key**, downloads, and relaunches. This updater key is Tauri's **own free
minisign-style key** (`tauri signer generate`) — **NOT** an OS Authenticode/code-signing cert. CA code
signing and MSI/WiX are **parked**; the first install is still an unsigned-by-CA NSIS (Windows
SmartScreen warns once), but auto-update works regardless via the updater key.

**One-time setup — generate the updater signing key:** see "13.1 — Updater signing key (one-time
ceremony)" below. Losing the private key means existing installs will reject all future updates —
back it up.

**Cut a release:**

```sh
# 1. bump the version in BOTH apps/desktop/src-tauri/tauri.conf.json and Cargo.toml (e.g. 0.1.0 → 0.1.1)
# 2. export the signing key so the build emits a .sig next to the installer
export TAURI_SIGNING_PRIVATE_KEY="$(cat .secrets/tauri-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<the password from the key ceremony, or empty if none>"
# 3. build the NSIS bundle (+ updater artifacts, since bundle.createUpdaterArtifacts is true)
npm run build:desktop
# → …/release/bundle/nsis/420AI Collector_0.1.1_x64-setup.exe  AND  …_x64-setup.exe.sig
```

**Author `latest.json`** (the shape the updater fetches — paste the `.sig` content and the
release-asset download URL):

```json
{
  "version": "0.1.1",
  "notes": "…",
  "pub_date": "2026-06-21T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<CONTENT of the _x64-setup.exe.sig file>",
      "url": "https://github.com/seanrobertwright/420AI/releases/download/v0.1.1/420AI.Collector_0.1.1_x64-setup.exe"
    }
  }
}
```

**Publish** (the `latest.json` asset is what the configured `…/releases/latest/download/latest.json`
endpoint resolves to):

```sh
gh release create v0.1.1 "<path to _x64-setup.exe>" latest.json \
  --title "420AI Collector 0.1.1" --notes "…"
```

A running older install detects the newer release on next launch, verifies the signature against the
baked pubkey, installs (passive NSIS), and relaunches. A **tampered** `latest.json`/installer fails the
signature check and is rejected — the app starts normally on the current version.

> **Parked (not built):** CA/Authenticode code signing, MSI/WiX, and a CI release workflow
> (`tauri-action`). The manual `gh release create` runbook above is the validated release path.

---

## 13.1 — Updater signing key (one-time ceremony)

The maintainer's manual, one-time action that makes the desktop auto-updater (12.8c) able to verify
release payloads. Do this once per signing identity, then keep the private key forever (losing it
means every existing install rejects all future updates — no recovery, only re-issue-and-re-install).

1. **Generate the keypair** (`cargo tauri` must run from `apps/desktop`, but the key is written to
   the repo-root `.secrets/` — the same home as every other signing key here — so steps 3 and 4
   below, like the rest of this file, can stay on the "run from the repo root" convention):
   ```sh
   cd apps/desktop
   cargo tauri signer generate -w ../../.secrets/tauri-updater.key --ci
   ```
   `.secrets/` is already gitignored — the same home as the connector-catalog signing key
   (`.secrets/connector-catalog-private-key.pem`). This writes the PRIVATE key to
   `.secrets/tauri-updater.key` (repo root) and prints the PUBLIC key to stdout.
2. **Paste the printed PUBLIC key** into `apps/desktop/src-tauri/tauri.conf.json` →
   `plugins.updater.pubkey`, replacing the `REPLACE_WITH_TAURI_UPDATER_PUBKEY` placeholder. This
   file is committed — the public key is safe to ship.
3. **Build releases with the private key in env** (never committed):
   ```sh
   export TAURI_SIGNING_PRIVATE_KEY="$(cat .secrets/tauri-updater.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""   # empty if --ci generated one with no password
   ```
   `bundle.createUpdaterArtifacts: true` (already set in `tauri.conf.json`) makes `cargo tauri build`
   emit the `.sig` files the 12.8c release runbook publishes alongside `latest.json`.
4. **Verify before committing anything:** `git check-ignore .secrets/tauri-updater.key` must exit 0
   — the private key must never be trackable, even accidentally.

---

## 13.6 — Scheduled reports (opt-in)

Report generation is **manual by default** (the dashboard button, or a single POST). To generate
the full report suite on a schedule, run `scripts/generate-reports.mjs` from the OS scheduler —
there is **NO in-server scheduler** (the same discipline as backups above: the server owns no
background dispatch loop).

`npm run reports:generate` walks every project (`GET /v1/projects`) and POSTs one report of each
project type (`POST /v1/projects/:id/reports`) authenticated with an **API key** (`API_KEY`) — the
machine/service credential (12.3), which is exactly the machine-to-machine path it exists for. It
reads `INGEST_URL` + `API_KEY` from the environment, **times every request out at 30 s** so a
stalled ingest can't hang the job, prints one line per artifact, and **exits non-zero if any call
fails** (so a cron wrapper can alert).

```sh
# all six project report types, every project:
INGEST_URL=http://localhost:8420 API_KEY=<k420_...> npm run reports:generate
# a subset and/or a single project (note the `--` so npm forwards the flags):
npm run reports:generate -- --types project.efficiency,project.cost_over_time --project <uuid>
```

Generation is **non-idempotent by design** — each run appends a new versioned artifact (the inverse
of the event-fingerprint upsert), so report history accrues. Schedule it via the OS, exactly like
backups (12.4d):

- **Windows Task Scheduler:** a weekly task running
  `"C:\Program Files\Git\bin\sh.exe" -lc "cd /c/Users/seanr/OneDrive/Documents/420AI && INGEST_URL=http://localhost:8420 API_KEY=<k420_...> npm run reports:generate"`.
- **cron (Linux/macOS):**
  `0 6 * * 1 cd /path/to/420AI && INGEST_URL=http://localhost:8420 API_KEY=<k420_...> npm run reports:generate >> reports.log 2>&1`

## 15.3 — Application role & Row-Level Security

M15 15.3 adds a **database-enforced** tenant-isolation backstop. Two things changed operationally:
there is now a **second Postgres role**, and the ingest server **refuses to start** without a
connection string for it.

### Why a second role exists (this is not optional hardening)

Postgres RLS is **inert** against a superuser or any role with `rolbypassrls` — and that is exactly
what `DATABASE_URL` connects as, because it owns the tables. Adding policies alone changes nothing.
`ALTER TABLE … FORCE ROW LEVEL SECURITY` does **not** help either: FORCE removes the _table-owner_
exemption, which is a **different exemption from the superuser one**, with a different switch.

So the isolation only becomes real when the server connects as a **non-owner role without
`rolbypassrls`**. That role is `420ai_app`.

| Variable                | Role                    | Used by                                                                                       |
| ----------------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | `420ai` (owner)         | every `db:*` CLI — migrate, rollback, reprice, reparse, rotate-key — and the break-glass path |
| `DATABASE_URL_APP`      | `420ai_app` (non-owner) | **the ingest server**, and nothing else                                                       |
| `DATABASE_URL_TEST`     | owner                   | integration-test setup (`TRUNCATE` needs ownership)                                           |
| `DATABASE_URL_TEST_APP` | non-owner               | the two-role RLS suites — the only tests that exercise the policies                           |

Both `DATABASE_URL` and `DATABASE_URL_APP` are required. Do **not** repoint the CLIs at the app
role: migrations create and own objects, which a non-owner cannot do.

### Provisioning

Migration `0015` creates the role `NOLOGIN` and grants it table privileges — the _schema_ half. It
deliberately does **not** set a password (a migration file is committed to git; a secret in one is a
secret in the repo forever). The _credential_ half is a separate command:

```sh
npm run db:migrate              # creates the role NOLOGIN + grants + the 15 policies
npm run db:provision-app-role   # grants LOGIN and sets the password from APP_DB_PASSWORD
```

`npm run setup` generates `APP_DB_PASSWORD` and substitutes it into both app-role URLs, so a fresh
clone only needs the two commands above. Verify:

```sh
docker exec 420ai-archive psql -U 420ai -d 420ai -t -c \
  "select rolcanlogin, rolbypassrls, rolsuper from pg_roles where rolname='420ai_app';"
# → t | f | f     (can log in; CANNOT bypass RLS; not a superuser)
```

`t | f | f` is the only acceptable result. A `t` in either of the last two columns means every
policy is decorative.

### Password rotation

`provisionAppRole` is idempotent, so rotation is a re-run:

1. Set a new `APP_DB_PASSWORD` in `.env`.
2. `npm run db:provision-app-role`.
3. Update `DATABASE_URL_APP` (and `DATABASE_URL_TEST_APP`) to match — `npm run setup` keeps them in
   sync on a fresh clone, but an edited `.env` must be updated by hand.
4. Restart ingest.

The password is never logged: the CLI prints only `provisioned app role: 420ai_app (LOGIN enabled)`.

### Migrating an EXISTING database

The role is per-cluster but the **grants are per-database**, so every database needs the migration
applied — including the test database, which `npm run db:migrate` does not touch:

```sh
npm run db:migrate
DATABASE_URL=$DATABASE_URL_TEST npm run db:migrate
npm run db:provision-app-role
```

### What the policies do

Fifteen tables carry a policy keyed on a transaction-local setting, `app.current_org`, which the
server sets via `withOrg` at the start of every request's DB work:

- **12 STRICT tables** (`events`, `raw_source_records`, `projects`, `workspaces`, `workspace_keys`,
  `report_artifacts`, `git_commits`, `git_commit_files`, `session_git_links`, `machine_heartbeats`,
  `alert_firings`, `search_documents`) — with no context set, a read returns **zero rows**. Not an
  error: a backstop must fail closed and quiet.
- **3 BOOTSTRAP-PERMISSIVE tables** (`machines`, `ingest_tokens`, `pairing_codes`) — enforced when a
  context is set, permissive when it is not. These are the credential tables, and the lookups that
  read them are _circular_: `POST /v1/pair` reads a pairing code **in order to discover** the org,
  so there is no org to set beforehand. A strict policy here would 401 every collector.
- **No policy** on `users` / `organizations` / `memberships` (the identity tables org resolution
  itself reads) or `pricing_catalogs` / `connector_catalogs` / `ingest_auth_failures`
  (deployment-global, no `org_id` column).

RLS **backstops** application scoping; it does not replace it. Every query still carries its
explicit `org_id` predicate, and that is load-bearing for performance as well as correctness: with
the explicit predicate the planner collapses the policy to a one-time filter rather than evaluating
it per row (measured: +10–20 % on a ~16 ms aggregate over 413 k events, index usage unchanged).
Removing the predicate "because RLS handles it now" is both a correctness and a performance
regression.

### Break-glass (D-M15-7)

There is **no HTTP god-token** and no privileged connection anywhere in the server — deliberately,
and as of **M15 15.9 that is now literally true**: `ADMIN_TOKEN`, the last credential that behaved
like one, has been removed. No bearer token grants cross-org access, and none can be minted: an API
key is capped at its owner's rung inside a single org (D-15.9-4), and so is a session.

Cross-org access therefore requires **direct database access with the owner URL** — never an HTTP
credential:

```sh
docker exec -it 420ai-archive psql -U 420ai -d 420ai
```

The owner role bypasses RLS, so this sees everything. Treat it as the audited emergency path it is:
take a backup first (12.4d), and prefer a read-only query over a mutation.

**Do not try to reconstruct an admin bearer as a shortcut.** If you are locked out of the UI, the
supported recovery is to set `ADMIN_PASSWORD` in `.env` and restart — the boot seed re-hashes it onto
the `ADMIN_EMAIL` user (`server.ts`) — then log in and mint a key. Re-introducing a shared token
would give back exactly the four properties 15.9 removed: un-attributable, un-revocable, un-expiring,
always `owner`.

### Troubleshooting

| Symptom                                                    | Cause                                                                                                                                                                                                |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ingest exits at startup with `DATABASE_URL_APP is not set` | The var is missing. This is intentional (D-15.3-2) — booting on the owner role would leave RLS inert while every health check stayed green.                                                          |
| Every endpoint returns empty/zeroed data                   | The org context is not being set — a handler is missing its `withOrg`, or the app role is connecting without one. `apps/ingest/src/routes/org-scoping.test.ts` catches the first case.               |
| `password authentication failed for user "420ai_app"`      | `DATABASE_URL_APP` and `APP_DB_PASSWORD` disagree. Re-run `npm run db:provision-app-role` after aligning them.                                                                                       |
| `permission denied for table <x>`                          | The migration was applied to a different database than the one being connected to, or a new table was created by a role other than `420ai` (the `ALTER DEFAULT PRIVILEGES` grant follows the owner). |
| A maintenance op reports `{repriced: 0}`                   | The deployment-wide ops iterate per org (D-15.3-5). A zero here means `listOrganizations` returned nothing, not that RLS blocked the pass.                                                           |

## 15.4 — Roles, permissions & the write backstop

M15 15.4 makes `memberships.role` load-bearing. Until this slice every authenticated caller had
full admin power over their org; a `viewer` could `POST /v1/replay/reparse` and rewrite the archive.

### The four roles

They form an **ordered ladder** (`packages/shared/src/roles.ts`), so gates express "admin or
better" as a rank comparison rather than enumerating roles — the form that silently omits `owner`
when someone adds a rung.

| Role     | May do                                                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viewer` | **Read everything in the org** — monitor, projects, sessions, reports, search, exports, workspaces, connector health, the catalogs. No writes at all.                               |
| `member` | Everything a viewer may, **plus ordinary work**: create/rename projects, remap workspaces, generate reports and AI interpretations, ack alerts, manage git links.                   |
| `admin`  | Everything a member may, **plus deployment administration**: upload/approve/reject catalogs, issue pairing codes, replay re-price and re-parse, search re-index, `GET /v1/metrics`. |
| `owner`  | Everything an admin may. Created automatically for the user an org is seeded around (`ensurePersonalOrg`).                                                                          |

Two rules follow from D-15.4-2 and are worth stating plainly:

- **Org membership is open-by-default.** Every member of an org sees every machine, project,
  workspace, session and commit in that org. The reads are scoped by `org_id`, not by `user_id` —
  a colleague's machines appear in your monitor.
- **Project grants only ever ELEVATE.** A `project_grants` row raises one user's capability on one
  project; effective role = `max(org role, grant role)`. A grant below the org role is a no-op,
  never a demotion. A solo install holds zero grant rows and behaves exactly as it did before 15.4.

Anything a role may not do returns **403 `{"error":"insufficient role"}`** — never a 404, and
never a silent no-op. The dashboard renders it as "You do not have permission to do this."

### The RLS write backstop (`app.current_role`)

`withOrg(db, orgId, role, fn)` sets a **second** transaction-local alongside `app.current_org`:

```sql
SELECT set_config('app.current_role', $1, true);   -- SET LOCAL semantics, bound parameter
```

Migration `0016` adds **39 RESTRICTIVE policies** (13 tenant tables x INSERT/UPDATE/DELETE) that
read it. Restrictive policies combine with `AND`, permissive ones with `OR`, so these sit _behind_
15.3's org policies without modifying any of them.

Three operational facts you need before debugging anything here:

1. **A blocked INSERT or UPDATE is LOUD** — `new row violates row-level security policy`. Both put
   the role test in `WITH CHECK`.
2. **A blocked DELETE is SILENT** — `DELETE 0`, no error. Postgres has no `WITH CHECK` for DELETE,
   so this is unavoidable. **The route gate is the only loud layer for deletes**; the backstop is
   genuinely a backstop, not a substitute for a complete gate.
3. **An UNSET role is PERMISSIVE.** The policies `coalesce(..., 'member')`, so a context with no
   role still writes. That is deliberate: machine-authed collector writes and the deployment-wide
   maintenance ops have no principal and pass the `SERVICE_ROLE` sentinel, and failing closed here
   would 500 every ingest. Strictness lives at the route layer, which fails closed on any role it
   does not recognise.

There is deliberately **no restrictive policy on SELECT**: a viewer is entitled to read their own
org, so a role predicate there would buy nothing the org policy does not already give while making
every read more expensive.

### `SERVICE_ROLE`: writes that belong to the ORG, not the caller

Three paths pass `SERVICE_ROLE` rather than `principal.role`, and each is load-bearing:

| Path                                          | Why                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Collector ingest / heartbeat / git / discover | No request principal exists — the caller is a machine bearing a machine token.                                                                                                                                                                                                                               |
| Replay + re-index per-org loops               | Deployment-wide maintenance, already gated at `admin` at the route.                                                                                                                                                                                                                                          |
| The monitor snapshot **and** alert delivery   | Evaluate-on-read means a `GET` performs a WRITE. That write is the org's bookkeeping, triggered by whoever happened to open the dashboard. Under `principal.role` a viewer's `GET /v1/monitor` would **500**, and every webhook and email would silently stop for an org whose only active user is a viewer. |

### Connector approval is NOT org RBAC (D-15.4-5)

Audit item B.7 asked whether connector capture-surface approval should be role-gated. It should
not, and this is a decision rather than an omission. Approval is entirely collector-**local**: it
is driven by `connectors.approve` over the M11 desktop control protocol, **there is no HTTP
approval endpoint**, and it is a machine-local trust decision made by whoever physically runs that
machine — the same person who could edit `~/.420ai/connector-config.json` directly or repoint the
collector with `--home`. Gating it on an org role would refuse someone who already holds the
filesystem. Recorded in the header of `apps/collector/src/connectors/connector-approvals.ts` too.

### Alert reconcile throttle

The monitor's evaluate-on-read reconcile is a WRITE, and 15.3 made every SSE tick a transaction —
so before this slice a single connected dashboard produced that write every
`monitorStreamIntervalMs` (default 3 s), forever, per org. It is now throttled to at most once per
`reconcileThrottleMs` (default **30 000**) per `(org, user)`; in between, the snapshot serves the
persisted firing list. **The emitted frame is identical in shape either way.** Set it to `0` to
restore pre-15.4 behaviour (every tick reconciles) — that is what the integration suites inject.

### Troubleshooting

| Symptom                                                   | Cause                                                                                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A user gets `403 {"error":"insufficient role"}`           | Their `memberships.role` is below the endpoint's minimum. Check with `select u.email, m.role from users u join memberships m on m.user_id = u.id`.                                                |
| A hand-edited role like `superadmin` grants nothing       | `hasRole` fails CLOSED on any unrecognised string. Note the asymmetry: the RLS backstop only asks "is this a viewer?", so the same row IS permitted to write at the database layer.               |
| A delete "worked" but nothing changed                     | A blocked DELETE is `DELETE 0` with no error. Check the route's `authorized(...)` gate — the backstop cannot make this loud.                                                                      |
| `withOrg requires a non-empty role`                       | A caller passed `""`. Machine paths must pass `SERVICE_ROLE` explicitly; a blank role would be coalesced to the permissive default.                                                               |
| A user has two memberships and resolves to the wrong role | `findPrincipalByEmail` takes the FIRST by `(created_at, id)`. `setUserPassword` auto-creates a personal `owner` membership, so **move** an invited user's membership rather than adding a second. |
| A viewer's `GET /v1/monitor` 500s                         | The snapshot's reconcile write is running under `principal.role` instead of `SERVICE_ROLE`. See the table above.                                                                                  |

## 15.6 — Sessions & revocation

Sessions are **server-side rows** as of migration `0018` (D-M15-12). Before it, a session was a
stateless HMAC with no record anywhere, so the only way to invalidate one was rotating
`SESSION_SECRET` — which signs out every user on the deployment at once.

**Rotating `SESSION_SECRET` is no longer the revocation mechanism.** Use the endpoints:

```bash
# list your live sessions. Returns:
#   {"sessions":[{"id":"…","createdAt":"…Z","expiresAt":"…Z","userAgent":"…","current":true}]}
curl.exe -s localhost:8420/v1/auth/sessions -H "Authorization: Bearer $TOKEN"

# sign one device out → 204. 404 if the id is unknown OR not yours (deliberately
# indistinguishable, so this is not an enumeration oracle); 400 if it is not a UUID.
curl.exe -s -X DELETE localhost:8420/v1/auth/sessions/<id> -H "Authorization: Bearer $TOKEN"

# end the current session        → 204 (204 for an API-KEY caller too: nothing to revoke)
curl.exe -s -X POST localhost:8420/v1/auth/logout -H "Authorization: Bearer $TOKEN"

# sign out EVERYWHERE, this device included → 200 {"revoked": n}
curl.exe -s -X POST localhost:8420/v1/auth/sessions/revoke-all -H "Authorization: Bearer $TOKEN"
```

Revocation also happens automatically, at three triggers:

| Trigger                                | Scope                           | Why                                                                                                               |
| -------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `POST /v1/auth/password-reset/confirm` | **All** sessions, sparing none  | OWASP Forgot-Password. The caller is unauthenticated and the flow exists because someone else may hold a session. |
| `POST /v1/auth/password` (change)      | All **except** the caller's own | The caller just re-proved their current password; logging them out of that tab is a tax with no security gain.    |
| `DELETE /v1/members/:userId`           | All of the removed member's     | In the same transaction as the membership delete.                                                                 |

**An open Live Monitor stream dies too.** `GET /v1/monitor/stream` holds its socket open and serves
snapshots on a timer, so a connect-time check alone would have kept streaming to a revoked — or
removed — user indefinitely. It now re-checks the session every tick and tears the stream down with
an `event: error` frame carrying `{"error":"session revoked"}`, within roughly one poll interval.
API-KEY streams are **not** exempt: they carry no session row, so the tick re-checks the KEY
instead (`isApiKeyLive`) and terminates the stream with `api key revoked`. M15 15.9 closed that gap —
the old `ADMIN_TOKEN` exemption was safe only because that tier could not be revoked at all.

`PATCH /v1/members/:userId` (a role change) deliberately does **not** revoke: `role` is re-resolved
from `memberships` on every request, so a demotion is already live on the target's next call.

**Rotating `ADMIN_PASSWORD` does NOT revoke** — the one credential change that cannot. The boot-time
seed re-hashes on every restart, and scrypt re-salts each time, so the server cannot tell a rotation
from an ordinary restart; revoking there would sign the admin out on every boot. If you are rotating
because the password LEAKED, call revoke-all explicitly afterwards:

```bash
TOKEN=$(curl.exe -s localhost:8420/v1/auth/login -H 'content-type: application/json'   --data-binary @login.json | jq -r .token)
curl.exe -s -X POST localhost:8420/v1/auth/sessions/revoke-all -H "Authorization: Bearer $TOKEN"
```

### Upgrading to 0018 signs everyone out, once (D-15.6-5)

A token minted before 0018 has no `sid` claim, and it is **rejected rather than grandfathered**. A
grace period would be a window in which revocation silently does not apply, which is the one failure
this slice exists to remove. Expect every logged-in user to log in again after the upgrade; nothing
else is affected, and no account, org or membership is touched.

**Rolling `0018` back is NOT the same cost in the other direction**, and the difference matters.
It drops the table and with it every revocation record — the pre-0018 verifier never looks a session
up, so tokens keep authenticating and **any session you had revoked becomes live again**. Nobody is
signed out. Roll the CODE back with it: 15.6 code against a dropped `sessions` table makes
`findLiveSession` query a missing relation, so every authenticated request 500s.

### The dashboard-shell residual (D-15.6-4) — real, and named on purpose

`apps/dashboard/src/middleware.ts` verifies the session cookie's MAC on the **Edge runtime, with no
database access**, so it _cannot_ see revocation. It remains a MAC+expiry UX gate.

**Consequence:** for up to 7 days (the token TTL) a revoked-but-unexpired cookie still renders the
dashboard **shell**, while **every data fetch through it 401s from ingest**. The user sees a
logged-in-looking page with errors instead of a redirect to `/login`.

This is deliberate. The security boundary is ingest, not Next: no data is served. Closing the gap
would mean calling ingest from middleware — a network hop on **every navigation** — for no security
gain. Do not "fix" the middleware. If the user-visible behaviour matters for a deployment, the lever
is a shorter session TTL — which today means editing `SESSION_TTL_SECONDS` in
`apps/ingest/src/session.ts` and restarting. It is deliberately **not** an env var yet, so do not go
looking for it in `.env.example`.

### Troubleshooting

| Symptom                                                          | Cause                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everyone was signed out after a deploy                           | Expected once, immediately after `0018`. Pre-0018 tokens carry no `sid` and are rejected (D-15.6-5).                                                                                                                                                                                                                 |
| The dashboard renders but every panel errors                     | The D-15.6-4 residual: the cookie's MAC is still valid, its session row is not. Log out and back in; the cookie expires on its own within 7 days.                                                                                                                                                                    |
| `DELETE /v1/auth/sessions/:id` returns 404 for an id you can see | It belongs to another user. The route collapses "unknown" and "not yours" so it cannot become an enumeration oracle.                                                                                                                                                                                                 |
| An API-KEY caller's session list looks wrong                     | A key has no session row of its own (D-15.9-5), so nothing is flagged `current`. Any rows listed are the key OWNER's own browser logins — empty unless that human has also used `/v1/auth/login`. Its `logout` is a no-op 204 and deliberately does NOT revoke the key; use `DELETE /v1/auth/api-keys/:id` for that. |

### Session rows are never purged (known residual, deliberate for 15.6)

A `sessions` row is **stamped**, never deleted — revocation sets `revoked_at`, and expiry is a
predicate rather than a cleanup. So the table grows by one row per login, forever.

That is intentional at this slice: revocation history is the audit trail 15.10's audit table will
want, `findLiveSession` is a primary-key probe (growth costs nothing on the hot path), and
`listSessions` filters to live rows, so nothing user-visible degrades. For a self-hosted deployment
the volume is negligible.

If a deployment ever needs it, the purge is a one-liner and safe to run at any time — a row past its
`expires_at` can never authenticate again:

```sql
DELETE FROM sessions WHERE expires_at < now() - interval '30 days';
```

## 15.7 — SSO (Google + GitHub)

Sign-in with Google or GitHub, for **identity only**. No repository or API scopes are requested and
**no provider access or refresh token is stored** (D-15.7-5) — 420AI never calls a provider on your
behalf after the login completes.

SSO is **off** until you configure it, and configuring it does not by itself let anyone in.

### Registering the two OAuth apps

Register each app with the **exact** redirect URI below, substituting your `APP_BASE_URL`. A
mismatch here is the most common setup failure and the provider reports it on its own error page
before 420AI is ever contacted.

| Provider | Where                                                                                 | Redirect URI                                  |
| -------- | ------------------------------------------------------------------------------------- | --------------------------------------------- |
| Google   | Google Cloud console → APIs & Services → Credentials → OAuth client (Web application) | `<APP_BASE_URL>/api/auth/sso/google/callback` |
| GitHub   | GitHub → Settings → Developer settings → OAuth Apps                                   | `<APP_BASE_URL>/api/auth/sso/github/callback` |

Scopes are fixed in code and need no configuration: Google gets `openid email`, GitHub gets
`read:user user:email` (the second is required to read the _verified_ flag, which is not on
`/user`).

### Environment

These are read by the **ingest** process, from the repo-root `.env` (`apps/ingest/src/server.ts`) —
**not** by the dashboard. Putting them in `apps/dashboard/.env.local` (which the setup script does
write, see the quickstart) has no effect at all: you get no provider buttons, no error and no log
line. `APP_BASE_URL` must likewise be set for **ingest**, because the OAuth `redirect_uri` is
derived there.

```bash
SSO_GOOGLE_CLIENT_ID=
SSO_GOOGLE_CLIENT_SECRET=
SSO_GITHUB_CLIENT_ID=
SSO_GITHUB_CLIENT_SECRET=
SSO_SIGNUP_ENABLED=false   # literal "true" to allow SSO to CREATE accounts
SSO_TIMEOUT_MS=10000
```

A provider is live only when **both** halves are set; a client id with no secret is treated as
absent rather than failing later at the token exchange. `GET /v1/auth/sso/providers` reports which
came up configured, and the login page renders exactly those buttons.

`redirect_uri` is derived server-side from `APP_BASE_URL` (D-15.7-6) and is not accepted from any
request. If your dashboard moves origin, update `APP_BASE_URL` **and** both OAuth app registrations.

### `SSO_SIGNUP_ENABLED` is its own flag, and it is off by default

It is deliberately **separate** from `SELF_SIGNUP_ENABLED` (D-15.7-7), so you can say "anyone with a
company Google account may self-provision, password signup stays shut" — or the reverse. With it
off, a new person arrives through SSO only by accepting an invitation: send the invite as usual and
they may redeem it with a provider login instead of choosing a password, provided the provider's
**verified** address matches the invited one.

Turning it on means anyone with a verified account at a configured provider can create an account
here. The server warns loudly at boot when it is on, naming the live providers.

### An existing account is NEVER adopted — this is the behaviour, not a bug

If someone signs in with Google using an address that **already has a 420AI account**, the login is
refused with **409 `link_required`** — no session is minted and no link is written — even though the
provider verified the address. The dashboard says "That address already has a 420AI account. Sign in
with your password, then connect the provider from Settings."

This is the point of the slice (D-15.7-4). The alternative — "look the user up by the email the
provider asserts, log them in" — is an account-takeover primitive against this product specifically:
**no `users` row here has a verified email**. Self-signup sends no verification mail, and rows
pre-seeded by pairing were never verified at all, so auto-adoption would turn any stale row into a
live account for whoever controls that mailbox at a provider.

The supported path is to **link deliberately**:

1. Sign in the way you already can (password).
2. **Settings → Single sign-on → Connect** next to the provider.
3. Sign out. The provider button now signs you in as the same account.

After linking, the login resolves on the provider's immutable user id, not the email — so changing
your address at Google does not break it, and nobody can inherit your account by acquiring a
released username.

### Disconnecting, and the lockout guard

`Disconnect` refuses with **409 `last_credential`** when it would remove the only way into an
account — an SSO-created user has no password at all. Set a password first (or connect a second
provider). If you are already locked out, the ordinary password-reset flow still works and requires
control of the mailbox.

> **Password reset needs a mail transport, and without one an SSO-created user has NO recovery
> path.** `POST /v1/auth/password-reset` answers **503** when neither `SMTP_URL`/`MAIL_FROM` nor the
> 13.5 fallbacks `ALERT_SMTP_URL`/`ALERT_EMAIL_FROM` are set — and `.env.example` ships all four
> empty. Since `SSO_SIGNUP_ENABLED=true` creates users with `password_hash IS NULL`, **configure
> SMTP before enabling it**, or an account whose only provider link is lost cannot be recovered
> through any supported flow.

### Troubleshooting

| Symptom                                                       | Cause                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No provider buttons on the login page                         | Neither provider has **both** its id and secret set (check `GET /v1/auth/sso/providers`) — **or** the dashboard cannot reach ingest. The proxy returns an empty list on any failure so the password form still renders, so a down archive looks identical to no configuration. Check `INGEST_URL` and curl ingest directly; the dashboard logs the failure. |
| Only one provider appears, and the other's variables look set | Only one half of its pair is set. Ingest logs `only one half is set — … SSO is DISABLED` at boot.                                                                                                                                                                                                                                                           |
| `?error=sso_unavailable`                                      | The start hop failed: the provider is unconfigured (404) or ingest is unreachable. The most common first-run symptom.                                                                                                                                                                                                                                       |
| `?error=sso_denied`                                           | The user cancelled at the provider's consent screen.                                                                                                                                                                                                                                                                                                        |
| `?error=config`                                               | `SESSION_SECRET` is unset on the **dashboard**, so the session cookie could never be verified. Logged server-side.                                                                                                                                                                                                                                          |
| `?error=unreachable` / `?error=failed`                        | The callback could not reach ingest, or ingest answered without a typed reason (e.g. a 502 because the provider hop failed).                                                                                                                                                                                                                                |
| `?ssoError=identity_taken` on Settings                        | That provider account is already linked to a different 420AI user.                                                                                                                                                                                                                                                                                          |
| `409 link_required` on every SSO login                        | Working as designed — that address already has an account. Sign in and link from Settings.                                                                                                                                                                                                                                                                  |
| `403 signup_disabled` for a brand-new address                 | `SSO_SIGNUP_ENABLED` is not the literal string `true`. Invite the person instead, or turn it on.                                                                                                                                                                                                                                                            |
| `403 email_unverified`                                        | The provider has not verified the address. On GitHub the **primary** address must be the verified one — a verified secondary does not count.                                                                                                                                                                                                                |
| `409 invite_mismatch`                                         | The invitation was issued to a different address than the provider vouches for. The invite is left unspent.                                                                                                                                                                                                                                                 |
| Redirected to `/login?error=sso_state`                        | The flow cookie expired (10 minutes), was blocked, or the `state` did not match. Start again.                                                                                                                                                                                                                                                               |
| The provider's own error page, before reaching 420AI          | The registered redirect URI does not match `<APP_BASE_URL>/api/auth/sso/<provider>/callback`.                                                                                                                                                                                                                                                               |
| `502` from the callback                                       | The provider was unreachable or timed out (`SSO_TIMEOUT_MS`).                                                                                                                                                                                                                                                                                               |

### Rolling back migration 0019

The down-migration **drops `sso_identities`**, discarding every provider link. Users with a password
are unaffected; an SSO-created user (`password_hash IS NULL`) must recover through password reset.
No `users`, `memberships` or `sessions` row is touched, and links must be re-established after
rolling forward again. The same SMTP caveat as above applies: password reset is only a recovery
path if a mail transport is configured.

## 15.8 — Two-factor authentication (TOTP)

MFA is a **per-user opt-in**. There is no deployment-wide or per-org "require MFA" setting and no new
environment variable (D-15.8-2) — an org-level policy is a _team_ control and lands with the other org
settings in 15.10. State the consequence plainly: **an operator cannot yet force members to enrol.**

Nothing needs to be configured to turn this on. It uses `node:crypto` (no new dependency), the
existing `ARCHIVE_ENCRYPTION_KEY`, and the existing `SESSION_SECRET`.

### How a user enrols

1. **Settings → Two-factor authentication → Confirm your password → Enable.** Arming a second factor
   RE-AUTHENTICATES (D-15.8-16), exactly as changing your password does. This is not friction for its
   own sake: without it a stolen session cookie could enrol an attacker's authenticator, and because
   `enroll/confirm` revokes every other session the rightful owner would be signed out — and a
   password reset does **not** clear MFA, so proven control of the mailbox would no longer be enough
   to get back in. An **SSO-only account** (`password_hash IS NULL`) has no password to present and
   must instead have signed in within the last **15 minutes**; if it refuses, sign out and back in.
   The card shows a base32 secret grouped in
   fours plus an `otpauth://` URI. There is **no QR code** in 15.8 (D-15.8-14) — every mainstream
   authenticator accepts manual entry; a QR needs either a new dashboard dependency or a hand-rolled
   encoder, and it lands with the account surfaces in 15.10.
2. **Enter the code the app shows and press Confirm.** Until this succeeds the credential gates
   nothing (`confirmed_at IS NULL`), so an abandoned enrolment — wrong clock, wrong app, closed tab —
   never locks anyone out of their own account.
3. **Save the ten recovery codes.** They are shown **once**. They are stored as SHA-256, so there is
   no endpoint that can display them again; regenerating replaces the whole set.

Confirming revokes every **other** live session and spares the tab it was done in (OWASP Session
Management: renew after a privilege-level change). Disabling does the same.

### What changes at sign-in

Every path that mints a session for an enrolled user — **password login and the SSO callback alike**
(D-15.8-5) — stops one step short and returns a short-lived signed **challenge** instead of a session
token. The dashboard hands off to `/login/mfa`; the session exists only after
`POST /v1/auth/mfa/verify` accepts a TOTP code or a recovery code. A login that returns a challenge
writes **no** `sessions` row at all.

Three properties worth knowing before a support ticket arrives:

- **A code cannot be used twice** (RFC 6238 §5.2). The accepted step is recorded and the comparison
  is monotonic. One consequence is visible: if a user confirms enrolment and then signs out and back
  in **within the same 30-second window**, the code their app is still showing is the one already
  spent, and it is refused. Waiting for the next code resolves it. This is the RFC's rule, not a bug.
- **Ten consecutive failures lock the credential for 15 minutes** (RFC 4226 §7.3). During the lock a
  _correct_ code is also refused, and the response is a `429` with `Retry-After` — deliberately
  distinguishable, because a lockout the user cannot see is a support ticket. A success resets both
  the counter and the lock.
- **A challenge dies the moment the password changes** (D-15.8-4). The challenge carries a
  fingerprint of the credential it was issued against, re-checked under the same row lock the login
  takes, so a reset mid-flow voids any challenge in flight. The answer is a **generic 401** — the
  same wording a wrong code gets — so it cannot be used to probe whether an account is live.

An **API key** is never MFA-gated (D-15.9-5, inheriting D-15.8-15's reasoning). It has no user session
to challenge, and it can only exist because an already-authenticated — and, if enrolled, already
MFA'd — session minted it. Re-challenging on every machine request would make the tier unusable for
exactly the headless clients it exists for, while adding nothing: the second factor was already
presented, at mint time.

### Losing the second factor

In order of preference:

1. **A recovery code.** Enter it in place of the six digits at `/login/mfa` (the "use a recovery code
   instead" link only relaxes the input mask — the server accepts either credential on the same
   field). Each works once; Settings shows how many remain.
2. **Operator break-glass — direct database access.** There is **no admin "reset MFA for user X"
   endpoint in 15.8**, and that absence is deliberate: it would be a privilege-escalation surface (an
   `admin` stripping an `owner`'s second factor), and 15.5's ladder lesson says such a route needs a
   full rank comparison plus an audit record. Both land in 15.10. Until then, with `DATABASE_URL`
   (consistent with D-M15-7's "operator break-glass is direct database access, never an HTTP
   god-token"):

   ```sql
   -- Verify who you are about to unlock, FIRST.
   select u.email, t.confirmed_at, t.locked_until
     from totp_credentials t join users u on u.id = t.user_id
    where u.email = 'person@example.com';

   -- Remove the second factor. The recovery codes must go too, or a later re-enrolment would
   -- silently inherit the old ones.
   begin;
   delete from mfa_recovery_codes where user_id = (select id from users where email = 'person@example.com');
   delete from totp_credentials  where user_id = (select id from users where email = 'person@example.com');
   commit;
   ```

   To clear only a **lockout** without disabling MFA:

   ```sql
   update totp_credentials set failed_attempts = 0, locked_until = null
    where user_id = (select id from users where email = 'person@example.com');
   ```

### Key rotation covers the TOTP secret

The secret is **encrypted at rest**, not hashed (D-15.8-6) — verification needs the plaintext to
recompute the code, so it is a symmetric bearer credential and a leaked backup would defeat MFA for
every enrolled user silently. It is the fourth encrypted column trio in the schema, and `reencryptAll`
covers it: `npm run keys:rotate` reports a `totpCredentials` count alongside the others. **Retiring an
old key without running the rotation would break sign-in for every enrolled user at once**, because
`decryptField` would throw on their stored secret.

### Troubleshooting

| Symptom                                                                       | Cause / fix                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codes are always rejected during enrolment                                    | The device clock is off by more than 30 s. The window is ±1 step by design (RFC 6238 §6). Enable automatic time on the phone.                                                                                                                                                                                                                                                                                                                          |
| A correct code is refused right after enrolling                               | The confirming code's step is spent (RFC 6238 §5.2). Wait for the next code.                                                                                                                                                                                                                                                                                                                                                                           |
| `429` with `retryAfter`                                                       | Ten consecutive failures locked the credential for 15 minutes. Use a recovery code after the lock expires, or clear it with the SQL above.                                                                                                                                                                                                                                                                                                             |
| `429 Rate limit exceeded, retry in 15 minutes` — **without** a `reason` field | This is the **per-IP** login rate limit (12.4c), not the per-user MFA lockout, and on a deployment with `RATE_LIMIT_*` configured it fires FIRST — measured during 15.8's walkthrough, where the IP limit cut a brute-force burst off at 6 attempts while `totp_credentials.failed_attempts` had reached 8. Both layers are working; they are just ordered. Tell them apart by the BODY: the MFA lockout answers `{"reason":"locked","retryAfter":n}`. |
| The second step bounces back to `/login`                                      | `/login/mfa` is missing from the dashboard middleware's `PUBLIC` list — the match is exact equality, so `/login` does not cover it.                                                                                                                                                                                                                                                                                                                    |
| Enrolment returns `401` with `reason: password_required`                      | Arming a second factor re-proves the current password (D-15.8-16). It was wrong or absent.                                                                                                                                                                                                                                                                                                                                                             |
| Enrolment returns `401` with `reason: reauth_required`                        | An SSO-only account whose session is older than 15 minutes (D-15.8-16). Sign out and sign in again, then enable it straight away.                                                                                                                                                                                                                                                                                                                      |
| Enrolment returns `409 already_enrolled`                                      | A confirmed credential already exists. Disable it first (which requires a live code) — silently rotating a working second factor from an unproven session would be a takeover primitive.                                                                                                                                                                                                                                                               |
| Sign-in never asks for a code                                                 | The enrolment was never confirmed (`confirmed_at IS NULL`), so it gates nothing. Re-run Enable and complete step 2.                                                                                                                                                                                                                                                                                                                                    |
| Every enrolled user fails to sign in after a key rotation                     | The old `ARCHIVE_ENCRYPTION_KEY` was retired without running `keys:rotate`. Restore the key to the keyring and rotate.                                                                                                                                                                                                                                                                                                                                 |

### Rolling back migration 0020

The down-migration **drops `totp_credentials` and `mfa_recovery_codes`**. That is not a lockout — every
user's password and SSO link are untouched, and login reverts to minting a session directly — but it
**silently downgrades every enrolled account to a single factor**, with no signal to the user that
their second factor stopped being asked for. Rolling forward again does **not** restore the secrets:
each user must re-enrol and save a new set of recovery codes.

## 15.9 — API keys (and the retirement of `ADMIN_TOKEN`)

M15 15.9 (D-M15-7) adds a **third credential tier** — named, hashed, revocable, per-user **API
keys** — and **removes `ADMIN_TOKEN`**, which authenticates nothing as of this slice.

### Why the shared token went

`ADMIN_TOKEN` had four properties, all bad, and each one is something a key fixes:

| Property                                                                      | What a key does instead                                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Un-attributable** — every holder resolved to the same bootstrap admin       | Resolves to a real person; every machine write is traceable to them |
| **Un-revocable** — revoking meant editing env + restarting, for _all_ clients | `DELETE /v1/auth/api-keys/:id` revokes one key, immediately         |
| **Un-expiring**                                                               | Optional `expiresInDays`; `NULL` = never, chosen per key            |
| **Always `owner`** — the reports script held the whole deployment             | Capped at the minter's rung, and re-capped on every request         |

### Issuing a key

Minting requires **re-authentication** (D-15.9-6) — a long-lived credential minted from a stolen
cookie outlives the session it came from. Listing and revoking do **not**: revocation must never be
harder than minting.

```sh
# Mint (over a logged-in session). PowerShell: use curl.exe and a file-based body.
curl -s -X POST "$INGEST_URL/v1/auth/api-keys" \
  -H "authorization: Bearer $SESSION" -H "content-type: application/json" \
  --data-binary "@body.json"
# body.json: {"name":"desktop","role":"member","currentPassword":"..."}
# → 201 {"apiKey":{...},"token":"k420_..."}   ← the ONLY time the token ever appears

# List (never returns the token or its hash)
curl -s "$INGEST_URL/v1/auth/api-keys" -H "authorization: Bearer $SESSION"

# Revoke one
curl -s -X DELETE "$INGEST_URL/v1/auth/api-keys/<id>" -H "authorization: Bearer $SESSION"
```

**The plaintext is shown exactly once.** Only its SHA-256 is stored (D-15.9-2), so a lost key is
re-minted, never recovered. Copy it straight into its client.

**Grant the lowest rung that works.** `role` is optional; omitting it means "inherit my role", which
is what `ADMIN_TOKEN` effectively did. The desktop app's monitor panel needs only `viewer`, and
`reports:generate` needs only `member`. You may never mint above your own rung (403).

### The effective role is re-derived on every request

A key's rung is the **lower** of its own `role` and its owner's **current** membership role
(D-15.9-4) — not a mint-time snapshot. So **demoting someone immediately demotes every key they
issued**, on the next request, with no rotation. Removing them from the org revokes their keys
outright, in the same transaction as their sessions (D-15.9-9).

A **password change deliberately does not** revoke keys: a key is not derived from the password, and
breaking every machine client on a routine rotation would be worse than the threat it addresses. If
you are rotating because the password _leaked_, revoke the keys explicitly as well.

### Where keys are used

| Client                        | Where it goes                                                     |
| ----------------------------- | ----------------------------------------------------------------- |
| Desktop app                   | Settings → **API key** (stored in the OS keychain, never on disk) |
| `npm run reports:generate`    | `API_KEY` in the environment (see `.env.example`)                 |
| `collector projects`          | `--token <apiKey>`                                                |
| Catalog signing / smoke tests | `API_KEY` (see `scripts/CATALOG-SIGNING.md`)                      |

### Upgrading a deployment

1. Ensure `ADMIN_EMAIL` + `ADMIN_PASSWORD` are set and restart — this is now the whole first-run
   bootstrap. (`ADMIN_TOKEN` never seeded anything; it only authenticated.)
2. Log in, mint one key **per machine client**, at the lowest rung that works.
3. Paste each into its client (desktop Settings, `API_KEY`, …).
4. Delete `ADMIN_TOKEN` from `.env`. Nothing reads it; leaving it is inert but misleading.

Any client still presenting the old token now gets a **401**. That is the intended outcome, and it is
pinned by a test (`auth.int.test.ts`).

### Revocation reaches an open stream

Revoking a key terminates an **already-open** `GET /v1/monitor/stream` within one tick, exactly as
15.6 made session revocation do. The stream re-probes the key every tick (`isApiKeyLive`) and closes
with `event: error` / `api key revoked`. The probe deliberately does **not** stamp `last_used_at` —
that would be a write per tick per connected client.

### `last_used_at`

Stamped fire-and-forget, at most once per `API_KEY_TOUCH_THROTTLE_MS` (default 60 s) per key. It
answers "is this key still in use?" to the minute, which is what a revocation decision needs, without
putting a write on every authenticated read. A key with an old-or-null `last_used_at` is the first
thing to revoke.

### Troubleshooting

| Symptom                                                             | Cause / fix                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every client 401s after upgrading                                   | They are still presenting `ADMIN_TOKEN`, which was removed in 15.9. Mint keys (above).                                                                                                                                                                                                                                             |
| `POST /v1/auth/api-keys` → 401 `reason: password_required`          | Minting re-proves the current password (D-15.9-6). It was wrong or absent.                                                                                                                                                                                                                                                         |
| `POST /v1/auth/api-keys` → 401 `reason: reauth_required`            | An SSO-only account whose session is older than 15 minutes. Sign out, sign in, mint straight away.                                                                                                                                                                                                                                 |
| `POST /v1/auth/api-keys` → 403 `cannot grant a role above your own` | You asked for a rung above your own. Mint at or below it.                                                                                                                                                                                                                                                                          |
| A key that worked yesterday is now a `viewer`                       | Its owner was demoted. The effective role is a `min` re-derived per request (D-15.9-4) — this is working as designed.                                                                                                                                                                                                              |
| A key 401s and you did not revoke it                                | Its owner was removed from the org (which revokes their keys, D-15.9-9), or it expired. The three reasons collapse into one 401 on purpose, so a guessed value reveals nothing.                                                                                                                                                    |
| `DELETE /v1/auth/api-keys/:id` → 404 for a key you can see          | It is not yours. 404 rather than 403 so the route is not an enumeration oracle.                                                                                                                                                                                                                                                    |
| The desktop panel says "API key not configured"                     | The keychain holds no `apiKey`. An upgraded install's old `adminToken` is dropped on load by design — paste a new key into Settings.                                                                                                                                                                                               |
| All my keys were revoked and I did not do it                        | ANY of a user's keys can revoke that user's OTHER keys — list and revoke are gated at `viewer` and scoped by user, and revocation is never re-auth-gated by design (D-15.9-6). So a leaked key is a **denial of service on your other keys**, not only a read risk. Treat it accordingly: re-mint, and drop the leaked key's rung. |
| Minting returns `409 at_capacity`                                   | You hold `MAX_API_KEYS_PER_USER` live keys. Revoke the ones whose `lastUsedAt` is old or null — that column exists precisely to make this decision answerable.                                                                                                                                                                     |
| Minting returns `409 duplicate_name`                                | A LIVE key of yours already has that name. Names are unique per user among live keys so the revoke list stays unambiguous; revoke the old one first, then re-mint under the same name.                                                                                                                                             |

### Rolling back migrations 0022 and 0021

`db:rollback` applies **only the latest** migration, and 15.9 ships two — so the first invocation
does **not** do what the paragraph below describes. Read this order carefully; getting it backwards
is how someone destroys every key believing the first rollback was safe.

**First `db:rollback` → 0022** (drop the `api_keys_user_live_name` index). **Lossless**: no key stops
working, no row is touched, and the only behavioural change is that `409 duplicate_name` stops firing
and a user may again hold two live keys with the same name.

**A second `db:rollback` → 0021**, and that one is the destructive one:

The down-migration **drops `api_keys`**, which **revokes every key at once**: the desktop app and
every scheduled script start returning 401 immediately. Rolling forward again does **not** restore
them — only SHA-256 hashes were ever stored — so each key must be re-minted and re-installed. Roll
the _code_ back with the schema: a post-15.9 server with no `api_keys` table has no working machine
credential at all.
