# Feature: M15 Slice 15.8 — MFA (TOTP enrolment + recovery codes)

The following plan should be complete, but it is important that you validate documentation, codebase
patterns and task sanity before you start implementing. Pay special attention to the naming of
existing utils, types and models — import from the right files.

Conventions are **not** restated here. Read [`CLAUDE.md`](../../CLAUDE.md) — in particular the
15.5 "name the mechanism" rule, `skipped ≠ passed` / `bypassed ≠ enforced`, the explicit-column-list
rule (15.1), and the `orgId`/`userId`-is-always-the-second-parameter discipline. Milestone context:
[`.agents/plans/m15-multi-user-access-control.md`](./m15-multi-user-access-control.md);
slice status in [`SUMMARY.md`](../../SUMMARY.md) §6.

---

## Feature Description

Second-factor authentication for the human login paths. A user opts in from Settings, scans/enters a
TOTP secret into an authenticator app, confirms with a live code, and receives ten single-use
recovery codes. From then on **every** path that mints a session for that user — password login
**and** SSO callback — stops one step short: it returns a short-lived, domain-separated **MFA
challenge** instead of a session token, and the session is only minted once
`POST /v1/auth/mfa/verify` is satisfied by a TOTP code or a recovery code.

This is the eighth of ten M15 slices and the last identity slice (15.9 is API keys, 15.10 is team
surfaces). It depends on 15.6 (`sessions` + `mintSession`) and touches 15.7's SSO callback.

## User Story

As a **member of a 420AI organization whose account can reach every session transcript in the
archive**
I want to **require a time-based code from my authenticator app before anyone can sign in as me**
So that **a leaked or reused password — or a compromised Google/GitHub account — is not by itself
enough to read my organization's data.**

## Problem Statement

After 15.5–15.7 there are five ways to become authenticated (password login, invite acceptance,
self-signup, password reset, SSO) and **all five terminate in a single-factor secret**. The archive
holds decrypted session transcripts, tokens, costs and git history for an entire organization, so
a single compromised password grants full read access to every member's work. `D-M15-5` committed
"TOTP MFA with recovery codes" as part of M15's identity scope, and the D-M15-13 pre-sign-off
checklist has an unticked box for it: _"MFA enrol + login + recovery-code E2E; session invalidation
on disable."_

Three sub-problems make this more than "add a TOTP library":

1. **Two-step login reopens a race 15.6 closed.** 15.6's login holds a `FOR SHARE` lock on the
   `users` row across scrypt so a concurrent password reset cannot have its `revokeAllSessions` run
   past a session that is about to be inserted. Splitting login into *authenticate now, mint later*
   puts an arbitrary gap between the credential check and the insert, which the lock cannot span.
2. **A stateless challenge cannot count attempts.** A six-digit code has 10⁶ possibilities and a
   ±1-step window makes three of them live at any moment. Per-IP rate limiting does not bound an
   attacker who already holds the password and can request a fresh challenge at will.
3. **SSO is a bypass unless it is gated too.** If MFA only guards the password path, an attacker who
   compromises the linked Google account signs in with no second factor and the enrolment was
   theatre.

## Solution Statement

- A **zero-dependency TOTP core** in `apps/ingest/src/mfa/totp.ts` (RFC 4226 HOTP + RFC 6238 TOTP +
  RFC 4648 base32), verified against the RFCs' own published test vectors. Same precedent as
  `password.ts` (scrypt from `node:crypto`) and M10's ed25519 verify — no new package, which also
  keeps the `node:sea` desktop sidecar build unaffected.
- Two new **identity** tables — `totp_credentials` (one row per user, secret **encrypted at rest**)
  and `mfa_recovery_codes` (sha256-hashed, single-use) — with **no `org_id` and no RLS policy**,
  joining `users`/`memberships`/`password_reset_tokens`/`sessions`/`sso_identities` in
  `NO_RLS_TABLES`.
- A **domain-separated, stateless MFA challenge token**: HMAC-signed under a key *derived* from
  `SESSION_SECRET`, so a challenge can never verify as a session and a session can never verify as a
  challenge. It carries a **credential-version fingerprint** (`cv`) which the verify route re-checks
  under the *same* `FOR SHARE` lock the 15.6 login takes — which is how problem 1 is closed.
- A **per-user lockout counter** on `totp_credentials` (an atomic blind increment), because a
  stateless challenge has nowhere to count — problem 2.
- The SSO callback routes through the **same** gate as password login — problem 3.

---

## Feature Metadata

**Feature Type**: New Capability
**Estimated Complexity**: Medium–High (M15 slice table says **M**; the SSO gate and the
credential-version binding push it toward the top of that band)
**Primary Systems Affected**: `packages/db` (schema, migration `0020`, one new repository, key
rotation), `apps/ingest` (new `mfa/` module, new route file, login + SSO callback changes),
`apps/dashboard` (login two-step, Settings enrolment island, three proxy route handlers, middleware)
**Dependencies**: **None new.** Everything uses `node:crypto`, the existing `encryptField`, and the
existing `hashToken`. Verified: `apps/ingest` has no TOTP/QR dependency and none is added.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

Backend:

- `apps/ingest/src/routes/auth.ts` (**whole file**, esp. `mintSession` at :83-97, the login route at
  :141-178, reset-confirm at :380-417, `POST /v1/auth/password` at :420-455) — Why: the exact shape
  every new route must mirror, and the login route is the one being split in two.
- `apps/ingest/src/routes/sso.ts` (:186-276) — Why: `resolveSsoLogin` returns a discriminated outcome
  and the callback calls `mintSession`; that call becomes the shared gate.
- `apps/ingest/src/session.ts` (whole file) — Why: `signSession`/`verifySession` are the primitives
  the challenge is deliberately kept *separate but parallel* to. Note the load-bearing "pure crypto,
  no database" split at :12-16.
- `apps/ingest/src/auth.ts` (:50-115 `resolvePrincipal`, :133-135 `authorized`, :143-145 `isUuid`) —
  Why: every session-gated MFA route opens with the same 401/403 pair.
- `apps/ingest/src/password.ts` (whole file) — Why: the "hand-rolled crypto in `apps/ingest`, not
  `packages/shared`" precedent the TOTP core follows, and `verifyPassword` is used by the disable
  route.
- `apps/ingest/src/plugins/auth.ts` (:9-79) — Why: the Fastify module augmentation. **No new
  decorator is needed** (this slice adds no env), and that is a deliberate outcome, not an omission.
- `apps/ingest/src/app.ts` (:209-231 registration order; :233-270 the typed-error → status mapping) —
  Why: `mfaRoutes` registers beside `ssoRoutes`, and `MfaError` joins the `setErrorHandler` chain
  next to `SsoIdentityError` (:255).
- `apps/ingest/src/schemas.ts` (:21-29 `loginBodySchema`, :509-528 the SSO bodies, :552-560
  `changePasswordBodySchema`) — Why: the ajv body-schema style, including
  `additionalProperties: false`.
