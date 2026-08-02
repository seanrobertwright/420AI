# Code review — M15 slice 15.10 (team surfaces + append-only audit table)

Reviewed at `b0f64bb`, against `.agents/plans/m15-slice10-team-surfaces.md`.

**Stats:**

- Files Modified: 33
- Files Added: 41 (5 of them PNG screenshot evidence)
- Files Deleted: 0
- New lines: 9,122
- Deleted lines: 103

Scope of the read: every added file in full, every modified file in full (not just the hunk). The
review checked the plan's 16 acceptance criteria, the CLAUDE.md invariants the slice touches
(tenancy/RLS, explicit column lists, long-lived resources, logging boundaries), and the two
path-matching traps the plan names as highest-risk.

---

## Findings

### 1. `navigator.clipboard` is unguarded — crashes on any non-HTTPS deployment

```
severity: high
file: apps/dashboard/src/components/settings/api-keys-card.tsx
line: 184
```

**issue:** `void navigator.clipboard.writeText(minted.token).then(() => setCopied(true))` has neither
a presence check nor a `.catch`.

**detail:** `navigator.clipboard` is `undefined` outside a secure context. `localhost` is treated as
secure, so this works in dev and in every test — but a self-hosted 420AI reached at
`http://192.168.4.70:3000`, which is the deployment this product is built for, gets `undefined` and
the click handler throws `TypeError: Cannot read properties of undefined`. The failure lands on the
**one control whose entire purpose is capturing a value that is shown exactly once**: the minted API
key. The user clicks Copy, nothing visibly happens, and the only copy of the credential is one
Dismiss away from being unrecoverable.

Even in a secure context the promise can reject (permission denied, document not focused), and an
unhandled rejection there leaves `copied` false with no explanation.

This is also a **deviation from the repo's own precedent**, which is what makes it a clear defect
rather than a judgement call — `apps/dashboard/src/components/pairing/pairing-view.tsx:51-59` does
exactly this and wraps it:

```ts
try {
  await navigator.clipboard.writeText(result.code);
  setCopied(true);
} catch {
  /* clipboard blocked — the code is visible to copy manually */
}
```

**suggestion:** Copy that shape verbatim, including the comment's reasoning (the token stays visible
in the `<code>` block, so manual selection is a real fallback). Guard the presence too, since the
precedent's `try` catches a rejected promise but not a missing `navigator.clipboard`:

```ts
async function copyToken(): Promise<void> {
  try {
    await navigator.clipboard?.writeText(minted.token);
    setCopied(true);
  } catch {
    /* clipboard blocked or unavailable — the token is visible above to copy manually */
  }
}
```

---

### 2. Self-targeting a `/team` mutation signs you out, and the UI reports it as a generic failure

```
severity: medium
file: apps/dashboard/src/components/team/team-view.tsx
line: 117 (reportFailure), 194 (remove), 214 (resetMfa)
```

**issue:** `outranks` permits equal rank by design, so an `owner` may press **Reset 2FA** or
**Remove** on their **own** row. Both revoke the target's sessions — including, in this case, the
session making the request. The island has no 401 branch, so every subsequent fetch returns 401,
`loadMembers`/`loadInvites` swallow it to `null`, and the page silently stops updating.

**detail:** The server behaviour is correct and deliberate (`members.ts` documents both the
equal-rank allowance and why revoking sessions is not optional). The defect is purely the UI's
reading of it. Two concrete paths:

- **Reset 2FA on yourself** → 204. `resetMfa` then sets the notice *"Two-factor authentication
  cleared and their sessions were signed out"* and calls `refreshAll()`, whose fetches all 401 →
  `loadMembers` returns `null` → `if (m) setRoster(m)` skips → the roster silently freezes at its
  pre-mutation state. The user sees a success message on a page that is now dead.
- **Remove yourself** (legal once a second owner exists) → 204, same silent freeze, and
  `router.refresh()` re-renders a server component whose own `adminHeaders()` call now 401s.

`reportFailure` (line 117) has no `401` case, so a subsequent failed mutation falls through to
`else setError(fallback)` and shows *"Could not change that role."* — which reads as a transient
server problem and invites the retry that cannot work.

**suggestion:** Two small changes, neither of which touches the server:

