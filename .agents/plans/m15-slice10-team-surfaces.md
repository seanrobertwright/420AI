# Feature: M15 Slice 15.10 — Team surfaces + audit table

The following plan should be complete, but it is important that you validate documentation, codebase
patterns and task sanity before you start implementing.

Pay special attention to naming of existing utils, types and models. Import from the right files.

Conventions live in [`CLAUDE.md`](../../CLAUDE.md) and the milestone definition in
[`.agents/plans/m15-multi-user-access-control.md`](./m15-multi-user-access-control.md) — this plan
LINKS to them and does not re-paste them.

---

## Feature Description

The last slice of M15. It ships the **dashboard surfaces** for everything slices 15.5–15.9 built
headless, and the milestone's **write-only audit table**.

Nine slices built a complete multi-user backend and shipped **zero** user-facing surface for it. The
dashboard today has no members list, no invite flow, no API-key management and no org settings; the
`/team` page does not exist. Most sharply: `apps/ingest/src/routes/members.ts:173` emails a new
colleague a link to `${appBaseUrl}/invite/${token}`, and **that page does not exist**, so the
flagship onboarding path of the entire milestone dead-ends on a 404. An admin can only onboard
someone by reading the token out of a JSON response and passing it over Slack for them to `curl`.

Alongside that, the slice lands `audit_events` — an **append-only** record of who did what to whom.
Nine slices deferred audit records to it by name (`api-keys.ts:27`, `mfa.ts:1137` in its plan,
`operations.md:774`, `operations.md:978`), and one deferred feature was explicitly blocked on it: an
admin-initiated **MFA reset** for a colleague who has lost their authenticator, which 15.8 refused to
ship without both 15.5's rank ceiling-and-floor and an audit record. Both now exist.

## User Story

```
As an owner or admin of a 420AI organization
I want to invite colleagues, see and change their roles, remove them, manage my own API keys,
  and have every one of those privileged acts recorded immutably
So that I can actually run a team on this deployment, and can later answer "who did that, and when?"
  without taking anyone's word for it
```

## Problem Statement

1. **The invite path is broken end-to-end.** The one link the product emails a new user 404s.
2. **Every team operation is curl-only.** `GET/PATCH/DELETE /v1/members`, `POST /v1/members/invite`,
   `GET/DELETE /v1/invites`, and all four `/v1/auth/api-keys` routes have no UI whatsoever.
3. **The desktop app tells users to wait for a UI that was never built.**
   `apps/desktop/src-tauri/src/proxy.rs:53` renders the literal message _"API key not configured.
   There is no management UI yet (15.10)"_, and `apps/desktop/src/components/Settings.tsx:304` says
   _"no UI until 15.10"_. Both are now the deployed product's advice to its user.
4. **Privileged actions are unattributable after the fact.** An admin can change a colleague's role,
   evict them, or reset their credentials, and nothing anywhere records that it happened. 15.9
   retired `ADMIN_TOKEN` specifically because it was un-attributable — but attribution at the
   *request* layer with no *record* still answers "who did that?" with silence.
5. **A colleague who loses their phone cannot recover.** With MFA enrolled and no admin reset path,
   the only remedy is the operator opening `psql` (D-M15-7 break-glass) — for a routine, expected
   event rather than an emergency.

## Solution Statement

Three surfaces, one table, one endpoint pair, and a documentation correction.

- **`/invite/[token]`** — a public page that previews the invitation (org name, role, expiry) and
  redeems it, setting the session cookie so the new colleague lands logged in.
- **`/team`** — members with their roles and join dates, pending invites, and the mutations
  (invite / change role / remove / revoke invite), gated so a `viewer` sees the roster and no
  controls.
- **Settings additions** — an `<ApiKeysCard/>` (list / mint / revoke, with the re-auth password
  prompt) beside the existing `<SsoLinks/>` and `<MfaCard/>`, and an `<OrgCard/>` that renders
  **only once the org has more than one member** (D-M15-10).
- **`audit_events`** — a new table with a deliberately novel RLS shape: **append-only**. One
  `PERMISSIVE ... FOR INSERT WITH CHECK (true)` policy, no `SELECT`/`UPDATE`/`DELETE` policy, and
  `UPDATE`/`DELETE` revoked from the app role outright. The application can append and can do
  nothing else; the operator reads it via break-glass. Proven by a spike — see NOTES.
- **`GET`/`PATCH /v1/org`** — the org settings the milestone line asks for. Rename is `owner`-only.
- **`DELETE /v1/members/:userId/mfa`** — the admin MFA reset 15.8 parked here.

## Feature Metadata

**Feature Type**: New Capability (frontend) + New Capability (audit table)
**Estimated Complexity**: Medium — broad but shallow. No change to any tenancy primitive.
**Primary Systems Affected**: `apps/dashboard` (most of the work), `apps/ingest` (audit wiring +
two new endpoints), `packages/db` (one table, one repository), `packages/shared` (one closed set),
`apps/desktop` (two stale strings)
**Dependencies**: **NONE new.** No new npm package in any workspace. This is deliberate — see
GOTCHA-6.

### Scope decisions taken for this slice (settled during planning — do not re-litigate)

- **D-15.10-1 — Multi-org membership and the org switcher are DEFERRED to M16.** Eleven source
  comments promise them "at 15.10" (`schema.ts:68`, `principal.ts:39,79`, `members.ts:117,318-342`,
  `organizations.ts:41`, `api-keys.ts:359`, and two routes whose 409 body literally reads
  `"user already exists — multi-org membership lands in 15.10"`). They are wrong about the slice, and
  **this slice corrects them rather than honouring them.** _Rationale:_ multi-org reopens
  `findPrincipalByEmail`/`findPrincipalByUserId` — the load-bearing 15.2 primitive whose byte-identical
  `ORDER BY` is the only thing keeping session-auth and key-auth resolving to the same org — and
  additionally requires an active-org claim in the session token, per-org session/key revocation, and
  a rewrite of the invite-accept refusal. That is an L-sized slice touching the tenancy core, and
  **nothing in 15.10's UI needs it**: every surface here operates within `principal.orgId`. It
  belongs with M16's tenant slugs and hosting work.
- **D-15.10-2 — `audit_events` is APPEND-ONLY at the database layer, not merely by convention.**
  A fourth RLS classification. See "Patterns to Follow" for the measured justification.
- **D-15.10-3 — Audit writes are IN-TRANSACTION with the action they record, never best-effort.**
  So a failed audit insert DOES fail the action. That is the correct trade for an audit log: "the
  change committed but nobody knows who made it" is worse than "the request was refused, retry".
  It is also exactly CLAUDE.md's own lesson — _"a best-effort/swallow path is the worst place to lose
  a policy"_ — and D-15.10-2's INSERT-only permissive policy is what makes it safe, because the
  insert cannot be blocked by a missing org context or a `viewer` role (SPIKE checks 1, 1b, 8).
- **D-15.10-4 — The audit table ships with NO viewer** (milestone non-goal, restated). The read path
  is break-glass `psql` as the owner. A structural test asserts the repository exports no reader, so
  the "write-only" claim cannot rot into a half-built list endpoint.
- **D-15.10-5 — `MAX_API_KEYS_PER_USER` stays 25; the comment is corrected.** `api-keys.ts:57`
  promises a revisit "with real data at 15.10, when the management UI makes key counts visible". The
  UI lands here and **there is still no real multi-user data** — one install, one human. So the
  honest action is to stop promising a measurement that has not happened, not to change the number on
  no evidence. Delete the forward-reference; keep the "judgement, not a measurement" framing.

### Non-goals (name in the PR; do NOT build here)

Multi-org membership / org switcher (D-15.10-1 → M16) · an audit-log **viewer** or export
(D-15.10-4) · gated self-signup page, password-reset pages, an active-sessions list, and MFA QR
rendering — **all four remain headless and stated as deferred** (user decision at planning time;
the endpoints exist and are curl-reachable) · user-defined roles · billing/quotas · everything in
the milestone's own non-goals list.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**The backend you are building a UI for (read all four; they are the contract):**

- `apps/ingest/src/routes/members.ts` (all 365 lines) — Why: the five member/invite endpoints,
  their exact status codes, and the `outranks()` ceiling-and-floor. You will add audit calls to four
  handlers and one new handler here. The header comment explains why the file is `withOrg`-wrapped
  with `principal.role` (not `SERVICE_ROLE`) — that reasoning governs your additions.
- `apps/ingest/src/routes/api-keys.ts` (all 275 lines) — Why: the four key endpoints, the
  `serializeApiKey` wire shape (lines 252-275) your UI consumes, and line 27's standing note that
  _"the mint and revoke handlers are the two audit-worthy events in this file"_. Also the file
  whose header + allow-list reason you must update (GOTCHA-4).
- `apps/ingest/src/routes/auth.ts` lines 257-335 — Why: `GET /v1/auth/invites/:token` (preview:
  returns `{email, role, orgName, expiresAt}`, 410 + `reason` on unknown/revoked/accepted/expired)
  and `POST /v1/auth/invites/accept` (returns the **same shape as login** — `{token, expiresAt}` —
  because a brand-new user cannot have MFA, so it calls `mintSession`, never
  `mintSessionOrChallenge`). This pair is the entire backend of your `/invite/[token]` page.
- `apps/ingest/src/reauth.ts` (all 93 lines) — Why: the mint gate. **The UI contract is the
  `reason` discriminant**: `"password_required"` ⇒ show a password field and retry;
  `"reauth_required"` ⇒ the SSO-only branch, tell them to sign in again. Both arrive as **401**.

**The frontend patterns to mirror exactly:**

- `apps/dashboard/src/components/settings/sso-links.tsx` (all 145 lines) — Why: **the** template
  for every client island you write. Note specifically: `useCallback` loader, the
  `let cancelled = false` cleanup armed before the first await resolves (lines 55-67), per-row
  `busy` state keyed by id, status-specific error copy (line 74-79), `router.refresh()` after a
  successful mutation, and `if (available.length === 0) return null` — render nothing rather than an
  empty shell.
- `apps/dashboard/src/components/settings/mfa-card.tsx` lines 1-60 — Why: the closest existing
  analogue to `<ApiKeysCard/>`. It already solves "a secret that exists exactly once": the recovery
  codes are held in memory only, never re-fetched, and the UI says so. Your minted `token` needs
  identical handling. Also note `passwordRequiredToEnrol` — a server-reported branch rather than a
  guess.
- `apps/dashboard/src/app/settings/page.tsx` (all 48 lines) — Why: the Server-Component page
  pattern, including the local `getJson<T>()` helper that returns `null` on any non-200/throw. You
  will add `<OrgCard/>` data here and mirror this helper in `/team/page.tsx`.
