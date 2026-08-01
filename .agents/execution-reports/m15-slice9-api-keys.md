# Execution Report — M15 Slice 15.9: API keys + retire `ADMIN_TOKEN`

**Date:** 2026-08-01 · **Commit:** `48f4e28` · **Branch:** `m15-slice9-api-keys`

## Meta Information

**Plan file:** [`.agents/plans/m15-slice9-api-keys.md`](../plans/m15-slice9-api-keys.md)

**Lines changed:** +7,607 / −506 across 69 files (58 modified, 11 added, 0 deleted)

**Files added (11)**

| Path | Purpose |
|---|---|
| `packages/db/src/repositories/api-keys.ts` | Repository — mint / hash-lookup / liveness / touch / list / revoke |
| `packages/db/src/repositories/api-keys.int.test.ts` | Two-role repository suite (17 tests) |
| `packages/db/drizzle/0021_typical_gabe_jones.sql` | Migration, hand-annotated |
| `packages/db/drizzle/down/0021_typical_gabe_jones.down.sql` | Rollback SQL |
| `packages/db/drizzle/meta/0021_snapshot.json` | drizzle journal artifact |
| `apps/ingest/src/routes/api-keys.ts` | The three HTTP routes |
| `apps/ingest/src/reauth.ts` | The re-auth gate, **extracted** from `routes/mfa.ts` |
| `apps/ingest/src/api-keys.int.test.ts` | Two-role HTTP suite (24 tests) |
| `apps/ingest/src/api-keys.test.ts` | Unit tests for the two extracted pure functions (14 tests) |
| `apps/ingest/src/test-support/bootstrap-key.ts` | `seedBootstrapKey` — the one helper the 24-file migration uses |
| `.agents/plans/m15-slice9-api-keys.md` | The plan itself |

**Files modified (58)** — grouped by why:

- **Schema / db surface (6):** `schema.ts`, `tokens.ts`, `index.ts`, `repositories/principal.ts`
  (`findPrincipalByUserId`), `repositories/rls.int.test.ts` (`NO_RLS_TABLES`), `rollback.int.test.ts`
  (drill retargeted 0020 → 0021), plus `drizzle/meta/_journal.json`.
- **Ingest core (9):** `auth.ts`, `app.ts`, `plugins/auth.ts`, `server.ts`, `schemas.ts`,
  `routes/monitor.ts`, `routes/members.ts`, `routes/mfa.ts`, `routes/auth.ts`, `routes/sso.ts`,
  `routes/org-scoping.test.ts`, `analysis/provider.ts`.
- **Test migration (19 ingest + 2 collector):** every `*.int.test.ts` that passed `adminToken` to
  `buildApp`.
- **Desktop (6):** `keychain.rs`, `proxy.rs`, `server.rs`, `bridge.ts`, `Settings.tsx`,
  `SyncHealth.tsx`.
- **Consumers / ops (10):** `scripts/generate-reports.mjs`, `setup-env.mjs`, `setup-env.test.ts`,
  `smoke-alert.sh`, `CATALOG-SIGNING.md`, `apps/collector/src/cli.ts`, dashboard settings page +
  view, `.env.example`, `docs/guide/operations.md`, `.prettierignore`, `SUMMARY.md`.

---

## Validation Results

| Gate | Result |
|---|---|
| Syntax & Linting (`npm run lint`) | ✓ exit 0 |
| Formatting (`npm run format:check`) | ✓ "All matched files use Prettier code style!" |
| Type Checking (root `tsc -b`) | ✓ 0 errors |
| Type Checking (`typecheck:dashboard`) | ✓ 0 errors |
| Type Checking (`typecheck:desktop`) | ✓ 0 errors |
| Rust (`cargo test`) | ✓ 28 passed, 0 failed |
| Rust (`cargo clippy -- -D warnings`) | ✓ clean |
| **Full suite (`repo-health --require-db`)** | ✓ **PASS — 141 files, 1250 tests, 472 integration, 0 skipped** |
| Migration round-trip (`db:migrate` → `db:rollback` → `db:migrate`) | ✓ clean |
| Grep gate (`grep -rn "adminToken" apps/ingest/src packages/*/src`) | ✓ **0 hits** |

**Tests added: 55** (24 HTTP integration + 17 repository integration + 14 unit).

**Two negative controls run rather than assumed:**

- Replacing `or(isNull(expiresAt), gt(...))` with a bare `gt` → **8 of 17** repository tests fail.
- Deleting the SSE `isApiKeyLive` probe → **exactly 1** test fails (the stream test), and nothing
  else — which is what makes it a test of the *stream's* re-check rather than of revocation generally.

---

## What Went Well

- **The plan's five spikes paid for themselves.** SPIKE 3 (base64url includes `_` and `-`) changed
  the design before a line was written; a `split("_")` scheme would have mis-handled a random
  fraction of valid keys and presented as "API keys are flaky", not as a parsing bug. SPIKE 1's
  no-`GRANT`-needed claim was re-verified live for this exact table shape (`relrowsecurity=false`,
  0 policies, app role holds DELETE/INSERT/SELECT/UPDATE implicitly).
