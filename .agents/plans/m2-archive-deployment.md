# Feature: Milestone 2 — Archive Deployment (Postgres + migrations + Ingest API + pairing + field-level encryption)

The following plan should be complete, but it is important that you **validate documentation and
codebase patterns and task sanity before you start implementing**. Read the M1 code first — M2
extends the exact same conventions (ESM + NodeNext, `kebab-case.ts`, strict TS, vitest, "raw records
sacred / events disposable", the deterministic fingerprint). Do **not** change the M1 fingerprint
formula or the normalized token/event shapes — M2 sends those same shapes over the wire and persists
them in Postgres. Everything downstream depends on them being stable.

Pay special attention to two new load-bearing contracts introduced here: the **ingest wire payload**
(`packages/shared`) and the **ciphertext-vs-plaintext column split** (`packages/db`). Both are
expensive to change after real data exists — get the column boundaries right per PRD §18.1.

## Feature Description

M1 proved the thinnest pipe end-to-end *locally* (Claude Code JSONL → `node:sqlite` → Markdown
report). M2 graduates the local SQLite "mirror of the future archive" into the **real Central
Archive**: a self-hosted PostgreSQL database (Docker), a typed schema with versioned migrations
(Drizzle), a **dedicated Ingest API** (Fastify) that authenticates machines per-token, validates and
**idempotently** writes batches, applies **field-level encryption to sensitive payloads at the
ingest boundary**, and the **collector pairing flow** that registers a machine and issues a
revocable ingest token. A thin `collector push` command sends an already-parsed session to the API,
proving the pipe now reaches a server.

This implements PRD §8.2 (Central Archive), §8.3 (Ingest API), §18 + §18.1 (field-level encryption
from day one), §19 (onboarding/pairing), §20 (the `health` surface), and §23 (upsert-by-fingerprint
on the server). It is SUMMARY.md §3 milestone 2 ("Archive deployment: Docker Supabase, migrations,
ingest API, pairing flow").

**Explicitly deferred to later milestones** (do NOT build in M2): the durable queue + per-file
cursors + connector framework (M3); Codex/Gemini connectors (M4); project/workspace mapping (M5);
event projections — sessions/usage/cost/git tables (M6); reports (M7); redaction pipeline + AI
analysis (M8); the Next.js dashboard, Supabase Studio, and the pairing **UI** (later). M2 stands up
the server side and the minimal collector affordance to exercise it.

## User Story

As an AI-heavy developer setting up the platform on my Windows machine,
I want to start a local Postgres archive, pair my collector to it with a short-lived code, and push a
captured Claude Code session through an authenticated ingest API that stores it durably with
sensitive content encrypted at rest,
So that my session data leaves the fragile vendor file and lands in a durable, queryable,
multi-machine-capable archive — the foundation every later report and projection reads from.

## Problem Statement

After M1, captured data lives only in a local `*.sqlite` file on one machine. There is no server, no
authentication, no cross-machine archive, no durability story, and no encryption — the PRD's Central
Archive (§8.2), Ingest API (§8.3), pairing flow (§19), and field-level encryption (§18.1) do not
exist yet. The SQLite schema was deliberately built as a *mirror* of the eventual Postgres schema; M2
must realize that real schema and put a secure, idempotent network boundary in front of it.

## Solution Statement

Two new workspaces plus extensions to the two existing ones:

1. **`packages/db`** (NEW) — the archive data layer. Drizzle schema (Postgres), the typed db client
   (`pg` Pool + `drizzle()`), programmatic + CLI migrations (drizzle-kit), the **AES-256-GCM
   field-encryption helper** (key from env, never in the DB), and repository functions (pairing,
   machines, tokens, idempotent batch ingest). Imported by the ingest API and (later) the dashboard.
2. **`apps/ingest`** (NEW) — a standalone **Fastify** service exposing `POST /v1/pair`,
   `POST /v1/ingest` (bearer-token authed), `GET /v1/health`, and a temporary admin-gated
   `POST /v1/pairing-codes` (the dashboard replaces it later). It validates payloads with Fastify's
   native JSON-schema, encrypts sensitive fields via `packages/db`, and upserts by fingerprint.
3. **`packages/shared`** (EXTEND) — add the pure **ingest wire types** (batch, raw/event payloads,
   pairing request/response) shared by collector and server. No behavior change to existing exports.
4. **`apps/collector`** (EXTEND) — add a tiny ingest HTTP client and two CLI commands: `pair <code>`
   and `push <file>`. No durable queue yet (M3) — `push` is a direct `fetch` that fails loudly.

Infra: a `docker-compose.yml` running `postgres:17` plus a separate test database, an
`.env.example`, and a README "Development (Milestone 2)" section.

## Feature Metadata

**Feature Type**: New Capability (introduces the project's first database, network service, auth, and crypto)
**Estimated Complexity**: High
**Primary Systems Affected**: NEW `packages/db`, NEW `apps/ingest`; EXTEND `packages/shared`, `apps/collector`; NEW infra (`docker-compose.yml`, `.env.example`)
**Dependencies** (exact versions verified together in PRE-FLIGHT): Docker (Postgres 17). npm: `drizzle-orm@^0.45.2`, `drizzle-kit@^0.31.10`, `pg@^8.21.0`, `@types/pg@^8.20.0`, `dotenv@^17.4.2`, `fastify@^5.8.5`, `fastify-plugin@^6.0.0`, `@testcontainers/postgresql@^12` (test-only, optional — see Testing). Node 24 built-ins: `node:crypto` (AES-GCM), global `fetch`.

---

## PRE-FLIGHT VERIFICATION (a full throwaway spike was EXECUTED on this machine — these risks are RETIRED with evidence)

A disposable 4-workspace monorepo (`shared`/`db`/`ingest`, the exact configs from this plan) was
scaffolded against a disposable `postgres:17` container and **run end-to-end** before finalizing.
Every integration the plan depends on was proven, not assumed. The spike is destroyed; the evidence
stands. (Reproduce by re-scaffolding the files below — the executor should NOT re-run it.)

1. **Environment — VERIFIED.** `node v24.16.0`, `npm 11.13.0`, `Docker 29.5.2` (daemon running),
   `Docker Compose v5.1.4`; `typeof fetch === "function"`; `crypto.getCiphers()` includes
   `aes-256-gcm`. All NEW paths (`docker-compose*`, `.env*`, `packages/db`, `apps/ingest`) are
   unoccupied in the real repo — no collisions.
2. **Exact versions — VERIFIED & PINNED (two plan guesses were WRONG and are corrected below).**
   Resolved + installed cleanly together: `drizzle-orm@0.45.2` (plan originally guessed 0.44),
   `drizzle-kit@0.31.10`, `pg@8.21.0`, `@types/pg@8.20.0`, **`fastify-plugin@6.0.0` (plan originally
   guessed 5 — fastify-plugin is a MAJOR ahead of Fastify itself)**, `fastify@5.8.5`,
   `dotenv@17.4.2`. The dependency lists in Tasks 2/9 + Feature Metadata now carry these exact pins.
3. **TS toolchain composes — VERIFIED.** `tsc -b` across all 4 workspaces under
   `module/moduleResolution: NodeNext` + `verbatimModuleSyntax` exited **0** with drizzle-orm, pg,
   fastify, and fastify-plugin imported and `@420ai/*` resolved through project references. → Risk
   "ESM/NodeNext glue with these libs" closed.
4. **Drizzle generate → migrate → onConflict idempotency — VERIFIED (the core mechanic).**
   `drizzle-kit generate` produced exactly the 6-table schema (events = 17 cols incl. the
   `payload_{ciphertext,iv,tag}` triple + `jsonb` tokens/cost, the `raw_machine_connector_record`
   unique index, FKs). Programmatic `migrate()` applied it. `ingestBatch` then ran **twice** with the
   identical batch: first = `{recordsInserted:2, eventsUpserted:3}`, second = `{recordsInserted:0,...}`,
   and the table row counts stayed `raw=2 / events=3` — i.e. `onConflictDoNothing` (raw) +
   `onConflictDoUpdate(fingerprint)` (events) are idempotent exactly as PRD §23 requires. → Risk
   "Drizzle upsert spelling / idempotency" closed.
5. **Field-level encryption at rest — VERIFIED.** Stored `payload_ciphertext` contained no plaintext
   (`"claude-opus"` absent), `decryptField` round-tripped it back to the exact original line, and
   `tokens->>'total'`/`cost->>'usd'` were queryable in plaintext via JSONB — confirming the §18.1
   ciphertext-vs-plaintext split end-to-end. Unit tests also proved AES-GCM round-trip (ascii/unicode/
   50KB), fresh-IV-per-call, **tamper-on-tag throws**, and short-key throws. → Risk "AES-GCM column
   encryption" closed.
6. **Fastify v5 + fastify-plugin v6 wiring — VERIFIED.** `buildApp(deps)` with an `fp()` auth plugin
   that `decorateRequest("machineId")` + `decorate("authenticate")`, a route whose `preHandler` defers
   to `app.authenticate`, and native JSON-schema body validation: `app.inject()` returned **200**
   (health + authed ingest with `machineId` attached), **401** (missing token, bad token), and **400**
   (malformed body) — all five assertions green. → Risk "Fastify plugin/decorator ordering + inject"
   closed.
7. **vitest globalSetup + skipIf harness — VERIFIED.** With `DATABASE_URL_TEST` set: globalSetup ran
   migrations and all 10 tests passed (3 files). With `DATABASE_URL_TEST=""`: the `*.int.test.ts`
   self-skipped (9 passed / 1 skipped) while unit suites stayed green — proving `npm test` works
   **with or without Docker**. → Risk "Postgres test harness / skip wiring" closed.

**API CORRECTIONS the spike surfaced (apply these — they differ from prose written before the spike):**
- **`fastify-plugin` is `^6.0.0`** (not `^5`). It tracks one major ahead of Fastify v5.
- **Drizzle table extra-config callback returns an ARRAY in 0.45**, not an object:
  `pgTable("t", {...}, (t) => [ uniqueIndex("..").on(t.a, t.b), index("..").on(t.c) ])`. The older
  `(t) => ({ name: ... })` object form is deprecated. Tasks below use the array form.
- `db.execute(sql\`...\`)` (node-postgres driver) returns a pg result — read rows via `.rows`.

**Residual risk (cannot retire before execution):** only the genuine first-write of the *real*
product code (mapping `ParseResult` → wire batch in `collector push`, the pairing transaction wiring,
the exact admin-token route) — every reusable mechanic underneath it is now proven on this machine.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — IMPORTANT: YOU MUST READ THESE BEFORE IMPLEMENTING!

- `.agents/plans/m1-walking-skeleton-claude-code.md` — Why: the house style for this plan AND the
  conventions (ESM/NodeNext, naming, test layout, "patterns defined by the plan become repo
  conventions"). M2 mirrors it.
- `packages/shared/src/events.ts` — Why: `NormalizedEvent`, `RawSourceRecord`, `EventType` are the
  shapes the wire payloads and the `events`/`raw_source_records` tables persist. Read field-for-field.
- `packages/shared/src/tokens.ts` (`NormalizedTokens`) and `packages/shared/src/cost.ts`
  (`CostResult`, `CostConfidence`) — Why: stored as plaintext `jsonb` columns (token counts + costs
  are queryable plaintext per §18.1); the wire payload carries them verbatim.
- `packages/shared/src/fingerprint.ts` — Why: the **server upserts events by this exact fingerprint**
  (PRD §23). Do NOT change the formula or add machine_id to it — the fingerprint is intentionally
  machine-independent so the same logical event dedups to one row across machines.
- `apps/collector/src/store/sqlite-store.ts` — Why: the M1 SQLite schema + `INSERT OR IGNORE` (raw) /
  `ON CONFLICT(fingerprint) DO UPDATE` (events) is the **exact behavior** the Postgres repository
  must reproduce. The Postgres schema is the Postgres translation of these two tables plus the new
  entity tables (users/machines/pairing_codes/ingest_tokens).
- `apps/collector/src/connectors/claude-code.ts` (`parseClaudeCodeSession`, `ParseResult`,
  `CLAUDE_CODE_CONNECTOR`, `PARSER_VERSION`) — Why: `collector push` reuses this verbatim to produce
  the batch; raw-record `id` (claude `uuid` or `${session}:${line}`) becomes the wire
  `sourceRecordId`.
- `apps/collector/src/cli.ts` — Why: extend this CLI (the only place allowed to log/exit/read argv);
  mirror its `getFlag`, `runIngest`/`runReport` "pure function + thin main()" split for `push`/`pair`.
- `docs/PRD.md` §8.2/§8.3 (archive + ingest), §13 (cost/token shapes stored), §18/§18.1 (encryption
  boundary — read the encrypt vs plaintext lists carefully), §19 (pairing onboarding), §20 (health),
  §23 (upsert-by-fingerprint) — Why: the spec for every M2 decision.
- `docs/CONTEXT.md` (Central Archive, Ingest API, Ingest Token, Collector Pairing, Local Durable
  Queue, Event Fingerprint, Archive Schema) — Why: canonical terminology; name code after these.
- `.gitignore` — Why: already ignores `.env`, `.env.*` (keeps `!.env.example`), `*.pem`, `*.key`,
  `secrets/`, `supabase/.branches|.temp`, `**/volumes/db/data/`, `dist/`, `*.tsbuildinfo`. The
  encryption key and DB URL live in `.env` (ignored); only `.env.example` is committed.
- `vitest.config.ts`, `tsconfig.base.json`, `tsconfig.json`, root `package.json` — Why: you will add
  references/aliases/scripts for the two new workspaces here, following the existing pattern exactly.

### New Files to Create

```
docker-compose.yml                               # postgres:17 (archive + a test DB)
.env.example                                     # documents required env (committed)
packages/db/
  package.json                                   # "@420ai/db", type module, deps: drizzle-orm, pg, dotenv
  tsconfig.json                                  # extends base, references ../shared
  drizzle.config.ts                              # drizzle-kit config (schema, out, dialect, dbCredentials)
  src/index.ts                                   # barrel: schema, client, crypto, repositories, types
  src/schema.ts                                  # Drizzle pgTable definitions (6 tables)
  src/client.ts                                  # Pool + drizzle() factory (createDb)
  src/crypto.ts                                  # AES-256-GCM encryptField/decryptField + EncryptedField
  src/tokens.ts                                  # generateToken/hashToken (ingest token helpers)
  src/migrate.ts                                 # programmatic migrate() runner (used by CLI + tests)
  src/repositories/pairing.ts                    # createPairingCode, redeemPairingCode
  src/repositories/machines.ts                   # createMachine, touchLastSeen
  src/repositories/tokens.ts                     # issueIngestToken, findMachineIdByToken (hash lookup)
  src/repositories/ingest.ts                     # ingestBatch (encrypt + idempotent upsert, in a tx)
  src/crypto.test.ts                             # round-trip + tamper-detection (NO db)
  src/tokens.test.ts                             # token hashing determinism + uniqueness (NO db)
  src/repositories/ingest.int.test.ts            # idempotent upsert + encryption-at-rest (needs PG)
  src/repositories/pairing.int.test.ts           # pair lifecycle (needs PG)
  drizzle/                                        # GENERATED migration SQL (committed) — Task 6
packages/shared/
  src/ingest.ts                                  # NEW: wire types (IngestBatch, RawRecordPayload, EventPayload, PairRequest, PairResponse)
  src/ingest.test.ts                             # NEW: type-guard/shape helper tests if any helpers added
apps/ingest/
  package.json                                   # "@420ai/ingest", type module, deps: fastify, fastify-plugin, @420ai/db, @420ai/shared, dotenv
  tsconfig.json                                  # extends base, references ../../packages/{shared,db}
  src/app.ts                                     # buildApp(): Fastify instance (NO listen) — testable via inject
  src/server.ts                                  # entrypoint: import 'dotenv/config'; buildApp().listen()
  src/plugins/auth.ts                            # fastify-plugin: bearer → machineId decorator
  src/routes/pairing-codes.ts                    # POST /v1/pairing-codes (admin-token gated)
  src/routes/pair.ts                             # POST /v1/pair
  src/routes/ingest.ts                           # POST /v1/ingest (authed)
  src/routes/health.ts                           # GET /v1/health
  src/schemas.ts                                 # JSON schemas for request bodies (Fastify validation)
  src/app.int.test.ts                            # e2e via app.inject(): pair → push → idempotency → 401 (needs PG)
apps/collector/
  src/ingest-client.ts                           # NEW: postPair(), postIngest() using global fetch
  src/ingest-client.test.ts                      # NEW: client builds correct request (fetch mocked)
```

### Files to MODIFY

```
tsconfig.json                # add { "path": "./packages/db" } and { "path": "./apps/ingest" } references
vitest.config.ts             # add @420ai/db alias to source; add globalSetup + dotenv load + fileParallelism:false
package.json (root)          # add scripts: db:up, db:down, db:generate, db:migrate, ingest:dev
apps/collector/src/cli.ts    # add `pair` and `push` commands + runPair/runPush exported functions
apps/collector/package.json  # add dependency "@420ai/shared":"*" already present; no new runtime deps (uses global fetch)
README.md                    # add "Development (Milestone 2)" section
.gitignore                   # (verify only) — already covers .env / secrets; add `!packages/db/drizzle/` if needed so migrations ARE committed
```

### Relevant Documentation — read before implementing

- **Drizzle ORM — PostgreSQL (node-postgres) get-started**: https://orm.drizzle.team/docs/get-started/postgresql-new
  - Why: exact install set, `drizzle.config.ts` shape, `drizzle()` + `Pool` client, schema with `pgTable`.
- **Drizzle Kit — migrate**: https://orm.drizzle.team/docs/drizzle-kit-migrate
  - Why: `generate` (emits SQL into `out`), `migrate` (applies + tracks in `__drizzle_migrations`),
    and **programmatic** `migrate()` from `drizzle-orm/node-postgres/migrator`.
- **Drizzle — insert / on-conflict**: https://orm.drizzle.team/docs/insert#on-conflict-do-update and `#on-conflict-do-nothing`
  - Why: `.onConflictDoUpdate({ target, set })` (events) and `.onConflictDoNothing({ target })` (raw)
    reproduce M1's idempotency. Use `.returning()` to count actually-inserted rows.
- **Fastify v5 — Getting started + TypeScript**: https://fastify.dev/docs/latest/Reference/TypeScript/ and https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/
  - Why: ESM app construction, route `schema` for native JSON-schema body validation, `app.inject()`.
- **@fastify/bearer-auth** (reference pattern only): https://github.com/fastify/bearer-auth
  - Why: shows the onRequest bearer hook + constant-time compare idea. We write a **custom**
    fastify-plugin instead (tokens are DB-backed + must attach `machineId`), but mirror its 401 shape.
- **fastify-plugin**: https://github.com/fastify/fastify-plugin — Why: correct plugin encapsulation so the auth decorator is visible to routes.
- **Node `node:crypto` Cipher (AES-GCM)**: https://nodejs.org/docs/latest-v24.x/api/crypto.html#class-cipher
  - Why: `createCipheriv("aes-256-gcm", key, iv)`, `cipher.getAuthTag()`, `decipher.setAuthTag()`;
    GCM `final()` throws on tampered tag (this is the integrity check we test).
- **@testcontainers/postgresql**: https://node.testcontainers.org/modules/postgresql/ — Why: optional hermetic Postgres for tests (see Testing Strategy for the chosen approach).
- **Node 24 `--env-file`**: https://nodejs.org/docs/latest-v24.x/api/cli.html#--env-fileconfig — Why: native env loading alternative to dotenv where convenient.

### Patterns to Follow (extend the M1 conventions — do not invent new ones)

**Module system / TS:** ESM everywhere, `"type": "module"`, `module/moduleResolution: NodeNext`,
`verbatimModuleSyntax: true`, `composite: true`. **Relative imports use explicit `.js`** (e.g.
`import { encryptField } from "./crypto.js"`). **Type-only imports use `import type`** (verbatim
module syntax enforces it). New workspaces extend `../../tsconfig.base.json` with `outDir: "dist"`,
`rootDir: "src"`, and `references` to their dependency workspaces.

**Naming:** files `kebab-case.ts`; types/interfaces `PascalCase`; functions/vars `camelCase`; SQL
table + column names `snake_case` (Drizzle maps `camelCase` TS keys → explicit `snake_case` column
strings — always pass the snake_case name to the column builder, e.g. `text("source_connector")`).
Package names `@420ai/<name>`. Route paths versioned under `/v1/...`.

**No logging in libraries:** `packages/db` and `packages/shared` never write to stdout/stderr.
`apps/ingest` logs only via Fastify's logger (`app.log.*`). `apps/collector/src/cli.ts` remains the
only collector file that writes to stdout/exits (extend its existing `try/catch` + `process.exit(1)`).

**Drizzle client (from official docs):**
```ts
// packages/db/src/client.ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>["db"];
export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  const db = drizzle({ client: pool, schema });
  return { db, pool };
}
```

**Drizzle config (from official docs):**
```ts
// packages/db/drizzle.config.ts
import "dotenv/config";
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  out: "./drizzle",
  schema: "./src/schema.ts",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

**Programmatic migrate (from official docs) — used by the migrate CLI and the test globalSetup:**
```ts
// packages/db/src/migrate.ts
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { createDb } from "./client.js";
export async function runMigrations(connectionString: string): Promise<void> {
  const { db, pool } = createDb(connectionString);
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
  await migrate(db, { migrationsFolder });
  await pool.end();
}
```

**Field encryption (AES-256-GCM, key from env, NEVER in the DB — PRD §18.1):**
```ts
// packages/db/src/crypto.ts
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
const ALGO = "aes-256-gcm";
export interface EncryptedField { ciphertext: string; iv: string; tag: string; } // all base64
function key(): Buffer {
  const b64 = process.env.ARCHIVE_ENCRYPTION_KEY;
  if (!b64) throw new Error("ARCHIVE_ENCRYPTION_KEY is not set");
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error("ARCHIVE_ENCRYPTION_KEY must be 32 bytes (base64-encoded)");
  return k;
}
export function encryptField(plaintext: string): EncryptedField {
  const iv = randomBytes(12);                                  // 96-bit IV, fresh per call — NEVER reuse
  const c = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { ciphertext: ct.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") };
}
export function decryptField(f: EncryptedField): string {
  const d = createDecipheriv(ALGO, key(), Buffer.from(f.iv, "base64"));
  d.setAuthTag(Buffer.from(f.tag, "base64"));                  // final() throws if ciphertext/tag tampered
  return Buffer.concat([d.update(Buffer.from(f.ciphertext, "base64")), d.final()]).toString("utf8");
}
```

**Ingest token (random secret; store only its hash; look up by hash):**
```ts
// packages/db/src/tokens.ts
import { randomBytes, createHash } from "node:crypto";
export function generateToken(): string { return randomBytes(32).toString("base64url"); }
export function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
```
Auth verifies by hashing the presented bearer token and `SELECT machine_id ... WHERE token_hash = $1
AND revoked_at IS NULL` — the indexed hash lookup leaks nothing useful, and the plaintext token is
never stored (only returned once at pairing time).

**Encrypt vs plaintext column split (PRD §18.1 — get this exactly right):**

| Stored | Column(s) | Plaintext or Ciphertext |
| --- | --- | --- |
| Raw record verbatim payload (the JSONL line — contains message bodies, tool args/outputs) | `raw_source_records.payload_{ciphertext,iv,tag}` | **Ciphertext** |
| Event tool-call payload (e.g. `{ name }`, args) | `events.payload_{ciphertext,iv,tag}` (nullable) | **Ciphertext** |
| Token counts | `events.tokens` (`jsonb`) | **Plaintext (queryable)** |
| Cost result | `events.cost` (`jsonb`) | **Plaintext (queryable)** |
| timestamps, model, session_id, fingerprint, event_type, connector, parser_version, ids | their own columns | **Plaintext (queryable)** |
| project_path, git_branch | their own columns | **Plaintext** — metadata (paths), needed for project attribution (M5); NOT secrets. Document this choice. |

**Idempotency (reproduce M1 exactly, PRD §23):** raw → `INSERT ... ON CONFLICT DO NOTHING` on
`unique(machine_id, source_connector, source_record_id)`; events → `INSERT ... ON CONFLICT
(fingerprint) DO UPDATE SET parser_version, tokens, cost, payload_* = excluded.*`. Wrap a batch in a
single transaction (`db.transaction(async (tx) => { ... })`).

**Wire types (pure, in `packages/shared/src/ingest.ts`):** plaintext over the wire (TLS in prod;
token-authed) — the **server** encrypts before write (§18.1 is at-rest). Shapes:
```ts
export interface RawRecordPayload { sourceConnector: string; sessionId: string; sourceRecordId: string; payload: string; ingestedAt?: string; }
export interface EventPayload { /* NormalizedEvent minus nothing — carry it verbatim */ fingerprint: string; sourceConnector: string; parserVersion: string; rawRecordId: string; eventIndex: number; eventType: EventType; sessionId: string; projectPath?: string; gitBranch?: string; model?: string; ts: string; tokens?: NormalizedTokens; cost?: CostResult; payload?: unknown; }
export interface IngestBatch { records: RawRecordPayload[]; events: EventPayload[]; }
export interface PairRequest { code: string; machine: { name: string; os?: string; hostname?: string }; }
export interface PairResponse { token: string; machineId: string; }
export interface IngestResponse { recordsInserted: number; eventsUpserted: number; }
```

---

## IMPLEMENTATION PLAN

### Phase 1: Infra + data layer (`docker-compose`, `packages/db`)
Stand up Postgres, define the typed schema + migrations, the crypto helper, token helpers, the
client, and repositories. This phase is self-contained and fully unit/integration-testable before any
HTTP exists.

### Phase 2: Wire contract (`packages/shared`)
Add the pure ingest/pairing wire types both sides import. No behavior change to existing exports.

### Phase 3: Ingest API (`apps/ingest`)
Fastify app: auth plugin, JSON-schema-validated routes (pairing-codes, pair, ingest, health), wired
to `packages/db` repositories. Testable via `app.inject()` (no real port).

### Phase 4: Collector integration (`apps/collector`)
Ingest HTTP client + `pair`/`push` CLI commands reusing the M1 parser.

### Phase 5: Tests, validation, docs
Unit tests (no DB) + integration tests (real Postgres) + the full validation ladder + README.

---

## STEP-BY-STEP TASKS

IMPORTANT: Execute every task in order, top to bottom. Run each task's VALIDATE before moving on.

### Task 1 — CREATE `docker-compose.yml` + `.env.example` + verify `.gitignore`
- **IMPLEMENT**: `docker-compose.yml` with one service `archive` using image `postgres:17`,
  `POSTGRES_USER=420ai`, `POSTGRES_PASSWORD=420ai`, `POSTGRES_DB=420ai`, port `5432:5432`, a named
  volume `archive-data:/var/lib/postgresql/data`, and a `healthcheck` (`pg_isready -U 420ai`). The
  **test database** is a second database on the same server — create it with an init script
  `./docker/init-test-db.sql` (`CREATE DATABASE "420ai_test";`) mounted at
  `/docker-entrypoint-initdb.d/`.
- **IMPLEMENT**: `.env.example` (committed) documenting:
  `DATABASE_URL=postgres://420ai:420ai@localhost:5432/420ai`,
  `DATABASE_URL_TEST=postgres://420ai:420ai@localhost:5432/420ai_test`,
  `ARCHIVE_ENCRYPTION_KEY=<base64 32 bytes — generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))">`,
  `ADMIN_TOKEN=<random — gates POST /v1/pairing-codes>`, `INGEST_PORT=8420`.
- **GOTCHA**: `.env` is gitignored (`!.env.example` is the committed template). Never commit a real
  key. The executor must `cp .env.example .env` and fill `ARCHIVE_ENCRYPTION_KEY`/`ADMIN_TOKEN` with
  freshly generated values before running anything that touches the DB or crypto.
- **VALIDATE**: `docker compose up -d && docker compose ps` shows `archive` healthy; `cp .env.example .env`
  then fill the two secrets; `docker compose exec archive psql -U 420ai -lqt | grep 420ai_test`.

### Task 2 — CREATE `packages/db` scaffold (package.json, tsconfig, drizzle.config.ts)
- **IMPLEMENT**: `packages/db/package.json`: `"name": "@420ai/db"`, `"version": "0.0.0"`,
  `"type": "module"`, `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`,
  `exports` map (mirror `@420ai/shared`), `"dependencies": { "@420ai/shared": "*", "drizzle-orm": "^0.45.2", "pg": "^8.21.0", "dotenv": "^17.4.2" }`,
  `"devDependencies": { "drizzle-kit": "^0.31.10", "@types/pg": "^8.20.0" }` (exact versions verified in PRE-FLIGHT),
  scripts: `"build": "tsc -b"`, `"db:generate": "drizzle-kit generate"`, `"db:migrate": "tsx src/migrate-cli.ts"` (or `drizzle-kit migrate`).
- **IMPLEMENT**: `packages/db/tsconfig.json` extends `../../tsconfig.base.json`, `outDir dist`,
  `rootDir src`, `"include": ["src/**/*"]`, `"references": [{ "path": "../shared" }]`. **Exclude
  `drizzle.config.ts`** from the build (`"exclude": ["drizzle.config.ts", "drizzle"]`) — it is run by
  drizzle-kit/tsx, not part of the library build.
- **IMPLEMENT**: `drizzle.config.ts` exactly as in "Patterns to Follow".
- **GOTCHA**: re-run `npm install` after adding the workspace so the `@420ai/db` symlink + new deps
  resolve. Verify exact patch versions with `npm view drizzle-orm version` / `npm view drizzle-kit version`
  and adjust the `^` ranges if the lines have moved.
- **VALIDATE**: `npm install && npm view drizzle-orm version` resolves; `ls node_modules/@420ai/db`.

### Task 3 — CREATE `packages/db/src/schema.ts` (6 tables)
- **IMPLEMENT**: Drizzle `pgTable` definitions for `users`, `machines`, `pairing_codes`,
  `ingest_tokens`, `raw_source_records`, `events` exactly per the "Encrypt vs plaintext" table and
  these column specs (use explicit snake_case column-name strings):
  - `users`: `id uuid pk defaultRandom`, `email text notNull unique`, `created_at timestamptz notNull defaultNow`.
  - `machines`: `id uuid pk defaultRandom`, `user_id uuid notNull → users.id`, `name text notNull`,
    `os text`, `hostname text`, `status text notNull default 'active'`, `created_at`, `last_seen_at timestamptz`.
  - `pairing_codes`: `code text pk`, `user_id uuid notNull → users.id`, `expires_at timestamptz notNull`,
    `consumed_at timestamptz`, `created_at`.
  - `ingest_tokens`: `id uuid pk defaultRandom`, `machine_id uuid notNull → machines.id`,
    `token_hash text notNull unique`, `created_at`, `revoked_at timestamptz`.
  - `raw_source_records`: `id uuid pk defaultRandom`, `machine_id uuid notNull → machines.id`,
    `source_connector text notNull`, `session_id text notNull`, `source_record_id text notNull`,
    `ingested_at timestamptz notNull defaultNow`, `payload_ciphertext text notNull`,
    `payload_iv text notNull`, `payload_tag text notNull`; + `uniqueIndex("raw_machine_connector_record")
    .on(machineId, sourceConnector, sourceRecordId)` and `index("raw_by_session").on(sessionId)`.
  - `events`: `fingerprint text pk`, `source_connector text notNull`, `parser_version text notNull`,
    `raw_record_id text notNull`, `event_index integer notNull`, `event_type text notNull`,
    `session_id text notNull`, `machine_id uuid → machines.id`, `project_path text`, `git_branch text`,
    `model text`, `ts timestamptz notNull` (**use `{ mode: "string" }`** to keep ISO strings exactly
    like M1 — Claude timestamps are ISO and we avoid Date/TZ coercion), `tokens jsonb $type<NormalizedTokens>()`,
    `cost jsonb $type<CostResult>()`, `payload_ciphertext text`, `payload_iv text`, `payload_tag text`;
    + `index("events_by_session").on(sessionId, ts)`.
- **IMPORTS**: `import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";`
  `import type { NormalizedTokens, CostResult } from "@420ai/shared";`
- **PATTERN**: this is the Postgres translation of the M1 SQLite tables
  (`apps/collector/src/store/sqlite-store.ts`) plus the new entity tables; column intent must match.
- **GOTCHA**: do NOT put `payload` in the fingerprint or in any unique key. `ts` mode "string" matters.
  `tokens`/`cost` are plaintext jsonb (queryable) — they are NOT encrypted.
- **GOTCHA (Drizzle 0.45 API — verified in PRE-FLIGHT)**: the table extra-config callback returns an
  **array**, not an object: `pgTable("raw_source_records", {...}, (t) => [ uniqueIndex("raw_machine_connector_record").on(t.machineId, t.sourceConnector, t.sourceRecordId), index("raw_by_session").on(t.sessionId) ])`.
  The legacy `(t) => ({ key: ... })` object form is deprecated. `drizzle-kit generate` with the array
  form was confirmed to emit the correct unique index + FKs.
- **VALIDATE**: `npm run -w @420ai/db build` (compiles once src/index.ts barrel exists — defer to Task 7) — for now `npx tsc -p packages/db --noEmit` after the barrel, or validate via Task 6 generate.

### Task 4 — CREATE `packages/db/src/crypto.ts` + `src/crypto.test.ts`
- **IMPLEMENT**: `encryptField` / `decryptField` / `EncryptedField` exactly as in "Patterns to Follow".
- **IMPLEMENT** test (NO DB): set `process.env.ARCHIVE_ENCRYPTION_KEY = randomBytes(32).toString("base64")`
  in the test; assert `decryptField(encryptField(s)) === s` for ASCII + unicode + a ~50KB string;
  assert two `encryptField(s)` calls produce **different** `iv`/`ciphertext` (fresh IV); assert that
  flipping one byte of `ciphertext` (or `tag`) makes `decryptField` **throw** (GCM integrity); assert
  a missing/short key throws a clear error.
- **GOTCHA**: 96-bit (12-byte) IV is the GCM standard; never reuse. Auth tag is 16 bytes.
- **VALIDATE**: `npx vitest run packages/db/src/crypto.test.ts` (green; no DB needed).

### Task 5 — CREATE `packages/db/src/tokens.ts` + `src/tokens.test.ts` + `src/client.ts` + `src/migrate.ts`
- **IMPLEMENT**: `tokens.ts` (`generateToken`, `hashToken`) per "Patterns to Follow". `client.ts`
  (`createDb`, `Db` type) per "Patterns to Follow". `migrate.ts` (`runMigrations`) per "Patterns to
  Follow", plus a thin `src/migrate-cli.ts` that does `import "dotenv/config"; await
  runMigrations(process.env.DATABASE_URL!)` for the `db:migrate` script.
- **IMPLEMENT** `tokens.test.ts` (NO DB): `hashToken` is deterministic (same input → same hash),
  different tokens → different hashes, `generateToken()` returns distinct values across calls.
- **GOTCHA**: `Pool` from `pg` must be `.end()`-ed in `runMigrations` (it does) so the migrate CLI
  process exits cleanly.
- **VALIDATE**: `npx vitest run packages/db/src/tokens.test.ts`.

### Task 6 — GENERATE the initial migration (drizzle-kit)
- **IMPLEMENT**: with `.env` filled and Postgres up, run `npm run -w @420ai/db db:generate`. This
  reads `schema.ts` and writes timestamped SQL into `packages/db/drizzle/`. Commit the generated SQL
  (it IS the migration history — `__drizzle_migrations` tracks applied ones).
- **IMPLEMENT**: ensure `.gitignore` does not exclude `packages/db/drizzle/` (the `dist/` rule won't,
  but add an explicit `!packages/db/drizzle/` if any broad rule matches). Migrations are source.
- **GOTCHA**: `db:generate` does not need a live DB (it diffs schema → SQL), but `db:migrate` does.
  Inspect the generated SQL: confirm `payload_ciphertext`/`iv`/`tag` are `text NOT NULL` on raw,
  nullable on events; confirm the unique index on raw and the fingerprint PK on events.
- **VALIDATE**: `npm run -w @420ai/db db:generate` then `npm run -w @420ai/db db:migrate`; then
  `docker compose exec archive psql -U 420ai -d 420ai -c "\dt"` lists all 6 tables +
  `__drizzle_migrations`.

### Task 7 — CREATE `packages/db/src/repositories/*` + `src/index.ts` barrel
- **IMPLEMENT** `repositories/pairing.ts`:
  - `createPairingCode(db, userId, ttlMs = 15*60*1000): Promise<{ code; expiresAt }>` — code =
    `randomBytes(8).toString("base64url")` (short, single-use), insert with `expires_at = now + ttl`.
    `expiresAt` computed in JS (avoid `Date.now()` only inside the repo; it's runtime app code, fine).
  - `redeemPairingCode(tx, code): Promise<{ userId }>` — select by `code`; throw a typed
    `PairingError` if missing, already `consumed_at`, or `expires_at < now`; else set
    `consumed_at = now` and return `userId`. Single-use.
- **IMPLEMENT** `repositories/machines.ts`: `createMachine(tx, { userId, name, os, hostname }):
  Promise<{ id }>`; `touchLastSeen(db, machineId)` (sets `last_seen_at = now`).
- **IMPLEMENT** `repositories/tokens.ts`: `issueIngestToken(tx, machineId): Promise<{ token }>` —
  `token = generateToken()`, insert `hashToken(token)`, return the plaintext token ONCE;
  `findMachineIdByToken(db, token): Promise<string | null>` — `hashToken` then select machine_id
  where `token_hash = ? AND revoked_at IS NULL`.
- **IMPLEMENT** `repositories/ingest.ts`: `ingestBatch(db, machineId, batch: IngestBatch):
  Promise<IngestResponse>` — in one `db.transaction`:
    - raw: for each record, `encryptField(record.payload)`; `insert(rawSourceRecords).values({...,
      machineId, payloadCiphertext, payloadIv, payloadTag}).onConflictDoNothing({ target: [machineId,
      sourceConnector, sourceRecordId] }).returning({ id })` — sum returned lengths = `recordsInserted`.
    - events: for each event, encrypt `event.payload` (if present) → ciphertext columns (else nulls);
      `insert(events).values({...}).onConflictDoUpdate({ target: events.fingerprint, set: {
      parserVersion, tokens, cost, payloadCiphertext, payloadIv, payloadTag } })`; count rows =
      `eventsUpserted` (use `.returning()` length).
    - Return `{ recordsInserted, eventsUpserted }`.
- **IMPLEMENT** `src/index.ts` barrel: re-export `schema`, `createDb`/`Db`, `crypto`, `tokens`,
  `runMigrations`, and all repositories + `PairingError` (all `.js` extensions).
- **IMPORTS**: `import { eq, and, isNull } from "drizzle-orm";` `import type { IngestBatch,
  IngestResponse } from "@420ai/shared";` schema + crypto + tokens from `./...js`.
- **GOTCHA**: encrypt happens **inside** the repository (the single write boundary) so no caller can
  forget it. Pass the same `tx` to `redeemPairingCode` + `createMachine` + `issueIngestToken` so
  pairing is atomic. Bind `undefined` → omit (Drizzle handles nullable columns).
- **VALIDATE**: `npm run -w @420ai/db build` (whole package compiles); integration coverage in Task 18.

### Task 8 — EXTEND `packages/shared`: add `src/ingest.ts` wire types + barrel export
- **IMPLEMENT**: `packages/shared/src/ingest.ts` exporting `RawRecordPayload`, `EventPayload`,
  `IngestBatch`, `PairRequest`, `PairResponse`, `IngestResponse` exactly as in "Patterns to Follow".
  `EventPayload` imports `EventType`/`NormalizedTokens`/`CostResult` from the sibling modules with
  `.js` + `import type`. Add `export * from "./ingest.js";` to `src/index.ts`.
- **IMPLEMENT**: optional tiny `src/ingest.test.ts` only if you add a runtime helper (e.g. a
  `toEventPayload(e: NormalizedEvent): EventPayload` mapper — recommended, keeps the collector thin).
  If added, test it round-trips a `NormalizedEvent`.
- **GOTCHA**: keep `packages/shared` dependency-free and pure (it still imports nothing external).
- **VALIDATE**: `npm run -w @420ai/shared build && npx vitest run packages/shared`.

### Task 9 — CREATE `apps/ingest` scaffold (package.json, tsconfig)
- **IMPLEMENT**: `apps/ingest/package.json`: `"name": "@420ai/ingest"`, `"type": "module"`,
  `"dependencies": { "@420ai/shared": "*", "@420ai/db": "*", "fastify": "^5.8.5", "fastify-plugin": "^6.0.0", "dotenv": "^17.4.2" }` (NOTE: fastify-plugin is **v6**, one major ahead of Fastify v5 — verified in PRE-FLIGHT),
  scripts `"build": "tsc -b"`, `"dev": "tsx watch src/server.ts"`, `"start": "node dist/server.js"`.
  `tsconfig.json` extends base, `outDir dist`, `rootDir src`, `"references": [{ "path":
  "../../packages/shared" }, { "path": "../../packages/db" }]`.
- **GOTCHA**: re-run `npm install` after adding the workspace + deps. Confirm exact versions
  (`npm view fastify version`, `npm view fastify-plugin version`).
- **VALIDATE**: `npm install && ls node_modules/fastify`.

### Task 10 — CREATE `apps/ingest/src/schemas.ts` (Fastify JSON-schema validation)
- **IMPLEMENT**: plain JSON-schema objects for request bodies — `pairBodySchema` (`code` string
  required, `machine` object with required `name`, optional `os`/`hostname`), `ingestBodySchema`
  (`records` array + `events` array with the required keys of each payload), `pairingCodeBodySchema`
  (optional `userId`/`email` — see Task 13). Export each as `{ body: {...} }` for route `schema`.
- **PATTERN**: Fastify validates+coerces with these natively (no zod dependency). Reject unknown/missing → 400.
- **GOTCHA**: keep schemas permissive on `events[].payload` (`{}` / true) since it is arbitrary JSON;
  strict on the metric/identity fields. `tokens`/`cost` are objects (not required).
- **VALIDATE**: covered by Task 19 (400 on malformed body).

### Task 11 — CREATE `apps/ingest/src/plugins/auth.ts` (bearer → machineId)
- **IMPLEMENT**: a `fastify-plugin` that decorates the request with `machineId: string` and exposes a
  `preHandler` (or a named decorator `app.authenticate`) which: reads `authorization: Bearer <token>`,
  401 with `{ error: "missing or malformed authorization header" }` if absent/malformed; calls
  `findMachineIdByToken(db, token)`; 401 `{ error: "invalid or revoked token" }` if null; else sets
  `request.machineId` and `touchLastSeen(db, machineId)` (fire-and-forget is fine, or await).
- **IMPORTS**: `import fp from "fastify-plugin";` `import { findMachineIdByToken, touchLastSeen } from "@420ai/db";`
  Get the `Db` from a decoration set in `app.ts` (e.g. `app.db`).
- **PATTERN**: mirror `@fastify/bearer-auth`'s 401 body shape; attach `machineId` via TS module
  augmentation of `FastifyRequest`.
- **GOTCHA**: register the db decoration BEFORE this plugin so `app.db` exists. Use
  `declare module "fastify" { interface FastifyRequest { machineId: string } interface FastifyInstance { db: Db; authenticate: ... } }`.
- **VALIDATE**: Task 19 asserts 401 on missing/invalid token, 200 on valid.

### Task 12 — CREATE `apps/ingest/src/app.ts` (buildApp) + `src/server.ts` (entrypoint)
- **IMPLEMENT**: `buildApp(opts: { db: Db; adminToken: string }): FastifyInstance` — create
  `Fastify({ logger: true })`, decorate `app.db = opts.db` and `app.adminToken = opts.adminToken`,
  register the auth plugin, register all route modules (Task 13 + health), set a `setErrorHandler`
  that maps `PairingError` → 400/410 and unexpected errors → 500 with `{ error }` (never leak
  internals). Return the app **without** calling `listen` (so tests can `inject`).
- **IMPLEMENT**: `server.ts` — `import "dotenv/config";` build the `Db` via
  `createDb(process.env.DATABASE_URL!)`, `buildApp({ db, adminToken: process.env.ADMIN_TOKEN! })`,
  `await app.listen({ port: Number(process.env.INGEST_PORT ?? 8420), host: "0.0.0.0" })`.
- **GOTCHA**: `app.ts` must take its dependencies as args (dependency injection) so tests pass a
  test-DB-backed `Db`. `server.ts` is the only place that reads env + listens.
- **VALIDATE**: `npm run -w @420ai/ingest build`; `npm run -w @420ai/ingest dev` then
  `curl localhost:8420/v1/health` → `{ "status": "ok" }` (Task 13 health route).

### Task 13 — CREATE routes: `health.ts`, `pairing-codes.ts`, `pair.ts`, `ingest.ts`
- **IMPLEMENT** `health.ts`: `GET /v1/health` → `{ status: "ok", time: new Date().toISOString() }`
  (no auth). Supports PRD §20 collector-side reachability checks.
- **IMPLEMENT** `pairing-codes.ts`: `POST /v1/pairing-codes` gated by an **admin** check —
  `authorization: Bearer <ADMIN_TOKEN>` compared to `app.adminToken` (constant-time via
  `crypto.timingSafeEqual` on equal-length buffers); body may supply `email` to find/create a `users`
  row (for M2 single-user: upsert a user by email, default `seanrobertwright@gmail.com` if omitted —
  or require `userId`). Returns `{ code, expiresAt }` from `createPairingCode`. **Document**: this is
  a temporary M2 affordance; the dashboard issues codes in a later milestone.
- **IMPLEMENT** `pair.ts`: `POST /v1/pair` (no bearer; the code IS the credential), `schema:
  pairBodySchema`. In a `db.transaction`: `redeemPairingCode(tx, code)` → `createMachine(tx, {...})`
  → `issueIngestToken(tx, machineId)`; respond `{ token, machineId }` (`PairResponse`). On
  `PairingError` → 410 Gone `{ error }`.
- **IMPLEMENT** `ingest.ts`: `POST /v1/ingest` `{ preHandler: app.authenticate, schema:
  ingestBodySchema }` → `ingestBatch(app.db, request.machineId, request.body)` → 200
  `{ recordsInserted, eventsUpserted }` (`IngestResponse`).
- **GOTCHA**: all four are Fastify plugins `export default async function (app) {...}` registered in
  `app.ts`. `/v1/ingest` must run inside the auth preHandler so `request.machineId` is set. Use the
  route `schema` to get 400s for free.
- **VALIDATE**: Task 19 covers all routes via `app.inject()`.

### Task 14 — EXTEND `apps/collector`: `src/ingest-client.ts` + `src/ingest-client.test.ts`
- **IMPLEMENT**: `postPair(baseUrl, body: PairRequest): Promise<PairResponse>` and
  `postIngest(baseUrl, token, batch: IngestBatch): Promise<IngestResponse>` using global `fetch`
  (Node 24). Set `content-type: application/json`; `postIngest` sets `authorization: Bearer ${token}`.
  Throw a clear `Error` including the HTTP status + response body text on non-2xx.
- **IMPLEMENT** test: mock global `fetch` (`vi.stubGlobal("fetch", vi.fn()...)`); assert `postIngest`
  sends the bearer header + correct JSON body and parses the JSON response; assert a 401 response
  throws with a useful message.
- **IMPORTS**: `import type { PairRequest, PairResponse, IngestBatch, IngestResponse } from "@420ai/shared";`
- **GOTCHA**: no new runtime dependency (use built-in `fetch`). Library file — no console output.
- **VALIDATE**: `npx vitest run apps/collector/src/ingest-client.test.ts`.

### Task 15 — EXTEND `apps/collector/src/cli.ts`: `pair` and `push` commands
- **IMPLEMENT**:
  - `runPair(opts: { url; code; name; os?; hostname? }): Promise<PairResponse>` — call `postPair`;
    return token + machineId. The `pair` command prints them and (optionally) persists
    `{ url, token, machineId }` to `~/.420ai/credentials.json` (mkdir -p; mode 600 where supported).
  - `runPush(opts: { file; url; token }): Promise<IngestResponse>` — `readFileSync`,
    `parseClaudeCodeSession`, map `ParseResult` → `IngestBatch` (`records`: `{ sourceConnector,
    sessionId, sourceRecordId: r.id, payload: r.payload }`; `events`: each `NormalizedEvent` →
    `EventPayload`, reusing the shared `toEventPayload` mapper if added in Task 8), then `postIngest`.
    Print `recordsInserted`/`eventsUpserted`.
  - Wire both into `main()`: `collector pair <code> --url <u> --name <n> [--os --hostname]` and
    `collector push <file> --url <u> --token <t>` (read token from creds file if `--token` omitted).
    Extend `usage()`.
- **PATTERN**: mirror the existing `runIngest`/`runReport` (pure exported fn) + thin `main()` split in
  `cli.ts`; only `main()` logs/exits. Keep the M1 `ingest`/`report` commands unchanged.
- **GOTCHA**: `main()` is now async for `pair`/`push` (await the client). Wrap in the existing
  try/catch; on a thrown client error print `error.message` + `process.exit(1)`.
- **VALIDATE**: Task 20 (integration) + manual run in Validation Commands Level 4.

### Task 16 — UPDATE root `tsconfig.json`, `vitest.config.ts`, root `package.json`
- **IMPLEMENT** `tsconfig.json`: add `{ "path": "./packages/db" }` and `{ "path": "./apps/ingest" }`
  to `references` (order: shared, db, collector, ingest).
- **IMPLEMENT** `vitest.config.ts`: add alias `"@420ai/db" → packages/db/src/index.ts` (so tests run
  from source like `@420ai/shared`); add `import "dotenv/config"` at top (load `.env` for
  `DATABASE_URL_TEST`/`ARCHIVE_ENCRYPTION_KEY`); add `test.globalSetup: "./vitest.global-setup.ts"`
  and `test.fileParallelism: false` (integration tests share one test DB — avoid cross-file races).
  Keep `include` covering `*.test.ts` (unit) AND `*.int.test.ts` (integration).
- **IMPLEMENT** root `package.json` scripts: `"db:up": "docker compose up -d"`,
  `"db:down": "docker compose down"`, `"db:generate": "npm run -w @420ai/db db:generate"`,
  `"db:migrate": "npm run -w @420ai/db db:migrate"`, `"ingest:dev": "npm run -w @420ai/ingest dev"`.
- **GOTCHA**: `verbatimModuleSyntax` + the vitest source aliases mean tests import TS source directly
  (no build) — confirm `@420ai/db` resolves to `src/index.ts` like shared does.
- **VALIDATE**: `npm run typecheck` (tsc -b across all 4 workspaces, 0 errors).

### Task 17 — CREATE `vitest.global-setup.ts` (test DB migrations)
- **IMPLEMENT**: a vitest global setup that, **if** `process.env.DATABASE_URL_TEST` is set, runs
  `runMigrations(process.env.DATABASE_URL_TEST)` once before the suite (so integration tests hit a
  migrated schema), and returns a no-op teardown. If `DATABASE_URL_TEST` is unset, do nothing (unit
  tests still run; integration tests self-skip — see Task 18).
- **IMPORTS**: `import { runMigrations } from "@420ai/db";` (resolved via the vitest alias).
- **GOTCHA**: global setup runs in its own process; do not try to share a connection with tests —
  tests open their own `createDb(DATABASE_URL_TEST)`. Idempotent migrations make re-runs safe.
- **VALIDATE**: with `.env` filled + `docker compose up -d`, `npx vitest run` completes setup without error.

### Task 18 — CREATE `packages/db` integration tests (`*.int.test.ts`)
- **IMPLEMENT** `repositories/ingest.int.test.ts` — guard the whole file with
  `describe.skipIf(!process.env.DATABASE_URL_TEST)`. In `beforeEach`, `TRUNCATE` all tables
  (`raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY
  CASCADE`). Seed a user + machine. Build an `IngestBatch` from the M1 fixture
  (`apps/collector/src/fixtures/sample-session.jsonl` → `parseClaudeCodeSession` →
  records/events). Assert: first `ingestBatch` returns expected `recordsInserted`/`eventsUpserted`;
  **re-running the same batch returns `recordsInserted: 0` and leaves `events` row-count unchanged**
  (idempotency, PRD §23); the stored `raw_source_records.payload_ciphertext` is **NOT** equal to the
  plaintext payload (encryption-at-rest), and `decryptField({ciphertext,iv,tag})` round-trips to the
  original line; `events.tokens`/`cost` are stored as readable JSON (plaintext queryable).
- **IMPLEMENT** `repositories/pairing.int.test.ts` — `createPairingCode` then `redeemPairingCode`
  succeeds once and throws `PairingError` on second redeem (single-use) and on an expired code
  (insert one with `expires_at` in the past).
- **GOTCHA**: import `@420ai/db` from source via the alias; set `ARCHIVE_ENCRYPTION_KEY` (from `.env`)
  — the repo encrypt path needs it. Close pools in `afterAll`.
- **VALIDATE**: `docker compose up -d && npx vitest run packages/db` (integration green when DB up).

### Task 19 — CREATE `apps/ingest/src/app.int.test.ts` (HTTP e2e via inject)
- **IMPLEMENT**: `describe.skipIf(!process.env.DATABASE_URL_TEST)`. In `beforeAll`, `createDb(TEST_URL)`
  + `buildApp({ db, adminToken: "test-admin" })`; `beforeEach` truncate + seed a user. Tests:
  1. `POST /v1/pairing-codes` with `Bearer test-admin` → 200 `{ code }`; without/with wrong admin
     token → 401.
  2. Full flow: create code → `POST /v1/pair { code, machine }` → 200 `{ token, machineId }`;
     re-pair with the same (now consumed) code → 410.
  3. `POST /v1/ingest` with the issued bearer token + a fixture batch → 200 with counts; **same batch
     again → `recordsInserted: 0`** (idempotent through the HTTP layer).
  4. `POST /v1/ingest` with no token → 401; with a revoked/garbage token → 401.
  5. `POST /v1/ingest` with a malformed body (missing `events`) → 400 (schema validation).
- **IMPORTS**: `buildApp` from `../app.js`, `createDb` from `@420ai/db`, fixture via `readFileSync`.
- **GOTCHA**: use `app.inject({ method, url, headers, payload })` — no real port, no flaky sockets.
  `await app.close()` + pool end in `afterAll`.
- **VALIDATE**: `docker compose up -d && npx vitest run apps/ingest`.

### Task 20 — CREATE `apps/collector` push integration coverage + wire e2e
- **IMPLEMENT**: a focused integration test (`apps/collector/src/push.int.test.ts`,
  `describe.skipIf(!process.env.DATABASE_URL_TEST)`) that builds the ingest app in-process
  (`buildApp` with a test `Db`), starts it on an ephemeral port (`app.listen({ port: 0 })`, read
  `app.server.address().port`), pairs via `runPair`, pushes the fixture via `runPush`, and asserts the
  returned counts + that a second `runPush` reports `recordsInserted: 0`. Close the app after.
- **GOTCHA**: this is the one test that uses a real socket (to exercise `fetch`); everything else uses
  `inject`. Alternatively, if cross-package test wiring is awkward, keep `ingest-client` unit-tested
  (Task 14) and assert the full HTTP path only in `apps/ingest` (Task 19) — document the choice.
- **VALIDATE**: `docker compose up -d && npx vitest run apps/collector`.

### Task 21 — UPDATE `README.md` with "Development (Milestone 2)"
- **IMPLEMENT**: append an M2 section: prerequisites (Docker + Node ≥24); `cp .env.example .env` and
  generate `ARCHIVE_ENCRYPTION_KEY` + `ADMIN_TOKEN`; `npm run db:up`; `npm run db:migrate`;
  `npm run ingest:dev`; the onboarding curl flow — create a pairing code (admin), `collector pair`,
  `collector push`; note that integration tests require `docker compose up -d` and a filled `.env`
  (they self-skip otherwise), and that sensitive payloads are encrypted at rest while token
  counts/costs stay queryable. Update the top-level "Status" line to reflect M2.
- **VALIDATE**: follow the README from a clean state end-to-end (see Validation Level 4).

---

## TESTING STRATEGY

Mirror M1's vitest layout (co-located `*.test.ts`). Split by infra need:

- **Unit tests (`*.test.ts`, NO database, always run):** `crypto.test.ts` (round-trip + tamper +
  fresh-IV + bad-key), `tokens.test.ts` (hash determinism/uniqueness), `ingest-client.test.ts`
  (request shape with mocked `fetch`), `packages/shared/ingest.test.ts` (mapper round-trip if added).
- **Integration tests (`*.int.test.ts`, real Postgres, `describe.skipIf(!DATABASE_URL_TEST)`):**
  - `packages/db`: idempotent `ingestBatch` (re-run → 0 new), **encryption-at-rest** assertion
    (ciphertext ≠ plaintext, `decryptField` round-trips), pairing single-use + expiry.
  - `apps/ingest`: full HTTP flow via `app.inject()` — admin-gated code issuance, pair → token,
    authed ingest, idempotency through HTTP, 401s (no/invalid token), 400 (schema).
  - `apps/collector`: real-socket `push` against an in-process ingest app.
- **DB provisioning:** a `420ai_test` database in the same compose Postgres; `vitest.global-setup.ts`
  runs migrations once; tests `TRUNCATE ... RESTART IDENTITY CASCADE` in `beforeEach`. (Alternative,
  documented in NOTES: `@testcontainers/postgresql` for fully hermetic, no-compose-needed runs.)

### Edge Cases (must be covered)
- Re-ingesting the same batch (whole pipe) → 0 new raw, events row-count stable (fingerprint upsert).
- Tampered ciphertext/tag → `decryptField` throws (GCM integrity).
- Missing/short `ARCHIVE_ENCRYPTION_KEY` → clear startup-time error, not a silent weak key.
- Expired pairing code, already-consumed code, unknown code → `PairingError` → 410, never a 500.
- Missing bearer, malformed `Authorization`, revoked token, unknown token → 401 (not 500).
- Malformed ingest body (missing `records`/`events`, wrong types) → 400 via schema.
- Empty batch (`{records:[],events:[]}`) → 200 `{0,0}` (no-op), no error.
- Assistant event with no `payload` → event stored with NULL ciphertext columns, no crypto call.

---

## VALIDATION COMMANDS

Run every level; zero regressions, feature correct.

### Level 1: Syntax, Types
- `npm install` (resolves the two new workspaces + deps)
- `npm run typecheck` (`tsc -b` across shared, db, collector, ingest — 0 errors)

### Level 2: Unit Tests (no infra)
- `npx vitest run packages/db/src/crypto.test.ts packages/db/src/tokens.test.ts apps/collector/src/ingest-client.test.ts packages/shared`
  (all green with **no** database running — proves the skip guards + unit isolation work)

### Level 3: Integration Tests (Postgres up)
- `npm run db:up` → wait for `archive` healthy
- `cp .env.example .env` (first time) and fill `ARCHIVE_ENCRYPTION_KEY`, `ADMIN_TOKEN`
- `npm run db:migrate`
- `npx vitest run` (all suites incl. `*.int.test.ts` — green)

### Level 4: Manual Validation (real end-to-end)
- `npm run ingest:dev` (terminal A) → `curl -s localhost:8420/v1/health` → `{"status":"ok",...}`
- Create a pairing code (admin):
  `curl -s -X POST localhost:8420/v1/pairing-codes -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d '{}'` → `{ "code": "...", "expiresAt": "..." }`
- Pair the collector:
  `npx tsx apps/collector/src/cli.ts pair <code> --url http://localhost:8420 --name win-dev` → prints `{ token, machineId }`
- Push a REAL session (reuse the M1 file):
  `npx tsx apps/collector/src/cli.ts push "$HOME/.claude/projects/C--Users-seanr-OneDrive-Documents-420AI/21135092-dcd8-40cf-b8e5-187964110f20.jsonl" --url http://localhost:8420 --token <token>`
  → prints non-zero `recordsInserted`/`eventsUpserted`.
- **Idempotency on real data:** run the same `push` again → `recordsInserted: 0`.
- **Encryption-at-rest proof:** `docker compose exec archive psql -U 420ai -d 420ai -c "SELECT left(payload_ciphertext,40), payload_iv FROM raw_source_records LIMIT 1;"`
  → shows base64 ciphertext, NOT readable JSON; and
  `SELECT event_type, tokens->>'total', cost->>'usd' FROM events WHERE tokens IS NOT NULL LIMIT 3;`
  → token/cost ARE readable (plaintext queryable).
- **Auth proof:** `curl -s -X POST localhost:8420/v1/ingest -d '{}'` → 401; with a bad bearer → 401.

### Level 5: Additional
- Revoke a token (manual `UPDATE ingest_tokens SET revoked_at = now()`) → subsequent `push` → 401
  (proves revocable per-machine tokens, PRD §18/§20).

---

## ACCEPTANCE CRITERIA

- [ ] `docker compose up -d` brings up a healthy `postgres:17` archive + a `420ai_test` database.
- [ ] `npm run db:migrate` applies Drizzle migrations; all 6 tables + `__drizzle_migrations` exist.
- [ ] `npm run typecheck` passes (strict, all 4 workspaces, 0 errors).
- [ ] `npx vitest run` passes WITHOUT a DB (unit only, integration self-skips) AND WITH a DB (all green).
- [ ] Field-level encryption: raw payloads + event tool payloads are AES-256-GCM ciphertext at rest;
      token counts + costs + identity/metadata are plaintext-queryable (PRD §18.1) — verified in psql.
- [ ] Tampered ciphertext/tag fails to decrypt (GCM integrity verified by test).
- [ ] Pairing: admin issues a short-lived single-use code; `collector pair` redeems it, registering a
      machine and returning a revocable ingest token (PRD §19). Re-redeem → 410.
- [ ] Ingest: `POST /v1/ingest` is bearer-authed (401 on missing/invalid/revoked), schema-validated
      (400 on malformed), and **idempotent** — re-pushing yields 0 new raw and a stable event count
      (PRD §23). The M1 fingerprint formula is unchanged.
- [ ] `collector push` sends a real Claude Code session through the API into Postgres end-to-end.
- [ ] No secrets committed; `.env` gitignored, `.env.example` documents required env; migrations committed.
- [ ] README "Development (Milestone 2)" walks the full setup + onboarding flow and works from clean.

## COMPLETION CHECKLIST

- [ ] All 21 tasks completed in order, each VALIDATE passing immediately.
- [ ] Unit suite green with no Docker; full suite green with Docker + filled `.env`.
- [ ] No type/lint errors; libraries log nothing (only Fastify logger + collector `cli.ts`).
- [ ] Manual real-data push + idempotency + encryption-at-rest + auth all confirmed in psql/curl.
- [ ] `git status` clean of `*.sqlite`, `.env`, and `volumes/db/data` (all gitignored).
- [ ] Acceptance criteria all met.

## NOTES

**Design decisions / trade-offs:**
- **Plain Postgres over full Supabase (user decision):** M1 deliberately avoided Docker heaviness; the
  full Supabase stack (GoTrue/Studio/PostgREST/realtime) is unused until the dashboard milestone. A
  single `postgres:17` container is the lightest thing that satisfies §8.2, and the Drizzle schema
  stays Supabase-compatible (plain SQL/DDL), so adopting Supabase later is additive, not a rewrite.
- **Drizzle ORM (user decision):** TS-first, type-safe schema-as-source-of-truth with generated SQL
  migrations and a typed query builder — best fit for this strict-TS single-language repo. The ingest
  repository gets compile-time-checked queries; `drizzle-kit generate` keeps migration history in
  version control; `__drizzle_migrations` tracks what's applied.
- **Standalone Fastify service (user decision):** matches the PRD's "dedicated ingest API" (§8.3),
  keeps ingest decoupled from the not-yet-existing Next.js dashboard, and `app.inject()` gives fast,
  socket-free route tests. `buildApp(deps)` uses dependency injection so tests run against a test DB.
- **Field-level encryption in M2 (user decision):** the ciphertext-vs-plaintext column split is the
  single most expensive thing to retrofit after data exists, so it lands now while the schema is born.
  AES-256-GCM (authenticated) with a 96-bit fresh IV per field and the 32-byte key in `.env`/env (per
  §18.1: key held by the app, NOT in the DB). Encryption happens **inside** the repository write
  boundary so no caller can bypass it. The redaction pipeline + the searchable redacted projection
  (§18.2/§21) remain a later milestone — M2 encrypts but does not yet redact-and-index.
- **Fingerprint stays machine-independent:** the M1 formula is unchanged on purpose — the same logical
  event from two machines dedups to one `events` row (PRD §23). Raw records ARE kept per-machine via
  `unique(machine_id, source_connector, source_record_id)`, so each machine retains its own sacred raw
  copy while events converge. `events.machine_id` records the most recent ingesting machine.
- **Admin-token pairing-code endpoint is a temporary M2 affordance:** PRD §19 issues codes from the
  dashboard, which doesn't exist yet. `POST /v1/pairing-codes` gated by `ADMIN_TOKEN` lets onboarding
  proceed headlessly now; the dashboard supersedes it in a later milestone (documented in README).
- **No durable queue yet:** `collector push` is a direct `fetch` that fails loudly — the durable
  queue, per-file cursors, machine identity persistence, and the connector framework are M3 (SUMMARY
  §3). M2 deliberately stops at "the pipe reaches the server, idempotently and encrypted."
- **Tables built vs deferred:** M2 creates only `users, machines, pairing_codes, ingest_tokens,
  raw_source_records, events`. The remaining §8.2 tables (sessions, work_sessions, metrics, costs,
  git_outcomes, connectors, catalog_versions, report_artifacts, redaction_findings) are projections/
  artifacts that belong to M5–M8 and would be speculative now.

**Testing approach alternative:** the plan uses a `420ai_test` database in the compose Postgres +
`describe.skipIf` so `npm test` works with or without Docker. If you prefer **fully hermetic** runs
(no compose dependency, CI-friendly without a service container), swap the global setup to
`@testcontainers/postgresql`: start one `PostgreSqlContainer("postgres:17")` in `vitest.global-setup.ts`,
expose its URI to tests via vitest's `provide`/`inject` (augment `ProvidedContext`), run migrations
against it, and tear down after. Trade-off: ~3–5s container boot per run vs a manual `docker compose up`.

**Confidence Score: 9/10** for one-pass success — raised from an initial 7.5 after a full throwaway
spike was **executed** on this machine (see PRE-FLIGHT VERIFICATION). M2's four first-time
integrations were each proven, not assumed: Drizzle `generate→migrate→onConflict` idempotency ran
green against a real `postgres:17`; `tsc -b` across all 4 workspaces compiled clean under
NodeNext + `verbatimModuleSyntax` with drizzle/pg/fastify; AES-256-GCM encryption-at-rest +
round-trip + tamper-detection passed; the Fastify v5 + fastify-plugin v6 app returned the right
200/400/401 via `inject`; and the vitest globalSetup + `skipIf` harness was confirmed to run with a
DB and self-skip without one. Exact versions are pinned from that install (two wrong guesses —
drizzle-orm 0.45 and **fastify-plugin v6** — corrected), and the two real API surprises the spike
surfaced (Drizzle's array-form table-config callback; `db.execute().rows`) are written into the
tasks. What keeps it at 9 and not 10 is the irreducible first-write of the *real* product code that
the spike intentionally did not build: the `collector push` `ParseResult`→batch mapping, the atomic
pairing transaction (redeem→createMachine→issueToken), and the admin-token route — all low-risk given
the proven primitives, and all caught by the Level 1–3 validation ladder before the real-data Level 4
run. Reaching a literal 10 requires executing that code; the honest way up the last point is to
**build it**, not to inflate the estimate.

**Relevant Documentation (sources):**
[Drizzle node-postgres setup](https://orm.drizzle.team/docs/get-started/postgresql-new) ·
[Drizzle Kit migrate](https://orm.drizzle.team/docs/drizzle-kit-migrate) ·
[Fastify TypeScript](https://fastify.dev/docs/latest/Reference/TypeScript/) ·
[@fastify/bearer-auth](https://github.com/fastify/bearer-auth) ·
[Node crypto Cipher (AES-GCM)](https://nodejs.org/docs/latest-v24.x/api/crypto.html#class-cipher) ·
[@testcontainers/postgresql](https://node.testcontainers.org/modules/postgresql/)
