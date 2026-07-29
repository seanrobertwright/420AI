# Feature: M15 Slice 15.6 — Sessions + revocation

The following plan should be complete, but it is important that you validate documentation, codebase
patterns and task sanity before you start implementing. Pay special attention to the naming of
existing utils, types and models — import from the right files.

Conventions are **not** restated here. The source of truth is [`CLAUDE.md`](../../CLAUDE.md); the
milestone context is [`.agents/plans/m15-multi-user-access-control.md`](./m15-multi-user-access-control.md)
and the shipped-state narrative is [`SUMMARY.md`](../../SUMMARY.md) §6.

## Feature Description

Today a 420AI session is a **stateless HMAC** (`apps/ingest/src/session.ts`): `base64url({sub,iat,exp}).base64url(mac)`,
signed with `SESSION_SECRET`, valid for 7 days, and verifiable by anyone holding the secret. There is
**no server-side record of it**, which means there is **no way to revoke it**. The only "revocation"
available is rotating `SESSION_SECRET`, which signs out every user on the deployment at once.

That was the correct design for M12 12.3, when the product had exactly one admin. It is not correct
now that 15.5 ships invites, self-signup and password reset, and it actively blocks 15.7 (SSO) and
15.8 (MFA), both of which require "sign out all devices" and invalidate-on-credential-change.

This slice makes sessions **stateful** (D-M15-12): a `sessions` table, a `sid` claim inside the
existing token, a revocation check inside `resolvePrincipal`, revoke-one / revoke-all endpoints, and
invalidate-on-credential-change wired into the two places 15.5 explicitly left `TODO`
(`routes/auth.ts:316` and `routes/auth.ts:345`).

## User Story

As an **operator or member of a 420AI organization**
I want to **see my active sessions and sign any or all of them out — and have my sessions die
automatically when my password changes or my membership is removed**
So that **a stolen laptop, a leaked cookie, or a removed colleague stops being a live credential
immediately, instead of staying valid for up to seven days**

## Problem Statement

1. **A leaked session token is irrevocable for 7 days.** Nothing short of rotating `SESSION_SECRET`
   (which logs out the entire deployment) invalidates it.
2. **A password reset does not end the attacker's session.** The canonical account-recovery flow —
   "someone took over my account, let me reset my password" — currently leaves the attacker's
   existing session fully valid. 15.5 shipped this knowingly (`routes/auth.ts:316-319`) with the
   reasoning that half-revocation is worse than none.
3. **Removing a member does not sign them out.** `DELETE /v1/members/:userId` deletes the
   membership, so `findPrincipalByEmail` stops resolving — which *does* fail closed. But it fails
   closed only because the user has no other membership; the mechanism is accidental, not designed,
   and it breaks the moment 15.10 ships multi-org users.
4. **15.7 and 15.8 are blocked.** Both require session invalidation as a primitive.

## Solution Statement

Add a `sessions` table and a `sid` (session id) claim to the existing token payload. Keep the HMAC
envelope **byte-identical in shape** so the dashboard's Edge verifier and the `next build` gate are
untouched. `resolvePrincipal` gains one indexed lookup: a token whose `sid` is missing, unknown,
revoked or expired resolves to `null` → 401.

Revocation then has three triggers — explicit (logout / revoke-one / revoke-all), credential change
(password reset confirm, password change), and membership removal — and one enforcement point
(`resolvePrincipal`), which is the single chokepoint every authenticated route already funnels
through.

