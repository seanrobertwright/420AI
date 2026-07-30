# Code review — M15 slice 15.8 (MFA: TOTP enrolment + recovery codes)

Reviewed at commit `b0bb9ee`, against the acceptance criteria in
[`.agents/plans/m15-slice8-mfa.md`](../plans/m15-slice8-mfa.md).

**Stats:**

- Files Modified: 21
- Files Added: 25
- Files Deleted: 0
- New lines: 8889
- Deleted lines: 37

Every finding below was **reproduced or verified against the running code**, not inferred. Finding 1
was proved with a throwaway two-role integration test driving real HTTP requests; that test was
deleted after it reported, and its assertions are reproduced verbatim in the finding.

---

## Findings

```
severity: critical
file: apps/ingest/src/routes/mfa.ts
line: 195
issue: Enrolment requires only a session, so a stolen session cookie converts into permanent, unrecoverable account takeover — a password reset does NOT recover the account.
```

**detail:**

`POST /v1/auth/mfa/enroll` and `POST /v1/auth/mfa/enroll/confirm` are gated by `resolvePrincipal` +
`authorized(principal, "viewer")` and nothing else. They demand no password and no existing factor.
This is asymmetric with every sibling credential mutation: `POST /v1/auth/password` demands the
current password (`routes/auth.ts:434`), and D-15.8-12 makes `disable` and `recovery-codes` demand a
live code — on the stated reasoning that *"an attacker holding a stolen session cookie must not be
able to switch the second factor off."* The same argument applies to switching it **on**, and it was
not made.

The consequence is worse than symmetry suggests, because enrol-confirm also calls
`revokeAllSessions(tx, userId, keep)` (D-15.8-11). The attacker's enrolment therefore signs the
legitimate owner out, and the owner cannot get back in.

I drove the full chain over real HTTP against the app role. **Every assertion below passed:**

```ts
// The attacker has a stolen session cookie. No password, no second factor.
const enr = await app.inject({ method: "POST", url: "/v1/auth/mfa/enroll",
                               headers: bearer(attackerSession) });
expect(enr.statusCode, "enrol requires nothing but a session").toBe(200);        // ✓ 200

await app.inject({ method: "POST", url: "/v1/auth/mfa/enroll/confirm",
                   headers: js(attackerSession), payload: { code: totpCode(secret, Date.now()) } });

// 1. The victim is signed out BY the attacker's enrolment.
expect((await app.inject({ url: "/v1/auth/me", headers: bearer(victimSession) })).statusCode).toBe(401);   // ✓

// 2. The victim's password still works, but now yields only a challenge they cannot answer.
expect((await login()).mfaRequired).toBe(true);                                  // ✓

// 3. A FULL PASSWORD RESET — i.e. proven control of the mailbox — DOES NOT RECOVER THE ACCOUNT.
//    (reset requested, token consumed, new password set, 204)
expect(body.mfaRequired, "even after a full password reset the victim gets only a challenge")
  .toBe(true);                                                                   // ✓
expect(body.token).toBeUndefined();                                              // ✓

// 4. …and the attacker retains access with the factor they planted.
expect(inAgain.statusCode).toBe(200);                                            // ✓
```

Point 3 is the part that makes this critical rather than merely untidy. Confirmed by grep: nothing
on the reset path calls `clearMfa`, so `POST /v1/auth/password-reset/confirm` changes the hash and
revokes sessions while leaving the attacker's `totp_credentials` row armed. **The documented recovery
story for a compromised account no longer works**, and the only remaining route back in is the
operator break-glass `DELETE FROM totp_credentials` in `docs/guide/operations.md`. For a
self-hosted single-admin deployment, the person locked out is often the only operator.

The obvious counter — *"a stolen session is already a full compromise"* — is true but insufficient.
A stolen session expires in seven days and is revocable from `/v1/auth/sessions/revoke-all`; this
converts it into **indefinite persistence plus denial of access to the rightful owner**, which is a
strict escalation and precisely the class 15.6's revocation work exists to bound.

**suggestion:**

Require re-authentication at enrolment, exactly as `POST /v1/auth/password` does. Smallest correct
change: accept `currentPassword` in `mfaCodeBodySchema`'s sibling for the enrol route and verify it
with `verifyPassword` before `upsertUnconfirmedTotp` — and for an SSO-only user (`passwordHash IS
NULL`, who genuinely has no password to present) gate on a **recent** session instead, or require the
SSO re-link. Note that "make password reset clear MFA" is **not** the fix and must not be adopted:
that would let anyone with mailbox access strip the second factor, defeating the entire slice.