- `apps/ingest/src/routes/org-scoping.test.ts` (:43-84 `ALLOWED_WITHOUT_WITHORG`, :133-140 "explains
  itself in its own source") — Why: **a new route file fails this suite** unless it is allow-listed
  *and* its own header mentions `M15 15.3`.
- `packages/db/src/schema.ts` (:96-104 `users`, :200-218 `passwordResetTokens`, :220-254 `sessions`,
  :256-298 `ssoIdentities`) — Why: the identity-table comment discipline and column style the two new
  tables mirror.
- `packages/db/src/repositories/sessions.ts` (whole file) and
  `packages/db/src/repositories/sso-identities.ts` (whole file) — Why: the closest structural twins
  of the new repository — explicit column lists, `userId` second, one typed error, silent library.
- `packages/db/src/repositories/password-resets.ts` (:51-71) — Why: `FOR UPDATE`-locked mint, the
  pattern the recovery-code replacement mirrors.
- `packages/db/src/tokens.ts` (whole file) — Why: `generateToken()` / `hashToken()`, reused verbatim
  for recovery codes.
- `packages/db/src/crypto.ts` (:35-39 `EncryptedField`, :91-110) — Why: `encryptField`/`decryptField`
  for the TOTP secret; exported from the barrel at `packages/db/src/index.ts:37`.
- `packages/db/src/repositories/key-rotation.ts` (:17-52 `rotateTable` + `RotationCounts`, :55-115) —
  Why: a **new encrypted column must be added to the rotation pass**, or `reencryptAll`'s promise
  ("every encrypted row under the active key") becomes false.
- `packages/db/src/repositories/rls.int.test.ts` (:136-155 `NO_RLS_TABLES`, :454-520 the policy
  inventory) — Why: the two new tables go in `NO_RLS_TABLES`; **every count in that test is derived,
  so no number moves.**
- `packages/db/drizzle/0019_outstanding_silhouette.sql` + `down/0019_….down.sql` — Why: the exact
  header-comment shape migration `0020` copies (including the "no policy block, and that absence is
  the decision" paragraph and the no-`GRANT`-needed note).
- `apps/ingest/src/identity.int.test.ts` (:36-52 the two-role header, :104-125 `buildApp` wiring,
  :126-152 `login`/`asUser`/`json` helpers, :183-215 the `TRUNCATE` + seed block) — Why: **the exact
  harness the new int suite copies.** Note `setUserPassword(owner.db, email, hashPassword(PASSWORD))`
  and the "MOVE the membership, never insert a second" rule at :195-206.
- `apps/ingest/src/sso.int.test.ts` (:60-140) — Why: the most recent two-role suite; its
  `TRUNCATE` comment at :132-133 records the fact this slice relies on (see GOTCHA-3).

Frontend:

- `apps/dashboard/src/app/api/auth/login/route.ts` (whole file) — Why: the cookie-setting login proxy
  that gains the `mfaRequired` branch.
- `apps/dashboard/src/app/api/auth/sso/[provider]/callback/route.ts` (:76-120) — Why: the second
  place a session cookie is set; it gains the same branch.
- `apps/dashboard/src/lib/sso-flow.ts` (whole file) — Why: the "one cookie, one definition, and the
  **path must be passed to `delete` as well as `set`**" pattern the MFA challenge cookie copies. That
  bug shipped once in 15.7; do not re-introduce it.
- `apps/dashboard/src/components/auth/login-form.tsx` (whole file) and
  `apps/dashboard/src/components/settings/sso-links.tsx` (whole file) — Why: the client-island
  patterns (busy state, `cancelled` teardown armed before the first await, error copy map).
- `apps/dashboard/src/middleware.ts` (:14-21) — Why: **`PUBLIC` matches by exact equality**, so
  `/login/mfa` is NOT public unless it is added. Missing this is a redirect loop.
- `apps/dashboard/src/lib/proxy.ts` (`proxyJson`) — Why: every authenticated dashboard→ingest hop.
- `apps/dashboard/src/app/settings/page.tsx` + `components/settings/settings-view.tsx` — Why: where
  the enrolment island mounts.

### New Files to Create

| Path | Purpose |
| --- | --- |
| `apps/ingest/src/mfa/totp.ts` | RFC 4648 base32 + RFC 4226 HOTP + RFC 6238 TOTP + `otpauthUri` |
| `apps/ingest/src/mfa/totp.test.ts` | The RFC vectors as a unit test (no infra) |
| `apps/ingest/src/mfa/challenge.ts` | Domain-separated challenge sign/verify + `credentialVersion` |
| `apps/ingest/src/mfa/challenge.test.ts` | Domain-separation + expiry + tamper unit tests |
| `apps/ingest/src/routes/mfa.ts` | The six endpoints |
| `apps/ingest/src/mfa.int.test.ts` | The slice's two-role HTTP proof |
| `packages/db/src/repositories/mfa.ts` | `totp_credentials` + `mfa_recovery_codes` repository |
| `packages/db/src/repositories/mfa.int.test.ts` | Repository-level concurrency proofs |
| `packages/db/drizzle/0020_<generated>.sql` | Generated DDL + the identity-table header comment |
| `packages/db/drizzle/down/0020_<generated>.down.sql` | Hand-authored down |
| `apps/dashboard/src/lib/mfa-flow.ts` | The challenge cookie's single definition |
| `apps/dashboard/src/app/login/mfa/page.tsx` | The second-step page |
| `apps/dashboard/src/components/auth/mfa-form.tsx` | The code-entry island |
| `apps/dashboard/src/app/api/auth/mfa/verify/route.ts` | Unauthenticated exchange → session cookie |
| `apps/dashboard/src/app/api/auth/mfa/route.ts` | Status + enrol/confirm/disable proxies |
| `apps/dashboard/src/app/api/auth/mfa/recovery-codes/route.ts` | Regeneration proxy |
| `apps/dashboard/src/components/settings/mfa-card.tsx` | The Settings enrolment island |

### Relevant Documentation — READ THESE BEFORE IMPLEMENTING

- [RFC 6238 — TOTP](https://datatracker.ietf.org/doc/html/rfc6238)
  - §4 (algorithm: `T = floor((now - T0) / X)`, X = 30), §5.2 (**a validated code must not be
    accepted a second time within the same step** — this is the `last_step` column), §6 (resync /
    skew window).
  - Why: the verification window and the replay rule are both normative, and both are implemented.
  - Appendix B holds the test vectors the unit test uses.
- [RFC 4226 — HOTP](https://datatracker.ietf.org/doc/html/rfc4226)
  - §5.3 (dynamic truncation), §5.4 (Appendix D test vectors), §7.3 (throttling: "we RECOMMEND
    setting a throttling parameter T, which defines the maximum number of possible attempts").
  - Why: dynamic truncation is easy to get subtly wrong, and §7.3 is the citation for the lockout.
- [RFC 4648 §6 — Base 32 Encoding](https://datatracker.ietf.org/doc/html/rfc4648#section-6)
  - Why: the alphabet and the bit-packing order authenticator apps expect.
- [Key URI Format (`otpauth://`)](https://github.com/google/google-authenticator/wiki/Key-Uri-Format)
  - Sections: *Label*, *Issuer*, *Secret*.
  - Why: the label is `issuer:account` and **both halves must be percent-encoded**; a raw `@` or `:`
    in the label breaks parsing in several apps.
- [OWASP MFA Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)
  - Sections: *TOTP*, *Reset/Recovery*.
  - Why: the source of "store recovery codes hashed, single-use", and of the rule that MFA state
    changes must re-authenticate.
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
  - Section: *Renew the Session ID After Any Privilege Level Change*.
  - Why: the citation for revoking other sessions on enrol/disable.

### Patterns to Follow

**The TOTP core — proven by SPIKE 1 (see NOTES for the run output).** Transcribe this shape; every
line below was executed and checked against the RFC vectors.

```ts
// apps/ingest/src/mfa/totp.ts
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648 §6

export function base32Encode(buf: Buffer): string { /* 5-bit accumulator; pad the tail */ }
export function base32Decode(s: string): Buffer { /* strip "=" + whitespace, uppercase */ }

/** RFC 4226 §5.3 dynamic truncation. `counter` is a step number, not a timestamp. */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}
```

**Assertions this snippet must keep satisfying (SPIKE 1 checked all of them):** HOTP counters 0–9
over the ASCII secret `"12345678901234567890"` produce `755224, 287082, 359152, 969429, 338314,
254676, 287922, 162583, 399871, 520489`; the same secret base32-encodes to
`GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`; and the RFC 6238 8-digit vectors hold at
`t = 59 / 1111111109 / 1111111111 / 1234567890 / 2000000000 / 20000000000`.

**`verifyTotp` returns the MATCHED STEP, never a boolean** — the caller needs the step number to
enforce the replay rule:

```ts
/** Returns the step the code matched, or null. Skew ±1 step (±30 s) per RFC 6238 §6. */
export function verifyTotp(
  secret: Buffer,
  code: string,
  opts: { nowMs: number; skew?: number },
): number | null {
  if (!/^\d{6}$/.test(code)) return null;              // shape first — no HMAC for garbage
  const step = Math.floor(opts.nowMs / 1000 / 30);
  const skew = opts.skew ?? 1;
  for (let d = -skew; d <= skew; d++) {
    if (constantTimeEqual(hotp(secret, step + d), code)) return step + d;
  }
  return null;
}
```

**Constant-time compare, length-guarded** (`timingSafeEqual` *throws* on a length mismatch — mirror
`password.ts:26` and `auth.ts:71-73`):

```ts
function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
```

**The challenge primitive — proven by SPIKE 4.** Structurally parallel to `session.ts` and
deliberately *not* sharing its key:

```ts
// apps/ingest/src/mfa/challenge.ts
const CHALLENGE_PURPOSE = "420ai.mfa.challenge.v1";
export const CHALLENGE_TTL_SECONDS = 5 * 60;

/** DOMAIN SEPARATION: the challenge is signed under a DERIVED key, never `sessionSecret` itself. */
function challengeKey(sessionSecret: string): Buffer {
  return createHmac("sha256", sessionSecret).update(CHALLENGE_PURPOSE).digest();
}

/** Binds a challenge to the credential it was issued against — see GOTCHA-1. */
export function credentialVersion(sessionSecret: string, passwordHash: string | null): string {
  return createHmac("sha256", challengeKey(sessionSecret))
    .update(`cv:${passwordHash ?? ""}`)
    .digest("base64url")
    .slice(0, 22);
}
```

**Assertions this must keep satisfying (SPIKE 4 checked all of them):** `verifySession(challenge,
secret) === null`; `verifyChallenge(sessionToken, secret) === null`; a body swapped under a stolen
MAC fails; an `exp` in the past fails; `credentialVersion` changes when the password hash changes,
is stable for the same hash, and is defined for a `null` hash (an SSO-only user).

**Repository shape** — copy `repositories/sessions.ts` exactly: `DbClient` first, `userId` **second**,
explicit `const …RowColumns` for anything reaching `reply.send()`, one typed `MfaError` with a
`reason` union, silent library.

**Route shape** — copy the four 15.6 session routes in `routes/auth.ts:474-568`: `resolvePrincipal`
→ 401, `authorized(principal, "viewer")` → 403, then the work. `viewer` is correct for every
session-gated MFA route for the reason `POST /v1/auth/password` records at :428-429: *managing your
own credential is not a privileged act on the org.*

---

## DESIGN DECISIONS (D-15.8-1 … D-15.8-15)

Record these in the execution report and in `SUMMARY.md`.

**D-15.8-1 — TOTP is hand-rolled in `apps/ingest/src/mfa/`, with zero new dependencies.** Precedent:
`password.ts` (scrypt), M10's ed25519 catalog verify, 15.7's plain-`fetch` OAuth. It lands in
`apps/ingest`, **not `packages/shared`**, for the same reason `password.ts` does: it is server-only
crypto with exactly one consumer, and `apps/dashboard` imports the `@420ai/shared` barrel into
client components — a `node:crypto` import reachable from that barrel is a bundling hazard for no
benefit.

**D-15.8-2 — MFA is a per-USER opt-in. There is no deployment-wide or per-org enforcement setting,
and no new env var.** An org-level "require MFA" policy is a *team* control and belongs with the
other org settings in 15.10; inventing an env flag here would be a second, undiscoverable place to
configure it. Consequence to state plainly: an operator cannot yet force members to enrol.

**D-15.8-3 — The challenge is STATELESS and domain-separated; there is no `mfa_challenges` table.**
Mirrors 15.7's reasoning for holding no per-flow server state (`routes/sso.ts:208-210`): an
unauthenticated endpoint that allocates a row per attempt is a free write amplifier. The security
property is not "it is unguessable" but "it is signed under a key nobody else can derive **and it is
not a session**" — a challenge that verified as a session would be a complete MFA bypass, which is
why the derived key (D-15.8-4's sibling) is asserted in both directions by a unit test.

**D-15.8-4 — The challenge carries a credential-version fingerprint, re-checked under the 15.6
`FOR SHARE` lock.** THIS IS THE SUBTLEST PART OF THE SLICE. See GOTCHA-1.

**D-15.8-5 — MFA gates the SSO callback too.** An enrolled user's SSO login returns a challenge just
as their password login does. Without this, "enable MFA" would mean "enable MFA unless the attacker
uses the Google button", and the linked identity is exactly what an attacker who owns the mailbox
controls. It costs one shared helper, not a second implementation — see Task 9.

**D-15.8-6 — The TOTP secret is ENCRYPTED at rest with the existing `encryptField`, and
`reencryptAll` is extended to cover it.** A TOTP secret is a *symmetric bearer credential*: anyone
holding it can generate valid codes forever, so a leaked backup would defeat MFA for every enrolled
user silently. The repo already has AES-256-GCM field encryption and a rotation script whose stated
promise is "every encrypted row under the active key" — adding a fourth encrypted column without
extending `reencryptAll` would make that promise false, which is precisely the class of comment
CLAUDE.md's 15.5 lesson forbids. Recovery codes are **hashed**, not encrypted, because they are
verified by comparison and never need to be read back.

**D-15.8-7 — Recovery codes are sha256-hashed via the existing `hashToken`, NOT scrypt.** They are
machine-generated `randomBytes(32)` (`generateToken()`), so there is no dictionary to defend against
— the same argument `invites.token_hash` and `ingest_tokens.token_hash` already make. Using scrypt
would additionally mean **ten** ~100 ms hashes per redemption attempt on the event loop, since a
presented code must be checked against every unused row. (Hashing lets us look the row up by hash in
one indexed probe instead — see `redeemRecoveryCode`.)

**D-15.8-8 — Replay is prevented by a monotonic `last_step`, per RFC 6238 §5.2.** A code accepted at
step N is never accepted again: the successful-use write is
`UPDATE … WHERE user_id = $1 AND (last_step IS NULL OR last_step < $2) RETURNING`, and an empty
return means "this step was already spent" → the same 401 a wrong code gets. `last_step` is
`integer`, not `bigint` — see GOTCHA-4.

**D-15.8-9 — Attempts are throttled by a per-user counter on `totp_credentials`
(`failed_attempts` / `locked_until`), not only by the per-IP rate limit.** RFC 4226 §7.3. The
mechanism is an **atomic blind increment** (`failed_attempts = failed_attempts + 1`), which takes no
read-then-write window — verified by SPIKE 3 with two concurrent connections. Threshold **10**
consecutive failures → **15 minutes** locked; a success resets both fields. Both constants live in
`routes/mfa.ts` as named exports so the int test can drive them.

**D-15.8-10 — Enrolment is TWO-PHASE: `enroll` stores an UNCONFIRMED secret, `enroll/confirm`
proves the user's authenticator agrees.** `confirmed_at IS NULL` means the credential does not
gate anything, so a user who abandons enrolment (wrong clock, wrong app, closed tab) is never locked
out of their own account. Re-running `enroll` on an unconfirmed row replaces the secret; running it
on a **confirmed** row throws `MfaError("already_enrolled")` → 409, because silently rotating a
working second factor from a session that has not re-proved anything is a takeover primitive.

**D-15.8-11 — Enrol-confirm and disable both revoke every OTHER session (sparing the caller's).**
OWASP Session Management, and the same asymmetry `POST /v1/auth/password` documents at
`routes/auth.ts:446-451`: the caller has just re-proved a factor in this tab, so logging *them* out
is a usability tax with no security gain, while every other live session predates the change.

**D-15.8-12 — Disabling MFA, and regenerating recovery codes, require a live TOTP or recovery
code in the body.** A session alone is not enough: an attacker holding a stolen session cookie must
not be able to switch the second factor off. This is the MFA analogue of `POST /v1/auth/password`
demanding the current password.

**D-15.8-13 — Both tables are IDENTITY tables: no `org_id`, no RLS policy.** Same argument as
`sessions` (D-15.6-3) and `sso_identities` (D-15.7-3): they are read at the one moment before any org
context exists. They join `NO_RLS_TABLES` in `packages/db/src/repositories/rls.int.test.ts`, and
because every count in that test is derived from the list lengths, **no expected number changes**.
`userId` is the whole scoping, and it is always the second parameter.

**D-15.8-14 — No QR-code rendering in 15.8.** The enrolment UI shows the base32 secret in
manual-entry form plus a copyable `otpauth://` URI; every mainstream authenticator accepts manual
entry. A QR needs either a new dashboard dependency or ~300 lines of hand-rolled encoder, and the
place it belongs is the team/account surface slice (15.10). **State this in the execution report as
deferred scope, not as done.**

**D-15.8-15 — The `ADMIN_TOKEN` credential path is never MFA-gated.** It is a service token with no
user session (`auth.ts:65-74`), it resolves to the bootstrap admin, and D-M15-7 retires it in 15.9.
Gating it would break the desktop app for a factor it cannot present.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation (pure, no infra)

The TOTP core, the challenge primitive, and their unit tests. Both are pure functions with published
test vectors, so this phase is fully verifiable before a single row exists.

### Phase 2: Persistence

Schema + generated migration `0020` + hand-authored down + the `mfa.ts` repository + the key-rotation
extension + `NO_RLS_TABLES`.

### Phase 3: Ingest routes

The six MFA endpoints, the login split, the SSO gate, `MfaError` in the error handler, the
`org-scoping.test.ts` allow-list entry.

### Phase 4: Dashboard

The challenge cookie, the two-step login, the `/login/mfa` page + middleware entry, the Settings
island, four proxy route handlers.

### Phase 5: Testing, docs, validation

The two-role HTTP suite, the repository concurrency suite, the operations-guide section, `SUMMARY.md`.

---

## STEP-BY-STEP TASKS

Execute in order. Each task is atomic and independently validated.

### 1. CREATE `apps/ingest/src/mfa/totp.ts`

- **IMPLEMENT**: `base32Encode`, `base32Decode`, `hotp`, `verifyTotp`, `generateTotpSecret()`
  (`randomBytes(20)` — 160 bits, the RFC 4226 §4 R6 recommendation), `otpauthUri({issuer, account,
  secret})`.
- **PATTERN**: the snippets above; file-header discipline as in `apps/ingest/src/password.ts:3-7`.
- **IMPORTS**: `import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";` only.
- **GOTCHA**: `otpauthUri` must percent-encode **both halves of the label** —
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=…&issuer=…&algorithm=SHA1&digits=6&period=30`.
  A raw `@` or `+` in the account breaks parsing in several apps (SPIKE 1 asserted no raw `@`
  survives in the label).
- **GOTCHA**: `verifyTotp` must reject on **shape** (`/^\d{6}$/`) before computing any HMAC, so a
  junk body costs a regex.
- **VALIDATE**: `npx vitest run apps/ingest/src/mfa/totp.test.ts` (after task 2).

### 2. CREATE `apps/ingest/src/mfa/totp.test.ts`

- **IMPLEMENT**: the RFC vectors verbatim — RFC 4226 Appendix D (counters 0–9, 6 digits), RFC 6238
  Appendix B (SHA-1 rows only, 8 digits), the RFC 4648 base32 vector, random round-trips at lengths
  that exercise the padding path (1,2,3,4,6,7,9,10,16,20,32 bytes), the ±1-step window (accepts
  ±30 s, **rejects +60 s**), and `constantTimeEqual` with unequal lengths returning `false` rather
  than throwing.
- **PATTERN**: co-located `*.test.ts`, no infra (CLAUDE.md Testing).
- **GOTCHA**: RFC 6238's Appendix B table also lists SHA-256/SHA-512 rows **with different secrets**
  (`…12345678901234567890123456789012` etc.). This implementation is SHA-1 only; use the SHA-1 rows.
- **VALIDATE**: `npx vitest run apps/ingest/src/mfa/totp.test.ts` → all pass.

### 3. CREATE `apps/ingest/src/mfa/challenge.ts` + `challenge.test.ts`

- **IMPLEMENT**: `CHALLENGE_TTL_SECONDS`, `credentialVersion`, `signChallenge(sessionSecret, {userId,
  credentialVersion})`, `verifyChallenge(token, sessionSecret): {uid, cv, iat, exp} | null`.
- **PATTERN**: `apps/ingest/src/session.ts` — same `base64url(payload).base64url(mac)` framing, same
  "pure crypto + expiry, never a database" split, same null-guard after `JSON.parse` (`session.ts:75`
  — `JSON.parse` can return `null`, and `null.exp` throws).
- **IMPORTS**: `node:crypto` only. **Do not import `session.ts`** — the separation is the point.
- **GOTCHA**: the derived key is mandatory. Signing the challenge with `sessionSecret` directly would
  make a challenge whose payload happened to include a valid `sid` into a session token.
- **TEST**: the four SPIKE-4 assertions in both directions (challenge↛session, session↛challenge),
  wrong secret, swapped body under a stolen MAC, expired `exp`, and the three `credentialVersion`
  properties.
- **VALIDATE**: `npx vitest run apps/ingest/src/mfa/challenge.test.ts`.

### 4. UPDATE `packages/db/src/schema.ts`

- **IMPLEMENT**: append `totpCredentials` and `mfaRecoveryCodes` **exactly** as below (this is the
  shape SPIKE 6 generated the DDL from), each with a header comment in the style of
  `ssoIdentities` (:256-276) stating: identity table, no `org_id`, no RLS, and *why* each column
  exists.

```ts
export const totpCredentials = pgTable("totp_credentials", {
  userId: uuid("user_id").primaryKey().references(() => users.id),
  secretCiphertext: text("secret_ciphertext").notNull(),
  secretIv: text("secret_iv").notNull(),
  secretTag: text("secret_tag").notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  lastStep: integer("last_step"),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mfaRecoveryCodes = pgTable(
  "mfa_recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mfa_recovery_codes_user_hash").on(t.userId, t.codeHash),
    index("mfa_recovery_codes_by_user").on(t.userId),
  ],
);
```

- **GOTCHA**: `user_id` is the PRIMARY KEY of `totp_credentials` (one credential per user) — there is
  no separate `id`. `integer`, not `bigint`, for `last_step` (GOTCHA-4).
- **IMPORTS**: all of `pgTable/uuid/text/integer/timestamp/index/uniqueIndex` are already imported at
  `schema.ts:1-12`. Nothing new.
- **VALIDATE**: `npm run typecheck` → exit 0.

### 5. GENERATE migration `0020`

- **IMPLEMENT**: `npm run db:generate` from the repo root. **Verified non-interactive during
  planning (SPIKE 6) with stdin closed** — a pure-additive change never triggers drizzle-kit's rename
  prompt. It writes `packages/db/drizzle/0020_<random-name>.sql`, `drizzle/meta/0020_snapshot.json`
  and appends to `drizzle/meta/_journal.json`.
- **The DDL it emits is exactly this** (captured in SPIKE 6 — if what you get differs, the schema in
  task 4 was transcribed wrong):

```sql
CREATE TABLE "mfa_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "totp_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_tag" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_step" integer,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "totp_credentials" ADD CONSTRAINT "totp_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mfa_recovery_codes_user_hash" ON "mfa_recovery_codes" USING btree ("user_id","code_hash");--> statement-breakpoint
CREATE INDEX "mfa_recovery_codes_by_user" ON "mfa_recovery_codes" USING btree ("user_id");
```

- **THEN**: prepend a header comment mirroring `0019_outstanding_silhouette.sql:1-14` — that this
  migration deliberately appends **no policy block** (D-15.8-13), that the tables join
  `NO_RLS_TABLES`, and that **no `GRANT` is needed** because 0015's
  `ALTER DEFAULT PRIVILEGES … TO "420ai_app"` covers tables created by the migration owner.
  **RE-VERIFIED live for these exact table shapes during planning (SPIKE 3):** the app role received
  `DELETE, INSERT, SELECT, UPDATE` implicitly on both tables, inserted and read with no explicit
  grant, and both came up with `relrowsecurity = false`, `relforcerowsecurity = false` and zero
  policies.
- **VALIDATE**: `npm run db:migrate` then re-run against `420ai_test`
  (`DATABASE_URL=$DATABASE_URL_TEST npm run db:migrate` — the test DB is **not** migrated by
  `db:migrate`; see NOTES).

### 6. CREATE `packages/db/drizzle/down/0020_<tag>.down.sql`

- **IMPLEMENT**: `DROP TABLE IF EXISTS "mfa_recovery_codes"; DROP TABLE IF EXISTS
  "totp_credentials";` with a header in the shape of `down/0019_….down.sql`.
- **GOTCHA**: the down note must state the **rollback consequence** honestly, as 0019's does: rolling
  back **disables MFA for everyone and discards every recovery code**. That is not a lockout — a
  user's password or SSO link is untouched — but it silently downgrades every enrolled account to one
  factor, and rolling forward again does **not** restore the secrets. `db:rollback` applies only the
  latest migration, so ordering the two drops matters only in that the FK-free drop order shown is
  already safe.
- **VALIDATE**: `npm run db:rollback` then `npm run db:migrate` on the **dev** DB; confirm the tables
  disappear and reappear.

### 7. CREATE `packages/db/src/repositories/mfa.ts`

- **IMPLEMENT** (all take `db: DbClient` first, `userId` second):

| Function | Contract |
| --- | --- |
| `MfaError` | `reason: "already_enrolled" \| "not_enrolled" \| "locked"` — mirrors `SsoIdentityError` |
| `findTotpCredential(db, userId)` | `{ secret: Buffer; confirmedAt: Date \| null; lastStep: number \| null; failedAttempts: number; lockedUntil: Date \| null } \| undefined`. **Decrypts inside** via `decryptField` |
| `upsertUnconfirmedTotp(db, userId, secret: Buffer)` | `INSERT … ON CONFLICT (user_id) DO UPDATE … setWhere: isNull(confirmedAt)`; empty `returning()` ⇒ throw `MfaError("already_enrolled")` |
| `confirmTotp(db, userId, step)` | `UPDATE … SET confirmed_at = now(), last_step = $step, failed_attempts = 0, locked_until = null WHERE user_id = $1 AND confirmed_at IS NULL RETURNING` → boolean |
| `recordTotpUse(db, userId, step)` | `UPDATE … SET last_step = $step, failed_attempts = 0, locked_until = null WHERE user_id = $1 AND (last_step IS NULL OR last_step < $step) RETURNING` → boolean; **`false` means replay** |
| `recordMfaFailure(db, userId, maxAttempts, lockMs)` | blind atomic increment; when the new value ≥ `maxAttempts`, stamp `locked_until` and reset the counter. Returns the new `{failedAttempts, lockedUntil}` |
| `clearMfa(db, userId)` | delete the credential **and** every recovery code, in one transaction |
| `replaceRecoveryCodes(db, userId, hashes)` | delete-then-insert inside one transaction, with a `FOR UPDATE` lock on the `users` row **exactly as `createPasswordReset` does** (`password-resets.ts:57-59`) so two concurrent regenerations cannot interleave into a mixed set |
| `redeemRecoveryCode(db, userId, hash)` | `UPDATE … SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING` → boolean |
| `countUnusedRecoveryCodes(db, userId)` | `count(*)::int` |

- **PATTERN**: `repositories/sessions.ts` + `repositories/sso-identities.ts`. The `setWhere`
  conflict-guard idiom is `sso-identities.ts:99-111` — read its comment; the emptiness of
  `returning()` **is** the signal.
- **GOTCHA**: `count(*)::int`, never a bare `count(*)` (CLAUDE.md — bigint comes back as a string).
- **GOTCHA**: **name the mechanism in every concurrency comment** (CLAUDE.md 15.5). Here they are:
  `recordTotpUse` and `redeemRecoveryCode` are **blind UPDATEs with the whole predicate in the
  `WHERE`** — no read-then-write window, EvalPlanQual re-evaluates for the loser, so exactly one
  wins (SPIKE 3 measured both). `recordMfaFailure` is an **atomic increment expression** (SPIKE 3
  measured two concurrent increments landing as 2). `replaceRecoveryCodes` is the one read-then-write
  decision and it takes the **`FOR UPDATE` lock**. Do **not** write "it's in a transaction".
- **THEN**: export everything from `packages/db/src/index.ts` beside the sso-identities exports.
- **VALIDATE**: `npm run typecheck` → exit 0.

### 8. UPDATE `packages/db/src/repositories/key-rotation.ts`

- **IMPLEMENT**: add `totpCredentials: number` to `RotationCounts` and a fourth `rotateTable(...)`
  pass keyed on `totpCredentials.userId` over
  `(secretCiphertext, secretIv, secretTag)`, filtered with `not(like(totpCredentials.secretCiphertext, prefix))`.
- **PATTERN**: the `gitCommits` pass immediately above it — identical shape.
- **GOTCHA**: all three columns are `notNull`, so this pass needs **no** `isNotNull(...)` guards
  (unlike the `events` pass, whose columns are nullable). The defensive `if (r.ct === null …) continue`
  inside `rotateTable` still covers it.
- **THEN**: update `packages/db/src/repositories/key-rotation.int.test.ts` to seed one encrypted TOTP
  row and assert the new count.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/key-rotation.int.test.ts`.

### 9. UPDATE `packages/db/src/repositories/rls.int.test.ts`

- **IMPLEMENT**: add `"totp_credentials"` and `"mfa_recovery_codes"` to `NO_RLS_TABLES` (:136-155),
  each with a comment in the shape of the `sso_identities` entry: identity table, keyed by `user_id`,
  read before any org context exists, **and that adding it moves no derived count.**
- **GOTCHA**: do **not** touch any expected number. Every count in test 8 derives from
  `STRICT_TABLES` / `BOOTSTRAP_TABLES` / `ROLE_GATED_BOOTSTRAP_TABLES` lengths; `NO_RLS_TABLES` is
  asserted as "has no policy", so the correct edit is list-only.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/rls.int.test.ts`.

### 10a. ADD `findCredentialById` to `packages/db/src/repositories/users.ts`

- **IMPLEMENT**: the id-keyed sibling of `findAdminCredential` (`users.ts:78-90`), with the **same**
  `options?: { lock?: boolean }` → `.for("share")` behaviour and the same return shape
  `{ id, email, passwordHash }`.

```ts
export async function findCredentialById(
  db: DbClient,
  userId: string,
  options?: { lock?: boolean },
): Promise<{ id: string; email: string; passwordHash: string | null } | undefined> {
  const query = db
    .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const [row] = await (options?.lock ? query.for("share") : query);
  return row;
}
```

- **WHY A NEW FUNCTION AND NOT A REUSE**: a challenge carries a **user id**, deliberately — it is the
  only identifier that cannot change between the two steps, whereas an email can be reassigned. Going
  `id → email → findAdminCredential` would re-introduce a lookup by a mutable key at the exact moment
  the code is trying to prove nothing mutated. This is the same reason `findUserEmailById` exists for
  the SSO path (`users.ts:146-161`).
- **GOTCHA**: copy `findAdminCredential`'s doc comment reasoning about the `FOR SHARE` lock — it is
  load-bearing here for the same race, one step further along (GOTCHA-1).
- **THEN**: export it from `packages/db/src/index.ts`.
- **VALIDATE**: `npm run typecheck` → exit 0.

### 10. CREATE `apps/ingest/src/routes/mfa.ts`

- **IMPLEMENT** six endpoints. Export `MFA_MAX_ATTEMPTS = 10` and `MFA_LOCK_MS = 15 * 60_000`.

| Method + path | Auth | Behaviour |
| --- | --- | --- |
| `GET /v1/auth/mfa` | session, `viewer` | `{ enabled: boolean, confirmedAt: string \| null, recoveryCodesRemaining: number }` |
| `POST /v1/auth/mfa/enroll` | session, `viewer` | 409 `already_enrolled` when confirmed; else store an unconfirmed secret and return `{ secret, otpauthUri }` |
| `POST /v1/auth/mfa/enroll/confirm` | session, `viewer` | body `{code}`. Verify against the **unconfirmed** secret → `confirmTotp` + `replaceRecoveryCodes` + `revokeAllSessions(tx, userId, request.sessionId ?? undefined)`, **one transaction**. Returns `{ recoveryCodes: string[] }` — the ONLY time they are readable |
| `POST /v1/auth/mfa/disable` | session, `viewer` | body `{code}` (TOTP **or** recovery code, D-15.8-12) → `clearMfa` + `revokeAllSessions(…, keep)` in one transaction. 204 |
| `POST /v1/auth/mfa/recovery-codes` | session, `viewer` | body `{code}` → `replaceRecoveryCodes`, returns the new set |
| `POST /v1/auth/mfa/verify` | **none** | body `{challenge, code}` → see below. `config: { rateLimit: app.rateLimitLogin }` |

- **The verify handler, in order** (this ordering is a security property, not style):

```ts
const payload = verifyChallenge(request.body.challenge, app.sessionSecret);
if (!payload) return reply.code(401).send({ error: "invalid or expired challenge" });

const outcome = await app.db.transaction(async (tx) => {
  // THE SAME LOCK THE 15.6 LOGIN TAKES — see GOTCHA-1 and task 10a.
  const cred = await findCredentialById(tx, payload.uid, { lock: true });
  if (!cred) return "invalid" as const;
  if (credentialVersion(app.sessionSecret, cred.passwordHash) !== payload.cv) return "stale" as const;

  const totp = await findTotpCredential(tx, payload.uid);
  if (!totp?.confirmedAt) return "invalid" as const;
  if (totp.lockedUntil && totp.lockedUntil > new Date()) return "locked" as const;

  const step = verifyTotp(totp.secret, request.body.code, { nowMs: Date.now() });
  const ok = step !== null
    ? await recordTotpUse(tx, payload.uid, step)          // false ⇒ REPLAY ⇒ treat as failure
    : await redeemRecoveryCode(tx, payload.uid, hashToken(request.body.code));
  if (!ok) {
    await recordMfaFailure(tx, payload.uid, MFA_MAX_ATTEMPTS, MFA_LOCK_MS);
    return "invalid" as const;
  }
  return mintSession(tx, request, app.sessionSecret, { userId: payload.uid, email: cred.email });
});
```

- **GOTCHA**: `"stale"` and `"invalid"` must both answer **401 with the same generic body**. A
  distinguishable "your password changed" response tells an attacker their stolen challenge is stale
  *and* that the account is live — the same reasoning behind the generic login 401
  (`routes/auth.ts:163`). `"locked"` may answer **429** with a `retryAfter`, because a lockout the
  user cannot see is a support ticket, and the attacker learning that lockout works is not a leak.
- **GOTCHA**: the failure increment runs **inside** the transaction, so a rolled-back verify does not
  silently forget the attempt.
- **GOTCHA**: the file header **must contain the string `M15 15.3`** and explain why it needs no
  `withOrg` — `org-scoping.test.ts:133-140` asserts exactly that for every allow-listed file.
- **PATTERN**: routes and gates copied from `routes/auth.ts:474-568`.
- **VALIDATE**: `npm run typecheck` → exit 0.

### 11. UPDATE `apps/ingest/src/routes/auth.ts` — split login, add the shared gate

- **IMPLEMENT**: export a new helper beside `mintSession`:

```ts
/**
 * M15 15.8 — the ONE place a completed authentication becomes either a session or an MFA
 * challenge. Both login paths (password here, SSO in routes/sso.ts) call this, so "enrolled
 * users get a second factor" cannot be true on one path and false on the other (D-15.8-5).
 */
export async function mintSessionOrChallenge(
  app: FastifyInstance,
  db: DbClient,
  request: FastifyRequest,
  { userId, email, passwordHash }: { userId: string; email: string; passwordHash: string | null },
): Promise<
  | { token: string; expiresAt: string }
  | { mfaRequired: true; challenge: string; expiresAt: string }
>;
```

- **IMPLEMENT**: in the login route, keep the existing transaction and the `{ lock: true }` read
  exactly as they are; replace the `return mintSession(...)` at `auth.ts:171` with
  `mintSessionOrChallenge(...)`, passing `cred.passwordHash` through so the `cv` is computed from the
  **locked** read.
- **GOTCHA**: `POST /v1/auth/invites/accept` and `POST /v1/auth/signup` keep calling `mintSession`
  directly — a user who is being created cannot have MFA. `POST /v1/auth/password-reset/confirm`
  mints nothing and is likewise unchanged. **Do not "helpfully" convert them.**
- **GOTCHA**: `mintSession` stays exported and unchanged; `mintSessionOrChallenge` wraps it. Changing
  `mintSession`'s signature would ripple into `sso.ts` and both int suites for no gain.
- **VALIDATE**: `npx vitest run apps/ingest/src/sessions.int.test.ts` (must still pass unchanged for
  non-enrolled users).

### 12. UPDATE `apps/ingest/src/routes/sso.ts`

- **IMPLEMENT**: replace the `mintSession(...)` call at `sso.ts:269-274` with
  `mintSessionOrChallenge(...)`. The outcome type gains no branch — `resolveSsoLogin` is untouched;
  only what happens *after* it admits the login changes.
- **GOTCHA**: an SSO-only user has `passwordHash === null`; `credentialVersion` handles that (SPIKE 4
  asserted it). Pass the value from a `findCredentialById` read, **not** `undefined` — `null` and
  `undefined` must not produce different fingerprints.
- **GOTCHA**: extend the file header's 15.7 paragraph rather than leaving it to under-describe the
  file — the `sso.ts` allow-list entry in `org-scoping.test.ts:69-71` is a claim about this file's
  DB access, and it stays true (MFA tables are identity tables), but the header should say so.
- **VALIDATE**: `npx vitest run apps/ingest/src/sso.int.test.ts` — every existing case must stay
  green, because none of those users is enrolled.

### 13. UPDATE `apps/ingest/src/app.ts`, `schemas.ts`, `org-scoping.test.ts`

- **IMPLEMENT**: `app.register(mfaRoutes)` immediately after `app.register(ssoRoutes)` (:211).
- **IMPLEMENT**: `MfaError` → **409** with its `reason` in `setErrorHandler`, beside the
  `SsoIdentityError` branch at :255.
- **IMPLEMENT**: `mfaVerifyBodySchema` (`{challenge, code}`, both required,
  `additionalProperties: false`, `code` `minLength: 6, maxLength: 64` — a recovery code is longer
  than six digits) and `mfaCodeBodySchema` (`{code}`) in `schemas.ts`.
- **IMPLEMENT**: add to `ALLOWED_WITHOUT_WITHORG` in `routes/org-scoping.test.ts`:
  `"mfa.ts": "reads totp_credentials/mfa_recovery_codes to complete authentication before any org context exists; both are identity tables with no org_id and no policy (D-15.8-13)"`.
- **GOTCHA**: `challenge` must be permissive on length (a base64url payload + MAC is ~200 chars);
  set `maxLength: 1024`.
- **VALIDATE**: `npx vitest run apps/ingest/src/routes/org-scoping.test.ts` → all pass.

### 14. CREATE `apps/dashboard/src/lib/mfa-flow.ts`

- **IMPLEMENT**: `MFA_CHALLENGE_COOKIE = "ai_mfa"`, `MFA_CHALLENGE_PATH = "/api/auth"`,
  `MFA_CHALLENGE_MAX_AGE_SECONDS = 300`, and a `parseMfaFlow` mirroring `parseSsoFlow`.
- **GOTCHA — THE 15.7 BUG, DO NOT REPEAT IT**: `cookies().delete(name)` defaults to `Path=/` and does
  **not** remove a cookie stored at a different path. Every `set` **and** every `delete` must pass
  `{ name, path: MFA_CHALLENGE_PATH }`. `lib/sso-flow.ts:19-33` documents exactly this.
- **GOTCHA**: `httpOnly: true`. The challenge is a credential; the browser must never hold it in JS
  (D8).
- **VALIDATE**: `npm run typecheck:dashboard`.

### 15. UPDATE `apps/dashboard/src/app/api/auth/login/route.ts` + the SSO callback

- **IMPLEMENT**: after a 200, branch on the body. When it carries `mfaRequired`, set the challenge
  cookie and return `{ mfaRequired: true }` **without** setting `SESSION_COOKIE`. In the SSO callback
  (`.../sso/[provider]/callback/route.ts:111-119`), do the same and redirect to
  `/login/mfa?next=<safeNext(flow.next)>`.
- **GOTCHA**: the `sessionConfigError()` guard must still run **before** the challenge branch — a
  deployment with no `SESSION_SECRET` must fail loudly at step one rather than at step two.
- **VALIDATE**: `npx vitest run apps/dashboard/src/app/api/auth/sso/\[provider\]/callback/route.test.ts`.

### 16. CREATE `/api/auth/mfa/verify/route.ts` + `/login/mfa/page.tsx` + `mfa-form.tsx`

- **IMPLEMENT**: the verify route handler reads the challenge cookie (**not** the request body — the
  browser never holds it), POSTs `{challenge, code}` to ingest, and on 200 sets `SESSION_COOKIE` and
  deletes the challenge cookie **with its path**. On 401/429 it forwards the status and leaves the
  cookie alone so the user can retry within the TTL.
- **IMPLEMENT**: `mfa-form.tsx` — a client island with a single `inputMode="numeric"`
  `autoComplete="one-time-code"` field, a "use a recovery code instead" toggle that only relaxes the
  input mask, an error map (`invalid` / `locked` / `expired`), and the `cancelled` teardown idiom.
- **PATTERN**: `components/auth/login-form.tsx`.
- **GOTCHA**: on success, `router.push(safeNext(searchParams.get("next")))` then `router.refresh()` —
  identical to the login form at :94-95.
- **VALIDATE**: `npm run typecheck:dashboard && npm run build:dashboard`.

### 17. UPDATE `apps/dashboard/src/middleware.ts`

- **IMPLEMENT**: `const PUBLIC = ["/login", "/login/mfa"];`
- **GOTCHA**: the match is `pathname === p` (exact equality, :19) — `/login/mfa` is **not** covered by
  the `/login` entry. Without this the second step redirects to `/login?next=/login/mfa` forever.
- **VALIDATE**: manual — see Level 4.

### 18. CREATE the Settings surface

- **IMPLEMENT**: `components/settings/mfa-card.tsx` (client island) + `/api/auth/mfa/route.ts` and
  `/api/auth/mfa/recovery-codes/route.ts` proxies over `proxyJson`. States: **not enrolled** (Enable →
  shows the base32 secret grouped in fours + the `otpauth://` URI + a code field), **enrolled**
  (shows `confirmedAt`, remaining recovery codes, Regenerate, Disable — both asking for a code).
- **IMPLEMENT**: mount it in `settings-view.tsx` beside `<SsoLinks />`.
- **GOTCHA**: recovery codes are returned **once**. The UI must present them as a copy/download block
  with an explicit "these will not be shown again" line, and must not re-fetch them.
- **PATTERN**: `components/settings/sso-links.tsx`.
- **VALIDATE**: `npm run typecheck:dashboard && npm run build:dashboard`.

### 19. CREATE `apps/ingest/src/mfa.int.test.ts` (the slice's proof)

- **IMPLEMENT**: a **two-role** suite copied structurally from `identity.int.test.ts`. See TESTING
  STRATEGY for the required cases.
- **GOTCHA**: test 1 must be the **role-identity assertion** (`current_setting('is_superuser') =
  'off'` AND `rolbypassrls = false`) — CLAUDE.md: without it the whole file is theatre.
- **VALIDATE**: `npx vitest run apps/ingest/src/mfa.int.test.ts` with the test DB up → 0 skipped.

### 20. CREATE `packages/db/src/repositories/mfa.int.test.ts`

- **IMPLEMENT**: the concurrency proofs that **cannot** be observed at the HTTP layer (CLAUDE.md
  15.5: "a concurrency test at the wrong LAYER cannot fail"): two hand-held transactions racing
  `redeemRecoveryCode` on the same code; two racing `recordTotpUse` at the same step; two racing
  `replaceRecoveryCodes`.
- **GOTCHA**: **release every hand-held transaction in a `finally`.** The 15.5 review's five phantom
  10 s timeouts came from one failed assertion skipping the release and holding a pooled connection.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/mfa.int.test.ts`.

### 21. Docs + SUMMARY

- **IMPLEMENT**: an MFA section in `docs/guide/operations.md` — how a user enrols, what happens when
  they lose their device (recovery code; if those are gone, an operator's break-glass is
  `delete from totp_credentials where user_id = …` via `DATABASE_URL`, matching D-M15-7's
  "operator break-glass is direct database access, never an HTTP god-token"), and the explicit
  statement that **there is no admin "reset MFA for user X" endpoint in 15.8**.
- **IMPLEMENT**: flip **15.8** to ✅ in `SUMMARY.md` §0 and §6 with the `DONE <date> (PR #NN)` note,
  in the **same commit** as the execution report (CLAUDE.md; `scripts/check-summary.mjs` enforces it).
- **VALIDATE**: `npm run repo-health` → check 5 passes.

---

## GOTCHAS (the four that decide whether this lands in one pass)

### GOTCHA-1 — Two-step login re-opens the 15.6 credential-change race, and the fix is the `cv` binding

`repositories/users.ts:58-77` and `repositories/sessions.ts:126-131` document, at length, a race that
15.6 **measured**: a login that reads the password hash, awaits, then inserts a `sessions` row can
have its insert land *after* a concurrent password reset's `revokeAllSessions` — leaving a session
minted from the OLD password alive for seven days. 15.6 closed it with a `FOR SHARE` lock held across
the scrypt.

**A challenge breaks that lock's reach**, because the gap is now unbounded: it spans the user reading
a code off their phone. No database lock can be held across it.

So the challenge carries `cv = credentialVersion(sessionSecret, passwordHash)`, and
`POST /v1/auth/mfa/verify` re-reads the credential **under the same `FOR SHARE` lock** and refuses
when `cv` no longer matches. Both orderings are then correct, and this is the mechanism, named:

- **reset first** → the hash changed, so the recomputed `cv` differs and the challenge is dead. The
  attacker's five-minute window is closed by the reset, exactly as the password path's is.
- **verify first** → the `FOR SHARE` lock blocks the reset's `UPDATE users`, so the reset's
  `revokeAllSessions` runs **after** the new session row exists and revokes it — the identical
  argument 15.6 makes.

Neither needs SERIALIZABLE nor a retry loop. The five-minute TTL is a bound, not the mechanism —
**do not write a comment claiming the TTL is what makes this safe.**

### GOTCHA-2 — A challenge that verifies as a session is a total bypass

`verifySession` accepts any well-formed payload whose MAC checks out under `SESSION_SECRET`, and
`resolvePrincipal` then requires a live `sid`. That second check *happens* to save us, but relying on
it means one future change to the challenge payload (adding a `sid`, say, for "convenience") silently
becomes a full authentication bypass. The derived key (`HMAC(sessionSecret, "420ai.mfa.challenge.v1")`)
makes the bypass **unrepresentable** rather than merely unreached, which is the same move
`findUserIdBySsoIdentity`'s signature makes for the email-fallback rule. **Both directions are unit
tested** (SPIKE 4 ran both and both are null).

### GOTCHA-3 — `TRUNCATE … users … CASCADE` already covers the new tables

Both new tables carry an FK to `users`, and every int fixture's `TRUNCATE` list ends with `users …
RESTART IDENTITY CASCADE`, so Postgres truncates them transitively. `sso.int.test.ts:132-133` records
that this was verified live for `sso_identities` (psql emits a NOTICE naming the cascaded table).
**Do not add the new tables to any `TRUNCATE` fixture** — 15.6 and 15.7 both deliberately added
nothing, and a fixture list that grows per-slice will eventually disagree with itself across files.
`ingest_auth_failures` is the counter-example (no FK → truncated explicitly at
`delivery.int.test.ts:60-62`); the new tables are not in that category.

### GOTCHA-4 — `last_step` is `integer`, not `bigint`

SPIKE 3 measured it: node-postgres returns `int8` as a **JavaScript string**, so a `bigint` column
would silently make `lastStep < step` a *string* comparison in any code path that forgot a
`Number(...)` — the exact shape of the repo's documented "numeric is a string" bug. `int4` is
sufficient by a wide margin: the largest representable step is `2147483647`, i.e. epoch second
64 424 509 410, i.e. the year **4011**. Use `integer` and the value arrives as a number.

---

## TESTING STRATEGY

### Unit Tests (no infra — always run)

- `mfa/totp.test.ts` — the RFC 4226 / 6238 / 4648 vectors, padding-path round-trips, the ±1-step
  window (including the **rejection** at +60 s), shape rejection before any HMAC, and unequal-length
  constant-time compare returning `false`.
- `mfa/challenge.test.ts` — domain separation **in both directions**, wrong secret, swapped body under
  a stolen MAC, expiry, `JSON.parse` returning `null`, and the three `credentialVersion` properties.

### Integration Tests (`*.int.test.ts`, two-role)

`apps/ingest/src/mfa.int.test.ts`, every case driven over `app.inject` against an app built on the
**app role**:

1. **Role identity** — `is_superuser = off`, `rolbypassrls = false`. First test in the file.
2. Enrol → confirm → `GET /v1/auth/mfa` reports enabled with 10 recovery codes remaining.
3. Enrolling **again** while confirmed → 409 `already_enrolled`.
4. Confirming with a **wrong** code → 401, and `confirmed_at` stays NULL (assert via the owner
   handle) — an abandoned enrolment never gates anything.
5. **Login for an enrolled user returns `mfaRequired` and mints NO session** — assert
   `select count(*) from sessions where user_id = …` is 0 through the owner handle. A response that
   *says* `mfaRequired` while having minted a session is the whole bug.
6. Challenge + correct code → 200 with a token; the token authenticates `GET /v1/auth/me`.
7. **Replay**: re-using the same code with a fresh challenge → 401 (D-15.8-8).
8. **Recovery code** redeems once; the second attempt → 401; `recoveryCodesRemaining` drops to 9.
9. **Lockout**: `MFA_MAX_ATTEMPTS` wrong codes → 429, and a **correct** code immediately afterwards is
   still refused.
10. **The credential-version binding**: mint a challenge, complete a password reset for that user,
    then present the challenge with a correct code → **401** (GOTCHA-1).
11. **Session invalidation**: two live sessions, enrol-confirm from one → the other 401s, the caller's
    still works. Same for disable.
12. **Disable requires a code** — a session-only disable is 400/401, never 204.
13. **SSO parity (D-15.8-5)**: an enrolled user completing the SSO callback gets `mfaRequired`, not a
    token. Drive it with the same fake provider `sso.int.test.ts` injects.
14. **A non-enrolled user's login is byte-identical to today** — the regression guard.
15. **Cross-user isolation**: user B cannot disable, regenerate for, or read the MFA status of user A
    (the routes take `principal.userId`; there is no id in any path).

`packages/db/src/repositories/mfa.int.test.ts` — the three two-transaction races from task 20.

### Edge Cases

- A user with MFA enrolled and **no password** (SSO-only): `cv` over a `null` hash must be stable.
- A challenge presented after `clearMfa` → 401 `not_enrolled`, never a 500.
- A recovery code presented in place of a TOTP code and vice versa (the route tries TOTP shape first,
  then the hash lookup).
- Clock skew: a code from the previous step is accepted; from two steps ago it is not.
- A 6-digit string that is also a valid recovery-code prefix — cannot collide, because
  `redeemRecoveryCode` looks up the full sha256 of the presented string.
- `ADMIN_TOKEN` callers hitting `GET /v1/auth/mfa`: they resolve to the bootstrap admin user and get
  that user's status (mirrors `GET /v1/auth/sso/identities` at `sso.ts:330-332`).

---

## VALIDATION COMMANDS

Every command runs from the **repo root**.

### Level 1: Syntax, style, types

```bash
npm run typecheck            # root tsc -b — MUST exit 0
npm run typecheck:dashboard  # the dashboard's own lane (root tsc -b will NEVER catch it)
npm run lint                 # ESLint — NOT part of repo-health; CI runs it
npm run format:check         # prettier, incl. this .md — CI checks it, local repo-health does not
```

Pass signal: all four exit 0.

### Level 2: Unit tests

```bash
npx vitest run apps/ingest/src/mfa/
```

Pass signal: every RFC vector and challenge case passes, 0 failures.

### Level 3: Integration (the DB layer must actually run)

```bash
npm run db:up
npm run db:migrate
DATABASE_URL=$DATABASE_URL_TEST npm run db:migrate    # the test DB is migrated SEPARATELY
npm run repo-health -- --require-db
```

Pass signal: `repo-health` PASSES **and reports 0 skipped integration tests**. A plain green
`repo-health` is not evidence — `skipped ≠ passed`.

### Level 4: Manual validation

```bash
# terminal 1
npm run ingest:dev
# terminal 2 (env is read from the DASHBOARD cwd, not the repo root)
ADMIN_TOKEN=… INGEST_URL=http://localhost:4000 SESSION_SECRET=… npm run dashboard:dev
```

1. Sign in with a password → Settings → Enable two-factor. Enter the displayed secret into a real
   authenticator app (manual entry), confirm with the live code, and **save the ten recovery codes**.
2. Sign out. Sign in again → the password form now hands off to `/login/mfa`. **Confirm the URL does
   not bounce back to `/login`** (that is the middleware `PUBLIC` entry, task 17).
3. Enter the live code → land on `/monitor`.
4. Sign out, sign in, and use a **recovery code** instead. Confirm Settings now shows 9 remaining and
   that the same code fails on a second attempt.
5. Wrong code ten times → confirm the 429 and that a correct code is refused until the lock expires.
6. With a second browser signed in, disable MFA in the first → the second session is signed out.
7. If a provider is configured: enrol, then sign in through Google/GitHub → confirm it also stops at
   `/login/mfa` (D-15.8-5).
8. Evidence for D-M15-13: capture screenshots under `.agents/qa/m15-signoff/mfa/` and tick the
   checklist box.

### Level 5: Additional

```bash
npm run db:rollback && npm run db:migrate   # the 0020 down/up cycle, on the dev DB
grep -rn "otplib\|speakeasy\|qrcode" package.json apps/*/package.json packages/*/package.json
```

Pass signal: the rollback cycle is clean; the grep returns **nothing** (D-15.8-1).

---

## ACCEPTANCE CRITERIA

- [ ] A user can enrol a TOTP credential, confirm it, and receive ten single-use recovery codes
- [ ] An enrolled user's **password** login returns a challenge and mints **no** session row
- [ ] An enrolled user's **SSO** login does the same (D-15.8-5)
- [ ] A correct code exchanges the challenge for an ordinary 15.6 session that `resolvePrincipal`,
      revocation and expiry all treat identically
- [ ] A code is not accepted twice (RFC 6238 §5.2), and a recovery code is not redeemed twice
- [ ] Ten consecutive failures lock the credential for 15 minutes
- [ ] A challenge is void after a password change (GOTCHA-1), and answers a **generic** 401
- [ ] Enrol-confirm and disable revoke every other session and spare the caller's
- [ ] Disabling MFA requires a live code, not just a session
- [ ] The TOTP secret is encrypted at rest **and** covered by `reencryptAll`
- [ ] Both new tables carry no `org_id` and no policy, and are listed in `NO_RLS_TABLES`
- [ ] Zero new npm dependencies
- [ ] `npm run repo-health -- --require-db` passes with **0 skipped**
- [ ] `npm run lint`, `npm run format:check`, `npm run build:dashboard` all pass
- [ ] `SUMMARY.md` marks 15.8 ✅ in §0 and §6, in the same commit as the execution report

## COMPLETION CHECKLIST

- [ ] All 21 tasks completed in order, each validated immediately
- [ ] Every concurrency comment **names its mechanism** (lock / unique index / blind-UPDATE
      predicate) — no "it's in a transaction"
- [ ] No comment claims a guarantee the code does not make (the 15.5/15.6/15.7 lesson)
- [ ] Manual Level-4 walkthrough done, with evidence under `.agents/qa/m15-signoff/mfa/`
- [ ] `/lril:code-review` run (it is what catches the long-lived-resource and false-comment classes)
- [ ] Execution report written; `SUMMARY.md` updated in the same commit
- [ ] Deferred scope stated explicitly in the report: **QR rendering (D-15.8-14)** and **org-level MFA
      enforcement (D-15.8-2)**, both → 15.10

---

## NOTES

### Spikes actually RUN during planning (this is the evidence behind the confidence score)

**SPIKE 1 — the TOTP core against the RFCs' own vectors.** A throwaway `spike-totp.mjs` implemented
base32/HOTP/TOTP and checked them. **34/34 assertions passed**: RFC 4226 Appendix D counters 0–9
(`755224 … 520489`), all six RFC 6238 SHA-1 rows (`t=59 → 94287082` … `t=20000000000 → 65353130`),
`base32("12345678901234567890") = GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`, 200 random 20-byte round-trips,
round-trips at ten non-multiple-of-5 lengths, ±1-step acceptance with rejection at +60 s,
length-guarded `timingSafeEqual`, and an `otpauth://` label with no un-encoded `@`. The algorithm in
this plan is therefore **transcribed from working code**, not recalled.

**SPIKE 2 — base32 padding.** Folded into SPIKE 1 (the ten length cases). This mattered because a
20-byte secret is not a multiple of 5 bits × 8 and the tail-padding branch is the classic bug.

**SPIKE 3 — the proposed tables against the REAL `420ai_test`, as BOTH roles.** A throwaway
`spike-db.mjs` created the exact DDL, then acted as `420ai_app`. **All 14 assertions passed**:
`current_user = 420ai_app`, `is_superuser = off`, `rolbypassrls = false`; **implicit grants
`DELETE,INSERT,SELECT,UPDATE` on both tables with no explicit `GRANT`** (0015's `ALTER DEFAULT
PRIVILEGES` covers them — the same fact 0018/0019 rely on, re-verified for these shapes);
`relrowsecurity = false`, `relforcerowsecurity = false`, **0 policies**; the app role inserted and
read with no explicit grant; **`int8` came back as the JS string `'58402262'`** (→ GOTCHA-4, and the
reason `last_step` is `integer`); two concurrent blind increments landed as **2**; two concurrent
`UPDATE … WHERE used_at IS NULL RETURNING` on one recovery code produced **exactly one winner** and a
replay redeemed **0**; a duplicate `(user_id, code_hash)` was rejected with **23505**. Every object
was dropped afterwards.

**SPIKE 4 — the challenge primitive against the REAL `session.ts`.** A throwaway TS spike run under
`tsx` imported the actual `signSession`/`verifySession`. **10/10 passed**, including both directions
of the domain separation (`verifySession(challenge) === null` **and** `verifyChallenge(session) ===
null`), wrong secret, a body swapped under a stolen MAC, expiry, and the three `credentialVersion`
properties (changes on a new hash, stable for the same hash, defined for `null`).

**SPIKE 5 — field encryption.** Same run: `activeKeyId()` is `legacy` in this deployment,
`ARCHIVE_ENCRYPTION_KEY` is set, a 20-byte secret round-tripped through
`encryptField`/`decryptField`, the IV and ciphertext differed across two calls of the same plaintext,
and a swapped GCM tag **threw**. So encrypting the TOTP secret works today with no configuration
change.

**SPIKE 6 — `npm run db:generate`.** The schema from task 4 was appended, `db:generate` was run with
**stdin closed** (it completed non-interactively and never prompted), and the emitted SQL is pasted
verbatim into task 5. The schema edit, the generated `.sql`, the `0020` snapshot and the `_journal`
entry were then all reverted; `git status` was confirmed clean.

All four throwaway files were deleted after their output was folded back in.

### Things deliberately NOT done here

- **No WebAuthn / passkeys.** D-M15-5 says TOTP; passkeys are a separate credential type with their
  own storage and a browser API, and they belong in the same bucket as enterprise SAML (M16).
- **No admin "reset MFA for user X" endpoint.** It is a privilege-escalation surface (an `admin`
  could strip an `owner`'s second factor), and 15.5's ladder lesson — *a route mutating another
  principal's standing needs a ceiling AND a floor* — says that endpoint needs the full rank
  comparison the member routes learned the hard way. Break-glass is direct DB access, consistent with
  D-M15-7. Revisit in 15.10 alongside the audit table, where the action can be recorded.
- **No `mfa_challenges` table** (D-15.8-3) and **no QR** (D-15.8-14).

### Sequencing note

15.8 is the last identity slice. 15.9 retires `ADMIN_TOKEN` and adds API keys — **API keys must never
be MFA-gated** (they are a second factor's peer, not its subject), and 15.9's plan should say so
explicitly, because "we added MFA, so gate everything" is the obvious wrong move at that point.
