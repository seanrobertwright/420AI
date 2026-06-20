# Feature: M12 Slice 12.4 — Operations Baseline

The following plan should be complete, but it's important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to naming of existing
utils, types, and models. Import from the right files (relative imports end in `.js`; `import type`
for type-only). **Project conventions are the source of truth — read [`CLAUDE.md`](../../CLAUDE.md) and
[`SUMMARY.md`](../../SUMMARY.md); do not re-derive them here.**

> **This slice is a bundle of SIX independent ops items.** Execute and **commit/PR each sub-slice
> separately** (mirrors how 12.2 split into 12.2a/12.2b). The recommended dependency order is
> **12.4a → 12.4b → 12.4c → 12.4d → 12.4e → 12.4f** (rotation + rollback lean on the backup safety net
> existing first). Each sub-slice below has its own tasks + validation gate and is green on its own.

## Feature Description

Slice 12.4 is "the genuinely-production slice the original PRD never modeled" (PRD §25 M12). It takes the
single-user, self-hosted archive from *feature-built* to *operable*:

- **12.4a — CI blocking.** Make the `repo-health` GitHub Actions check a **required** status check on
  `main` (the repo is **public** — branch protection is free; see Spike A), plus small workflow
  hardening, retiring the "never merge red" honor-system note in SUMMARY.
- **12.4b — Server observability.** Structured logging for the ingest API (env log level + auth/cookie
  redaction) and an admin-gated **`GET /v1/metrics`** JSON stats endpoint (counters via an `onResponse`
  hook). *Distinct from the M9 collector→monitor heartbeat — this is the server observing itself.*
- **12.4c — Ingest rate limiting.** Register `@fastify/rate-limit` with a generous global limit and a
  **strict limit on `POST /v1/auth/login`** (the brute-force guard 12.3 explicitly deferred here).
- **12.4d — Automated archive backup + retention/pruning.** A `pg_dump`-based backup script (gzip,
  timestamped) + **backup-file retention** (delete dumps older than N days) + a documented restore. Raw
  records stay forever (PRD §8.5: "raw sacred"); an **optional** prune of re-buildable rows is documented
  but defaults off.
- **12.4e — Encryption-key rotation (key-versioning).** Upgrade `crypto.ts` from a single
  `ARCHIVE_ENCRYPTION_KEY` to a **keyring** (`ARCHIVE_ENCRYPTION_KEYS` + `ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID`)
  that tags each ciphertext with its `keyId` (prefix on the ciphertext string — **no schema change, no
  read-site change**), so old + new keys coexist; plus a **rotation CLI** that re-encrypts every encrypted
  row under the active key. Back-compat: a deployment with only the legacy `ARCHIVE_ENCRYPTION_KEY` set is
  byte-for-byte unchanged (proven by Spike C).
- **12.4f — Migration rollback path.** Hand-authored **down-migrations** (`drizzle/down/NNNN_*.down.sql`,
  one per existing `0000`–`0009`) + a **`db:rollback` CLI** that reads `_journal.json`, finds the
  latest-applied migration in Drizzle's `__drizzle_migrations` table, runs its down SQL in a transaction,
  and deletes the tracking row (Spike B confirmed the table shape + the `created_at = folderMillis` key).

## User Story

As the **self-hosting single admin** of my 420AI archive,
I want **CI that actually blocks bad merges, automatic backups I can restore from, server logs/metrics I
can read, rate limiting on the ingest API, a safe way to rotate my encryption key, and a way to roll back
a bad migration**,
So that **running this in production is safe and recoverable** — not dependent on my own vigilance, with no
single irreversible action (key change, migration, or red merge) that can lose or corrupt data.

## Problem Statement

1. **CI is advisory, not enforced.** `repo-health.yml` runs on every PR but is not a *required* check; a
   red merge already slipped through once (SUMMARY §0 — M8/PR #7) and needed a hotfix PR.
2. **No backups.** The PRD names volume/retention numbers (§8.5) but ships no backup job — a dropped
   volume or bad migration loses the archive irrecoverably.
3. **The server is a black box.** Fastify's default pino logging is on, but there is no env-tunable level,
   no guarantee bearer tokens/cookies aren't logged, and **no metrics surface** to see request/error/
   ingest volume.
4. **No rate limiting.** Every endpoint — including the unauthenticated `POST /v1/auth/login` — accepts
   unlimited requests. 12.3 explicitly deferred login brute-force protection to this slice.
5. **Key rotation is impossible without downtime + data loss risk.** `ARCHIVE_ENCRYPTION_KEY` is a single
   env value; changing it makes all existing ciphertext undecryptable. There is no key versioning, no
   rotation tooling, and no documented procedure.
6. **Migrations are one-way.** Drizzle generates up-only SQL; there is no down path and no rollback tool,
   so a bad migration can only be undone by hand-editing the DB or restoring a backup.

## Solution Statement

See the six sub-slice summaries in **Feature Description**. Cross-cutting design choices (all chosen to
minimize blast radius on proven code):

- **Key-versioning rides INSIDE the ciphertext string** (`"<keyId>.<base64>"`), so `EncryptedField` keeps
  its `{ciphertext, iv, tag}` shape — the **3 write sites and 3 read sites are unchanged** and there is
  **no schema migration** for 12.4e. Legacy (un-prefixed) ciphertext decrypts via the carried-in legacy
  key. (Spike C: 13/13 cases pass.)
- **Rate limiting + metrics + log config are all additive `buildApp` options with safe defaults**, so the
  **7 existing `buildApp` callers don't change** (mirrors 12.3's optional-opts discipline). Rate limiting
  is **off unless `opts.rateLimit` is provided** → existing int tests run unthrottled; only `server.ts`
  (and a dedicated new int test) enable it.
- **Backups + rollback are ops scripts**, not server code — they run as standalone `tsx`/shell entrypoints
  (the only places allowed to log / read argv / exit, per CLAUDE.md "Logging / process boundaries").

## Feature Metadata

