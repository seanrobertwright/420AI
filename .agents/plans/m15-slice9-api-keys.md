# Feature: M15 Slice 15.9 — API keys + retire `ADMIN_TOKEN`

The following plan should be complete, but it is important that you validate documentation and
codebase patterns and task sanity before you start implementing.

Pay special attention to naming of existing utils, types and models. Import from the right files.
Conventions are **not** re-pasted here — [`CLAUDE.md`](../../CLAUDE.md) is the source of truth, and
the milestone context is [`m15-multi-user-access-control.md`](./m15-multi-user-access-control.md).

## Feature Description

The last credential slice of M15. It adds a **third credential tier** — hashed, revocable,
per-user, attributable **API keys** — and then **retires `ADMIN_TOKEN` as an auth credential**
(D-M15-7), leaving it as an inert env var that authenticates nothing.

Today `ADMIN_TOKEN` is a shared, un-attributable, un-revocable, un-expiring god-token accepted as
branch (1) of `resolvePrincipal` (`apps/ingest/src/auth.ts:65-74`). It resolves to the bootstrap
admin principal, so every holder acts as the same `owner`. Two clients still present it: the
**desktop app** (`keychain.rs` / `proxy.rs` / `server.rs`) and **`scripts/generate-reports.mjs`**.

After this slice each machine client holds its own named key, minted by a real human, capped at that
human's rung, individually revocable, and visible in a list with a last-used timestamp.

## User Story

As an **operator running 420AI for a team**
I want to **issue named, revocable API keys to my desktop app and scheduled scripts, and retire the
shared admin token**
So that **a leaked or stale machine credential can be revoked on its own, without rotating a secret
every client shares, and so every machine-originated write is attributable to a person.**

## Problem Statement

`ADMIN_TOKEN` violates every property M15 has spent nine slices establishing:

1. **Un-attributable.** Every holder resolves to `app.adminEmail`, so the audit table 15.10 is about
   to add would record "the bootstrap admin" for actions taken by three different clients.
2. **Un-revocable.** Revoking it means editing env and restarting the server, which revokes it for
   *all* clients at once. 15.6 built revocation for sessions; this tier never got it.
3. **Un-scopeable.** It is always `owner`. `scripts/generate-reports.mjs` needs to POST reports; it
   gets full ownership of the deployment, including member removal.
4. **It is a documented hole in the SSE revocation guarantee.** `routes/monitor.ts:337-341` skips the
   per-tick session re-check when `sid === null`, and says so in prose: *"That tier is un-revocable
   by construction until D-M15-7 retires it in 15.9."*

## Solution Statement

An `api_keys` **identity table** (keyed by `user_id`, no `org_id`, no RLS — the same classification
as `sessions` / `sso_identities` / `totp_credentials`), a sha256-hashed token with a distinguishing
`k420_` prefix, a three-route self-service surface beside `/v1/auth/sessions`, and a new branch in
`resolvePrincipal` that resolves a key to its owner's principal with a **role ceiling**.

Then, in a clearly separated final phase, `ADMIN_TOKEN`'s auth branch is deleted, the
`buildApp({ adminToken })` option is removed, and all 24 call sites migrate to a real credential.

**Deliberate three-phase order** so the branch is shippable and reviewable at every commit:

| Phase | Effect if you stop here |
| --- | --- |
| A — API keys land (purely additive) | Both credentials work. Nothing breaks. |
| B — Consumers migrate (desktop, script) | Both credentials work; nobody uses `ADMIN_TOKEN`. |
| C — `ADMIN_TOKEN` retired | The tier is gone. |

## Feature Metadata

**Feature Type**: New Capability + Refactor (credential retirement)
**Estimated Complexity**: **High** (M–L in the milestone plan; the 24-file test migration in Phase C
and the Rust work are the size drivers, not the feature itself)
**Primary Systems Affected**: `packages/db` (schema + migration + repository), `apps/ingest`
(auth resolution, one new route file, error mapping), `apps/desktop` (Rust: keychain/proxy/server +
the Settings webview), `scripts/generate-reports.mjs`, `docs/guide/operations.md`, `.env.example`
**Dependencies**: **None new.** Everything uses `node:crypto` via the existing
`packages/db/src/tokens.ts` helpers. No new npm or cargo dependency.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**The credential path you are extending**

- `apps/ingest/src/auth.ts` (whole file, 146 lines) — `resolvePrincipal`. Branch (1) is the
  `ADMIN_TOKEN` path you delete in Phase C; your new branch goes where it was. Read the ordering
  comment at lines 65-70 — it explains *why* the service branch is first and session-free.
- `apps/ingest/src/plugins/auth.ts` (lines 9-79) — the `declare module "fastify"` augmentation. Add
  `request.apiKeyId` here, and note line 91-95: **`decorateRequest` defaults must be primitives or
  `null`**, never object literals (Fastify shares the reference across requests).
- `packages/db/src/repositories/principal.ts` (whole file, 67 lines) — `Principal` and
  `findPrincipalByEmail`. Your key branch resolves through this same function.

**The table shape to mirror (this is the closest structural twin)**

- `packages/db/src/repositories/sessions.ts` (whole file, 203 lines) — mirror its **silent-library
  discipline**, its `DbClient` parameter, its `undefined`/`false`/count returns (no typed error), its
  explicit `sessionRowColumns` constant, and its **app-clock** expiry comparison (lines 76-84 explain
  why `now()` was wrong).
- `packages/db/src/schema.ts:220-254` (`sessions`) and `:911-992` (`totp_credentials`,
  `mfa_recovery_codes`) — the identity-table header-comment format. Every column is justified.
- `packages/db/src/schema.ts:200-218` (`password_reset_tokens`) — the `token_hash … .unique()` shape.
- `packages/db/src/repositories/tokens.ts` (whole file, 39 lines) — `issueIngestToken` /
  `findMachineIdByToken`. **This is the exact hash-lookup pattern for a pre-context auth read.**
- `packages/db/src/tokens.ts` (16 lines) — `generateToken()` (`randomBytes(32).toString("base64url")`)
  and `hashToken()` (sha256 hex). Re-exported from `@420ai/db` (`index.ts:42`).

**The route surface to mirror**

- `apps/ingest/src/routes/auth.ts:536-604` — `GET /v1/auth/sessions` + `DELETE /v1/auth/sessions/:id`.
  Copy this shape exactly: `resolvePrincipal` → `authorized(principal, "viewer")` → `isUuid` →
  repository call → **404 not 403** when the row is someone else's (enumeration oracle, see the
  comment at 568-574).
- `apps/ingest/src/routes/mfa.ts:249-296` — the **re-auth gate** you must extract and reuse
  (D-15.8-16). Two branches: password when `passwordHash` is set, session-age
  (`MFA_REAUTH_MAX_SESSION_AGE_MS`, exported at `mfa.ts:62`) when it is null. Note the
  `config: { rateLimit: app.rateLimitLogin }` at line 258 and the comment explaining why a
  session-gated route needs it *once it verifies a password*.
- `apps/ingest/src/routes/members.ts` (whole file, 346 lines) — the fullest example of the repo's
  route idiom, and the source of the `hasRole` **ceiling** discipline (D-15.5-11, lines 29-51).

**The gates your change must satisfy**

