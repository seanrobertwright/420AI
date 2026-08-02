# Remaining Milestones & Slices — outline

> **SUPERSEDED 2026-08-02 (slice 16.0) — read [`SUMMARY.md`](../../SUMMARY.md) §3/§6 for current
> state.** This snapshot was taken on 2026-08-01, one day before M15 closed, and it is stale in three
> ways: **M15 is DONE** (15.9 and 15.10 shipped; the "in flight PR #68" note below is spent),
> **`M16` no longer means Cloud-hosted SaaS** — that milestone was renumbered **M20** and `M16` is now
> _Dogfood Instrumentation & Data Trust_
> ([`m16-dogfood-instrumentation.md`](../plans/m16-dogfood-instrumentation.md)) — and the
> unsequenced bucket is therefore **M17–M20**. The milestone numbers below have been repointed to M20
> so no live document says `M16` and means SaaS (D-16.0-1); **the rest of the snapshot is deliberately
> left as it was**, because it is a dated projection, not a maintained index.
>
> Snapshot: **2026-08-01**. Derived from [`SUMMARY.md`](../../SUMMARY.md) §3/§6, [`docs/PRD.md`](../../docs/PRD.md) §25,
> and [`.agents/plans/m15-multi-user-access-control.md`](../plans/m15-multi-user-access-control.md).
> This is a **projection, not a new commitment** — it re-states scope already settled in those files
> and invents nothing. Where a milestone has no slices yet, that is stated rather than filled in.

## Legend

| Mark | Meaning                                                                      |
| ---- | ---------------------------------------------------------------------------- |
| 🔨   | Sliced and executable now                                                    |
| 🕳️   | Committed scope, **not yet sliced** — needs its deferral-audit + scope convo  |
| ⏸️   | Deferred item with a named home                                              |

**Done and out of scope for this outline:** M1–M14 (all ✅), and M15 slices 15.0–15.8.

---

## M15 — Multi-user & access control · IN PROGRESS 🔨

Plan: [`m15-multi-user-access-control.md`](../plans/m15-multi-user-access-control.md).
Settled decisions: org-level tenancy (D-M15-1), RLS as **backstop** behind primary application
scoping (D-M15-3), four fixed roles + per-project grants (D-M15-4), all four identity paths + reset +
MFA (D-M15-5), `ADMIN_TOKEN` retired to a bootstrap-only seed (D-M15-7).

**Shipped:** 15.0 spike · 15.1 tenancy schema · 15.2 request principal · 15.3 RLS · 15.4 RBAC ·
15.5 identity core · 15.6 sessions + revocation · 15.7 SSO · 15.8 MFA.
**In flight:** PR #68 (15.8) open on `m15-slice8-mfa`.

### 15.9 — API keys + retire `ADMIN_TOKEN` · size M–L

The last credential slice, and the only one with **Rust-side work**.

- Hashed, revocable, **attributable per-user** API keys (a real principal, not a shared secret).
- Migrate the desktop app off `ADMIN_TOKEN`: `keychain.rs`, `proxy.rs`, `server.rs`.
- Migrate `scripts/generate-reports.mjs` to key auth.
- Demote `ADMIN_TOKEN` to an **inert first-run bootstrap seed** (D-M15-7) — no longer an auth credential.
- Land the `docs/guide/operations.md` amendment: API-key issuance/revocation + the corrected
  **break-glass procedure** (direct DB access, not an HTTP token).

_Gated by:_ 15.5 (identity core) for the user a key attaches to.

### 15.10 — Team surfaces + audit table · size M

The slice that makes the org visible in the product.

- Dashboard: user/member management, invites, role assignment, API-key management.
- Org settings — **hidden for a solo org** (D-M15-10), so a single-user install sees no new chrome.
- **Write-only audit table** — the table ships here; the **viewer is explicitly deferred** (non-goal).
- Absorbs two 15.8 deferrals: **QR rendering** for TOTP enrolment (D-15.8-14) and any org-level
  **"require MFA" policy** (D-15.8-2).

_Note:_ there is deliberately **no** admin "reset MFA for user X" endpoint — it would need 15.5's full
rank ceiling-and-floor plus an audit record; break-glass is direct DB access (D-M15-7).

### M15 sign-off checklist (maintainer manual actions, evidence → `.agents/qa/m15-signoff/`)

