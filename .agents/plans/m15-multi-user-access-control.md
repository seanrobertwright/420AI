# M15 — Multi-user & Access Control

> **Milestone definition** — the output of the 2026-07-25 deferral audit + scope conversation
> (the same process that produced M12, M13 and M14). Conventions live in `CLAUDE.md`; this links,
> not re-pastes. Each slice below still goes through the build loop (`SUMMARY.md` §2) with its own
> `/lril:plan-feature` plan; **slices 15.3+ cannot be planned until the 15.0 RLS spike lands.**

M15 is the first V2 milestone to be promoted from the committed-but-unsequenced M15–M19 bucket
(PRD §25, committed 2026-07-21). It was chosen on the stated criterion — _who the next milestone is
for_ — and the answer is: **this product is going to be a SaaS**, so the tenancy foundation is
built now, while there is exactly one real install and zero customers.

---

## Origin — the 2026-07-25 deferral audit

A full sweep of `docs/` (PRD §1/§4/§25, CONTEXT, guides), `.agents/` (plans, code-reviews,
system-reviews), and source comments for every marker parked on multi-user/RBAC/tenancy.
Findings, deduplicated:

- **A. Parked by decision, stays parked (→ M16–M19):** billing/subscriptions, quotas and
  per-tenant rate limits, managed/hosted archive, multi-region (all M16); cross-platform
  collectors + portable signed installers (M17); semantic/vector search, scheduled _analysis_,
  in-tool context-rule enforcement (M18); script/plugin connector runtime, local-model lifecycle,
  mobile (M19).

- **B. Tracked deferrals that M15 must now pick up** — each was explicitly deferred _to
  multi-user_ and is now in scope:
  1. **Search-doc ownership is arbitrary across users** —
     `.agents/code-reviews/m12-slice1-basic-search.md`: `search.ts` picks a session's owner via
     `min(machines.userId)::text`, deterministic-but-arbitrary if a session's raw records span
     machines owned by different users. Compounded by `search_documents_entity` being unique on
     `(entity_type, entity_id)` with **no user/org column** — for `session` and `event` rows the
     entity id is a connector-supplied session id or fingerprint, i.e. globally scoped, so two
     tenants can collide on the index. → **15.1 + 15.3.**
  2. **Project-scoped projections don't thread `userId`** —
     `.agents/code-reviews/m6-event-projections.md`: `projectEventSummary(db, id)` and friends
     take no user, and `sessionDetail` queries by connector session id with no user filter. Safe
     only because a project uuid is unguessable and there is one user. → **15.2.**
  3. **Report version-bump race** — `.agents/code-reviews/m7-reporting-foundation.md`:
     `insertReportArtifact` computes `max(version)+1` inside the tx; under READ COMMITTED two
     concurrent generations both attempt `N+1` and one 500s on
     `report_artifacts_scope_version`. Negligible at one user; real once several people generate
     reports. → **15.2** (retry-on-conflict / `ON CONFLICT` loop).
  4. **Alert reconcile runs per SSE tick, per user** —
     `.agents/plans/m10-slice3c-persisted-alerts.md` deferred a throttle as "a refinement if
     multi-user/perf ever matters." It now matters: evaluate-on-read reconcile inside
     `buildSnapshot` × N orgs × the SSE cadence. → **15.3.**
  5. **Catalog approval authority + firing fan-out** —
     `.agents/plans/m10-slice3d-catalog-signing.md`: `pricing_catalogs` /`connector_catalogs` are
     global (no `user_id`) but the `catalog.update_requires_approval` firing they raise is
     per-user, keyed to the `adminEmail` user. Multi-org needs a decided fan-out. → **15.4**
     (see D-M15-9).
  6. **`adminAuthorized` is sync + boolean by design** —
     `.agents/plans/m12-slice3-auth-hardening.md` names this precisely: "Single-user collapses
     authn ↔ identity… this is what keeps `adminAuthorized` sync and same-signature — the 12
     routes don't change. (Multi-user/RBAC is V2 and is where per-session identity would thread
     through.)" M15 is that milestone. → **15.2.**
  7. **Connector-approval authority is unscoped** —
     `.agents/plans/m12-slice7b-connector-permission-scopes.md`: capture-surface approval is
     "self-hosted single-user only (no RBAC/multi-user)". Who may approve a widened capture scope
     is an RBAC question. → **15.4.**
  8. **GitHub OAuth was considered and rejected for V1** —
     `.agents/plans/m12-slice3-auth-hardening.md`, on the grounds that the product is
     local-first, all repo reliance is local `.git` filesystem reads, and there is zero
     Octokit/GitHub-API usage, so a GitHub identity "buys nothing a `.git/config` read doesn't
     already provide." **That rationale is not overturned — it is superseded on different
     grounds.** M15 adopts GitHub OAuth for _identity/SSO convenience_ (D-M15-5), not for API
     access. No Octokit dependency is introduced.