- `apps/ingest/src/routes/org-scoping.test.ts` (whole file, 235 lines) — the structural grep. Your new
  route file touches `app.db` without `withOrg`, so it **needs an `ALLOWED_WITHOUT_WITHORG` entry AND
  a matching `M15 15.3` explanation in its own header** (the test at lines 140-147 asserts both).
- `packages/db/src/repositories/rls.int.test.ts:136-164` — `NO_RLS_TABLES`. Add `api_keys`. **Every
  count in that file is derived from list lengths**, so adding an entry moves no expected number and
  the "all 17 tenant tables" title stays 17.
- `packages/db/src/repositories/mfa.int.test.ts:1-60` — the **two-role int-suite harness**. Copy this
  header verbatim in shape: `owner = createDb(TEST_URL)` for setup only, `appRole = createDb(APP_URL)`
  for every assertion, `describe.skipIf(!TEST_URL || !APP_URL)`, both pools closed in `afterAll`.
- `packages/db/drizzle/0020_talented_dark_phoenix.sql` — the precedent for a migration that
  **deliberately appends no policy block**, and states that absence as a decision.

**The consumers to migrate**

- `apps/desktop/src-tauri/src/keychain.rs:45-80` — `ServerConfig`. Note the `#[serde(default)]`
  comment at 61-64: **a new field without it makes every stored blob fail to deserialize, and
  `load()` maps a parse failure to `None` — silently presenting a configured user as unpaired.**
- `apps/desktop/src-tauri/src/proxy.rs:27-46` — `monitor_credentials()`, keychain-then-env fallback.
- `apps/desktop/src-tauri/src/server.rs:41-58` (`ServerConfigView`), `:60-86` (`ServerConfigInput`),
  `:145-186` (`ingest_env`), `:188-204` (`to_view`), `:206-221` (`merge_secret`), `:300-330`
  (`set_server_config`).
- `apps/desktop/src/lib/bridge.ts:98-131` and `apps/desktop/src/components/Settings.tsx:293-305`.
- `scripts/generate-reports.mjs:11-20` (header) and `:95-98` (env read).

**Server wiring**

- `apps/ingest/src/server.ts:14-21` (the `ADMIN_TOKEN` throw), `:237-263` (the **actual** first-run
  owner bootstrap — `ensureUserByEmail` + `setUserPassword` from `ADMIN_EMAIL`/`ADMIN_PASSWORD`).
- `apps/ingest/src/app.ts:1-60` (imports + `BuildAppOptions`), `:148` (the decorator), `:236-286`
  (`setErrorHandler` and the `MemberError` → status mapping you will extend).

### New Files to Create

- `packages/db/src/repositories/api-keys.ts` — the repository.
- `packages/db/src/repositories/api-keys.int.test.ts` — **two-role** repository suite.
- `apps/ingest/src/routes/api-keys.ts` — the three HTTP routes.
- `apps/ingest/src/api-keys.int.test.ts` — HTTP-layer suite (mirrors `sessions.int.test.ts`).
- `packages/db/drizzle/0021_*.sql` — **generated by `npm run db:generate`**, then hand-annotated with
  a header comment (see Task 3).
- `packages/db/drizzle/down/0021_*.sql` — the rollback SQL (mirror an existing `down/` file).

### Relevant Documentation

