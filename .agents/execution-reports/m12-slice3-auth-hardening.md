# Execution Report — M12 Slice 12.3: Auth Hardening (real single-user admin login)

## Meta Information

- **Plan file:** `.agents/plans/m12-slice3-auth-hardening.md`
- **Branch:** `m12-slice3-auth-hardening`
- **Lines changed:** +285 −109 (tracked diff vs HEAD), plus 15 new files (3 generated migration artifacts).

### Files added

**Ingest (auth primitives + surface):**
- `apps/ingest/src/password.ts` — scrypt `hashPassword`/`verifyPassword`
- `apps/ingest/src/password.test.ts`
- `apps/ingest/src/session.ts` — HMAC `signSession`/`verifySession` + `SESSION_TTL_SECONDS`
- `apps/ingest/src/session.test.ts`
- `apps/ingest/src/routes/auth.ts` — `POST /v1/auth/login` + `GET /v1/auth/me`
- `apps/ingest/src/auth.int.test.ts`

**Dashboard (login gate):**
- `apps/dashboard/src/lib/session.ts` — Edge `verifySessionEdge` (`crypto.subtle`) + `SESSION_COOKIE`
- `apps/dashboard/src/lib/session.test.ts` — Node-sign → Edge-verify interop (Spike 3)
- `apps/dashboard/src/middleware.ts` — login gate
- `apps/dashboard/src/app/login/page.tsx`
- `apps/dashboard/src/components/auth/login-form.tsx`
- `apps/dashboard/src/app/api/auth/login/route.ts`
- `apps/dashboard/src/app/api/auth/logout/route.ts`

**DB (migration):**
- `packages/db/drizzle/0009_exotic_ben_grimm.sql` (+ `meta/0009_snapshot.json`, `meta/_journal.json` entry)

### Files modified

- DB: `packages/db/src/schema.ts` (users.password_hash), `repositories/users.ts` (findAdminCredential, setUserPassword), `index.ts` (barrel)
- Ingest: `app.ts` (opts/decorations + register authRoutes), `auth.ts` (hybrid gate), `plugins/auth.ts` (type augmentation), `schemas.ts` (loginBodySchema), `server.ts` (env reads + seed), and 10 route files retiring `DEFAULT_EMAIL` (`alerts, exports, git, interpretations, monitor, pairing-codes, projections, projects, reports, workspaces`), plus a stale comment in `catalog.int.test.ts`
- Dashboard: `lib/ingest.ts` (async cookie-based `adminHeaders`), `lib/proxy.ts` (await), `components/app-nav.tsx` (logout), 8 Server Component / Route Handler call sites (await), `lib/ingest.test.ts` + `lib/proxy.test.ts` (cookie contract + `next/headers` mock)
- Docs: `.env.example`, `README.md`

## Validation Results

- **Syntax & Linting:** ✓ (no lint step in the gate; NUL-byte + stray-artifact scans clean)
- **Type Checking:** ✓ root `tsc -b` exit 0; ✓ `typecheck:dashboard` (tsc --noEmit) exit 0
- **Unit Tests:** ✓ all pass (password, session, dashboard session-interop, ingest/proxy cookie contract)
- **Integration Tests:** ✓ `repo-health --require-db` PASS — **129 integration tests ran, 0 skipped**; 488 tests total green
- **Build gate:** ✓ `build:dashboard` exit 0 (Edge middleware compiled; no `node:crypto` leak into the middleware graph)
- **D8 invariant:** session token rides an httpOnly/sameSite=lax/secure-in-prod cookie; `SESSION_SECRET` never sent to client; no NEXT_PUBLIC_* exposure

## What Went Well

- **Spike-proven snippets transferred verbatim.** The three crypto modules (password, session, Edge verifier) were lifted directly from the plan's spike-validated snippets; the Node↔Edge HMAC interop test passed first try — the byte-format compatibility held exactly as Spike 3 predicted.
- **The "optional buildApp options with defaults" strategy worked as intended.** All 6 existing `buildApp` callers compiled and passed unchanged; `adminEmail` defaulting to the legacy literal kept every `DEFAULT_EMAIL`-seeded test resolving the same user — zero regression in the existing int suites.
- **Mechanical `DEFAULT_EMAIL` retirement** across 10 files via two-pass edits (remove declaration, then `replace_all` the identifier) reached the 0-occurrence acceptance criterion cleanly.
- **The hybrid gate stayed sync + same-signature**, so none of the 12 admin route call sites changed — exactly the blast-radius the plan promised.

## Challenges Encountered

