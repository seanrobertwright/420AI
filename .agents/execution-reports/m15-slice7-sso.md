# Execution Report — M15 Slice 15.7 (SSO: Google + GitHub)

## Meta

- **Plan:** [`.agents/plans/m15-slice7-sso.md`](../plans/m15-slice7-sso.md)
- **Code review:** [`.agents/code-reviews/m15-slice7-sso.md`](../code-reviews/m15-slice7-sso.md)
- **Commits:** `3609464` (feature) · `91f5953` (review fixes)
- **Lines changed:** +8397 −29 across 42 files (25 added, 17 modified)

### Files added (25)

`packages/db/src/repositories/sso-identities.ts` ·
`packages/db/src/repositories/sso-identities.int.test.ts` ·
`packages/db/drizzle/0019_outstanding_silhouette.sql` ·
`packages/db/drizzle/down/0019_outstanding_silhouette.down.sql` ·
`packages/db/drizzle/meta/0019_snapshot.json` ·
`apps/ingest/src/sso/{provider,google,github,pkce}.ts` ·
`apps/ingest/src/sso/{google,github,pkce}.test.ts` ·
`apps/ingest/src/routes/sso.ts` · `apps/ingest/src/sso.int.test.ts` ·
`apps/dashboard/src/app/api/auth/sso/{providers,identities}/route.ts` ·
`apps/dashboard/src/app/api/auth/sso/[provider]/{route.ts,start/route.ts,callback/route.ts,callback/route.test.ts}` ·
`apps/dashboard/src/lib/{safe-next,sso-flow}.ts` ·
`apps/dashboard/src/components/settings/sso-links.tsx` · plan + review docs

### Files modified (17)

`packages/db/src/{schema,index}.ts` · `packages/db/src/repositories/{users,rls.int.test}.ts` ·
`packages/db/src/rollback.int.test.ts` · `packages/db/drizzle/meta/_journal.json` ·
`apps/ingest/src/{app,server,schemas}.ts` · `apps/ingest/src/plugins/auth.ts` ·
`apps/ingest/src/routes/{auth,org-scoping.test}.ts` ·
`apps/dashboard/src/components/auth/login-form.tsx` ·
`apps/dashboard/src/components/settings/settings-view.tsx` · `.env.example` ·
`docs/guide/operations.md` · `SUMMARY.md`

## Validation Results

| Gate                                | Result                                                    |
| ----------------------------------- | --------------------------------------------------------- |
| Syntax & Linting (`npm run lint`)   | ✓ exit 0                                                   |
| Formatting (`format:check`)         | ✓ exit 0                                                   |
| Type Checking (root `tsc -b`)       | ✓ 0 errors                                                 |
| Type Checking (dashboard lane)      | ✓ 0 errors                                                 |
| `build:dashboard`                   | ✓ compiled; all 5 SSO routes registered                    |
| Unit tests                          | ✓ 24 new (pkce 4, google 11, github 9) + 7 dashboard route |
| Integration tests                   | ✓ 24 HTTP + 13 repository, two-role throughout             |
| **`repo-health -- --require-db`**   | **✓ PASS — 1105 tests, 384 integration, 0 skipped**        |

`skipped ≠ passed` was checked explicitly: the gate reports the integration count and 0 skipped,
so the DB-backed layer demonstrably ran.

**Live validation (Level 5):** served `/login` contains **0** occurrences of either client secret,
the literal `CLIENT_SECRET`, or `ADMIN_TOKEN`; both provider buttons render (screenshot); the `start`
hop 307s to Google with `code_challenge_method=S256` and a server-derived `redirect_uri`, and to
GitHub with `state` and no challenge.

## What Went Well

- **The injected-provider pattern made an OAuth slice testable at all.** Copying
  `analysis/provider.ts` one-for-one meant every automated test drives a stub and no test opens a
  socket. The mutable-`profile` stub is what let the discriminator run the *same* callback twice and
  change only the database — the whole proof rests on that.
- **Building Google and GitHub together did what the plan predicted.** GitHub's awkwardness (no
  `id_token`, verified flag behind a second call, no documented PKCE) is what forced `usesPkce` onto
  the interface and kept the abstraction from being Google-shaped.
- **D-15.7-1 as a signature rather than a comment.** `findUserIdBySsoIdentity` cannot see an email,
  so the anti-takeover rule is structural. This paid off during the mutation check: deleting branch 4
  produced a *crash*, not adoption, because there is no adoption path to fall back to — auto-adoption
  would have to be *added*.
- **The plan's spikes were accurate.** `TRUNCATE … users … CASCADE` clears `sso_identities` without
  naming it (so no fixture edits anywhere), the app role got its grants implicitly from 0015, and
  `(provider, subject)` permits the same subject on two providers. None needed re-verification.

## Challenges Encountered

- **The mutation check's prediction was wrong in an informative way.** The plan predicted deleting
  branch 4 would yield a clean 200; it yielded a **500** (unique-index violation). I ran the
  *faithful* mutation instead — actually implementing adoption — which produced exactly the predicted
  split. The lesson is that "delete the guard" and "implement the bug" are different mutations, and
  only the second tests what the assertion claims to discriminate.