1. Add a 401 branch to `reportFailure` that is honest about what happened and gives the one action
   that helps: `setError("Your session ended. Sign in again.")`. Better still, hard-navigate:
   `window.location.href = "/login"`, matching how `app-nav.tsx`'s logout does it — a full request is
   what makes the middleware re-gate.
2. Make `refreshAll` distinguish "unauthenticated" from "failed": have `loadMembers`/`loadInvites`
   surface a `401` sentinel the way `loadInvites` already surfaces `"forbidden"`, and redirect on it.

A cheaper alternative, if the redirect is unwanted: keep the controls but make the copy accurate for
the self-target case — the notice already says "their sessions were signed out", which is precisely
what is about to break the page, so it can say "you have been signed out" when
`userId === your own`. That requires passing the caller's `userId` into the island, which
`GET /v1/org` does not currently return.

---

### 3. The out-of-band invite handoff shows a path, not a link

```
severity: low
file: apps/dashboard/src/components/team/team-view.tsx
line: 395
```

**issue:** When no mailer is configured, the token comes back for the admin to pass on and the UI
renders `` {`/invite/${handoffToken}`} `` — a relative path.

**detail:** This is the **supported single-box workflow** (D-15.5-10), not a degraded mode, so it is
the path a solo self-hosted operator uses every time they onboard someone. The admin must
hand-assemble `http://<host>:<port>` in front of it before pasting into Slack, and getting the host
wrong produces a link the colleague cannot use — with a single-use token attached.

The copy also says "pass this link on yourself", which the rendered value is not.

**suggestion:** Render an absolute URL from the browser's own origin, which is by definition the one
the admin is currently reaching the dashboard on:

```tsx
<code className="block break-all font-mono text-xs">
  {`${window.location.origin}/invite/${handoffToken}`}
</code>
```

Guard it for SSR (`typeof window === "undefined"`) or compute it in an effect — this is a client
island, but the first render still runs on the server. Consider a Copy button here too, subject to
finding 1's guard.

---

### 4. The two public invite proxies do not forward `request.signal`

```
severity: low
file: apps/dashboard/src/app/api/auth/invites/[token]/route.ts
line: 28
file: apps/dashboard/src/app/api/auth/invites/accept/route.ts
line: 38
```

**issue:** Both call `fetch(...)` without passing the incoming request's `AbortSignal`, so a client
disconnect mid-flight leaves the dashboard→ingest hop running to completion.

**detail:** Flagged for completeness against CLAUDE.md's long-lived-resource rule, but **it is not a
regression and fixing it here alone would be inconsistent**: `lib/proxy.ts`'s `proxyJson` — which
every other JSON proxy in the app uses, including the nine added by this slice — does not pass a
signal either. Only `proxyStream` does, which is the case the M9 lesson was actually about (an SSE
stream held open indefinitely). These two are short, bounded requests: one indexed token lookup, and
one scrypt-bounded account creation.

The accept route is the marginally more interesting of the two, since abandoning it does not stop
the user from being created — but that is a property of the upstream write, not of the missing
signal, and cancelling the hop would not roll the transaction back either.

**suggestion:** Leave as-is for this slice. If it is worth doing, do it **once in `proxyJson`** so
all eleven proxies gain it together, and treat the two hand-rolled auth routes as following suit.
Note that `api/auth/login/route.ts`, which these were deliberately modelled on, has the same shape.

---

### 5. `TeamView` ignores its `members` prop after first render

```
severity: low
file: apps/dashboard/src/components/team/team-view.tsx
line: 67
```

**issue:** `useState<Member[]>(members)` seeds from the server prop, and React ignores subsequent
prop changes for an already-mounted component. So a `router.refresh()` that produces a new roster
server-side does not update the table.

**detail:** Currently harmless, and worth recording as *why* rather than leaving it to be
rediscovered: every mutation path calls `refreshAll()`, which re-fetches `/api/members` on the client
and calls `setRoster` explicitly, so the island keeps itself current and the stale prop is never
observed. The latent trap is that the two mechanisms are redundant — a future edit that drops the
client re-fetch on the assumption that `router.refresh()` covers it would silently stop updating the
table.

**suggestion:** No behavioural change needed. Either add a one-line comment at line 67 stating that
the prop is a **first-paint seed only** and that `refreshAll()` owns every subsequent update, or drop
the server-side `members` fetch entirely and let the island own the data (which would cost a
first-paint flash, so the comment is the better trade).

