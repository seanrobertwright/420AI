# Execution report — M15 slice 15.10 (team surfaces + append-only audit table)

## Meta

- **Plan:** [`.agents/plans/m15-slice10-team-surfaces.md`](../plans/m15-slice10-team-surfaces.md)
  (27 tasks, 5 phases, self-rated 9.4/10 for one-pass success)
- **Commit:** `b0f64bb` — 74 files, **+9,122 / −103**
- **Slice size:** the largest in M15 by file count; broad and shallow, as the plan predicted.

### Files added (39)

**`packages/shared`** — `src/audit.ts`, `src/audit.test.ts`

**`packages/db`** — `drizzle/0023_silky_longshot.sql`, `drizzle/down/0023_silky_longshot.down.sql`,
`drizzle/meta/0023_snapshot.json`, `src/repositories/audit.ts`, `src/repositories/audit.test.ts`,
`src/repositories/audit.int.test.ts`

**`apps/ingest`** — `src/routes/org.ts`, `src/audit.int.test.ts`, `src/org.int.test.ts`

**`apps/dashboard`** — `src/app/invite/[token]/page.tsx`, `src/app/team/page.tsx`,
`src/components/invite/invite-accept-form.tsx`, `src/components/team/team-view.tsx`,
`src/components/settings/api-keys-card.tsx`, `src/components/settings/org-card.tsx`,
`src/lib/public-paths.ts`, `src/lib/public-paths.test.ts`, plus **11 proxy route handlers** under
`src/app/api/{members,invites,org,auth/api-keys,auth/invites}/…`

**Evidence** — `.agents/qa/m15-signoff/` (5 screenshots + audit-trail dump + written walkthrough)

### Files modified (33, selected)

`packages/db/src/schema.ts` (+`auditEvents`), `packages/db/src/index.ts`,
`packages/db/src/repositories/organizations.ts` (+`getOrg`/`renameOrg`),
`packages/db/src/repositories/rls.int.test.ts` (fifth classification),
`packages/db/src/rollback.int.test.ts` (drill retargeted to 0023),
`packages/db/src/repositories/tenancy.int.test.ts`,
`apps/ingest/src/routes/{members,api-keys,auth,sso,mfa,pairing-codes}.ts`,
`apps/ingest/src/routes/org-scoping.test.ts`, `apps/ingest/src/{app,schemas}.ts`,
`apps/dashboard/src/{middleware.ts,components/app-nav.tsx,components/settings/settings-view.tsx}`,
`apps/desktop/src-tauri/src/proxy.rs`, `apps/desktop/src/components/Settings.tsx`,
`CLAUDE.md`, `SUMMARY.md`, `docs/guide/operations.md`,
`.agents/plans/m15-multi-user-access-control.md`

## Validation results

| Gate                                  | Result | Detail                                                    |
| ------------------------------------- | ------ | --------------------------------------------------------- |
| `npm run typecheck` (root `tsc -b`)   | ✓      | 0 errors                                                   |
| `npm run typecheck:dashboard`         | ✓      | 0 errors                                                   |
| `npm run typecheck:desktop`           | ✓      | 0 errors                                                   |
| `cargo check` (`apps/desktop`)        | ✓      | the one Rust change (a user-facing string)                 |
| `npm run lint`                        | ✓      | 0                                                          |
| `npm run format:check`                | ✓      | 0 — includes the `.md` CI lints but local repo-health does not |
| Unit tests                            | ✓      | 792 passed                                                 |
| Integration tests                     | ✓      | **515 ran, 0 skipped** (`--require-db`)                     |
| `npm run repo-health -- --require-db` | ✓      | **PASS** — 147 files, 1,307 tests                           |
| `npm run build:dashboard`             | ✓      | `/team` and `/invite/[token]` in the route manifest         |
| `db:rollback` → `db:migrate`          | ✓      | round-trips; the policy returns intact                      |
| Manual walkthrough                    | ✓      | all 12 steps against the real DB; evidence committed        |
| Negative control                      | ✓      | **observed failing**, then restored                         |

## What went well

- **The spike did its job, and specifically the negative control did.** SPIKE check 8 — a strict org
  policy rejecting an insert from an unwrapped route — is the reason this slice did not ship a design
  where every `api_key.minted` audit 500s. That failure would have surfaced during Phase 3 UI work as
  "minting is broken", three phases and a day away from its cause. A spike that only confirms the
  happy path would have missed it entirely.