- **C. Found by this audit, never previously tracked (security-relevant):**
  9. **`POST /v1/pairing-codes` creates users from caller-supplied email.**
     `apps/ingest/src/routes/pairing-codes.ts:24-34` upserts into `users` for
     `request.body.email ?? app.adminEmail`; `routes/interpretations.ts` does the same via
     `ensureUserByEmail`. Harmless today (`password_hash` is NULL ⇒ the row cannot log in), but
     it is an **account pre-seeding primitive**, and pre-seeding + SSO auto-link-by-email is an
     account-takeover vector. **Must close in 15.5, i.e. before SSO lands in 15.7.** See
     D-M15-8.

- **D. Documentation now false, corrected in 15.0:** PRD §4/§25 and `SUMMARY.md` §3 assert that
  "the archive schema is already multi-user-capable, so M15/M16 are a product-surface build,
  not a data migration." That was true for _per-user_ isolation. It is **false** under org-level
  tenancy (D-M15-1), which adds `org_id` across ~15 tables with a backfill. Also `docs/CONTEXT.md`
  §"V2 Scope" still says only "the second release expands tracking to General AI Chat sessions" —
  stale since 2026-07-21.

---

## Scope decisions (settled 2026-07-25 — do not re-litigate)

**D-M15-1 — The tenancy boundary is the ORGANIZATION, not the user.** New `organizations` +
`memberships` tables; tenant-owned data hangs off `org_id`. _Rationale:_ SaaS (M16) is the
committed destination, and retrofitting a tenancy column across ~15 tables after customers exist
is a downtime migration on live data. There is one install and no customers today — this is the
cheapest this decision will ever be. _Consequence:_ the PRD's "not a data migration" claim is
corrected in 15.0.

**D-M15-2 — Tenancy is a COLUMN on `events`; attribution remains a JOIN.** `org_id` is added to
`events` and `raw_source_records`. This **amends** the CLAUDE.md invariant, which is amended in the
same commit with the distinguishing test:

> A column belongs on `events` if it is **fixed at capture time and never re-derived**.
> `org_id` passes (whose data it is, fixed by which machine — paired to which user — uploaded it).
> `project_id` fails (attribution changes when a workspace is remapped) and stays a join.

_Rejected alternatives:_ (a) pure join scoping via `workspace_keys` leaves **unattributed events
ownerless** (null `project_path`, or no workspace key yet) and turns every RLS policy into a
correlated subquery — a known Postgres performance cliff; (c) scoping via
`raw_source_records → machines → users` looks correct but is not total, because `events.machine_id`
is **nullable** and documented as "most recent ingesting machine" (events deliberately converge
across machines).

_Hazard to test, not merely comment:_ `events.fingerprint` is machine-independent by design, so
the same logical event from two machines converges to one row. Cross-tenant collision is
effectively impossible today (distinct machines yield distinct `raw_record_id`s) but is not
prevented **by construction**. An ingest must never flip an existing row's `org_id` — this needs a
dedicated negative test.

