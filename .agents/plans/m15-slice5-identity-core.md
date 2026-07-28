# Feature: M15 slice 15.5 — Identity core (user CRUD, invites, password reset, gated self-signup)

The following plan should be complete, but it is important that you validate documentation and
codebase patterns and task sanity before you start implementing.

Pay special attention to naming of existing utils, types and models. Import from the right files.
Every symbol referenced below was read from source during planning; the file:line citations are
exact as of `m15-slice4-rbac` @ `77bf949`.

## Feature Description

15.4 gave an organization a **role ladder**. It did not give it a way to acquire a **second human**.
Today the only way a `users` row is born is a boot-time env seed (`ADMIN_EMAIL`/`ADMIN_PASSWORD`) or
an accidental side effect of `POST /v1/pairing-codes`. There is no invite, no signup, no password
reset, no way to change someone's role, and no way to remove them.

15.5 ships the identity core: **member CRUD**, **invite-by-email** over the M13 13.5 SMTP transport,
**password reset**, **gated self-signup** (D-M15-6), and — the security half — it **closes the
account pre-seeding primitive** (D-M15-8 / audit finding C.9). That closure is why this slice gates
15.7: pre-seeding plus SSO auto-link-by-email is an account-takeover chain, and 15.7 is where the
second link lands.

## User Story

As the **owner of a 420AI deployment**
I want to **invite teammates by email, set and change their roles, remove them, and let them reset
their own passwords**
So that **the org I have been carrying alone since 15.1 can actually hold more than one person —
without me handing out the bootstrap admin password.**

## Problem Statement

1. **No user creation path exists that is fit for purpose.** `ensureUserByEmail` is an idempotent
   upsert used by the boot seed and by tests; `POST /v1/pairing-codes` inlines a *third* `users`
   upsert (`apps/ingest/src/routes/pairing-codes.ts:45-53`) from a caller-supplied
   `body.email`. That is an unauthenticated-in-effect account pre-seeding primitive: any `admin`
   can mint a `users` row for `victim@corp.com`, which under 15.7's SSO link-by-email becomes an
   adopted account. **D-M15-8 requires this be gone before 15.7.**
2. **No membership management.** `memberships` rows are created only by `ensurePersonalOrg`
   (`packages/db/src/repositories/organizations.ts:99-114`), always with role `owner`. There is no
   route that lists, adds, re-roles or removes a member — so the four-rung ladder 15.4 enforces has
   exactly one reachable rung in practice.
3. **No credential lifecycle.** `setUserPassword` is called only from `server.ts:152` with
   `process.env.ADMIN_PASSWORD`. A user cannot change their own password and cannot recover a lost
   one; the only "reset" is the maintainer editing `.env` and restarting.
4. **Emails are case-sensitive.** Confirmed by spike (below): `users.email` is plain `text` with
   `CREATE UNIQUE INDEX users_email_unique ON public.users USING btree (email)`. `Foo@corp.com` and
   `foo@corp.com` are two distinct accounts today. Every path this slice adds (invite, signup,
   reset) keys on email, and 15.7 links identity by email — so shipping them over a case-sensitive
   key would open the second half of the same takeover vector D-M15-8 exists to close.

## Solution Statement

Four additive surfaces plus one deletion:

- **`invites`** — a new org-owned table with the same lifecycle as `pairing_codes` (short-lived,
  single-use, redeemed *before* any org context exists) and therefore the same
  **bootstrap-permissive** org policy, *plus* the 15.4 restrictive role-write backstop (an invite is
  a privilege-granting row; `pairing_codes` is not).
- **`password_reset_tokens`** — a new identity table keyed by `user_id`, carrying **no RLS**, for
  the same reason `users`/`organizations`/`memberships` carry none (D-15.3-4): it is read at the one
  moment before any identity is established.
- **`routes/members.ts`** — principal-authed org member/invite CRUD, `withOrg`-wrapped and
  `authorized()`-gated, with a role-escalation guard and a last-owner guard.
- **`routes/auth.ts` additions** — the unauthenticated identity edge: invite preview/accept, gated
  signup, password-reset request/confirm, plus a session-gated change-own-password.
- **Deletion**: the `users` upsert inside `routes/pairing-codes.ts` (D-M15-8). It is replaced by a
  lookup that resolves an **existing member of the caller's org** and 404s otherwise.

Mail rides on the existing nodemailer transport from 13.5, refactored one level: a new
`delivery/mailer.ts` exposing a plain `Mailer` (`send({to, subject, text})`) built on the *same*
`MailTransport` structural interface `smtp-deliverer.ts` already defines. The `AlertDeliverer`
contract (`deliver(firing)`) cannot carry an invite, so it is reused at the transport level, not the
deliverer level.

## Feature Metadata

**Feature Type**: New Capability (with one security-motivated Removal)
**Estimated Complexity**: **High** (L — largest remaining M15 slice besides 15.7)
**Primary Systems Affected**: `packages/db` (schema + migration 0017 + 3 repositories),
`apps/ingest` (2 route files, mailer, schemas, server env wiring), no dashboard, no collector,
no Rust.
**Dependencies**: none new. `nodemailer@9.0.3` already resolves under `apps/ingest`
(spike output below). No new npm package is introduced by this slice.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — IMPORTANT: YOU MUST READ THESE BEFORE IMPLEMENTING

**Conventions (source of truth — read, do not re-derive):**

- `CLAUDE.md` — the whole file. Especially: *"Validation is a GATE"*, *"bypassed ≠ enforced"*, the
  15.4 block (`setUserPassword` auto-creates a personal `owner` membership — this slice trips over
  that lesson harder than 15.4 did), *"Repository functions whose rows reach `reply.send()` MUST use
  explicit column lists"*, and *"A read keyed by a CONNECTOR-SUPPLIED string MUST take `orgId`"*.
- `.agents/plans/m15-multi-user-access-control.md` — D-M15-4 (roles), **D-M15-6** (self-signup off by
  default), **D-M15-8** (pairing codes must never create users), D-M15-10 (solo stays zero-friction),
  D-M15-12 (sessions become stateful — **in 15.6, not here**).

**Identity + auth (the code you are extending):**

- `apps/ingest/src/routes/auth.ts` (whole file, 62 lines) — Why: the file you add five routes to.
  Note its header explains why it is on the `withOrg` allow-list; your additions must not invalidate
  that explanation.
- `apps/ingest/src/auth.ts:37-64` (`resolvePrincipal`), `:82-84` (`authorized`), `:92-94` (`isUuid`)
  — Why: every new gated route uses all three; the 401-then-403 two-`if` shape at each call site is
  what `routes/org-scoping.test.ts` greps for.
- `apps/ingest/src/password.ts` (whole file, 28 lines) — Why: `hashPassword` / `verifyPassword`, the
  exact functions signup/reset/change must call. Stored form is `scrypt$<salt>$<dk>`.
- `apps/ingest/src/session.ts:19-29` (`signSession`), `:10` (`SESSION_TTL_SECONDS`) — Why: accept-invite
  and signup should return a session token so the caller is logged in, exactly as
  `POST /v1/auth/login` does (`routes/auth.ts:44-45`).
- `packages/db/src/repositories/users.ts` (whole file, 78 lines) — Why: `ensureUserByEmail` and
  `setUserPassword` **both call `ensurePersonalOrg`**, which is the single biggest trap in this
  slice. See GOTCHA-1.
- `packages/db/src/repositories/principal.ts:44-61` (`findPrincipalByEmail`) — Why: it resolves the
  **first** membership by `(created_at, id)`. Combined with the line above, an invited user who is
  given a personal org first will resolve to the *wrong* org forever.
- `packages/db/src/repositories/organizations.ts` (whole file, 114 lines) — Why: `ensurePersonalOrg`,
  `findOrgIdByUserId`, `getOrgIdForUser`; and its header states the rule you must obey — *"a row's
  `org_id` must match the org of whoever the row BELONGS to, which is the principal only when the
  principal is also the owner."*

**Tenancy / RLS (the layer your two new tables join):**

- `packages/db/src/org-context.ts` (whole file, 103 lines) — Why: `withOrg(db, orgId, role, fn)` —
  four required args, `Db` not `DbClient`, and the reason each guard exists.
- `packages/db/drizzle/0015_shiny_iron_man.sql:1-30, 75-92` — Why: the strict vs bootstrap-permissive
  policy shapes, verbatim, and the mandatory `nullif(…, '')` guard.
- `packages/db/drizzle/0016_strong_magus.sql:1-45, 68-75` — Why: the RESTRICTIVE role-write policy
  shape (INSERT/UPDATE → `WITH CHECK`, DELETE → `USING`) and why DELETE is unavoidably silent.
- `packages/db/drizzle/down/0016_strong_magus.down.sql:1-20` — Why: the down-migration ordering
  discipline your `down/0017_*.down.sql` must mirror (drop every POLICY before disabling RLS or
  dropping a table).
- `packages/db/src/repositories/rls.int.test.ts:97-125` (the three table-classification constants)
  and `:423-503` (the `pg_policies` inventory test) — Why: you MUST extend both. Re-key, never
  merely bump a number (CLAUDE.md 15.4 lesson).

**Patterns to mirror:**

- `packages/db/src/repositories/project-grants.ts:1-56` — Why: the *canonical* 15.4-era repository —
  silent library header, `DbClient` not `Db`, `orgId` as the second parameter, an explicit
  `…RowColumns` constant mirroring the exported `…Row` interface.