- **The plan undercounted the `adminHeaders()` blast radius.** It listed "13 sites" but `machines/page.tsx` has 3 calls (14 live call sites total), and — more importantly — it did NOT flag that **`proxy.test.ts`** exercises `proxyJson`/`proxyStream`, which now transitively call the async `cookies()`. Making `adminHeaders()` async broke 4 assertions in that co-located test (an unmocked `next/headers` threw → caught as 502, turning a forwarded-404 assertion into 502 and a passthrough assertion into an undefined-array-index crash). The full `repo-health` vitest run surfaced it; typecheck could not. Fixed by rewriting `proxy.test.ts` to the cookie contract with a `vi.hoisted` + `vi.mock("next/headers")` shim (same pattern as `ingest.test.ts`).
- **Test-DB migration is not covered by `db:migrate`.** `migrate-cli.ts` only migrates `DATABASE_URL` (dev), but the int tests connect to `DATABASE_URL_TEST` (`420ai_test`). I had to apply migration 0009 to the test DB explicitly (one-off `runMigrations` against the test URL) before the int layer would see `password_hash`. Without that, `auth.int.test.ts` would have failed on a missing column.

## Divergences from Plan

**Rewrote `proxy.test.ts` (not listed in the plan's Task 13 file list)**
- Planned: Task 13 enumerated the call sites + "(Also update `lib/ingest.test.ts` — Task 18)"; `proxy.test.ts` was not mentioned.
- Actual: rewrote `proxy.test.ts` to the cookie-based contract (mock `next/headers`), since `proxyJson`/`proxyStream` now await `adminHeaders()`.
- Reason: making `adminHeaders()` async transitively broke the proxy unit test; it had to move to the new contract.
- Type: Plan assumption wrong (incomplete impact analysis).

**Hid the nav on `/login` and made logout right-aligned**
- Planned: logout control "nice to have" to hide nav on `/login` (`usePathname() === "/login" → null`).
- Actual: implemented both — nav returns `null` on `/login`, logout button `ml-auto`.
- Reason: cleaner UX; the plan explicitly marked it acceptable/nice-to-have.
- Type: Better approach found (within the plan's sanctioned latitude).

**Tidied the stale `DEFAULT_EMAIL` comment in `catalog.int.test.ts`**
- Planned: acceptance criterion targeted `apps/ingest/src` source; a comment in an int test referenced `DEFAULT_EMAIL`.
- Actual: reworded the comment so `DEFAULT_EMAIL` is truly 0-occurrence across `apps/ingest/src`.
- Reason: honor the acceptance grep literally + codebase consistency.
- Type: Other (completeness).

## Skipped Items

- **Brute-force rate-limiting on `POST /v1/auth/login`** — explicitly deferred to slice 12.4 by the plan (documented in a code comment); scrypt cost + localhost single-user makes it acceptable now.
- **`/api/auth/me` proxy + admin-email display in the nav** — the plan marked this optional ("a logout button is sufficient"); not implemented to keep the surface minimal. (`GET /v1/auth/me` itself IS implemented + tested on the ingest side.)
- **Level 4 live-stack manual QA + screenshots to `.agents/qa/m12-slice3/`** — the completion checklist's manual login/D8-grep step on a running stack was not performed in this automated execution; the D8 invariant is instead pinned by the interop unit test (same-secret success) and the httpOnly-cookie / no-NEXT_PUBLIC design. Recommend a human run of Level 4 before production use.

## Code Review Outcome

Ran `/lril:code-review` after implementation. Three findings, all fixed + regression-tested:
- **HIGH** — open redirect via `next` param in `login-form.tsx` (`//evil.com` passed a naive `startsWith("/")`). Fixed: reject `//` and `/\` prefixes.
- **LOW ×2** — `JSON.parse("null").exp` would throw an uncaught TypeError in both verifiers (MAC-gated, not attacker-reachable). Hardened both with a `!payload` guard + added valid-MAC-null-body regression tests.
Full review: `.agents/code-reviews/m12-slice3-auth-hardening.md`.

## Recommendations

- **Plan command:** when a synchronous helper is being made `async`, the impact analysis must include **co-located unit tests that exercise the helper transitively** (not just direct call sites). The "13 sites" count was call sites in app code only; the breaking change was in a test's mocking setup. Add a checklist item: "grep for tests importing the changed module / its dependents."
- **Execute command:** already strong on "the gate is the whole suite, not the files you touched" — this run is a concrete proof point (typecheck green, 4 tests red). Keep it.
- **CLAUDE.md addition:** document that the **test DB (`DATABASE_URL_TEST` / `420ai_test`) is NOT migrated by `npm run db:migrate`** — a new migration must be applied to it separately before `repo-health --require-db` will exercise it (otherwise int tests fail on the missing column, or worse, a future no-column-touch migration silently leaves them stale). Consider adding a `db:migrate:test` script to remove this manual step.
