# Feature: M15 Slice 15.7 — SSO (Google + GitHub)

The following plan should be complete, but it is important that you validate documentation, codebase
patterns and task sanity before you start implementing. Pay special attention to the naming of
existing utils, types and models — import from the right files.

Conventions are **not** restated here. The source of truth is [`CLAUDE.md`](../../CLAUDE.md); the
milestone context is [`.agents/plans/m15-multi-user-access-control.md`](./m15-multi-user-access-control.md)
and the shipped-state narrative is [`SUMMARY.md`](../../SUMMARY.md) §6.

## Feature Description

15.5 shipped four ways to become a 420AI user (admin-creates, invite, gated self-signup, password
reset) and 15.6 made the resulting session revocable. All of them are **password** credentials. This
slice adds the fifth: **OAuth identity** via Google and GitHub (D-M15-5), for *identity only* — no
Octokit, no GitHub API access, no repo scopes. It is the last identity path before 15.8 (MFA).

The OAuth plumbing is the easy half. The half that matters, and the reason the milestone sized this
**L**, is **account linking**: the rules that decide whether an incoming Google identity claiming
`alice@corp.com` may be admitted as the existing `alice@corp.com` account. Get that wrong and SSO is
an account-takeover primitive rather than a login convenience — which is precisely why D-M15-8 (close
the pairing-code user-creation hole) was made a **hard prerequisite** of this slice and landed in 15.5.

## User Story

As a **member of a 420AI organization**
I want to **sign in with my existing Google or GitHub account, and attach that identity to the
account I already have**
So that **I stop managing another password — without that convenience ever becoming a way for
somebody else to walk into my account by asserting my email address**

## Problem Statement

1. **Every credential in the product is a password.** Team onboarding means choosing yet another
   password, and the operator's only lever on credential quality is `MIN_NEW_PASSWORD_LENGTH`.
2. **The obvious implementation is a takeover vector.** "Look up the user by the email the provider
   asserts, log them in" is the default shape of every OAuth tutorial. Against this codebase it is
   exploitable in a specific, concrete way: `users` rows exist that **nobody ever verified**, and
   until 15.5 anyone holding `ADMIN_TOKEN` could mint one for an arbitrary address
   (`POST /v1/pairing-codes`, audit finding C.9). Auto-adoption would turn a stale pre-seeded row
   into a live account for whoever controls that mailbox at a provider.
3. **SSO can silently reopen a door D-M15-6 deliberately shut.** Self-signup is OFF by default. An
   SSO callback that creates a user on first sight is self-signup wearing a different hat, and it
   would ship enabled by accident on every deployment that sets a client ID.
4. **15.8 (MFA) wants a second factor to sit behind a first factor that is not always a password.**

## Solution Statement

A `sso_identities` table keyed on **`(provider, subject)`** — the provider's own immutable user id,
never the email — plus a small injectable `SsoProvider` abstraction (the shape `analysisProvider` /
`mailer` / `alertDeliverer` already use), plus one resolution function whose branches ARE the
anti-takeover policy:

| # | Situation | Outcome |
| --- | --- | --- |
| 1 | `(provider, subject)` already linked | log in as that user — **email is not consulted** |
| 2 | provider says the email is **not verified** | `403 email_unverified` |
| 3 | a valid **invite token** rides along and its email equals the verified provider email | create user + membership in the inviting org, link |
| 4 | a `users` row already exists for that email | **`409 link_required`** — never adopted |
| 5 | no user, and `SSO_SIGNUP_ENABLED=true` | create user + personal org, link |
| 6 | no user, signup disabled | `403 signup_disabled` |

Branch 4 is the whole slice. Its escape hatch is an **authenticated** link endpoint: log in the way
you already can, then attach the provider identity deliberately.