**D-M15-3 — Isolation is enforced by Postgres RLS as a BACKSTOP, with application-level scoping
as the PRIMARY.** Repositories **keep** their explicit `orgId`/`userId` parameters; RLS catches
what the code forgets rather than replacing it. _Rationale:_ relying on RLS alone puts every query
one role misconfiguration away from returning everything, and the failure mode is **silent
over-disclosure**, not an error. Three consequences that 15.0 must prove before 15.3 is planned:

- **Pooled connections + transaction-local context.** `packages/db/src/client.ts` uses a shared
  `new Pool({connectionString})`. The org context must be set **inside a transaction**, via
  `SELECT set_config('app.current_org', $1, true)` — **not** `SET LOCAL`, which cannot bind a
  parameter (Postgres rejects `SET LOCAL x = $1`) and would force interpolating the org id into
  SQL, an injection vector in the isolation primitive itself. A plain `SET` persists for the life
  of the physical connection and the next request to borrow it inherits the previous tenant's
  context — a proven cross-tenant leak. ⇒ **every request touching tenant data must run in a
  transaction.** Only **10** call sites use `db.transaction()` today (count corrected from 11 by
  the 15.0 code review, which re-derived it; see the research doc's Finding 3 for the enumeration
  and the command); this is the single largest mechanical cost of D-M15-3. Evidence:
  `docs/research/m15-rls-spike.md` (Findings 3–4).
- **Superuser bypass — worse than "owner bypass", and FORCE does NOT fix it.** _Corrected
  2026-07-25 by the 15.0 spike, which disproved the original wording of this bullet._ The role in
  `DATABASE_URL`/`DATABASE_URL_TEST` is `420ai`, which is `rolsuper=t, rolbypassrls=t`. RLS is
  **inert** against it: with RLS enabled and an unsatisfiable policy it still returned every row,
  and `ALTER TABLE … FORCE ROW LEVEL SECURITY` **did not change that** (FORCE constrains the table
  _owner_; a superuser bypasses unconditionally). Therefore the **separate non-owner application
  role is load-bearing, not a hardening nicety** — without it, 15.3 ships policies that pass
  review, pass every test, and enforce nothing. Migrations keep running as the owner. Evidence:
  `docs/research/m15-rls-spike.md` (Findings 1–2).
- **Two-role integration suite.** `*.int.test.ts` must run as the owner for setup/`TRUNCATE` and
  as the app role for the tests that assert a cross-tenant read returns **zero rows**. That
  negative test is the milestone's proof.

**D-M15-4 — Full RBAC: four FIXED roles + per-project grants.** `owner` / `admin` / `member` /
`viewer`, plus per-project grants. **No user-defined roles** (that is an M16 enterprise concern).
Enforced at both the route layer and in RLS policy.

**D-M15-5 — All four identity paths ship, plus reset and MFA.** Admin-creates-user;
invite-by-email (over the 13.5 SMTP deliverer); **gated** self-signup; SSO via **Google + GitHub**
(identity only — no Octokit, no GitHub API); password reset; TOTP MFA with recovery codes.
Enterprise SAML/OIDC is explicitly **not** in scope (M16).

**D-M15-6 — Self-signup is OFF by default, behind an explicit env/setting, never on by default.**
Invite-only is the default posture for every deployment, self-hosted and hosted. _Rationale:_ an
open signup on a self-hosted box means anyone who can reach it creates an account.

**D-M15-7 — `ADMIN_TOKEN` is retired as an auth credential.** Three credential tiers replace the
hybrid gate:

| Tier | Identifies | Revocable | Holders |
| --- | --- | --- | --- |
| **User session** (extend 12.3 HMAC; `sub` → user + org + role, now actually read) | a user | yes (15.6) | humans via dashboard |
| **Machine token** (`ingest_tokens`, unchanged shape) | a machine → user → org | yes, per machine | collectors |
| **Per-user API key** (NEW: hashed, revocable, attributable) | a user | yes, per key | desktop app, `reports:generate`, scripts |