- `apps/dashboard/src/app/api/auth/login/route.ts` (all 72 lines) — Why: **the cookie-setting
  pattern your invite-accept proxy must copy**, including the `sessionConfigError()` guard that must
  run FIRST (D.3), and the exact cookie options at lines 64-70.
- `apps/dashboard/src/lib/proxy.ts` (all 82 lines) — Why: `proxyJson()` forwards the upstream
  status verbatim, which is what lets the UI distinguish 403 from 404 from 502. Every authenticated
  proxy route you add is a two-line call to it.
- `apps/dashboard/src/lib/mutation-error.ts` — Why: `FORBIDDEN_MESSAGE` / `FORBIDDEN_SHORT`. Use
  them for every 403; do not write new 403 copy.
- `apps/dashboard/src/middleware.ts` (all 46 lines) — Why: **GOTCHA-1 lives here.**
- `apps/dashboard/src/components/app-nav.tsx` (all 117 lines) — Why: **GOTCHA-2 lives here**
  (lines 29-43), and you add the `/team` link at line 17-27.

**The database patterns:**

- `packages/db/drizzle/0021_typical_gabe_jones.sql` — Why: the exact convention for a
  hand-commented migration whose **absent policy block is the decision**. Yours is the inverse: a
  *present, novel* policy block. Match the density and the "re-verified live during planning" note.
- `packages/db/drizzle/0015_shiny_iron_man.sql` lines 1-45 — Why: the strict-policy pattern you are
  deliberately NOT using, the mandatory `nullif(…, '')` guard, and the
  `ALTER DEFAULT PRIVILEGES` statement that means **your table needs no `GRANT`** (verified in the
  spike: the app role received INSERT implicitly).
- `packages/db/drizzle/down/0021_typical_gabe_jones.down.sql` — Why: the `down/` file convention,
  including stating plainly what rolling back destroys.
- `packages/db/src/repositories/rls.int.test.ts` lines 89-173 and 470-560 — Why: the four
  classification constants and the inventory test whose **every count is derived from list lengths**.
  You add a fifth constant. Read the comment at lines 472-478 before touching it: the fix for a
  collapsing assertion is to re-key, **never to bump the expected number**.
- `packages/db/src/repositories/members.ts` lines 28-110 — Why: `MemberRow` (`{userId, email, role,
  joinedAt}`) is the wire shape your `/team` table renders, and `memberRowColumns` (line 52) is the
  explicit-column-list convention your audit repository must follow.
- `packages/db/src/org-context.ts` — Why: `withOrg(db, orgId, role, fn)` — note `role` is a
  **required** fourth parameter and `db` is typed `Db`, not `DbClient`, on purpose.
- `packages/shared/src/roles.ts` (all ~50 lines) — Why: the closed-set-as-const pattern your
  `AUDIT_ACTIONS` mirrors, and `hasRole` (fails closed, takes a `string`, never cast
  `principal.role`).

**The test harness (confirmed to exist):**

- `apps/ingest/src/test-support/bootstrap-key.ts:34` — `seedBootstrapKey(db, email, label?)`
  returns a plaintext bearer. **Call it in `beforeEach`, AFTER the TRUNCATE** (the file's own
  instruction at lines 21-24: `api_keys` FKs to `users`, so a `beforeAll` key is gone by the second
  test and the symptom is a confusing 401).
- `apps/ingest/src/rbac.int.test.ts` — Why: the existing multi-role HTTP fixture. Read how it
  seeds a second, non-owner principal — and heed CLAUDE.md's warning that `setUserPassword`
  auto-creates a personal `owner` membership that **shadows** an INSERTed one, so a second-rung user
  must be seeded by MOVING the existing membership.
- `packages/db/src/repositories/rls.int.test.ts` lines 175-215 — Why: the two-handle
  (`owner` + `appRole`) setup, the role-identity assertion, and `TRUNCATE … RESTART IDENTITY
  CASCADE` on the owner handle only.

### New Files to Create

**`packages/shared`**

- `src/audit.ts` — the `AUDIT_ACTIONS` closed set, `AuditAction` type, `isAuditAction` guard.
- `src/audit.test.ts` — the set is unique, sorted, and every entry matches `^[a-z_]+\.[a-z_]+$`.

**`packages/db`**

- `drizzle/00XX_<generated>.sql` — hand-edited after `db:generate` (see Task 4).
- `drizzle/down/00XX_<generated>.down.sql`
- `src/repositories/audit.ts` — `recordAuditEvent`, and nothing else.
- `src/repositories/audit.test.ts` — the D-15.10-4 write-only structural guard.
- `src/repositories/audit.int.test.ts` — the two-role append-only proof.

**`apps/ingest`**

- `src/routes/org.ts` — `GET /v1/org`, `PATCH /v1/org`.
- `src/audit.int.test.ts` — HTTP-level: each audited action writes exactly one correct row.
- `src/org.int.test.ts` — the org read/rename gating.

**`apps/dashboard`** (all under `src/`)

- `app/invite/[token]/page.tsx` + `components/invite/invite-accept-form.tsx`
- `app/team/page.tsx` + `components/team/team-view.tsx`
- `components/settings/api-keys-card.tsx`
- `components/settings/org-card.tsx`
- `app/api/auth/invites/[token]/route.ts` — **PUBLIC** preview proxy (under `/api/auth/` on purpose)
- `app/api/auth/invites/accept/route.ts` — **PUBLIC** accept proxy; sets the session cookie
- `app/api/members/route.ts` (GET), `app/api/members/invite/route.ts` (POST)
- `app/api/members/[userId]/route.ts` (PATCH, DELETE)
- `app/api/members/[userId]/mfa/route.ts` (DELETE)
- `app/api/invites/route.ts` (GET), `app/api/invites/[id]/route.ts` (DELETE)
- `app/api/org/route.ts` (GET, PATCH)
- `app/api/auth/api-keys/route.ts` (GET, POST, DELETE),
  `app/api/auth/api-keys/[id]/route.ts` (DELETE)

### Relevant Documentation

No external library documentation is required — this slice adds **no dependency**. The two framework
behaviours it leans on are already load-bearing elsewhere in the repo and are pinned by existing
tests, but the authoritative references are:

