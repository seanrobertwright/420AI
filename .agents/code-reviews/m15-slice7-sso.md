# Code Review — M15 Slice 15.7 (SSO: Google + GitHub)

Reviewed at commit `3609464`, against the acceptance criteria in
[`.agents/plans/m15-slice7-sso.md`](../plans/m15-slice7-sso.md).

**Stats:**

- Files Modified: 17
- Files Added: 24
- Files Deleted: 0
- New lines: 7980
- Deleted lines: 29

Every finding below was **verified by execution**, not by inspection — the method is recorded with
each one. Two of them are the same shape CLAUDE.md's 15.5 lesson names explicitly: **a comment
asserting a guarantee the code does not provide.** In both cases the comment is the more dangerous
half, because the next reader trusts it instead of re-deriving it.

---

## 1. HIGH — the SSO flow cookie is never actually deleted (wrong `Path`)

```
severity: high
file: apps/dashboard/src/app/api/auth/sso/[provider]/callback/route.ts
line: 33
issue: `jar.delete(SSO_FLOW_COOKIE)` emits `Path=/`, but the cookie was SET with `Path=/api/auth/sso`, so it is never removed.
```

**detail.** `start/route.ts:70` sets the flow cookie with `path: "/api/auth/sso"`. Browsers key
cookies by `(name, domain, path)`, so an expiry issued at `Path=/` does not match and does not clear
it. The cookie holds the **PKCE `codeVerifier` and the `state`**, and it survives every refusal for
its full `Max-Age=600`.

Verified live against the running dev server — a callback with a mismatched `state`:

```
$ curl -D - -H 'Cookie: ai_sso={"state":"expected","mode":"login"}' \
    '.../api/auth/sso/google/callback?code=abc&state=ATTACKER'
HTTP/1.1 307 Temporary Redirect
location: http://localhost:3002/login?error=sso_state
set-cookie: ai_sso=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT     ← Path=/ , not /api/auth/sso
```

The file's own header comment states *"the flow cookie is deleted on EVERY path, success or failure
— a verifier that survives a failed attempt is a replay window."* That is exactly the property that
does not hold, which makes the comment the load-bearing defect: it documents an intended invariant
as an achieved one.

Not remotely exploitable on its own (an attacker needs the victim's browser, and the authorization
code is single-use at the provider), but it defeats the stated one-code-one-attempt property and
leaves a live `state`/verifier pair for ten minutes.

**suggestion.** Delete with the same path, using Next's object form:

```ts
jar.delete({ name: SSO_FLOW_COOKIE, path: "/api/auth/sso" });
```

---

## 2. MEDIUM — `linkSsoIdentity`'s guard is a read-then-write with no lock; the race reports a FALSE SUCCESS

```
severity: medium
file: packages/db/src/repositories/sso-identities.ts
line: 82
issue: The `identity_taken` guard SELECTs then upserts. Two concurrent linkers both pass the read; the loser's ON CONFLICT DO UPDATE silently updates the WINNER's row and returns success.
```

**detail.** The doc comment claims *"Catching it here turns the race into a clean 409 at every call
site."* It does not — `SELECT` takes no locks, and the `onConflictDoUpdate` sets only `email`, with
no predicate on `user_id`. So the losing transaction updates a row belonging to somebody else and
`.returning()` hands back that row's id as if the link succeeded. `POST /v1/auth/sso/:provider/link`
answers **204** to a user who is not linked.

Verified deterministically with two hand-held transactions (throwaway probe, since deleted): T1
inserts the identity for user A uncommitted; T2 calls the real `linkSsoIdentity` for user B; T1
commits.

```
>>> T2 outcome: SUCCEEDED          (expected THREW:identity_taken)
>>> row belongs to: userA
```