- `packages/db/src/repositories/pairing.ts` (whole file, 66 lines) — Why: the exact lifecycle
  `invites` copies (mint short-lived single-use credential → redeem-and-mark-consumed atomically →
  typed error class with a `reason` union). `PairingError` is the model for `InviteError`.
- `packages/db/src/tokens.ts` (whole file, 16 lines) — Why: `generateToken()` (32 random bytes,
  base64url) + `hashToken()` (sha256 hex). **Reuse these; do not write new crypto.**
- `apps/ingest/src/routes/pairing-codes.ts` (whole file, 60 lines) — Why: this is the file you
  surgically change, and its 15.3 header comment is the thing you must rewrite (its stated reason
  for being on the `withOrg` allow-list changes when the `users` upsert leaves).
- `apps/ingest/src/schemas.ts:20-29` (`loginBodySchema`) — Why: the exact JSON-schema style for every
  new body (`required` + `additionalProperties:false` + `minLength:1`).
- `apps/ingest/src/delivery/smtp-deliverer.ts:15-28, 55-68` — Why: `MailTransport` (the structural
  subset you reuse) and the injectable `transportFactory` pattern.
- `apps/ingest/src/routes/org-scoping.test.ts` (whole file, 199 lines) — Why: the structural gate your
  new `members.ts` must satisfy, and the two allow-lists you may need to touch.
- `apps/ingest/src/rbac.int.test.ts` (whole file, 485 lines) — Why: **the harness you extend.** It is
  the only two-role, multi-user fixture in the repo. Its `beforeEach` (`:125-164`) is the seeding
  recipe; its comment at `:135-142` is GOTCHA-1 stated in the codebase's own words.
- `apps/ingest/src/server.ts:106-133` (deliverer env wiring), `:140-157` (the boot seeds) — Why: where
  the mailer and the self-signup flag get wired.

### New Files to Create

- `packages/db/src/repositories/invites.ts` — invite mint/preview/redeem/list/revoke + `InviteError`.
- `packages/db/src/repositories/password-resets.ts` — reset-token mint/consume + expiry sweep.
- `packages/db/src/repositories/members.ts` — org member list / role change / removal, with the
  last-owner guard.
- `packages/db/src/repositories/members.int.test.ts` — two-role repository suite for the guards.
- `packages/db/drizzle/0017_<drizzle-name>.sql` — **hand-edited** on top of the generated DDL (drizzle
  cannot emit `CREATE POLICY`). Two tables + 1 bootstrap-permissive org policy + 3 restrictive
  role-write policies.
- `packages/db/drizzle/down/0017_<same-name>.down.sql` — the reversal, policies first.
- `apps/ingest/src/delivery/mailer.ts` — `Mailer` + `createMailer` over the shared `MailTransport`.
- `apps/ingest/src/delivery/mailer.test.ts` — unit tests with an injected fake transport.
- `apps/ingest/src/routes/members.ts` — the principal-authed member/invite CRUD routes.
- `apps/ingest/src/identity.int.test.ts` — the slice's proof: a two-role, multi-user HTTP suite.

### Files to Modify

- `packages/db/src/schema.ts` — `invites` + `passwordResetTokens` tables.
- `packages/db/src/index.ts` — barrel exports for the three new repositories + two new tables.
- `packages/db/src/repositories/users.ts` — email normalization; a new
  `createUserWithPassword` that does **NOT** create a personal org (GOTCHA-1).
- `packages/db/src/repositories/rls.int.test.ts` — extend the three classification constants and the
  `pg_policies` inventory assertions.
- `apps/ingest/src/routes/auth.ts` — five new routes.
- `apps/ingest/src/routes/pairing-codes.ts` — **remove** the `users` upsert (D-M15-8).
- `apps/ingest/src/schemas.ts` — the new body schemas.
- `apps/ingest/src/app.ts` + `apps/ingest/src/plugins/auth.ts` — decorate `mailer` and
  `selfSignupEnabled`; declare both on `FastifyInstance`.
- `apps/ingest/src/server.ts` — env wiring for the mailer + self-signup flag.
- `.env.example` — the new vars, documented in the file's existing voice.
- `SUMMARY.md` — flip **15.5** to ✅ in §0 and §6 **in the same commit** as the execution report
  (CLAUDE.md makes this a gate, `scripts/check-summary.mjs`).

### Relevant Documentation