- [RFC 6750 §2.1 — Bearer token usage](https://datatracker.ietf.org/doc/html/rfc6750#section-2.1)
  — Why the credential travels in `Authorization: Bearer`, unchanged from the other two tiers.
- [OWASP Cheat Sheet — Secrets Management §Key rotation](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
  — Why show-once + store-hash, and why per-client credentials beat one shared secret.
- [OWASP Session Management — server-side invalidation](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#session-expiration)
  — The rule 15.6 applied to sessions; Task 8 applies the same rule to a long-lived key on the SSE
  stream.
- [Drizzle — generating migrations](https://orm.drizzle.team/docs/migrations)
  — `db:generate` produces the numbered SQL from `schema.ts`; you then hand-annotate it.

### Patterns to Follow

**Explicit column lists — rows that reach `reply.send()`**
(CLAUDE.md's 15.1 rule; no route declares a Fastify `response` schema, so nothing strips extras.)
The constant must mirror the exported interface, and **`token_hash` must not be in it.**

```ts
/** Explicit column list — these rows reach `reply.send()` (CLAUDE.md 15.1). NO `token_hash`. */
const apiKeyRowColumns = {
  id: apiKeys.id,
  name: apiKeys.name,
  role: apiKeys.role,
  lastUsedAt: apiKeys.lastUsedAt,
  expiresAt: apiKeys.expiresAt,
  createdAt: apiKeys.createdAt,
};
```

**The pre-context hash lookup** — mirrors `findMachineIdByToken` (`repositories/tokens.ts:32-39`),
plus an expiry predicate on the **app clock** (`sessions.ts:76-84` explains why not `now()`):

```ts
export async function findLiveApiKey(
  db: DbClient,
  token: string,
): Promise<{ id: string; userId: string; role: string | null } | undefined> {
  const [row] = await db
    .select({ id: apiKeys.id, userId: apiKeys.userId, role: apiKeys.role })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.tokenHash, hashToken(token)),
        isNull(apiKeys.revokedAt),
        // App clock, matching `findLiveSession` — see the comment there. `expires_at IS NULL`
        // means "never expires", so it must be an OR, not a bare `gt`.
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
      ),
    )
    .limit(1);
  return row;
}
```

> **Assertions this snippet encodes, proven by SPIKE 1/2 (see NOTES).** The app role can `SELECT`
> and `INSERT` on a freshly-created `api_keys`-shaped table **with no org context set** and with no
> explicit `GRANT` — measured, not assumed. If that stops being true the table needs a `GRANT`
> block, not a policy.

**Silent library** — `packages/db` never logs and never throws for an ordinary miss. `findLiveApiKey`
returns `undefined` for unknown / revoked / expired, collapsed on purpose exactly as `findLiveSession`
collapses its three reasons: the caller answers 401 to all of them, and distinguishing them at the API
tells an attacker whether a guessed value exists.

**Route idiom** (from `routes/auth.ts:546-566` — copy the ordering, it is load-bearing):

```ts
const principal = await resolvePrincipal(app, request);
if (!principal) return reply.code(401).send({ error: "admin authorization required" });
if (!authorized(principal, "viewer")) return reply.code(403).send({ error: "insufficient role" });
if (!isUuid(request.params.id)) return reply.code(400).send({ error: "invalid api key id" });
```

**Naming**: `kebab-case.ts` files, `camelCase` functions, `snake_case` columns, `.js` import
suffixes, `import type` for type-only imports.

---

## DECISIONS (record these in the plan's commit; they are referenced by the tasks below)

**D-15.9-1 — `api_keys` is an IDENTITY table: `user_id`, no `org_id`, NO RLS.** It joins
`users` / `organizations` / `memberships` / `password_reset_tokens` / `sessions` / `sso_identities` /
`totp_credentials` / `mfa_recovery_codes` in `NO_RLS_TABLES`. The reason is the one the whole chain
gives: the row is read **inside `resolvePrincipal`, at the one moment before any org context exists**,
because resolving it is part of what establishes that context. A strict policy here would read zero
rows and every API key would silently 401. The migration therefore appends **no policy block**, and
that absence is the decision — say so in the migration header, as `0020` does.

**D-15.9-2 — HASHED with `hashToken` (sha256), not encrypted and not scrypt.** Same choice as
`ingest_tokens.token_hash`, `invites.token_hash` and `mfa_recovery_codes.code_hash`: the token is
machine-generated `randomBytes(32)`, so there is no dictionary to defend against, and the value is
only ever *compared*, never read back. The plaintext is returned **exactly once**, from the mint
response, and is unrecoverable thereafter.

**D-15.9-3 — A distinguishing `k420_` prefix, routed with `startsWith`, NEVER by splitting on `_`.**
The prefix lets `resolvePrincipal` decide which branch to take without a DB probe on every session
token, and lets a leaked string be recognised in a log or a git history.
**SPIKE 3 FINDING — this is a real trap:** `generateToken()` is base64url, whose alphabet **includes
`_` and `-`** (measured: `-0-9A-Z_a-z` across 200 samples). So a token body routinely contains
underscores. Any "split on the last underscore" or `split("_")[1]` parsing is wrong and will
mis-handle a fraction of otherwise-valid keys. Use `token.startsWith(API_KEY_PREFIX)` and
pass the **whole token** to `hashToken` — the hash covers the prefix too, so there is nothing to
strip. Total length is 48 (5 + 43).

**D-15.9-4 — A key carries an OPTIONAL role, and the effective role is the LOWER of (key role,
the owner's CURRENT membership role), re-derived on every request.** This is D-15.5-11's ceiling
applied to a credential instead of a person: you may never mint a key above your own rung. The
`min` — not just the mint-time cap — is what makes a demotion take effect on the *next request*
rather than on key rotation, exactly as `findPrincipalByEmail` already re-resolves a session's role
(D-15.6-7). `role IS NULL` means "inherit the membership role exactly", which is what `ADMIN_TOKEN`
does today, so the desktop app's migration is behaviour-preserving.
**A key whose stored `role` is not in `ROLES` is REJECTED (401), not clamped** — `isRole` narrows,
and failing closed on a hand-edited row is the same direction `hasRole` already fails.

**D-15.9-5 — An API key is never MFA-gated, and mints no session.** MFA is enforced at *login*
(`routes/auth.ts:137`), and a key can only exist because an already-authenticated — and, if enrolled,
already-MFA'd — session minted it. This is D-15.8-15's reasoning for the service token, now attached
to a credential that is actually attributable and revocable. `request.sessionId` stays `null` for a
key caller; `request.apiKeyId` is set instead.

**D-15.9-6 — Minting requires RE-AUTHENTICATION, reusing 15.8's gate verbatim.** A long-lived
credential minted from a stolen cookie is a persistence primitive that outlives the session it came
from — the same argument D-15.8-16 made for arming a second factor, and it applies at least as
strongly here. **Extract** the gate from `routes/mfa.ts:268-295` into one exported helper rather than
copying it: two copies of a security check drift, and this repo has already paid for that once.
Listing and revoking are **not** gated — revocation must never be harder than minting.

**D-15.9-7 — `last_used_at`, written at most once per `API_KEY_TOUCH_THROTTLE_MS` (default 60 000).**
`sessions` deliberately has no such column (schema.ts:234-237) because touching it puts a write on
every authenticated read. That reasoning is *not* weaker here — it is why the write is **throttled in
process**, mirroring `app.reconcileLastRunAt` (`plugins/auth.ts:31-34`), which exists for exactly
this shape (audit B.4). Without the column, "is this key still in use?" is unanswerable and every
revocation is a guess; with an unthrottled write, the desktop app's monitor poll writes on every
tick. The write is **fire-and-forget** (`void … .catch(() => {})`, matching
`recordIngestAuthFailure` at `plugins/auth.ts:108`) so it never alters auth latency or the 401
contract.

**D-15.9-8 — Optional expiry: `expires_at` nullable, NULL = never.** Compared against the **app
clock**, matching `findLiveSession`. Requires `or(isNull(...), gt(...))` — a bare `gt` silently makes
every never-expiring key invalid, which would present as "API keys don't work at all".

**D-15.9-9 — Removing a member revokes their API keys; changing a password does NOT.** Member removal
already revokes sessions in the same transaction (`routes/members.ts:335`), and the argument there —
"remove an employee, sign them out" — is *strictly stronger* for a key, which has no expiry to save
you. A password change is different: a key is not derived from the password, and revoking on a
routine rotation would silently break the desktop app and every scheduled script, which is a worse
outcome than the threat it addresses. Both halves carry the same 15.10 revisit note
`revokeAllSessions` already carries (multi-org membership inverts the reasoning).

**D-15.9-10 — `ADMIN_TOKEN` is deleted as an auth credential, and the `buildApp` option goes with
it.** An option that still exists but authenticates nothing is precisely the false guarantee this
repo has been burned by; leaving it inert would mean the next reader has to test the server to find
out. The env var itself stays *documented as removed* in `.env.example` (so an upgrading operator
learns why their token stopped working) but is read by nothing. **The first-run bootstrap is
unaffected** — verified: the initial owner is seeded by `ensureUserByEmail(adminEmail)` +
`setUserPassword` from `ADMIN_EMAIL`/`ADMIN_PASSWORD` (`server.ts:237-263`); `ADMIN_TOKEN` seeds
nothing today. Where D-M15-7 says "survives as a first-run bootstrap seed", that seed is
`ADMIN_EMAIL`/`ADMIN_PASSWORD` and it already exists.

---

## IMPLEMENTATION PLAN

### Phase A — API keys (purely additive; nothing breaks if you stop here)

Schema + migration, repository, the `resolvePrincipal` branch, three routes, and both test suites.
`ADMIN_TOKEN` keeps working throughout.

### Phase B — Migrate the consumers (both credentials still work)

Desktop Rust (keychain field, proxy resolution, `ingest_env`, the masked view, the Settings form) and
`scripts/generate-reports.mjs`. Each accepts an API key **preferentially**, falling back to
`ADMIN_TOKEN` so a half-upgraded install keeps running.

### Phase C — Retire `ADMIN_TOKEN`

Delete branch (1), delete the `buildApp` option, migrate 24 test files to a real credential, remove
the desktop fallback, update `.env.example` + `docs/guide/operations.md` (including the corrected
break-glass procedure: **direct DB access via the `db:*` scripts, never an HTTP token**).

### Phase D — Validation & docs

Full gate with `--require-db`, `cargo test`, `SUMMARY.md` update in the same commit as the
execution report.

---

## STEP-BY-STEP TASKS

Execute in order. Each task is atomic and independently validatable.

### 1. ADD `apiKeys` table to `packages/db/src/schema.ts`

- **IMPLEMENT**: A new `pgTable("api_keys", …)` placed **after `ssoIdentities`** (keep the identity
  tables together). Columns: `id` uuid pk `defaultRandom`; `userId` uuid notNull → `users.id`;
  `name` text notNull; `tokenHash` text notNull `.unique()`; `role` text (nullable); `lastUsedAt`
  timestamptz; `expiresAt` timestamptz; `revokedAt` timestamptz; `createdAt` timestamptz notNull
  `defaultNow()`. Index: `index("api_keys_by_user").on(t.userId)`.
- **PATTERN**: `schema.ts:239-254` (`sessions`) for the table shape; `:200-218`
  (`password_reset_tokens`) for `tokenHash … .unique()`.
- **IMPORTS**: already present in the file (`pgTable`, `uuid`, `text`, `timestamp`, `index`).
- **GOTCHA**: Write a **header comment in the file's established style** — one paragraph naming the
  identity-table classification (D-15.9-1) and one line per column that encodes a decision (`role`
  nullable = inherit; `expires_at` nullable = never; why `last_used_at` exists here but not on
  `sessions`). The surrounding tables all do this; a bare table would be the odd one out.
- **VALIDATE**: `npm run typecheck`

### 2. GENERATE the migration

- **IMPLEMENT**: `npm run db:generate` → produces `packages/db/drizzle/0021_<name>.sql`.
- **GOTCHA**: Do **not** hand-write the DDL. Do not renumber. Commit the `meta/` journal changes
  drizzle emits alongside it.
- **VALIDATE**: `ls packages/db/drizzle/0021_*.sql` — exactly one new file.

### 3. UPDATE `packages/db/drizzle/0021_*.sql` — annotate the header

- **IMPLEMENT**: Prepend a comment block, mirroring `0020_talented_dark_phoenix.sql`, stating:
  (a) this migration appends **no policy block** and that absence is D-15.9-1, not an omission;
  (b) `api_keys` joins `NO_RLS_TABLES` in `rls.int.test.ts`, where every count is derived, so it
  moves no expected number; (c) **no `GRANT` is needed** — 0015's
  `ALTER DEFAULT PRIVILEGES … TO "420ai_app"` covers it, **re-verified live against `420ai_test`
  during planning for this exact table shape (SPIKE 1: the app role received DELETE/INSERT/SELECT/
  UPDATE implicitly; `relrowsecurity = false`, `relforcerowsecurity = false`, 0 policies)**.
- **PATTERN**: `packages/db/drizzle/0020_talented_dark_phoenix.sql` lines 1-20.
- **VALIDATE**: `head -25 packages/db/drizzle/0021_*.sql`

### 4. CREATE `packages/db/drizzle/down/0021_*.sql`

- **IMPLEMENT**: `DROP TABLE "api_keys";` (the index and FK go with it).
- **PATTERN**: an existing file under `packages/db/drizzle/down/`. Match its naming convention
  exactly — `db:rollback` resolves by name.
- **VALIDATE**: `npm run db:migrate && npm run db:rollback && npm run db:migrate` — round-trips clean.

### 5. CREATE `packages/db/src/repositories/api-keys.ts`

- **IMPLEMENT**: `apiKeyRowColumns` (no `tokenHash`), `ApiKeyRow`, and:
  - `createApiKey(db, userId, opts: { name, role?, expiresAt? }): Promise<{ key: ApiKeyRow; token: string }>`
    — `token = API_KEY_PREFIX + generateToken()`, store `hashToken(token)`, return the plaintext once.
  - `findLiveApiKey(db, token)` — as the snippet in "Patterns to Follow".
  - `touchApiKeyLastUsed(db, id): Promise<void>`.
  - `listApiKeys(db, userId): Promise<ApiKeyRow[]>` — live only, newest first.
  - `revokeApiKey(db, userId, id): Promise<boolean>` — `userId` is the **second** parameter and is
    NOT optional (the `sessions.ts:91-98` rule; without it any caller could revoke a guessed id).
  - `revokeAllApiKeys(db, userId): Promise<number>` — for D-15.9-9.
- **PATTERN**: `packages/db/src/repositories/sessions.ts` for structure and comment discipline;
  `repositories/tokens.ts:32-39` for the hash lookup.
- **IMPORTS**: `import { and, desc, eq, gt, isNull, or } from "drizzle-orm";`,
  `import type { DbClient } from "../client.js";`, `import { apiKeys } from "../schema.js";`,
  `import { generateToken, hashToken } from "../tokens.js";`
- **GOTCHA**: `revokeAllApiKeys` is a blind `UPDATE` with its whole predicate in the `WHERE` — so it
  excludes revoke-vs-revoke (EvalPlanQual re-evaluates `revoked_at IS NULL`) but **not** revoke-vs-
  INSERT. **Name that in the comment**, as `revokeAllSessions` does (`sessions.ts:119-131`); CLAUDE.md
  is explicit that "it's in a transaction" is almost never the mechanism.
- **GOTCHA**: `API_KEY_PREFIX = "k420_"` — export it from `packages/db/src/tokens.ts` so the ingest
  branch and the repository share one definition.
- **VALIDATE**: `npm run typecheck`

### 6. UPDATE `packages/db/src/index.ts` — export the new surface

- **IMPLEMENT**: Export the six functions, the `ApiKeyRow` type, and `API_KEY_PREFIX`.
- **PATTERN**: `index.ts:120-121` (the sessions block).
- **VALIDATE**: `npm run typecheck`

### 7. UPDATE `apps/ingest/src/auth.ts` — the API-key branch in `resolvePrincipal`

- **IMPLEMENT**: After the bearer is extracted and **before** the session branch:

```ts
// (1b) API key — M15 15.9. Routed by PREFIX, so a session token never pays for a key lookup and a
// key never pays for an HMAC. `startsWith`, never a split on `_`: base64url's alphabet INCLUDES
// `_` and `-`, so a token body routinely contains underscores (measured during planning).
if (token.startsWith(API_KEY_PREFIX)) {
  const key = await findLiveApiKey(app.db, token);
  if (!key) return null;
  const principal = await findPrincipalByEmail(app.db, /* the key's owner */ ...);
  ...
}
```

  Resolve the owner's principal, then apply **D-15.9-4**: if `key.role` is set, reject when
  `!isRole(key.role)`, else take the lower of the two rungs
  (`hasRole(principal.role, key.role) ? key.role : principal.role`). Set `request.principal`,
  `request.sessionId = null`, `request.apiKeyId = key.id`. Fire the throttled
  `touchApiKeyLastUsed` **fire-and-forget**.
- **PATTERN**: the existing branch structure at `auth.ts:65-97`; the fire-and-forget idiom at
  `plugins/auth.ts:106-108`.
- **IMPORTS**: add `findLiveApiKey`, `touchApiKeyLastUsed`, `API_KEY_PREFIX` from `@420ai/db`;
  `isRole` from `@420ai/shared`.
- **GOTCHA**: `findPrincipalByEmail` takes an **email**, not a user id. Either add a
  `findPrincipalByUserId` to `repositories/principal.ts` (mirroring the existing function's
  `innerJoin` + `ORDER BY (created_at, id) LIMIT 1` — **keep that ordering identical**, it is what
  makes both functions resolve to the same org) or have `findLiveApiKey` join `users` to return the
  email. **Prefer the former**: it is the read the 15.10 team surfaces will want anyway, and it
  avoids widening the hot auth read.
- **GOTCHA**: Update the file's header comment. It currently documents **two** credential paths and
  says branch (1) is retired "in 15.9" — that prose becomes false the moment you land this.
- **VALIDATE**: `npm run typecheck && npx vitest run apps/ingest/src/authorize.test.ts`

### 8. UPDATE `apps/ingest/src/routes/monitor.ts` — re-check the API key per SSE tick

- **IMPLEMENT**: Capture `const keyId = request.apiKeyId;` beside `const sid = request.sessionId;`
  (line 281, **before the hijack**, with the other pre-hijack guards). Extend the per-tick re-check
  at lines 336-342: when `sid` is null but `keyId` is set, probe the key and
  `terminate("api key revoked")` if it is gone.
- **PATTERN**: the existing `if (sid) { … }` block at `monitor.ts:336-341`.
- **GOTCHA**: **This is the sharpest correctness risk in the slice.** The existing skip is justified
  *only* by `ADMIN_TOKEN` being un-revocable — the comment says so in as many words. An API key **is**
  revocable, so inheriting that skip silently would re-open the exact hole 15.6 closed, one tier over:
  revoke a key, and the desktop app's open stream keeps delivering the org's live snapshot for as long
  as it holds the socket. Rewrite that comment; do not leave it describing a tier that no longer
  exists.
- **GOTCHA**: Add a repository read for the key that does **not** touch `last_used_at` — the tick must
  not become a per-tick write per connected client (that is precisely audit B.4).
- **VALIDATE**: `npm run typecheck`

### 9. EXTRACT the re-auth gate from `apps/ingest/src/routes/mfa.ts`

- **IMPLEMENT**: Move the two-branch gate (`mfa.ts:268-295`) into an exported helper — suggested
  `apps/ingest/src/reauth.ts`, exporting `REAUTH_MAX_SESSION_AGE_MS` and
  `requireRecentAuth(app, request, currentPassword): Promise<{ ok: true } | { ok: false; code: 401; body: {...} }>`.
  Re-point `routes/mfa.ts` at it. **Keep `MFA_REAUTH_MAX_SESSION_AGE_MS` exported from `mfa.ts` as a
  re-export** — `mfa.int.test.ts` imports it by that name (`mfa.ts:59-60` says the suite drives the
  same number).
- **PATTERN**: the code at `routes/mfa.ts:268-295` verbatim; do not re-derive the branches.
- **GOTCHA**: Do **not** copy-paste it into the new route file. Two copies of an auth check drift, and
  the divergence is invisible to `tsc`.
- **VALIDATE**: `npx vitest run apps/ingest/src/mfa.int.test.ts` — unchanged behaviour.

### 10. ADD the body schema to `apps/ingest/src/schemas.ts`

- **IMPLEMENT**: `createApiKeyBodySchema` — `required: ["name"]`, `additionalProperties: false`;
  `name` string 1..80; `role` string `enum: ["viewer","member","admin","owner"]` (optional);
  `expiresInDays` integer 1..3650 (optional); `currentPassword` string (optional, for D-15.9-6).
- **PATTERN**: `schemas.ts:466-476` (`inviteMemberBodySchema`) and `:589-603` (`mfaEnrollBodySchema`).
- **VALIDATE**: `npm run typecheck`

### 11. CREATE `apps/ingest/src/routes/api-keys.ts`

- **IMPLEMENT**: Three routes, all `resolvePrincipal` → `authorized(principal, "viewer")`:
  - `POST /v1/auth/api-keys` — `config: { rateLimit: app.rateLimitLogin }` (it verifies a password —
    same reasoning as `mfa.ts:252-258`). Re-auth via Task 9's helper. Enforce the D-15.9-4 ceiling
    with `hasRole(principal.role, requestedRole)` → 403 `"cannot grant a role above your own"`.
    Return `{ apiKey: <row>, token }` — **the only time the plaintext exists.**
  - `GET /v1/auth/api-keys` — live keys, newest first. Never returns `tokenHash`.
  - `DELETE /v1/auth/api-keys/:id` — `isUuid` → 400; **404, not 403**, when it is not the caller's.
- **PATTERN**: `routes/auth.ts:536-604` for list/revoke; `routes/members.ts:100-108` for the ceiling.
- **GOTCHA**: The file **must** carry a header comment containing the literal string `M15 15.3`
  explaining why it is not `withOrg`-wrapped — `org-scoping.test.ts:140-147` asserts exactly that on
  every allow-listed file. Reuse the `auth.ts` / `mfa.ts` wording: an identity table with no `org_id`
  and no policy, read before any org context exists.
- **VALIDATE**: `npm run typecheck`

### 12. UPDATE `apps/ingest/src/routes/org-scoping.test.ts` — allow-list the new file

- **IMPLEMENT**: Add `"api-keys.ts": "…"` to `ALLOWED_WITHOUT_WITHORG` with a real reason (D-15.9-1).
- **PATTERN**: the `"mfa.ts"` entry at lines 72-78.
- **VALIDATE**: `npx vitest run apps/ingest/src/routes/org-scoping.test.ts`

### 13. UPDATE `apps/ingest/src/plugins/auth.ts` + `apps/ingest/src/app.ts` — wire it up

- **IMPLEMENT**: (a) declare `request.apiKeyId: string | null` in the module augmentation and
  `app.decorateRequest("apiKeyId", null)`; (b) declare `app.apiKeyTouchThrottleMs: number` +
  `app.apiKeyLastTouchedAt: Map<string, number>` (D-15.9-7); (c) `import apiKeyRoutes from
  "./routes/api-keys.js"` and `app.register(apiKeyRoutes)` beside `memberRoutes`; (d) decorate the
  throttle **before** route registration, matching the `rateLimitLogin` comment at `app.ts:194`.
- **PATTERN**: `plugins/auth.ts:27-34` (the `reconcileLastRunAt` pair) and `:91-95` (decorator
  defaults).
- **GOTCHA**: `decorateRequest("apiKeyId", null)` — a primitive/`null` default only.
- **VALIDATE**: `npm run typecheck`

### 14. CREATE `packages/db/src/repositories/api-keys.int.test.ts` — TWO-ROLE

- **IMPLEMENT**: `describe.skipIf(!TEST_URL || !APP_URL)`. **First test asserts role identity**:
  `current_setting('is_superuser') = 'off'` AND `rolbypassrls = false`. Then: mint→lookup round-trip;
  a revoked key is invisible; an expired key is invisible; **a NULL `expires_at` key is still live**
  (the `or(isNull(...))` regression — a bare `gt` breaks every key); `revokeApiKey` refuses another
  user's id; `revokeAllApiKeys` is idempotent (second call returns 0); `touchApiKeyLastUsed` moves
  the column; the plaintext token appears **nowhere** in the table (`select * … where token_hash like
  '%' || $1` returns nothing for the plaintext).
- **PATTERN**: `packages/db/src/repositories/mfa.int.test.ts:1-60` — copy the harness header shape
  exactly. Owner handle for `TRUNCATE`/seeding only; **every assertion on `appRole`**.
- **GOTCHA**: Close **both** pools in `afterAll` or vitest hangs. Any test holding a transaction open
  must release it in a `finally` (CLAUDE.md's 15.5 lesson — one real failure wore five fake ones).
- **VALIDATE**: `npx vitest run packages/db/src/repositories/api-keys.int.test.ts`

### 15. CREATE `apps/ingest/src/api-keys.int.test.ts` — HTTP layer

- **IMPLEMENT**: Mint→use→revoke→401 end-to-end; the role ceiling (a `member` minting an `admin` key
  → 403); the **effective-role floor** (mint an `admin` key, demote the owner to `viewer`, assert the
  key now acts as `viewer` — this is the D-15.9-4 `min`, and it is the assertion that proves the role
  is re-derived rather than frozen); re-auth required (wrong/missing password → 401
  `reason: "password_required"`); a revoked key 401s; `GET` never leaks `tokenHash`; the mint response
  is the **only** place `token` appears; a key caller is **not** MFA-gated even when its owner is
  enrolled (D-15.9-5).
- **PATTERN**: `apps/ingest/src/sessions.int.test.ts` and `rbac.int.test.ts` (which already drives
  real requests as a real viewer and a real member — reuse its seeding).
- **GOTCHA**: `setUserPassword` auto-creates a personal `owner` membership via `ensurePersonalOrg`,
  and `findPrincipalByEmail` resolves the FIRST membership by `(created_at, id)` — so seeding a
  second-rung user by INSERTing a membership is silently shadowed and you will be testing an owner.
  **Move** the existing membership instead (CLAUDE.md's 15.4 finding).
- **VALIDATE**: `npx vitest run apps/ingest/src/api-keys.int.test.ts`

### 16. UPDATE `packages/db/src/repositories/rls.int.test.ts` — classify the table

- **IMPLEMENT**: Add `"api_keys"` to `NO_RLS_TABLES` with a comment in the established style
  (D-15.9-1), noting that every count in the file is derived so no expected number moves and the
  "all 17 tenant tables" title stays 17.
- **PATTERN**: the `sessions` / `sso_identities` / MFA entries at lines 143-160.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/rls.int.test.ts`

### 17. UPDATE `apps/ingest/src/routes/members.ts` — revoke keys on member removal (D-15.9-9)

- **IMPLEMENT**: In the `DELETE /v1/members/:userId` transaction, beside
  `if (removed) await revokeAllSessions(tx, request.params.userId);`, add
  `await revokeAllApiKeys(tx, request.params.userId);`.
- **PATTERN**: `routes/members.ts:312-336` — and extend that comment block rather than adding a new
  one; it already carries the 15.10 multi-org revisit note that applies verbatim.
- **VALIDATE**: add an assertion to the identity int suite; `npx vitest run apps/ingest/src/identity.int.test.ts`

--- Phase B — consumers ---

### 18. UPDATE `scripts/generate-reports.mjs`

- **IMPLEMENT**: Read `API_KEY` first, falling back to `ADMIN_TOKEN`. Update the header (lines 11-20)
  which currently calls `ADMIN_TOKEN` "the retained machine/service credential (12.3)".
- **GOTCHA**: **Use `||`, never `??`.** `.env.example` ships keys with EMPTY values, so
  `process.env.API_KEY ?? process.env.ADMIN_TOKEN` evaluates to `""` for exactly the upgrading
  operator the fallback exists for. CLAUDE.md records this as a shipped M15 15.5 bug.
- **VALIDATE**: `node -e "import('./scripts/generate-reports.mjs').then(m=>console.log(typeof m.parseArgs))"`

### 19. UPDATE `apps/desktop/src-tauri/src/keychain.rs`

- **IMPLEMENT**: Add `#[serde(default)] pub api_key: String,` to `ServerConfig`.
- **GOTCHA**: **`#[serde(default)]` is mandatory, not stylistic.** Without it every previously-stored
  keychain blob fails to deserialize, and `load()` maps a parse failure to `None` — silently
  presenting a configured user as UNPAIRED. The comment at `keychain.rs:61-64` documents this exact
  trap from the `database_url_app` addition. Extend the round-trip test.
- **VALIDATE**: `cd apps/desktop/src-tauri && cargo test`

### 20. UPDATE `apps/desktop/src-tauri/src/proxy.rs`

- **IMPLEMENT**: In `monitor_credentials()`, prefer `cfg.api_key`, then `env API_KEY`, then
  `cfg.admin_token`, then `env ADMIN_TOKEN` (the fallback chain is removed in Phase C).
- **PATTERN**: the existing `.map(...).filter(...).or_else(...)` chain at `proxy.rs:33-38` — an empty
  keychain string is already treated as unset, which is the Rust equivalent of the `||` rule above.
- **VALIDATE**: `cd apps/desktop/src-tauri && cargo test`

### 21. UPDATE `apps/desktop/src-tauri/src/server.rs`

- **IMPLEMENT**: `has_api_key` on `ServerConfigView`; `api_key: Option<String>` on
  `ServerConfigInput`; `merge_secret` it in `set_server_config`; `to_view` maps it. In `ingest_env`,
  **stop requiring `admin_token`** and do not inject `ADMIN_TOKEN` (Phase C removes the server's read
  of it entirely) — keep injecting it only while the Phase-B fallback exists, then delete.
- **PATTERN**: `server.rs:145-186` (`ingest_env`), `:188-204` (`to_view`), `:300-330` (merge).
- **VALIDATE**: `cd apps/desktop/src-tauri && cargo test`

### 22. UPDATE `apps/desktop/src/lib/bridge.ts` + `apps/desktop/src/components/Settings.tsx`

- **IMPLEMENT**: `hasApiKey` on the view type, `apiKey?` on the input type; rename the Settings field
  to "API key" with a placeholder explaining where to mint one
  (`Settings → API keys` in the dashboard, 15.10).
- **PATTERN**: `Settings.tsx:293-305` (the existing password-typed secret field + `secretPlaceholder`).
- **VALIDATE**: `npm run typecheck:desktop`

--- Phase C — retirement ---

### 23. REMOVE the `ADMIN_TOKEN` branch from `apps/ingest/src/auth.ts`

- **IMPLEMENT**: Delete branch (1) (lines 65-74) and the `timingSafeEqual` import if now unused.
  Rewrite the header comment's credential-path list.
- **VALIDATE**: `npm run typecheck`

### 24. REMOVE `adminToken` from `BuildAppOptions` and the decorator

- **IMPLEMENT**: `apps/ingest/src/app.ts:58` (the option) and `:148` (`app.decorate`), plus the
  `adminToken: string` line in the `plugins/auth.ts` module augmentation, plus `server.ts:19` and its
  throw at `:21`.
- **GOTCHA**: **`tsc` is a FILE-level checklist here, not a call-site one.** CLAUDE.md records that
  deleting `adminAuthorized` raised 16 errors, not ~45 — one per file, on the failed import.
  Excess-property checks *will* flag the object literals in this case, but do not rely on it: pair
  the build with `grep -rn "adminToken" apps/*/src packages/*/src scripts` and require **0 hits**
  outside the desktop's own Rust/TSX naming.
- **VALIDATE**: `npm run typecheck && ! grep -rn "adminToken" apps/ingest/src packages/*/src`

### 25. MIGRATE the 24 test files off `adminToken`

- **IMPLEMENT**: **33 occurrences across 24 files** (measured). Add ONE shared helper — suggested
  `apps/ingest/src/test-support/bootstrap-key.ts` exporting
  `seedBootstrapKey(db, email): Promise<string>` that calls `ensureUserByEmail` + `createApiKey` and
  returns the plaintext — and replace `adminToken: ADMIN` in `buildApp({...})` with a `beforeAll`
  that mints the key and assigns the existing `ADMIN` / `SERVICE_TOKEN` constant.
- **GOTCHA**: These constants are already used as bearers throughout each file, so the change is
  two lines per file if the helper returns the same shape. Do **not** hand-roll the seeding per file.
- **GOTCHA**: `apps/collector/src/capture-engine.int.test.ts:60` and
  `apps/collector/src/push.int.test.ts:27` also call `buildApp` — they are outside `apps/ingest` and
  are easy to miss.
- **VALIDATE**: `npx vitest run` (full suite)

### 26. UPDATE `.env.example` and `docs/guide/operations.md`

- **IMPLEMENT**: Mark `ADMIN_TOKEN` as **removed in M15 15.9** with a one-line migration note (mint an
  API key, put it in the desktop keychain / `API_KEY`). Update the `ADMIN_PASSWORD` comment at
  `.env.example:57` which says "the API still works via ADMIN_TOKEN for machine clients" — that
  becomes false. Add an operations section covering **API-key issuance and revocation** and the
  **corrected break-glass procedure: direct DB access via the `db:*` scripts, never an HTTP token**
  (this is the `docs/guide/operations.md` amendment the milestone plan assigns to 15.9).
- **VALIDATE**: `npx prettier --check "**/*.md"`

### 27. UPDATE `SUMMARY.md` in the same commit as the execution report

- **IMPLEMENT**: Flip **15.9** to ✅ with `DONE <date> (PR #NN)` in **both** the §0 status block and
  the §6 roadmap; adjust the M15 status line if 15.10 is the only slice left.
- **GOTCHA**: `scripts/check-summary.mjs` FAILS the gate when an execution report exists without the
  ✅ — this is the backstop, not the reminder.
- **VALIDATE**: `npm run repo-health:fast`

---

## TESTING STRATEGY

### Unit Tests

Co-located `*.test.ts`, no infra. Cover the pure parts: the prefix predicate, the effective-role
`min` (a table-driven test over all 4×4 role pairs plus `null` and a corrupt string), and the
throttle decision function. Extract the role computation into a named exported function so it is
testable without a DB — a `min` buried in `resolvePrincipal` can only be tested through HTTP.

### Integration Tests

Two suites, at two layers, deliberately split (the 15.8 precedent — see
`repositories/mfa.int.test.ts:24-33`):

- **`packages/db/src/repositories/api-keys.int.test.ts` (two-role)** — the storage and revocation
  mechanisms, with the role-identity assertion first. This is where the app role's ability to read
  the table **with no org context** is proven.
- **`apps/ingest/src/api-keys.int.test.ts`** — the primary defence: route gates, the ceiling, the
  floor, re-auth, and the end-to-end flows.

### Edge Cases

- `expires_at IS NULL` (never expires) must remain **live** — a bare `gt` inverts this silently.
- A key whose stored `role` is not in `ROLES` → 401, not a clamp.
- A key whose owner has been demoted since minting → acts at the **lower** rung.
- A key whose owner has been **removed from the org** → 401 (no membership ⇒ no principal), *and*
  the key row is revoked (D-15.9-9).
- Revoking a key while an SSE stream is open → the stream terminates within one tick (Task 8).
- A token that is 48 chars and starts with `k420_` but is unknown → 401, indistinguishable from
  revoked/expired.
- A session token presented after retirement → still works (the two tiers must not interfere).
- The literal old `ADMIN_TOKEN` value presented after Phase C → **401**.

---

## VALIDATION COMMANDS

Every command runs from the **repo root**. Level 1-3 are GATES.

### Level 1: Syntax & Style

```bash
npm run typecheck            # root `tsc -b` — MUST exit 0. Per-workspace build is NOT a substitute.
npm run typecheck:dashboard  # the dashboard is outside the root graph
npm run typecheck:desktop
npm run lint                 # ESLint — NOT part of repo-health; CI runs it
npx prettier --check "**/*.{ts,tsx,js,mjs,json,md}"   # CI runs format:check on markdown too
cd apps/desktop/src-tauri && cargo test && cargo clippy -- -D warnings   # cargo 1.95.0 verified present
```

**Pass signal**: exit 0 from each.

### Level 2: Unit Tests

```bash
npx vitest run               # units always run; integration self-skips without DATABASE_URL_TEST
```

**Pass signal**: 0 failures. Note the suite was 743 tests at end of M13 and has grown since — expect
this slice to add ~35-50.

### Level 3: Integration Tests — THE LAYER THAT MUST ACTUALLY RUN

```bash
npm run db:up
npm run db:migrate                                             # the DEV database
DATABASE_URL="$(grep '^DATABASE_URL_TEST=' .env | cut -d= -f2-)" npm run db:migrate   # the TEST database, separately
npm run repo-health -- --require-db
```

**Pass signal**: green **with 0 skipped**. `skipped ≠ passed` — a plain `repo-health` PASS does not
prove the DB-backed layer ran, and `--require-db` fails if `DATABASE_URL_TEST` is unconfigured or any
`*.int.test.ts` self-skipped. `--require-db` also asserts the two-role setup before it runs vitest, so
`DATABASE_URL_TEST_APP` must be set.

> **The test database is migrated separately from the dev database** — `npm run db:migrate` alone
> leaves `420ai_test` behind and the int layer fails in confusing ways. Both were confirmed at 21
> migrations / 28 tables during planning.

### Level 4: Manual Validation

```bash
# 1. mint a key (as the bootstrap admin, over a real session)
curl.exe -s -X POST http://localhost:8420/v1/auth/api-keys \
  -H "Authorization: Bearer $SESSION" -H "content-type: application/json" \
  --data-binary "@body.json"       # {"name":"desktop","role":"member","currentPassword":"..."}
# → 200 {"apiKey":{...},"token":"k420_..."}   ← the ONLY time the token appears

# 2. use it
curl.exe -s http://localhost:8420/v1/monitor -H "Authorization: Bearer k420_..."   # → 200

# 3. revoke it, then reuse it
curl.exe -s -X DELETE http://localhost:8420/v1/auth/api-keys/<id> -H "Authorization: Bearer $SESSION"
curl.exe -s -o /dev/null -w "%{http_code}" http://localhost:8420/v1/monitor -H "Authorization: Bearer k420_..."   # → 401

# 4. the retired token
curl.exe -s -o /dev/null -w "%{http_code}" http://localhost:8420/v1/monitor -H "Authorization: Bearer $OLD_ADMIN_TOKEN"   # → 401
```

> **PowerShell**: use `curl.exe` (not the `curl` alias) and file-based JSON bodies — inline `\"`
> escaping is a known trap in this environment.

Then, against the desktop app: pair, save an API key in Settings, confirm the Sync & Health panel
renders a live snapshot, revoke the key, and confirm the panel degrades rather than hanging.

### Level 5: Additional Validation

The M15 sign-off checklist items this slice owns (evidence → `.agents/qa/m15-signoff/`):

- [ ] Desktop app runs with an API key, `ADMIN_TOKEN` removed from the keychain; pairing + Monitor
      round-trip green
- [ ] `reports:generate` runs authenticated by an API key

---

## ACCEPTANCE CRITERIA

- [ ] A named API key can be minted, listed, used as a bearer, and revoked by its owner
- [ ] The plaintext token is returned **exactly once** and appears in no other response and in no
      table column (asserted)
- [ ] A key may not be minted above the minter's rung (403), and acts at the **lower** of its own
      rung and its owner's current rung (asserted by demoting the owner after minting)
- [ ] Minting requires re-authentication; listing and revoking do not
- [ ] A revoked key 401s, including terminating an open SSE stream within one tick
- [ ] Removing a member revokes their API keys in the same transaction; a password change does not
- [ ] `api_keys` carries **no** RLS policy and appears in `NO_RLS_TABLES`; the "17 tenant tables"
      assertion is unchanged
- [ ] The desktop app and `scripts/generate-reports.mjs` authenticate with an API key
- [ ] `ADMIN_TOKEN` authenticates nothing: the branch, the `buildApp` option and the `server.ts`
      throw are gone, and `grep -rn "adminToken" apps/ingest/src packages/*/src` returns 0 hits
- [ ] `.env.example` and `docs/guide/operations.md` document the retirement, API-key issuance/
      revocation, and the **DB-access** break-glass procedure
- [ ] `npm run repo-health -- --require-db` green with **0 skipped**; `cargo test` green
- [ ] `SUMMARY.md` flips 15.9 to ✅ in the same commit as the execution report

---

## COMPLETION CHECKLIST

- [ ] All tasks completed in order
- [ ] Each task's validation passed immediately
- [ ] All validation commands executed successfully (Levels 1-3 mandatory)
- [ ] Full test suite passes (unit + integration, 0 skipped)
- [ ] No linting, formatting or type errors — including `lint` and `prettier`, which `repo-health`
      does not run
- [ ] Manual testing confirms the four Level-4 curl outcomes
- [ ] Acceptance criteria all met
- [ ] Migration + `db:rollback` → `db:migrate` cycle proven
- [ ] Code reviewed via `/lril:code-review` before commit

---

## NOTES

### Spikes RUN during planning (not specified for the executor) — and their output

All five ran live against `420ai_test` on 2026-08-01. The throwaway script was deleted afterwards.

**SPIKE 0 — the harness is real.** `420ai_test` has **21 migrations applied, 28 tables**. The app
handle connects as `current_user = 420ai_app`, `is_superuser = off`, `rolbypassrls = false`. The
two-role suite this slice adds therefore has a genuine non-owner to assert on — `bypassed ≠ enforced`
is satisfied before a line is written.

**SPIKE 1 — does `ALTER DEFAULT PRIVILEGES` cover a new `api_keys`-shaped table?** Created the exact
proposed table as the migration owner, then inspected:

```
app privileges: [ 'DELETE', 'INSERT', 'SELECT', 'UPDATE' ]
rls flags:      [ { relrowsecurity: false, relforcerowsecurity: false } ]
policies:       0
```

**⇒ No `GRANT` block is needed in migration 0021**, and its absence is not a bug. 0020's header makes
this claim for the MFA tables; this re-verifies it for this table shape.

**SPIKE 2 — can the app role INSERT and hash-lookup with NO org context set?** Yes:

```
hash lookup as app role, no org context: [ { user_id: '048e977a-…', role: 'member' } ]
```

**⇒ D-15.9-1 is sound.** The pre-context read `resolvePrincipal` needs works under the role the
server actually connects as, without a policy.

**SPIKE 3 — the token alphabet (this one changed the design).** 200 samples of
`randomBytes(32).toString("base64url")`:

```
chars seen:       -0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz
any contain '_':  true
```

**⇒ base64url includes `_` and `-`.** A prefix scheme parsed by splitting on `_` would mis-handle a
large fraction of valid keys. D-15.9-3 mandates `startsWith` and hashing the **whole** token
(prefix included, so there is nothing to strip). Total length 48 = 5 + 43.

**SPIKE 4 — `startsWith` routing** works on the composed token; length confirmed 48.

**SPIKE 5 — the throttled `last_used_at` UPDATE** returns a row count (`updated rows: 1`) under the
app role, so the fire-and-forget touch has an observable result if it is ever asserted.

**Tooling presence**: `cargo 1.95.0` verified on PATH; `apps/desktop/src-tauri` is `desktop` v0.1.1.
No new npm or cargo dependency is introduced by this plan — `node:crypto` via the existing
`packages/db/src/tokens.ts` helpers covers everything.

### Symbols verified by reading (not from memory)

`resolvePrincipal` / `authorized` / `isUuid` (`apps/ingest/src/auth.ts`) · `findPrincipalByEmail` +
`Principal` (`repositories/principal.ts:50`) · `generateToken` / `hashToken`
(`packages/db/src/tokens.ts:10,14`, re-exported at `index.ts:42`) · `findMachineIdByToken`
(`repositories/tokens.ts:32`) · `findLiveSession` / `revokeSession` / `revokeAllSessions` /
`findLiveSessionCreatedAt` / `listSessions` (`repositories/sessions.ts`) · `hasRole` / `isRole` /
`ROLES` / `SERVICE_ROLE` (`packages/shared/src/roles.ts:11,25,38,44`) · `withOrg`
(`packages/db/src/org-context.ts:50`, throws on an empty role) · `verifyPassword`
(`apps/ingest/src/password.ts:21`) · `findCredentialById` (`repositories/users.ts:116`) ·
`MFA_REAUTH_MAX_SESSION_AGE_MS` (`routes/mfa.ts:62`) · `setErrorHandler` + `MemberError` mapping
(`app.ts:236,249`).

### Design decisions and trade-offs

**Why an identity table rather than an org-scoped one.** An API key could plausibly carry `org_id`
like `ingest_tokens` does. It should not: `ingest_tokens` derives its org from a *machine*, which is
already an org-owned row, whereas a key derives everything from its *user*. Giving it an `org_id`
would create a second, independently-mutable answer to "which org is this?" that could disagree with
the membership — and the membership is the one `findPrincipalByEmail` reads. One source of truth.

**Why the role is a `min` rather than a mint-time cap.** A mint-time-only cap freezes privilege at
issuance: demote someone and their key keeps the old rung until somebody remembers to rotate it. The
`min` makes a demotion take effect on the next request, which is exactly the property D-15.6-7
already gives sessions. It costs one comparison.

**What is deliberately NOT here.** Per-key *scopes* (endpoint or resource granularity) — D-M15-4
fixes the role set at four rungs and rules out user-defined roles; a scope system is an M16 concern.
The **API-key management UI** is 15.10 (this slice ships the API; the dashboard surface lands with
the team surfaces). The **audit record** for mint/revoke is 15.10, which is where the audit table
lands — the routes here should be written so an audit call is a one-line addition.

### Risks

1. **Task 25 is the size driver, not the feature.** 33 occurrences across 24 files, including two in
   `apps/collector`. It is mechanical, but a missed file is a compile error at best and a test
   authenticating as nobody at worst. Do it with the shared helper, in one commit, separately from
   Phase A.
2. **The SSE re-check (Task 8) is the correctness risk.** It is the one place where inheriting an
   existing comment's reasoning silently re-opens a closed hole. The comment at `monitor.ts:337-341`
   justifies the skip *entirely* by `ADMIN_TOKEN` being un-revocable; an API key is not.
3. **The Rust `#[serde(default)]` trap (Task 19)** has already bitten this codebase once. Omitting it
   makes every existing desktop install present as unpaired after upgrade — a silent, total failure
   that looks like data loss to the user.
4. **Phase ordering is load-bearing.** Landing Phase C before Phase B leaves the desktop app with no
   working credential.

### Confidence

**9.4 / 10** for one-pass execution. Earned by: five spikes run live with their output folded in
(one of which — the base64url alphabet — changed the design); every imported symbol verified by
reading its source with a file:line citation; the two-role harness confirmed live rather than assumed;
and both structural gates (`org-scoping.test.ts`, `rls.int.test.ts`) read in full so their exact
required edits are named as tasks rather than left to discovery.

The residual 0.6 is concentrated in two places, both named above rather than hidden: the Rust changes
are specified but **not compiled during planning** (`cargo build` for a Tauri crate is slow enough
that I read the code instead), and Task 25's 24-file migration is broad enough that a stray call site
in a workspace I did not grep is possible — which is why Task 24 pairs `tsc` with an explicit `grep`
assertion rather than trusting the build.