- **The three-phase ordering held.** Each phase was independently shippable, and Phase C's 24-file
  sweep never touched logic — which is why a mechanical error there would have been a compile break
  rather than a silent auth hole.
- **Extracting the two pure functions was the highest-leverage decision.** `effectiveApiKeyRole` and
  `shouldTouchApiKey` are the whole of D-15.9-4 and D-15.9-7, and pulling them out of
  `resolvePrincipal` turned a 4×4 role matrix from "three cases covered, thirteen assumed" into a
  table-driven unit test with no database.
- **`tsc`'s excess-property check did flag every `buildApp({ adminToken })` call site**, which the
  plan predicted might not happen. But pairing it with the explicit `grep` was still correct — the
  grep is what proved the conversion complete, and it caught a stale reference `tsc` could never see.
- **The plan named its own sharpest risk correctly.** The SSE re-check (Task 8) *was* the one place
  where inheriting an existing comment's reasoning would have silently re-opened a closed hole.
  Having that flagged in advance meant it got a mutation proof rather than a glance.

---

## Challenges Encountered

- **OneDrive deleted three tracked files mid-run.** `apps/collector/src/connectors/connector.ts`,
  `packages/db/src/repositories/ingest.ts` and `apps/collector/src/capture-engine.int.test.ts`
  vanished from the working tree, and a `capture-engine.int.test-Living-Room.ts` conflict copy
  appeared holding my edit. Surfaced as ~18 bogus "Cannot find module" errors in an otherwise-clean
  typecheck. Restored from HEAD; the edit was re-applied to the real path and the conflict copy
  deleted. **Nothing was lost, but nothing in the gate chain would have caught it** — `tsc` reported
  it as a module-resolution error, not as a missing file, and only `git status` told the truth.
- **My own edits introduced CRLF into an LF repo.** Python's `open(p, 'w')` on Windows translates
  `\n` → `\r\n`, so 34 files silently changed line endings. This broke one vitest parse with an
  unlocalised `SyntaxError: Invalid or unexpected token` that `node --check` and `esbuild` both
  *passed*, costing several bisect cycles before line endings were even a suspect. Fixed by
  normalizing all 34 and re-writing subsequent edits with `newline=''`.
- **A grep pattern inside a block comment terminated the comment.** Writing
  `grep -rn "adminToken" apps/ingest/src packages/*/src` into a `/** … */` doc comment ended it at
  the `*/`, producing 10 cascading parse errors. Trivially fixed, but a genuinely easy trap when the
  whole slice is about documenting a grep gate.
- **Three of my first-pass integration tests asserted the wrong existing-route shapes** —
  `/v1/auth/me` returns `{ email }` only (not `orgId`/`role`), `POST /v1/members/invite` returns 200
  not 201, `POST /v1/auth/password` returns 204 not 200. I wrote the assertions from the plan's
  narrative rather than from the routes. The fix was better than the original intent: role is now
  observed **behaviourally** through two gates at different rungs (`GET /v1/invites` at `admin`,
  `GET /v1/monitor` at `viewer`), which tests the claim that actually matters — "the key is
  *authorized* at the lower rung" — rather than a string a route happens to report.
- **`POST` with no bearer returns 400, not 401**, because Fastify validates the body before the
  handler runs. My first "all routes 401 without a credential" test therefore proved schema
  validation works and said nothing about authentication. Fixed by sending a valid body.

---

## Divergences from Plan

### 1. No `API_KEY || ADMIN_TOKEN` fallback in the consumers

- **Planned:** Task 18 / 20 — read `API_KEY` first, fall back to `ADMIN_TOKEN` so a half-upgraded
  install keeps running.
- **Actual:** `API_KEY` only. When it is unset **and** `ADMIN_TOKEN` is set, both consumers fail with
  an explicit migration message naming the retirement and how to mint a key.
- **Reason:** The fallback is correct for a Phase-B-*only* landing, where both credentials still
  work. All three phases land in one change, so the server accepts no `ADMIN_TOKEN` at all — the
  fallback would have sent a credential guaranteed to 401, converting a fixable configuration error
  into an opaque failure on an unwatched cron job. The `||`-not-`??` rule from CLAUDE.md still
  applies and is applied, to the `API_KEY` read itself.
- **Type:** Better approach found (plan assumption was phase-scoped and stopped holding once the
  phases merged).

### 2. `admin_token` was **removed** from the desktop keychain struct, not kept alongside `api_key`

- **Planned:** Task 19 — *add* `#[serde(default)] pub api_key: String`.
- **Actual:** Added `api_key` with `#[serde(default)]` **and** deleted `admin_token`.
- **Reason:** Keeping a field the server can no longer authenticate is the same false guarantee
  D-15.9-10 removed from `buildApp`. Deletion is safe in the other direction — serde ignores unknown
  fields, so an existing blob's `adminToken` is simply dropped on load. The mandatory
  `#[serde(default)]` on the *new* field is what prevents the documented "every install presents as
  UNPAIRED after upgrade" failure.