- [Next.js — Route Handlers: setting cookies](https://nextjs.org/docs/app/building-your-application/routing/route-handlers#cookies)
  - Why: `cookies().set()` is legal **only** in a Route Handler or Server Action, never a Server
    Component. This is why invite-accept must be a Route Handler, exactly as login is
    (`api/auth/login/route.ts:11` records the same constraint).
- [Next.js — Middleware `matcher`](https://nextjs.org/docs/app/building-your-application/routing/middleware#matcher)
  - Why: confirms the middleware runs on `/invite/<token>` under the existing catch-all matcher, so
    the page is gated unless explicitly exempted (GOTCHA-1).
- [PostgreSQL — `CREATE POLICY`](https://www.postgresql.org/docs/17/sql-createpolicy.html)
  - Specific sections: _"if no policy exists for the command, a default-deny applies"_ and the
    `PERMISSIVE`/`RESTRICTIVE` combination rules.
  - Why: the append-only design's whole basis. A table with RLS enabled and an INSERT-only policy
    default-denies `SELECT`/`UPDATE`/`DELETE` **for the non-owner role**, which is what makes
    "write-only" a database guarantee rather than a convention. Confirmed live — see NOTES.
- [PostgreSQL — `ALTER TABLE … FORCE ROW LEVEL SECURITY`](https://www.postgresql.org/docs/17/sql-altertable.html)
  - Why: justifies **omitting** FORCE here (GOTCHA-3), against a repo where all 13 strict tables set
    it.

### Patterns to Follow

#### The append-only RLS shape (D-15.10-2) — the slice's one novel pattern

Every audit-worthy action in this repo originates from **one of two kinds of call site**, and that
is the fact the design turns on:

| Call site                                       | Org context set? | Role in context     |
| ----------------------------------------------- | ---------------- | ------------------- |
| `members.ts`, `org.ts` — `withOrg`-wrapped      | yes              | the caller's, e.g. `admin` |
| `api-keys.ts`, `mfa.ts`, `auth.ts` — **not** wrapped (identity tables, allow-listed) | **no** | none |

A strict org policy (the 13-table pattern) therefore **cannot** be used: it rejects the insert from
the unwrapped half outright. And the 15.4 RESTRICTIVE role policies cannot be used either: a
`viewer` is explicitly permitted to revoke their own API key (`api-keys.ts:205`), and that action
must produce an audit row rather than a 500. Both were measured, not assumed (SPIKE checks 1b, 8).

So:

```sql
-- The whole policy block. RLS ON, so default-deny applies to every command with no policy;
-- exactly one policy, and it is INSERT-only and unconditional.
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
-- Deliberately NOT `FORCE ROW LEVEL SECURITY` — see GOTCHA-3.
CREATE POLICY "audit_events_append_only" ON "audit_events" FOR INSERT WITH CHECK (true);
-- Defence in depth: the policy already blocks these, and revoking makes the attempt LOUD
-- (`permission denied`) instead of a silent 0-row no-op. SELECT stays granted so a future
-- viewer needs only a policy, not a grant.
REVOKE UPDATE, DELETE ON "audit_events" FROM "420ai_app";
```

Measured consequences (all confirmed live — NOTES):

- the app role **appends** with or without an org context, at any role, always;
- the app role **reads zero rows**, even with a matching org context set — it is the absent SELECT
  policy, not a failing predicate;
- the app role **cannot** rewrite or erase history: `UPDATE`/`DELETE` are a hard permission error;
- the **owner** reads everything — the D-M15-7 break-glass channel, intact.

> **Spike-snippet fidelity.** The block above is the exact shape SPIKE checks 6 and 7 asserted:
> `pg_policies` shows **one** row — `permissive='PERMISSIVE'`, `cmd='INSERT'`, `qual=null`,
> `with_check='true'` — and `pg_class` shows `relrowsecurity=true`, `relforcerowsecurity=false`.
> If your migration produces anything else, the migration is wrong, not the spike.

#### Denormalize the actor and target onto the audit row

`actor_email` and `target_email` are stored **alongside** the FK ids, which is a deliberate
departure from the repo's normalized habit. Two reasons, and the second is decisive:

1. An audit row must be legible to an operator running one `SELECT *` under break-glass, without
   reconstructing joins across `users` and `memberships` to learn who "`a1b2…`" was.
2. For `member.invited` **there is no target user id at all** — an invite names an email address
   that has no `users` row yet (that is the entire point of D-M15-8). A normalized-only design
   simply cannot record the most common audited action.

`target_user_id` is therefore nullable and `target_email` is the load-bearing column.

#### Audit metadata never holds a secret

`metadata jsonb` carries the *shape* of a change (`{"from":"member","to":"admin"}`,
`{"keyName":"laptop"}`, `{"revoked":3}`) and **never** a token, a token hash, a password, or a
recovery code. The minted API key's plaintext exists exactly once, in the mint response
(`api-keys.ts:151`); an audit row that echoed it would create a second, permanent copy in the one
table the application cannot delete from.

#### Everything else follows an existing pattern

Route handlers: `resolvePrincipal` → 401, `authorized(principal, minimum)` → 403, `isUuid` → 400,
`withOrg(app.db, principal.orgId, principal.role, …)` for the tenant-touching ones. Proxy routes:
`export const dynamic = "force-dynamic"` + one `proxyJson()` call. Client islands: mirror
`sso-links.tsx` exactly.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation — the closed set, the table, the repository

The audit primitive, bottom-up, with nothing consuming it yet. Ends with a green
`repo-health --require-db` and a table nobody writes to.

### Phase 2: Ingest — audit wiring, the org endpoints, the MFA reset

Every audited action, in-transaction. Two new endpoints. The stale allow-list reasons.

### Phase 3: Dashboard — the three surfaces

Proxy routes first (they are pure plumbing and independently verifiable with `curl`), then the
pages, then the two path-matching fixes that make `/invite/` public.

### Phase 4: Testing & Validation

The two-role append-only proof, the RLS inventory extension, the HTTP-level audit assertions, and
the manual walkthrough.

### Phase 5: Truth — correct the eleven multi-org comments and the stale desktop strings

D-15.10-1's other half. A comment that promises a shipped slice will do something it did not do is
the kind of debt CLAUDE.md is largely a monument to.

---

## STEP-BY-STEP TASKS

Execute in order. Each task is atomic and independently validated.

### 1. CREATE `packages/shared/src/audit.ts`

- **IMPLEMENT**: `AUDIT_ACTIONS` as a `readonly` tuple, `AuditAction` as its member union, and an
  `isAuditAction(value: string): value is AuditAction` guard. The set, exactly:

  ```
  api_key.minted        api_key.revoked        api_key.revoked_all
  member.invited        member.invite_revoked  member.joined
  member.removed        member.role_changed    member.mfa_reset
  org.renamed
  ```

  Document what is **excluded and why**, so the boundary is a decision rather than an oversight:
  logins and login failures are not audited (`ingest_auth_failures` already records failures, and
  recording every success turns a security record into a traffic log), and self-service credential
  changes a user makes to their own account (password change, MFA enrol/disable, session revoke)
  are not audited in this slice — they are visible to the account holder already and none of them
  affects another principal's standing.
- **PATTERN**: `packages/shared/src/roles.ts` — `as const` tuple + derived union + closed-set guard,
  with the "TEXT not a pg enum, so adding a value is a code change not a migration" rationale.
- **IMPORTS**: none.
- **GOTCHA**: the `<subject>.<verb_past_tense>` spelling is the contract with the table's `action`
  TEXT column, which has **no CHECK** (matching `memberships.role`). The guard is the enforcement,
  so use it wherever an action could arrive as a bare string.
- **VALIDATE**: `npx vitest run packages/shared/src/audit.test.ts`

### 2. ADD the barrel export in `packages/shared/src/index.ts`

- **IMPLEMENT**: re-export `AUDIT_ACTIONS`, `isAuditAction` and `export type { AuditAction }`.
- **PATTERN**: find the adjacent `roles.js` re-export and mirror it, `.js` suffix included.
- **GOTCHA**: `verbatimModuleSyntax` — types go through `export type`, never a bare `export`.
- **VALIDATE**: `npm run typecheck` (exit 0)

### 3. UPDATE `packages/db/src/schema.ts` — add `auditEvents`

- **IMPLEMENT**: append at the end of the file:

  ```ts
  export const auditEvents = pgTable(
    "audit_events",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id")
        .notNull()
        .references(() => organizations.id),
      actorUserId: uuid("actor_user_id")
        .notNull()
        .references(() => users.id),
      actorEmail: text("actor_email").notNull(),
      targetUserId: uuid("target_user_id").references(() => users.id),
      targetEmail: text("target_email"),
      action: text("action").notNull(),
      metadata: jsonb("metadata"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [index("audit_events_by_org_time").on(t.orgId, t.createdAt)],
  );
  ```

  The doc comment must carry D-15.10-2's argument (the two-kinds-of-call-site table), D-15.10-4
  (no viewer), and the denormalization rationale.
- **PATTERN**: `invites` (schema.ts:175-198) for a uuid-PK org-owned table with an index; `events`
  for the `jsonb` import.
- **IMPORTS**: `jsonb` is already imported by this file (used by `events.tokens`) — confirm rather
  than adding a duplicate import.
- **GOTCHA**: the FKs to `organizations` and `users` are safe **because neither row is ever
  deleted** — `members.ts:180` records that the personal org is never dropped, and member removal
  deletes a *membership*, never a user. If that ever changes, these FKs become the thing that
  blocks it, which is the correct direction for an audit table.
- **GOTCHA**: `metadata` is nullable and `targetUserId`/`targetEmail` are nullable; `orgId`,
  `actorUserId`, `actorEmail` and `action` are NOT — an audit row that cannot say who acted is not
  an audit row.
- **VALIDATE**: `npm run typecheck` (exit 0)

### 4. GENERATE and then HAND-EDIT the migration

- **IMPLEMENT**: run `npm run db:generate`. It emits `packages/db/drizzle/00XX_<random-name>.sql`
  containing only the `CREATE TABLE` + FK + index. **Append the policy block by hand**, verbatim
  from "Patterns to Follow" above, preceded by a comment in 0021's register that states: why the
  strict pattern is unusable (both kinds of call site, with the SPIKE-8 control result named), why
  FORCE is omitted (GOTCHA-3), why no `GRANT` is needed (0015's `ALTER DEFAULT PRIVILEGES`, verified
  live), and that `audit_events` joins a **new** `APPEND_ONLY_TABLES` classification in
  `rls.int.test.ts` — not `NO_RLS_TABLES`, and not the tenant lists.
- **PATTERN**: `packages/db/drizzle/0021_typical_gabe_jones.sql` for the comment density and the
  "RE-VERIFIED live against 420ai_test during planning" note. Use `--> statement-breakpoint`
  between every statement.
- **GOTCHA**: `drizzle-kit generate` **cannot** emit `CREATE POLICY`, `REVOKE`, or
  `ALTER TABLE … ENABLE ROW LEVEL SECURITY` — that is why 0015 and 0016 are hand-authored. Never
  re-run `db:generate` after hand-editing expecting it to preserve your block.
- **GOTCHA**: the generated filename is random; do not hard-code `0023` anywhere. Reference the file
  by its real name in the `down/` file and the SUMMARY entry.
- **VALIDATE**:
  `npm run db:up && npm run db:migrate && docker compose exec -T archive psql -U 420ai -d 420ai -c "select policyname, permissive, cmd, with_check from pg_policies where tablename='audit_events'"`
  — expect exactly one row: `audit_events_append_only | PERMISSIVE | INSERT | true`.

### 5. CREATE the `down/` migration

- **IMPLEMENT**: `packages/db/drizzle/down/00XX_<same-name>.down.sql` — a single
  `DROP TABLE IF EXISTS "audit_events";` (the policy, index and FKs drop with it, so there is no
  policy-ordering hazard). State plainly what rolling back destroys: **the entire audit history,
  irrecoverably** — it is derived from nothing and cannot be rebuilt from any other table, unlike
  every `events` projection in this repo. Note that rolling forward again produces an empty table,
  and that a post-15.10 server against a pre-15.10 schema will **fail every audited mutation**
  (D-15.10-3 makes the audit insert part of the action's transaction), not silently skip auditing.
- **PATTERN**: `drizzle/down/0021_typical_gabe_jones.down.sql`.
- **VALIDATE**: `npm run db:rollback && npm run db:migrate` — both exit 0; re-run the Task-4 psql
  check afterwards and expect the policy back.

### 6. CREATE `packages/db/src/repositories/audit.ts`

- **IMPLEMENT**: exactly one exported function plus its input type:

  ```ts
  export interface AuditEventInput {
    orgId: string;
    actorUserId: string;
    actorEmail: string;
    action: AuditAction;
    targetUserId?: string | null;
    targetEmail?: string | null;
    metadata?: Record<string, unknown> | null;
  }

  export async function recordAuditEvent(db: DbClient, input: AuditEventInput): Promise<void>;
  ```

  Typed `DbClient` (a `Db` **or** a `Tx`) precisely so it can be called from both kinds of call
  site — the wrapped handlers pass their `tx`, the unwrapped ones pass `app.db`. Returns `void`: the
  row's id has no consumer (D-15.10-4), and returning one would invite a caller to try to read it
  back, which the policy forbids.
- **PATTERN**: `packages/db/src/repositories/members.ts` — silent library (no logging, no
  `process.exit`), explicit column lists.
- **IMPORTS**: `import type { AuditAction } from "@420ai/shared";` — the action is typed at the
  boundary so a typo is a compile error rather than an unqueryable string in the one table you
  cannot `UPDATE`.
- **GOTCHA**: **no `returning()`**, and no `select` anywhere in this file. D-15.10-4 is enforced by
  the next task's test, which reads this module's exports.
- **GOTCHA**: do NOT wrap in a transaction here. The caller owns the transaction — that is what
  makes the audit row atomic with the action it records (D-15.10-3).
- **VALIDATE**: `npm run typecheck` (exit 0)

### 7. CREATE `packages/db/src/repositories/audit.test.ts` — the write-only guard

- **IMPLEMENT**: import the module namespace and assert that **every** exported value is a writer:
  no export name matches `/^(list|find|get|select|count|search)/i`, and the export set is exactly
  `["recordAuditEvent"]`. The test's message must explain that D-15.10-4 makes this a *decision*:
  adding a reader requires adding a strict SELECT policy in the same commit, because the app role
  currently reads zero rows and a reader would silently return an empty list forever.
- **PATTERN**: `apps/ingest/src/routes/org-scoping.test.ts` — a structural test that asserts a
  schema-level decision so an exemption cannot grow silently. Note its header's honesty about being
  a "cheap first net"; say the same here, and point at `audit.int.test.ts` as the behavioural proof.
- **GOTCHA**: assert the set is non-empty first. A structural test that scans nothing passes
  vacuously — the worst kind of green (that exact guard exists at `org-scoping.test.ts:118`).
- **VALIDATE**: `npx vitest run packages/db/src/repositories/audit.test.ts`

### 8. ADD the barrel export in `packages/db/src/index.ts`

- **IMPLEMENT**: export `recordAuditEvent` and `export type { AuditEventInput }`; add `auditEvents`
  to the schema re-export block at the top (mirroring `organizations`, `memberships`).
- **PATTERN**: the existing `./repositories/members.js` export block at index.ts:170-180, comment
  included — say why `audit_events` needs no `orgId`-scoping note (it has no read path).
- **VALIDATE**: `npm run typecheck` (exit 0)

---

### 9. UPDATE `apps/ingest/src/routes/members.ts` — audit the four mutations

- **IMPLEMENT**: inside each handler's existing `withOrg` callback, on the **success** path only,
  call `recordAuditEvent(tx, …)`:
  - invite success → `member.invited`, `targetEmail: email`, `metadata: { role: requestedRole }`.
    Place it inside the same `withOrg` transaction as `createInvite`, **before** the mailer call —
    the audit records that an invite was *created*, which is true regardless of whether SMTP later
    succeeded (and the mailer's failure path deliberately still returns 200).
  - `DELETE /v1/invites/:id` success → `member.invite_revoked`. The repository's `revokeInvite`
    returns a boolean; you need the invite's email for `targetEmail`, so audit with
    `metadata: { inviteId }` and `targetEmail: null` unless you widen `revokeInvite` — **do not
    widen it**; an invite id is sufficient identification and widening a repository signature for a
    log field is the wrong trade.
  - `PATCH /v1/members/:userId` success → `member.role_changed`, `targetUserId`,
    `targetEmail: target.email`, `metadata: { from: target.role, to: requestedRole }`. `target` is
    already in scope from the `findMemberByUserId` call the outrank guard uses — reuse it, do not
    re-query.
  - `DELETE /v1/members/:userId` success → `member.removed`, `targetUserId`,
    `targetEmail: target.email`, `metadata: { role: target.role, sessionsRevoked, keysRevoked }`
    using the counts `revokeAllSessions`/`revokeAllApiKeys` already return.
- **PATTERN**: the file's own `withOrg(app.db, principal.orgId, principal.role, async (tx) => …)`
  shape — pass the **`tx`**, never `app.db`, or the audit row commits separately from the action it
  claims to describe.
- **IMPORTS**: add `recordAuditEvent` to the existing `@420ai/db` import block.
- **GOTCHA**: audit on success only. The `"already_member"` / `"user_exists"` / `"pending"` /
  `"outranked"` / `"not_a_member"` branches are refusals, and a refusal is not an event — auditing
  them would make the table a request log and bury the ten actions that matter.
- **GOTCHA**: `principal.email` is the `actorEmail`. It is already on the `Principal`
  (`principal.ts:19`), so no extra read is needed.
- **VALIDATE**: `npm run typecheck && npx vitest run apps/ingest/src/identity.int.test.ts`

### 10. ADD `DELETE /v1/members/:userId/mfa` to `apps/ingest/src/routes/members.ts`

- **IMPLEMENT**: the admin MFA reset 15.8 parked here. In order: `resolvePrincipal` → 401;
  `authorized(principal, "admin")` → 403; `isUuid` → 400; then inside
  `withOrg(app.db, principal.orgId, principal.role, …)`: `findMemberByUserId` → 404 if absent;
  `outranks(principal.role, target.role)` → 403; then `clearMfa(tx, userId)`,
  `revokeAllSessions(tx, userId)`, and `recordAuditEvent(tx, { action: "member.mfa_reset", … })`.
  Return **204**.
- **PATTERN**: the `DELETE /v1/members/:userId` handler immediately above it — same guard ladder,
  same `withOrg`, same outcome-discriminant style (`"not_a_member"` / `"outranked"` consts returned
  out of the callback and mapped to statuses after it).
- **IMPORTS**: `clearMfa` from `@420ai/db` (verified present at
  `packages/db/src/repositories/mfa.ts:277`); `revokeAllSessions` is already imported by this file.
- **GOTCHA**: **the outrank floor is mandatory here, and is the reason 15.8 refused to ship this
  route.** Without it, an `admin` strips an `owner`'s second factor and then — if they also hold or
  can reset that owner's password — owns the account. `outranks` allows EQUAL rank on purpose
  (`hasRole` is `>=`), so a co-owner can help a co-owner.
- **GOTCHA**: revoking sessions is not optional. Clearing MFA without it leaves any session the
  target had already established alive, so an attacker who had a session keeps it *and* has now had
  the second factor removed — strictly worse than doing nothing.
- **GOTCHA**: this route deliberately has **no** self-service equivalent and does **not** let an
  admin reset their own MFA by passing their own id — that path exists already as
  `DELETE /v1/auth/mfa` with the 15.8 re-auth gate. Nothing prevents `userId === principal.userId`
  here and nothing needs to: `outranks` permits equal rank, and the action is audited either way.
- **VALIDATE**: `npm run typecheck` (exit 0); behaviour is asserted in Task 22.

### 11. UPDATE `apps/ingest/src/routes/api-keys.ts` — audit mint/revoke, fix two comments

- **IMPLEMENT**: four changes.
  1. Mint success → `recordAuditEvent` **inside** the existing `app.db.transaction(...)` that wraps
     `mintApiKey`, action `api_key.minted`, `metadata: { keyName: request.body.name, role:
     requestedRole ?? null, expiresAt: expiresAt?.toISOString() ?? null }`. Target is the actor
     themselves — set `targetUserId: principal.userId`, `targetEmail: principal.email`.
  2. `DELETE /v1/auth/api-keys/:id` success → `api_key.revoked`, `metadata: { keyId }`. This handler
     currently calls `revokeApiKey(app.db, …)` with no transaction; wrap the revoke and the audit in
     one `app.db.transaction(...)` so they commit together.
  3. `DELETE /v1/auth/api-keys` success → `api_key.revoked_all`, `metadata: { revoked }`. Same
     transactional treatment. **Audit even when `revoked === 0`** — "I pressed the panic button and
     there was nothing to kill" is a real, meaningful event on an incident timeline.
  4. Replace line 27's forward-looking `15.10 note` with a statement of what shipped, and delete
     `MAX_API_KEYS_PER_USER`'s "Revisit with real data at 15.10" sentence per **D-15.10-5**, keeping
     the "judgement, not a measurement" framing and stating that the revisit did not happen because
     the data still does not exist.
- **PATTERN**: the existing `app.db.transaction((tx) => mintApiKey(tx, …))` at line 128.
- **GOTCHA**: `api_keys` has no `org_id`, but the **audit row does** — use `principal.orgId`. An
  audit event is an act *within an org* even when the object it acts on is org-less. This is the one
  place a reviewer will expect `withOrg` and be wrong: the transaction is for atomicity, and the
  append-only policy needs no context (SPIKE check 1).
- **GOTCHA**: never put `minted.token` or any hash in `metadata`.
- **VALIDATE**: `npm run typecheck && npx vitest run apps/ingest/src/api-keys.int.test.ts`

### 12. UPDATE `apps/ingest/src/routes/auth.ts` and `sso.ts` — audit `member.joined`

- **IMPLEMENT**: in `POST /v1/auth/invites/accept`, inside the existing
  `app.db.transaction(async (tx) => …)` that creates the user and accepts the invite, add
  `recordAuditEvent(tx, { orgId: invite.orgId, actorUserId: id, actorEmail: invite.email, action:
  "member.joined", targetUserId: id, targetEmail: invite.email, metadata: { role: invite.role } })`.
  Do the same on `sso.ts`'s invite-acceptance path.
- **PATTERN**: `auth.ts:320-324` — note the comment explaining that the new user's id is *returned
  out of* the callback rather than assigned to an outer `let`; your audit call goes inside the
  callback where `id` is in scope, which needs no change to that shape.
- **GOTCHA**: **the actor and the target are the same person here**, and that is correct rather than
  redundant — an invite is *redeemed* by its recipient. Set both so a query for "everything that
  happened to this user" and "everything this user did" both return the join.
- **GOTCHA**: `sso.ts` is on `ALLOWED_WITHOUT_WITHORG`; adding an audit write does not change that
  (see Task 13), but you must not "fix" it by introducing `withOrg` — the invite lookup is what
  discovers the org, so a wrapped call would read zero rows.
- **VALIDATE**: `npx vitest run apps/ingest/src/identity.int.test.ts apps/ingest/src/sso.int.test.ts`

### 13. UPDATE `apps/ingest/src/routes/org-scoping.test.ts` — refresh three allow-list reasons

- **IMPLEMENT**: `api-keys.ts`, `mfa.ts` and `sso.ts`'s `ALLOWED_WITHOUT_WITHORG` entries currently
  end with claims like _"touch no tenant table at all"_ and _"there is no policy for `withOrg` to
  activate"_. After Tasks 11–12 those files write `audit_events`, which **does** carry `org_id` and
  **does** carry a policy. Extend each reason to name `audit_events` and state that its append-only
  policy is unconditional, so an org context is not required for the insert to succeed.
- **PATTERN**: the file's own precedent at lines 48-57, where 15.6 **extended** `auth.ts`'s reason
  rather than leaving it to under-describe the file, and the note at lines 90-96 explaining that a
  stale justification is worse than a missing one because the "no stale entries" test only catches a
  file that no longer *exists*.
- **GOTCHA**: also update each file's **own header comment** — the
  `"every allow-listed file explains itself in its own source"` test (line 149) requires the reason
  to live where the next reader is. It only greps for `/M15 15\.3/`, so it will not catch a stale
  *wording*; that is precisely why this task is explicit.
- **VALIDATE**: `npx vitest run apps/ingest/src/routes/org-scoping.test.ts`

### 14. ADD the org body schema to `apps/ingest/src/schemas.ts`

- **IMPLEMENT**: `patchOrgBodySchema` — `{ name: string, minLength: 1, maxLength: 200 }`, required,
  `additionalProperties: false`.
- **PATTERN**: `patchMemberRoleBodySchema` / `inviteMemberBodySchema` in the same file.
- **GOTCHA**: match the file's existing style for length bounds; an unbounded `name` is a row the
  break-glass operator has to page through.
- **VALIDATE**: `npm run typecheck` (exit 0)

### 15. CREATE `apps/ingest/src/routes/org.ts` and register it

- **IMPLEMENT**: two handlers, both `withOrg`-wrapped with `principal.role`.
  - `GET /v1/org` — gate `viewer`. Returns `{ id, name, isPersonal, memberCount, yourRole }`.
    `name`/`isPersonal` from a new `getOrg(db, orgId)` (Task 16); `memberCount` from
    `listMembers(tx, orgId).length`; `yourRole` is `principal.role`.
  - `PATCH /v1/org` — gate **`owner`**. Renames via `renameOrg` (Task 16), audits `org.renamed` with
    `metadata: { from, to }` in the same transaction, returns `200 { org }`.
- **PATTERN**: `apps/ingest/src/routes/members.ts` — identical guard ladder and `withOrg` usage. The
  header comment must carry the same "why `withOrg` here at all, given `organizations`/`memberships`
  carry no RLS" argument members.ts:56-70 makes: the explicit `orgId` predicate is the only tenancy
  boundary, and wrapping keeps the read-then-write atomic.
- **IMPORTS**: `resolvePrincipal, authorized` from `../auth.js`; `withOrg, listMembers, getOrg,
  renameOrg, recordAuditEvent` from `@420ai/db`; `patchOrgBodySchema` from `../schemas.js`.
- **GOTCHA**: register in `apps/ingest/src/app.ts` beside `app.register(memberRoutes)` — a route
  file that is never registered typechecks perfectly and serves 404s.
- **GOTCHA**: **`owner`, not `admin`, for the rename.** Renaming the org is the most org-level act
  available and there is no undo surface; `admin` is the rung that manages *people*.
- **GOTCHA**: `memberCount` is what the dashboard uses to satisfy D-M15-10 (render no org surface
  until a second member exists), so it must count **memberships**, not invites — a pending invite is
  not a colleague yet.
- **VALIDATE**: `npm run typecheck && npx vitest run apps/ingest/src/routes/org-scoping.test.ts`
  (the new file must pass the withOrg + role-gate checks with **no** allow-list entry)

### 16. ADD `getOrg` and `renameOrg` to `packages/db/src/repositories/organizations.ts`

- **IMPLEMENT**:
  - `getOrg(db, orgId): Promise<{ id, name, isPersonal } | undefined>` — explicit column list.
  - `renameOrg(db, orgId, name): Promise<{ id, name, isPersonal } | undefined>` —
    `update(organizations).set({ name }).where(eq(organizations.id, orgId)).returning(<explicit>)`.
- **PATTERN**: `getOrgName` (organizations.ts:99) for the read; `setMemberRole`
  (members.ts:153) for an update-returning shape.
- **GOTCHA**: **explicit column lists on the `returning()`**, per CLAUDE.md's 15.1 rule — no ingest
  route declares a Fastify `response` schema, so a bare `returning()` puts every future
  `organizations` column on the wire the day one is added.
- **GOTCHA**: `renameOrg` keeps `is_personal` untouched. An org that was auto-created for one user
  and has since grown a second member is still flagged personal, and **that is fine** — the flag
  records provenance (which row the 15.1 backfill seeded), not current shape. Do not clear it here;
  the dashboard branches on `memberCount`, never on `isPersonal`.
- **GOTCHA**: no `orgId` predicate is "missing" — `orgId` **is** the key, and it comes from
  `principal.orgId`, never from a request body. Do not add a route parameter for it; a rename
  endpoint that accepts a target org id is a cross-tenant write waiting to happen.
- **VALIDATE**: `npm run typecheck` (exit 0)

---

### 17. CREATE the authenticated proxy route handlers

- **IMPLEMENT**: nine files, each `export const dynamic = "force-dynamic"` plus one `proxyJson()`
  call per method:
  | File | Methods → ingest path |
  | --- | --- |
  | `app/api/members/route.ts` | GET → `/v1/members` |
  | `app/api/members/invite/route.ts` | POST → `/v1/members/invite` |
  | `app/api/members/[userId]/route.ts` | PATCH, DELETE → `/v1/members/:userId` |
  | `app/api/members/[userId]/mfa/route.ts` | DELETE → `/v1/members/:userId/mfa` |
  | `app/api/invites/route.ts` | GET → `/v1/invites` |
  | `app/api/invites/[id]/route.ts` | DELETE → `/v1/invites/:id` |
  | `app/api/org/route.ts` | GET, PATCH → `/v1/org` |
  | `app/api/auth/api-keys/route.ts` | GET, POST, DELETE → `/v1/auth/api-keys` |
  | `app/api/auth/api-keys/[id]/route.ts` | DELETE → `/v1/auth/api-keys/:id` |
- **PATTERN**: `app/api/catalog/[id]/approve/route.ts` (a parameterized mutating proxy) and
  `app/api/projects/[id]/route.ts`. Copy the `params` handling exactly.
- **GOTCHA**: in this Next version route `params` is a **Promise** — `const { userId } = await
  params;`. The existing dynamic proxies already do this; mirror them rather than writing it from
  memory.
- **GOTCHA**: forward the request body with `await req.text()` and
  `contentType: "application/json"`, never a re-serialized `await req.json()` — `proxyJson`'s
  signature takes a `body`/`contentType` pair for exactly this.
- **GOTCHA**: `proxyJson` already forwards the upstream status verbatim, so **do not** collapse 403
  to 500 or add retry logic. The UI depends on seeing 401/403/404/409 distinctly.
- **VALIDATE**: `npm run typecheck:dashboard` (exit 0)

### 18. CREATE the two PUBLIC invite proxy route handlers

- **IMPLEMENT**:
  - `app/api/auth/invites/[token]/route.ts` — GET, forwarding to
    `${ingestUrl()}/v1/auth/invites/${token}` **with no auth header at all**. Forward the upstream
    status (410 with its `reason` matters to the UI).
  - `app/api/auth/invites/accept/route.ts` — POST, forwarding `{token, password}`; on 200 the
    upstream returns `{token, expiresAt}`, so **set the session cookie here** exactly as the login
    route does, then return `{ ok: true }`.
- **PATTERN**: `app/api/auth/login/route.ts` — copy it nearly verbatim for the accept route,
  including the **`sessionConfigError()` guard first** and the cookie options at lines 64-70.
- **GOTCHA**: **these two must NOT use `proxyJson`/`adminHeaders()`.** `adminHeaders()` reads the
  session cookie, and the caller of these routes has no session — that is the whole point. Attaching
  a bearer here would be meaningless at best; call `fetch` directly like the login route does.
- **GOTCHA**: **the `/api/auth/` prefix is load-bearing, not cosmetic.** `middleware.ts:27` exempts
  `pathname.startsWith("/api/auth/")` from the session gate. Placing these anywhere else (e.g.
  `/api/invites/accept`) makes the middleware redirect the unauthenticated POST to `/login` and the
  invite flow fails with no useful error.
- **GOTCHA**: there is **no MFA branch** to handle. A user who has just been created cannot have a
  second factor, and ingest calls `mintSession` not `mintSessionOrChallenge` (`auth.ts:329`), so the
  response is always `{token, expiresAt}`. Do not copy login's `"mfaRequired" in payload` branch.
- **VALIDATE**: `npm run typecheck:dashboard` (exit 0); end-to-end in Task 24.

### 19. UPDATE `apps/dashboard/src/middleware.ts` — make `/invite/<token>` public

- **IMPLEMENT**: add a prefix branch beside the exact-match check:

  ```ts
  const PUBLIC_PREFIXES = ["/invite/"];
  // …
  if (
    PUBLIC.some((p) => pathname === p) ||
    PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith("/api/auth/")
  ) {
    return NextResponse.next();
  }
  ```

- **PATTERN**: the existing `PUBLIC` array and its comment.
- **GOTCHA**: **this is the single most likely thing to be missed, and it fails in a way that looks
  like a backend bug.** `PUBLIC` matches by `pathname === p` — the comment at lines 14-21 exists
  because `/login/mfa` was already caught by this exact trap. A dynamic path can never equal a
  static entry, so without a prefix branch every invited colleague is redirected to
  `/login?next=/invite/<token>` — a login page they have no account for, with their one-time token
  sitting in the query string of a URL they cannot use.
- **GOTCHA**: keep the exact-match array for `/login` and `/login/mfa`. Do not convert those to
  prefixes: `/login/` as a prefix would expose any future nested login route unreviewed.
- **VALIDATE**: `npx vitest run apps/dashboard` — and add a unit test asserting
  `/invite/abc123` is public while `/invitex` and `/invite` are **not**.

### 20. UPDATE `apps/dashboard/src/components/app-nav.tsx`

- **IMPLEMENT**: two changes.
  1. Add `{ href: "/team", label: "Team" }` to `LINKS`, after `/machines`.
  2. Treat `/invite/<token>` as unauthenticated so the page renders no nav:
     `const unauthenticated = UNAUTHENTICATED_PATHS.includes(pathname) ||
     pathname.startsWith("/invite/");`
- **PATTERN**: the file's own `UNAUTHENTICATED_PATHS` comment at lines 29-38.
- **GOTCHA**: **the same exact-equality trap as GOTCHA-1, in a second file** — and the comment at
  lines 29-38 documents the precedent: when `/login/mfa` was added, the nav rendered the full
  authenticated chrome (Monitor, Settings, **Logout**) to a visitor with no session, and every link
  bounced to `/login`. That was found by comparing screenshots, not by a test. `/invite/` would
  reproduce it exactly.
- **GOTCHA**: the nav also probes `/api/auth/me`. Guarding on `unauthenticated` (as the existing
  code does) is what stops an invite visitor firing a 401 request on page load.
- **VALIDATE**: `npm run build:dashboard` (exit 0) + the Task-24 screenshot.

### 21. CREATE the three surfaces

- **IMPLEMENT**:
  - **`app/invite/[token]/page.tsx`** — a Server Component that fetches the preview server-side
    (mirroring `settings/page.tsx`'s local `getJson`, but hitting
    `/v1/auth/invites/${token}` with **no** `adminHeaders()`), and renders either
    `<InviteAcceptForm/>` with `{email, role, orgName, expiresAt}` or a terminal "this invitation is
    no longer valid" state on a 410 that names the `reason`.
  - **`components/invite/invite-accept-form.tsx`** — a client island: the email shown read-only, a
    password + confirm field, POST to `/api/auth/invites/accept`, then
    `window.location.href = "/monitor"` on success. Handle 409 ("an account already exists for this
    address — ask your admin to add you instead"), 410 (expired mid-flight), 429 (rate limited).
  - **`app/team/page.tsx` + `components/team/team-view.tsx`** — the members table
    (`email · role · joined`), the pending-invites table, and the mutations. Fetch `/api/members`
    and `/api/org` server-side; the island fetches `/api/invites` itself because a `viewer` gets a
    **403** there and the page must still render.
  - **`components/settings/api-keys-card.tsx`** — list / mint / revoke / revoke-all, rendered from
    `settings-view.tsx` beside `<MfaCard/>`.
  - **`components/settings/org-card.tsx`** — org name, member count, your role, and (for an
    `owner`) a rename field. **Returns `null` when `memberCount <= 1`.**
- **PATTERN**: `sso-links.tsx` for every island; `machines-view.tsx` + `ui/table.tsx` for a data
  table; `mfa-card.tsx` for the once-only secret.
- **GOTCHA**: **`<OrgCard/>` returning `null` for a solo org is D-M15-10, the milestone's
  zero-friction promise** — "a single user never sees an org". Gate on `memberCount`, not on
  `isPersonal` (Task 16 explains why the flag records provenance, not shape).
- **GOTCHA**: **the minted API key plaintext appears exactly once.** Hold it in island state, show
  it with a copy affordance, say in the UI that it will never be shown again, and never re-fetch —
  `GET /v1/auth/api-keys` deliberately omits it. `mfa-card.tsx`'s recovery-codes block is the
  pattern.
- **GOTCHA**: **the mint re-auth branch.** POST without a password first; on **401** read
  `reason` — `"password_required"` ⇒ reveal a password field and retry;
  `"reauth_required"` ⇒ "Sign in again before creating an API key" (the SSO-only account has no
  password to offer). Hold the password only for the duration of the request and clear it in a
  `finally`, as `mfa-card.tsx:52-57` does.
- **GOTCHA**: a `viewer` on `/team` must see the roster and **no** controls, and must not see a
  broken invites panel. Use `yourRole` from `/api/org` to decide what to render, and treat a 403
  from `/api/invites` as "no panel", not as an error. The server is still the gate — the UI hiding a
  button is courtesy, never enforcement.
- **GOTCHA**: **never render an org id, user id, or any token in visible copy.** Ids belong in
  `key=` props and request paths.
- **VALIDATE**: `npm run typecheck:dashboard && npm run build:dashboard` (both exit 0)

---

### 22. CREATE `packages/db/src/repositories/audit.int.test.ts` — the append-only proof

- **IMPLEMENT**: a **two-role** suite. First test asserts role identity
  (`current_setting('is_superuser') = 'off'` AND `rolbypassrls = false` for the app handle) — without
  it the whole file is theatre. Then, on the **app** handle:
  1. `recordAuditEvent` succeeds with **no** org context set;
  2. it succeeds inside `withOrg(..., "viewer", ...)` — the `viewer` role does not block it;
  3. a raw `select` returns **0 rows**, and still 0 with a matching org context set;
  4. `UPDATE` and `DELETE` are rejected (the `REVOKE` makes them a permission error);
  5. on the **owner** handle, every row inserted above is visible (break-glass intact).
- **PATTERN**: `packages/db/src/repositories/rls.int.test.ts` lines 175-215 for the two-handle
  setup, the `TRUNCATE … CASCADE` on the owner handle only, and `await`ing **both** pools in
  `afterAll` (or vitest hangs on an open handle).
- **GOTCHA**: these five assertions are the spike, re-expressed as a regression test. Run them
  against a build where the policy is replaced with `USING (true)` / `FOR ALL` and confirm 3 and 4
  **fail** — a negative test nobody has watched fail is not evidence (CLAUDE.md).
- **GOTCHA**: assertion 4's failure mode differs by layer: with the `REVOKE` in place it is a loud
  `permission denied`; with the grant restored but the policy absent it is a **silent 0-row
  no-op**. Assert on the row surviving (read back as owner), not only on the error, so the test
  holds either way.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/audit.int.test.ts` — must report
  **0 skipped**.

### 23. UPDATE `packages/db/src/repositories/rls.int.test.ts` — the fifth classification

- **IMPLEMENT**: add `const APPEND_ONLY_TABLES = ["audit_events"] as const;` with a comment
  explaining why it is neither strict, nor bootstrap, nor role-gated, nor no-policy. Then in the
  `pg_policies` inventory test: the permissive expectation becomes
  `STRICT + BOOTSTRAP + ROLE_GATED + APPEND_ONLY`; assert `audit_events`' single policy is
  `cmd === "INSERT"`, `with_check === "true"`, `qual === null`; assert it appears in **no** other
  classification; assert it carries **no** RESTRICTIVE policy; and assert
  `relforcerowsecurity = false` for it specifically.
- **PATTERN**: the `ROLE_GATED_BOOTSTRAP_TABLES` precedent at lines 117-133 — a new classification
  gets its **own constant** rather than being forced into an existing list, precisely because the
  inventory test asserts a different expectation for each.
- **GOTCHA**: **do not simply bump a number.** Read lines 472-478 first: the earlier keying on
  `tablename` alone collapsed four rows per table into one and stayed green at `size === 15` while
  meaning nothing. Every count here is **derived from list lengths** — add the constant and let the
  arithmetic follow. If you find yourself editing a literal integer, stop.
- **GOTCHA**: the "all 17 tenant tables" count elsewhere in the file must **stay 17**.
  `audit_events` is not a tenant table in that sense: nothing reads it per-tenant. Say so in the
  comment, as 15.6/15.7/15.8/15.9 each did for `NO_RLS_TABLES`.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/rls.int.test.ts` — 0 skipped.

### 24. CREATE `apps/ingest/src/audit.int.test.ts` and `apps/ingest/src/org.int.test.ts`

- **IMPLEMENT**: HTTP-level, driving `buildApp` in-process with keys from `seedBootstrapKey`.
  - **`audit.int.test.ts`** — for each of the ten actions, drive the real endpoint and assert
    (reading back on the **owner** handle) that exactly **one** row exists with the right `action`,
    `actor_user_id`, `actor_email`, `target_email` and `metadata`. Plus three discriminating cases:
    (a) a **refused** mutation (403 outranked, 409 already-member) writes **zero** rows;
    (b) a **`viewer`** revoking their own API key **does** produce a row — the assertion that proves
    no role policy blocks the append; (c) `member.removed` records the session and key revoke counts.
  - **`org.int.test.ts`** — `GET /v1/org` at `viewer` returns the right `memberCount`;
    `PATCH /v1/org` is **403 for `admin`** and 200 for `owner`; the rename is audited; a
    cross-org rename is impossible (there is no parameter for it).
- **PATTERN**: `apps/ingest/src/rbac.int.test.ts` for a multi-role HTTP fixture;
  `apps/ingest/src/api-keys.int.test.ts` for `seedBootstrapKey` usage.
- **GOTCHA**: seed the second, non-owner principal by **MOVING** the existing membership, never by
  INSERTing a second one. `setUserPassword` auto-creates a personal `owner` membership via
  `ensurePersonalOrg`, and `findPrincipalByEmail` resolves the **first** membership by
  `(created_at, id)` — so an INSERTed second membership is silently shadowed and every "admin
  cannot do X" assertion would in fact be testing an owner. This is a CLAUDE.md lesson from 15.4.
- **GOTCHA**: read audit rows back on the **owner** handle. The app role reads zero rows by design,
  so an assertion made through the app handle passes vacuously — which would make this entire suite
  the "green and enforcing nothing" shape the repo has been burned by three times.
- **GOTCHA**: call `seedBootstrapKey` in `beforeEach` **after** the TRUNCATE.
- **VALIDATE**: `npx vitest run apps/ingest/src/audit.int.test.ts apps/ingest/src/org.int.test.ts`
  — 0 skipped.

---

### 25. UPDATE the eleven multi-org comments (D-15.10-1)

- **IMPLEMENT**: repoint every "15.10 will do multi-org" claim to **M16**, and reword each so it
  states the decision rather than a schedule. The exact sites:
  | File:line | Current claim |
  | --- | --- |
  | `packages/db/src/schema.ts:68` | "15.10 needs multi-org users" |
  | `packages/db/src/repositories/organizations.ts:41` | same |
  | `packages/db/src/repositories/principal.ts:39` | "possible by design — 15.10 needs it" |
  | `packages/db/src/repositories/principal.ts:79` | "A user may hold two memberships by design (15.10 needs it)" |
  | `packages/db/src/repositories/members.ts:149,180` | "other orgs (15.10)" |
  | `packages/db/src/repositories/api-keys.ts:359` | "the 15.10 revisit note" |
  | `apps/ingest/src/routes/members.ts:117` | "Multi-org membership + an org switcher is 15.10." |
  | `apps/ingest/src/routes/members.ts:318-342` | the two "REVISIT AT 15.10" blocks |
  | `apps/ingest/src/routes/pairing-codes.ts:59` | "wrong the moment 15.10 gives one user two memberships" |
  | `apps/ingest/src/routes/members.ts:161`, `apps/ingest/src/routes/auth.ts:306` | the 409 **response body**: `"user already exists — multi-org membership lands in 15.10"` |
  Also `apps/ingest/src/sessions.int.test.ts:518,524` and
  `apps/ingest/src/api-keys.int.test.ts:505`, and
  `packages/db/src/repositories/principal.int.test.ts:138`,
  `packages/db/src/repositories/members.int.test.ts:255`.
- **PATTERN**: `org-scoping.test.ts:90-96` — when 15.5 invalidated an entry it **deleted** rather
  than re-worded it, because a stale justification is a hole the next reader widens. Here the claims
  remain true in substance (nothing constrains one-membership-per-user; the revoke semantics do
  invert under multi-org) — only the *milestone* is wrong, so reword rather than delete.
- **GOTCHA**: the two 409 strings are **user-facing API responses**, not comments. Changing them
  changes the wire contract's prose; check whether any test asserts on the message text and update
  it in the same commit. Prefer wording that does not name a milestone at all —
  `"user already exists — a user may belong to only one organization"` — since the next reader of a
  409 body is an API consumer, not a maintainer.
- **VALIDATE**:
  `grep -rn "15\.10" apps/*/src packages/*/src` — every surviving hit must be a *statement about
  what 15.10 shipped*, never a promise about what it will ship. Then `npm run repo-health`.

### 26. UPDATE the two stale desktop strings

- **IMPLEMENT**: `apps/desktop/src-tauri/src/proxy.rs:51-53` and
  `apps/desktop/src/components/Settings.tsx:304` both tell the user there is no management UI. Point
  them at `/settings` on the dashboard instead.
- **PATTERN**: keep the existing message shape; only the remedy clause changes.
- **GOTCHA**: `proxy.rs` is **Rust** — it does not typecheck under `tsc`. Verify with
  `cd apps/desktop && cargo check` (or at minimum confirm the string literal's escaping is intact;
  the current line uses a `\` continuation).
- **GOTCHA**: this is the only Rust in the slice. Do not attempt a full `cargo tauri build`.
- **VALIDATE**: `npm run typecheck:desktop` (exit 0) + `cargo check` in `apps/desktop`

### 27. UPDATE the docs

- **IMPLEMENT**:
  - **`CLAUDE.md`** — add the append-only lesson to the Drizzle/SQL section: an audit-style table
    whose writers straddle the org-context boundary cannot use a strict policy (with the SPIKE-8
    control named), and `REVOKE UPDATE, DELETE` is what turns a silent 0-row no-op into a loud
    permission error. Also record that a **denormalized** actor/target email on an audit row is
    deliberate, because the only reader is break-glass `psql`.
  - **`docs/guide/operations.md`** — a new "Reading the audit log" section: it is readable **only**
    as the owner (`DATABASE_URL`), with the exact `psql` query; state that the app role appends and
    can do nothing else, and that rolling migration `00XX` back destroys the history irrecoverably.
    Update line 774's "the audit trail 15.10's audit table will provide" and line 978's "Both land in
    15.10" to describe what shipped.
  - **`SUMMARY.md`** — flip **15.10** to `✅` with `DONE <date> (PR #NN)` in **both** the §0 status
    block and the §6 roadmap, record **D-15.10-1** (multi-org → M16) as a correction, and set the
    **M15 milestone status line to DONE** — 15.10 is the last open slice.
  - **`.agents/plans/m15-multi-user-access-control.md`** — amend the 15.10 row to match what
    shipped, and add multi-org to the non-goals with its M16 pointer.
- **PATTERN**: the existing per-slice SUMMARY entries — dense, decision-first, naming what was
  measured rather than what was intended.
- **GOTCHA**: `scripts/check-summary.mjs` **fails the gate** if an execution report exists for a
  slice that is not marked done in `SUMMARY.md`. Update SUMMARY in the **same commit** as the
  execution report, per CLAUDE.md.
- **GOTCHA**: CI runs `format:check` over Markdown but local `repo-health` does not — run
  `npm run format` before pushing.
- **VALIDATE**: `npm run repo-health` (exit 0) then `npm run format:check`

---

## TESTING STRATEGY

### Unit Tests (always run, no infra)

- `packages/shared/src/audit.test.ts` — the closed set is unique, sorted, and well-formed.
- `packages/db/src/repositories/audit.test.ts` — the D-15.10-4 write-only structural guard.
- `apps/dashboard/src/middleware.test.ts` (extend or create) — `/invite/<token>` is public while
  `/invite` and `/invitex` are not. This is the cheapest possible guard on GOTCHA-1, which is the
  single highest-risk line in the slice.
- `apps/ingest/src/routes/org-scoping.test.ts` — the new `org.ts` passes with **no** allow-list
  entry; the three refreshed reasons still match their files.

### Integration Tests (`*.int.test.ts`, two-role where tenancy is involved)

- `packages/db/src/repositories/audit.int.test.ts` — the five append-only assertions (Task 22).
- `packages/db/src/repositories/rls.int.test.ts` — the extended inventory (Task 23).
- `apps/ingest/src/audit.int.test.ts` — every action, plus the three discriminating cases (Task 24).
- `apps/ingest/src/org.int.test.ts` — org read/rename gating (Task 24).
- The existing `identity.int.test.ts`, `api-keys.int.test.ts`, `sso.int.test.ts`,
  `sessions.int.test.ts` and `rbac.int.test.ts` must stay green — audit writes are additive but they
  are now **inside** those paths' transactions (D-15.10-3), so a mistake there fails an existing
  suite rather than a new one. That is deliberate.

### Edge Cases That Must Be Tested

1. An audit insert from a route with **no org context** (`api-keys.ts`) — succeeds. _The design's
   central claim._
2. An audit insert by a **`viewer`** — succeeds. _No role policy blocks the append._
3. A **refused** mutation writes **zero** audit rows.
4. `api_key.revoked_all` with `revoked === 0` — still audited.
5. `member.invited` for an address with **no `users` row** — `target_user_id IS NULL`,
   `target_email` set. _The case a normalized-only schema could not record._
6. The app role's `SELECT` on `audit_events` returns 0 rows **with a matching org context set**.
7. The app role's `UPDATE`/`DELETE` fails **and the row survives** (verified as owner).
8. An `admin` attempting `DELETE /v1/members/:owner/mfa` → **403**, no MFA cleared, no audit row.
9. An `admin` attempting `PATCH /v1/org` → **403**.
10. `/invite/<token>` reachable with **no session cookie**; `/team` is **not**.
11. An expired/revoked/accepted token on the invite page → a terminal 410 state, not a crash.
12. Accepting an invite for an email that already has an account → 409 with actionable copy.
13. A solo org renders **no** `<OrgCard/>`; a two-member org renders it.
14. `next build` succeeds — the only gate that catches a broken theGridCN/barrel import or a
    `node:crypto` import leaking into the Edge middleware graph.

---

## VALIDATION COMMANDS

Every command runs from the **repo root**.

### Level 1: Syntax, Style & Types

```bash
npm run typecheck            # root tsc -b — MUST exit 0 (the four backend workspaces)
npm run typecheck:dashboard  # tsc --noEmit — the root build NEVER catches dashboard errors
npm run typecheck:desktop
npm run lint                 # ESLint — NOT part of repo-health; CI runs it
npm run format:check         # CI lints Markdown; local repo-health does not
```

### Level 2: Unit Tests

```bash
npx vitest run packages/shared/src/audit.test.ts
npx vitest run packages/db/src/repositories/audit.test.ts
npx vitest run apps/ingest/src/routes/org-scoping.test.ts
npx vitest run apps/dashboard
```

Pass signal: exit 0, every file reporting `passed`.

### Level 3: Integration Tests — the DB layer must actually RUN

```bash
npm run db:up && npm run db:migrate
# The test database is migrated SEPARATELY from the dev database.
npx vitest run packages/db/src/repositories/audit.int.test.ts \
               packages/db/src/repositories/rls.int.test.ts \
               apps/ingest/src/audit.int.test.ts \
               apps/ingest/src/org.int.test.ts
```

Pass signal: exit 0 with **0 skipped**. A skipped integration layer still reports green —
`skipped ≠ passed`.

### The gate

```bash
npm run repo-health -- --require-db
```

Pass signal: exit 0. `--require-db` **fails** if `DATABASE_URL_TEST` is unconfigured or if any
`*.int.test.ts` self-skipped, and it checks `DATABASE_URL_TEST_APP` (the non-owner role) before it
runs vitest — `bypassed ≠ enforced`.

```bash
npm run build:dashboard      # next build — gates milestone sign-off
npm run db:rollback && npm run db:migrate   # the down/ SQL round-trips
```

### Level 4: Manual Validation

Run ingest + dashboard, then walk the flow that has never worked:

```bash
npm run ingest:dev
npm run dashboard:dev   # needs SESSION_SECRET + INGEST_URL in apps/dashboard/.env.local
```

1. Log in as the bootstrap owner → `/team` renders with one member and **no** `<OrgCard/>`.
2. Invite `colleague@example.com` as `member`. With no SMTP configured the token comes back in the
   response; with Mailpit running, the **email arrives and its link resolves**.
3. Open `/invite/<token>` **in a fresh private window** — it must render the org name and role with
   **no** nav chrome and **no** redirect to `/login`. _This is the 404 the slice exists to fix._
4. Set a password → land logged in on `/monitor`.
5. Back as the owner: `/team` now shows two members **and** `<OrgCard/>` appears.
6. Change the colleague's role to `admin`, then try to demote the owner **as that admin** → 403 with
   the shared `FORBIDDEN_MESSAGE`.
7. `/settings` → mint an API key (the password prompt appears on the first 401), copy it, confirm it
   is never shown again after dismissal, then `curl` ingest with it.
8. Revoke it → the same `curl` 401s. Confirm an **already-open** `/monitor` SSE stream also drops
   (the 15.9 per-tick re-probe).
9. Reset the colleague's MFA as owner → they are signed out.
10. Rename the org as owner; confirm an `admin` gets 403.
11. **Read the audit log the only way it can be read:**

```bash
docker compose exec -T archive psql -U 420ai -d 420ai -c \
  "select created_at, actor_email, action, target_email, metadata
     from audit_events order by created_at"
```

Expect one row per action above, in order. Then prove the application cannot touch it:

```bash
# As the app role — must fail loudly, and the rows must survive.
psql "$DATABASE_URL_APP" -c "delete from audit_events"      # ERROR: permission denied
psql "$DATABASE_URL_APP" -c "select count(*) from audit_events"  # 0 rows visible
docker compose exec -T archive psql -U 420ai -d 420ai -c "select count(*) from audit_events"  # unchanged
```

12. Screenshot evidence for `/team`, `/invite/<token>` and `/settings` via headless Edge (see
    CLAUDE.md — the gstack browse daemon is unreliable here), and assert
    `grep -c "$SOME_MINTED_KEY" page-source.html` == 0.

---

## ACCEPTANCE CRITERIA

- [ ] `/invite/<token>` renders and redeems with **no session**, and the emailed link works
      end-to-end — the milestone's onboarding path is no longer a 404
- [ ] `/team` lists members and pending invites and performs all four mutations; a `viewer` sees the
      roster and no controls and no broken panel
- [ ] `<ApiKeysCard/>` mints (with the re-auth prompt), lists, revokes one, and revokes all; the
      plaintext is shown exactly once
- [ ] `<OrgCard/>` is **absent** for a solo org and present at two members (D-M15-10)
- [ ] `audit_events` exists with exactly one policy — `PERMISSIVE / INSERT / with_check=true` — and
      `relforcerowsecurity = false`
- [ ] All ten audited actions write exactly one correct row; refusals write none
- [ ] The app role can append, reads **0 rows**, and **cannot** `UPDATE` or `DELETE`; the owner reads
      everything
- [ ] `DELETE /v1/members/:userId/mfa` works, enforces the outrank floor, revokes the target's
      sessions, and is audited
- [ ] `GET`/`PATCH /v1/org` work; rename is `owner`-only and audited
- [ ] `grep -rn "15\.10" apps/*/src packages/*/src` contains **no forward promise** — every hit
      describes what shipped (D-15.10-1)
- [ ] The two 409 bodies no longer name slice 15.10
- [ ] Both stale desktop strings point at the real UI
- [ ] `npm run repo-health -- --require-db` exits 0 with **0 skipped**
- [ ] `npm run build:dashboard`, `npm run lint`, `npm run format:check` all exit 0
- [ ] `db:rollback` → `db:migrate` round-trips
- [ ] `SUMMARY.md` marks 15.10 ✅ in both places and **M15 as DONE**; the milestone plan records
      D-15.10-1
- [ ] The four deferred surfaces (signup, password reset, sessions list, MFA QR) are **stated as
      deferred** in the PR body and SUMMARY, not silently dropped

---

## COMPLETION CHECKLIST

- [ ] All 27 tasks completed in order
- [ ] Each task's validation passed immediately, not deferred to the end
- [ ] Full suite green (unit + integration, 0 skipped) with a live test DB
- [ ] Zero typecheck / lint / format errors across all four typecheck lanes
- [ ] The manual walkthrough completed, including the private-window invite redemption and the
      three-command audit-immutability proof
- [ ] Screenshot evidence captured under `.agents/qa/m15-signoff/`
- [ ] The negative-control run done: policy replaced with `USING (true)`, tests 3 and 4 of
      `audit.int.test.ts` **observed failing**, policy restored
- [ ] Acceptance criteria all met
- [ ] Non-goals named in the PR body (multi-org → M16; no audit viewer; four deferred surfaces)
- [ ] `/lril:code-review` run before commit — it is what catches the long-lived-resource and
      org-scoping classes that `tsc` and tests do not

---

## NOTES

### Spikes actually RUN during planning, and their results

**SPIKE — the `audit_events` RLS shape.** A throwaway script created two candidate tables in the
live `420ai_test` database and drove them through **both** roles (`DATABASE_URL_TEST` owner and
`DATABASE_URL_TEST_APP` → `420ai_app`). **15/15 checks passed.** Verbatim output:

```
PASS  0. app handle is a NON-owner, non-superuser, non-bypassrls role — {"current_user":"420ai_app","su":"off","bypass":false}
PASS  1. app role INSERTs with NO org context set
PASS  1b. app role INSERTs inside withOrg WITH role=viewer (no restrictive policy blocks it)
PASS  2. app role SELECT returns ZERO rows (write-only by construction) — n=0
PASS  2b. ...still zero WITH a matching org context set — n=0
PASS  4. OWNER reads every row (break-glass channel intact) — n=2
PASS  3. app role UPDATE affects ZERO rows (silently) — rowCount=0
PASS  3b. app role DELETE affects ZERO rows (silently) — rowCount=0
PASS  3c. owner confirms both rows SURVIVED the tamper attempt — n=2
PASS  5. after REVOKE, app role UPDATE is a LOUD permission error — permission denied for table spike_audit_events
PASS  5b. after REVOKE, app role DELETE is a LOUD permission error — permission denied for table spike_audit_events
PASS  5c. INSERT still works after the REVOKE
PASS  6. exactly ONE policy: PERMISSIVE / INSERT / with_check=true / qual=null
PASS  7. relrowsecurity=true, relforcerowsecurity=FALSE (owner exemption kept on purpose)
PASS  8. CONTROL: a STRICT org policy REJECTS an audit insert from a route with no org context
        — new row violates row-level security policy for table "spike_audit_strict"
```

Four things this **measured** rather than assumed:

1. **Check 8 is the decisive one** — the negative control. Reusing the repo's 13-table strict
   pattern would have made every `api_key.minted` audit a **500**, because `api-keys.ts` runs
   outside `withOrg` by design. The failure would have appeared during Phase 3 UI work as "minting
   is broken", far from its cause.
2. **Checks 3/3b vs 5/5b** — with the `GRANT` intact, a blocked `UPDATE`/`DELETE` is a **silent
   0-row no-op**; the explicit `REVOKE` turns it into `permission denied`. Both are safe, only one is
   diagnosable, which is why the `REVOKE` is in the migration.
3. **Check 2b** — the app role reads zero rows even **with** a matching org context, confirming it
   is the absent SELECT policy doing the work, not a failing predicate. So "write-only" is a
   database guarantee.
4. **No `GRANT` is needed** — 0015's `ALTER DEFAULT PRIVILEGES` gave the app role INSERT on the new
   table implicitly, re-verified for this table shape.

The throwaway was **deleted** (`git status` clean afterwards).

**Symbols verified by reading their source, not from memory:** `withOrg(db, orgId, role, fn)`
(`org-context.ts` — required 4th param, `Db` not `DbClient`); `resolvePrincipal` / `authorized` /
`isUuid` (`apps/ingest/src/auth.ts:68,300,310`); `requireRecentAuth` and its
`reason: "password_required" | "reauth_required"` 401 contract (`reauth.ts:62,80,90`);
`clearMfa` (`repositories/mfa.ts:277`); `revokeAllSessions` / `revokeAllApiKeys` (imported by
`members.ts:12-13`); `listMembers` / `MemberRow` `{userId,email,role,joinedAt}`
(`repositories/members.ts:40,64`); `ensurePersonalOrg(db, userId, name)` and the absence of any
rename (`repositories/organizations.ts:117` — which is why Task 16 adds one);
`hasRole` / `ROLES` / `SERVICE_ROLE` (`packages/shared/src/roles.ts`); `proxyJson` /
`adminHeaders` (`lib/proxy.ts`, `lib/ingest.ts`); `SESSION_COOKIE` + the exact cookie options
(`lib/session.ts:12`, `api/auth/login/route.ts:64-70`); `FORBIDDEN_MESSAGE`
(`lib/mutation-error.ts`).

**Test harness confirmed to exist:** `seedBootstrapKey(db, email, label?)` at
`apps/ingest/src/test-support/bootstrap-key.ts:34`, with its own instruction to call it in
`beforeEach` after the TRUNCATE. The two-role fixture is
`packages/db/src/repositories/rls.int.test.ts:175-215`. The multi-role HTTP fixture is
`apps/ingest/src/rbac.int.test.ts`.

**Endpoint contracts read, not inferred:** `GET /v1/auth/invites/:token` →
`{email, role, orgName, expiresAt}` / 410+`reason`; `POST /v1/auth/invites/accept` →
`{token, expiresAt}` via `mintSession` (**never** a challenge — `auth.ts:329`);
`serializeApiKey`'s wire shape (`api-keys.ts:252-275`).

### Named gotchas

- **GOTCHA-1 — the middleware's `PUBLIC` matches by EXACT EQUALITY.** `/invite/<token>` can never
  equal a static entry, so without a prefix branch every invited colleague is bounced to
  `/login?next=/invite/<token>`. The file's own comment (lines 14-21) exists because `/login/mfa`
  was already caught by this. **Highest-risk line in the slice**; pinned by a unit test in Task 19.
- **GOTCHA-2 — the same trap again in `app-nav.tsx`** (`UNAUTHENTICATED_PATHS.includes(pathname)`).
  Its comment records that when `/login/mfa` hit this, the nav rendered Monitor/Settings/**Logout**
  to a visitor with no session and every link bounced. Found by screenshot, not by a test.
- **GOTCHA-3 — `FORCE ROW LEVEL SECURITY` is deliberately OMITTED**, against all 13 strict tables.
  FORCE removes the table-**owner** exemption, and the owner is exactly who performs the documented
  break-glass read. It is a no-op today (the owner is also a superuser, a separate exemption) and
  actively harmful the day the owner stops being one — a plausible hardening step. Task 23 asserts
  `relforcerowsecurity = false` **on purpose**, so nobody "completes the pattern" later.
- **GOTCHA-4 — three `ALLOWED_WITHOUT_WITHORG` reasons go stale in this slice.** `api-keys.ts`,
  `mfa.ts` and `sso.ts` currently claim they "touch no tenant table at all". After Tasks 11-12 they
  write `audit_events`. The suite's "no stale entries" test only catches an allow-listed file that
  no longer *exists*, never one whose reason quietly stopped being true.
- **GOTCHA-5 — D-15.10-3 means an audit failure fails the action.** Chosen, not accidental. If a
  reviewer proposes `try/catch`-ing the audit write to "protect" the action, the answer is CLAUDE.md:
  a best-effort/swallow path is the worst place to lose a policy, precisely because it is designed
  not to complain.
- **GOTCHA-6 — no new dependency, in any workspace.** The MFA QR code was the one thing in M15's UI
  backlog that would have needed one, and it is deferred. If a task seems to want a package, it is
  the wrong task.
- **GOTCHA-7 — `db:generate` cannot emit the policy block.** Hand-edit after generating, and never
  re-run `db:generate` expecting the block to survive.
- **GOTCHA-8 — read audit rows back on the OWNER handle in tests.** Through the app handle every
  assertion passes vacuously against zero rows — the exact "green and enforcing nothing" shape this
  repo has been burned by three times.

### Design decisions and trade-offs

- **Why an append-only classification rather than reusing `NO_RLS_TABLES`.** No policy at all would
  also have made every insert work. It would not have made the table **immutable to the
  application**, which is the only property that makes an audit log worth having: a log the app can
  rewrite records what the app chose to admit. The extra cost is one constant and four assertions.
- **Why no viewer.** A viewer needs a strict SELECT policy, per-role read gating (a `member` must
  not read the org's audit log), and pagination — a slice's worth of decisions on top of a surface
  nobody has asked for. Break-glass `psql` is a real read path, and D-M15-7 already establishes it
  as the operator's channel.
- **Why the rename endpoint is in scope at all.** `ensurePersonalOrg` seeds the org name from the
  user's **email address** (`organizations.ts:117-131` — `name` is the caller-supplied email). An
  "Organization" card that displays `sean@example.com` to a colleague with no way to change it is a
  visibly unfinished surface at exactly the moment a second person sees it. One endpoint, one
  repository function, one audit action.
- **Residual risk.** The largest is **volume, not difficulty**: eleven proxy route handlers and five
  components. Each is individually trivial and mirrors an existing file, but `next build` is the
  only thing that catches a barrel or Edge-graph mistake — run it before declaring Phase 3 done,
  not at the end.
- **The parked item that stayed parked.** `MAX_API_KEYS_PER_USER` remains 25 (D-15.10-5). The UI
  lands here, but the promised "real data" still does not exist — one install, one human. Correcting
  the comment is the honest action; changing the number on no evidence would be the dishonest one.

### Confidence

**9.4 / 10** for one-pass success. Earned by: a 15/15 live spike **including a negative control**
that disproved the obvious design; every referenced symbol read at its source; the seed/test harness
confirmed by name and line; two real path-matching traps found and pinned with tests before
implementation; and a scope conflict (multi-org) resolved by decision rather than left for the
executor. The 0.6 deduction is the dashboard's breadth — sixteen new frontend files whose only
integration gate is `next build`.