This is a scope question as well as a bug — D-15.8-12 was written about `disable`/`recovery-codes`
only — so it is the maintainer's call whether it lands here or as a 15.9 follow-up. It should not
ship undocumented either way.

---

```
severity: medium
file: packages/db/src/repositories/mfa.ts
line: 47
issue: Two of MfaError's three `reason` values are never constructed, and app.ts's 429 branch for one of them is unreachable code carrying a comment that describes behaviour the system cannot produce.
```

**detail:**

`MfaError`'s reason union is `"already_enrolled" | "not_enrolled" | "locked"`. Verified by grep —
there is exactly one construction site in the entire repo:

```
packages/db/src/repositories/mfa.ts:165:  throw new MfaError("two-factor authentication is already enabled", "already_enrolled");
```

The routes never throw `MfaError`; they reply directly through `replyForFactor`, which is the right
design (it can attach `Retry-After`, which an error handler cannot). So `"not_enrolled"` and
`"locked"` are dead, and `apps/ingest/src/app.ts:268-272` — which maps `locked` to 429 — can never
execute. Its comment reads *"`locked` is the one reason that is NOT a conflict: it is a rate limit,
so it is a 429"*, describing a code path that does not exist.

That is the specific failure mode CLAUDE.md's 15.5 lesson names: the comment is the defect, because
the next reader trusts it instead of re-deriving it. A future author reading it will reasonably
assume throwing `MfaError("…", "locked")` from a repository yields a 429 with the documented shape —
it would, but with no `Retry-After` and a different body from the one `replyForFactor` produces, so
the two lockout responses would silently disagree.

**suggestion:**

Narrow the union to `"already_enrolled"` and delete the 429 arm, or keep both and add the one
construction site that justifies them. Narrowing is preferable: the routes hold the `lockedUntil`
value and are the only place that can answer correctly. If narrowed, simplify the `app.ts` branch to
a plain 409 and drop the sentence about 429.

---

```
severity: medium
file: apps/ingest/src/routes/mfa.ts
line: 379
issue: An EXPIRED challenge is reported to the user as "That code is not valid", so a user whose five-minute window lapsed retypes correct codes indefinitely.
```

**detail:**

The verify route answers an unusable challenge with:

```ts
return reply.code(401).send({ error: "invalid or expired challenge" });   // mfa.ts:379
```

No `reason` field. The dashboard's error map keys on `reason`
(`mfa-form.tsx:62`) and falls back to `res.status === 401 → MFA_ERRORS.invalid`, which reads *"That
code is not valid. Check your authenticator and try again."* The map's `expired` entry — *"That
sign-in attempt expired. Please sign in again."* — is only reachable from the dashboard proxy's own
missing-cookie branch (`verify/route.ts:44`), i.e. only when the browser dropped the cookie first.

The plan's task 16 specified an error map with `invalid` / `locked` / `expired`, so the `expired`
case was intended to be reachable; it is not, for the server-side expiry that is the common cause.

This is not a security trade-off being made deliberately. The plan's generic-401 rule (GOTCHA-1) is
about the **credential-version mismatch** — where distinguishing the response would tell an attacker
their stolen challenge is stale *and* the account is live — and that reasoning does not extend here:
a caller who presents a well-formed challenge already holds it, so telling them it expired discloses
nothing they do not have.

**suggestion:**

Send `{ error: "invalid or expired challenge", reason: "expired" }` at `mfa.ts:379` only. Leave the
`"stale"` (cv-mismatch) and `"invalid"` paths generic and reason-less, which is what GOTCHA-1
actually requires — and add an int-test assertion that the cv-mismatch 401 still carries **no**
`reason`, so this change cannot later be over-applied to the branch that must stay silent.

---

```
severity: low
file: apps/ingest/src/routes/mfa.ts
line: 82
issue: `consumeSecondFactor` is typed `DbClient` while its own doc comment says it MUST be called with a `Tx`.
```

**detail:**

The doc comment states, correctly and at length, *"MUST be called with a `Tx`. Everything it does is
a write … the FAILURE INCREMENT runs inside the caller's transaction on purpose: a route that rolled
back after a failed attempt would silently forget it, which is a throttle with a free retry built
in."* The signature then accepts `DbClient`, which is `Db | Tx` — so `consumeSecondFactor(app.db, …)`
compiles, and the throttle guarantee the comment describes quietly does not hold.