**Feature Type**: New Capability (ops tooling) + Enhancement (hardening). Six independent sub-features.
**Estimated Complexity**: **High** (breadth: 6 items spanning CI/infra/crypto/migrations) — but each item
is individually low-to-medium and the one genuinely risky piece (crypto key-versioning) is spike-proven.
**Primary Systems Affected**: `.github/workflows` (12.4a), `apps/ingest` (12.4b logging+metrics, 12.4c
rate limit), repo-root `scripts/` + `docker-compose.yml` (12.4d backup), `packages/db` crypto + a new CLI
(12.4e), `packages/db/drizzle` + a new CLI (12.4f), `.env.example` + `docs/` (all).
**Dependencies**: **One new npm package** — `@fastify/rate-limit@^11` (declares `"fastify":"^5.0.0"`;
Spike A confirmed compatibility with the repo's Fastify 5.8.5). Everything else uses `node:crypto`, `pg`
(already present), `pg_dump` (ships in the `postgres:17` image), and `gh`/GitHub settings.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**Shared / gate (12.4a, all):**
- `.github/workflows/repo-health.yml` (whole file) — the CI workflow; triggers on PR + push to `main`,
  spins up `postgres:17` as a service, creates `420ai_test`, writes a CI `.env`, runs
  `npm run repo-health -- --require-db`. **12.4a hardens this + you make it a required check in GitHub
  settings (Spike A / Task A2).**
- `scripts/repo-health.mjs` (whole file, ~227 lines) — the 6-check gate (NUL scan, stray-artifact scan,
  root `tsc -b`, dashboard typecheck, desktop typecheck, vitest; `--fast` skips tests, `--require-db`
  asserts the int layer ran 0-skipped). **MIRROR its check-block + `run()` helper if 12.4d adds a backup
  smoke-check (optional).**
- `.githooks/pre-commit` — runs `repo-health --fast`. (No change expected.)
- `package.json` (scripts block, lines 13–31) — where `db:rollback` / `backup` / `rotate-key` npm scripts
  get added (Tasks d/e/f). Existing: `db:up`, `db:migrate`, `db:generate`, `repo-health`, etc.
- `SUMMARY.md` (§0 lines 44–46) — the "⚠️ not yet a hard blocking required check … never merge red" note
  to retire in 12.4a; (§6 12.4 bullets lines 356–360) to mark done at sign-off.

**Ingest observability + rate limiting (12.4b, 12.4c):**
- `apps/ingest/src/app.ts` (whole file, 122 lines) — `BuildAppOptions` (lines 31–49) + `buildApp` (59–122)
  with `app.decorate(...)` calls (62–77), plugin/route registration (79–96), and the error handler
  (99–119). **Add `logLevel?`, `metrics?`, `rateLimit?` options + the logger config object + the metrics
  hook/decoration + the rate-limit plugin registration here.**
- `apps/ingest/src/server.ts` (whole file, 82 lines) — reads env, builds the app, listens. **Add
  `LOG_LEVEL`, `RATE_LIMIT_*`, and metrics wiring; pass them into `buildApp`.** Note the
  `parsePositiveInt` helper (24–31) to reuse for new numeric envs.
- `apps/ingest/src/routes/health.ts` (whole file, 6 lines) — the **minimal route to MIRROR** for the new
  `routes/metrics.ts` (`export default async function xRoutes(app)`; `app.get(url, handler)`).
- `apps/ingest/src/plugins/auth.ts` (lines 9–31) — the `declare module "fastify"` augmentation. **Add
  `metrics: MetricsStore;` here** (so `app.metrics` is typed).
- `apps/ingest/src/auth.ts` — `adminAuthorized(app, request)` (the sync hybrid gate). **The metrics route
  is admin-gated: `if (!adminAuthorized(app, request)) return reply.code(401)...`.**
- `apps/ingest/src/routes/auth.ts` (the 12.3 `POST /v1/auth/login` route) — **add the per-route
  `config: { rateLimit: {...} }` for login brute-force protection (12.4c).**
- `apps/ingest/src/routes/pairing-codes.ts` — the canonical admin-gated route pattern (inline
  `adminAuthorized`). MIRROR for `routes/metrics.ts`'s gate.
- `apps/ingest/src/app.int.test.ts` (lines 47–94) — int-test scaffold: `TEST_URL`,
  `describe.skipIf(!TEST_URL)`, `createDb(TEST_URL!)`, `buildApp({db, adminToken: ADMIN, analysisProvider:
  stubProvider, monitorStreamIntervalMs: 50, logger: false})`, `app.ready()`, `beforeEach TRUNCATE …
  RESTART IDENTITY CASCADE`, `createCode()`/`pair()` helpers, `app.inject({method,url,headers})`. **MIRROR
  for the new metrics + rate-limit int tests.**
- `apps/ingest/package.json` (deps: `fastify ^5.8.5`, `fastify-plugin ^6`, `dotenv ^17`) — **add
  `@fastify/rate-limit` (12.4c).**

**Crypto / key rotation (12.4e):**
- `packages/db/src/crypto.ts` (whole file, ~50 lines) — `ALGO`, `EncryptedField`, `key()`, `encryptField`,
  `decryptField`. **This is the file you rewrite to a keyring (per Spike C). Keep `EncryptedField`'s shape
  and the exact error strings.**
- `packages/db/src/crypto.test.ts` (whole file, 68 lines) — sets only `ARCHIVE_ENCRYPTION_KEY` (single-key
  mode). **These tests MUST still pass unchanged** (single-key mode is byte-identical → un-prefixed
  ciphertext; the tamper test flips a bit in the base64 ciphertext). **Add new keyring-mode tests in a
  SEPARATE describe block (or new file `crypto-keyring.test.ts`).**
- `packages/db/src/index.ts` (line 23) — barrel `export { encryptField, decryptField } from "./crypto.js"`
  + `export type { EncryptedField }` (24). **Add the rotation repo fn export + maybe `activeKeyId` helper.**
- The **3 write sites** (unchanged, but read to confirm): `repositories/ingest.ts:33` (raw payload),
  `repositories/ingest.ts:59` (event payload), `repositories/git.ts:35` (commit message).
- The **3 read sites** (unchanged, but read to confirm): `repositories/attribution.ts:95`,
  `repositories/search.ts:205`, `repositories/transcript.ts:112` — each builds
  `decryptField({ ciphertext, iv, tag })`. **The keyId travels in `ciphertext` so these don't change.**
- `packages/db/src/schema.ts` — the 3 encrypted-column trios to re-encrypt: `rawSourceRecords`
  `payload_{ciphertext,iv,tag}` (lines 108–110, NOT NULL), `events` `payload_{ciphertext,iv,tag}`
  (149–151, nullable), `gitCommits` `message_{ciphertext,iv,tag}` (lines ~326–328, nullable). **The
  rotation CLI iterates these.**
- `packages/db/src/repositories/machines.ts` (lines 11, 48–78) — `recordHeartbeat` is the **existing
  in-DB retention precedent** (`HEARTBEAT_RETENTION_MS`, append-then-`delete … where ts < now-retention`).
  MIRROR its prune shape if 12.4d adds the (optional, off-by-default) row prune.

**Migrations / rollback (12.4f):**
- `packages/db/src/migrate.ts` (whole file) — `runMigrations(connectionString)`:
  `migrate(db, { migrationsFolder })` then `pool.end()`. The **up** path.
- `packages/db/src/migrate-cli.ts` (whole file) — the **entrypoint MIRROR for `rollback-cli.ts`**: loads
  repo-root `.env`, reads `DATABASE_URL`, calls the runner, top-level `await`.
- `packages/db/src/client.ts` (whole file) — `createDb(connectionString) → { db, pool }`; caller must
  `pool.end()`. The rollback CLI uses the **`pool` directly** (raw SQL).
- `packages/db/drizzle/_journal` → `packages/db/drizzle/meta/_journal.json` — the authoritative
  `{idx, tag, when, breakpoints}` list (version "7", 10 entries 0000–0009). **The rollback CLI reads this
  for the `tag` ↔ `when`(=`folderMillis`=`created_at`) mapping.**
- `packages/db/drizzle/0009_exotic_ben_grimm.sql` (1 line: `ALTER TABLE "users" ADD COLUMN
  "password_hash" text;`) and `0004_bouncy_romulus.sql` (53 lines: CREATE TABLE ×3 + ADD CONSTRAINT ×5 +
  CREATE INDEX ×5, separated by `--> statement-breakpoint`) — the **two worked down-migration examples**
  (Task f2). Every up-migration uses `--> statement-breakpoint` between statements.
- `packages/db/package.json` (scripts 24–28: `db:generate`, `db:migrate`) — **add `db:rollback`.**

### New Files to Create

- `apps/ingest/src/metrics.ts` — `MetricsStore` type + `createMetrics()` (counter store) +
  `registerMetricsHook(app)` (the `onResponse` hook). (12.4b)
- `apps/ingest/src/metrics.test.ts` — unit test of the counter store increments. (12.4b)
- `apps/ingest/src/routes/metrics.ts` — admin-gated `GET /v1/metrics`. (12.4b)
- `apps/ingest/src/observability.int.test.ts` — int test: `/v1/metrics` gated + counts a request;
  rate-limit 429 on the login route when `rateLimit` opt is set. (12.4b + 12.4c, combined)
- `packages/db/src/repositories/key-rotation.ts` — `reencryptAll(db, opts)` (re-encrypt every encrypted
  row under the active key; returns per-table counts). (12.4e)
- `packages/db/src/rotate-key-cli.ts` — entrypoint that loads `.env`, calls `reencryptAll`, logs counts.
  (12.4e)
- `packages/db/src/crypto-keyring.test.ts` — keyring-mode unit tests (the executable form of Spike C).
  (12.4e)
- `packages/db/src/rollback.ts` — `rollbackLast(connectionString, { downDir, journalPath })` (the rollback
  engine). (12.4f)
- `packages/db/src/rollback-cli.ts` — entrypoint (MIRROR `migrate-cli.ts`). (12.4f)
- `packages/db/drizzle/down/0000_*.down.sql` … `0009_*.down.sql` — one down-migration per existing
  migration (same base filename + `.down.sql`). (12.4f)
- `scripts/backup-archive.sh` — `pg_dump | gzip` to a timestamped file + prune dumps older than retention.
  (12.4d)
- `scripts/restore-archive.sh` — documented restore (`gunzip | psql`). (12.4d)
- `docs/guide/operations.md` — the ops runbook: enabling the required check, backups/restore, log/metrics,
  rate limits, **key rotation procedure**, **migration rollback procedure**. (all)

### Relevant Documentation — READ THESE BEFORE IMPLEMENTING

- `@fastify/rate-limit` — <https://github.com/fastify/fastify-rate-limit#readme>
  - Sections: global options (`max`, `timeWindow`, `allowList`), **per-route config**
    (`{ config: { rateLimit: { max, timeWindow } } }`), and the `429` response shape.
  - Why: 12.4c. **GOTCHA:** the plugin must be **registered before** the routes that carry per-route
    `config.rateLimit`. Default key is `request.ip` (fine for self-hosted single-user).
- Fastify logging — <https://fastify.dev/docs/latest/Reference/Logging/>
  - Sections: `logger` as an options object (`level`, `redact`), and the default `req`/`res` serializers
    (which do **not** log arbitrary headers by default — the `redact` is defense-in-depth).
  - Why: 12.4b log config. **GOTCHA:** pass `logger` as `false` (tests) OR an object `{level, redact}`;
    don't pass `true` once you want level/redact.
- PostgreSQL `pg_dump` / `pg_restore` — <https://www.postgresql.org/docs/17/app-pgdump.html>
  - Why: 12.4d. We use plain-format `pg_dump | gzip` (portable, greppable) + `psql` restore. The
    `postgres:17` container has `pg_dump`; run it via `docker compose exec -T archive pg_dump …`.
- drizzle-orm migrator internals (read the installed source, not the web) —
  `node_modules/drizzle-orm/pg-core/dialect.cjs` (the `CREATE TABLE IF NOT EXISTS
  drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)` +
  `insert … values(hash, folderMillis)` + `select … order by created_at desc limit 1`).
  - Why: 12.4f. **This is the table the rollback CLI mutates** (Spike B).
- GitHub branch protection / required status checks —
  <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches>
  - Why: 12.4a. The repo is **public** (Spike A: `seanrobertwright/420AI`, `visibility: PUBLIC`), so this
    is free. Settings → Branches → Add rule for `main` → Require status checks → select `repo-health`.

### Patterns to Follow

**Keyring crypto (`packages/db/src/crypto.ts`) — PROVEN by Spike C (13/13 pass):**
```ts
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const ALGO = "aes-256-gcm";
/** keyId used for legacy single-key deployments and for un-prefixed (pre-rotation) ciphertext. */
const LEGACY_ID = "legacy";

export interface EncryptedField {
  ciphertext: string; // base64 — keyring mode prefixes "<keyId>.": "v2.AbCd…". Legacy = bare base64.
  iv: string; // base64
  tag: string; // base64
}

interface Keyring { keys: Map<string, Buffer>; activeId: string; }

/** Build the keyring from env each call (cheap; preserves the existing test that mutates env). */
function keyring(): Keyring {
  const raw = process.env.ARCHIVE_ENCRYPTION_KEYS;
  if (raw) {
    const obj = JSON.parse(raw) as Record<string, string>; // { keyId: base64key }
    const keys = new Map<string, Buffer>();
    for (const [id, b64] of Object.entries(obj)) {
      const k = Buffer.from(b64, "base64");
      if (k.length !== 32) throw new Error(`ARCHIVE_ENCRYPTION_KEYS["${id}"] must be 32 bytes (base64-encoded)`);
      keys.set(id, k);
    }
    const activeId = process.env.ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID;
    if (!activeId || !keys.has(activeId)) {
      throw new Error("ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID must name a key in ARCHIVE_ENCRYPTION_KEYS");
    }
    return { keys, activeId };
  }
  // Back-compat: a single legacy key. Output stays UN-prefixed → byte-identical to pre-12.4e.
  const b64 = process.env.ARCHIVE_ENCRYPTION_KEY;
  if (!b64) throw new Error("ARCHIVE_ENCRYPTION_KEY is not set");
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error("ARCHIVE_ENCRYPTION_KEY must be 32 bytes (base64-encoded)");
  return { keys: new Map([[LEGACY_ID, k]]), activeId: LEGACY_ID };
}

function resolveKey(ring: Keyring, id: string): Buffer {
  const k = ring.keys.get(id);
  if (!k) throw new Error(`no encryption key for keyId "${id}"`);
  return k;
}

/** The active keyId — used by the rotation CLI to skip already-rotated rows. */
export function activeKeyId(): string { return keyring().activeId; }

export function encryptField(plaintext: string): EncryptedField {
  const ring = keyring();
  const iv = randomBytes(12); // 96-bit, fresh per call — NEVER reuse
  const c = createCipheriv(ALGO, resolveKey(ring, ring.activeId), iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  // Only keyring mode prefixes; legacy single-key stays bare base64 (zero format change).
  const prefix = ring.activeId === LEGACY_ID ? "" : ring.activeId + ".";
  return { ciphertext: prefix + ct.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") };
}

export function decryptField(f: EncryptedField): string {
  const ring = keyring();
  let id = LEGACY_ID;
  let ctB64 = f.ciphertext;
  const dot = f.ciphertext.indexOf("."); // base64 has no "." → unambiguous prefix split
  if (dot >= 0) { id = f.ciphertext.slice(0, dot); ctB64 = f.ciphertext.slice(dot + 1); }
  const d = createDecipheriv(ALGO, resolveKey(ring, id), Buffer.from(f.iv, "base64"));
  d.setAuthTag(Buffer.from(f.tag, "base64")); // final() throws if tampered
  return Buffer.concat([d.update(Buffer.from(ctB64, "base64")), d.final()]).toString("utf8");
}
```
> **Spike C assertions (fold into `crypto-keyring.test.ts`):** legacy round-trip; legacy ciphertext has no
> "."; a legacy row decrypts after upgrading to keyring mode (un-prefixed → legacy key); keyring active=v2
> prefixes "v2." and round-trips; an active=legacy field still decrypts after the active flips to v2;
> decrypt-then-encrypt rotation yields a v2-prefixed field that round-trips; unknown keyId throws
> `no encryption key for keyId "v9"`; tamper throws. **The existing `crypto.test.ts` (single-key mode)
> passes UNCHANGED** because legacy mode emits bare base64 with the same two error strings.

**Metrics store + hook (`apps/ingest/src/metrics.ts`):**
```ts
import type { FastifyInstance } from "fastify";

export interface MetricsStore {
  startedAt: number;            // epoch ms (process start)
  requests: number;             // total responses observed
  byStatusClass: Record<string, number>; // "2xx"|"3xx"|"4xx"|"5xx" → count
  ingestRecordsInserted: number; // bumped by the ingest route (optional, see GOTCHA)
  ingestEventsUpserted: number;
}

export function createMetrics(now: number): MetricsStore {
  return { startedAt: now, requests: 0, byStatusClass: {}, ingestRecordsInserted: 0, ingestEventsUpserted: 0 };
}

/** Count every response by status class. Registered in buildApp when opts.metrics !== false. */
export function registerMetricsHook(app: FastifyInstance): void {
  app.addHook("onResponse", (_req, reply, done) => {
    const m = app.metrics;
    m.requests += 1;
    const cls = `${Math.floor(reply.statusCode / 100)}xx`;
    m.byStatusClass[cls] = (m.byStatusClass[cls] ?? 0) + 1;
    done();
  });
}
```
> **GOTCHA:** `startedAt`/`now` is injected (CLAUDE.md: "inject clocks for determinism") — `buildApp`
> passes `Date.now()` (it's an entrypoint-ish factory, but to keep `metrics.test.ts` deterministic the
> store takes `now`). Counters reset on restart — acceptable for single-user self-hosted; say so in
> `/v1/metrics`'s doc and the route payload (`startedAt` lets a reader see the window).

**Metrics route (`apps/ingest/src/routes/metrics.ts`) — MIRROR `health.ts` + the admin gate:**
```ts
import type { FastifyInstance } from "fastify";
import { adminAuthorized } from "../auth.js";

/** GET /v1/metrics — admin-gated server self-observability (M12 12.4b). JSON counters, not Prometheus. */
export default async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/metrics", async (request, reply) => {
    if (!adminAuthorized(app, request)) return reply.code(401).send({ error: "admin authorization required" });
    const m = app.metrics;
    return reply.code(200).send({
      uptimeSeconds: Math.floor((Date.now() - m.startedAt) / 1000),
      requests: m.requests,
      byStatusClass: m.byStatusClass,
      ingest: { recordsInserted: m.ingestRecordsInserted, eventsUpserted: m.ingestEventsUpserted },
      memory: process.memoryUsage().rss,
    });
  });
}
```

**Logger config + new options in `buildApp` (`apps/ingest/src/app.ts`):**
```ts
// BuildAppOptions additions:
  /** 12.4b pino level (default "info"); ignored when logger:false. */
  logLevel?: string;
  /** 12.4b metrics: false disables the store+hook+route (tests may omit → enabled with injected now). */
  metrics?: boolean;
  /** 12.4c when present, registers @fastify/rate-limit with these limits. Omitted → no rate limiting
   *  (so the 7 existing buildApp callers run unthrottled). */
  rateLimit?: { global?: { max: number; timeWindow: string }; login?: { max: number; timeWindow: string } };

// In buildApp — logger:
const app = Fastify({
  logger: opts.logger === false ? false
    : { level: opts.logLevel ?? "info", redact: { paths: ["req.headers.authorization", "req.headers.cookie"], remove: true } },
});

// metrics (after the existing decorations):
if (opts.metrics !== false) {
  app.decorate("metrics", createMetrics(Date.now()));
  registerMetricsHook(app);
  app.register(metricsRoutes);
}

// rate limit — register BEFORE routes so per-route config.rateLimit binds:
if (opts.rateLimit) {
  const rl = opts.rateLimit; // capture for the async closure
  app.register(import("@fastify/rate-limit"), {
    global: false, // opt routes in explicitly; the global limiter is applied to the ingest hot path only if desired
    max: rl.global?.max ?? 1000,
    timeWindow: rl.global?.timeWindow ?? "1 minute",
  });
}
```
> **GOTCHA:** keep the `metrics` decoration BEFORE `registerMetricsHook` (the hook reads `app.metrics`).
> Register rate-limit **before** `app.register(...routes)` so `routes/auth.ts`'s per-route
> `config.rateLimit` resolves. `app.register(import("@fastify/rate-limit"))` (dynamic import) keeps the
> dep out of the module graph when unused — or use a top `import rateLimit from "@fastify/rate-limit"`;
> either compiles (verify with `tsc -b`). The `declare module "fastify"` block must gain `metrics:
> MetricsStore;` (Task b1) for `app.metrics` to typecheck.

**Login per-route rate limit (`apps/ingest/src/routes/auth.ts`) — 12.4c:**
```ts
app.post<{ Body: LoginBody }>(
  "/v1/auth/login",
  {
    schema: { body: loginBodySchema },
    // 12.4c: brute-force guard (deferred here from 12.3). Only active when @fastify/rate-limit is
    // registered (server.ts/opts.rateLimit); harmlessly ignored when it isn't (tests without rateLimit).
    config: { rateLimit: app.rateLimitLogin ?? false },
  },
  async (request, reply) => { /* … unchanged 12.3 body … */ },
);
```
> **GOTCHA:** a route's `config.rateLimit` is read at registration time, but `app` decorations from later
> `register` calls may not be visible. **Simpler + robust:** instead of `app.rateLimitLogin`, pass the
> login limit through a small module-level mechanism — set it via a decoration BEFORE routes register, OR
> (cleanest) gate it by reading `opts` in `buildApp` and decorating `app.rateLimitLogin` (a
> `{max,timeWindow}|false`) right after the rate-limit plugin registration, before `app.register(authRoutes)`.
> Add `rateLimitLogin: { max: number; timeWindow: string } | false;` to the `declare module "fastify"`
> block. Verify the 429 path in `observability.int.test.ts`.

**Backup script (`scripts/backup-archive.sh`) — pg_dump via the compose container:**
```sh
#!/bin/sh
# M12 12.4d — timestamped, gzipped pg_dump of the archive + retention prune.
# Usage: BACKUP_DIR=./backups RETENTION_DAYS=14 sh scripts/backup-archive.sh
set -eu
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/420ai-$STAMP.sql.gz"
# Raw records are immutable + sacred (PRD §8.5) → full logical dump. Plain SQL + gzip = portable/greppable.
docker compose exec -T archive pg_dump -U 420ai -d 420ai | gzip > "$OUT"
echo "wrote $OUT"
# Retention: prune dumps older than RETENTION_DAYS (backup FILES, not DB rows — raw stays forever).
find "$BACKUP_DIR" -name '420ai-*.sql.gz' -type f -mtime "+$RETENTION_DAYS" -print -delete
```
> **GOTCHA:** `date`/`find -mtime` are POSIX (the Bash tool is Git Bash; the script runs under `sh`). The
> `-T` on `docker compose exec` disables TTY allocation (required for piping). The container name/service
> is `archive` (docker-compose.yml). Document a Windows Task Scheduler / cron line in `operations.md`;
> **do not** add a server-side scheduler (no new long-lived resource — CLAUDE.md / M9 discipline).

**Rollback engine (`packages/db/src/rollback.ts`) — uses Drizzle's tracking table (Spike B):**
```ts
import { readFileSync } from "node:fs";
import { Pool } from "pg";

interface JournalEntry { idx: number; tag: string; when: number; }

/** Roll back the single latest-applied migration: run its down SQL + delete the tracking row. */
export async function rollbackLast(
  connectionString: string,
  opts: { downDir: string; journalPath: string },
): Promise<{ rolledBack: string } | { rolledBack: null; reason: string }> {
  const journal = JSON.parse(readFileSync(opts.journalPath, "utf8")) as { entries: JournalEntry[] };
  const pool = new Pool({ connectionString });
  try {
    // Drizzle stores applied migrations in drizzle.__drizzle_migrations (created_at = folderMillis = journal.when).
    const applied = await pool.query<{ created_at: string }>(
      `select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`,
    );
    if (applied.rowCount === 0) return { rolledBack: null, reason: "no applied migrations" };
    const createdAt = Number(applied.rows[0]!.created_at); // bigint → string over the wire → Number()
    const entry = journal.entries.find((e) => e.when === createdAt);
    if (!entry) return { rolledBack: null, reason: `no journal entry for created_at ${createdAt}` };
    const downSql = readFileSync(`${opts.downDir}/${entry.tag}.down.sql`, "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const stmt of downSql.split("--> statement-breakpoint")) {
        const s = stmt.trim();
        if (s) await client.query(s);
      }
      await client.query(`delete from drizzle.__drizzle_migrations where created_at = $1`, [createdAt]);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
    return { rolledBack: entry.tag };
  } finally {
    await pool.end();
  }
}
```
> **Spike B facts pinned in this snippet:** the table is `drizzle.__drizzle_migrations`
> (`id SERIAL, hash text, created_at bigint`); `created_at === folderMillis === journal entry.when`;
> "latest" = `order by created_at desc limit 1`. `pg` returns `bigint` as a **string** → `Number(...)`
> (matches the repo's "numeric comes back as string" gotcha). Down SQL is split on the same
> `--> statement-breakpoint` marker Drizzle's up files use.

**Rollback CLI (`packages/db/src/rollback-cli.ts`) — MIRROR `migrate-cli.ts`:**
```ts
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { rollbackLast } from "./rollback.js";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");

const downDir = fileURLToPath(new URL("../drizzle/down", import.meta.url));
const journalPath = fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url));
const result = await rollbackLast(url, { downDir, journalPath });
if (result.rolledBack) console.log(`rolled back: ${result.rolledBack}`);
else { console.error(`nothing rolled back: ${result.reason}`); process.exit(1); }
```

**Down-migration files (`packages/db/drizzle/down/NNNN_*.down.sql`) — reverse each up file:**
```sql
-- 0009_exotic_ben_grimm.down.sql  (reverse of: ALTER TABLE "users" ADD COLUMN "password_hash" text;)
ALTER TABLE "users" DROP COLUMN "password_hash";
```
```sql
-- 0004_bouncy_romulus.down.sql (reverse of CREATE TABLE ×3 + constraints + indexes — DROP in REVERSE order)
DROP INDEX "session_git_links_by_commit";--> statement-breakpoint
DROP INDEX "session_git_links_unique";--> statement-breakpoint
DROP INDEX "git_commits_by_root";--> statement-breakpoint
DROP INDEX "git_commits_machine_sha";--> statement-breakpoint
DROP INDEX "git_commit_files_by_commit";--> statement-breakpoint
DROP TABLE "session_git_links";--> statement-breakpoint
DROP TABLE "git_commits";--> statement-breakpoint
DROP TABLE "git_commit_files";
-- (DROP TABLE drops its FKs/constraints, so no separate ALTER … DROP CONSTRAINT needed.)
```
> **Rule for the other 8:** open each `NNNN_*.sql`, and write `NNNN_*.down.sql` that reverses every
> statement **in reverse order** — `DROP INDEX` before `DROP TABLE`; `DROP COLUMN` to undo `ADD COLUMN`;
> `DROP TABLE` cascades its own constraints; reverse an `ALTER … ADD CONSTRAINT` with `ALTER … DROP
> CONSTRAINT` only when the table itself survives the rollback. Partial unique indexes (e.g. catalog
> active, alert open) reverse with a plain `DROP INDEX`. **Down-migrate is destructive — the runbook says
> back up first (12.4d).**

---

## IMPLEMENTATION PLAN

> Six independent sub-slices. Do them in order; **commit/PR each separately**. Each ends at its own gate.

### Sub-slice 12.4a — CI blocking (smallest; mostly settings + a SUMMARY edit)
Make `repo-health` a required check via GitHub branch protection (repo is public — free), optionally
harden the workflow, and retire the "never merge red" honor-system note.

### Sub-slice 12.4b — Server observability (logging + JSON `/v1/metrics`)
Add the logger config object (env level + auth/cookie redaction), the metrics store + `onResponse` hook +
admin-gated `GET /v1/metrics`, all behind additive `buildApp` options (defaults keep the 7 callers).

### Sub-slice 12.4c — Ingest rate limiting
Add `@fastify/rate-limit`, register it (opt-in via `opts.rateLimit`), and put a strict limit on
`POST /v1/auth/login`. Wire `server.ts` from env.

### Sub-slice 12.4d — Automated backup + retention/pruning
`pg_dump|gzip` backup script + file-retention prune + restore script + runbook. No server/schema change.

### Sub-slice 12.4e — Encryption-key rotation (key-versioning)
Rewrite `crypto.ts` to a keyring (Spike C), add the rotation repo fn + CLI, env, and tests. No schema
change; `EncryptedField` shape and the 6 call sites unchanged.

### Sub-slice 12.4f — Migration rollback path
Hand-author `down/NNNN_*.down.sql` for 0000–0009, the `rollback.ts` engine + `rollback-cli.ts` entrypoint
(Spike B), and `db:rollback`.

---

## STEP-BY-STEP TASKS

> Execute in order within each sub-slice; run each task's VALIDATE before moving on. `npx tsc -b` = the
> repo-root backend typecheck (the 4 backend workspaces). The dashboard is untouched in this slice.

### — 12.4a: CI blocking —

#### Task A1 — UPDATE `.github/workflows/repo-health.yml` (harden; optional but recommended)
- **IMPLEMENT**: keep the existing job; add a top-level `permissions: { contents: read }` (least
  privilege) and confirm `concurrency` + the Postgres service are intact. **No functional change to the
  steps** — the workflow already runs `repo-health -- --require-db` with a Postgres service. (If you add
  nothing else, that's fine — the real work of A2 is in GitHub settings.)
- **PATTERN**: the existing YAML (read it first).
- **VALIDATE**: `git diff .github/workflows/repo-health.yml` shows only the additive `permissions` block;
  YAML is valid (push the branch and confirm the Actions run is green).

#### Task A2 — MAKE `repo-health` a required check (GitHub settings — document + perform)
- **IMPLEMENT**: in GitHub → **Settings → Branches → Add branch protection rule** for `main`:
  **Require status checks to pass before merging** → select **`repo-health`**; also tick **Require a pull
  request before merging** + **Do not allow bypassing**. (Repo is **public** — Spike A — so this is free.)
  Optionally script it: `gh api -X PUT repos/seanrobertwright/420AI/branches/main/protection
  --input protection.json` (document the JSON in `operations.md`; the UI is simpler and is the
  recommended path).
- **GOTCHA**: the check name must EXACTLY match the workflow job name (`repo-health`). The check only
  appears in the picker after it has run at least once on a PR — push this branch's PR first.
- **VALIDATE**: open a throwaway PR with a deliberately failing change → confirm **merge is blocked** until
  `repo-health` passes. Revert the throwaway. (Manual, one-time.)

#### Task A3 — UPDATE `SUMMARY.md` (retire the honor-system note)
- **IMPLEMENT**: edit §0 lines ~44–46 — replace the "⚠️ not yet a hard blocking required check … never
  merge red" caveat with "✅ `repo-health` is a **required** status check on `main` (M12 12.4a) — red PRs
  cannot merge." Mark §6 12.4a done at sign-off.
- **VALIDATE**: `rg "not yet a hard" SUMMARY.md` → 0 matches.

### — 12.4b: Server observability —

#### Task B1 — UPDATE `apps/ingest/src/plugins/auth.ts` (type augmentation)
- **IMPLEMENT**: in the `declare module "fastify" { interface FastifyInstance { … } }` block add
  `metrics: import("../metrics.js").MetricsStore;` and (for 12.4c, can add now)
  `rateLimitLogin: { max: number; timeWindow: string } | false;`.
- **PATTERN**: lines 9–31 (where `adminToken`/`adminEmail`/etc. are declared).
- **VALIDATE**: `npx tsc -b` exits 0.

#### Task B2 — CREATE `apps/ingest/src/metrics.ts` (+ test)
- **IMPLEMENT**: `MetricsStore`, `createMetrics(now)`, `registerMetricsHook(app)` per the Patterns snippet.
- **CREATE** `apps/ingest/src/metrics.test.ts`: `const m = createMetrics(1000)`; assert initial zeros;
  simulate increments (`m.requests++`, status-class bump) and assert the store — OR test the hook by
  building a tiny Fastify app with a route + the hook and `inject`-ing (simpler: unit-test the store math).
- **VALIDATE**: `npx vitest run apps/ingest/src/metrics.test.ts` → all pass.

#### Task B3 — CREATE `apps/ingest/src/routes/metrics.ts`
- **IMPLEMENT**: admin-gated `GET /v1/metrics` per the Patterns snippet (MIRROR `health.ts` + the
  `pairing-codes.ts` admin gate).
- **IMPORTS**: `adminAuthorized` from `../auth.js`.
- **VALIDATE**: `npx tsc -b` exits 0.

#### Task B4 — UPDATE `apps/ingest/src/app.ts` (logger object + metrics wiring + options)
- **IMPLEMENT**: add `logLevel?`, `metrics?` to `BuildAppOptions`; change the `Fastify({ logger… })` call
  to the object form (level + redact) per the Patterns snippet; after the existing decorations, when
  `opts.metrics !== false`: `app.decorate("metrics", createMetrics(Date.now()))`, `registerMetricsHook(app)`,
  `app.register(metricsRoutes)`.
- **IMPORTS**: `import { createMetrics, registerMetricsHook } from "./metrics.js";` and
  `import metricsRoutes from "./routes/metrics.js";`.
- **GOTCHA**: decorate `metrics` BEFORE registering the hook (the hook reads `app.metrics`). Tests that
  pass `logger:false` are unaffected; tests that omit `metrics` get it enabled (harmless — they just have
  a counter). The `redact.remove:true` strips the auth/cookie headers entirely from any log line.
- **VALIDATE**: `npx tsc -b` exits 0.

#### Task B5 — UPDATE `apps/ingest/src/server.ts` (env → logLevel)
- **IMPLEMENT**: read `const logLevel = process.env.LOG_LEVEL ?? "info";` and pass `logLevel` into the
  `buildApp({...})` call. (metrics stays default-on.)
- **VALIDATE**: `npx tsc -b` exits 0.

### — 12.4c: Ingest rate limiting —

#### Task C1 — ADD `@fastify/rate-limit` dependency
- **IMPLEMENT**: `npm install -w @420ai/ingest @fastify/rate-limit@^11` (Spike A: v11 declares
  `"fastify":"^5.0.0"`, compatible with the installed Fastify 5.8.5).
- **VALIDATE**: `npm ls -w @420ai/ingest @fastify/rate-limit` resolves a single 11.x; `git diff` shows the
  dep added to `apps/ingest/package.json` + the lockfile updated.

#### Task C2 — UPDATE `apps/ingest/src/app.ts` (register rate-limit, opt-in)
- **IMPLEMENT**: add the `rateLimit?` option (Patterns snippet). When `opts.rateLimit` is set: register
  `@fastify/rate-limit` (`global: false`) and decorate `app.rateLimitLogin` with
  `opts.rateLimit.login ?? false`, BOTH **before** `app.register(authRoutes)` and the other routes. When
  unset: decorate `app.rateLimitLogin` = `false` (so the route config is valid either way) and skip the
  plugin.
- **IMPORTS**: `import rateLimit from "@fastify/rate-limit";` (static import compiles; verify).
- **GOTCHA**: registration order — rate-limit + the `rateLimitLogin` decoration must precede the route
  registrations so `routes/auth.ts`'s `config.rateLimit` resolves. Keep `global:false` so only the login
  route (and any route you opt in) is limited; the ingest hot path stays unthrottled unless you choose a
  generous global later.
- **VALIDATE**: `npx tsc -b` exits 0; existing `app.int.test.ts` still passes (no `rateLimit` opt → no
  throttling) — run in Task C5.

#### Task C3 — UPDATE `apps/ingest/src/routes/auth.ts` (login limit)
- **IMPLEMENT**: add `config: { rateLimit: app.rateLimitLogin }` to the `POST /v1/auth/login` route options
  (alongside `schema`). Leave the handler body unchanged.
- **GOTCHA**: `app.rateLimitLogin` is `false` when rate limiting is off → `@fastify/rate-limit` treats a
  falsy per-route config as "no limit", and with the plugin unregistered the `config` is simply ignored.
  Either way existing tests are unthrottled.
- **VALIDATE**: `npx tsc -b` exits 0.

#### Task C4 — UPDATE `apps/ingest/src/server.ts` (env → rateLimit)
- **IMPLEMENT**: read `RATE_LIMIT_GLOBAL_MAX` (default 1000), `RATE_LIMIT_WINDOW` (default `"1 minute"`),
  `RATE_LIMIT_LOGIN_MAX` (default 10), `RATE_LIMIT_LOGIN_WINDOW` (default `"15 minutes"`) — numbers via the
  existing `parsePositiveInt`. Pass `rateLimit: { global: { max, timeWindow }, login: { max, timeWindow } }`
  into `buildApp`. Allow a `RATE_LIMIT_ENABLED=false` escape hatch (omit the `rateLimit` opt when set
  false).
- **VALIDATE**: `npx tsc -b` exits 0.

#### Task C5 — CREATE `apps/ingest/src/observability.int.test.ts` (metrics + rate-limit)
- **IMPLEMENT**: MIRROR `app.int.test.ts` scaffold. `buildApp({ db, adminToken: ADMIN, analysisProvider:
  stubProvider, logger: false, rateLimit: { login: { max: 2, timeWindow: "1 minute" } } })`.
  Cases: (1) `GET /v1/metrics` without auth → 401; with `Bearer ADMIN` → 200 with `{requests, byStatusClass,
  uptimeSeconds}` and `requests >= 1`. (2) `GET /v1/health` then `GET /v1/metrics` → `byStatusClass["2xx"]`
  incremented. (3) POST `/v1/auth/login` 3× with a bad body/creds → the **3rd** returns **429** (login
  limit max:2). Seed a user if needed (MIRROR `auth.int.test.ts` `setUserPassword`), or just assert the
  429 fires on repeated calls regardless of cred validity (the limiter counts before the handler).
- **GOTCHA**: this test **adds a `buildApp` caller with `rateLimit`** — deliberate; it does not change the
  other callers. The limiter keys by `request.ip`; under `app.inject` the ip is stable, so repeated injects
  share the bucket (429 fires).
- **VALIDATE**: with the test DB up: `npx vitest run apps/ingest/src/observability.int.test.ts` → all pass,
  **0 skipped**.

### — 12.4d: Automated backup + retention —

#### Task D1 — CREATE `scripts/backup-archive.sh` + `scripts/restore-archive.sh`
- **IMPLEMENT**: the backup script per the Patterns snippet (pg_dump via `docker compose exec -T archive`,
  gzip, timestamped, `find -mtime` prune). The restore script:
  `gunzip -c "$1" | docker compose exec -T archive psql -U 420ai -d 420ai` with a `set -eu` + a usage
  guard (`[ $# -eq 1 ] || { echo "usage: sh scripts/restore-archive.sh <backup.sql.gz>"; exit 1; }`).
- **PATTERN**: POSIX `sh` (Git Bash). The compose service is `archive` (docker-compose.yml).
- **GOTCHA**: add `backups/` to `.gitignore` (dumps contain ciphertext + plaintext metadata — never
  commit). Make scripts executable is unnecessary on Windows; document `sh scripts/backup-archive.sh`.
- **VALIDATE**: with the stack up (`npm run db:up`): `BACKUP_DIR=./backups sh scripts/backup-archive.sh`
  writes a non-empty `backups/420ai-*.sql.gz`; `gunzip -t` on it succeeds; `rg "backups/" .gitignore` → 1.

#### Task D2 — ADD npm scripts + retention default
- **IMPLEMENT**: in root `package.json` scripts add `"backup": "sh scripts/backup-archive.sh"` and
  `"restore": "sh scripts/restore-archive.sh"`.
- **VALIDATE**: `npm run backup` (stack up) produces a dump; `git diff package.json` shows the two scripts.

#### Task D3 — DOCUMENT scheduling + (optional) row prune
- **IMPLEMENT**: in `docs/guide/operations.md` (created in Task Z1) document: a Windows Task Scheduler
  entry (and a cron line) calling `npm run backup` daily; the restore procedure; and an **optional**
  re-buildable-row prune (events/report_artifacts older than N days) — **default OFF**, with the
  `recordHeartbeat` prune (machines.ts:70–77) cited as the in-DB precedent IF the operator opts in. State
  clearly: **raw_source_records is NEVER pruned** (PRD §8.5 "raw sacred"; events/reports are re-buildable).
- **VALIDATE**: `rg "raw_source_records is never pruned|raw sacred" docs/guide/operations.md` → ≥1.

### — 12.4e: Encryption-key rotation —

#### Task E1 — REWRITE `packages/db/src/crypto.ts` (keyring) + barrel
- **IMPLEMENT**: replace the body with the keyring version per the Patterns snippet (Spike C). Keep
  `EncryptedField`, add `activeKeyId()`. **Preserve the two legacy error strings exactly.**
- **UPDATE** `packages/db/src/index.ts` line 23/24: also `export { activeKeyId }` from `./crypto.js`.
- **GOTCHA**: build the keyring per-call (the existing `crypto.test.ts` mutates `process.env` between
  cases). Single-key mode (only `ARCHIVE_ENCRYPTION_KEY`) emits **un-prefixed** ciphertext → byte-identical
  to today → existing tests + all existing rows + CI (single key) unaffected.
- **VALIDATE**: `npx tsc -b` exits 0; `npx vitest run packages/db/src/crypto.test.ts` → **all existing
  cases still pass unchanged**.

#### Task E2 — CREATE `packages/db/src/crypto-keyring.test.ts` (Spike C as a regression test)
- **IMPLEMENT**: the 8 keyring-mode assertions from the Spike C list (legacy round-trip + un-prefixed;
  legacy row decrypts under keyring; v2 prefix + round-trip; active-flip coexistence; rotation re-encrypt;
  unknown keyId throws; tamper throws). Set/clear `ARCHIVE_ENCRYPTION_KEYS` /
  `ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID` per case (save/restore in `finally`, like crypto.test.ts).
- **VALIDATE**: `npx vitest run packages/db/src/crypto-keyring.test.ts` → all pass.

#### Task E3 — CREATE `packages/db/src/repositories/key-rotation.ts` (+ barrel export)
- **IMPLEMENT**: `reencryptAll(db: Db): Promise<{ rawSourceRecords: number; events: number; gitCommits:
  number }>`. For each of the 3 encrypted trios, in batches: `select` rows whose ciphertext is NOT already
  under the active key (`where payload_ciphertext not like activeKeyId()+'.%'` — and for legacy/no-active
  skip), `decryptField` the trio, `encryptField` the plaintext, `update` the row's 3 columns by id.
  Wrap each table's pass in `db.transaction`. Skip NULL payloads (events/gitCommits nullable).
- **IMPORTS**: `encryptField, decryptField, activeKeyId` from `../crypto.js`; `rawSourceRecords, events,
  gitCommits` from `../schema.js`; `eq, like, isNotNull` from `drizzle-orm`.
- **UPDATE** `packages/db/src/index.ts`: `export { reencryptAll } from "./repositories/key-rotation.js";`.
- **GOTCHA**: only meaningful in **keyring mode** (active != legacy) — in single-key mode `activeKeyId()`
  is `"legacy"` and ciphertext is un-prefixed, so the `not like 'legacy.%'` filter would match every row
  and re-encrypt them to … still un-prefixed (no-op-ish). Guard: if `activeKeyId() === "legacy"`, throw
  `"rotation requires ARCHIVE_ENCRYPTION_KEYS + ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID (keyring mode)"`. Process
  in id-ordered batches (e.g. 500) to bound memory on large raw tables.
- **VALIDATE**: `npx tsc -b` exits 0.

#### Task E4 — CREATE `packages/db/src/rotate-key-cli.ts` + npm script + int test
- **IMPLEMENT**: entrypoint (MIRROR `migrate-cli.ts`): load `.env`, read `DATABASE_URL`, `createDb`, call
  `reencryptAll`, log per-table counts, `pool.end()`. Add `"db:rotate-key": "tsx src/rotate-key-cli.ts"` to
  `packages/db/package.json` and `"db:rotate-key": "npm run -w @420ai/db db:rotate-key"` to root.
- **CREATE** `packages/db/src/repositories/key-rotation.int.test.ts` (self-skips without
  `DATABASE_URL_TEST`): set keyring `{legacy:K1, v2:K2}`; ingest a batch under active=legacy (un-prefixed
  rows) using `ingestBatch`; flip active=v2; call `reencryptAll`; assert returned counts > 0; assert the
  raw rows' `payload_ciphertext` now start with `"v2."`; assert `decryptField` still returns the original
  plaintext. (MIRROR `ingest.int.test.ts` seeding.)
- **GOTCHA**: the int test manipulates `process.env.ARCHIVE_ENCRYPTION_KEYS` — save/restore around the test
  so it doesn't leak into other suites (vitest runs files in isolation, but restore anyway).
- **VALIDATE**: DB up: `npx vitest run packages/db/src/repositories/key-rotation.int.test.ts` → pass, 0
  skipped.

### — 12.4f: Migration rollback —

#### Task F1 — CREATE `packages/db/drizzle/down/NNNN_*.down.sql` for 0000–0009
- **IMPLEMENT**: for each `packages/db/drizzle/NNNN_*.sql`, create
  `packages/db/drizzle/down/NNNN_<same-name>.down.sql` reversing every statement in **reverse order** (see
  the two worked examples + the rule in Patterns). Use the SAME `--> statement-breakpoint` separators.
- **GOTCHA**: read each up file first (don't reverse from memory). `DROP INDEX` before `DROP TABLE`;
  `DROP COLUMN` undoes `ADD COLUMN`; `DROP TABLE` cascades its own FKs/constraints. For additive-column
  migrations (e.g. 0005 catalog/analysis version columns, 0009 password_hash) the down is `DROP COLUMN`.
- **VALIDATE**: 10 files exist (`ls packages/db/drizzle/down/`); each is non-empty; visually each reverses
  its up file. (Functionally validated in F4.)

#### Task F2 — CREATE `packages/db/src/rollback.ts`
- **IMPLEMENT**: `rollbackLast(connectionString, { downDir, journalPath })` per the Patterns snippet
  (Spike B: `drizzle.__drizzle_migrations`, `created_at = journal.when`, latest = desc limit 1, run down
  in a tx, delete the row).
- **IMPORTS**: `readFileSync` (`node:fs`), `Pool` (`pg`).
- **VALIDATE**: `npx tsc -b` exits 0.

#### Task F3 — CREATE `packages/db/src/rollback-cli.ts` + npm scripts
- **IMPLEMENT**: entrypoint per the Patterns snippet. Add `"db:rollback": "tsx src/rollback-cli.ts"` to
  `packages/db/package.json` and `"db:rollback": "npm run -w @420ai/db db:rollback"` to root.
- **VALIDATE**: `npx tsc -b` exits 0; `git diff` shows both scripts.

#### Task F4 — CREATE `packages/db/src/rollback.int.test.ts` (round-trip)
- **IMPLEMENT** (self-skips without `DATABASE_URL_TEST`): on a freshly-migrated test DB, query
  `drizzle.__drizzle_migrations` count = 10; call `rollbackLast(TEST_URL, {downDir, journalPath})`; assert
  it returns `{rolledBack:"0009_exotic_ben_grimm"}`; assert the `users.password_hash` column is gone
  (`select` it → throws / information_schema shows absent) and the tracking count is 9; then **re-apply**
  `runMigrations(TEST_URL)` and assert the column is back + count 10 (proves rollback is reversible and
  doesn't corrupt the journal table).
- **GOTCHA**: this test mutates the shared test DB schema — run it in isolation and **re-migrate at the
  end** so subsequent suites see the full schema. Because `repo-health --require-db` runs the whole suite,
  ensure the final state is fully-migrated (re-apply in an `afterAll`).
- **VALIDATE**: DB up: `npx vitest run packages/db/src/rollback.int.test.ts` → pass, 0 skipped; then a full
  `npm run db:migrate` confirms idempotent re-apply.

### — Cross-cutting docs/env (do as part of whichever sub-slice introduces each var) —

#### Task Z1 — CREATE `docs/guide/operations.md` + UPDATE `.env.example`
- **IMPLEMENT**: `operations.md` runbook with one section per item: required-check setup (12.4a), backups
  + restore + scheduling + the raw-never-pruned rule (12.4d), log level + `/v1/metrics` (12.4b), rate
  limits (12.4c), **key rotation procedure** (12.4e), **migration rollback procedure** (12.4f). In
  `.env.example` add (grouped, with comments mirroring the existing style):
  - `# --- 12.4b observability ---` `LOG_LEVEL=info`
  - `# --- 12.4c rate limiting ---` `RATE_LIMIT_ENABLED=true`, `RATE_LIMIT_GLOBAL_MAX=1000`,
    `RATE_LIMIT_WINDOW=1 minute`, `RATE_LIMIT_LOGIN_MAX=10`, `RATE_LIMIT_LOGIN_WINDOW=15 minutes`
  - `# --- 12.4d backups ---` `BACKUP_DIR=./backups`, `RETENTION_DAYS=14`
  - `# --- 12.4e key rotation (OPTIONAL keyring mode) ---` document that `ARCHIVE_ENCRYPTION_KEY` (single
    key) remains the default; to rotate, switch to `ARCHIVE_ENCRYPTION_KEYS={"legacy":"<old-b64>","v2":
    "<new-b64>"}` + `ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID=v2`, then `npm run db:rotate-key`. **Carry the old
    key in the keyring until rotation completes**, then it may be removed.
- **GOTCHA**: the key-rotation doc MUST state the order: (1) `npm run backup`, (2) add the new key to
  `ARCHIVE_ENCRYPTION_KEYS` + set active, (3) restart ingest, (4) `npm run db:rotate-key`, (5) verify, (6)
  optionally drop the old key. Never remove the old key before rotation finishes (un-rotated rows become
  undecryptable).
- **VALIDATE**: `rg "ARCHIVE_ENCRYPTION_KEYS|db:rotate-key|db:rollback" .env.example docs/guide/operations.md`
  shows the vars + commands; `npx tsc -b` unaffected.

#### Task Z2 — Full gate (run per sub-slice + once at the end)
- **VALIDATE**: `npm run db:up && npm run db:migrate && npm run repo-health -- --require-db` → PASS with the
  int layer actually running (**0 skipped**), including the new `observability.int.test.ts`,
  `key-rotation.int.test.ts`, and `rollback.int.test.ts`. (The test DB must be migrated — per memory, the
  `420ai_test` DB is migrated separately: `DATABASE_URL=$DATABASE_URL_TEST npm run db:migrate` if needed.)

---

## TESTING STRATEGY

### Unit Tests
- `apps/ingest/src/metrics.test.ts` — counter store init + increment math.
- `packages/db/src/crypto.test.ts` — **must pass UNCHANGED** (single-key back-compat regression).
- `packages/db/src/crypto-keyring.test.ts` — the 8 Spike-C keyring assertions.

### Integration Tests (self-skip without `DATABASE_URL_TEST`; must run 0-skipped under `--require-db`)
- `apps/ingest/src/observability.int.test.ts` — `/v1/metrics` gating + counting; login 429 under a strict
  `rateLimit` opt.
- `packages/db/src/repositories/key-rotation.int.test.ts` — ingest under legacy → flip active → `reencryptAll`
  → rows now `v2.`-prefixed and still decrypt to the original plaintext.
- `packages/db/src/rollback.int.test.ts` — migrate → rollback last (0009) → column gone, tracking row gone
  → re-migrate restores it (idempotent).
- **Existing** `app.int.test.ts` / `auth.int.test.ts` / `ingest.int.test.ts` / catalog/git/exports — **must
  still pass unchanged** (regression guard: optional opts preserved back-compat; keyring single-key mode
  byte-identical).

### Edge Cases (must be covered)
- Single-key deployment (no keyring env) → crypto output un-prefixed, all existing rows decrypt, error
  strings unchanged. (crypto.test.ts.)
- Rotation in single-key mode → `reencryptAll` throws a clear "keyring mode required" error (no silent
  no-op). (E3 guard.)
- Rollback with **no applied migrations** → `{rolledBack:null, reason:"no applied migrations"}`, CLI exits
  1 (doesn't crash). (rollback.ts.)
- Rate limiting **off** (no `opts.rateLimit`) → no throttling; the login route's `config.rateLimit:false`
  is harmless. (Existing int tests are the proof.)
- Backup retention prune removes only `420ai-*.sql.gz` older than `RETENTION_DAYS` (scoped glob, not a
  blanket delete). (D1 manual.)
- Metrics counters reset on restart — documented in the `/v1/metrics` payload (`uptimeSeconds`).

---

## VALIDATION COMMANDS

All from the repo root. **`repo-health` is the gate** (root `tsc -b` + dashboard/desktop typecheck lanes +
full `vitest` + NUL/stray scans). The dashboard/desktop are untouched this slice but their lanes still run.

### Level 1: Syntax & Style
- `npm run typecheck` → exit 0 (root `tsc -b`, the 4 backend workspaces).

### Level 2: Unit Tests
- `npx vitest run apps/ingest/src/metrics.test.ts packages/db/src/crypto.test.ts
  packages/db/src/crypto-keyring.test.ts` → all pass (note crypto.test.ts must be **unchanged**).

### Level 3: Integration Tests (DB up)
- `npm run db:up && npm run db:migrate` (and migrate the test DB per memory note if needed).
- `npm run repo-health -- --require-db` → PASS, **0 int tests skipped** (asserts the 3 new int suites +
  all existing ones ran against Postgres).

### Level 4: Manual Validation (live stack)
1. **Observability:** `LOG_LEVEL=debug npm run ingest:dev` → logs are structured JSON at debug level; hit
   any endpoint with `Authorization: Bearer …` → confirm the bearer is **absent** from the log line
   (`redact`). `curl -s localhost:8420/v1/metrics -H "authorization: Bearer $ADMIN_TOKEN"` → 200 JSON with
   `requests`, `byStatusClass`, `uptimeSeconds`; without the header → 401.
2. **Rate limit:** with `RATE_LIMIT_LOGIN_MAX=2`, `curl -X POST localhost:8420/v1/auth/login …` 3× →
   the 3rd returns **429** with a `retry-after` header.
3. **Backup/restore:** `npm run backup` → a `backups/420ai-*.sql.gz` appears; `gunzip -t` it; (optionally)
   restore into a scratch DB and `select count(*) from raw_source_records`.
4. **Key rotation:** set `ARCHIVE_ENCRYPTION_KEYS={"legacy":"<cur>","v2":"<new>"}` +
   `ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID=v2`, restart ingest, `npm run db:rotate-key` → prints per-table
   counts; verify a previously-stored session still renders (decrypt-for-render path works).
5. **Rollback:** `npm run db:rollback` → prints `rolled back: 0009_exotic_ben_grimm`; `npm run db:migrate`
   re-applies it. (Do this on the test DB, not a DB with real data — or back up first.)
6. **CI required check:** confirm a failing PR cannot merge (Task A2).

### Level 5: Build gate
- `npm run repo-health` (full) → PASS. (`build:dashboard` not required — dashboard untouched.)

---

## ACCEPTANCE CRITERIA

- [ ] **12.4a:** `repo-health` is a **required** status check on `main` (public-repo branch protection); a
      failing PR is blocked from merging; the SUMMARY "never merge red" honor-system note is retired.
- [ ] **12.4b:** ingest logs are structured with an env-tunable `LOG_LEVEL` and **never** emit the
      `authorization`/`cookie` headers (redacted); `GET /v1/metrics` is admin-gated and returns request /
      status-class / uptime counters.
- [ ] **12.4c:** `@fastify/rate-limit@^11` is registered (opt-in via `opts.rateLimit`); `POST /v1/auth/login`
      returns **429** past its limit; the ingest contract is otherwise unchanged; existing tests unthrottled.
- [ ] **12.4d:** `npm run backup` writes a gzipped, timestamped `pg_dump`; backups older than
      `RETENTION_DAYS` are pruned; a restore path is documented; **raw_source_records is never pruned**.
- [ ] **12.4e:** `crypto.ts` is a keyring; a legacy single-key deployment is byte-for-byte unchanged
      (crypto.test.ts unchanged); `npm run db:rotate-key` re-encrypts all encrypted rows under the active
      key and they still decrypt; `EncryptedField` shape + the 6 call sites are unchanged; **no schema
      migration** added for rotation.
- [ ] **12.4f:** `down/NNNN_*.down.sql` exists for 0000–0009; `npm run db:rollback` reverses the latest
      migration (down SQL in a tx + tracking-row delete) and a subsequent `db:migrate` re-applies it.
- [ ] No new npm dependency beyond `@fastify/rate-limit`; the 7 existing `buildApp` callers are unchanged.
- [ ] `npm run repo-health -- --require-db` PASSES with **0 int tests skipped** (3 new int suites ran).

## COMPLETION CHECKLIST

- [ ] Each sub-slice (12.4a–f) committed/PR'd separately; each green on its own gate.
- [ ] Unit + integration suites green (int layer actually ran against Postgres, 0 skipped).
- [ ] No typecheck errors (root `tsc -b`; dashboard/desktop lanes unaffected).
- [ ] Manual checks (metrics/redaction, login 429, backup+restore, rotate-key, rollback, required check)
      verified on the live stack.
- [ ] `.env.example` + `docs/guide/operations.md` written; `SUMMARY.md`/`PRD.md` 12.4 marked done at
      sign-off; `backups/` gitignored.
- [ ] No new long-lived server resource introduced (backups/rollback/rotation are ops scripts, not
      daemons; metrics is an in-memory counter + an `onResponse` hook — no timer; M9 leak discipline holds).

---

## NOTES

### Design decisions (and why)
- **Sub-sliced, not monolithic.** Six independent ops items → six PRs (mirrors 12.2a/12.2b). Order puts the
  backup safety-net (12.4d) before the two destructive capabilities (rotation 12.4e, rollback 12.4f).
- **Key-versioning rides in the ciphertext string, not a new column.** This was the pivotal choice: it
  keeps `EncryptedField`'s shape, so the **3 write + 3 read sites and the schema are untouched** — the
  smallest possible blast radius on the load-bearing crypto path. A dedicated `*_key_id` column would have
  been more queryable but touched the schema + every read SELECT + the int-test reads. The rotation CLI
  finds un-rotated rows with a `NOT LIKE 'v2.%'` scan instead (rotation re-encrypts everything anyway).
- **Single-key mode stays byte-identical.** Legacy (`ARCHIVE_ENCRYPTION_KEY` only) deployments emit
  un-prefixed ciphertext and the same error strings → zero migration, zero behavior change, CI unaffected.
  Versioning is **opt-in** (set `ARCHIVE_ENCRYPTION_KEYS`).
- **Rate-limit + metrics + log config are optional `buildApp` opts with safe defaults.** Rate limiting is
  **off unless opted in**, so the 7 existing callers and every existing int test run unthrottled — only
  `server.ts` and the one new int test enable it. (Same discipline 12.3 used for `sessionSecret`.)
- **Backups + rollback + rotation are entrypoint scripts, not server code.** Honors CLAUDE.md's
  process-boundary rule (only entrypoints log/argv/exit) and adds **no long-lived resource** (no in-server
  scheduler — scheduling is OS cron / Task Scheduler, documented).
- **JSON `/v1/metrics`, not Prometheus.** Per the scope decision — a single-user self-hosted box isn't
  running a Prometheus scraper; a readable admin-gated JSON snapshot is the right altitude. `prom-client`
  would be dead weight.
- **Down-migrations are hand-authored + destructive.** Drizzle has no down support; the runbook makes
  "back up first" (12.4d) the precondition for a rollback. The CLI mutates `drizzle.__drizzle_migrations`
  by `created_at` (= journal `when`), the key Drizzle itself uses.

### PRE-FLIGHT SPIKES ACTUALLY RUN DURING PLANNING (results folded in above)
- **Spike A — external facts (run):** `gh repo view --json visibility` → `seanrobertwright/420AI`,
  **`PUBLIC`** (so branch protection / required checks are free — reshapes 12.4a). `@fastify/rate-limit`
  `11.0.0`/`11.3.0` and `10.3.0` all declare `"fastify":"^5.0.0"` (registry check) → compatible with the
  repo's Fastify `5.8.5`; **plan pins `^11`.** `docker compose version` → present (backup path viable).
- **Spike B — Drizzle migration tracking (read installed source `drizzle-orm/pg-core/dialect.cjs`):** the
  table is **`drizzle.__drizzle_migrations` (`id SERIAL PRIMARY KEY, hash text NOT NULL, created_at
  bigint`)**; one row inserted per applied migration with `created_at = migration.folderMillis` (= the
  `_journal.json` entry's `when`); "latest applied" = `select … order by created_at desc limit 1`. ⇒ the
  `rollback.ts` snippet is built on the real table shape, not a guess.
- **Spike C — keyring crypto round-trip (ran a throwaway `node` script, 13/13 PASS, deleted):** legacy
  single-key round-trips and emits **un-prefixed** ciphertext (byte-compat); a legacy row decrypts after
  upgrading to keyring mode; keyring active=v2 prefixes `v2.` and round-trips; an active=legacy field still
  decrypts after the active flips to v2; decrypt→re-encrypt rotation yields a v2 field that round-trips;
  unknown keyId throws `no encryption key for keyId "v9"`; the two legacy error strings are preserved;
  tamper still throws. ⇒ the `crypto.ts` snippet IS the proven code; `crypto-keyring.test.ts` is this spike
  as a permanent test.

### Symbols / harness verified by reading source (not memory)
`buildApp`/`BuildAppOptions`/`app.decorate`/the error handler + plugin-register order (`app.ts:31–122`);
`server.ts` env reads + `parsePositiveInt` + the `buildApp({...})` call (whole file); the
`declare module "fastify"` augmentation (`plugins/auth.ts:9–31`); `adminAuthorized` (`auth.ts`); the
`health.ts` route shape; `encryptField`/`decryptField`/`key()`/`EncryptedField` (`crypto.ts`) + the 3
write sites (`ingest.ts:33,59`, `git.ts:35`) + the 3 read sites (`attribution.ts:95`, `search.ts:205`,
`transcript.ts:112`); the `@420ai/db` barrel (`index.ts:23–24`); the encrypted schema trios
(`schema.ts:108–110,149–151,~326–328`); `recordHeartbeat`'s prune precedent (`machines.ts:11,70–77`);
`migrate.ts`/`migrate-cli.ts`/`client.ts` (the entrypoint MIRROR + `createDb→{db,pool}`); the migration
file format + `--> statement-breakpoint` (`0004`, `0009`) + `_journal.json` (version 7, 10 entries); the
int-test scaffold (`app.int.test.ts:47–94`, `auth.int.test.ts` seeding); the CI workflow + `repo-health.mjs`
`--require-db` 0-skipped assertion; `docker-compose.yml` service name `archive`; the existing `.env.example`
structure.

### Residual risk (named; below-floor items retired)
- **`@fastify/rate-limit` per-route `config.rateLimit` timing.** The one piece not executable-spiked (it
  needs the running plugin). Mitigation: the plan registers the plugin + decorates `app.rateLimitLogin`
  **before** route registration (the documented requirement), and `observability.int.test.ts` asserts the
  **429** live — so the executor proves it in-loop. If `config.rateLimit` via a decoration proves finicky,
  the fallback is to set the login limit inline in `routes/auth.ts` from a captured `opts` closure (the
  app.ts registration already has `opts.rateLimit` in scope).
- **Authoring 10 down-migrations is laborious** (not risky — mechanical). The two worked examples + the
  reverse-order rule + `rollback.int.test.ts` (which exercises at least 0009) bound the risk; the executor
  should spot-check 1–2 more by applying `db:rollback` repeatedly on the test DB if time allows.
- **Backup verification depends on Docker being up** — the manual restore check is gated on the live stack;
  CI does not run `pg_dump` (it uses the Actions Postgres service, not compose).

### Confidence
**9.4 / 10** for one-pass success **executed sub-slice by sub-slice** (the intended mode). The single
genuinely-risky item (key-versioning crypto, 12.4e) is spike-proven 13/13 with the snippet being the exact
proven code; the rollback engine (12.4f) is built on the verified `__drizzle_migrations` shape; rate-limit
compatibility + repo visibility are registry/CLI-confirmed; every edit target was read at the source and
the blast radius is minimized by additive options + ciphertext-embedded keyId (no schema/read-site churn).
The deductions keeping it from 9.7: the un-spiked `@fastify/rate-limit` per-route wiring (mitigated by a
live 429 int test + a stated fallback) and the manual, laborious down-migration authoring.