- **Every count derived from list lengths held up.** Adding `APPEND_ONLY_TABLES` to
  `rls.int.test.ts` moved no literal integer, exactly as the plan promised. The one place a number
  did have to change (`rollback.int.test.ts`) was a genuinely different assertion, and it changed for
  a reason the comment now states.
- **The plan's file-and-line references were accurate.** `seedBootstrapKey` at `bootstrap-key.ts:34`,
  `clearMfa` at `mfa.ts:277`, the `reauth` reason discriminant, `serializeApiKey`'s wire shape,
  the two-handle fixture at `rls.int.test.ts:175-215` — all present as described. Nothing had to be
  re-derived, which is the difference between a plan and a sketch.
- **Task-by-task validation caught things early.** Running `npx vitest run` after each phase rather
  than at the end meant the three suites that needed updating (below) surfaced at the gate, not after
  a PR was open.
- **The append-only design is genuinely enforced, not asserted.** The three-command proof in the
  walkthrough (`0` rows to the app role, `permission denied` on delete, `8` rows surviving) is
  something a reader can re-run in fifteen seconds.

## Challenges encountered

- **Three existing suites failed on the first full gate run, all genuinely.** None was flaky and none
  was a mistake in the new code; each was a real consequence of the slice that the plan had not
  enumerated:
  - `identity.int.test.ts` asserted the 409 body matched `/15\.10/` — the plan **did** warn that the
    409 strings were wire-visible prose and to check for tests asserting them, so this was
    anticipated, just not located in advance.
  - `rollback.int.test.ts` hard-codes the migration count and policy counts and retargets every
    slice. Not mentioned in the plan at all.
  - `tenancy.int.test.ts` asserts that every table carrying `org_id` is in `TENANT_TABLES`.
    `audit_events` carries one. Also not mentioned.

  The second and third are the interesting ones: both are **structural tests that assert a
  repo-wide invariant**, and a plan that lists "files to modify" will systematically miss them,
  because the file being modified is not the file being changed by the feature.

- **`drizzle-kit generate` cannot express the policy block**, as the plan warned, so migration 0023 is
  a generated `CREATE TABLE` with ~45 hand-authored comment lines and a hand-appended policy block.
  Straightforward, but it means the migration file is now the source of truth for the policy and
  re-running `db:generate` would silently discard it. The header says so.

- **The test database is migrated separately** from the dev database and `db:migrate` does not touch
  it. Known from a prior session's memory, not from the plan; without that it would have looked like
  the new int suites were failing against a table that "should" exist.

- **Nested transactions.** `clearMfa` opens its own transaction for a `FOR UPDATE` lock, and the new
  MFA-reset route calls it with a `tx`. Drizzle turns that into a `SAVEPOINT`, which is correct, but
  it was worth confirming against `routes/mfa.ts`'s existing call rather than assuming.

- **A `git` corruption event mid-review** (see below) cost a diagnosis cycle.

## Divergences from plan

**`<OrgCard/>` self-fetches instead of receiving server-fetched data**

- **Planned:** Task 21 — "You will add `<OrgCard/>` data here" (in `settings/page.tsx`).
- **Actual:** `<OrgCard/>` fetches `/api/org` itself, like `<SsoLinks/>` and `<MfaCard/>` beside it.
- **Reason:** it renders `null` for most deployments (any solo org), so a server fetch would pay for
  data that is usually discarded, and the two islands it sits between already own their own loads.
- **Type:** Better approach found.

**The public-path predicate moved out of `middleware.ts`**

- **Planned:** Task 19 — add a `PUBLIC_PREFIXES` array inline in `middleware.ts`, and add a unit test.
- **Actual:** the decision lives in `lib/public-paths.ts` as `isPublicPath()`; `middleware.ts` calls it.
- **Reason:** the two halves of the task were in tension. Testing `middleware()` directly means
  constructing a `NextRequest` and an Edge context; extracting the pure predicate is what made the
  **highest-risk line in the slice** testable at all. `middleware.ts` must also stay free of any
  `node:crypto` import for `next build`, so the extracted file is deliberately dependency-free.
- **Type:** Better approach found.

**`app-nav.tsx` got its own prefix list rather than importing the middleware's**

- **Planned:** Task 20 — add `pathname.startsWith("/invite/")` to the nav's check.
- **Actual:** a named `UNAUTHENTICATED_PREFIXES` array beside the existing `UNAUTHENTICATED_PATHS`.
- **Reason:** the two lists answer different questions — *may you enter?* vs *should chrome render?* —
  and coupling them would make a future legitimate divergence look like a bug. Stated in the comment.
