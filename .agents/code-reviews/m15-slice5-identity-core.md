# Code review — M15 slice 15.5 (identity core)

Reviewed at `c3dbbd1` on `m15-slice5-identity-core`. Scope: the whole slice diff (`HEAD~1..HEAD`),
each new file read in full, each changed file read in full rather than as a diff.

**Stats**

- Files Modified: 20
- Files Added: 14
- Files Deleted: 0
- New lines: 7613
- Deleted lines: 82

Every finding below was **reproduced with a real test before being written down** (a throwaway
`zzscratch.int.test.ts`, deleted afterwards) — except #6, which is explicitly labelled as latent
because the probe could NOT trigger it. The distinction matters: five of these are demonstrated
defects, one is a false claim in a comment.

---

## 1. An `admin` can demote — and REMOVE — an `owner`

```
severity: high
file: apps/ingest/src/routes/members.ts
line: 175 (PATCH /v1/members/:userId) and 205 (DELETE /v1/members/:userId)
issue: The escalation guard checks the REQUESTED role but never the TARGET's current role, so an
       admin can strip or evict an owner.
detail: D-15.5-11 is implemented as `hasRole(principal.role, requestedRole)` — "may I GRANT this
        rung?". Nothing asks "may I act ON this person?". An admin therefore passes the guard when
        demoting an owner to viewer (the requested rung is below their own) and the DELETE path has
        no role comparison at all. Reproduced: `PATCH` an owner as an admin → **200**, body shows
        `role: "viewer"`; `DELETE` an owner as an admin → **204**. The last-owner guard bounds the
        damage to "not zero owners" but does not prevent an admin unilaterally removing one owner of
        two, which is a privilege inversion — the whole point of the ladder is that a lower rung
        cannot act on a higher one.
        NOTE this is a gap in the PLAN, not only the code: D-15.5-11 is worded purely about granting
        ("you may never grant or assign a role above your own") and is silent about acting on a
        member above you. The implementation matched the decision as written; the decision was
        incomplete.
suggestion: Look the target up inside the same `withOrg` transaction and refuse when
        `!hasRole(principal.role, target.role)`. `hasRole` fails CLOSED on an unrecognised target
        role (`RANK[garbage]` is undefined, so the comparison is NaN → false), so a hand-edited
        membership row makes the route refuse rather than permit. Apply to BOTH the PATCH and the
        DELETE handler. An owner acting on another owner stays allowed (equal rung clears
        `hasRole`), which is what makes co-owners workable.
```

## 2. `POST /v1/auth/password-reset/confirm` runs scrypt BEFORE validating the token

```
severity: high
file: apps/ingest/src/routes/auth.ts
line: 259 (hashPassword) vs 262 (consumePasswordReset)
issue: An unauthenticated, un-rate-limited endpoint performs a ~100 ms synchronous scrypt on a
       request whose token has not been checked yet.
detail: `hashPassword` is called on the line ABOVE the transaction that validates the token, so a
        garbage token still costs a full scryptSync (N=16384, keylen 64) on the event loop before
        the request is rejected. Node's event loop is single-threaded, so this is a cheap
        unauthenticated CPU-exhaustion primitive: no credential needed and no rate limit applied.
        Note the sibling paths get this right by accident of ordering — login only calls
        `verifyPassword` after `findAdminCredential` returns a hash, and accept-invite only hashes
        after `findInviteByToken` throws — so this one route is inconsistent with the file it lives
        in, which is why it reads as correct.
suggestion: Move `hashPassword` INSIDE the transaction, after `consumePasswordReset` has validated
        and stamped the token. Holding the transaction for the scrypt duration is acceptable — it
        locks one token row on a low-volume path — and it removes the primitive entirely. Also add
        `config: { rateLimit: app.rateLimitLogin }` to this route and to
        `/v1/auth/invites/accept`: they are unauthenticated writes exactly like signup and
        password-reset, which the plan already singled out for the limit.
```

## 3. `??` makes the documented SMTP fallback silently fail for the operator it targets