The proof is a two-role HTTP suite whose discriminating assertion is that a **verified** Google
identity asserting a **pre-existing** address is refused — see
[THE ANTI-TAKEOVER ASSERTION](#the-anti-takeover-assertion), which is the part of this plan most
likely to be got wrong.

## Feature Metadata

**Feature Type**: New Capability (identity path)
**Estimated Complexity**: High (the milestone sizes it **L**)
**Primary Systems Affected**: `packages/db` (schema + migration `0019` + one new repository + one new
`users` function), `apps/ingest` (new `src/sso/**`, new `routes/sso.ts`, `app.ts`, `server.ts`,
`schemas.ts`), `apps/dashboard` (login page + two route handlers + settings section)
**Dependencies**: **none new.** No OAuth library, no JWT library, no Octokit — plain `fetch` +
`node:crypto`, exactly as `analysis/anthropic.ts` does it (Scope Decision 3).

---

## SCOPE DECISIONS SETTLED WITH THE USER (2026-07-29) — do not re-litigate

- **All three onboarding paths ship**: authenticated link, gated SSO signup, and invite-acceptance
  via SSO. Rationale: self-signup is off by default, so without invite-via-SSO a new teammate could
  never *arrive* through SSO — it would only ever be a convenience for accounts that already exist.
- **A separate `SSO_SIGNUP_ENABLED` flag, default off** — not a reuse of `SELF_SIGNUP_ENABLED`. The
  two are genuinely different risks, and an operator running "anyone with a company Google account
  may self-provision, password signup stays shut" must be able to say so.
- **Dashboard ships login buttons AND a link/unlink surface** (folded into the existing
  `/settings` page, not a new route). Without it, branch 4's escape hatch is curl-only and SSO is
  unusable for every account that already exists — which is all of them.
- **Google and GitHub together.** GitHub is the awkward one on purpose: no `id_token`, and the
  verified-email flag lives behind a second API call. Building both at once is what stops the
  abstraction from being Google-shaped.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

| File | Why |
| --- | --- |
| `apps/ingest/src/routes/auth.ts` (lines 56-92, 211-310) | `mintSession` — **reuse it verbatim, do not re-implement**. Also the invite-accept and signup handlers, whose transaction shape branches 3 and 5 mirror exactly (including the "escape the transaction by RETURNING, never an outer `let`" rule at :246-251). |
| `apps/ingest/src/auth.ts` (lines 50-115) | `resolvePrincipal` / `authorized` / `isUuid`. SSO adds **no** new enforcement point — it mints an ordinary 15.6 session and everything downstream is unchanged. |
| `apps/ingest/src/analysis/provider.ts` (all 79 lines) | **The template for `sso/provider.ts`.** Injected-provider interface, `createX(cfg \| null)`, a `notConfigured()` stand-in that boots cleanly and only fails its own endpoints, and a typed error with a `kind` the app-level handler maps to 502/503. |
| `apps/ingest/src/analysis/anthropic.ts` (all 68 lines) | The outbound-`fetch` discipline to copy exactly: `AbortSignal.timeout(cfg.timeoutMs)`, non-200 → typed error, `catch` that re-throws its own error type and wraps everything else. |
| `apps/ingest/src/app.ts` (lines 46-93, 122-152, 204-236) | `BuildAppOptions` + the decorate block + the `setErrorHandler` chain you extend with `SsoProviderError`. |
| `apps/ingest/src/server.ts` (lines 124-167, 210-225) | Env plumbing. Note `SMTP_URL || ALERT_SMTP_URL` at :145 and its comment — **the `||`-not-`??` rule** (CLAUDE.md). `APP_BASE_URL` is already read at :154; SSO reuses it. |
| `packages/db/src/repositories/sessions.ts` | The 15.6 repository — the closest structural sibling to the one you are adding (identity-owned, `userId`-scoped, explicit column list, no `orgId` parameter at all). |
| `packages/db/src/repositories/users.ts` (all 158 lines) | `normalizeEmail` (:21) and **`createUserWithPassword` (:134) with its D-15.5-9 doc comment** — you add a no-password sibling and that comment explains why it must NOT call `ensurePersonalOrg`. |
| `packages/db/src/repositories/invites.ts` (lines 107-148) | `findInviteByToken` (throws `InviteError`, takes no `orgId`, must not be wrapped in `withOrg`) and `acceptInvite` (stamps + inserts EXACTLY ONE membership). Branch 3 calls both. |
| `packages/db/src/repositories/rls.int.test.ts` (lines 135-151, 470-546) | `NO_RLS_TABLES` — you add exactly one entry. Every policy count is *derived*, so adding it changes no number; the "all 17 tenant tables" count must stay 17. |
| `packages/db/drizzle/0018_warm_living_mummy.sql` (lines 1-12) | The hand-edited header convention for a no-policy identity table, including the "no `GRANT` needed and here is why" paragraph. Re-verified for this table by SPIKE 1 below. |
| `apps/ingest/src/identity.int.test.ts` (lines 1-200) | **The harness you extend.** `describe.skipIf(!TEST_URL \|\| !APP_URL)`, the `owner`/`appRole` split, `buildApp({db: appRole.db, …})`, `login()`/`asUser()`/`json()`, `inviteAndCollect()`, the `beforeEach` TRUNCATE, and the `afterAll` that closes the app **and both pools**. |
| `apps/dashboard/src/app/api/auth/login/route.ts` (all 50 lines) | **The cookie-setting pattern the SSO callback reuses exactly**, including the `sessionConfigError()` loud-failure guard. |
| `apps/dashboard/src/app/api/auth/logout/route.ts` | The `proxyJson` + cookie-mutation shape, and the tone of the "best-effort hop" comment. |
| `apps/dashboard/src/components/auth/login-form.tsx` (lines 34-45) | The **same-origin redirect guard** (`startsWith("/") && !startsWith("//") && !startsWith("/\\")`) — the SSO callback's `next` handling must reuse it or an open redirect ships. |
| `apps/dashboard/src/middleware.ts` (line 19) | `pathname.startsWith("/api/auth/")` already exempts every new SSO route handler. **No middleware change is needed** — confirm, do not edit. |

### New Files to Create

- `packages/db/src/repositories/sso-identities.ts` — link / find / list / unlink (+ the credential guard)
- `packages/db/src/repositories/sso-identities.int.test.ts` — repository-level two-role suite
- `packages/db/drizzle/0019_<generated>.sql` + `down/0019_<generated>.down.sql`
- `apps/ingest/src/sso/provider.ts` — `SsoProvider` / `SsoProfile` / `SsoProviderError` / `createSsoProviders`
- `apps/ingest/src/sso/google.ts`, `apps/ingest/src/sso/github.ts`
- `apps/ingest/src/sso/pkce.ts` (+ `pkce.test.ts`)
- `apps/ingest/src/sso/google.test.ts`, `apps/ingest/src/sso/github.test.ts` — the pure halves
- `apps/ingest/src/routes/sso.ts` — six endpoints
- `apps/ingest/src/sso.int.test.ts` — **the HTTP-level two-role behavioural suite (the centrepiece)**
- `apps/dashboard/src/app/api/auth/sso/[provider]/start/route.ts`
- `apps/dashboard/src/app/api/auth/sso/[provider]/callback/route.ts` (+ `route.test.ts`)
- `apps/dashboard/src/components/settings/sso-links.tsx`

### Relevant Documentation — VERIFIED LIVE DURING PLANNING (2026-07-29)

- [Google OpenID Connect discovery document](https://accounts.google.com/.well-known/openid-configuration)
  - Fetched and read. `authorization_endpoint` = `https://accounts.google.com/o/oauth2/v2/auth`;
    `token_endpoint` = `https://oauth2.googleapis.com/token`; `userinfo_endpoint` =
    `https://openidconnect.googleapis.com/v1/userinfo`; `code_challenge_methods_supported` includes
    **`S256`**; `claims_supported` includes **`email_verified`**.
  - Why: every literal in `sso/google.ts` comes from here, not from memory.
- [Google — OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server)
  - Authorization params (`client_id`, `redirect_uri`, `response_type=code`, `scope`, `state`) and the
    token-exchange body (`client_id`, `client_secret`, `code`, `grant_type=authorization_code`,
    `redirect_uri`).
- [GitHub — Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
  - `GET https://github.com/login/oauth/authorize`; `POST https://github.com/login/oauth/access_token`
    which **returns form-encoded unless you send `Accept: application/json`**; response is
    `{access_token, scope, token_type}` and there is **no `id_token`**.
- [GitHub REST — Emails](https://docs.github.com/en/rest/users/emails)
  - `GET /user/emails` requires scope **`user:email`**; each element is
    `{email, primary, verified, visibility}`. Headers `Accept: application/vnd.github+json` and
    `X-GitHub-Api-Version: 2026-03-10`.
- [OpenID Connect Core §3.1.3.7 — ID Token Validation](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)
  - Why: the normative basis for **D-15.7-2** (we do not verify the `id_token` signature, because we
    never receive it over an untrusted channel).
- [OWASP — Authorization Cheat Sheet, "Enforce Authorization Checks on Static Resources"/state](https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html)
  - Why: the `state` + PKCE requirements and the rule that `redirect_uri` must never be caller-supplied.

### Patterns to Follow

**Injected provider, deterministic in tests.** `sso/provider.ts` mirrors `analysis/provider.ts`
one-for-one: an interface, a `createSsoProviders(cfg)` factory, and `BuildAppOptions.ssoProviders`.
Every automated test injects a stub; **the live `fetch` runs only in `server.ts` and Level-4 manual
validation.** This is what makes an OAuth slice testable at all.

**Silent library.** `packages/db/src/repositories/sso-identities.ts` never logs and never exits. It
returns `undefined` for "not found" and throws exactly one typed error (`SsoIdentityError`) for the
one case a caller must distinguish: unlinking the last credential.

**Explicit column lists** (CLAUDE.md 15.1). `listSsoIdentities` rows reach `reply.send()`, so it uses
an `ssoIdentityRowColumns` constant mirroring the exported `SsoIdentityRow` interface. Never a bare
`select()`. Note what the list deliberately **omits**: `subject`. It is the provider's stable
identifier and has no business on the wire.

**`orgId` is always the SECOND parameter — and this repository has none at all**, exactly as
`sessions.ts` has none, and for the same reason (D-15.7-3): an SSO identity belongs to a *user*.
Where scoping is needed it is `userId`, and it is always second.

**Timestamps.** Every column is read through drizzle's typed select, never a raw `sql` aggregate, so
the `mode:"string"` gotcha does not apply. `SsoIdentityRow` carries `Date`; the route calls
`.toISOString()`, mirroring `GET /v1/auth/sessions` at `routes/auth.ts:480-486`.

> **Spike-snippet fidelity:** the migration header in Task 2 asserts that the app role receives its
> grants implicitly. That is not inherited belief — SPIKE 1 below created this exact table shape and
> read `information_schema.role_table_grants`. If you change the table's shape, re-run the spike
> rather than transcribing the claim.

---

## THE ANTI-TAKEOVER ASSERTION

This section exists because it is the part most likely to be implemented as theatre. Read it before
writing any test.

### Why 15.6's discriminator shape does not transfer unchanged

15.6 proved revocation by showing a token was **rejected while still cryptographically valid** — the
positive and negative facts about the *same* token. Here the failure has a different silhouette:
**an over-permissive SSO login looks exactly like a successful one.** It returns 200, it mints a real
session, the user reaches the dashboard, and every existing test stays green — because every existing
test logs in as somebody who is legitimately themselves. Nothing anywhere reports that the identity
was adopted rather than authenticated.

So the discriminating fact is not "valid yet rejected". It is: **the same provider response is
admitted in one world and refused in the other, and the ONLY difference between the two worlds is
whether a `users` row already existed.**

### The five assertions, and what each one excludes

A suite that omits any one of these is not proof.

**1 — Role identity (first test in the file, exactly as `rls.int.test.ts:200` and
`identity.int.test.ts` do it).** Assert `current_setting('is_superuser') = 'off'` **and**
`rolbypassrls = false` for the handle the app is built on. This slice adds no policy, but the app
still runs as `420ai_app` and a missing `GRANT` on `sso_identities` is a real shippable bug that only
a non-owner handle can see. SPIKE 1 says the grant arrives implicitly; this test is what keeps that
true.

**2 — The POSITIVE assertion (the `delivered.length > 0` lesson).** With `ssoSignupEnabled: true` and
a clean database, a Google callback for a **new** verified address must return a token **and that
token must authenticate**: `GET /v1/auth/me` → **200**, `email` equal to the provider's address. A
resolver that refuses *everything* — a typo'd column, a missing grant, a stub wired wrong — is
indistinguishable from correct anti-takeover policy if you only ever assert failures.

**3 — THE DISCRIMINATOR: same provider response, opposite outcome, one row of difference.**

```ts
it("a VERIFIED provider identity does NOT adopt a pre-existing account", async () => {
  // (2) POSITIVE FIRST, in the SAME shape — prove this exact callback succeeds when the address
  //     is genuinely new, so the 409 below cannot be blamed on the stub, the wiring or the flag.
  googleStub.profile = { subject: "g-newcomer", email: "newcomer@example.com", emailVerified: true };
  const ok = await ssoCallback("google");
  expect(ok.statusCode, "a brand-new verified identity must be admitted").toBe(200);

  // THE ONLY DIFFERENCE: `victim@example.com` already has a `users` row. Note it is a PRE-SEEDED
  // one (password_hash NULL) — the exact artefact D-M15-8 was written about, and the row an
  // auto-adopting implementation hands over. Its email is IDENTICAL to what the provider asserts,
  // and the provider says `emailVerified: true`, so nothing about the provider's answer explains
  // the refusal. The `users` row is the only variable.
  googleStub.profile = { subject: "g-attacker", email: "victim@example.com", emailVerified: true };
  const res = await ssoCallback("google");

  expect(res.statusCode, "a pre-existing account must never be adopted").toBe(409);
  expect(res.json().reason).toBe("link_required");

  // …and the refusal must be TOTAL, not merely a non-200. A handler that 409s after having
  // already written the link, or after minting a session, has still performed the takeover.
  expect(res.json().token, "no session may be issued on a refused link").toBeUndefined();
  const linked = await owner.db.execute(
    sql`select count(*)::int as n from sso_identities where subject = 'g-attacker'`,
  );
  expect(linked.rows[0]!.n, "no identity row may be written on a refused link").toBe(0);
});
```

**4 — The ISOLATION assertion.** `(provider, subject)` is the key, so two providers may share a
subject string and must not collide (SPIKE 2 proved the index permits it): linking GitHub subject
`"12345"` must not log anyone in as Google subject `"12345"`. A resolver that looked up by `subject`
alone would pass every other test in this file.

**5 — The UNLINK-LOCKOUT assertion.** An SSO-created user has `password_hash = NULL`. Unlinking their
only provider would leave an account **no credential on earth can open**. Assert the unlink is refused
with `409 last_credential`, and assert the positive complement — a user who *also* has a password, or
a second linked provider, unlinks successfully. Without the positive half this is another
"rejects-everything" test.

### The mutation check (run it, record the result in the execution report)

Assertion 3 claims to discriminate. **Verify that claim the way 15.3 and 15.6 verified theirs** — by
breaking the thing and watching the right test fail:

1. In `resolveSsoLogin`, delete branch 4 (the `findUserIdByEmail` → `link_required` check) so an
   existing user is adopted, which is the bug this slice exists to prevent.
2. Run `npx vitest run apps/ingest/src/sso.int.test.ts`.
3. **Expected:** the takeover test (3) FAILS — and it must fail on the **409 expectation**, not on a
   later assertion, because an adopting implementation returns a clean 200. Tests 1 (role identity),
   2 (positive), 4 (isolation) and 5 (unlink) still PASS.
4. Restore the branch.

If the positive test fails too, the suite is over-coupled and cannot tell "the policy works" from
"SSO works" — fix the suite before shipping. **Record the observed pass/fail split in the execution
report**; "I ran it and it failed" is not the finding, *which* tests failed is.

---

## IMPLEMENTATION PLAN

### Phase 1 — Foundation (schema + migration + repositories)

Tasks 1-6. Additive only. At the end `tsc -b` and the whole suite pass with zero behaviour change,
because nothing calls the new code yet.

### Phase 2 — Core (provider abstraction)

Tasks 7-10. The `SsoProvider` interface, PKCE, and the two clients. Still no route change — the
providers are pure functions plus `fetch`, and their pure halves get unit tests here.

### Phase 3 — Integration (routes + wiring + dashboard)

Tasks 11-16. The six ingest endpoints, `buildApp`/`server.ts` wiring, and the browser surface.

### Phase 4 — Testing & docs

Tasks 17-20. The two integration suites, the mutation check, and the SUMMARY/execution-report update
**in the same commit** (CLAUDE.md's rebuildable-projection rule).

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Each task carries its own validation command.

### 1. ADD `sso_identities` to `packages/db/src/schema.ts`

- **IMPLEMENT**: a new `pgTable` immediately after `sessions` (line 254), keeping the identity tables
  contiguous:

  ```ts
  /**
   * M15 15.7 — a linked external identity (D-M15-5). An IDENTITY table: no `org_id` and therefore
   * NO RLS, for the same reason `users`/`memberships`/`password_reset_tokens`/`sessions` carry none
   * (D-15.3-4 / D-15.5-1 / D-15.6-3 / D-15.7-3). It is read at the one moment before any org context
   * exists, because resolving this row is part of what establishes it.
   *
   * THE UNIQUE KEY IS `(provider, subject)`, AND `subject` IS THE PROVIDER'S IMMUTABLE ID — never a
   * username, never an email (D-15.7-1). GitHub `login` is renameable and a released handle can be
   * re-registered by somebody else; a Google address can be deleted and re-issued inside a Workspace
   * domain. Keying on either would let one person inherit another's account by acquiring a string.
   * So: Google's `sub`, GitHub's numeric `id`.
   *
   * `email` is stored for DISPLAY AND AUDIT ONLY and is deliberately NOT unique and NOT a lookup
   * key. It records what the provider asserted at link time; it is never how a login is resolved,
   * which is the single rule that makes auto-adoption unrepresentable rather than merely unwritten.
   *
   * There is no `access_token` / `refresh_token` column, and that absence is the decision
   * (D-15.7-5): this is identity, not API access. We never call a provider on the user's behalf
   * after the login completes, so storing a live provider credential would add a breach liability
   * that buys nothing.
   */
  export const ssoIdentities = pgTable(
    "sso_identities",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      userId: uuid("user_id")
        .notNull()
        .references(() => users.id),
      // `google` | `github` — TEXT with no CHECK, matching how `memberships.role` models a closed
      // set (the legal values live in code, so adding one is not a migration).
      provider: text("provider").notNull(),
      subject: text("subject").notNull(),
      // Lowercased via `normalizeEmail` at the boundary, like `invites.email`. Nullable: a GitHub
      // account with no verified address links only through an already-authenticated user.
      email: text("email"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      uniqueIndex("sso_identities_provider_subject").on(t.provider, t.subject),
      index("sso_identities_by_user").on(t.userId),
    ],
  );
  ```

- **PATTERN**: `packages/db/src/schema.ts:239-254` (`sessions`) — same column vocabulary, same FK
  style, same `<table>_by_<column>` index naming, same `uniqueIndex` usage as
  `memberships_org_user` (:91).
- **IMPORTS**: none new — `pgTable`, `uuid`, `text`, `timestamp`, `index`, `uniqueIndex` are all
  already imported.
- **GOTCHA**: one user may hold **several** identities (a Google *and* a GitHub link), so
  `sso_identities_by_user` is a plain index, **not** unique. A `uniqueIndex` there would silently cap
  every account at one provider and the failure would look like "GitHub linking is broken".
- **VALIDATE**: `npm run typecheck`

### 2. GENERATE + HAND-EDIT migration `0019`

- **IMPLEMENT**: run `npm run db:generate`, then hand-append a header comment to the generated
  `packages/db/drizzle/0019_<generated>.sql` in 0018's style:

  ```sql
  -- M15 15.7 SSO identities (D-M15-5; D-15.7-1…5). The generated DDL below is used AS IS: like 0018
  -- and unlike 0015/0016/0017 this migration appends NO policy block, and that absence is the
  -- decision rather than an omission. `sso_identities` is an IDENTITY table (D-15.7-3) — keyed by
  -- `user_id` with no `org_id` — read at the one moment before any org context exists, because
  -- resolving this row is part of what establishes it. It joins `users`, `organizations`,
  -- `memberships`, `password_reset_tokens` and `sessions` in rls.int.test.ts's NO_RLS_TABLES, which
  -- asserts it carries NO policy at all.
  --
  -- No `GRANT` statement is needed and its absence is not a bug: 0015's
  -- `ALTER DEFAULT PRIVILEGES … TO "420ai_app"` covers tables created by the migration owner.
  -- RE-VERIFIED live against 420ai_test during planning for THIS table shape (SPIKE 1) — the app
  -- role was granted DELETE, INSERT, SELECT, UPDATE implicitly, and inserted a row with no explicit
  -- grant. The table was also confirmed to come up with relrowsecurity = false and zero policies.
  ```

- **PATTERN**: `packages/db/drizzle/0018_warm_living_mummy.sql:1-12`.
- **GOTCHA**: the tag is generated (`0019_<random_marvel_name>`); use whatever `db:generate` emits in
  the down-file name too. Do **not** hand-write `meta/_journal.json` — `db:generate` maintains it, and
  `idx` must be **19** (the journal currently holds 19 entries, `idx` 0-18).
- **VALIDATE**: `npm run db:migrate` then
  `docker exec 420ai-archive psql -U 420ai -d 420ai -c "\d sso_identities"` shows the table with both
  indexes.

### 3. CREATE `packages/db/drizzle/down/0019_<generated>.down.sql`

- **IMPLEMENT**:

  ```sql
  -- Down-migration for 0019 (M15 15.7). A bare DROP TABLE: `sso_identities` carries no policy and no
  -- RLS switch, so there is no policy-ordering hazard of the kind 0015-0017's downs had to navigate.
  --
  -- D-M15-13 rollback-drill note: this DOES discard data — every provider link. The cost is that
  -- each user must re-link after rolling forward again. It is NOT a lockout for a user who also has
  -- a password, but it IS one for an SSO-created user (`password_hash` IS NULL), who must go through
  -- password reset to regain access. No `users`, `memberships` or `sessions` row is touched, and
  -- pre-0019 code ignores the table entirely.
  DROP TABLE IF EXISTS "sso_identities";
  ```

- **PATTERN**: `packages/db/drizzle/down/0018_warm_living_mummy.down.sql` — note it states what the
  rollback discards, which the D-M15-13 drill depends on.
- **VALIDATE**: `npx vitest run packages/db/src/rollback.int.test.ts`

### 4. ADD `createUserWithoutPassword` to `packages/db/src/repositories/users.ts`

- **IMPLEMENT**: a sibling of `createUserWithPassword` (:134), immediately after it:

  ```ts
  /**
   * M15 15.7 — create a user who has NO password, for an SSO-only account, returning its id. Like
   * its password-bearing sibling above it deliberately does NOT call `ensurePersonalOrg`, and for
   * exactly the same reason (D-15.5-9 / GOTCHA-1): the SSO invite-acceptance path inserts its one
   * membership through `acceptInvite`, and a personal `owner` membership created first would shadow
   * it forever, because `findPrincipalByEmail` resolves the FIRST membership by (created_at, id).
   * The SSO *signup* path is the other case and calls `ensurePersonalOrg` explicitly, exactly as
   * `POST /v1/auth/signup` does.
   *
   * `password_hash` stays NULL, which is not a gap but the whole point: `findAdminCredential`'s
   * callers already treat a null hash as "cannot log in with a password" (the generic 401 at
   * routes/auth.ts:159), so an SSO-only account is password-unopenable by construction rather than
   * by a check somebody has to remember to write. Such a user may still ADOPT a password later
   * through the ordinary reset flow, which requires control of the mailbox — that is a feature, and
   * it is also the recovery path named in the 0019 down-migration note.
   *
   * Throws on a duplicate email (the unique index) — callers check first and return 409.
   */
  export async function createUserWithoutPassword(db: DbClient, email: string): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({ email: normalizeEmail(email) })
      .returning({ id: users.id });
    return row!.id;
  }
  ```

- **PATTERN**: `createUserWithPassword` at `users.ts:134-144` — identical shape minus the hash.
- **GOTCHA**: do **not** reach for `ensureUserByEmail` (:41) instead. It calls `ensurePersonalOrg`
  and it is an UPSERT, so on the invite path it would both shadow the membership and silently
  succeed against an existing row — which is auto-adoption by another name.
- **VALIDATE**: `npm run typecheck`

### 5. CREATE `packages/db/src/repositories/sso-identities.ts`

- **IMPLEMENT**: five functions plus one typed error.

  ```ts
  import { and, desc, eq, ne } from "drizzle-orm";
  import type { DbClient } from "../client.js";
  import { ssoIdentities, users } from "../schema.js";
  import { normalizeEmail } from "./users.js";

  /**
   * The ONE exceptional condition in this repository. Everything else is a `undefined`/boolean that
   * a route turns into a status code; this is different because the caller must be able to say WHY
   * an unlink was refused, and "you would lock yourself out" is not something a boolean conveys.
   * Mirrors `MemberError`/`InviteError`; `app.ts` maps it to 409 with its `reason`.
   */
  export class SsoIdentityError extends Error {
    constructor(
      message: string,
      readonly reason: "last_credential" | "identity_taken",
    ) {
      super(message);
      this.name = "SsoIdentityError";
    }
  }

  /** Explicit column list — these rows reach `reply.send()` (CLAUDE.md 15.1). NOTE the deliberate
   * omission of `subject`: it is the provider's stable identifier and never belongs on the wire. */
  const ssoIdentityRowColumns = {
    id: ssoIdentities.id,
    provider: ssoIdentities.provider,
    email: ssoIdentities.email,
    createdAt: ssoIdentities.createdAt,
  };

  export interface SsoIdentityRow {
    id: string;
    provider: string;
    email: string | null;
    createdAt: Date;
  }

  /**
   * Resolve a provider identity to its owner, or `undefined` when it is not linked.
   * THE hot path of an SSO login — one index probe on `(provider, subject)`.
   *
   * IT DOES NOT TAKE AN EMAIL, and that is the anti-takeover rule expressed as a SIGNATURE rather
   * than as a comment (D-15.7-1). A function that cannot see the email cannot be "improved" into
   * falling back to it.
   */
  export async function findUserIdBySsoIdentity(
    db: DbClient,
    provider: string,
    subject: string,
  ): Promise<string | undefined> {
    const [row] = await db
      .select({ userId: ssoIdentities.userId })
      .from(ssoIdentities)
      .where(and(eq(ssoIdentities.provider, provider), eq(ssoIdentities.subject, subject)))
      .limit(1);
    return row?.userId;
  }

  /**
   * Link a provider identity to a user. Throws `identity_taken` when that (provider, subject) is
   * already bound to somebody else — which the unique index would raise anyway, but as an opaque
   * 500. Catching it here turns the race into a clean 409 at every call site.
   */
  export async function linkSsoIdentity(
    db: DbClient,
    userId: string,
    identity: { provider: string; subject: string; email?: string | null },
  ): Promise<{ id: string }> {
    const existing = await findUserIdBySsoIdentity(db, identity.provider, identity.subject);
    if (existing && existing !== userId) {
      throw new SsoIdentityError("identity already linked to another account", "identity_taken");
    }
    const [row] = await db
      .insert(ssoIdentities)
      .values({
        userId,
        provider: identity.provider,
        subject: identity.subject,
        email: identity.email ? normalizeEmail(identity.email) : null,
      })
      // Re-linking the SAME identity to the SAME user is a no-op success, not an error: a user who
      // double-clicks "Connect Google" must not get a 409 for the state they asked for.
      .onConflictDoUpdate({
        target: [ssoIdentities.provider, ssoIdentities.subject],
        set: { email: identity.email ? normalizeEmail(identity.email) : null },
      })
      .returning({ id: ssoIdentities.id });
    return row!;
  }

  /** A user's linked identities, newest first. Explicit columns; rows reach the wire. */
  export async function listSsoIdentities(db: DbClient, userId: string): Promise<SsoIdentityRow[]> {
    return db
      .select(ssoIdentityRowColumns)
      .from(ssoIdentities)
      .where(eq(ssoIdentities.userId, userId))
      .orderBy(desc(ssoIdentities.createdAt));
  }

  /**
   * Unlink `provider` from `userId`. Returns false when nothing was linked.
   *
   * THE GUARD IS LOCKED, AND THE MECHANISM IS THE LOCK — NOT THE TRANSACTION (CLAUDE.md 15.5, the
   * lesson 15.5's last-owner guard had to learn twice). Removing a user's last credential locks the
   * account out permanently, so this must refuse when the user has no password AND no other link.
   * That is a read-then-write decision, and `SELECT count(*)` takes NO LOCKS: under READ COMMITTED
   * two concurrent unlinks of two DIFFERENT providers each see "one other credential exists" and
   * both proceed, leaving zero. Sharing a transaction does not help — atomicity is not isolation.
   *
   * So the OTHER identity rows are selected `FOR UPDATE` (hence rows-then-`length`; Postgres cannot
   * apply FOR UPDATE to an aggregate), and the `users` row `FOR SHARE`. A blocked transaction
   * re-evaluates its predicate after the lock releases (EvalPlanQual), so the row the winner deleted
   * drops out of the loser's result set and the loser correctly refuses. No SERIALIZABLE, no retry.
   *
   * Takes a `DbClient` so a caller may pass a `Tx`; the route passes `app.db` and this opens its own.
   */
  export async function unlinkSsoIdentity(
    db: DbClient,
    userId: string,
    provider: string,
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      const others = await tx
        .select({ id: ssoIdentities.id })
        .from(ssoIdentities)
        .where(and(eq(ssoIdentities.userId, userId), ne(ssoIdentities.provider, provider)))
        .for("update");
      const [cred] = await tx
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, userId))
        .for("share")
        .limit(1);
      const hasOtherCredential = others.length > 0 || Boolean(cred?.passwordHash);
      if (!hasOtherCredential) {
        throw new SsoIdentityError(
          "cannot unlink the only credential on this account — set a password first",
          "last_credential",
        );
      }
      const removed = await tx
        .delete(ssoIdentities)
        .where(and(eq(ssoIdentities.userId, userId), eq(ssoIdentities.provider, provider)))
        .returning({ id: ssoIdentities.id });
      return removed.length > 0;
    });
  }
  ```

- **PATTERN**: `packages/db/src/repositories/sessions.ts` (structure, doc density, `DbClient`
  parameter) and `packages/db/src/repositories/members.ts`'s `MemberError` for the typed-error shape.
- **GOTCHA**: note what the import line does **not** include — `count`. The first draft of this guard
  used `select({ n: count() })`, which is exactly the shape CLAUDE.md's 15.5 lesson forbids: Postgres
  cannot apply `FOR UPDATE` to an aggregate, so the locking version *must* select rows and read
  `.length`. If you find yourself reaching for `count`, you have reverted the fix.
- **GOTCHA**: `unlinkSsoIdentity` opens a transaction internally, so **do not call it inside another
  `db.transaction()`** — node-postgres will happily nest and the inner `BEGIN` is a no-op with a
  warning. No current call site does; keep it that way.
- **VALIDATE**: `npm run typecheck && npm run lint`

### 6. EXPORT from `packages/db/src/index.ts`

- **IMPLEMENT**: add `ssoIdentities` to the schema re-export block (after `sessions`, ~line 13) and a
  new export block after the sessions one (~line 104):

  ```ts
  // M15 15.7 SSO identities. Identity-owned — no org_id, no RLS (D-15.7-3), scoped by userId only.
  export {
    findUserIdBySsoIdentity,
    linkSsoIdentity,
    listSsoIdentities,
    unlinkSsoIdentity,
    SsoIdentityError,
  } from "./repositories/sso-identities.js";
  export type { SsoIdentityRow } from "./repositories/sso-identities.js";
  ```

  …and add `createUserWithoutPassword` to the existing `./repositories/users.js` export block.
- **PATTERN**: `packages/db/src/index.ts:96-104`.
- **VALIDATE**: `npm run typecheck`

### 7. CREATE `apps/ingest/src/sso/pkce.ts` (+ `pkce.test.ts`)

- **IMPLEMENT**:

  ```ts
  import { createHash, randomBytes } from "node:crypto";

  /** An unguessable CSRF `state` value. 32 bytes, base64url — same budget as `tokens.ts`. */
  export function randomState(): string {
    return randomBytes(32).toString("base64url");
  }

  /**
   * RFC 7636 PKCE pair. `codeChallenge = base64url(sha256(codeVerifier))`, method S256 —
   * CONFIRMED supported by Google's discovery document (`code_challenge_methods_supported`
   * contains "S256"), which is why this is not guarded behind a capability check for Google.
   *
   * Node's `base64url` digest encoding is already unpadded and URL-safe, so no hand-rolled
   * `+/=` replacement is needed — writing one is the classic way to break the challenge.
   */
  export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    return { codeVerifier, codeChallenge };
  }
  ```

- **TESTS** (`pkce.test.ts`): the challenge is the base64url sha256 of the verifier (recompute
  independently); two calls differ; neither value contains `+`, `/` or `=`.
- **VALIDATE**: `npx vitest run apps/ingest/src/sso/pkce.test.ts`

### 8. CREATE `apps/ingest/src/sso/provider.ts`

- **IMPLEMENT**: the abstraction, mirroring `analysis/provider.ts` clause for clause.

  ```ts
  import { googleProvider } from "./google.js";
  import { githubProvider } from "./github.js";

  /**
   * The SSO Provider abstraction (M15 15.7, D-M15-5). An INJECTED, configurable set of providers,
   * wired through `BuildAppOptions` exactly as `analysisProvider` / `mailer` / `alertDeliverer` are
   * (the proven buildApp pattern) — so EVERY automated test drives a deterministic stub and the
   * live `fetch` runs only in `server.ts` and manual validation. Without this an OAuth slice is
   * simply untestable.
   *
   * Silent library (CLAUDE.md): the clients throw `SsoProviderError`, never log.
   * No SDK and no JWT dependency — plain `fetch` + `AbortSignal.timeout`, like `analysis/*`.
   */

  /** What a provider tells us about a person. The ONLY three facts this slice consumes. */
  export interface SsoProfile {
    /** The provider's IMMUTABLE user id — Google `sub`, GitHub numeric `id`. NEVER a username. */
    subject: string;
    /** The address the provider asserts. Display/audit only; never a lookup key (D-15.7-1). */
    email: string | null;
    /** Whether the PROVIDER has verified that address. Branch 2 of the policy turns on this. */
    emailVerified: boolean;
  }

  export interface SsoProvider {
    /** True when the provider documents PKCE support (Google yes, GitHub no — see github.ts). */
    readonly usesPkce: boolean;
    /** Build the provider's authorize URL. Pure — unit-tested without network. */
    authorizeUrl(params: { state: string; codeChallenge?: string; redirectUri: string }): string;
    /** Exchange `code` for a profile. The one method that talks to the network. */
    exchange(params: {
      code: string;
      codeVerifier?: string;
      redirectUri: string;
    }): Promise<SsoProfile>;
  }

  /**
   * A clean, mappable failure for ANY provider problem. `unavailable` → 502 and `not_configured`
   * → 503 via app.ts, so a provider outage is never a leaked 500. Deliberately does NOT carry the
   * POLICY reasons (`link_required`, `signup_disabled`, …) — those are decisions the route makes
   * about our own data and it returns them as explicit status codes, the way signup returns its 409.
   */
  export class SsoProviderError extends Error {
    constructor(
      message: string,
      readonly kind: "unavailable" | "not_configured" = "unavailable",
    ) {
      super(message);
      this.name = "SsoProviderError";
    }
  }

  export interface SsoProviderConfig {
    clientId: string;
    clientSecret: string;
    timeoutMs: number;
  }

  export interface SsoConfig {
    google?: SsoProviderConfig;
    github?: SsoProviderConfig;
  }

  export type SsoProviders = Partial<Record<"google" | "github", SsoProvider>>;

  export const SSO_PROVIDER_IDS = ["google", "github"] as const;
  export type SsoProviderId = (typeof SSO_PROVIDER_IDS)[number];

  export function isSsoProviderId(s: string): s is SsoProviderId {
    return (SSO_PROVIDER_IDS as readonly string[]).includes(s);
  }

  /**
   * Build the configured providers. An UNCONFIGURED provider is simply ABSENT from the map rather
   * than present-and-throwing, which is the one deliberate divergence from `createAnalysisProvider`'s
   * `notConfigured()` stand-in: the login page asks `GET /v1/auth/sso/providers` which buttons to
   * render, and "present but always fails" would render a button that cannot work.
   */
  export function createSsoProviders(cfg: SsoConfig): SsoProviders {
    const out: SsoProviders = {};
    if (cfg.google) out.google = googleProvider(cfg.google);
    if (cfg.github) out.github = githubProvider(cfg.github);
    return out;
  }
  ```

- **PATTERN**: `apps/ingest/src/analysis/provider.ts:1-79`.
- **VALIDATE**: `npm run typecheck` (expect errors until Tasks 9-10 create the two clients)

### 9. CREATE `apps/ingest/src/sso/google.ts` (+ `google.test.ts`)

- **IMPLEMENT**: authorize-URL builder + code exchange + userinfo, all literals taken from the
  discovery document verified above.

  ```ts
  import type { SsoProfile, SsoProvider, SsoProviderConfig } from "./provider.js";
  import { SsoProviderError } from "./provider.js";

  /**
   * Google OpenID Connect client (M15 15.7). Endpoints read from the live discovery document
   * https://accounts.google.com/.well-known/openid-configuration during planning, not from memory.
   *
   * WE DO NOT VERIFY THE `id_token` SIGNATURE, AND THAT IS DELIBERATE (D-15.7-2). Signature
   * validation exists for an ID token that arrived through an UNTRUSTED channel (the browser, in the
   * implicit/hybrid flows). Here the token was fetched by THIS process over TLS directly from
   * Google's token endpoint, authenticated with our client secret — OIDC Core §3.1.3.7 explicitly
   * permits skipping validation in exactly that case. So instead of pulling in a JWT library and a
   * JWKS cache (a dependency and a moving part, both of which can be got wrong), we spend one extra
   * round trip on `userinfo`, which is authoritative and makes Google and GitHub the SAME SHAPE:
   * exchange code → get access token → call a profile endpoint.
   */
  const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
  const TOKEN_URL = "https://oauth2.googleapis.com/token";
  const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
  /** `openid email` is all this slice consumes; `profile` is NOT requested — we store no name. */
  const SCOPE = "openid email";

  interface GoogleTokenResponse {
    access_token?: string;
  }
  interface GoogleUserinfo {
    sub?: string;
    email?: string;
    email_verified?: boolean;
  }

  /** Pure: raw userinfo → our profile. Exported so the mapping is unit-testable without network. */
  export function toGoogleProfile(raw: GoogleUserinfo): SsoProfile {
    if (!raw.sub) throw new SsoProviderError("google userinfo returned no subject");
    return {
      subject: raw.sub,
      email: raw.email ?? null,
      // `=== true`, not truthiness: Google returns a real boolean, and coercing a missing claim to
      // "verified" is the one mistake in this file that would be a security bug rather than a bug.
      emailVerified: raw.email_verified === true,
    };
  }

  export function googleProvider(cfg: SsoProviderConfig): SsoProvider {
    return {
      usesPkce: true,
      authorizeUrl({ state, codeChallenge, redirectUri }) {
        const q = new URLSearchParams({
          client_id: cfg.clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: SCOPE,
          state,
          // No `access_type=offline` and no `prompt=consent`: we want NO refresh token (D-15.7-5 —
          // we never call Google again after the login), and asking for one triggers a consent
          // screen the user has no reason to see.
          ...(codeChallenge ? { code_challenge: codeChallenge, code_challenge_method: "S256" } : {}),
        });
        return `${AUTHORIZE_URL}?${q.toString()}`;
      },
      async exchange({ code, codeVerifier, redirectUri }) {
        const accessToken = await postForToken(cfg, { code, codeVerifier, redirectUri });
        return toGoogleProfile(await getUserinfo(cfg, accessToken));
      },
    };
  }
  ```

  `postForToken` POSTs `application/x-www-form-urlencoded`
  `{client_id, client_secret, code, grant_type: "authorization_code", redirect_uri, code_verifier?}`
  to `TOKEN_URL`; `getUserinfo` GETs `USERINFO_URL` with `Authorization: Bearer <token>`. Both use
  `signal: AbortSignal.timeout(cfg.timeoutMs)` and wrap every failure in `SsoProviderError`.

- **PATTERN**: `apps/ingest/src/analysis/anthropic.ts:22-53` — copy the try/catch shape verbatim,
  including `if (err instanceof SsoProviderError) throw err;` before the wrap.
- **TESTS** (`google.test.ts`, no network): `authorizeUrl` contains `code_challenge_method=S256`,
  `response_type=code`, the exact `redirect_uri`, and the state; `toGoogleProfile` maps
  `{sub, email, email_verified:true}` correctly, returns `emailVerified:false` for a **missing**
  `email_verified`, and **throws** when `sub` is absent.
- **GOTCHA**: the token endpoint wants **form encoding**, not JSON. Sending JSON returns a 400 whose
  body says `invalid_request` with no hint about the content type.
- **VALIDATE**: `npm run typecheck && npx vitest run apps/ingest/src/sso/google.test.ts`

### 10. CREATE `apps/ingest/src/sso/github.ts` (+ `github.test.ts`)

- **IMPLEMENT**: same shape, three provider-specific differences, each verified against the docs
  above.

  ```ts
  const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
  const TOKEN_URL = "https://github.com/login/oauth/access_token";
  const USER_URL = "https://api.github.com/user";
  const EMAILS_URL = "https://api.github.com/user/emails";
  /** `user:email` is required to read /user/emails; `read:user` for /user. NO `repo` scope —
   *  this is identity only (D-M15-5 supersedes 12.3's rejection on identity grounds, not API ones). */
  const SCOPE = "read:user user:email";
  const API_VERSION = "2026-03-10";

  /**
   * GitHub OAuth client (M15 15.7). THREE differences from Google, all of them load-bearing:
   *
   *  1. NO `id_token` and no OIDC at all — the profile comes from `GET /user`.
   *  2. The verified flag is NOT on `/user`. `/user.email` is the account's PUBLIC address and
   *     carries no verification signal; the truth lives in `GET /user/emails`, whose elements are
   *     `{email, primary, verified, visibility}`. We take the entry that is BOTH `primary` AND
   *     `verified` — primary-but-unverified must not pass, and verified-but-secondary is not the
   *     address the person identifies by.
   *  3. `usesPkce: false`. GitHub's OAuth-App documentation specifies `state` and does not document
   *     PKCE, so we do not send a challenge we cannot rely on being enforced. `state` remains
   *     mandatory. If GitHub documents PKCE later this becomes a one-line change.
   *
   * The subject is `String(user.id)` — the NUMERIC id, never `login`. A GitHub username can be
   * changed and a released one re-registered by somebody else, so keying on it would let a stranger
   * inherit an account by claiming a handle (D-15.7-1).
   */
  ```

  `exchange` POSTs form-encoded `{client_id, client_secret, code, redirect_uri}` with
  **`Accept: application/json`** (without it GitHub replies form-encoded and `res.json()` throws),
  then GETs `/user` and `/user/emails` with `Authorization: Bearer <token>`,
  `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2026-03-10`.

  Export a pure `toGithubProfile(user, emails)` for the unit tests.

- **GOTCHA**: GitHub returns **200 with an `{error, error_description}` body** for a bad code, not a
  4xx. Check for `error` in the parsed body as well as `!res.ok`, or an invalid code becomes
  "undefined access token" much later and much more confusingly.
- **GOTCHA**: `user.id` is a **number** in JSON. `String(...)` it at the boundary — a numeric
  `subject` would be inserted into a `text` column by drizzle without complaint on one path and
  compared as a string on another.
- **TESTS** (`github.test.ts`): `authorizeUrl` has no `code_challenge`; `toGithubProfile` picks the
  primary+verified address, returns `emailVerified:false` when the primary address is unverified,
  ignores a verified-but-secondary address, and stringifies a numeric id.
- **VALIDATE**: `npm run typecheck && npx vitest run apps/ingest/src/sso/github.test.ts`

### 11. ADD body schemas to `apps/ingest/src/schemas.ts`

- **IMPLEMENT**: two schemas beside the 15.5/15.6 auth ones (~line 498):

  ```ts
  /** POST /v1/auth/sso/:provider/start body — optional, carries only the invite being accepted. */
  export const ssoStartBodySchema = {
    type: "object",
    additionalProperties: false,
    properties: { inviteToken: { type: "string", minLength: 8, maxLength: 256 } },
  } as const;

  /** POST /v1/auth/sso/:provider/callback (and .../link) body. NOTE what is ABSENT: `redirectUri`.
   *  Ingest derives it from APP_BASE_URL so a caller can never steer the exchange (D-15.7-6). */
  export const ssoCallbackBodySchema = {
    type: "object",
    required: ["code"],
    additionalProperties: false,
    properties: {
      code: { type: "string", minLength: 1, maxLength: 2048 },
      codeVerifier: { type: "string", minLength: 32, maxLength: 128 },
      inviteToken: { type: "string", minLength: 8, maxLength: 256 },
    },
  } as const;
  ```

- **PATTERN**: `apps/ingest/src/schemas.ts:498-506` (`signupBodySchema`).
- **VALIDATE**: `npm run typecheck`

### 12. CREATE `apps/ingest/src/routes/sso.ts` — the resolver and six endpoints

- **IMPLEMENT**: the policy function first, then the routes.

  ```ts
  /**
   * THE ANTI-TAKEOVER POLICY (M15 15.7, D-15.7-1/4/7). Every branch is a decision; read the table in
   * the plan's Solution Statement alongside it. Returns a discriminated outcome rather than throwing,
   * so the route maps each to a status and NOTHING falls through to a default "log them in".
   *
   * BRANCH ORDER IS LOAD-BEARING. The linked-identity probe comes FIRST and is keyed on
   * (provider, subject) alone, so a person whose provider-side email changed keeps their account;
   * and the pre-existing-user refusal comes BEFORE the signup branch, so a takeover attempt can
   * never be answered by "well, signup is on, I'll just make them".
   */
  type SsoOutcome =
    | { kind: "login"; userId: string; email: string }
    | { kind: "created"; userId: string; email: string }
    | { kind: "refused"; status: 403 | 409; reason: SsoRefusal };

  type SsoRefusal = "email_unverified" | "link_required" | "signup_disabled" | "invite_mismatch";
  ```

  `resolveSsoLogin(app, provider, profile, inviteToken?)` implements branches 1-6 exactly as the
  Solution Statement table states. Branches 3 and 5 each run **one transaction** in the shape
  `routes/auth.ts:252-256` uses (create the user, then `acceptInvite` **or** `ensurePersonalOrg`,
  then `linkSsoIdentity`, RETURNING the id out of the callback — never an outer `let`).

  | Route | Auth | Behaviour | Status |
  | --- | --- | --- | --- |
  | `GET /v1/auth/sso/providers` | none | `{providers: ["google", …]}` — which are CONFIGURED | 200 |
  | `POST /v1/auth/sso/:provider/start` | none | `{authorizeUrl, state, codeVerifier?}` | 200 / 404 |
  | `POST /v1/auth/sso/:provider/callback` | none | exchange → `resolveSsoLogin` → `mintSession` | 200 / 403 / 409 |
  | `POST /v1/auth/sso/:provider/link` | session, `viewer` | exchange → `linkSsoIdentity` for the caller | 204 / 409 |
  | `GET /v1/auth/sso/identities` | session, `viewer` | the caller's links | 200 |
  | `DELETE /v1/auth/sso/:provider` | session, `viewer` | `unlinkSsoIdentity` | 204 / 404 / 409 |

- **PATTERN**: the guard ladder at `routes/auth.ts:469-476` (`resolvePrincipal` → 401 →
  `authorized(principal, "viewer")` → 403) for the three gated routes; `routes/auth.ts:136-173`
  (login) for the un-gated ones, **including `config: { rateLimit: app.rateLimitLogin }`**.
- **GOTCHA — the redirect URI is NEVER caller-supplied.** Compute it in ONE helper,
  `` ssoRedirectUri(app, provider) => `${app.appBaseUrl}/api/auth/sso/${provider}/callback` ``, and
  use the same helper in `start` and in `callback`. OAuth requires the two to match, and accepting it
  from the body would let anyone redirect an authorization code to a host they control — a complete
  account-takeover primitive that no test would notice, because the happy path works fine.
- **GOTCHA — `start` and `callback` are BOTH un-gated and BOTH write-adjacent**, so both carry
  `app.rateLimitLogin`, exactly as signup/reset do. `callback` is the expensive one (two outbound
  hops), and an unthrottled one is a free proxy for hammering Google.
- **GOTCHA — an unknown `:provider` is 404, before anything else.** Use `isSsoProviderId` then look
  it up in `app.ssoProviders`; a configured-but-absent provider is also 404, not 500.
- **GOTCHA — the link route must NOT accept an `inviteToken`.** The caller is already authenticated
  and already in an org; honouring an invite there would silently move or double their membership.
  The schema is shared, so ignore the field explicitly and say so in a comment.
- **GOTCHA — do not widen `Principal`.** The link/unlink routes need only `principal.userId`, which
  `resolvePrincipal` already provides.
- **VALIDATE**: `npm run typecheck`

### 13. WIRE `apps/ingest/src/app.ts`

- **IMPLEMENT**:
  - `BuildAppOptions`: `ssoProviders?: SsoProviders;` and `ssoSignupEnabled?: boolean;` and
    `appBaseUrl?: string;` — each documented in the style of `mailer` / `selfSignupEnabled` (:85-92),
    stating the omitted-default and why it is safe.
  - decorate all three **before** the route registrations (`ssoProviders ?? {}`,
    `ssoSignupEnabled ?? false`, `appBaseUrl ?? "http://localhost:3000"`), then
    `app.register(ssoRoutes)` after `authRoutes`.
  - `setErrorHandler`: add `SsoProviderError` (→ 503 for `not_configured`, else 502) beside
    `AnalysisProviderError`, and `SsoIdentityError` (→ 409 with its `reason`) beside `MemberError`.
- **GOTCHA**: `ssoSignupEnabled` **must default to `false`**, for the same reason
  `selfSignupEnabled` does and with the same consequence if you get it wrong — every existing
  `buildApp` caller and every deployment that upgrades without touching `.env` would become an open
  box the moment a client ID is configured.
- **GOTCHA**: declare the three new decorations in the Fastify module augmentation wherever
  `mailer` / `selfSignupEnabled` are declared (grep `declare module "fastify"`), or `app.ssoProviders`
  is a type error at the call site rather than at the decoration.
- **VALIDATE**: `npm run typecheck`

### 14. WIRE `apps/ingest/src/server.ts`

- **IMPLEMENT**: after the mailer block (~line 160):

  ```ts
  // M15 15.7 SSO (D-M15-5). A provider is configured only when BOTH halves are present; a client id
  // with no secret is a half-configuration that would fail at the token exchange with an opaque 502,
  // so it is treated as absent and logged once at boot.
  //
  // `||` NOT `??` on every one of these, per the SMTP_URL comment above: `.env.example` ships these
  // keys with EMPTY values, and `""` is not null — `??` would hand an empty client id straight to
  // Google, exactly the silent misconfiguration the mailer fallback was written to avoid.
  const ssoConfig: SsoConfig = {};
  const googleId = process.env.SSO_GOOGLE_CLIENT_ID || "";
  const googleSecret = process.env.SSO_GOOGLE_CLIENT_SECRET || "";
  if (googleId && googleSecret) {
    ssoConfig.google = { clientId: googleId, clientSecret: googleSecret, timeoutMs: SSO_TIMEOUT_MS };
  }
  // …same for GitHub…
  const ssoSignupEnabled = process.env.SSO_SIGNUP_ENABLED === "true";
  ```

  Plus the boot warning `selfSignupEnabled` already models (:163-168) — when `ssoSignupEnabled` is on,
  say so loudly, naming which providers are live.
- **PATTERN**: `apps/ingest/src/server.ts:145-168`. Reuse the **existing** `APP_BASE_URL` read at
  :154 (`process.env.APP_BASE_URL || "http://localhost:3000"`) and pass it as `appBaseUrl` — do not
  introduce a second base-URL variable.
- **GOTCHA**: `SSO_SIGNUP_ENABLED === "true"` **exactly**, not a truthiness check, so a typo
  (`SSO_SIGNUP_ENABLED=yes`) fails safe. The comment at :161 states this rule for the sibling flag.
- **UPDATE** `.env.example` with the five new keys (empty values, matching the file's convention) and
  a comment block explaining that SSO is off unless both halves of a provider are set.
- **VALIDATE**: `npm run typecheck`

### 15. CREATE the dashboard route handlers

- **IMPLEMENT** `apps/dashboard/src/app/api/auth/sso/[provider]/start/route.ts`:
  - `GET`. Read `mode` (`login` | `link`), `next`, `inviteToken` from the query.
  - `proxyJson` is **wrong for `login` mode** — it attaches `adminHeaders()` (the caller's session),
    and a logged-out user has none. Call ingest with a plain `fetch` for `login`, and `proxyJson` for
    `link` (which *is* authenticated). Say so in a comment; this is the easiest thing in the slice to
    get subtly wrong.
  - Set ONE short-lived cookie `ai_sso` = JSON `{state, codeVerifier, mode, next, inviteToken}`:
    `httpOnly`, `sameSite: "lax"`, `path: "/api/auth/sso"`, `maxAge: 600`,
    `secure: process.env.NODE_ENV === "production"`.
  - `NextResponse.redirect(authorizeUrl)`.
- **IMPLEMENT** `.../callback/route.ts`:
  - `GET`. Read `code` + `state` from the query and the `ai_sso` cookie. **Compare the two `state`
    values and abort on any mismatch** before touching ingest. Delete the cookie on every path.
  - POST `{code, codeVerifier, inviteToken?}` to ingest's callback (login mode) or link endpoint
    (link mode), then — for login — set `SESSION_COOKIE` **exactly as
    `api/auth/login/route.ts:42-48` does**, including the `sessionConfigError()` guard at the top.
  - Redirect to the validated `next` on success, or `/login?error=<reason>` on refusal so the login
    form can render "this address already has an account — sign in and link it from Settings".
- **GOTCHA — `sameSite: "lax"`, never `"strict"`.** The provider sends the user back via a top-level
  cross-site GET; a `strict` cookie is **not** sent on it, so `state` would be missing on every real
  login while working perfectly in any same-site test.
- **GOTCHA — the open-redirect guard.** `next` arrives from a query string and is used in a redirect.
  Reuse the exact check from `login-form.tsx:38-41` (`startsWith("/") && !startsWith("//") &&
  !startsWith("/\\")`), defaulting to `/monitor`. Put it in `lib/` and have the login form import it
  rather than keeping two copies.
- **GOTCHA — `params` is a Promise in this Next version.** `export async function GET(req, { params }:
  { params: Promise<{ provider: string }> })` then `const { provider } = await params;`. Check a
  sibling dynamic route (`app/projects/[id]/page.tsx`) and match it exactly.
- **GOTCHA**: `middleware.ts:19` already exempts `/api/auth/**`. **Verify, do not edit.**
- **VALIDATE**: `npm run typecheck:dashboard && npm run build:dashboard`

### 16. ADD the dashboard UI

- **IMPLEMENT**:
  - `login-form.tsx`: fetch `/api/auth/sso/providers` (a tiny same-origin proxy route) on mount and
    render one `<a href="/api/auth/sso/{id}/start?mode=login&next=…">` per configured provider, below
    a divider. **Anchors, not `fetch`** — this is a top-level navigation to a third party. Render an
    error banner from `?error=link_required` with the "sign in and link it from Settings" copy.
  - `components/settings/sso-links.tsx`: a client island listing `GET /api/auth/sso/identities`
    (through a proxy route) with Connect / Disconnect actions. Surface the `last_credential` 409 as
    "Set a password before disconnecting your only sign-in method."
  - Render it from the existing `app/settings/page.tsx` — **do not add a new route**.
- **PATTERN**: `components/auth/login-form.tsx` for the client-island + error-surfacing shape;
  `app/settings/page.tsx:33-47` for how the page passes server-fetched props into a view component.
- **GOTCHA**: hand-write any new shadcn primitive you need; do not run `npx shadcn init` (CLAUDE.md).
  `card` / `badge` / `table` / `cn` already exist and are enough.
- **VALIDATE**: `npm run typecheck:dashboard && npm run build:dashboard && npm run lint`

### 17. CREATE `packages/db/src/repositories/sso-identities.int.test.ts`

- **IMPLEMENT**: repository-level, two-role. Role identity **first**; then link/find/list/unlink;
  the `(provider, subject)` isolation case (same subject, two providers, two users — SPIKE 2 proved
  the index permits it); re-linking the same identity to the same user is a no-op success; linking an
  identity already bound elsewhere throws `identity_taken`; **the last-credential guard** in both
  directions (refused for a password-less single-link user, allowed once a password or a second link
  exists).
- **PATTERN**: `packages/db/src/repositories/rls.int.test.ts` for the two-role setup and the
  role-identity test; `sessions.int.test.ts` for the per-repository shape.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/sso-identities.int.test.ts`

### 18. CREATE `apps/ingest/src/sso.int.test.ts` — the centrepiece

- **IMPLEMENT**: build the app on `appRole.db` with a **mutable stub provider**:

  ```ts
  /** A deterministic stand-in for Google/GitHub. `profile` is reassigned per test, which is what
   *  lets the discriminator run the SAME callback twice and change only the database. */
  function stubSso(): SsoProvider & { profile: SsoProfile } {
    return {
      usesPkce: true,
      profile: { subject: "unset", email: null, emailVerified: false },
      authorizeUrl: ({ state, redirectUri }) => `https://stub.test/auth?state=${state}&r=${redirectUri}`,
      async exchange() {
        return this.profile;
      },
    };
  }
  ```

  Write the five assertions from [THE ANTI-TAKEOVER ASSERTION](#the-anti-takeover-assertion)
  verbatim, plus: the linked-identity path ignores a **changed** provider email (branch 1 keyed on
  subject); an unverified email is refused **even when the address is brand new**; invite-acceptance
  via SSO creates exactly ONE membership in the inviting org (assert the count — the D-15.5-9 trap);
  an invite whose email differs from the verified provider email is refused `invite_mismatch`; signup
  is refused when `ssoSignupEnabled` is omitted (the default-off assertion, mirroring
  `identity.int.test.ts` group 8); an unknown `:provider` is 404; a session minted through SSO is
  revocable by 15.6's `revoke-all` (the paths compose).
- **PATTERN**: `apps/ingest/src/identity.int.test.ts:1-200` — copy the harness wholesale: the
  `describe.skipIf(!TEST_URL || !APP_URL)`, the `owner`/`appRole` split,
  `buildApp({db: appRole.db, …})`, `login()`, `asUser()`, `json()`, `inviteAndCollect()`, and the
  `afterAll` that closes **the app and both pools**.
- **GOTCHA**: **no fixture edits are needed anywhere else.** SPIKE 3 confirmed live that the existing
  `TRUNCATE … users … RESTART IDENTITY CASCADE` clears `sso_identities` **without naming it** (the
  psql `NOTICE` was captured). Do not add it to ~20 TRUNCATE lists.
- **GOTCHA**: add `"sso_identities"` to `NO_RLS_TABLES` in `rls.int.test.ts:136`, and to **no other
  list**. Every policy count there is derived, so this changes no number; the "all 17 tenant tables"
  test must stay at **17** — `sso_identities` is not a tenant table. If a count assertion starts
  failing you have added a policy you did not mean to add.
- **VALIDATE**: `npx vitest run apps/ingest/src/sso.int.test.ts`
- **THEN**: run the **mutation check** exactly as specified above and record the pass/fail split.

### 19. ADD the dashboard callback unit test

- **IMPLEMENT**: `apps/dashboard/src/app/api/auth/sso/[provider]/callback/route.test.ts` — a
  **state-mismatch is rejected without any ingest call**, and a happy path sets the session cookie.
- **PATTERN**: `apps/dashboard/src/app/api/auth/logout/route.test.ts` (the existing precedent for
  testing a route handler with mocked `next/headers`).
- **VALIDATE**: `npx vitest run apps/dashboard/src/app/api/auth`

### 20. UPDATE docs + `SUMMARY.md` in the same commit

- **IMPLEMENT**:
  - `docs/guide/operations.md` — an "SSO (Google + GitHub)" section: registering each OAuth app and
    the **exact** redirect URI (`<APP_BASE_URL>/api/auth/sso/{google,github}/callback`); the five env
    keys; that `SSO_SIGNUP_ENABLED` is off by default and what turning it on means; **and the
    link-required behaviour** — an existing account is never adopted, users must sign in and link
    from Settings — because that is the thing operators will otherwise file as a bug.
  - `.env.example` — the five keys with empty values.
  - `SUMMARY.md` — flip **15.7** to ✅ with `DONE <date> (PR #NN)` in both the §0 status block and the
    §6 roadmap, and record D-15.7-1…7.
  - `.agents/execution-reports/m15-slice7-sso.md` via `/lril:execution-report`, **including the
    mutation-check split**.
- **GOTCHA**: `scripts/check-summary.mjs` **fails the gate** if an execution report exists without the
  matching ✅. Same commit, not a follow-up.
- **VALIDATE**: `npm run repo-health:fast`

---

## TESTING STRATEGY

### Unit Tests

- `apps/ingest/src/sso/pkce.test.ts` — challenge = base64url(sha256(verifier)), recomputed
  independently; no `+`/`/`/`=` in either value.
- `apps/ingest/src/sso/google.test.ts` — authorize-URL params; `toGoogleProfile` mapping, including
  **missing `email_verified` → `false`** (the coercion bug) and missing `sub` → throw.
- `apps/ingest/src/sso/github.test.ts` — no `code_challenge` in the URL; `toGithubProfile` picks
  primary+verified, rejects primary-but-unverified, ignores verified-but-secondary, stringifies a
  numeric id.
- `apps/dashboard/src/lib/session.test.ts` — unchanged. **The token payload is not modified by this
  slice**, so the Edge verifier needs no new case; confirm this rather than assuming it.

### Integration Tests

Both new `*.int.test.ts` files, **two-role throughout**, with the layering the 15.3 lesson
prescribes: the HTTP suite proves the *policy*, the repository suite proves the *mechanism*, and
neither substitutes for the other.

### Edge Cases

- Provider returns `emailVerified: false` for a **brand-new** address → 403, no user created.
- Provider returns `email: null` (a GitHub account with no verified address) → 403 on the login path;
  **allowed** on the authenticated link path, where the email is cosmetic.
- Same `subject` string on two different providers → two independent identities (SPIKE 2).
- The provider-side email changes after linking → the user still logs in, and the stored `email` is
  refreshed by the `onConflictDoUpdate`.
- An invite whose email differs from the verified provider email → `invite_mismatch`, invite unspent.
- Linking an identity already bound to another user → 409 `identity_taken`, no row moved.
- Unlinking the only credential → 409 `last_credential`; unlinking one of two → 204.
- Two concurrent unlinks of two different providers → exactly one succeeds. **This needs a
  repository-level test with two hand-held transactions**, not two HTTP requests: CLAUDE.md's 15.5
  corollary is explicit that a concurrency test at the HTTP layer passes identically with and without
  the lock. **Release the held transaction in a `finally`** — 15.5's failure to do so turned one real
  failure into five fake timeouts.
- Provider timeout / non-200 → 502 (never a leaked 500); provider not configured → 404 on the route.
- An SSO-minted session is revoked by `POST /v1/auth/sessions/revoke-all` → 401 afterwards.
- `ADMIN_TOKEN` caller on `GET /v1/auth/sso/identities` → 200 with an empty list, not a 500.

---

## VALIDATION COMMANDS

All runnable from the repo root. Every level is a **gate**; a level is green only at exit 0.

### Level 1: Syntax & Style

```bash
npm run typecheck            # root tsc -b — MUST exit 0 (a per-workspace build is NOT a substitute)
npm run typecheck:dashboard  # the dashboard is out of the root graph; this is its only typecheck
npm run lint                 # not in repo-health; CI runs it
npm run format:check         # CI lints markdown too — this plan file included
```

### Level 2: Unit Tests

```bash
npx vitest run apps/ingest/src/sso apps/dashboard/src/lib/session.test.ts apps/dashboard/src/app/api/auth
```

Expected: all pass, including every new case.

### Level 3: Integration Tests

```bash
npm run db:up && npm run db:migrate
# The test DB is NOT migrated by db:migrate — migrate 420ai_test separately, or every new int test
# errors on a relation that does not exist.
npx vitest run packages/db/src/repositories/sso-identities.int.test.ts apps/ingest/src/sso.int.test.ts
npm run repo-health -- --require-db
```

**`--require-db` is mandatory for this slice** (it touches `@420ai/db` and `apps/ingest`). Expected
pass signal: exit 0 **and** the integration layer reported as actually run with **0 skipped**. A plain
`repo-health` PASS is not evidence — `skipped ≠ passed`.

### Level 4: Manual Validation (the only place a real provider is contacted)

Register both OAuth apps first, with redirect URI
`http://localhost:3000/api/auth/sso/{google,github}/callback`.

```bash
# 1. Which providers came up configured?
curl.exe -s localhost:3001/v1/auth/sso/providers

# 2. Browser: click "Sign in with Google" on /login. With SSO_SIGNUP_ENABLED unset the FIRST
#    login for a new address must be refused — that is the D-M15-6 posture holding, not a bug.

# 3. The takeover case, by hand: log in with the password account, note its email, log out, then
#    sign in with a Google account carrying THAT address. Expect the "already has an account" banner
#    and NO session cookie.

# 4. Link it properly: log in with the password, Settings → Connect Google, log out, sign in with
#    Google. Expect to land on /monitor as the SAME user (check GET /v1/auth/me's email).

# 5. Disconnect the only credential on an SSO-created account → expect the refusal copy.
```

On Windows use `curl.exe` and file-based JSON bodies — bare `curl` is a PowerShell alias and `\"`
escaping breaks.

### Level 5: Additional Validation

Headless-Edge screenshot of `/login` showing the provider buttons and of `/settings` showing the link
state (CLAUDE.md's recipe). Pair it with the standing HTTP assertion that page source contains **0**
occurrences of `ADMIN_TOKEN` — and add its 15.7 sibling: **0** occurrences of any
`SSO_*_CLIENT_SECRET`.

---

## ACCEPTANCE CRITERIA

- [ ] A verified provider identity asserting a **pre-existing** address is refused `409 link_required`,
      with **no session minted and no identity row written**
- [ ] The refusal is proven to be the policy, not a broken pipe — the positive assertion (a brand-new
      verified identity IS admitted, via the same stub and the same route) sits directly above it, and
      the mutation check produced the predicted pass/fail split (recorded in the execution report)
- [ ] Login resolves on `(provider, subject)` only; a provider-side email change does not break it
- [ ] An unverified provider email is refused even for a brand-new address
- [ ] SSO-driven user creation is OFF unless `SSO_SIGNUP_ENABLED=true`; `buildApp` defaults it false
- [ ] Invite-via-SSO creates **exactly one** membership in the inviting org, and refuses an
      email mismatch
- [ ] An authenticated user can link and unlink; unlinking the **last** credential is refused, and the
      guard holds under two concurrent transactions (tested at the repository layer, released in a
      `finally`)
- [ ] `redirect_uri` is derived server-side from `APP_BASE_URL` and never read from a request body
- [ ] `state` is validated in the dashboard callback before any ingest hop; the cookie is
      `sameSite: "lax"`; `next` passes the same-origin guard
- [ ] No client secret and no provider access token is stored, logged, or reaches the browser
- [ ] `sso_identities` appears in `NO_RLS_TABLES` and in no other classification list; every derived
      `pg_policies` count and the "all 17 tenant tables" count are unchanged
- [ ] Both new suites run under the **non-owner** role, with the role-identity assertion first
- [ ] `npm run repo-health -- --require-db` passes with **0 skipped** integration tests
- [ ] `npm run build:dashboard` passes (Edge middleware import graph intact)
- [ ] `SUMMARY.md` flips 15.7 to ✅ in the **same commit** as the execution report
- [ ] `docs/guide/operations.md` documents both OAuth app registrations, the exact redirect URIs, and
      the link-required behaviour

---

## COMPLETION CHECKLIST

- [ ] All 20 tasks completed in order, each validated immediately
- [ ] Mutation check run; the pass/fail split matches the prediction
- [ ] Rollback drill: `npm run db:rollback` to 0018 and forward again
- [ ] No stale comments left claiming 15.7 is pending (grep `15.7` across `apps/`, `packages/`)
- [ ] `/lril:code-review` run before commit
- [ ] Full gate green: `npm run repo-health -- --require-db`

---

## NOTES

### Decisions this slice makes

- **D-15.7-1 — Identity is `(provider, subject)`; EMAIL IS NEVER A LOOKUP KEY.** `subject` is the
  provider's immutable id (Google `sub`, GitHub numeric `id`), never a username. `findUserIdBySso
  Identity` does not accept an email **as a matter of signature**, so email fallback is not something
  a future edit can quietly add.
- **D-15.7-2 — We do not verify the `id_token` signature; we call `userinfo`.** OIDC Core §3.1.3.7
  permits it when the token came directly from the token endpoint over TLS, which it did. This drops
  a JWT library and a JWKS cache, and it makes Google and GitHub the same shape.
- **D-15.7-3 — `sso_identities` is an IDENTITY table: no `org_id`, no RLS.** Extends D-15.3-4 /
  D-15.5-1 / D-15.6-3.
- **D-15.7-4 — A pre-existing `users` row is NEVER auto-adopted, verified provider email or not.**
  The milestone says "never auto-adopt an *unverified* pre-existing email row"; in this codebase that
  simplifies, because **no `users` row has a verified email** — 15.5's signup sends no verification
  mail and pre-seeded pairing rows were never verified at all. There is no "verified pre-existing
  row" class to carve out, so the rule is unconditional. The escape hatch is the authenticated link
  endpoint.
- **D-15.7-5 — No provider tokens are stored.** No `access_token`, no `refresh_token`, and Google is
  not asked for offline access. This is identity, not API access (which is also why 12.3's rejection
  of GitHub OAuth is *superseded on different grounds*, not overturned — still no Octokit).
- **D-15.7-6 — `redirect_uri` is derived server-side from `APP_BASE_URL`, never caller-supplied.** A
  caller-supplied one is a complete takeover primitive whose happy path works perfectly.
- **D-15.7-7 — SSO-driven signup is gated by its own `SSO_SIGNUP_ENABLED`, default off.** Separate
  from `SELF_SIGNUP_ENABLED` so an operator can open SSO self-provisioning without opening password
  signup. Defaulting it on would silently reopen the door D-M15-6 shut.

### Spikes actually RUN during planning (throwaways deleted)

All against the live `420ai_test` database in the `420ai-archive` container on 2026-07-29, by
creating a throwaway `sso_identities_spike` table of the exact shape in Task 1 and then dropping it.

| Spike | Question | Result |
| --- | --- | --- |
| **1** | Does 0015's `ALTER DEFAULT PRIVILEGES` cover this **new** table with no explicit `GRANT`, and does it come up RLS-free? | `information_schema.role_table_grants` returned **DELETE, INSERT, SELECT, UPDATE** for `420ai_app`; `relrowsecurity = f` with **0** policies. The app role then **inserted a row itself** with no explicit grant. **0019 needs no GRANT.** ✅ |
| **2** | Does `uniqueIndex(provider, subject)` permit the same subject on two providers, and reject a true duplicate? | `('google','12345')` and `('github','12345')` both inserted (2 rows); the second `('google','12345')` was rejected with `duplicate key value violates unique constraint`. ✅ Confirms both the isolation case and the `identity_taken` path. |
| **3** | Do the ~20 existing `TRUNCATE` fixtures need `sso_identities` added? | **No.** The verbatim fixture list from `identity.int.test.ts` emitted `NOTICE: truncate cascades to table "sso_identities_spike"` and the row count went 2 → 0 **without the table being named**. Removes ~20 file edits. ✅ |
| **4** | Google's real endpoints, PKCE support and `email_verified` claim | Fetched `https://accounts.google.com/.well-known/openid-configuration`: `code_challenge_methods_supported` includes **S256**; `claims_supported` includes **email_verified**; `userinfo_endpoint` = `https://openidconnect.googleapis.com/v1/userinfo`. ✅ |
| **5** | GitHub's token/email wire shape | Docs confirm `POST /login/oauth/access_token` needs `Accept: application/json`, returns `{access_token, scope, token_type}` and **no `id_token`**; `GET /user/emails` needs scope `user:email` and returns `{email, primary, verified, visibility}`. ✅ |

### Symbols verified by reading source (not from memory)

`DbClient` / `Db` / `Tx` (`packages/db/src/client.ts`) · `normalizeEmail`, `findUserIdByEmail`,
`findAdminCredential`, `createUserWithPassword`, `setUserPassword`, `updatePasswordHash`,
`ensureUserByEmail` (`repositories/users.ts:21,26,78,134,101,147,41`) · `ensurePersonalOrg`,
`getOrgName` (`repositories/organizations.ts:117,99`) · `findInviteByToken`, `acceptInvite`,
`InviteError` (`repositories/invites.ts:107,137,26`) · `findPrincipalByEmail`, `Principal`
(`repositories/principal.ts:50,17`) · `createSession`, `revokeAllSessions`, `listSessions`
(`repositories/sessions.ts`) · `resolvePrincipal`, `authorized`, `isUuid`
(`apps/ingest/src/auth.ts:50,133,143`) · `signSession`, `verifySession`, `SESSION_TTL_SECONDS`
(`apps/ingest/src/session.ts:43,60,19`) · `mintSession` (`apps/ingest/src/routes/auth.ts:78`) ·
`AnalysisProvider`, `AnalysisProviderError`, `createAnalysisProvider`
(`apps/ingest/src/analysis/provider.ts:28,37,73`) · `Mailer` (`apps/ingest/src/delivery/mailer.ts`) ·
`buildApp`, `BuildAppOptions` (`apps/ingest/src/app.ts:103,46`) · `proxyJson`
(`apps/dashboard/src/lib/proxy.ts:23`) · `SESSION_COOKIE`, `sessionConfigError`, `verifySessionEdge`
(`apps/dashboard/src/lib/session.ts:12,24,50`).

Test harness confirmed to exist: `apps/ingest/src/identity.int.test.ts` — `buildApp({db, adminToken,
adminEmail, sessionSecret, analysisProvider, mailer, reconcileThrottleMs, logger})` at :107-117,
`login()` at :128, `asUser()`/`json()` at :139-140, `inviteAndCollect()` at :157, the `beforeEach`
TRUNCATE at :180-182, the two-pool `afterAll` at :121-126. `rls.int.test.ts` — `NO_RLS_TABLES` at
:136, the derived-count inventory at :470-546.

### Residual risks (each named, none blocking)

1. **Both OAuth apps must be registered by hand** before Level 4. Nothing in the automated gate needs
   them — the integration suite drives an injected stub — so a missing registration blocks manual
   validation only, and the failure is loud (the provider's own error page).
2. **GitHub PKCE is not documented**, so `usesPkce: false` there. `state` is still mandatory and is
   what GitHub's own guidance prescribes. If GitHub documents PKCE later this is a one-line change.
3. **The D-15.6-4 dashboard-shell residual extends to SSO unchanged** — a revoked-but-unexpired
   cookie still renders the shell. Nothing in this slice changes that, and it is already documented.
4. **`next build` is the only check on the new Route Handlers' Edge/server split.** They are ordinary
   Node route handlers (not middleware), so the constraint is loose, but run `build:dashboard` rather
   than trusting `typecheck:dashboard` alone.

### Confidence

**9.4 / 10** for one-pass execution. Earned by: five spikes actually run (three live against the test
database with the exact table shape, two against live provider documentation), every imported symbol
read at its source rather than recalled, the test harness opened and cited by line, and an injected
provider abstraction that removes the network from every automated test. The 0.6 deduction is the
dashboard OAuth round trip — cookie flags, the `params` Promise shape, and the `proxyJson`-vs-plain-
`fetch` split are three small things that only `next build` plus a manual click-through can fully
confirm, and Level 4 is where they surface.