`ADMIN_TOKEN` survives **only** as a first-run bootstrap seed that creates the initial owner and is
inert thereafter — not a permanent bypass. **Operator break-glass is direct database access** via
the existing `db:*` scripts (which already authenticate with `DATABASE_URL`, not HTTP), never an
HTTP god-token. _Note:_ 12.3 already moved the dashboard off `ADMIN_TOKEN` — `lib/proxy.ts` →
`adminHeaders()` forwards the logged-in user's session from the httpOnly cookie. Identity is
already carried to ingest; ingest simply discards `sub`. The remaining holder is the **desktop app**
(`keychain.rs`, `proxy.rs`, `server.rs`).

**D-M15-8 — Pairing codes must NEVER create users.** `POST /v1/pairing-codes` must reference an
**existing member of the caller's org**; the `users` upsert is removed, as is `ensureUserByEmail`
in `interpretations.ts`. This closes the account pre-seeding primitive (audit finding C.9) and
**must land before SSO in 15.7**.

**D-M15-9 — Global resources stay global; ANY admin may approve.** `pricing_catalogs` and
`connector_catalogs` remain global (no `org_id`) — they apply to every machine in the deployment.
Any user with role `admin` or `owner` in any org may approve. The
`catalog.update_requires_approval` firing **fans out one firing per org**, reusing the existing
per-tenant firing key.

**D-M15-10 — Solo self-hosted stays zero-friction.** A single user never sees an org, never picks
a tenant, never invites anyone. The personal org is invisible plumbing; no org switcher renders
until a second member exists.

**D-M15-11 — Migration: the existing admin becomes `owner` of an auto-created personal org, and
every existing row backfills to that `org_id`.** Nothing changes hands.

**D-M15-12 — Sessions become STATEFUL, superseding 12.3's "no sessions table".** Stateless HMAC
cannot revoke; multi-user + SSO + MFA require "sign out all devices" and
invalidate-on-credential-change. 12.3's decision ("for a single admin, revoke-all == rotate
`SESSION_SECRET`") was correct for one user and is not correct for many.

---

## Non-goals (name in every PR; do NOT build here)

Billing / subscriptions / quotas / per-tenant rate limits · multi-tenant hosting, managed archive,
multi-region (all **M16**) · cross-platform collectors, portable signed installers (**M17**) ·
enterprise SAML/OIDC, SCIM / directory sync · user-defined or custom roles · an audit-log **UI**
(the `audit_events` table shipped in 15.10; the viewer stays deferred by decision, D-15.10-4 — the
read path is break-glass `psql` as the owner, and a structural test asserts the repository exports no
reader) · **MULTI-ORG MEMBERSHIP + THE ORG SWITCHER (→ M16, D-15.10-1)** — eleven source comments
promised them "at 15.10" and 15.10 CORRECTED those comments rather than honouring them: multi-org
reopens `findPrincipalByEmail`, the load-bearing 15.2 primitive whose byte-identical `ORDER BY` is
the only thing keeping session-auth and key-auth resolving to the same org, and additionally needs an
active-org claim in the session token, per-org session/key revocation and a rewrite of the invite
refusal. It belongs with M16's tenant slugs and hosting; nothing in 15.10's UI needed it · four
surfaces left HEADLESS but curl-reachable (gated self-signup page, password-reset pages, an
active-sessions list, MFA QR rendering) · semantic/vector search (**M18**) ·
mobile (**M19**) · MSI/code signing (still parked).

---

## Slices (dependency order)

Sizes are relative to prior milestones. **15.0 gates 15.3**; 15.5 gates 15.7 (D-M15-8).