All three current call sites do pass a `Tx`, so there is no live bug. This is the comment-versus-
signature gap the repo has been bitten by before (`findUserIdBySsoIdentity` takes no email precisely
so the rule cannot be broken), applied one notch weaker here.

**suggestion:**

Change the parameter to `tx: Tx` (`import type { Tx } from "@420ai/db"`). It costs nothing, all
callers already comply, and it makes the stated requirement unrepresentable rather than merely
documented.

---

## Verified correct (checked, and deliberately not raised)

Recorded so a later reader knows these were examined rather than skipped:

- **The `cv` binding.** Both orderings behave as GOTCHA-1 claims; pinned by `mfa.int.test.ts`'s
  password-reset case, which asserts the MAC is still valid and the `exp` still future, so the 401
  can only be the comparison.
- **Domain separation.** `verifySession(challenge)` and `verifyChallenge(session)` both null against
  the real `session.ts`, including with deliberately overlapping payload shapes.
- **The SSO path's unlocked `findCredentialById`** (`sso.ts`, no `{ lock: true }`). A password change
  racing the SSO callback produces a stale `cv` and the challenge is refused — fail-safe, and the
  15.7 path never held a lock. Not a regression.
- **Concurrency mechanisms.** All three (`recordTotpUse`, `redeemRecoveryCode`, `replaceRecoveryCodes`)
  were confirmed to FAIL their tests with the mechanism removed, and the atomic-increment test was
  rewritten after it passed against a broken read-then-write implementation.
- **`last_step` as `integer`.** Live value observed as a JS number (`59513883`), not a string.
- **Rate limit vs lockout layering.** Both fire; the per-IP limit first. Documented rather than
  changed.
- **D8 token containment.** 0 occurrences of `ADMIN_TOKEN` and 0 of the challenge cookie value in
  served `/settings` HTML.

---

## Summary

**4 findings: 1 critical, 2 medium, 1 low.**

The critical one is a genuine security defect with a reproduced end-to-end chain, and it is the only
finding that blocks. The remaining three are correctness-of-documentation and user-facing-diagnostics
issues, each with a small, contained fix.

---

## Resolution (triaged 2026-07-30)

The maintainer selected **fix all 4** at the triage gate, and chose the **recent-session** branch for
SSO-only accounts on finding 1.

| #   | Severity | Issue                                              | File                                     | Disposition | What was done                                                                                                                                                                                                       | Status |
| --- | -------- | -------------------------------------------------- | ---------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | Critical | Enrolment needs only a session → permanent takeover | `apps/ingest/src/routes/mfa.ts:198`       | Fix         | **D-15.8-16**: `POST /v1/auth/mfa/enroll` now re-authenticates — the current password for a password-bearing account, or a session under `MFA_REAUTH_MAX_SESSION_AGE_MS` (15 min) for an SSO-only one. New `findLiveSessionCreatedAt` repository fn; `GET /v1/auth/mfa` reports `passwordRequiredToEnrol` so the card knows which branch applies; Settings gains a password step. 5 new int tests, including the full hijack chain as a permanent regression test. | Fixed  |
| 2   | Medium   | `MfaError`'s `not_enrolled`/`locked` never constructed | `packages/db/src/repositories/mfa.ts:47` | Fix         | Union narrowed to `"already_enrolled"`; `app.ts`'s unreachable 429 arm deleted and its comment replaced with one that names where lockouts are actually answered (`replyForFactor`, which holds `lockedUntil`).       | Fixed  |
| 3   | Medium   | Expired challenge reported as "code is not valid"   | `apps/ingest/src/routes/mfa.ts:379`       | Fix         | The challenge-verification 401 now carries `reason: "expired"`. The cv-mismatch 401 stays reason-less, and an int test pins that asymmetry so the change cannot later be over-applied to the branch that must stay silent. | Fixed  |
| 4   | Low      | `consumeSecondFactor` typed `DbClient`, doc says `Tx` | `apps/ingest/src/routes/mfa.ts:82`        | Fix         | Parameter retyped to `Tx`. All three call sites already complied, so the requirement is now unrepresentable rather than merely documented.                                                                            | Fixed  |

**Verification.** The two enrolment-gate tests were confirmed to FAIL with the gate disabled
(`expected 200 to be 401` in both), per CLAUDE.md's rule that a negative test must be shown to fail
without its mechanism. `apps/ingest/src/mfa.int.test.ts` is now **29 cases**, up from 23.
