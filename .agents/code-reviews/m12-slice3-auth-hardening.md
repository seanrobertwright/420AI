# Code Review — M12 Slice 12.3 Auth Hardening

Reviewed branch `m12-slice3-auth-hardening` against `HEAD`. All changed + new files read in full.

**Stats:**

- Files Modified: 22
- Files Added: 15 (3 of which are generated migration files; `.agents/` plan excluded)
- Files Deleted: 0
- New lines: 285
- Deleted lines: 109

---

## Issues

```
severity: high
file: apps/dashboard/src/components/auth/login-form.tsx
line: 38
issue: Open redirect via the `next` query param (protocol-relative URL).
detail: The post-login redirect accepts any `next` value that startsWith("/"). A
  protocol-relative URL like "//evil.com" (and the backslash variant "/\evil.com",
  which some browsers normalize to "//") also passes that check, so router.push("//evil.com")
  navigates the freshly-authenticated admin OFF-SITE. The legit flow is safe (the middleware
  only ever sets `next` to a clean pathname), but an attacker can hand-craft a phishing link
  `/login?next=//evil.com` — this is attacker-reachable.
suggestion: Reject `next` unless it is a same-origin absolute path: require startsWith("/")
  AND NOT startsWith("//") AND NOT startsWith("/\\"). Fall back to "/monitor" otherwise.
status: FIXED
```

```
severity: low
file: apps/ingest/src/session.ts
line: 46
issue: Uncaught TypeError if a valid-MAC token's payload base64url-decodes to JSON `null`.
detail: The try/catch wraps only JSON.parse; JSON.parse("null") succeeds (returns null), then
  `payload.exp` dereferences null → TypeError that escapes verifySession (and bubbles out of the
  sync adminAuthorized gate → a 500 instead of a clean reject). NOT attacker-reachable: reaching
  this line requires a valid HMAC, which only the secret-holder can produce, and the signer only
  ever emits an object payload. Pure defense-in-depth, but cheap and this is auth code.
suggestion: Guard the payload before property access: `if (!payload || typeof payload.exp !== "number" ...)`.
status: FIXED
```

```
severity: low
file: apps/dashboard/src/lib/session.ts
line: 56
issue: Same null-payload deref as the ingest verifier (the Edge-side mirror).
detail: Identical pattern in verifySessionEdge — JSON.parse → null → `payload.exp` throws, escaping
  the verifier and surfacing as a middleware 500. Same non-reachability (MAC-gated), same cheap fix.
suggestion: Same guard: `if (!payload || typeof payload.exp !== "number" ...)`.
status: FIXED
```

---

## Notes (reviewed, no change required)

- **Service-token timing-safe compare** keeps the mandatory length guard before `timingSafeEqual`
  (throws on length mismatch) — correct.
- **No user-enumeration:** login returns one generic 401 for both unknown-email and wrong-password,
  and a null `passwordHash` is treated like a missing user. Verified by an int test.
- **D8 token boundary:** the browser never holds a credential; the session token rides an httpOnly,
  sameSite=lax, `secure`-in-prod cookie; `SESSION_SECRET` is never sent to the client. No
  NEXT_PUBLIC_* exposure.
- **No new long-lived resources:** middleware/Edge has no timers; the login route's `fetch` is
  request-scoped; `proxyStream` still passes `request.signal`. No M9-class leak window introduced.
- **Migration** is a single additive, generated `ALTER TABLE "users" ADD COLUMN "password_hash" text;`
  — nullable, back-compat preserved.
```