- **Type:** Better approach found.

### 3. `rollback.int.test.ts` retargeted from 0020 to 0021

- **Planned:** not mentioned.
- **Actual:** The D-M15-13 rollback drill now targets 0021; 0020's assertions survive as
  untouched-by-0021 invariants, and `api_keys` presence/absence is asserted across the round trip.
- **Reason:** The drill is pinned to "the latest migration" and failed on `trackedCount() === 21`
  once 0021 existed. This is the same retargeting 15.5/15.6/15.7/15.8 each performed — the plan
  simply did not enumerate it.
- **Type:** Plan omission (mechanical, expected).

### 4. `.prettierignore` gained `apps/desktop/src-tauri/gen`

- **Planned:** not mentioned.
- **Actual:** One entry added beside the existing `src-tauri/target`.
- **Reason:** Running `cargo test`/`cargo clippy` (which the plan *does* require) generates
  gitignored ACL/capability schemas under `gen/`. They are untracked, so CI never sees them, but a
  **local** `format:check` fails on files nobody authored and nobody may hand-edit.
- **Type:** Other (gate hygiene caused by a required step).

### 5. Two suites lost their machine-tier fixture entirely

- **Planned:** Task 25 implied every converted file mints a key.
- **Actual:** `rbac.int.test.ts` and `identity.int.test.ts` had their `SERVICE_TOKEN` declaration and
  mint **removed**, not converted.
- **Reason:** Neither ever presented it as a bearer — it was only ever a `buildApp` option, so with
  the option gone the fixture was dead code (caught by ESLint, not by `tsc`).
- **Type:** Plan assumption wrong (the plan's "33 occurrences" count did not distinguish bearer uses
  from option-only uses).

---

## Skipped Items

**Level 4 — Manual validation: NOT PERFORMED.** The plan's four `curl` outcomes (mint → use →
revoke → 401, plus the retired-token 401) were **not** run against a live server. Every one of them
is covered by an equivalent assertion in `api-keys.int.test.ts` driving the real Fastify app against
the real database, so the behaviour is proven — but "proven at the inject layer" is not "proven over
a socket", and the distinction is stated here rather than glossed.

**Level 5 — M15 sign-off evidence: NOT PERFORMED.** Neither checklist item this slice owns has
evidence in `.agents/qa/m15-signoff/`:

- [ ] Desktop app runs with an API key, `ADMIN_TOKEN` removed from the keychain; pairing + Monitor
      round-trip green
- [ ] `reports:generate` runs authenticated by an API key

Both require a running stack and, for the first, a built desktop app. The Rust changes compile and
`cargo test` passes (28/28), but **the desktop app was not launched and the keychain round-trip was
not exercised end to end.** This is the single largest residual risk in the slice and should be
cleared before M15 sign-off, not before this PR merges.

**Nothing else from the plan was skipped.** All 27 tasks were completed.

---

## Recommendations

### Plan command improvements

- **Phase-scoped instructions need an explicit "if you are landing all phases together" note.** The
  `API_KEY || ADMIN_TOKEN` fallback was right for its phase and wrong for the merged result, and
  nothing in the plan flagged that the guidance was conditional. A plan that defines phases should
  say which instructions expire when a later phase lands in the same change.
- **Have the plan enumerate the "retarget with every migration" chores.** The rollback drill has now
  been retargeted by five consecutive slices and has been listed as a task by none of them.

### Execute command improvements

- **Verify the response shape of every pre-existing route a new test asserts against, before writing
  the assertion.** Three of my tests encoded the plan's prose instead of the route's actual contract.
  A two-minute `grep` for the handler's `reply.send(...)` would have prevented all three.
- **Run `git status` between phases, not only at the end.** The OneDrive deletion sat undetected
  until a typecheck produced 18 confusing module errors; a `git status` after each phase would have
  caught it immediately and cheaply.

### CLAUDE.md additions

Two proposed additions to **Tooling gotchas (Windows)** — both cost real time here:

1. **Python-based bulk edits silently rewrite line endings.** `open(p, 'w', encoding='utf-8')` on
   Windows translates `\n` → `\r\n`. This repo is LF, so a scripted multi-file edit converts every
   file it touches. The failure is *not* a diff-noise annoyance: it surfaced as an unlocalised
   `SyntaxError: Invalid or unexpected token` from vitest, while `node --check` and `esbuild` both
   parsed the same file successfully. **Always pass `newline=''`** when scripting edits, and verify
   with `git diff --stat` that the churn matches the intended change.
2. **A `*/` inside a block comment ends it.** Documenting a shell glob such as `packages/*/src` in a
   `/** … */` doc comment silently terminates the comment and cascades parse errors into the rest of
   the file. Prefer backticked prose or a `//` comment for anything containing `*/`.

And one for **Testing**:

3. **A route with a body schema returns 400 before it returns 401.** Fastify validates the body
   ahead of the handler, so an "unauthenticated request is rejected" test that sends an empty payload
   proves schema validation and asserts nothing about authentication. Send a *valid* body when
   testing an auth gate on a POST.