- **Type:** Other (structural clarity).

**`additionalProperties: false` strips rather than rejects**

- **Planned:** Task 24 — a cross-org rename attempt (`{name, orgId}`) should be a **400**.
- **Actual:** it is a **200** against the caller's own org, and the test asserts that.
- **Reason:** **the plan's assumption was wrong.** Fastify's default ajv runs with
  `removeAdditional`, so an unknown key is stripped before the handler sees it. The measured
  behaviour is the *stronger* guarantee: a 400 proves the field was noticed, whereas a 200 that
  renames the caller's own org proves the field **cannot reach the query**.
- **Type:** Plan assumption wrong.

**The rollback drill was retargeted, not just repaired**

- **Planned:** not addressed.
- **Actual:** `rollback.int.test.ts` now targets 0023 and asserts the policy count moves 60 → 59 → 60,
  that the table is *gone* after rollback, and that a re-migrate produces an **empty** table.
- **Reason:** the drill retargets with every slice that adds a migration (0017…0022 each did). 15.10
  is the first retarget where the policy count *moves*, and the +1 is the whole point — every
  migration since 0017 added none, so "59 before, 59 after" had been the assertion.
- **Type:** Better approach found (the drill got stricter rather than merely moving).

## Skipped items

Nothing from the plan was skipped. The plan's own **non-goals** were honoured and are named in the
PR body and SUMMARY rather than silently dropped:

- **Multi-org membership + the org switcher** → M16 (D-15.10-1). The slice **corrected eleven source
  comments** that promised them "at 15.10", including two 409 response bodies, rather than honouring
  a promise the codebase should not have made.
- **An audit-log viewer or export** → D-15.10-4. `audit.test.ts` asserts the repository exports no
  reader, so the "write-only" claim cannot rot into a half-built list endpoint.
- **Four surfaces stay headless but curl-reachable**: gated self-signup, password-reset pages, an
  active-sessions list, MFA QR rendering (the last held by the slice's no-new-dependency rule).

**No new dependency was added in any workspace**, as GOTCHA-6 required.

## Recommendations

### For the plan command

- **Add a "structural tests that will need updating" section.** Two of the three gate failures were
  repo-wide invariant tests (`rollback.int.test.ts`, `tenancy.int.test.ts`) that a "files to modify"
  list cannot surface, because the feature does not touch them — the *invariant* does. A planning
  step that greps for tests asserting counts, table lists or migration numbers would have caught
  both. The plan already does this well for `rls.int.test.ts`; it just needs to generalise.
- **When a plan asserts framework behaviour, mark it as an assumption to verify.** The
  `additionalProperties: false` → 400 claim read as fact and was wrong. One line — "verify: does this
  ajv config reject or strip?" — would have flagged it.

### For the execute command

- Nothing structural. The per-task validation cadence worked; running the full `--require-db` gate
  only after all 27 tasks was correct, since the three failures it found were cheap to fix and
  would have been noise if chased earlier.

### For CLAUDE.md

The append-only lesson has been **added** in this slice (the fourth RLS classification, the
`REVOKE`-makes-it-loud corollary, and the denormalized-audit-row rationale). Two further candidates
this slice earned:

- **`removeAdditional` is Fastify's default**, so `additionalProperties: false` **strips** rather
  than rejects. Any test asserting a 400 for an unknown body key is asserting something Fastify does
  not do. This is the same shape as the existing `??` vs `||` env lesson: a framework default that
  quietly differs from the obvious reading.
- **Structural/invariant tests are a change surface that "files to modify" does not cover.**
  `rls.int.test.ts`, `tenancy.int.test.ts`, `rollback.int.test.ts` and `org-scoping.test.ts` each
  assert something repo-wide, and a feature can break them without touching them. Worth naming as a
  standing checklist item before any gate run.

### Environment (operational, not code)

Mid-review, **OneDrive deleted `.git/refs/heads/m15-slice10-team-surfaces`** and left a stale
`commit-graph` pointing at an unreadable object — the same corruption class recorded on 2026-07-14.
The commit itself survived (`b0f64bb`, parent `f78a183`, 74 files), so the repair was `git update-ref`
plus deleting the commit-graph cache; `git fsck` came back clean and the branch was pushed to origin
immediately. No content lost, no history rewritten.

The standing mitigation is **push early**, and it is worth strengthening to: **push as soon as the
slice's first commit exists**, before review and report generation, rather than at the Phase 4 gate.
This slice's commit sat local for roughly two minutes and that was long enough to lose its ref.