```
severity: medium
file: apps/ingest/src/server.ts
line: 139-140, 147
issue: `process.env.SMTP_URL ?? process.env.ALERT_SMTP_URL` does not fall through on an EMPTY
       string, but `.env.example` ships `SMTP_URL=` empty — so the documented fallback is false.
detail: `.env.example` promises "SMTP_URL falls back to ALERT_SMTP_URL and MAIL_FROM to
        ALERT_EMAIL_FROM … so an upgrading operator who already sends alert email gets invites with
        no new configuration". An operator who does exactly that — has ALERT_SMTP_URL set, pastes
        the new block — ends up with `SMTP_URL=""`, and `"" ?? x` is `""`, so the mailer is NULL and
        invites silently stop being mailed (they fall back to returning the token, which looks like
        a deliberate no-SMTP install). Reproduced with the shipped values: `??` → mailer disabled,
        `||` → mailer enabled. The repo already knows this: server.ts:96 carries the comment
        "`||` (not `??`) so an empty-string env falls back to the default, like ANALYSIS_BASE_URL".
        `APP_BASE_URL ?? "http://localhost:3000"` has the same defect — an empty value yields an
        empty base URL and every emailed link becomes a bare path.
suggestion: Use `||` at all three sites, matching the existing idiom, and say why in a comment so
        the next edit does not "modernise" it back to `??`.
```

## 4. A mail-send failure strands an unrecoverable pending invite

```
severity: medium
file: apps/ingest/src/routes/members.ts
line: 126 (await app.mailer.send)
issue: The invite row is committed BEFORE the mail is sent, and a send failure is unhandled — so the
       admin gets a 500, never sees the token, and can never re-mint it.
detail: Reproduced with a throwing mailer: first invite → **500**, one pending `invites` row written,
        retry → **409** "an invite for this address is already pending". The token is stored only as
        a sha256 hash (correctly), so it is unrecoverable by design — the admin's only escape is to
        find and revoke the invite through a different endpoint and start again. On the one path
        whose entire job is onboarding a colleague, a transient SMTP blip becomes a dead end that
        looks like a server bug.
suggestion: Catch the send failure, log it (this is a route, so logging is in bounds), and return
        200 with `mailed: false` plus the token — the same shape the no-mailer branch already
        returns. This route is `admin`-gated, so handing the token back is already sanctioned by
        D-15.5-10; the decision's reasoning ("the admin may pass it on out-of-band") applies just as
        well to "SMTP is broken" as to "SMTP is absent". The UNAUTHENTICATED reset route must NOT
        adopt this and keeps swallowing-then-202.
```

## 5. A new password-reset token does not invalidate outstanding ones

```
severity: medium
file: packages/db/src/repositories/password-resets.ts
line: 34 (createPasswordReset)
issue: Every request mints an additional live token; OWASP requires only one active reset token.
detail: Reproduced: two reset requests leave **2** rows with `consumed_at IS NULL`, both usable for
        the full hour. The practical exposure is bounded (a token only reaches the account's own
        mailbox), but it widens the window a stale link stays dangerous: a user who requests twice,
        uses the second, and later has the first link scraped from mail history is still
        compromisable for up to an hour. The file's own header cites the 1-hour TTL as the bound on
        exposure, and this quietly multiplies the number of things that bound applies to.
suggestion: Stamp every outstanding unconsumed token for that user as consumed inside
        `createPasswordReset` before inserting the new one. One extra UPDATE on a tiny indexed set.
```

## 6. The last-owner guard takes no row lock — and its comment claims it does

```
severity: medium
file: packages/db/src/repositories/members.ts
line: 10-14 (header comment), 112 (countOwners)
issue: A shared transaction gives ATOMICITY, not isolation. `SELECT count(*)` acquires no locks, so
       under READ COMMITTED two concurrent demotions can both observe two owners.
detail: NOT REPRODUCED — a two-request probe returned one 200 and one 409 with one owner remaining,
        consistently across three runs, because the requests serialise at this concurrency. So this
        is a LATENT gap, reported as such. What IS definitely wrong is the header, which states the
        two operations "must share ONE transaction — otherwise two concurrent demotions each see two
        owners and both succeed". Sharing a transaction is not what prevents that; nothing currently
        prevents it. A comment that asserts a guarantee the code does not provide is worse than no
        comment, because the next reader will trust it instead of re-deriving it.
suggestion: Make the claim true rather than softening it: have `countOwners` select the owner rows
        `FOR UPDATE` and count them in JS. Under READ COMMITTED, a blocked second transaction
        re-evaluates the predicate after acquiring the lock (EvalPlanQual), so a row demoted by the
        first transaction no longer matches `role = 'owner'` and the second correctly sees one owner
        and refuses. Then state in the comment that the LOCK, not the transaction boundary, is what
        serialises it.
```

---

## Resolution — all six fixed at `HEAD` + 1