- **A test that asserted the call, not the effect, hid a real bug.** The dashboard callback test
  mocked `cookies().delete` recording only the name, so the `Path=/` vs `Path=/api/auth/sso`
  mismatch shipped green. It took a live `curl -D -` against the running server to see it. This is
  the same family as the repo's `skipped ≠ passed` and `bypassed ≠ enforced` lessons.
- **Two of my own comments asserted guarantees the code did not provide** — the flow-cookie deletion
  and `linkSsoIdentity`'s "clean 409 at every call site". Both were caught only by *executing* the
  claim (a live header dump; two hand-held transactions). Writing the confident comment is precisely
  what stops the next reader from checking.

## Divergences from Plan

**`rollback.int.test.ts` had to be retargeted**

- Planned: not mentioned.
- Actual: retargeted the drill from 0018 to 0019 (`trackedCount` 19→20, new `ssoIdentitiesTableExists`
  helper, 0018's assertions demoted to untouched-by-0019 invariants).
- Reason: the drill asserts the *latest* migration by name and count; it fails by construction on any
  slice that adds one. Its own comment says it retargets each slice.
- Type: Plan assumption wrong (an omission — the plan listed the rollback test only as a validation
  command, not as a file to edit).

**`org-scoping.test.ts` required an allow-list entry**

- Planned: not mentioned.
- Actual: added `sso.ts` to `ALLOWED_WITHOUT_WITHORG` with its argument, plus the `M15 15.3`
  justification the suite requires in the file itself.
- Reason: the structural grep flags any route file reaching `app.db` without `withOrg`. `sso.ts` is a
  legitimate exemption for `auth.ts`'s exact reason (identity tables read before any org context).
- Type: Plan assumption wrong — and the check working as designed.

**Two small enablers not in the plan**

- Planned: "reuse `mintSession` verbatim".
- Actual: had to **export** it (it was module-private through 15.6), and add `findUserEmailById`.
- Reason: branch 1 resolves only a `userId`, and `mintSession` signs the *email*. Re-deriving that
  email from the provider's assertion would have reintroduced the takeover in another costume — the
  point of branch 1 is that the provider's email is not consulted.
- Type: Better approach found (the alternative was a second `mintSession`, which is how the row's
  `expires_at` and the token's `exp` drift apart).

**The D-15.7-6 proof had to change shape**

- Planned: assert a caller-supplied `redirectUri` is rejected with 400.
- Actual: asserts the **provider received the derived URI** (`stub.lastRedirectUri`).
- Reason: Fastify's ajv is configured with `removeAdditional`, so an unknown property is *stripped*,
  not 400'd — a stronger outcome, but it means the schema-rejection assertion would have passed for
  the wrong reason the day the schema loosened. My first version asserted the 400 and failed.
- Type: Plan assumption wrong.

## Skipped Items

- **Level 4 manual validation** — needs two hand-registered OAuth apps. Nothing automated depends on
  it (the suites drive an injected stub), and it is residual risk #1 in the plan. It uniquely
  confirms the live provider round trip, real-browser cookie behaviour, and that `APP_BASE_URL`
  matches the registered redirect URI. My Level 5 run surfaced exactly that mismatch shape: the
  derived URI was `localhost:3000` while the dashboard ran on 3002 — correct behaviour, and the thing
  a real click-through would catch.
- **Review findings 5 and 6** — deferred to 15.10 with destinations recorded (email-nulling on
  refresh; multiple identities per provider per user). **Finding 7** — deliberate won't-fix; it
  matches the existing `/v1/auth/signup` precedent and fixing one path alone would be inconsistent.

## Recommendations

**CLAUDE.md additions**

- **"A mock that records the CALL cannot test the EFFECT."** The callback test recorded
  `cookie.delete:<name>` and discarded the options, so a cookie that was never actually deleted
  passed. This is the browser-layer sibling of `skipped ≠ passed` / `bypassed ≠ enforced`, and it now
  has a concrete instance to cite. Rule of thumb: when a mock drops an argument, it drops the
  assertion with it.
- **Cookie deletion must repeat every attribute that scopes the cookie.** `cookies().delete(name)`
  defaults to `Path=/` and silently no-ops against a path-scoped cookie. Worth one line beside the
  dashboard proxy rules, since 15.8 (MFA) will add more short-lived flow cookies.

**Plan command improvements**

- When a slice adds a migration, the plan should list `rollback.int.test.ts` as a **file to edit**,
  not merely a validation command — it fails by construction otherwise.
- A plan that specifies a mutation check should specify **which mutation**: "delete the guard" and
  "implement the bug" are different, and only the latter tests the discriminating claim. This plan's
  predicted 200 was only reachable via the second.

**Execute command improvements**

- The hygiene gate should say plainly that **structural/grep tests with allow-lists** (here
  `org-scoping.test.ts`) are expected to fail for a legitimately-new exempt file, and the correct
  response is an entry *with an argument*, never a widened regex.
