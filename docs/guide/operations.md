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
curl -s localhost:8420/v1/metrics -H "authorization: Bearer $ADMIN_TOKEN" | jq
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
curl -X POST localhost:8420/v1/replay/reprice -H "authorization: Bearer $ADMIN_TOKEN"
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
curl -X POST "$INGEST_URL/v1/connector-catalog" -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d @signed.json
# 3. approve (admin) → active (prior active atomically superseded)
curl -X POST "$INGEST_URL/v1/connector-catalog/<id>/approve" -H "authorization: Bearer $ADMIN_TOKEN"
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
curl -s -H "authorization: Bearer $ADMIN_TOKEN" \
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

**One-time setup — generate the updater signing key:**

```sh
cd apps/desktop
npm run tauri signer generate -- -w ~/.tauri/420ai.key   # choose + record a password
```

This emits `~/.tauri/420ai.key` (PRIVATE — **never commit**; store like the catalog signing keys in
`.secrets/` and/or a GitHub Actions secret) and `~/.tauri/420ai.key.pub` (PUBLIC). Paste the **`.pub`
content** into `apps/desktop/src-tauri/tauri.conf.json` → `plugins.updater.pubkey` (it currently holds
the `REPLACE_WITH_TAURI_UPDATER_PUBKEY` placeholder). Losing the private key means existing installs
will reject all future updates — back it up.

**Cut a release:**

```sh
# 1. bump the version in BOTH apps/desktop/src-tauri/tauri.conf.json and Cargo.toml (e.g. 0.1.0 → 0.1.1)
# 2. export the signing key so the build emits a .sig next to the installer
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/420ai.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<the password from setup>"
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