| # | Slice | Size | Content |
| --- | --- | --- | --- |
| **15.0** | Truth + RLS spike | S–M | Correct PRD §4/§25 + `SUMMARY.md` §3 ("not a data migration" is false under D-M15-1) + `docs/CONTEXT.md` V2 scope. **Spike:** prove pool + `SET LOCAL` + FORCE RLS + a non-owner app role against the real test DB; decide and document the transaction-wrapping pattern. Writes `docs/research/m15-rls-spike.md`. **No production code.** |
| **15.1** | Tenancy schema | M | `organizations` + `memberships`; `org_id` added across tenant tables incl. `events` + `raw_source_records` (D-M15-2); fix `search_documents_entity` uniqueness to include org (audit B.1); backfill + `down/` SQL; personal-org auto-creation (D-M15-11). **No behavior change.** |
| **15.2** | Request principal | **L** | `adminAuthorized` (boolean, ~60 call sites) → `resolvePrincipal` returning `{userId, orgId, role}`; ingest reads the session `sub` instead of falling back to `app.adminEmail` (11 route files); thread `userId`/`orgId` through the projection repos + `sessionDetail` (audit B.2); `ON CONFLICT` retry on report version bump (audit B.3). **Widest edit in the milestone.** |
| **15.3** | RLS enforcement | **L** | Non-owner app role + `FORCE ROW LEVEL SECURITY` + policies; transaction wrapping per 15.0's pattern; two-role int suite with **cross-tenant negative tests**. **D-15.3-7 (2026-07-26): audit B.4 (alert-reconcile throttle) MOVED to 15.4** — it is a performance refinement with no isolation content, and keeping 15.3 a pure security slice gives it a single review lens. |
| **15.4** | RBAC | M–L | Four fixed roles + per-project grants; enforcement at route **and** policy layer; connector-approval authority (audit B.7); catalog approval + per-org firing fan-out (audit B.5, D-M15-9). **Inherits audit B.4** (alert-reconcile throttle / move off the SSE path) from 15.3 per D-15.3-7 — 15.3 measured a single-query RLS cost (+10–20 %) but did NOT measure connection-pool pressure, and the SSE path (one transaction per tick per connected client) is where that would surface first. **Also inherits the `userId`-only read backlog** (PR #63 review): eleven repository reads — `machineStatuses`, `connectorHealth`, `activeSessions`, `recentBacklogSamples`, `listProjects`, `createProject`, `listWorkspaces`, `remapWorkspace`, `gitCommitDetail`, `resolveWorkspaceId`, `listAlertFirings` — still scope by `userId` with **no `org_id` predicate**, so RLS is their PRIMARY defence rather than their backstop, inverting D-M15-3. Correct only while every org is personal and single-user (D-M15-4), which is exactly what THIS slice ends: once an org holds several users, `userId` and `orgId` stop being 1:1 and these become the only reads in the codebase with no application-layer tenancy predicate. Thread `orgId` through them **as part of 15.4, before the second user exists** — the sharpest tell is `listAlertFirings`, whose sibling `ackAlertFiring` already takes one. |
| **15.5** | Identity core | **L** | User CRUD; invite-by-email over the 13.5 SMTP deliverer; password reset; gated self-signup (D-M15-6). **Closes the pairing-code user-creation primitive (D-M15-8, audit C.9) — security-gating for 15.7.** |
| **15.6** | Sessions + revocation | M | `sessions` table; revoke-one / revoke-all; invalidate on credential change (D-M15-12). Prereq for 15.7/15.8. |
| **15.7** | SSO — Google + GitHub | **L** | OAuth identity only; account linking with **explicit anti-takeover rules** (never auto-adopt an unverified pre-existing email row). Depends on 15.5 + 15.6. |
| **15.8** | MFA | M | TOTP enrolment + recovery codes; invalidate sessions on enrol/disable. |
| **15.9** | API keys + retire `ADMIN_TOKEN` | M–L | Hashed, revocable, attributable per-user keys; migrate the **desktop app** (`keychain.rs`/`proxy.rs`/`server.rs`) and `scripts/generate-reports.mjs`; demote `ADMIN_TOKEN` to a bootstrap-only seed (D-M15-7). Rust-side work. |
| **15.10** ✅ | Team surfaces + audit table | M | **DONE `2026-08-02`.** `/invite/[token]` (public — the emailed link had 404'd since 15.5), `/team` (roster + pending invites + all four mutations, viewer-safe), `<ApiKeysCard/>` + `<OrgCard/>` (hidden for a solo org per D-M15-10, gated on member COUNT not `is_personal`), eleven proxy routes, `GET`/`PATCH /v1/org` (rename is **owner**-only), and `DELETE /v1/members/:userId/mfa` — the admin MFA reset 15.8 refused to ship without 15.5's rank floor plus an audit record. `audit_events` is a **fourth RLS classification: APPEND-ONLY** (D-15.10-2) — one `PERMISSIVE FOR INSERT WITH CHECK (true)` policy, no read/update/delete policy, `REVOKE UPDATE, DELETE`, `FORCE` deliberately omitted so break-glass survives. Writes are in-transaction with the action (D-15.10-3). No viewer (D-15.10-4). Multi-org deferred to M16 (D-15.10-1). |

---

## Risks

1. **15.2 is the widest single edit in this repo's history** (~60 gate call sites, 11 route files,
   plus the projection repos). It is mechanical but broad; a missed site is a silent
   wrong-tenant read until 15.3's RLS backstop lands. Mitigation: land 15.3 immediately after, and
   do not let the two drift apart across releases.
2. **Transaction wrapping (D-M15-3) touches nearly every read path.** If 15.0's spike shows the
   cost is worse than estimated, the fallback is RLS on the highest-value tables only
   (`events`, `raw_source_records`, `report_artifacts`, `search_documents`) with application
   scoping everywhere else — decide in 15.0, not mid-15.3.
3. **Scope.** With all identity paths in (D-M15-5), M15 is roughly **1.5× M12** — the largest
   milestone attempted here. 15.7 and 15.8 are deliberately sequenced last so the cut line is
   clean if the milestone needs to ship early.
4. **`db:rollback` must be proven on a backfill migration.** 15.1's `down/` SQL drops columns
   carrying real data; the rollback drill must run against a **copy** of the live archive.

---

## Pre-sign-off checklist (D-M15-13 — every box, maintainer manual)

Adopted from M14's practice, which is what stopped manual actions from slipping. Evidence under
`.agents/qa/m15-signoff/`.

- [ ] Cross-tenant negative test verified live: connect as the **app role**, attempt a read across
      orgs, observe **0 rows** (not merely a green suite)
- [ ] `FORCE ROW LEVEL SECURITY` confirmed on every tenant table (owner-bypass proven closed)
- [ ] Google OAuth app registered; live login E2E
- [ ] GitHub OAuth app registered; live login E2E
- [ ] Account-linking anti-takeover verified: a pre-seeded email row is **not** adopted by an SSO login
- [ ] Invite email delivered live (Mailpit or real SMTP) and redeemed end-to-end
- [ ] Password-reset E2E
- [ ] MFA enrol + login + recovery-code E2E; session invalidation on disable
- [ ] Desktop app runs with an API key, `ADMIN_TOKEN` removed from the keychain; pairing + Monitor
      round-trip green
- [ ] `reports:generate` runs authenticated by an API key
- [ ] Migration + `db:rollback` → `db:migrate` cycle proven on a **copy of the real archive**
- [ ] `npm run repo-health -- --require-db` green with **0 skipped**

---

## Invariant amendments (land with the slice that makes them true)

- **CLAUDE.md "Invariants"** — amend the events/attribution rule with the D-M15-2 fixed-at-capture
  test. Land in **15.1**.
- **CLAUDE.md "Validation is a GATE"** — add the two-role integration requirement (RLS is not
  exercised by an owner-role test run; an owner-only suite reports green while enforcing nothing).
  Land in **15.3**.
- **`docs/guide/operations.md`** — the non-owner app role, `SET LOCAL` discipline, API-key issuance
  and revocation, and the corrected break-glass procedure (DB access, not an HTTP token). Land in
  **15.3** and **15.9** respectively.