- [ ] Cross-tenant negative test verified **live** as the app role — 0 rows, not merely a green suite
- [ ] `FORCE ROW LEVEL SECURITY` confirmed on every tenant table (owner-bypass proven closed)
- [ ] Google OAuth app registered; live login E2E
- [ ] GitHub OAuth app registered; live login E2E
- [ ] Account-linking anti-takeover: a pre-seeded email row is **not** adopted by an SSO login
- [ ] Invite email delivered live (Mailpit or real SMTP) and redeemed end-to-end
- [ ] Password-reset E2E
- [ ] MFA enrol + login + recovery-code E2E; session invalidation on disable
- [ ] Desktop app runs on an API key, `ADMIN_TOKEN` gone from the keychain; pairing + Monitor round-trip
- [ ] `reports:generate` authenticated by an API key
- [ ] Migration + `db:rollback` → `db:migrate` cycle proven on a **copy of the real archive**
- [ ] `npm run repo-health -- --require-db` green with **0 skipped**

### M15 non-goals (name in every PR)

Billing / quotas / per-tenant rate limits · multi-tenant hosting, managed archive, multi-region (M20) ·
cross-platform collectors, portable signed installers (M17) · enterprise SAML/OIDC, SCIM / directory
sync · user-defined or custom roles · audit-log **UI** · semantic/vector search (M18) · mobile (M19) ·
MSI/code signing (parked).

---

## M17–M20 — committed scope, unsequenced 🕳️

Committed **2026-07-21**: the scope conversation asked for one strategic direction and the answer was
all three — deepen the single-user product, go multi-user/SaaS, extend cross-platform reach.

Two things are true of every milestone below:

1. **The numbering is inherited from the old PRD sketch and is not an execution order.** Sequencing is
   driven by _who the next milestone is for_, not technical dependency (the criterion that promoted M15).
2. **None is executable yet.** Each needs the deferral-audit + scope-conversation pass that produced
   M12/M13/M14/M15. Several will sub-slice as heavily as those did.

The bullets under each are the **committed scope items as written** — read them as candidate slice
seeds, not as slices.

### M20 — Cloud-hosted SaaS 🕳️

_Genuinely depends on M15 and the M12 ops baseline. Biggest architectural shift — local-first stays a
first-class deployment mode alongside hosted._

- Multi-tenant hosted deployment + tenancy isolation at the hosting layer
- Managed / hosted archive
- Scale hardening: quotas + rate limits **beyond** M12 §12.4
- Billing / subscriptions
- Hosted onboarding

### M17 — Cross-platform collectors 🕳️

_Most parallelizable — the strongest candidate to run **alongside** another milestone rather than in
sequence. The architecture was kept portable for exactly this._

- macOS collector (V1/M11 are Windows-first)
- Linux collector
- Portable **signed** installers + auto-update across OSes (extends M12 §12.8 distribution)

### M18 — Advanced intelligence & automation 🕳️

_Deepens data already captured; benefits from M14's larger corpus._

- Semantic / vector search (V1 ships keyword FTS from 12.1)
- Scheduled **analysis** (scheduled report _generation_ already shipped in 13.6; V1 analysis is manual-first)
- Active **in-tool context-rule enforcement** (V1 only recommends)
- Richer trend / anomaly detection
- Subscription cost amortization

### M19 — Connector ecosystem & local models 🕳️

_Extensibility + breadth; naturally last._

- **Script/plugin** custom-connector runtime (V1 is config-only)
- Full **local-model lifecycle** management (V1 supports hosted + OpenAI-compatible APIs)
- Graduate the experimental connector catalog: opencode, Aider, Copilot, Windsurf, Continue, Cline, …
- **Mobile** consumption app — see the open question below

---

## Cross-cutting deferrals with a named home ⏸️

| Item                                                                                        | Home                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| TOTP **QR rendering** (D-15.8-14)                                                            | 15.10                                      |
| Org-level **"require MFA"** policy (D-15.8-2)                                                 | 15.10                                      |
| Audit-log **viewer** UI (table ships write-only in 15.10)                                    | post-M15, unassigned                       |
| Browser-extension **ChatGPT/Gemini origins**, SSE interception, `claude-live` ↔ `claude-export` dedup | M19 fold-in (tracked as M14 deferrals) |
| MSI / code signing                                                                           | **parked indefinitely** (M12 12.8 decision) |

### Open question to resolve at promotion time

**Where the mobile app lives.** PRD §25 sketches it inside M19, but it pairs at least as naturally with
M20 as a consumption surface. Resolve in the scope conversation that promotes whichever of the two runs
first — do not settle it here.

---

## Suggested next actions (not scope)

1. Land PR #68 → M15 is one identity slice from complete.
2. Slice **15.9**, then **15.10** — 15.9 first, since 15.10's API-key management UI needs 15.9's keys.
3. Work the M15 sign-off checklist as slices land, not in a batch at the end (the M14 lesson).
4. Then run a deferral-audit + scope conversation to pick and promote **one** of M17–M20, on the
   "who is the next milestone for" criterion.