---

## Checked and found correct

Recording these because several are the places this milestone has previously been burned, and a
review that only lists problems does not tell the next reader what was actually verified.

- **The append-only policy shape** matches the spike exactly: one `PERMISSIVE / INSERT /
  with_check=true / qual=null` policy, `relrowsecurity=true`, `relforcerowsecurity=false`. Asserted
  in `rls.int.test.ts` (test 8 and the new test 10) with every count **derived from list lengths** —
  no literal integer was edited, which is the 15.4 lesson.
- **The negative control was actually run and observed to fail** (tests 3 and 4 of
  `audit.int.test.ts`), then restored. A negative test nobody has watched fail is not evidence.
- **Audit reads in tests go through the OWNER handle** in both new int suites. Through the app handle
  they would pass vacuously against zero rows.
- **Audit writes are inside the caller's transaction** everywhere, and `recordAuditEvent` opens none
  of its own. No `try/catch` wraps an audit call — D-15.10-3 held.
- **No secret reaches `metadata`.** `api_key.minted` carries `keyName`/`role`/`expiresAt` only, and
  `audit.int.test.ts` asserts `JSON.stringify(rows)` does not contain the minted plaintext.
- **Both path-matching traps are closed and pinned.** `lib/public-paths.test.ts` asserts
  `/invite/abc123` is public while `/invite` and `/invitex` are not; the walkthrough confirmed
  `/invite/<token>` → 200 and `/team` → 307 with no cookie, and 0 occurrences of nav chrome on the
  invite page.
- **Explicit column lists** on `getOrg`/`renameOrg` including the `returning()`, per the 15.1 rule.
- **`renameOrg` takes no target-org parameter**, so a cross-org rename is inexpressible rather than
  refused; `org.int.test.ts` pins that a smuggled `orgId` is inert.
- **The `outranks` floor is present on both new privileged paths** (`DELETE /v1/members/:id/mfa` and
  the existing member routes), and the MFA reset revokes sessions in the same transaction.
- **Library files write nothing to stdout/stderr** and call no `process.exit`.
- **No `setInterval`, SSE stream or event listener was added.** Every `useEffect` in the five new
  components arms its `cancelled` cleanup before the first `await` resolves.
- **`org.ts` passes `org-scoping.test.ts` with no allow-list entry**, and the three refreshed
  allow-list reasons match their files' own headers.

---

## Plan conformance

All 27 tasks landed. Two deliberate deviations, both defensible, neither a defect:

1. **`<OrgCard/>` self-fetches `/api/org`** rather than being fed data from `settings/page.tsx` as
   Task 21 sketched. This matches `<SsoLinks/>` and `<MfaCard/>`, the two islands it sits beside, and
   avoids making the Settings page fetch data that only one card uses and that is `null` for most
   deployments (a solo org renders nothing).
2. **The public-path predicate moved to `lib/public-paths.ts`** instead of staying inline in
   `middleware.ts` as Task 19 sketched. Required, not cosmetic: Task 19 also demanded a unit test, and
   driving `middleware()` directly means constructing a `NextRequest` and an Edge context. Extracting
   the decision is what made the highest-risk line in the slice testable.

One plan **assumption was wrong and is corrected in the code**: Task 24 expected a smuggled `orgId`
on `PATCH /v1/org` to produce a 400 via `additionalProperties: false`. Fastify's default ajv runs
with `removeAdditional`, so the key is **stripped**, not rejected. The test now asserts the measured
behaviour (200 against the caller's own org), which is the stronger guarantee — it proves the field
cannot reach the query, where a 400 would only have proven it was noticed.

---

## Environment note (not a code finding)

Mid-review, OneDrive **deleted `.git/refs/heads/m15-slice10-team-surfaces`** and left a stale
`commit-graph` referencing an unreadable object — the same class of corruption recorded on
2026-07-14. The commit object itself was intact (`b0f64bb`, parent `f78a183` = main's tip, 74 files),
so the repair was `git update-ref` plus dropping the commit-graph cache; `git fsck` is clean and the
branch was pushed to origin immediately. No content was lost and no history was rewritten. The
standing lesson applies: **push early on this machine.**