**This is not a takeover** — the row keeps user A's `user_id`, so nobody gains access to anything.
It is a correctness/UX defect plus a false comment. Worth fixing precisely because this repository
has already paid for this lesson twice (CLAUDE.md 15.5: "name the mechanism — a lock, a unique
index, or an isolation level").

**suggestion.** Make the upsert itself the guard, so the unique index is the mechanism and no lock
is needed. Add a `setWhere` so the update only fires for the SAME owner, then treat an empty
`returning()` as the conflict:

```ts
const [row] = await db
  .insert(ssoIdentities)
  .values({ userId, provider: identity.provider, subject: identity.subject, email })
  .onConflictDoUpdate({
    target: [ssoIdentities.provider, ssoIdentities.subject],
    set: { email },
    setWhere: eq(ssoIdentities.userId, userId), // same owner → refresh; different owner → no row
  })
  .returning({ id: ssoIdentities.id });
if (!row) {
  throw new SsoIdentityError("identity already linked to another account", "identity_taken");
}
return row;
```

The pre-read may stay as a cheap fast path, but the comment must name the **index** as the
mechanism rather than the read.

---

## 3. MEDIUM — two callback error codes render no message at all

```
severity: medium
file: apps/dashboard/src/components/auth/login-form.tsx
line: 17
issue: The callback can redirect with `error=config` and `error=failed`; neither has an entry in SSO_ERRORS, so the login page shows a bare form with no explanation.
```

**detail.** Cross-checked by grep:

| emitted by `callback/route.ts`            | copy in `SSO_ERRORS`? |
| ----------------------------------------- | --------------------- |
| `sso_denied`, `sso_state`, `unreachable`   | ✅                    |
| ingest reasons (`link_required`, …)        | ✅                    |
| `config` (:77)                             | ❌ **missing**        |
| `failed` (:102, the `reason ?? "failed"` fallback) | ❌ **missing** |

`config` is the `SESSION_SECRET`-missing path — the exact misconfiguration the D.3 loud-failure
guard exists to surface, and the user sees nothing. `failed` is the catch-all for any ingest refusal
without a typed `reason`. Both silently fall through to `?? null`.

**suggestion.** Add both, and make the lookup fall back to a generic message so a future reason code
can never render blank:

```ts
config: "Sign-in is misconfigured on the server. Contact your administrator.",
failed: "Sign-in failed. Please try again.",
// …and at the call site:
const code = searchParams.get("error");
setError(code ? (SSO_ERRORS[code] ?? "Sign-in failed. Please try again.") : null);
```

---

## 4. LOW — the callback unit test cannot catch finding 1

```
severity: low
file: apps/dashboard/src/app/api/auth/sso/[provider]/callback/route.test.ts
line: 27
issue: The `next/headers` mock records `cookie.delete:<name>` only, discarding the options argument, so the test asserts the CALL and not the EFFECT.
```

**detail.** `expect(calls.order).toContain("cookie.delete:ai_sso")` passes identically whether the
delete carries the right path, the wrong path, or none. This is why finding 1 shipped with a green
suite — the same "asserts the call, not the effect" shape the plan's own mutation check was designed
to expose elsewhere.

**suggestion.** Record the argument and assert on it, so the fix for finding 1 is pinned:

```ts
delete: (arg: string | { name: string; path?: string }) => {
  calls.cookieDeleted = typeof arg === "string" ? { name: arg } : arg;
},
// …
expect(calls.cookieDeleted).toEqual({ name: "ai_sso", path: "/api/auth/sso" });
```

---

## 5. LOW — a login can NULL a previously-recorded identity email

```
severity: low
file: apps/ingest/src/routes/sso.ts
line: 88
issue: Branch 1's refresh passes `email: profile.email` unconditionally, so a provider that stops asserting an address overwrites the stored one with NULL.
```

**detail.** Reachable on GitHub, where `/user/emails` returns `[]` if the `user:email` grant is later
withdrawn — `toGithubProfile` then yields `email: null`. The column is display/audit only, so nothing
breaks, but the Settings row degrades from the address to "connected" and the audit trail loses the
value it existed to keep.

**suggestion.** Refresh only when the provider actually asserts one:

```ts
await linkSsoIdentity(app.db, linkedUserId, {
  provider,
  subject: profile.subject,
  ...(profile.email ? { email: profile.email } : {}),
});
```

(Requires `linkSsoIdentity` to leave `email` untouched when the key is absent rather than coercing to
`null` — currently `identity.email ? … : null` collapses both cases.)

---

## 6. LOW — one user may accumulate several identities for the SAME provider

```
severity: low
file: packages/db/src/schema.ts
line: 361
issue: The unique index is `(provider, subject)`, so nothing stops one user linking two different Google accounts; the Settings UI shows only the first and Disconnect removes both at once.
```

**detail.** `sso-links.tsx:104` does `linked?.find((l) => l.provider === id)`, so the second identity
is invisible, while `unlinkSsoIdentity` deletes by `(userId, provider)` and removes both. The
last-credential guard still behaves correctly (it counts rows with a *different* provider). No
security consequence — every link is deliberate and authenticated — but the UI and the data model
disagree about cardinality.

**suggestion.** Decide it explicitly rather than leaving it emergent. Either add a
`uniqueIndex(user_id, provider)` (one account per provider, the common product choice, and a
migration), or keep it and render **all** rows in the Settings list with per-identity disconnect.
Given 15.7 is already merged-scope, recommend documenting the current behaviour and deferring the
index to 15.10, which touches the team surfaces anyway.

---

## 7. LOW — concurrent first-sight signups for the same address 500 instead of 409

```
severity: low
file: apps/ingest/src/routes/sso.ts
line: 152
issue: Branch 5 checks `findUserIdByEmail` then inserts; two simultaneous callbacks for the same new address both pass and one hits the `users_email_unique` violation as an opaque 500.
```

**detail.** Identical in shape to the pre-existing `POST /v1/auth/signup` path (`routes/auth.ts:292`),
so this is consistent with precedent rather than a regression, and the window is narrow. Flagged for
completeness; fixing it repo-wide is a better slice than fixing it here alone.

**suggestion.** Defer, or handle the unique violation and map it to the same 409 `link_required` the
sequential path returns.

---

## What the review checked and found correct

- **Every plan acceptance criterion is met.** The anti-takeover refusal is total (no token, no row —
  asserted directly), the mutation check produced the predicted split, `redirect_uri` is derived
  server-side and provably so, and `sso_identities` appears in `NO_RLS_TABLES` and nowhere else.
- **No secrets reach the browser** — verified live: served `/login` source contains 0 occurrences of
  either client secret, the literal `CLIENT_SECRET`, or `ADMIN_TOKEN`. Neither authorize URL carries
  a secret.
- **The `proxyJson`-vs-plain-`fetch` split is correct** in both handlers, and pinned by a test — the
  thing the plan flagged as easiest to get subtly wrong.
- **`sameSite: "lax"`** on both cookies (a `strict` flow cookie would break every real login).
- **Long-lived resources**: both client islands arm their `cancelled` flag before the first `await`;
  no timers, streams or listeners were added.
- **The unlink lock is real** — the repository race test genuinely discriminates (it asserts the
  loser is still unsettled after a wait) and releases its connection in a `finally`.
- **Silent-library discipline** holds: no `console.*` outside `server.ts` and the two Route Handlers.

---

## Recommendation

Findings **1** and **3** are user-visible and should land before merge. Finding **2** is a real
correctness defect whose fix is small and whose comment is actively misleading. Findings **4**–**7**
are judgement calls; **4** is worth taking alongside **1** since it is what lets **1** regress.

---

## Resolution (triaged by the maintainer, 2026-07-29)

Selection at the triage gate: **fix 1, 2, 3, 4 · defer 5, 6 · won't-fix 7.**

| #   | Severity | Issue                                     | File                                                  | Disposition | What was done                                                                                                              | Status   |
| --- | -------- | ----------------------------------------- | ----------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | HIGH     | Flow cookie never deleted (`Path` mismatch) | `apps/dashboard/src/app/api/auth/sso/[provider]/callback/route.ts:33` | Fix         | `delete({name, path: SSO_FLOW_PATH})`; path hoisted to a shared constant in `lib/sso-flow.ts` so the two call sites cannot drift | Fixed    |
| 2   | MEDIUM   | Link race reports a false success          | `packages/db/src/repositories/sso-identities.ts:82`   | Fix         | Read-then-upsert replaced by `setWhere: eq(userId)`; empty `returning()` is the conflict signal. Unique index is now the mechanism | Fixed    |
| 3   | MEDIUM   | `config`/`failed` render no message        | `apps/dashboard/src/components/auth/login-form.tsx:17` | Fix         | Both codes given copy, plus `ssoErrorMessage()` fallback so an unknown code can never render blank                          | Fixed    |
| 4   | LOW      | Callback test can't catch #1               | `apps/dashboard/.../callback/route.test.ts:27`        | Fix         | Mock records the delete ARGUMENT; asserts `{name:"ai_sso", path:"/api/auth/sso"}`                                          | Fixed    |
| 5   | LOW      | Login can NULL a stored identity email     | `apps/ingest/src/routes/sso.ts:88`                    | Defer       | Display/audit only; a proper fix changes `linkSsoIdentity`'s signature. Deferred to **15.10**                               | Deferred |
| 6   | LOW      | Several identities per provider per user   | `packages/db/src/schema.ts:361`                       | Defer       | Needs a migration or a UI change; no security impact. Deferred to **15.10** (team surfaces)                                 | Deferred |
| 7   | LOW      | Concurrent signup 500s instead of 409      | `apps/ingest/src/routes/sso.ts:152`                   | Won't fix   | Identical to the existing `/v1/auth/signup` precedent; fixing one path alone would be inconsistent                          | Not done |

### Verification that the fixes landed

- **1** — re-ran the live probe that found it. Before: `set-cookie: ai_sso=; Path=/`. After:
  `set-cookie: ai_sso=; Path=/api/auth/sso; Expires=Thu, 01 Jan 1970`.
- **2** — the throwaway probe that proved the bug (`T2 outcome: SUCCEEDED`, row owned by userA) is
  now a **permanent** regression test in `sso-identities.int.test.ts` ("refuses a CONCURRENT link of
  the same identity to a different user"), asserting `THREW:identity_taken` and that the row still
  belongs to the winner. It fails against the pre-fix implementation by construction.
- **3** — grep parity between the callback's `refuse(...)` codes and `SSO_ERRORS` now complete.
- **4** — the assertion changed from "the call happened" to "the call carried the path", which is
  what makes it capable of catching a regression of 1.

Findings 5, 6 and 7 are **triaged, not dropped** — 5 and 6 carry a destination (15.10), and 7 is a
deliberate consistency decision. They are not re-litigated on subsequent review passes.
