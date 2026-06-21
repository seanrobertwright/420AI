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

**Metrics.** `GET /v1/metrics` is **admin-gated** (service token *or* a session bearer) and
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
*Re-buildable* rows (events, report_artifacts older than N days) MAY be pruned by an operator who
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
fingerprint are untouched**, and there is no schema change. It only ever *recomputes* an existing
cost — it never *adds* a cost to a costless event (`usage.reported`/`message.*` pass through).

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
  call), which looks up *only* the active catalog with no fallback to the bundled baseline. Upload a
  complete catalog.
- It is **idempotent** — safe to re-run; rows already at the active version are skipped (so a second
  run reprices 0). Run it after each catalog approval.