- [PostgreSQL — Row Security Policies](https://www.postgresql.org/docs/16/ddl-rowsecurity.html#DDL-ROWSECURITY-POLICIES)
  - Specific section: *Policies* — `AS RESTRICTIVE`, and the `USING` vs `WITH CHECK` table.
  - Why: your new `invites` table takes an unusual-for-this-repo combination (bootstrap-permissive
    org policy **+** restrictive role-write policies). The doc's statement that RESTRICTIVE policies
    combine with `AND` while PERMISSIVE combine with `OR` is what makes that combination sound.
- [PostgreSQL — `set_config`](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADMIN-SET)
  - Why: `SET LOCAL x = $1` is not parameterizable (15.0 Finding 4.1). Already encapsulated in
    `withOrg` — do not re-derive it.
- [Nodemailer — Message configuration](https://nodemailer.com/message/)
  - Specific section: `from` / `to` / `subject` / `text`.
  - Why: `MailTransport.sendMail` is a structural subset of this; keep it a subset.
- [OWASP — Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
  - Specific sections: *Return a consistent message*, *Use a URL token with sufficient entropy*,
    *Ensure tokens expire and are single-use*.
  - Why: it is the source of D-15.5-7 (the always-202 reset response). `generateToken()`'s 32 random
    bytes clears the entropy bar with room to spare.

### Patterns to Follow

**Repository shape** — mirror `project-grants.ts:23-56` exactly:

```ts
export interface InviteRow {
  id: string;
  email: string;
  role: string;
  invitedByUserId: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
}

/** Keep this list == `InviteRow` — the 15.1 lesson: no route declares a response schema,
 *  so a bare `select()` puts every future column (starting with `org_id`) on the wire. */
const inviteRowColumns = {
  id: invites.id,
  email: invites.email,
  role: invites.role,
  invitedByUserId: invites.invitedByUserId,
  expiresAt: invites.expiresAt,
  acceptedAt: invites.acceptedAt,
  createdAt: invites.createdAt,
};
```

Note `org_id` and `token_hash` are deliberately **absent** from `inviteRowColumns` — the first is
tenancy plumbing, the second is a credential digest. Neither belongs on the wire.

**`orgId` is always the SECOND parameter**, right after `db` (CLAUDE.md 15.2 rule) — so a transposed
argument between two adjacent `string` params is visible in review:

```ts
export async function listInvites(db: DbClient, orgId: string): Promise<InviteRow[]>
export async function revokeInvite(db: DbClient, orgId: string, inviteId: string): Promise<boolean>
```

**Route gate shape** — two adjacent `if` blocks, never folded together (`auth.ts:66-81` explains
why; `org-scoping.test.ts` greps for both):

```ts
const principal = await resolvePrincipal(app, request);
if (!principal) {
  return reply.code(401).send({ error: "admin authorization required" });
}
if (!authorized(principal, "admin")) {
  return reply.code(403).send({ error: "insufficient role" });
}
const result = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
  listInvites(tx, principal.orgId),
);
```

**Typed error class** — mirror `PairingError` (`pairing.ts:8-16`) and map it in `app.ts`'s
`setErrorHandler` beside the existing `PairingError` branch (`app.ts:189-193`):

```ts
export class InviteError extends Error {
  constructor(
    message: string,
    readonly reason: "unknown" | "accepted" | "expired" | "revoked",
  ) {
    super(message);
    this.name = "InviteError";
  }
}
```

**Body schema** — mirror `loginBodySchema` (`schemas.ts:21-29`):

```ts
export const inviteMemberBodySchema = {
  type: "object",
  required: ["email", "role"],
  additionalProperties: false,
  properties: {
    email: { type: "string", minLength: 3, maxLength: 320 },
    role: { type: "string", enum: ["viewer", "member", "admin", "owner"] },
  },
} as const;
```

> **Spike-snippet fidelity.** Every snippet in this plan agrees with the spikes recorded in NOTES.
> In particular: the `invites` policy block below is the *bootstrap-permissive* shape copied
> verbatim from `0015_shiny_iron_man.sql:89`, and the restrictive block is copied verbatim from
> `0016_strong_magus.sql:70-72`. If a snippet and a spike ever disagree, the spike wins — re-run it.

---

## DESIGN DECISIONS (resolve these before writing code; they are already resolved — do not re-litigate)

**D-15.5-1 — Two tables, not one generic `identity_tokens`.** An invite is **org-owned**
(`org_id`, `role`, `invited_by`) and a reset token is **identity-owned** (`user_id`, no org). They
therefore land on opposite sides of D-15.3-4's identity-tables-carry-no-RLS line. One table would
force either an RLS policy on identity data or none on tenant data. Two tables, two classifications.

**D-15.5-2 — `invites` is BOOTSTRAP-PERMISSIVE for org, RESTRICTIVE for role.** A new combination,
and both halves are argued:

- _Bootstrap-permissive org policy_ — accepting an invite reads the row **in order to discover the
  org**, exactly like `redeemPairingCode` (`pairing.ts:42-49`). A strict policy would make the accept
  path read zero rows under the app role. Copy `pairing_codes`'s policy verbatim.
- _Restrictive role-write policies (×3)_ — unlike `machines`/`ingest_tokens`/`pairing_codes`, an
  invite **is** written by a principal with a membership role, and it is a **privilege-granting**
  row: a viewer minting `role: "owner"` is the precise escalation the 15.4 backstop exists for.

This requires a **third** classification in `rls.int.test.ts`. Add
`ROLE_GATED_BOOTSTRAP_TABLES = ["invites"] as const` and extend the inventory assertions to
`STRICT_TABLES.length * 3 + ROLE_GATED_BOOTSTRAP_TABLES.length * 3`. **Do not merely bump the
number** — the CLAUDE.md 15.4 lesson is that a collapsing assertion reads green and means nothing.

**D-15.5-3 — Emails are normalized to lowercase at every boundary, and existing rows are
lowercased by 0017.** Proven necessary by spike 3: `users_email_unique` is a plain btree on `email`,
so case variants are distinct accounts today. Add a `normalizeEmail(e) => e.trim().toLowerCase()` in
`packages/db/src/repositories/users.ts` and route **every** email through it —
`findUserIdByEmail`, `ensureUserByEmail`, `findAdminCredential`, `setUserPassword`,
`findPrincipalByEmail`, and every new function. The migration runs
`UPDATE users SET email = lower(email) WHERE email <> lower(email);`.

> If two rows differ only in case, that `UPDATE` **fails loudly** on `users_email_unique`. That is
> the correct outcome — a human must decide which account survives. Do not add `ON CONFLICT`.

**D-15.5-4 — `POST /v1/pairing-codes` resolves an existing member; it never creates one
(D-M15-8).** Delete the inline `users` upsert and the `ensurePersonalOrg` call
(`pairing-codes.ts:45-53`). Replace with a new `findMemberByEmail(db, orgId, email)` in
`repositories/members.ts`; `undefined` → **404** `{ error: "no such member in this organization" }`.
This also *narrows* the route: it can no longer mint a code for someone in another org, so its
allow-list justification in `org-scoping.test.ts:51` must be rewritten (see Task 14).

**D-15.5-5 — Self-signup is OFF by default behind `SELF_SIGNUP_ENABLED` (D-M15-6), and returns 403
when off.** Not 404. The route's existence is public knowledge (this is open source); pretending it
does not exist buys nothing and makes a misconfiguration undiagnosable. Parse the env with the same
`=== "true"` strictness the repo uses elsewhere — any value other than the literal `"true"` is off.

**D-15.5-6 — Self-signup creates a NEW personal org; it never joins an existing one.** A signup that
joined the first org it found would hand every passer-by a tenant. Signup ⇒
`createUserWithPassword` + `ensurePersonalOrg` ⇒ `owner` of their own org. (This is the one new path
where `ensurePersonalOrg` is correct.)

**D-15.5-7 — Reset request always answers 202, regardless of whether the email exists.** Mirrors the
generic 401 at `routes/auth.ts:40-42` ("no user-enumeration") and OWASP's *consistent message* rule.
Consequence: a reset request for an unknown address does nothing and reports success. That is
intended; assert it in a test so nobody "fixes" it into a 404.

**D-15.5-8 — Tokens are stored hashed; plaintext is returned exactly once.** `generateToken()` +
`hashToken()` from `packages/db/src/tokens.ts`, same as `ingest_tokens`. `invites.token_hash` and
`password_reset_tokens.token_hash` are both `text NOT NULL UNIQUE`. The plaintext appears only in
the mail body and (for invites only, see D-15.5-10) in the admin-gated mint response.

**D-15.5-9 — An invite for an email that ALREADY has a user is rejected 409.** This is the slice's
hardest boundary and it exists because of GOTCHA-1. `findPrincipalByEmail` resolves the **first**
membership by `(created_at, id)`, and every existing user already owns a personal org created before
any invite could be. So adding a second membership produces a user who is "in" the new org according
to the table and resolves to their old org on every request — a path that *looks* like it works and
does not. Multi-org membership plus an org switcher is **15.10**. Until then:

- target email has **no** user row → invite proceeds (the happy path: a brand-new colleague);
- target email **is already a member of the caller's org** → `409 { error: "already a member" }`;
- target email has a user row in **any other org** → `409 { error: "user already exists — multi-org
  membership lands in 15.10" }`.

Assert all three. Rejecting loudly is the point: the alternative ships a silent no-op.

**D-15.5-10 — With no mailer configured, `POST /v1/members/invite` returns the token in its
response; `POST /v1/auth/password-reset` returns 503.** The invite route is `admin`-gated, so
handing the admin a token to pass on out-of-band is exactly the precedent
`POST /v1/pairing-codes` already sets (`pairing-codes.ts:57` returns the code in the body). The
reset route is **unauthenticated** — returning a token there would be a full account-takeover
primitive, so with no mailer it must fail. This keeps a solo self-hosted box with no SMTP fully
functional for invites (D-M15-10) without opening a hole.

**D-15.5-11 — Role escalation guard: you may never grant or assign a role above your own.** An
`admin` may invite/promote up to `admin`, never `owner`. Implemented in the route layer
(`hasRole(principal.role, requestedRole as Role)`), because the RLS backstop only ever asks "is this
a viewer?" — the strict layer is the route (`auth.ts:76-80`).

**D-15.5-12 — Last-owner guard: an org's final `owner` membership cannot be demoted or removed.**
Enforced in `repositories/members.ts` (a `count(*) where role='owner'` inside the same transaction),
throwing `MemberError("last owner", "last_owner")` → **409**. In the repository, not the route, so
it holds for any future caller.

**D-15.5-13 — Sessions are NOT invalidated on password change in this slice.** D-M15-12 makes
sessions stateful in **15.6**; today they are stateless HMACs (`session.ts:1-8`) and the only
revocation is rotating `SESSION_SECRET`. Do **not** attempt partial revocation here — leave a
`// 15.6 (D-M15-12)` comment at the password-change site and a matching line in the execution
report. Half-revocation would be worse than none.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation — schema, migration, mailer

Two tables, the 0017 up/down pair, the email-normalization helper, and the mailer. No routes yet;
after this phase `npm run repo-health -- --require-db` must still pass with behavior unchanged.

### Phase 2: Core — repositories

`invites.ts`, `password-resets.ts`, `members.ts` + barrel exports. Silent libraries: typed errors,
no logging, no clock reading beyond `Date.now()` for expiry (mirroring `pairing.ts:37`).

### Phase 3: Integration — routes, wiring, and the D-M15-8 deletion

`routes/members.ts`, the five `routes/auth.ts` additions, `app.ts`/`plugins/auth.ts` decorations,
`server.ts` env wiring, and the pairing-code surgery. Update `org-scoping.test.ts`'s allow-list
comments to match the new reality.

### Phase 4: Testing & Validation

The `identity.int.test.ts` two-role HTTP suite, the `members.int.test.ts` repository suite, the
`mailer.test.ts` units, the `rls.int.test.ts` inventory extension, and the full gate with
`--require-db`.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom.

### 1. UPDATE `packages/db/src/schema.ts`

- **IMPLEMENT**: two new `pgTable`s, placed immediately after `pairingCodes` (they share its
  lifecycle):

```ts
/**
 * M15 15.5 — an outstanding invitation to join an organization (D-M15-5). Same lifecycle as
 * `pairing_codes`: short-lived, single-use, and REDEEMED BEFORE ANY ORG CONTEXT EXISTS — which
 * is why 0017 gives it the bootstrap-permissive org policy (D-15.3-3) rather than a strict one.
 *
 * UNLIKE `pairing_codes` it also carries the 15.4 RESTRICTIVE role-write policies: an invite is a
 * PRIVILEGE-GRANTING row, so a viewer minting `role: 'owner'` is precisely the escalation the
 * backstop exists for (D-15.5-2).
 *
 * `role` is TEXT with no CHECK, matching `memberships.role` — the four legal values live in
 * `@420ai/shared`'s ROLES and the route schema's enum, not in a migration.
 */
export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    // Lowercased at every boundary by `normalizeEmail` (D-15.5-3). NOT unique: a revoked or
    // expired invite for an address must not block re-inviting it.
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    // sha256 hex of the plaintext token (tokens.ts `hashToken`). The plaintext is returned once
    // and never stored — same discipline as `ingest_tokens.token_hash`.
    tokenHash: text("token_hash").notNull().unique(),
    invitedByUserId: uuid("invited_by_user_id")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("invites_by_org").on(t.orgId), index("invites_by_email").on(t.email)],
);

/**
 * M15 15.5 — a single-use password-reset token (D-M15-5). An IDENTITY table: no `org_id`, and
 * therefore NO RLS at all, for the same reason `users`/`organizations`/`memberships` carry none
 * (D-15.3-4) — it is read at the one moment before any identity is established.
 */
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("password_reset_tokens_by_user").on(t.userId)],
);
```

- **PATTERN**: `schema.ts:143-170` (`pairingCodes`) for shape; `schema.ts:77-93` (`memberships`) for
  the TEXT-role convention and the "no pg enum" rationale.
- **IMPORTS**: all of `pgTable`/`uuid`/`text`/`timestamp`/`index` are already imported in the file.
- **GOTCHA**: `token_hash` is `.unique()`, `email` is **not**. A unique email would make a revoked
  invite permanently block re-inviting that address.
- **VALIDATE**: `npm run typecheck` → exit 0.

### 2. CREATE the 0017 migration (generate, then HAND-EDIT)

- **IMPLEMENT**: `npm run db:generate` to emit the two `CREATE TABLE`s, then **append by hand** the
  policy block drizzle-kit cannot express, plus the email lowercasing:

```sql
-- (appended by hand to the drizzle-generated DDL above — `drizzle-kit generate` cannot emit
-- CREATE POLICY. Mirrors the hand-edited convention of 0014/0015/0016.)

-- D-15.5-3: emails become case-insensitive by NORMALIZATION. `users_email_unique` is a plain
-- btree on `email` (verified against the live test DB), so `Foo@x.com` and `foo@x.com` are two
-- accounts today. This UPDATE will FAIL LOUDLY on that unique index if such a pair exists — which
-- is the correct outcome: a human must decide which account survives. Do NOT add ON CONFLICT.
UPDATE "users" SET "email" = lower("email") WHERE "email" <> lower("email");--> statement-breakpoint

-- `invites` — BOOTSTRAP-PERMISSIVE org policy, copied verbatim from 0015's `pairing_codes`
-- (line 89). Accepting an invite reads the row IN ORDER TO discover the org, exactly as
-- `redeemPairingCode` does, so a strict policy would read zero rows under the app role.
ALTER TABLE "invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invites" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "invites_org_isolation" ON "invites" USING (nullif(current_setting('app.current_org', true), '') IS NULL OR org_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint

-- …AND the 15.4 role-write backstop, which the other three bootstrap tables deliberately lack
-- (D-15.5-2). They are written by machine paths with no membership role; an invite is written by
-- a principal and GRANTS PRIVILEGE. Shape copied verbatim from 0016 lines 70-72: INSERT/UPDATE
-- test in WITH CHECK (LOUD), DELETE in USING (unavoidably silent — Postgres has no WITH CHECK
-- for DELETE, and the route gate is the only loud layer there).
CREATE POLICY "invites_role_write_ins" ON "invites" AS RESTRICTIVE FOR INSERT WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "invites_role_write_upd" ON "invites" AS RESTRICTIVE FOR UPDATE WITH CHECK (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');--> statement-breakpoint
CREATE POLICY "invites_role_write_del" ON "invites" AS RESTRICTIVE FOR DELETE USING (coalesce(nullif(current_setting('app.current_role', true), ''), 'member') <> 'viewer');

-- `password_reset_tokens` gets NO policy at all (D-15.3-4 / D-15.5-1): it is an identity table,
-- read at the one moment before any identity — and therefore any org context — exists.
```

- **PATTERN**: `0016_strong_magus.sql:1-45` for the header-comment style; `:70-72` for the exact
  restrictive policy text; `0015_shiny_iron_man.sql:89` for the exact bootstrap-permissive text.
- **GOTCHA**: **no `GRANT` statement is needed.** Spike 1 (see NOTES) proved against the live test DB
  that 0015's `ALTER DEFAULT PRIVILEGES` already covers brand-new tables — the app role
  INSERTed and SELECTed on a table created seconds earlier with no explicit grant. Adding a
  redundant `GRANT` is harmless but do not treat its absence as a bug.
- **GOTCHA**: keep `--> statement-breakpoint` between every statement and **omit it after the last
  one** (match the existing files exactly).
- **VALIDATE**: `npm run db:migrate` → exit 0; then
  `psql "$DATABASE_URL_TEST" -c "select policyname, permissive, cmd from pg_policies where tablename='invites'"`
  → 4 rows (1 PERMISSIVE ALL, 3 RESTRICTIVE INSERT/UPDATE/DELETE).

### 3. CREATE `packages/db/drizzle/down/0017_<same-name>.down.sql`

- **IMPLEMENT**: drop the 4 policies, then disable RLS, then drop both tables. Header comment must
  state the ordering rule and the fact that the email lowercasing is **not** reversible (it is a
  normalization, not a data loss — say so explicitly).
- **PATTERN**: `down/0016_strong_magus.down.sql:1-20` — *"every POLICY is dropped before any table's
  RLS is disabled or any table is dropped."*
- **GOTCHA**: dropping a policy while RLS stays ENABLED makes Postgres deny everything (the 15.3
  corollary in CLAUDE.md). Harmless here only because the tables are then dropped — say why in the
  comment.
- **VALIDATE**: `npm run db:rollback` against a scratch DB, then `npm run db:migrate` again → both
  exit 0.

### 4. UPDATE `packages/db/src/repositories/users.ts`

- **IMPLEMENT**: (a) `normalizeEmail`; (b) route every existing function's `email` through it;
  (c) a new `createUserWithPassword` that deliberately does **NOT** create a personal org.

```ts
/**
 * M15 15.5 (D-15.5-3) — THE email boundary. `users_email_unique` is a plain btree on `email`
 * (verified against the live schema), so without this `Foo@corp.com` and `foo@corp.com` are two
 * accounts. That is half of the takeover chain D-M15-8 closes: pre-seeding gets you a row,
 * case-variance gets you a SECOND row the victim cannot see. 15.7 links identity by email.
 *
 * Every function in this file, plus `findPrincipalByEmail`, plus every 15.5 route, normalizes
 * here. Migration 0017 lowercases the existing rows.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Create a user WITH a password hash and return its id — and deliberately WITHOUT a personal
 * organization. This is the ONLY users-insert path that skips `ensurePersonalOrg`, and skipping
 * it is the entire point (D-15.5-9 / GOTCHA-1):
 *
 *   `findPrincipalByEmail` resolves the FIRST membership by (created_at, id). If an invited user
 *   were given a personal `owner` membership first, every subsequent request would resolve to
 *   THAT org — the invite would be a silent no-op, and every role assertion about them would
 *   secretly be testing an owner. That is not hypothetical; it is what the first run of
 *   `rbac.int.test.ts` actually did (see its comment at :135-142).
 *
 * The invite-accept path therefore calls this and then inserts EXACTLY ONE membership, in the
 * inviting org. Self-signup (D-15.5-6) is the opposite case and calls `ensurePersonalOrg`
 * explicitly, because a signup legitimately owns a brand-new org.
 *
 * Throws on a duplicate email (the unique index) — callers check first and return 409.
 */
export async function createUserWithPassword(
  db: DbClient,
  email: string,
  passwordHash: string,
): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: normalizeEmail(email), passwordHash })
    .returning({ id: users.id });
  return row!.id;
}

/** Set (or replace) an existing user's password hash. Returns false if no such user. */
export async function updatePasswordHash(
  db: DbClient,
  userId: string,
  passwordHash: string,
): Promise<boolean> {
  const rows = await db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  return rows.length > 0;
}
```

- **PATTERN**: `users.ts:28-37` / `:65-78` for the existing shape and comment density.
- **IMPORTS**: `eq` from `drizzle-orm` (already imported); `users` from `../schema.js` (already).
- **GOTCHA-1 (the big one)**: do **not** reach for `setUserPassword` in the invite-accept path. It
  calls `ensurePersonalOrg` (`users.ts:76`) and will shadow the invited membership.
- **GOTCHA**: also normalize inside `findPrincipalByEmail`
  (`packages/db/src/repositories/principal.ts:44-61`) — it is the read half of the same key.
- **VALIDATE**: `npx vitest run packages/db` → all existing db tests still pass.

### 5. CREATE `packages/db/src/repositories/invites.ts`

- **IMPLEMENT**: `InviteError`; `createInvite`, `findInviteByToken`, `acceptInvite`, `listInvites`,
  `revokeInvite`; `InviteRow` + `inviteRowColumns`.
  - `createInvite(db, orgId, { email, role, invitedByUserId }, ttlMs = 7 * 24 * 60 * 60 * 1000)`
    → `{ token, invite: InviteRow }`. Token via `generateToken()`, stored as `hashToken(token)`.
  - `findInviteByToken(db, token)` → the row **including `orgId`** (the accept path needs it to
    discover the org — this is the bootstrap read). Throws `InviteError` for
    unknown/accepted/expired/revoked.
  - `acceptInvite(tx, token, userId)` → validates, stamps `accepted_at`, inserts the
    `memberships` row `{ orgId, userId, role }`. **One transaction**, mirroring
    `redeemPairingCode`.
- **PATTERN**: `pairing.ts` end to end — the typed error, the TTL constant, the
  validate-then-stamp order, and the "AUTH BOUNDARY" comment on the pre-context read.
- **IMPORTS**: `and, eq, isNull` from `drizzle-orm`; `generateToken, hashToken` from
  `../tokens.js`; `invites, memberships` from `../schema.js`; `type DbClient` from `../client.js`.
- **GOTCHA**: `findInviteByToken` must **not** take an `orgId` and must **not** be called inside a
  `withOrg` context — it is what *establishes* the context. Say so in the header, as
  `tokens.ts:27-31` does.
- **GOTCHA**: check `revokedAt` **and** `acceptedAt` **and** `expiresAt`, in that order, so the
  error `reason` a caller sees is the most specific true one.
- **VALIDATE**: `npm run typecheck` → exit 0.

### 6. CREATE `packages/db/src/repositories/password-resets.ts`

- **IMPLEMENT**: `createPasswordReset(db, userId, ttlMs = 60 * 60 * 1000)` → `{ token, expiresAt }`;
  `consumePasswordReset(tx, token)` → `{ userId }` or throws `PasswordResetError` with reason
  `"unknown" | "consumed" | "expired"`.
- **PATTERN**: `pairing.ts:25-66` — same mint/redeem pair, same single-use stamping.
- **GOTCHA**: 1 hour TTL, not 15 minutes and not 7 days. A reset link travels by email; short enough
  to bound exposure, long enough to survive a slow mail hop.
- **GOTCHA**: consume must be **atomic** — validate and stamp `consumed_at` in the same transaction
  as the password update, or a leaked token is replayable.
- **VALIDATE**: `npm run typecheck` → exit 0.

### 7. CREATE `packages/db/src/repositories/members.ts`

- **IMPLEMENT**: `MemberError` (reasons `"last_owner" | "not_a_member"`); `MemberRow` +
  `memberRowColumns`; and:
  - `listMembers(db, orgId): Promise<MemberRow[]>` — `memberships ⨝ users`, ordered
    `(created_at, id)`, columns `{ userId, email, role, joinedAt }`. **No `passwordHash`.**
  - `findMemberByEmail(db, orgId, email): Promise<MemberRow | undefined>` — the D-M15-8 replacement
    for the pairing-code upsert.
  - `setMemberRole(tx, orgId, userId, role): Promise<MemberRow>` — throws `MemberError("last_owner")`
    when demoting the org's final owner.
  - `removeMember(tx, orgId, userId): Promise<boolean>` — same guard.
- **PATTERN**: `project-grants.ts` for the whole file shape; `principal.ts:48-59` for the
  `users ⨝ memberships` join and the `(created_at, id)` ordering.
- **GOTCHA (D-15.5-12)**: the owner count and the mutation must be in the **same transaction**, or
  two concurrent demotions each see two owners and both succeed. All callers are already inside
  `withOrg`, which is a transaction — take `DbClient` (a `Tx`), never `Db`, and say why in the
  header (mirroring `project-grants.ts:16-20`).
- **GOTCHA**: every function takes `orgId` as the **second** parameter, and every `where` carries
  `eq(memberships.orgId, orgId)` — the explicit predicate is the primary defence; `memberships`
  carries **no RLS** at all, so there is no backstop here. This is the one place in the slice where
  a forgotten predicate is a genuine cross-tenant read.
- **VALIDATE**: `npm run typecheck` → exit 0.

### 8. UPDATE `packages/db/src/index.ts`

- **IMPLEMENT**: export `invites`, `passwordResetTokens` from `./schema.js`; and the three new
  repositories' functions + types + error classes, each with a one-line `// M15 15.5 …` comment in
  the style of the `project-grants` block (`index.ts` ~line 78).
- **VALIDATE**: `npm run typecheck` → exit 0; `grep -c "createInvite" packages/db/src/index.ts` → 1.

### 9. CREATE `apps/ingest/src/delivery/mailer.ts`

- **IMPLEMENT**:

```ts
import nodemailer from "nodemailer";
import type { MailTransport } from "./smtp-deliverer.js";

/**
 * M15 15.5 — transactional mail (invites, password resets). Reuses M13 13.5's nodemailer
 * transport at the TRANSPORT level, not the deliverer level: `AlertDeliverer.deliver(firing)`
 * takes an `AlertFiring` and cannot express an invite. `MailTransport` (smtp-deliverer.ts:26-28)
 * is already the right structural subset, so it is imported rather than redeclared — one fake
 * transport shape serves both files' unit tests.
 *
 * Returns `null` when unconfigured, mirroring `createSmtpDeliverer` (smtp-deliverer.ts:60).
 * Callers branch on null: the admin-gated invite route hands the token back in its response
 * (D-15.5-10, same precedent as `POST /v1/pairing-codes`), while the UNAUTHENTICATED
 * password-reset route 503s — returning a reset token to an anonymous caller would be a
 * complete account-takeover primitive.
 *
 * Never logs (CLAUDE.md: libraries throw, entrypoints log). `send` THROWS on failure.
 */
export interface MailerConfig {
  url: string;
  from: string;
  /** Base URL of the DASHBOARD, used to build invite/reset links. Defaults to
   *  http://localhost:3000 (`next dev`'s port) when APP_BASE_URL is unset. */
  appBaseUrl: string;
}

export interface Mailer {
  send(mail: { to: string; subject: string; text: string }): Promise<void>;
  /** Exposed so routes build links without re-reading env. */
  readonly appBaseUrl: string;
}

export function createMailer(
  cfg: MailerConfig | null,
  transportFactory: (url: string) => MailTransport = (url) =>
    nodemailer.createTransport(url) as unknown as MailTransport,
): Mailer | null {
  if (!cfg) return null;
  const transport = transportFactory(cfg.url);
  return {
    appBaseUrl: cfg.appBaseUrl,
    async send({ to, subject, text }) {
      await transport.sendMail({ from: cfg.from, to, subject, text });
    },
  };
}
```

- **PATTERN**: `smtp-deliverer.ts:55-68` verbatim in shape.
- **GOTCHA**: `nodemailer@9.0.3` resolves under `apps/ingest` (verified — `npm ls nodemailer`, output
  in NOTES) and ships its own types; there is no `@types/nodemailer` and none is needed. Keep the
  `as unknown as MailTransport` cast — that is how the existing file bridges it.
- **VALIDATE**: `npx vitest run apps/ingest/src/delivery/mailer.test.ts` → passes with the injected
  fake transport (Task 20).

### 10. UPDATE `apps/ingest/src/schemas.ts`

- **IMPLEMENT**: append a `// --- M15 15.5 identity core ---` section with
  `inviteMemberBodySchema`, `acceptInviteBodySchema` (`{ token, password }`, password
  `minLength: 12`), `signupBodySchema` (`{ email, password }`), `passwordResetRequestBodySchema`
  (`{ email }`), `passwordResetConfirmBodySchema` (`{ token, password }`),
  `changePasswordBodySchema` (`{ currentPassword, newPassword }`), `patchMemberRoleBodySchema`
  (`{ role }` with the four-value enum).
- **PATTERN**: `schemas.ts:21-29`.
- **GOTCHA**: `additionalProperties: false` on every one; a missing/invalid field then becomes a 400
  via `app.ts:198-200`'s `err.validation` branch **before** the handler runs.
- **GOTCHA**: the `role` enum is the literal four strings, matching `ROLES` in
  `packages/shared/src/roles.ts:11`. Fastify JSON-schema enums cannot reference a TS const — keep
  them in sync by hand and note it in a comment.
- **VALIDATE**: `npm run typecheck` → exit 0.

### 11. UPDATE `apps/ingest/src/plugins/auth.ts` + `apps/ingest/src/app.ts`

- **IMPLEMENT**: declare `mailer: Mailer | null` and `selfSignupEnabled: boolean` on
  `FastifyInstance` (plugins/auth.ts's `declare module "fastify"` block, ~line 39); decorate both in
  `buildApp` with `opts.mailer ?? null` and `opts.selfSignupEnabled ?? false`; add both to
  `BuildAppOptions` with the same "omitted → off, so no existing caller changes" comment style as
  `alertDeliverer` (`app.ts:80-82`); register `memberRoutes`; and add an `InviteError` /
  `MemberError` / `PasswordResetError` branch to `setErrorHandler` beside `PairingError`
  (`app.ts:189-193`).
- **GOTCHA**: **`selfSignupEnabled` defaults to `false`** (D-M15-6). A default of `true` would turn
  every existing test caller — and every deployment that upgrades without touching `.env` — into an
  open-signup box. This is the single most consequential default in the slice.
- **GOTCHA**: decorate before `app.register(...)` of the routes, same as every other decoration.
- **VALIDATE**: `npm run typecheck` → exit 0; `npx vitest run apps/ingest` → existing suites pass
  unchanged (proving the additive defaults really are inert).

### 12. CREATE `apps/ingest/src/routes/members.ts`

- **IMPLEMENT**: five handlers, each with the 401/403/`withOrg` triple:

| Method | Path | Min role | Notes |
| --- | --- | --- | --- |
| `GET` | `/v1/members` | `viewer` | `listMembers` |
| `POST` | `/v1/members/invite` | `admin` | escalation guard (D-15.5-11) + the three-way 409 (D-15.5-9); mails or returns the token (D-15.5-10) |
| `GET` | `/v1/invites` | `admin` | pending only |
| `DELETE` | `/v1/invites/:id` | `admin` | `isUuid` guard → 400; unknown → 404 |
| `PATCH` | `/v1/members/:userId` | `admin` | escalation guard + last-owner guard (D-15.5-12) |
| `DELETE` | `/v1/members/:userId` | `admin` | last-owner guard |

- **PATTERN**: `routes/pairing-codes.ts:24-58` for the gate triple;
  `routes/projects.ts` for the `isUuid` + 404 discipline.
- **IMPORTS**: `resolvePrincipal, authorized, isUuid` from `../auth.js`; `withOrg` and the member/
  invite repositories from `@420ai/db`; `hasRole, type Role` from `@420ai/shared`.
- **GOTCHA**: **this file must call `withOrg`**, or `org-scoping.test.ts` fails. It is not on either
  allow-list and must not be added to one: `memberships`/`users` carry no RLS, so the explicit
  `orgId` predicate is the *only* boundary — wrapping costs one transaction and makes the
  `invites` bootstrap-permissive policy actually bind (with a context set it behaves strictly).
- **GOTCHA**: pass `principal.role` to `withOrg`, **not** `SERVICE_ROLE`. Unlike the monitor's
  alert-delivery pass (which is the org's own bookkeeping), a member change **is** the caller's
  action, so it should be subject to the role backstop. This is the 15.4 lesson applied in the
  opposite direction — ask *"whose action is this?"*, not *"who triggered it?"*.
- **GOTCHA**: the escalation guard is `hasRole(principal.role, requested)`. Do **not** cast
  `principal.role` to `Role` — `hasRole` takes a `string` and fails closed
  (`packages/shared/src/roles.ts:44-47`). The *requested* role, by contrast, is safe to narrow: the
  body schema's enum already constrained it.
- **VALIDATE**: `npx vitest run apps/ingest/src/routes/org-scoping.test.ts` → all 11 tests pass.

### 13. UPDATE `apps/ingest/src/routes/auth.ts`

- **IMPLEMENT**: five routes, all **unauthenticated** except the last:
  - `GET /v1/auth/invites/:token` — preview: `{ email, role, orgName, expiresAt }`. No token in the
    response. `InviteError` → 410 (mirroring `PairingError`'s 410 at `app.ts:190-192`).
  - `POST /v1/auth/invites/accept` — body `{ token, password }` → `createUserWithPassword` +
    `acceptInvite` in **one** transaction → returns `{ token, expiresAt }` (a session, via
    `signSession`), so the invitee is logged in.
  - `POST /v1/auth/signup` — 403 when `!app.selfSignupEnabled` (D-15.5-5); else
    `createUserWithPassword` + `ensurePersonalOrg` (D-15.5-6) → session. 409 on an existing email.
  - `POST /v1/auth/password-reset` — always 202 (D-15.5-7); 503 when `app.mailer === null`.
  - `POST /v1/auth/password-reset/confirm` — body `{ token, password }` → `consumePasswordReset` +
    `updatePasswordHash` in one transaction → 204.
  - `POST /v1/auth/password` — **session-gated** (`resolvePrincipal` + `authorized(…, "viewer")`),
    body `{ currentPassword, newPassword }`, verifies with `verifyPassword` before updating.
- **PATTERN**: `routes/auth.ts:28-47` (login) for the route-options + generic-error shape.
- **GOTCHA**: apply `config: { rateLimit: app.rateLimitLogin }` to `/v1/auth/signup` and
  `/v1/auth/password-reset` exactly as the login route does (`routes/auth.ts:35`). They are the two
  new unauthenticated write endpoints — one is an account-creation firehose, the other a mail-bomb.
- **GOTCHA**: this file stays on `ALLOWED_WITHOUT_WITHORG` — but its header explanation must be
  **extended**, not left stale. The old sentence covers login only; add that the invite/reset reads
  are the same pre-context shape (`invites` is bootstrap-permissive precisely to allow it, and
  `password_reset_tokens` carries no policy). `org-scoping.test.ts:104-111` asserts the file
  mentions `M15 15.3`; keep that string and add a `M15 15.5` paragraph.
- **GOTCHA (D-15.5-13)**: leave `// 15.6 (D-M15-12): sessions become stateful; THIS is where
  invalidate-on-credential-change lands.` at the two password-mutation sites. Do not half-implement
  revocation.
- **VALIDATE**: `npx vitest run apps/ingest/src/routes/org-scoping.test.ts` → passes.

### 14. UPDATE `apps/ingest/src/routes/pairing-codes.ts` — the D-M15-8 deletion

- **IMPLEMENT**: delete lines 36-54's `users` insert + `ensurePersonalOrg`. Replace with:

```ts
      // D-M15-8 (audit C.9) — CLOSED IN 15.5. This route used to upsert a `users` row from a
      // caller-supplied `body.email`, which is an account PRE-SEEDING primitive: any admin could
      // mint a row for victim@corp.com, and 15.7's SSO link-by-email would then adopt it. The
      // route now REFERENCES an existing member of the caller's org and 404s otherwise.
      let userId = request.body.userId;
      if (!userId) {
        const email = request.body.email ?? principal.email;
        const member = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
          findMemberByEmail(tx, principal.orgId, email),
        );
        if (!member) {
          return reply.code(404).send({ error: "no such member in this organization" });
        }
        userId = member.userId;
      }
```

- **GOTCHA**: `body.userId` is still accepted, and it is now the **weaker** path — a raw uuid with no
  org check. Add the same verification: resolve it through `listMembers`/`findMemberByEmail`'s
  sibling and 404 if it is not a member of `principal.orgId`. Otherwise the primitive survives one
  parameter to the left. (If a member-by-id lookup does not exist yet, add
  `findMemberByUserId(db, orgId, userId)` to `members.ts` in Task 7.)
- **GOTCHA**: the file now calls `withOrg`, so **remove** its entry from
  `ALLOWED_WITHOUT_WITHORG` (`org-scoping.test.ts:51`) — the exemption's stated reason
  ("writes a row for a TARGET user whose org is not the caller's") is no longer true, and
  `org-scoping.test.ts:96-102` fails a stale allow-list only for *deleted files*, not for
  *obsolete reasons*. Leaving it would be a hole for the next reader.
- **GOTCHA**: `createPairingCode` still resolves the org from the **target user**
  (`pairing.ts:35`), which is now always the caller's org. Leave that resolution alone — it is
  correct and its comment should be updated to say the target is now guaranteed same-org.
- **VALIDATE**: `grep -n "insert(users)" apps/ingest/src/routes/pairing-codes.ts` → **no matches**;
  `grep -rn "insert(users)" apps/ingest/src packages/db/src --include=*.ts | grep -v test` → only
  `packages/db/src/repositories/users.ts`.

### 15. UPDATE `apps/ingest/src/server.ts`

- **IMPLEMENT**: wire the mailer and the flag, in the style of the deliverer block (`:106-133`):

```ts
// M15 15.5 transactional mail (invites, password resets). Reuses 13.5's SMTP config when a
// dedicated one is not given, so an existing deployment gets invites with zero new env.
const smtpUrl = process.env.SMTP_URL ?? process.env.ALERT_SMTP_URL;
const mailFrom = process.env.MAIL_FROM ?? process.env.ALERT_EMAIL_FROM;
const mailer = createMailer(
  smtpUrl && mailFrom
    ? {
        url: smtpUrl,
        from: mailFrom,
        appBaseUrl: process.env.APP_BASE_URL ?? "http://localhost:3000",
      }
    : null,
);

// D-M15-6: invite-only is the default posture for EVERY deployment, self-hosted and hosted.
// Strict equality — any value other than the literal "true" leaves signup closed.
const selfSignupEnabled = process.env.SELF_SIGNUP_ENABLED === "true";
if (selfSignupEnabled) {
  console.warn("SELF_SIGNUP_ENABLED=true — anyone who can reach this server can create an account.");
}
```

…and pass `mailer` + `selfSignupEnabled` into `buildApp`.

- **GOTCHA**: the `console.warn` belongs here and nowhere else — `server.ts` is an entrypoint
  (CLAUDE.md logging boundary). Libraries throw; entrypoints log.
- **GOTCHA**: `http://localhost:3000` is `next dev`'s default (`apps/dashboard/package.json` has a
  bare `next dev` with no `-p`). Verified.
- **VALIDATE**: `npm run typecheck` → exit 0.

### 16. UPDATE `.env.example`

- **IMPLEMENT**: a `# --- M15 15.5 identity ---` block for `SELF_SIGNUP_ENABLED`, `SMTP_URL`,
  `MAIL_FROM`, `APP_BASE_URL`, each with the one-line rationale style the file already uses
  (see its `ALERT_SMTP_URL` comment at line 111).
- **GOTCHA**: state the fallback explicitly ("`SMTP_URL`/`MAIL_FROM` default to
  `ALERT_SMTP_URL`/`ALERT_EMAIL_FROM`") so an upgrading operator does not re-enter credentials.
- **VALIDATE**: `npm run format:check` → exit 0.

### 17. UPDATE `packages/db/src/repositories/rls.int.test.ts`

- **IMPLEMENT**: add `"password_reset_tokens"` to `NO_RLS_TABLES` (`:118-125`); add a new
  `ROLE_GATED_BOOTSTRAP_TABLES = ["invites"] as const` beside `BOOTSTRAP_TABLES` (`:115`) with the
  D-15.5-2 rationale; extend the inventory test (`:423-503`):
  - org policies: `STRICT + BOOTSTRAP + ROLE_GATED_BOOTSTRAP`, with the role-gated table asserted
    **`toContain("IS NULL")`** (it is permissive on the org axis);
  - restrictive: `expect(restrictive).toHaveLength((STRICT_TABLES.length + ROLE_GATED_BOOTSTRAP_TABLES.length) * 3)`,
    and the per-table INSERT/UPDATE/DELETE + `WITH CHECK`/`USING` loop extended to cover it;
  - the `relrowsecurity AND relforcerowsecurity` test (`:501+`) covers the new table too.
- **GOTCHA (CLAUDE.md 15.4 lesson, verbatim)**: the map is keyed on `${tablename}.${policyname}` and
  `expect(byKey.size).toBe(all.length)` guards the collapse. **Do not** re-key it and **do not**
  merely bump an expected count without extending the per-table loops.
- **GOTCHA**: the test's title string ("all 16 tenant tables…") is now wrong — 17. Update it; a
  count in a title that disagrees with the array is exactly the drift this file exists to prevent.
- **VALIDATE**: `npx dotenvx run -- npx vitest run packages/db/src/repositories/rls.int.test.ts` →
  all tests pass, **0 skipped**.

### 18. CREATE `packages/db/src/repositories/members.int.test.ts`

- **IMPLEMENT**: a **two-role** suite. Test 1 is the role-identity assertion, copied from
  `rbac.int.test.ts:175-188` (`is_superuser = 'off'`, `rolbypassrls = false`,
  `current_user = '420ai_app'`). Then:
  1. `listMembers` returns every member of org A and **no** member of org B (cross-tenant negative).
  2. `setMemberRole` demoting the last owner throws `MemberError("last_owner")` and the row is
     unchanged.
  3. `setMemberRole` demoting a *non-last* owner succeeds.
  4. `removeMember` on the last owner throws; on a member succeeds.
  5. `findMemberByEmail` is case-insensitive (`Owner@Example.com` finds `owner@example.com`) — the
     D-15.5-3 proof at the repository layer.
  6. `findMemberByEmail(db, orgB, "owner@example.com")` → `undefined` (the D-M15-8 proof: an admin
     of org B cannot resolve org A's member).
- **PATTERN**: `rbac.int.test.ts:78-172` for `beforeAll`/`afterAll`/`beforeEach` and the exact
  `TRUNCATE` list — **append `invites, password_reset_tokens`** to that list (both new tables must
  be truncated or tests leak state across files).
- **GOTCHA-1 restated**: seed the second-rung users by **MOVING** their auto-created membership
  (`UPDATE memberships SET org_id=…, role=…`), never by inserting a second one — see
  `rbac.int.test.ts:135-151`. Getting this wrong makes every role assertion secretly test an owner.
- **VALIDATE**: `npx dotenvx run -- npx vitest run packages/db/src/repositories/members.int.test.ts`
  → passes, 0 skipped.

### 19. CREATE `apps/ingest/src/identity.int.test.ts` — THE SLICE'S PROOF

- **IMPLEMENT**: a two-role, multi-user **HTTP** suite built on `buildApp({ db: appRole.db, … })`
  with an **injected fake mailer** (`{ appBaseUrl: "http://test.local", send: vi.fn() }`) so no test
  opens SMTP. Minimum coverage — each line is a decision this plan made, so a missing test is an
  unproven decision:

  1. **Role identity** (copy `rbac.int.test.ts:175-188`). First test, non-negotiable.
  2. **End-to-end invite**: admin invites `new@example.com` as `member` → the fake mailer received
     one message whose body contains the token → `GET /v1/auth/invites/:token` previews the org →
     `POST /v1/auth/invites/accept` with a password returns a session → **logging in with that
     session and calling `GET /v1/auth/me` reports `new@example.com`** → `GET /v1/members` now lists
     two members.
  3. **GOTCHA-1 regression (the test that must fail before Task 4)**: after accepting, assert the new
     user has **exactly one** membership and it is in the **inviting** org — `select org_id, role
     from memberships where user_id = …` returns one row, `orgId === orgA`, `role === 'member'`.
     Then drive a real request as them and assert `GET /v1/monitor` shows org A's machine. Build the
     accept path with `setUserPassword` instead of `createUserWithPassword` once, locally, and
     confirm this test **fails** — then revert. A test that never failed proves nothing.
  4. **Escalation guard**: an `admin` inviting `role: "owner"` → 403.
  5. **Existing-user rejection (D-15.5-9)**: inviting an email that already has a user → 409, and
     **no** `invites` row was written.
  6. **Viewer cannot invite** → 403; **and** the backstop below it: `withOrg(appRole.db, orgA,
     "viewer", tx => tx.insert(invites)…)` is an RLS rejection (reuse
     `rbac.int.test.ts:67-76`'s `expectRlsRejection`). Both layers, as 15.4 did.
  7. **Last-owner guard**: `DELETE /v1/members/:ownerId` on the sole owner → 409; the membership row
     survives.
  8. **Self-signup off by default**: `POST /v1/auth/signup` on the default app → 403. On a second
     app built with `selfSignupEnabled: true` → 200, **and** the new user is `owner` of a **new**
     org, not a member of org A (the D-15.5-6 proof).
  9. **Password reset round trip**: request → 202 → mailer got a token → confirm with a new password
     → old password 401s, new password 200s at `/v1/auth/login`. Plus: **a reset request for an
     unknown email also returns 202** and writes no token row (D-15.5-7, pinned so nobody turns it
     into a 404).
  10. **Reset token is single-use**: confirming twice → second call 410.
  11. **D-M15-8 closure**: `POST /v1/pairing-codes` with `{ email: "stranger@nowhere.test" }` → 404,
      **and `select count(*) from users where email='stranger@nowhere.test'` is 0.** The count is the
      real assertion; the status code alone would pass even if the row were created and then the
      lookup failed.
  12. **Email case-insensitivity end to end**: invite `New@Example.com`, accept, then log in as
      `new@example.com` → 200; and `select count(*) from users where lower(email)='new@example.com'`
      → exactly 1.

- **PATTERN**: `rbac.int.test.ts` in its entirety — file header explaining *why* two roles, the
  `login`/`asUser` helpers (`:112-123`), `expectRlsRejection` (`:55-76`), and the `beforeEach`
  TRUNCATE (extend it with the two new tables).
- **GOTCHA**: `await app.close()` **and** `await owner.pool.end()` **and** `await appRole.pool.end()`
  in `afterAll`, or vitest hangs on an open handle (`rbac.int.test.ts:105-110`).
- **GOTCHA**: `describe.skipIf(!TEST_URL || !APP_URL)` — both URLs, so pointing only one at the DB
  cannot produce a partially-meaningful green.
- **VALIDATE**: `npx dotenvx run -- npx vitest run apps/ingest/src/identity.int.test.ts` → all pass,
  0 skipped.

### 20. CREATE `apps/ingest/src/delivery/mailer.test.ts`

- **IMPLEMENT**: unit tests with `{ sendMail: vi.fn() }`: `createMailer(null)` → `null`;
  `send` forwards `from`/`to`/`subject`/`text` unchanged; a throwing transport propagates (the
  route layer decides what to do, not the mailer).
- **PATTERN**: `apps/ingest/src/delivery/smtp-deliverer.test.ts`.
- **VALIDATE**: `npx vitest run apps/ingest/src/delivery/mailer.test.ts` → passes with no DB.

### 21. UPDATE `SUMMARY.md` + write the execution report

- **IMPLEMENT**: flip **15.5** to ✅ in the §0 status block (line ~474) and the §6 roadmap (line
  ~243) with a `DONE <date> (PR #NN)` note; adjust the M15 status line if 15.5 was the last open
  slice (it is not — 15.6…15.10 remain). Write
  `.agents/execution-reports/m15-slice5-identity-core.md`.
- **GOTCHA**: same commit as the report — `scripts/check-summary.mjs` is the gate that fails the
  build when this is forgotten.
- **VALIDATE**: `npm run repo-health` → check 5 (SUMMARY consistency) passes.

---

## TESTING STRATEGY

### Unit Tests

Co-located `*.test.ts`, no infra: `mailer.test.ts` (injected fake transport) and any pure helper
(`normalizeEmail`). Existing `password.test.ts` / `session.test.ts` / `authorize.test.ts` must keep
passing untouched — if any changes, you altered a shared primitive you should not have.

### Integration Tests

Both new int suites are **two-role** and both open with the role-identity assertion. Per CLAUDE.md:
*"any slice that touches tenancy MUST carry a two-role suite"* — 15.5 adds a tenant table
(`invites`) and mutates `memberships`, so it does.

Split of responsibility, deliberately:

- `identity.int.test.ts` (HTTP) validates the **primary** defence — the route gates, the guards, the
  end-to-end flows.
- `members.int.test.ts` (repository) validates the **backstop and the predicates** — cross-tenant
  reads, the last-owner transaction guard.

This split is the 15.3 lesson: an endpoint-level suite validates the primary defence, because
explicit `orgId` predicates scope those reads on their own. Put backstop proof at the repository
layer.

### Edge Cases (each must have a named test)

- Invite: expired · already accepted · revoked · unknown token → 410 with distinct `reason`s.
- Invite for an email that already has a user → 409, **no row written**.
- `admin` inviting `owner` → 403 (escalation).
- `viewer` inviting anyone → 403 at the route **and** RLS rejection at the DB.
- Last owner: demote → 409; remove → 409; row survives both.
- Signup disabled (default) → 403. Enabled → new **personal** org, never an existing one.
- Reset for an unknown email → **202** and zero token rows.
- Reset token replay → 410.
- Reset with no mailer configured → 503.
- Pairing code for a non-member email → 404 and **zero** `users` rows created.
- `Foo@X.com` and `foo@x.com` resolve to one account throughout.
- Password change with a wrong `currentPassword` → 401.

---

## VALIDATION COMMANDS

Every command runs from the **repo root**.

### Level 1: Syntax, Style & Types

```bash
npm run typecheck          # root `tsc -b` across the four backend workspaces — MUST exit 0
npm run lint               # ESLint 9 flat config (NOT run by repo-health — CI runs it)
npm run format:check       # Prettier, incl. .md — CI runs this; local repo-health does not
```

Pass signal: all three exit 0.

### Level 2: Unit Tests

```bash
npx vitest run apps/ingest/src/delivery/mailer.test.ts
npx vitest run apps/ingest/src/routes/org-scoping.test.ts   # 11 structural assertions
npx vitest run packages/shared                              # roles ladder unchanged
```

Pass signal: exit 0; `org-scoping.test.ts` reports 11 passed.

### Level 3: Integration Tests (require a live DB)

```bash
npm run db:up
npm run db:migrate
# and MIGRATE THE TEST DB SEPARATELY — db:migrate targets DATABASE_URL only:
DATABASE_URL="$DATABASE_URL_TEST" npm run db:migrate

npx dotenvx run -- npx vitest run apps/ingest/src/identity.int.test.ts
npx dotenvx run -- npx vitest run packages/db/src/repositories/members.int.test.ts
npx dotenvx run -- npx vitest run packages/db/src/repositories/rls.int.test.ts
npx dotenvx run -- npx vitest run apps/ingest/src/rbac.int.test.ts   # 13 tests — must stay green
```

Pass signal: every file passes with **0 skipped**. A skipped int file is not a pass
(`skipped ≠ passed`), and a suite that only ever used `DATABASE_URL_TEST` proves nothing about
isolation (`bypassed ≠ enforced`).

### Level 4: THE GATE

```bash
npm run repo-health -- --require-db
```

Pass signal: exit 0. This is the only command that proves (a) the root typecheck is clean,
(b) `DATABASE_URL_TEST_APP` really connects as a non-bypassing role, (c) **0** integration tests
self-skipped, (d) no NUL bytes / stray artifacts, (e) SUMMARY.md is consistent.

### Level 5: Manual Validation

```bash
# 1. Boot with signup OFF (the default) and no SMTP.
ADMIN_TOKEN=… SESSION_SECRET=… ADMIN_PASSWORD=… npm run ingest:dev

# 2. Log in, invite a colleague, get the token back in the response (D-15.5-10).
curl.exe -s -X POST localhost:8420/v1/auth/login -H "content-type: application/json" -d "@login.json"
curl.exe -s -X POST localhost:8420/v1/members/invite -H "authorization: Bearer <session>" \
  -H "content-type: application/json" -d "@invite.json"

# 3. Accept it, then confirm the new user resolves to the INVITING org (the GOTCHA-1 check).
curl.exe -s -X POST localhost:8420/v1/auth/invites/accept -H "content-type: application/json" -d "@accept.json"
curl.exe -s localhost:8420/v1/auth/me -H "authorization: Bearer <new-session>"

# 4. Signup is refused by default.
curl.exe -s -X POST localhost:8420/v1/auth/signup -H "content-type: application/json" -d "@signup.json"
#    → 403 {"error":"self-signup is disabled"}

# 5. The closed primitive.
curl.exe -s -X POST localhost:8420/v1/pairing-codes -H "authorization: Bearer <session>" \
  -H "content-type: application/json" -d "{\"email\":\"stranger@nowhere.test\"}"
#    → 404, and `select count(*) from users where email='stranger@nowhere.test'` is 0.
```

> Use `curl.exe` with **file-based** JSON bodies in PowerShell — bare `curl` is an alias for
> `Invoke-WebRequest` and `\"` escaping does not survive.

Evidence goes under `.agents/qa/m15-signoff/` per D-M15-13.

---

## ACCEPTANCE CRITERIA

- [ ] An org owner can invite, list, re-role and remove members over HTTP.
- [ ] An invited user accepts with a password and lands with **exactly one** membership, in the
      **inviting** org, at the **invited** role — asserted by a test that fails if
      `setUserPassword` is used in place of `createUserWithPassword`.
- [ ] Password reset works end to end and the token is single-use.
- [ ] Self-signup is **off** by default and refused with 403; when enabled it creates a new personal
      org and never joins an existing one.
- [ ] `POST /v1/pairing-codes` creates **zero** `users` rows under any input (D-M15-8 closed), proven
      by a `count(*)` assertion, not only a status code.
- [ ] `grep -rn "insert(users)" apps/ingest/src packages/db/src --include=*.ts | grep -v test`
      returns **only** `packages/db/src/repositories/users.ts`.
- [ ] Emails are case-insensitive end to end; migration 0017 lowercased existing rows.
- [ ] `invites` carries 1 bootstrap-permissive org policy + 3 restrictive role-write policies;
      `password_reset_tokens` carries none — asserted by the extended `rls.int.test.ts` inventory
      keyed on `(tablename, policyname)`.
- [ ] Both new int suites are two-role and open with the role-identity assertion.
- [ ] `npm run repo-health -- --require-db` exits 0 with **0 skipped** integration tests.
- [ ] `npm run lint` and `npm run format:check` exit 0 (CI runs both; `repo-health` runs neither).
- [ ] `npm run db:rollback` reverses 0017 cleanly and `npm run db:migrate` re-applies it.
- [ ] `SUMMARY.md` marks 15.5 ✅ in §0 and §6, in the same commit as the execution report.
- [ ] No dashboard, collector or Rust file changed (15.10 owns the team UI).

---

## COMPLETION CHECKLIST

- [ ] All 21 tasks completed in order
- [ ] Each task's `VALIDATE` command run immediately, not batched to the end
- [ ] Level 1-4 validation commands all executed and green
- [ ] `identity.int.test.ts` test 3 confirmed to **fail** under the wrong (`setUserPassword`)
      implementation before being left green
- [ ] `org-scoping.test.ts` allow-list entry for `pairing-codes.ts` removed (not merely re-worded)
- [ ] Manual validation performed; evidence under `.agents/qa/m15-signoff/`
- [ ] Execution report written; `SUMMARY.md` updated in the same commit

---

## NOTES

### Spikes actually run during planning (with output)

**Spike 1 — do 0015's `ALTER DEFAULT PRIVILEGES` cover a table created by a LATER migration?**
This gates whether 0017 must re-`GRANT`. Run live against `420ai_test` with both roles:

```
SPIKE1 app-role INSERT on brand-new table: OK 1
SPIKE1 app-role SELECT: 1
```

**Result: yes.** A table the owner created seconds earlier was immediately INSERT/SELECT-able by
`420ai_app` with no explicit grant. 0017 therefore needs no `GRANT` statement. (Throwaway table
dropped.)

**Spike 2 — does `nodemailer` resolve for `apps/ingest`?**

```
420ai@0.0.0 C:\Users\seanr\OneDrive\Documents\420AI
└─┬ @420ai/ingest@0.0.0 -> .\apps\ingest
  └── nodemailer@9.0.3
```

**Result: yes, 9.0.3, already a direct dependency.** No new package, and no `@types/nodemailer` in
`devDependencies` — nodemailer ships its own types, which is why `smtp-deliverer.ts:58` casts
through `as unknown as MailTransport`. Keep the cast.

**Spike 3 — is `users.email` case-sensitive?**

```
SPIKE3 users indexes: CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)
                    | CREATE UNIQUE INDEX users_email_unique ON public.users USING btree (email)
SPIKE3 users cols: [{"column_name":"id","data_type":"uuid"},
                    {"column_name":"created_at",...},
                    {"column_name":"email","data_type":"text"},
                    {"column_name":"password_hash","data_type":"text"}]
```

**Result: yes — plain `text`, plain btree, no `citext`, no functional index.** `Foo@x.com` and
`foo@x.com` are two accounts today. This is what produced D-15.5-3, and it was *not* in the original
slice description; it surfaced only by looking.

**Spike 4 — is the two-role harness this plan tells the executor to mirror actually healthy?**

```
npx dotenvx run -- npx vitest run apps/ingest/src/rbac.int.test.ts
 Test Files  1 passed (1)
      Tests  13 passed (13)
   Duration  7.33s
```

**Result: yes.** The test DB is migrated through 0016, `DATABASE_URL_TEST` and
`DATABASE_URL_TEST_APP` are both configured in `.env`, and `npx dotenvx run --` is the working
invocation for a focused int-test run. So every `VALIDATE` command in this plan is executable as
written.

### Design trade-offs worth recording

- **Why reject an invite to an existing user (D-15.5-9) instead of supporting multi-org?** Because
  `findPrincipalByEmail` resolves the first membership by `(created_at, id)` and every existing user
  already has a personal org that predates any invite. Supporting it properly needs a default-org or
  an org switcher, which is 15.10. Shipping the insert without that would be a path that reads as
  working and is not — the exact failure class CLAUDE.md's "silent" lessons keep naming.
- **Why `invites` gets role-write policies when the other bootstrap tables do not.** The other three
  are written by machine paths with no membership role. An invite is written by a principal and
  grants privilege. This is the first table in the repo with that combination, which is why it
  earns a third classification constant in `rls.int.test.ts` rather than being forced into one of
  the existing two.
- **Why no session invalidation on password change.** Sessions are stateless HMACs until 15.6
  (D-M15-12). A partial revocation now would be indistinguishable from working revocation and would
  make 15.6's real implementation harder to verify.
- **Scope explicitly NOT in this slice**: any dashboard UI (15.10), SSO/OAuth (15.7), MFA (15.8),
  API keys and `ADMIN_TOKEN` retirement (15.9), the audit table (15.10), stateful sessions and
  revoke-all (15.6).

### Branch & PR

Planned on `m15-slice5-identity-core`, branched from `m15-slice4-rbac` because 15.5 builds directly
on 15.4's role ladder (`authorized`, `SERVICE_ROLE`, the restrictive-policy convention). **PR #64
(15.4) is still open.** Per the stacked-PR rule: merge #64 into `main` first, or retarget this
branch to `main` **before** #64's branch is deleted — deleting a base branch auto-closes the child
PR rather than retargeting it.

### Confidence

**9.5 / 10** for one-pass success. Backed by: four spikes run live during planning (above, with
output); every imported symbol read from source and cited with file:line; the test harness confirmed
green at 13/13; every conflicting instruction resolved in the DESIGN DECISIONS section (D-15.5-1…13)
rather than left for the executor.

The residual 0.5 is one thing only: **the exact drizzle-kit-generated DDL for the two new tables is
not transcribed here** (the hash-suffixed migration filename cannot be known before
`npm run db:generate` runs). The executor must generate it and then hand-append the policy block
given verbatim in Task 2. This is mechanical, and Task 2's `VALIDATE` (a `pg_policies` query
expecting exactly 4 rows for `invites`) catches a mistake immediately.