| # | Severity | Fix | Regression test |
| --- | --- | --- | --- |
| 1 | high | `outranks()` helper in `routes/members.ts`; both PATCH and DELETE resolve the target inside the same `withOrg` tx and 403 unless `hasRole(actor, target.role)`. Equal rank allowed so co-owners can administer each other. | 3 tests: admin→owner refused (both verbs), owner→owner allowed, admin→member/viewer still allowed |
| 2 | high | `hashPassword` moved INSIDE the transaction, after `consumePasswordReset`. Added `rateLimit` to reset-confirm and accept-invite. | covered by the existing 410 paths; ordering is now structural |
| 3 | medium | `??` → `||` at all three env sites, with a comment naming the empty-string trap | n/a (config) |
| 4 | medium | invite `send` wrapped in try/catch → 200 with `mailed:false`, `mailError:true` and the token | test asserts the returned token is USABLE end-to-end |
| 5 | medium | `createPasswordReset` stamps outstanding tokens consumed before inserting | test asserts exactly 1 live token, stale → 410, newest → 204 |
| 6 | medium | `countOwners` selects owner rows `FOR UPDATE`; file header corrected to say the LOCK (not the transaction) serialises it | repository-level test asserting tx2 BLOCKS while tx1 holds the lock |

**Each fix was verified to be load-bearing by removing it and watching the test fail** — except #3, which is
a config-semantics change proven by evaluating both operators against the shipped `.env.example`
values.

Two lessons from the fixing pass itself, both worth more than the fixes:

- **Finding 6's first regression test was worthless and looked fine.** An HTTP-level version passed
  identically with and without the lock, because two requests serialise on their own at that
  granularity. Only a repository-level test with two hand-held transactions — asserting that tx2 is
  still unsettled after 500 ms — could tell the fixed code from the broken code. A concurrency test
  that cannot fail is strictly worse than no test, because it advertises a guarantee nobody checked.
- **That same test initially failed *five other tests* along with itself.** A failing assertion
  skipped the `releaseTx1()` call, so the held transaction kept its pooled connection and every
  later test in the file timed out at 10 s. One real failure wore five fake ones. The release now
  sits in a `finally`.

Fix #1 also changed an EXISTING test's expected status: "removing the org's SOLE owner is 409" was
written with an `admin` actor and now gets 403, because the rank check fires before the last-owner
guard. The test was rewritten to use the owner as actor (the only way to reach that guard over HTTP),
and a NEW test pins the ORDER of the two refusals — a 409 there would mean the rank check had been
bypassed and the org was saved only by the owner count, which is a much weaker promise that
evaporates as soon as a second owner exists.

Post-fix gate: `repo-health --require-db` PASS — 989 tests, **304 integration tests ran, 0 skipped**
(up from 982/297).

---

## Checked and found sound (recorded so the next reviewer need not redo it)

- **No SQL injection.** Every query is a parameterised drizzle builder or a `sql` template with
  bound values. `withOrg` uses `set_config(…, true)` with a bound parameter rather than interpolating
  into `SET LOCAL` (the 15.0 Finding 4.1 trap).
- **No secret exposure.** `inviteRowColumns` / `memberRowColumns` are explicit lists that omit
  `token_hash`, `org_id` and `password_hash`; the int suite asserts the exact key sets on the wire.
  The invite preview does not echo the token. `.env.example` gained no real credential, and the UAT
  evidence file contains only throwaway values (scanned for `postgres://`, `DATABASE_URL`, `sk-`,
  `ghp_` — none).
- **Token entropy + storage.** 32 random bytes via `generateToken()`, stored as sha256, compared by
  hash lookup — same discipline as `ingest_tokens`. Plaintext returned once.
- **No user enumeration on reset.** Always 202, and a send failure logs without changing the status,
  so the timing/status oracle stays closed. (Verified the catch is inside the `if (userId)` branch.)
- **No N+1 or unbounded query.** Every new read is a single statement with an indexed predicate;
  `listMembers` is one join, not a per-member lookup.
- **No leaked long-lived resources.** This slice adds no `setInterval`, SSE stream, listener or
  proxied `fetch`. The mailer builds its nodemailer transport ONCE per process (pinned by a unit
  test), mirroring `createSmtpDeliverer`.
- **Logging boundary respected.** The three new repositories never log; the only new writes to
  stdout/stderr are `server.ts`'s self-signup warning (an entrypoint) and `request.log.error` in a
  route.
- **`acceptInvite` re-validates inside its transaction**, so two concurrent accepts cannot both
  stamp one invite, and the `users.email` unique index catches the duplicate insert.