The proof is a **two-role behavioural suite** whose discriminating assertion is that a revoked token
is rejected **while still being a cryptographically valid HMAC** — see
[THE TWO-ROLE BEHAVIOURAL ASSERTION](#the-two-role-behavioural-assertion), which is the part of this
plan most likely to be got wrong.

## Feature Metadata

**Feature Type**: New Capability (security primitive)
**Estimated Complexity**: Medium
**Primary Systems Affected**: `packages/db` (schema + migration `0018` + one new repository),
`apps/ingest` (`session.ts`, `auth.ts`, `routes/auth.ts`, `routes/members.ts`, `schemas.ts`),
`apps/dashboard` (logout route handler only)
**Dependencies**: none new — no package added, no package upgraded

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

| File | Why |
| --- | --- |
| `apps/ingest/src/session.ts` (all 54 lines) | The HMAC signer/verifier you are extending. Note `verifySession` returns `null` for every failure and never throws. |
| `apps/ingest/src/auth.ts` (lines 37-64) | `resolvePrincipal` — **the single enforcement point**. The service-token branch (ADMIN_TOKEN) must stay session-free; only branch (2) gains the lookup. |
| `apps/ingest/src/routes/auth.ts` (lines 84-106, 291-350) | Where sessions are minted (`login`, `invites/accept`, `signup`) and the two `15.6 (D-M15-12)` TODO comments you are closing. |
| `apps/ingest/src/routes/members.ts` (lines 287-310) | `DELETE /v1/members/:userId` — the third revocation trigger. Note the `outranks` guard already in place; you are adding **inside** the existing `withOrg` outcome, not around it. |
| `packages/db/src/repositories/password-resets.ts` (all 112 lines) | **The template for the new repository.** Same mint/redeem shape, same silent-library discipline, same typed error. Copy its structure, not its hashing (see D-15.6-2). |
| `packages/db/src/schema.ts` (lines 96-104, 200-218) | `users` and `password_reset_tokens` — the exact shape `sessions` mirrors. |
| `packages/db/drizzle/0017_aromatic_maximus.sql` | The hand-edited-migration convention, including the header explaining why no `GRANT` is needed. |
| `packages/db/drizzle/down/0017_aromatic_maximus.down.sql` | The down-migration ordering discipline and the D-M15-13 rollback-drill note. |
| `packages/db/src/repositories/rls.int.test.ts` (lines 118-145, 444-470) | `NO_RLS_TABLES` and the `pg_policies` inventory test keyed on `(tablename, policyname)`. You add one entry to the former; the latter must stay unchanged in count. |
| `apps/ingest/src/identity.int.test.ts` (lines 1-175) | **The test harness you extend.** `buildApp({db: appRole.db, ...})`, the `login()` / `asUser()` / `json()` helpers, the injected `fakeMailer`. |
| `apps/dashboard/src/lib/session.ts` + `src/middleware.ts` | The Edge verifier. **Read both before touching the payload** — D-15.6-4 turns on what these can and cannot do. |
| `apps/dashboard/src/app/api/auth/logout/route.ts` | The one dashboard file this slice edits. |
| `packages/db/src/tokens.ts` | `generateToken` / `hashToken`. You will **not** use them here — D-15.6-2 explains why, and that explanation belongs in the code. |

### New Files to Create

- `packages/db/src/repositories/sessions.ts` — mint / look-up-live / revoke-one / revoke-all / list
- `packages/db/src/repositories/sessions.int.test.ts` — repository-level two-role suite
- `packages/db/drizzle/0018_<generated>.sql` — `sessions` table (hand-edited to append the no-RLS comment)
- `packages/db/drizzle/down/0018_<generated>.down.sql` — the reverse
- `apps/ingest/src/sessions.int.test.ts` — **the HTTP-level two-role behavioural suite** (the centrepiece)

### Relevant Documentation

- [OWASP Session Management Cheat Sheet — §"Session Expiration" and §"Session Termination"](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#session-expiration)
  - Why: the rule that a session identifier must be invalidated server-side on logout, not merely
    dropped by the client — which is exactly what the dashboard does today.
- [OWASP Forgot Password Cheat Sheet — §"Transmitting the Reset"](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
  - Why: it requires all existing sessions be terminated when a password is reset. This is the
    normative source for Task 9.
- [PostgreSQL — `TRUNCATE … CASCADE`](https://www.postgresql.org/docs/current/sql-truncate.html)
  - Why: the basis for the "no fixture edits needed" finding (SPIKE 6 below). CASCADE truncates
    tables that reference the named ones.
- [MDN — HTTP cookies, size limits](https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies#limitations)
  - Why: the 4096-byte budget the enlarged payload must stay under (SPIKE 4 measured 172 bytes).

### Patterns to Follow

**Silent library.** `packages/db/src/repositories/sessions.ts` must never log and never `process.exit`.
It returns `undefined` for "not found" (mirroring `findPrincipalByEmail`) and throws a typed error
only where a caller must distinguish reasons. **This slice needs no new typed error** — a revoked
session is not an exceptional condition, it is a `null` principal and a 401, exactly as an expired
one already is.

**Explicit column lists** (CLAUDE.md 15.1). `listSessions` rows reach `reply.send()`, so it uses a
`sessionRowColumns` constant mirroring the exported `SessionRow` interface — copy the shape from
`packages/db/src/repositories/projects.ts`. Never a bare `select()`.

**`orgId` is always the SECOND parameter** — and this repository deliberately **has no `orgId`
parameter at all**, because a session belongs to a *user*, not an org (D-15.6-3). Where scoping is
needed it is `userId`, and it is always passed as the second parameter for the same reason.

**Timestamps.** Every column is a `timestamp(..., {withTimezone: true})` read through drizzle's typed
select, **not** through a raw `sql` template — so the `mode:"string"` aggregate gotcha in CLAUDE.md
does not apply here. `SessionRow` exposes ISO strings, produced by `.toISOString()` at the route
layer (see Task 7's snippet), never by string-concatenating a `Date`.

---

## THE TWO-ROLE BEHAVIOURAL ASSERTION

This section exists because it is the part most likely to be implemented as theatre. Read it before
writing any test.

### Why the usual shape does not transfer

15.3 and 15.5 proved their claims by **dropping a policy and watching tests fail**. That works when
the mechanism under test *is* an RLS policy. **It does not transfer here**, because `sessions` is an
identity table with **no policy at all** (D-15.6-3). There is nothing to drop.

So the failure mode this suite must exclude is different, and it is the nastiest one in the
milestone: **a revoked session that still works reports nothing anywhere.** No error, no log, a 200
response, and every existing test stays green — because every existing test uses a *freshly minted*
token, which is live by construction. This is the same silhouette as 15.3's dead alert delivery
(`bypassed ≠ enforced`) and 15.4's silent `DELETE 0`.

### The four assertions, and what each one excludes

A suite that omits any one of these is not proof.

**1 — Role identity (first test in the file, exactly as in `rls.int.test.ts:200`).**
Assert `current_setting('is_superuser') = 'off'` **and** `rolbypassrls = false` for the handle the
app is built on. Without it, pointing `DATABASE_URL_TEST_APP` at the owner URL by mistake leaves
every test below passing while proving nothing. *This slice does not depend on RLS* — but the app
still runs as `420ai_app`, and a missing `GRANT` on the new table would be a real, shippable bug that
only a non-owner handle can see. SPIKE 2 says the grant arrives implicitly; this test is what keeps
that true.

**2 — The POSITIVE behavioural assertion (the `delivered.length > 0` lesson).**
Before revoking anything, assert a freshly-minted session **actually authenticates**: `GET
/v1/auth/me` returns **200**. This is the assertion CLAUDE.md's 15.3 corollary was written for. A
revocation check that rejects *everything* — a typo'd column, a missing `GRANT`, a `sid` that was
never persisted — is indistinguishable from correct revocation if you only ever assert 401s. Every
negative test below is meaningless without this one above it.

**3 — The DISCRIMINATOR: rejected while still cryptographically valid.**
This is the assertion that makes the suite non-theatre, and it has no precedent in the repo:

```ts
it("a REVOKED session is rejected even though its HMAC is still valid", async () => {
  const token = await login("member@example.com");

  // (2) POSITIVE FIRST — prove the credential works before we take it away.
  const before = await app.inject({ method: "GET", url: "/v1/auth/me", headers: asUser(token) });
  expect(before.statusCode, "a fresh session must authenticate").toBe(200);

  await app.inject({ method: "POST", url: "/v1/auth/sessions/revoke-all", headers: asUser(token) });

  // (3) THE DISCRIMINATOR. `verifySession` is the pure crypto check with no database in it, so a
  // non-null result here proves the MAC still verifies and `exp` is still in the future. The 401
  // below therefore CANNOT be explained by expiry, a tampered token, a wrong secret, or a
  // malformed payload — the only remaining explanation is server-side revocation.
  //
  // Without this line the test passes just as well when the token was never valid at all, which
  // is precisely how a revocation test becomes theatre.
  expect(verifySession(token, SESSION_SECRET), "token must still be crypto-valid").not.toBeNull();

  const after = await app.inject({ method: "GET", url: "/v1/auth/me", headers: asUser(token) });
  expect(after.statusCode, "a revoked session must be rejected").toBe(401);
});
```

**4 — The ISOLATION assertion (behavioural, on the app role).**
Revoking user A's sessions must not touch user B's — asserted by B's token still returning **200**
after A's revoke-all. A `revokeAllSessions` that forgot its `WHERE user_id = $1` would pass every
other test in this file. This is the `min(org_id)` lesson one table over: an ownership predicate
omitted from a mutation is invisible until someone tests the other tenant.

### The mutation check (run it, record the result in the execution report)

Assertion 3 claims to discriminate. **Verify that claim the same way 15.3 verified its negative
tests** — by breaking the thing and watching the right test fail:

1. Comment out the revocation lookup in `resolvePrincipal` (the two lines added in Task 6).
2. Run `npx vitest run apps/ingest/src/sessions.int.test.ts`.
3. **Expected:** the revoke-one, revoke-all, logout, password-change and reset-confirm tests FAIL;
   tests 1 (role identity), 2 (positive) and 4 (isolation) still PASS.
4. Restore the lines.

If the positive test fails too, the suite is over-coupled and cannot tell "revocation works" from
"auth works" — fix the suite before shipping. **Record the observed pass/fail split in the
execution report**; "I ran it and it failed" is not the finding, *which* tests failed is.

---

## IMPLEMENTATION PLAN

### Phase 1 — Foundation (schema + migration + repository)

Tasks 1-4. Additive only: a new table, a new repository, no existing signature changed. At the end of
this phase `tsc -b` and the whole suite pass with zero behaviour change, because nothing calls the
new code yet.

### Phase 2 — Core (token claim + enforcement)

Tasks 5-6. The `sid` claim and the `resolvePrincipal` lookup. **This is the phase that can break every
authenticated route in the product**, so it is deliberately two small tasks with a full gate between
them and Phase 3.

### Phase 3 — Integration (routes + credential-change + dashboard)

Tasks 7-10. The four new endpoints, the two TODOs 15.5 left, member removal, and the dashboard logout
hop.

### Phase 4 — Testing & docs

Tasks 11-14. The two suites, the mutation check, and the SUMMARY/execution-report update **in the
same commit** (CLAUDE.md's rebuildable-projection rule).

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Each task carries its own validation command.

### 1. ADD `sessions` to `packages/db/src/schema.ts`

- **IMPLEMENT**: a new `pgTable` immediately after `passwordResetTokens` (line 218), so the identity
  tables stay contiguous:

  ```ts
  /**
   * M15 15.6 — a STATEFUL user session (D-M15-12), superseding 12.3's "no sessions table".
   *
   * An IDENTITY table: no `org_id`, and therefore NO RLS at all, for the same reason
   * `users`/`memberships`/`password_reset_tokens` carry none (D-15.3-4 / D-15.5-1 / D-15.6-3).
   * It is read inside `resolvePrincipal` — the one moment before any org context exists, because
   * resolving this row is part of what establishes it.
   *
   * NOTE what is absent: there is NO `token_hash` column, unlike `invites` and
   * `password_reset_tokens` (D-15.6-2). Those tables hold a bearer secret that IS the whole
   * credential, so only its hash may be stored. A session's credential is the HMAC over the
   * payload, which `SESSION_SECRET` alone can produce; `id` is a LOOKUP KEY, not a secret, and
   * hashing it would buy nothing while implying a protection that is not there.
   *
   * There is also no `last_used_at`, deliberately: touching it would put a WRITE on every
   * authenticated read, and the SSE monitor stream is one request per client per tick — the exact
   * shape of the audit-B.4 problem 15.4 had to throttle back out.
   */
  export const sessions = pgTable(
    "sessions",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      userId: uuid("user_id")
        .notNull()
        .references(() => users.id),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
      revokedAt: timestamp("revoked_at", { withTimezone: true }),
      // Free-text, truncated by the route (D-15.6-9) — it exists so a user can recognise a session
      // in the list, never for a security decision. Nullable: non-browser clients send none.
      userAgent: text("user_agent"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [index("sessions_by_user").on(t.userId)],
  );
  ```

- **PATTERN**: `packages/db/src/schema.ts:205-218` (`passwordResetTokens`) — same column vocabulary,
  same FK style, same index naming (`<table>_by_<column>`).
- **IMPORTS**: none new — `pgTable`, `uuid`, `text`, `timestamp`, `index` are already imported.
- **GOTCHA**: use a **plain** `index(...)`, not a partial one. `revoked_at IS NULL` in a drizzle index
  predicate would need a raw `sql` fragment, and the table is small and always probed by primary key
  on the hot path. The `sessions_by_user` index serves the list/revoke-all paths only.
- **VALIDATE**: `npm run typecheck`

### 2. GENERATE + HAND-EDIT migration `0018`

- **IMPLEMENT**: run `npm run db:generate`, then hand-append a header comment to the generated
  `packages/db/drizzle/0018_<generated>.sql` in 0017's style:

  ```sql
  -- M15 15.6 sessions + revocation (D-M15-12; D-15.6-1…3). The generated DDL below is used AS IS:
  -- unlike 0015/0016/0017 this migration appends NO policy block, and that absence is the decision
  -- rather than an omission. `sessions` is an IDENTITY table (D-15.6-3) — keyed by `user_id` with no
  -- `org_id` — read inside `resolvePrincipal` at the one moment before any org context exists.
  -- It joins `users`, `organizations`, `memberships` and `password_reset_tokens` in
  -- rls.int.test.ts's NO_RLS_TABLES, which asserts it carries NO policy at all.
  --
  -- No `GRANT` statement is needed and its absence is not a bug: 0015's
  -- `ALTER DEFAULT PRIVILEGES … TO "420ai_app"` covers tables created by the migration owner.
  -- RE-VERIFIED live against the test DB during planning for THIS table shape — the app role was
  -- granted DELETE, INSERT, SELECT, UPDATE implicitly and both inserted and selected with no
  -- explicit grant.
  ```

- **PATTERN**: `packages/db/drizzle/0017_aromatic_maximus.sql:1-17`.
- **GOTCHA**: the tag is generated (`0018_<random_marvel_name>`); use whatever `db:generate` emits in
  the down-file name and in `_journal.json`. Do **not** hand-write the journal entry — `db:generate`
  maintains it, and idx must be `17` (0-based) for the 18th migration.
- **VALIDATE**: `npm run db:migrate` then
  `docker exec 420ai-archive psql -U postgres -d 420ai -c "\d sessions"` shows the table.

### 3. CREATE `packages/db/drizzle/down/0018_<generated>.down.sql`

- **IMPLEMENT**:

  ```sql
  -- Down-migration for 0018 (M15 15.6). A bare DROP TABLE: `sessions` carries no policy and no RLS
  -- switch, so there is no policy-ordering hazard of the kind 0015-0017's downs had to navigate.
  --
  -- D-M15-13 rollback-drill note: this DOES discard data — every live session. The cost of the
  -- drill is that every logged-in user must log in again; the pre-0018 code accepts any unexpired
  -- HMAC, so it is byte-compatible with tokens minted before AND after 0018 (the extra `sid` claim
  -- is simply ignored by the older verifier). No `users` or `memberships` row is touched.
  DROP TABLE IF EXISTS "sessions";
  ```

- **PATTERN**: `packages/db/drizzle/down/0017_aromatic_maximus.down.sql` — note it explains what the
  rollback discards, which the D-M15-13 drill depends on.
- **VALIDATE**: `npx vitest run packages/db/src/rollback.int.test.ts`

### 4. CREATE `packages/db/src/repositories/sessions.ts`

- **IMPLEMENT**: five functions, silent-library discipline, explicit column list.

  ```ts
  import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
  import type { DbClient } from "../client.js";
  import { sessions } from "../schema.js";

  /** Explicit column list — these rows reach `reply.send()` (CLAUDE.md 15.1). */
  const sessionRowColumns = {
    id: sessions.id,
    createdAt: sessions.createdAt,
    expiresAt: sessions.expiresAt,
    userAgent: sessions.userAgent,
  };

  export interface SessionRow {
    id: string;
    createdAt: Date;
    expiresAt: Date;
    userAgent: string | null;
  }

  /** Mint a session row; the caller signs a token carrying the returned id as its `sid`. */
  export async function createSession(
    db: DbClient,
    userId: string,
    expiresAt: Date,
    userAgent?: string | null,
  ): Promise<{ id: string }> {
    const [row] = await db
      .insert(sessions)
      .values({ userId, expiresAt, userAgent: userAgent ?? null })
      .returning({ id: sessions.id });
    return row!;
  }

  /**
   * Resolve a session id to its owner, or `undefined` when it is unknown, revoked or expired.
   * THE hot path — one primary-key probe on every authenticated request.
   *
   * The three rejection reasons collapse into one `undefined` ON PURPOSE: the caller
   * (`resolvePrincipal`) answers 401 for all of them, and distinguishing them at the API would
   * tell an attacker whether a guessed id exists.
   */
  export async function findLiveSession(
    db: DbClient,
    sessionId: string,
  ): Promise<{ userId: string } | undefined> {
    const [row] = await db
      .select({ userId: sessions.userId })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, sessionId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, sql`now()`),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * Revoke ONE session, scoped to its owner. Returns false when the id is unknown, already
   * revoked, or belongs to somebody else.
   *
   * `userId` is the second parameter and is NOT optional — the same discipline `orgId` follows
   * elsewhere. Without it any authenticated caller could revoke any session id they could guess,
   * and the route has no other ownership check.
   */
  export async function revokeSession(
    db: DbClient,
    userId: string,
    sessionId: string,
  ): Promise<boolean> {
    const revoked = await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
        ),
      )
      .returning({ id: sessions.id });
    return revoked.length > 0;
  }

  /**
   * Revoke every live session for a user, optionally sparing one (the caller's own).
   *
   * IDEMPOTENT by construction: the `revoked_at IS NULL` predicate means a second call updates
   * zero rows rather than re-stamping, so the returned count is "how many were live", not "how
   * many exist" — verified against the live test DB during planning.
   *
   * No lock and no `FOR UPDATE`, and unlike `createPasswordReset` that is correct here: this is a
   * blind UPDATE with its predicate in the WHERE clause, so there is no read-then-write window for
   * two callers to race through (the CLAUDE.md 15.5 lesson is about guards that SELECT first).
   */
  export async function revokeAllSessions(
    db: DbClient,
    userId: string,
    exceptSessionId?: string,
  ): Promise<number> {
    const revoked = await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          ...(exceptSessionId ? [sql`${sessions.id} <> ${exceptSessionId}::uuid`] : []),
        ),
      )
      .returning({ id: sessions.id });
    return revoked.length;
  }

  /** List a user's LIVE sessions, newest first. Explicit columns; rows reach the wire. */
  export async function listSessions(db: DbClient, userId: string): Promise<SessionRow[]> {
    return db
      .select(sessionRowColumns)
      .from(sessions)
      .where(
        and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, sql`now()`)),
      )
      .orderBy(desc(sessions.createdAt));
  }
  ```

- **PATTERN**: `packages/db/src/repositories/password-resets.ts` (structure, doc-comment density,
  typed `DbClient` parameter so a caller can pass a `Tx`).
- **GOTCHA**: `gt(sessions.expiresAt, sql\`now()\`)` compares in the **database**, not against a JS
  `Date`. That matters: it keeps expiry consistent with the `exp` claim regardless of clock skew
  between the app process and Postgres, and it avoids the `mode:"string"` coercion trap entirely
  because the value never leaves SQL.
- **GOTCHA**: the `::uuid` cast in `revokeAllSessions` is required — a bound parameter compared to a
  `uuid` column is inferred as `text` and Postgres rejects the operator.
- **VALIDATE**: `npm run typecheck`

### 5. EXPORT the repository from `packages/db/src/index.ts`

- **IMPLEMENT**: add `sessions` to the schema re-export block (alongside `invites`, line ~10) and a
  new export block after the `password-resets` one (line ~92):

  ```ts
  export {
    createSession,
    findLiveSession,
    listSessions,
    revokeAllSessions,
    revokeSession,
  } from "./repositories/sessions.js";
  export type { SessionRow } from "./repositories/sessions.js";
  ```

- **PATTERN**: `packages/db/src/index.ts:85-93`.
- **GOTCHA**: the barrel already exports a *function* named `searchDocuments` that shadows a table
  (see the comment at line 190). `sessions` has no such collision — but do add the **table** to the
  schema block, since the int tests need it for `TRUNCATE`-free direct assertions.
- **VALIDATE**: `npm run typecheck`

### 6. UPDATE `apps/ingest/src/session.ts` — the `sid` claim

- **IMPLEMENT**: add `sid` to the payload and to the signer's parameters.

  ```ts
  export interface SessionPayload {
    sub: string;
    iat: number;
    exp: number;
    /**
     * M15 15.6 (D-15.6-1) — the `sessions` row id. REQUIRED for a token to authenticate, but typed
     * optional because a token minted before 0018 simply does not have one: `verifySession` is a
     * pure crypto+expiry check and must keep answering "the MAC is good" for such a token. It is
     * `resolvePrincipal` that turns a missing `sid` into a 401 (D-15.6-5), and keeping that split
     * is what lets the int suite assert "still crypto-valid, yet rejected".
     */
    sid?: string;
  }

  export function signSession(
    sub: string,
    secret: string,
    ttlSec: number,
    sid: string,
  ): { token: string; exp: number } {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + ttlSec;
    const body = Buffer.from(JSON.stringify({ sub, iat, exp, sid })).toString("base64url");
    const mac = createHmac("sha256", secret).update(body).digest("base64url");
    return { token: `${body}.${mac}`, exp };
  }
  ```

- **PATTERN**: the existing function — only the payload literal and the signature change.
- **GOTCHA**: `sid` is a **required** fourth parameter on `signSession`, deliberately, and for the
  reason `withOrg`'s `role` is required (`org-context.ts:38-43`): an optional one would silently mint
  an unrevocable session at any call site that forgot it. An arity change on a successfully-imported
  function reports **one error per call site**, which is what you want — there are exactly three
  (`routes/auth.ts` lines 103, 183, 223).
- **GOTCHA**: **do not touch the dashboard's `verifySessionEdge`.** SPIKE 4 proved the extra claim
  round-trips through its `atob`/`TextDecoder` path unchanged and is ignored by its `{sub, exp}`
  destructure. Editing it would risk the Edge-runtime import constraint for no gain.
- **VALIDATE**: `npm run typecheck` — expect exactly 3 errors, one per `signSession` call site, which
  Task 7 fixes. `npx vitest run apps/dashboard/src/lib/session.test.ts` must stay green.

### 7. UPDATE `apps/ingest/src/auth.ts` — enforce revocation in `resolvePrincipal`

- **IMPLEMENT**: extend branch (2) only.

  ```ts
  import { findLiveSession, findPrincipalByEmail, type Principal } from "@420ai/db";

  // …inside resolvePrincipal, replacing the `else` branch:
  } else {
    // (2) Human session token — HMAC-signed, unexpired, AND NOT REVOKED (M15 15.6, D-M15-12).
    const payload = verifySession(token, app.sessionSecret);
    // A valid MAC is no longer sufficient. A token with no `sid` predates migration 0018 and is
    // REJECTED rather than grandfathered (D-15.6-5): a grace period would be a window in which
    // revocation silently does not apply, which is the one failure this slice exists to remove.
    // The cost is that everyone logs in once after the upgrade — stated in the operations guide.
    if (payload?.sid) {
      const live = await findLiveSession(app.db, payload.sid);
      if (live) {
        email = payload.sub;
        sessionUserId = live.userId;
      }
    }
  }
  ```

  …then, after `findPrincipalByEmail` resolves:

  ```ts
  const principal = await findPrincipalByEmail(app.db, email);
  if (!principal) return null;
  // Defence in depth: the MAC already binds `sub` and `sid` together, so a mismatch is not
  // reachable by an attacker — it is reachable by a BUG (a session row re-pointed at another user,
  // an email reassigned). Fail closed on it rather than trusting one half of a signed pair.
  if (sessionUserId && sessionUserId !== principal.userId) return null;
  ```

- **PATTERN**: `apps/ingest/src/auth.ts:44-63` — keep the service-token branch first and untouched
  (a machine client must not pay for a session lookup).
- **GOTCHA**: declare `let sessionUserId: string | null = null;` beside `let email`. Do **not** hoist
  the lookup above the ADMIN_TOKEN check — `ADMIN_TOKEN` has no session and must keep working
  unchanged until 15.9 retires it.
- **GOTCHA**: `findLiveSession` takes `app.db` **unwrapped**, not `withOrg`. That is correct and is
  the same reasoning `routes/auth.ts:60-63` already records: this read *establishes* identity, so an
  org-scoped read would be circular. `sessions` carries no policy, so there is nothing to satisfy.
- **VALIDATE**: `npm run typecheck`

### 8. UPDATE `apps/ingest/src/routes/auth.ts` — mint sessions at the three call sites

- **IMPLEMENT**: at each of the three places that call `signSession` (login line 103, invite-accept
  line 183, signup line 223), create the row first and pass its id. Login, in full:

  ```ts
  const { id: sid } = await createSession(
    app.db,
    cred.userId,
    new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
    request.headers["user-agent"]?.slice(0, 256) ?? null,
  );
  const { token, exp } = signSession(cred.email, app.sessionSecret, SESSION_TTL_SECONDS, sid);
  ```

- **PATTERN**: the existing lines; only two statements are added at each site.
- **GOTCHA**: `findAdminCredential` must return the **user id**. Read
  `packages/db/src/repositories/users.ts:58-78` first — if it selects only `{email, passwordHash}`,
  add `id` to its explicit column list and to its return interface. The two other sites already hold
  a `userId` (invite-accept from `createUserWithPassword`, signup likewise) — **reuse it, do not
  re-query**, and note that in invite-accept the id must escape the transaction (assign to a
  `let` declared outside, as the existing code does not yet do).
- **GOTCHA**: truncate the user-agent to 256 chars at the route (D-15.6-9). It is attacker-controlled
  free text that is later rendered in a session list; the column is unbounded `text`, so the bound
  belongs here, at the edge.
- **GOTCHA**: the session's `expires_at` and the token's `exp` must be derived from the **same**
  `SESSION_TTL_SECONDS`, not computed independently — otherwise a token outlives its row (or vice
  versa) and the 401 becomes unexplainable.
- **VALIDATE**: `npm run typecheck && npx vitest run apps/ingest/src/session.test.ts`

### 9. ADD the four session routes to `apps/ingest/src/routes/auth.ts`

- **IMPLEMENT**: all four are session-gated at `viewer` (managing your own sessions is not a
  privileged act on the org — the same reasoning `POST /v1/auth/password` records at line 333).

  | Route | Behaviour | Status |
  | --- | --- | --- |
  | `GET /v1/auth/sessions` | list the caller's live sessions; mark the current one | 200 |
  | `DELETE /v1/auth/sessions/:id` | revoke one of the caller's own; `isUuid` guard first | 204 / 404 |
  | `POST /v1/auth/logout` | revoke the caller's current session | 204 |
  | `POST /v1/auth/sessions/revoke-all` | revoke ALL the caller's sessions, current included | 200 `{revoked: n}` |

  The list handler needs the caller's own `sid` to flag `current: true`. `resolvePrincipal` does not
  expose it, so re-derive it locally — do **not** widen `Principal`, which is a `@420ai/db` type with
  no business carrying a transport detail:

  ```ts
  /** The caller's own session id, or null for an ADMIN_TOKEN caller (which has no session). */
  function currentSid(app: FastifyInstance, request: FastifyRequest): string | null {
    const m = /^Bearer (.+)$/.exec(request.headers.authorization ?? "");
    return m ? (verifySession(m[1]!, app.sessionSecret)?.sid ?? null) : null;
  }
  ```

- **PATTERN**: the guard ladder at `routes/auth.ts:329-337` (`resolvePrincipal` → 401 →
  `authorized(principal, "viewer")` → 403) and the `isUuid(id) else 404` ladder documented at
  `routes/alerts.ts:7`.
- **GOTCHA**: `DELETE /v1/auth/sessions/:id` returns **404**, not 403, when the id belongs to another
  user — `revokeSession` already collapses "unknown" and "not yours" into `false`, and telling a
  caller that a session id exists but is not theirs is an enumeration oracle. Same reasoning as the
  always-202 reset route (D-15.5-7).
- **GOTCHA**: `POST /v1/auth/logout` on an `ADMIN_TOKEN` caller has no session to revoke. Return
  **204** anyway (idempotent, nothing to do) rather than erroring — the desktop app still uses
  `ADMIN_TOKEN` until 15.9.
- **GOTCHA**: `revoke-all` includes the caller's own session. That is the "sign out everywhere"
  semantic users expect, and the dashboard clears the cookie right after. `POST /v1/auth/password`
  (Task 10) uses the `exceptSessionId` form instead — the two are deliberately different.
- **VALIDATE**: `npm run typecheck`

### 10. CLOSE the two 15.5 TODOs — invalidate on credential change

- **IMPLEMENT**:
  - `POST /v1/auth/password-reset/confirm` (line ~316): inside the **existing** transaction, after
    `updatePasswordHash`, call `await revokeAllSessions(tx, userId)` — **all** of them. The caller is
    unauthenticated, has no current session, and the whole point of the flow is that somebody else
    may be holding one. Replace the TODO comment with what actually happens.
  - `POST /v1/auth/password` (line ~345): `await revokeAllSessions(app.db, principal.userId, currentSid(app, request) ?? undefined)`
    — every session **except the caller's own**, so changing your password does not log you out of
    the tab you did it in.
- **PATTERN**: the existing transaction at `routes/auth.ts:299-315` — join it, do not open a second.
  A password written but sessions left live is exactly the half-state the atomicity comment there
  warns about.
- **GOTCHA**: delete the two now-false `15.6 (D-M15-12): sessions become stateful; THIS is where…`
  comments. A stale comment that describes work as pending after it shipped is the defect CLAUDE.md's
  15.5 lesson names explicitly — the next reader trusts it instead of re-deriving it.
- **VALIDATE**: `npm run typecheck`

### 11. UPDATE `apps/ingest/src/routes/members.ts` — revoke on removal

- **IMPLEMENT**: inside the existing `withOrg` callback in `DELETE /v1/members/:userId` (line ~304),
  after `removeMember` succeeds, call `await revokeAllSessions(tx, request.params.userId)`.
- **PATTERN**: `routes/members.ts:287-310` — the outcome-union shape is already there; add the call
  inside the same transaction so a removed membership and dead sessions commit together.
- **GOTCHA**: `PATCH /v1/members/:userId` (role change) deliberately does **NOT** revoke. `role` is
  re-resolved from `memberships` on *every* request by `findPrincipalByEmail`, so a demotion takes
  effect on the caller's very next request without touching their session. Revoking there would log
  a user out for a change that is already live — add a one-line comment saying so, or the next
  reader will "fix" the asymmetry.
- **VALIDATE**: `npm run typecheck`

### 12. UPDATE `apps/dashboard/src/app/api/auth/logout/route.ts`

- **IMPLEMENT**: call ingest's new `POST /v1/auth/logout` (through `proxyJson`) **before** clearing
  the cookie, so the server-side row dies rather than merely the client's copy.
- **PATTERN**: `apps/dashboard/src/lib/proxy.ts:23` — `proxyJson("/v1/auth/logout", {method: "POST"})`.
- **GOTCHA**: the cookie must be cleared **even if the ingest hop fails** (502/unreachable). A logout
  that leaves the user logged in because the archive is down is a worse outcome than a session row
  that outlives its cookie — it will expire on its own within 7 days.
- **GOTCHA (D-15.6-4, read this before "fixing" the middleware)**: `apps/dashboard/src/middleware.ts`
  verifies the cookie's MAC **on the Edge runtime, with no database access**, so it *cannot* see
  revocation. It stays a MAC+expiry UX gate. **The residual is real and must be named, not hidden**:
  for up to 7 days a revoked-but-unexpired cookie still renders the dashboard *shell*, while every
  data fetch through it 401s from ingest. Do **not** attempt to close this by calling ingest from
  middleware — that puts a network hop on every navigation, and the security boundary is ingest, not
  Next. Document it in `docs/guide/operations.md` (Task 14) and leave the middleware alone.
- **VALIDATE**: `npm run typecheck:dashboard && npm run build:dashboard`

### 13. CREATE the two test suites

- **IMPLEMENT**:
  - `packages/db/src/repositories/sessions.int.test.ts` — repository-level, two-role. Role identity
    first; then mint/find/revoke-one/revoke-all/list; the isolation assertion (A's revoke-all leaves
    B's session live); idempotent second revoke-all returns 0; an expired row is not "live".
  - `apps/ingest/src/sessions.int.test.ts` — **the centrepiece**. Build the app on `appRole.db` and
    write the four assertions from
    [THE TWO-ROLE BEHAVIOURAL ASSERTION](#the-two-role-behavioural-assertion) verbatim, plus:
    logout kills only the current session; revoke-one 404s for another user's id; password-change
    keeps the current session and kills the others; reset-confirm kills all; member-removal kills the
    removed user's sessions; a `sid`-less legacy token 401s (hand-sign one with the old 3-arg payload).
- **PATTERN**: `apps/ingest/src/identity.int.test.ts:1-175` — copy the harness wholesale: the
  `describe.skipIf(!TEST_URL || !APP_URL)`, the `owner`/`appRole` split, `buildApp({db: appRole.db,…})`,
  `login()`, `asUser()`, `json()`, and the `afterAll` that closes **the app and both pools**.
- **IMPORTS**: `import { verifySession } from "./session.js";` — the discriminator assertion needs the
  pure crypto check.
- **GOTCHA**: **no fixture edits are needed anywhere else.** Verified during planning: `TRUNCATE …
  users … RESTART IDENTITY CASCADE` — the shape every existing int-test fixture already uses —
  truncates `sessions` automatically via the FK, *without* naming it. Do not add `sessions` to ~20
  TRUNCATE lists.
- **GOTCHA**: add `"sessions"` to `NO_RLS_TABLES` in
  `packages/db/src/repositories/rls.int.test.ts:135`, and to **no other list**. The inventory test's
  expected policy counts are *derived* from `STRICT_TABLES` / `BOOTSTRAP_TABLES` /
  `ROLE_GATED_BOOTSTRAP_TABLES` (lines ~470-500), so adding `sessions` to `NO_RLS_TABLES` changes no
  count — it extends the `expect(orgByTable.has(t)).toBe(false)` loop to assert `sessions` carries
  **no** policy. If a count assertion starts failing, you have added a policy you did not mean to
  add. The "all 17 tenant tables have relrowsecurity" test must also stay at 17: `sessions` is not a
  tenant table.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/sessions.int.test.ts apps/ingest/src/sessions.int.test.ts`
- **THEN**: run the **mutation check** exactly as specified above and record the pass/fail split.

### 14. UPDATE docs + `SUMMARY.md` in the same commit

- **IMPLEMENT**:
  - `docs/guide/operations.md` — a short "Sessions and revocation" section: sessions are now
    server-side rows; upgrading to 0018 signs everyone out once (D-15.6-5); rotating `SESSION_SECRET`
    is no longer the revocation mechanism; **and the D-15.6-4 residual** (the dashboard shell renders
    for a revoked-but-unexpired cookie, data does not).
  - `SUMMARY.md` — flip **15.6** to ✅ with `DONE <date> (PR #NN)` in both the §0 status block and the
    §6 roadmap, and record D-15.6-1…9.
  - `.agents/execution-reports/m15-slice6-sessions-revocation.md` via `/lril:execution-report`.
- **GOTCHA**: `scripts/check-summary.mjs` **fails the gate** if an execution report exists without the
  matching ✅. Same commit, not a follow-up.
- **VALIDATE**: `npm run repo-health:fast`

---

## TESTING STRATEGY

### Unit Tests

- `apps/ingest/src/session.test.ts` — extend: a signed token round-trips its `sid`; a token signed
  without one (hand-built, old 3-arg payload) still verifies cryptographically but has
  `payload.sid === undefined`. **That second test is what makes the int suite's discriminator
  meaningful**, so it is not optional.
- `apps/dashboard/src/lib/session.test.ts` — extend with one case: a token carrying `sid` verifies on
  the Edge path and the extra claim is ignored. Pins SPIKE 4 so a future payload change cannot break
  Edge interop silently.

### Integration Tests

Both new `*.int.test.ts` files from Task 13, **two-role throughout**. Note the layering deliberately
mirrors the 15.3 lesson: the HTTP suite proves the *product behaviour*, the repository suite proves
the *mechanism*, and neither substitutes for the other.

### Edge Cases

- A `sid` that is a well-formed uuid but does not exist → 401 (not a 500 from a failed cast).
- A `sid` that is **not** a uuid (hand-forged payload, valid MAC — only reachable by the secret
  holder, but the query must not 500). `findLiveSession`'s `eq` on a `uuid` column with a non-uuid
  string raises `22P02`; guard with `isUuid` in `resolvePrincipal` or catch it. **Decide and pin it
  with a test** — this is the "unknown id → 404/401, never a DB-cast 500" invariant CLAUDE.md states.
- A session whose row is live but whose token `exp` has passed → 401 from `verifySession` before any
  query runs.
- A session whose token `exp` is in the future but whose row expired (clock skew / shortened TTL) →
  401 from `findLiveSession`. Both directions must be covered.
- `revoke-all` twice → second returns `{revoked: 0}`, not an error.
- Two concurrent `revoke-all` calls → both succeed, total revoked across the two equals the number
  that were live. (No lock needed — the blind UPDATE has no read-then-write window. This test exists
  to pin the *reasoning*, since CLAUDE.md's 15.5 lesson makes "is this racy?" the first question a
  reviewer will ask.)
- `ADMIN_TOKEN` caller → every route in this slice still behaves (logout 204, list empty).

---

## VALIDATION COMMANDS

All runnable from the repo root.

### Level 1: Syntax & Style

```bash
npm run typecheck          # root tsc -b — MUST exit 0 (per-workspace build is not a substitute)
npm run typecheck:dashboard
npm run lint               # not in repo-health; CI runs it
npm run format:check       # CI lints markdown too — this plan file included
```

### Level 2: Unit Tests

```bash
npx vitest run apps/ingest/src/session.test.ts apps/dashboard/src/lib/session.test.ts
```

Expected: all pass, including the two new cases.

### Level 3: Integration Tests

```bash
npm run db:up && npm run db:migrate
npx vitest run packages/db/src/repositories/sessions.int.test.ts apps/ingest/src/sessions.int.test.ts
npm run repo-health -- --require-db
```

**`--require-db` is mandatory for this slice** (it touches `@420ai/db` and `apps/ingest`). Expected
pass signal: the gate exits 0 **and** reports the integration layer actually ran with **0 skipped**.
A plain `repo-health` PASS is not evidence — `skipped ≠ passed`.

> Test-DB note: `db:migrate` does **not** migrate `420ai_test`. Migrate it separately before
> `--require-db`, or the new `sessions` table will be missing and every new int test will error on a
> relation that does not exist.

### Level 4: Manual Validation

```bash
# 1. Log in; keep the token.
TOKEN=$(curl -s localhost:3001/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"…"}' | jq -r .token)

# 2. It works (the POSITIVE check — do this before revoking anything).
curl -s -o /dev/null -w '%{http_code}\n' localhost:3001/v1/auth/me -H "Authorization: Bearer $TOKEN"   # 200

# 3. List sessions — the current one is flagged.
curl -s localhost:3001/v1/auth/sessions -H "Authorization: Bearer $TOKEN" | jq

# 4. Revoke everything, then re-check the SAME token.
curl -s -X POST localhost:3001/v1/auth/sessions/revoke-all -H "Authorization: Bearer $TOKEN" | jq
curl -s -o /dev/null -w '%{http_code}\n' localhost:3001/v1/auth/me -H "Authorization: Bearer $TOKEN"   # 401
```

On Windows use `curl.exe` and file-based JSON bodies — bare `curl` is a PowerShell alias and `\"`
escaping breaks.

### Level 5: Additional Validation

Dashboard round-trip with headless Edge (CLAUDE.md's screenshot recipe): log in, revoke all from a
second browser, confirm the first browser's next data load shows the error state. Pair it with the
HTTP assertion that page source contains **0** occurrences of `ADMIN_TOKEN`.

---

## ACCEPTANCE CRITERIA

- [ ] A revoked session token is rejected by every authenticated ingest route
- [ ] The rejection is proven to be revocation, not expiry — the discriminator assertion is present
      and the mutation check produced the expected pass/fail split (recorded in the execution report)
- [ ] A freshly minted session authenticates (the positive assertion) — asserted **before** every
      negative one
- [ ] Revoking user A's sessions leaves user B's live
- [ ] `POST /v1/auth/password-reset/confirm` kills **all** the user's sessions
- [ ] `POST /v1/auth/password` kills all **except** the caller's own
- [ ] `DELETE /v1/members/:userId` kills the removed user's sessions, in the same transaction
- [ ] `PATCH /v1/members/:userId` does **not** revoke, with a comment saying why
- [ ] A pre-0018 (`sid`-less) token is rejected
- [ ] `sessions` appears in `NO_RLS_TABLES` and in no other classification list; every derived
      `pg_policies` count and the "all 17 tenant tables" count are unchanged
- [ ] Both new suites run under the **non-owner** role, with the role-identity assertion first
- [ ] `npm run repo-health -- --require-db` passes with **0 skipped** integration tests
- [ ] `npm run build:dashboard` passes (Edge middleware import graph intact)
- [ ] `SUMMARY.md` flips 15.6 to ✅ in the **same commit** as the execution report
- [ ] The D-15.6-4 residual is documented in `docs/guide/operations.md`, not left implicit

---

## COMPLETION CHECKLIST

- [ ] All 14 tasks completed in order, each validated immediately
- [ ] Mutation check run; the pass/fail split matches the prediction
- [ ] Rollback drill: `npm run db:rollback` to 0017 and forward again
- [ ] No stale comments left claiming 15.6 is pending
- [ ] `/lril:code-review` run before commit (it is what catches the long-lived-resource and
      silent-failure classes this slice is full of)
- [ ] Full gate green: `npm run repo-health -- --require-db`

---

## NOTES

### Decisions this slice makes

- **D-15.6-1 — Keep the HMAC; add a `sid` claim.** Not opaque random tokens. The dashboard's Edge
  middleware verifies the MAC locally with `crypto.subtle`; opaque tokens would force it to call
  ingest on every navigation or abandon the gate entirely. Proven safe by SPIKE 4.
- **D-15.6-2 — `sessions` stores no `token_hash`.** A deliberate departure from `invites` /
  `password_reset_tokens` / `ingest_tokens`, all of which hash. Those rows hold a bearer secret that
  *is* the credential; a session's credential is the HMAC, which requires `SESSION_SECRET` to produce.
  `id` is a lookup key. Hashing it would imply a protection that is not there.
- **D-15.6-3 — `sessions` is an IDENTITY table: no `org_id`, no RLS.** Extends D-15.3-4 / D-15.5-1. A
  session belongs to a user; the org comes from the membership at resolve time.
- **D-15.6-4 — Revocation is enforced at ingest, NOT in the dashboard middleware.** With the named
  residual: a revoked-but-unexpired cookie renders the shell, and every data fetch 401s. Closing it
  would cost a network hop per navigation for no security gain, since ingest is the boundary.
- **D-15.6-5 — Pre-0018 (`sid`-less) tokens are rejected, not grandfathered.** Everyone logs in once
  after the upgrade. A grace period is a window in which revocation silently does not apply.
- **D-15.6-6 — Password *change* spares the current session; password *reset* spares none.**
- **D-15.6-7 — Member removal revokes; role change does not.** Role is re-resolved per request.
- **D-15.6-8 — No `last_used_at`.** It would put a write on every authenticated read, including the
  SSE stream — the audit-B.4 shape 15.4 had to throttle away.
- **D-15.6-9 — `user_agent` is truncated to 256 chars at the route.** Attacker-controlled text that is
  later rendered; bound it at the edge.

### Spikes actually RUN during planning (throwaways deleted)

All against the live test DB (`420ai-archive` container) on 2026-07-28.

| Spike | Question | Result |
| --- | --- | --- |
| **1** | Is `DATABASE_URL_TEST_APP` really a non-bypassing role? | `current_user=420ai_app`, `is_superuser=off`, `rolbypassrls=false` ✅ |
| **2** | Does 0015's `ALTER DEFAULT PRIVILEGES` cover a **new** table with no explicit `GRANT`? | Implicit `DELETE,INSERT,SELECT,UPDATE` to `420ai_app`; the app role inserted **and** selected on a table created seconds earlier. **0018 needs no GRANT.** ✅ |
| **3** | Is `UPDATE … WHERE revoked_at IS NULL RETURNING id` idempotent, and does it return a usable count? | First call 1 row, second call 0 rows. ✅ Confirms `revokeAllSessions`' return contract. |
| **4** | Does an extra `sid` claim survive **both** verifiers? | ingest `node:crypto` parse keeps `sid`; the dashboard's base64url→`atob` path decodes identically; token **172 bytes**, far under the 4096-byte cookie limit. **No dashboard change needed.** ✅ |
| **5** | sha256 hex width, had we hashed the token | 64 chars — noted, then rejected per D-15.6-2. |
| **6** | Do ~20 existing `TRUNCATE` fixtures need `sessions` added? | **No.** `TRUNCATE memberships, organizations, users RESTART IDENTITY CASCADE` cleared a new FK-referencing table *without naming it*. Removes ~20 file edits from this slice. ✅ |

### Symbols verified by reading source (not from memory)

`Db` / `Tx` / `DbClient` / `createDb` (`packages/db/src/client.ts:5,8,15,21`) · `withOrg`,
`APP_ROLE_NAME`, `ORG_SETTING`, `ROLE_SETTING` (`org-context.ts:50,94,97,103`) ·
`findPrincipalByEmail`, `Principal` (`repositories/principal.ts:50,17`) · `normalizeEmail`,
`findUserIdByEmail`, `findAdminCredential`, `createUserWithPassword`, `updatePasswordHash`,
`setUserPassword` (`repositories/users.ts:21,26,58,112,125,79`) · `MemberError`, `removeMember`,
`setMemberRole`, `findMemberByUserId` (`repositories/members.ts:30,182,153,102`) ·
`PasswordResetError`, `createPasswordReset`, `consumePasswordReset`
(`repositories/password-resets.ts:22,51,81`) · `generateToken` / `hashToken` (`tokens.ts:10,14`) ·
`signSession`, `verifySession`, `SESSION_TTL_SECONDS` (`apps/ingest/src/session.ts:19,35,10`) ·
`resolvePrincipal`, `authorized`, `isUuid` (`apps/ingest/src/auth.ts:37,82,92`) · `hasRole`, `Role`
(`@420ai/shared`) · `proxyJson` (`apps/dashboard/src/lib/proxy.ts:23`) · `verifySessionEdge`,
`SESSION_COOKIE` (`apps/dashboard/src/lib/session.ts:50,12`).

Test harness confirmed to exist: `apps/ingest/src/identity.int.test.ts` — `buildApp({db, adminToken,
adminEmail, sessionSecret, analysisProvider, mailer, reconcileThrottleMs, logger})` at lines 104-115,
`login()` at 126, `asUser()`/`json()` at 136-137, two-pool `afterAll` at 119-124. `errorChain` /
`expectRlsRejection` at 55-77 (not needed here — no policy to violate — but present if a later
reviewer expects them).

### Residual risks (each named, none blocking)

1. **Task 8 may require widening `findAdminCredential`** to return `id`. Read it first; it is a
   two-line change to an explicit column list, and `tsc` will point at it.
2. **The non-uuid `sid` cast** (`22P02`) is the one edge case whose handling is left to the executor
   to *decide* (guard vs catch) rather than prescribed — both are defensible, and the plan requires
   only that a test pins whichever is chosen.
3. **The D-15.6-4 residual is a product decision, not a bug.** If a reviewer wants it closed, that is
   a scope change (middleware→ingest hop per navigation) and belongs in 15.10 with the team surfaces,
   not here.
