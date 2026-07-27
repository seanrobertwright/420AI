# Execution Report — M15 slice 15.3: RLS Enforcement

## Meta Information

- **Plan file:** `.agents/plans/m15-slice3-rls-enforcement.md`
- **Commit:** `35b3626` — 65 files changed, +6861 / −293
- **Branch:** `m15-slice3-rls-enforcement`

**Files added (13)**

| Path | What |
|---|---|
| `packages/db/src/org-context.ts` | `withOrg` — the one place the RLS context is set |
| `packages/db/src/org-context.test.ts` | 8 pure unit tests on the emitted SQL |
| `packages/db/src/provision-app-role.ts` | credential half (LOGIN + password) |
| `packages/db/src/provision-app-role-cli.ts` | secret-free entrypoint |
| `packages/db/drizzle/0015_shiny_iron_man.sql` | role, grants, default privileges, 15 policies |
| `packages/db/drizzle/down/0015_…down.sql` | reversal drill |
| `packages/db/drizzle/meta/0015_snapshot.json` | keeps `drizzle-kit generate` chained |
| `packages/db/src/repositories/rls.int.test.ts` | the two-role suite (9 tests) |
| `apps/ingest/src/rls.int.test.ts` | HTTP-level negatives under the app role (11 tests) |
| `apps/ingest/src/routes/org-scoping.test.ts` | source-level completeness (8 tests) |
| `.agents/qa/m15-signoff/15.3-rls-evidence.md` | captured psql evidence |
| `.agents/code-reviews/m15-slice3-rls-enforcement.md` | review + resolution |
| `.agents/plans/m15-slice3-rls-enforcement.md` | the plan itself |

**Files modified (52)** — 15 route files, 3 report/interpretation orchestrators, 7 repositories
(`ingest`, `git`, `reports`, `reprice`, `reparse`, `search`, `organizations`, `alert-firings`),
`server.ts`, both replay CLIs, `repo-health.mjs`, `setup-env.mjs`, desktop
`server.rs`/`keychain.rs`/`Settings.tsx`/`bridge.ts`, `.env.example`, `CLAUDE.md`, `SUMMARY.md`,
`docs/guide/operations.md`, and 6 existing int-test files.

## Validation Results

| Gate | Result |
|---|---|
| Root `tsc -b` | ✓ exit 0 |
| `npm run lint` (eslint) | ✓ exit 0 |
| `npm run format:check` | ✓ "All matched files use Prettier code style!" |
| `typecheck:dashboard` / `typecheck:desktop` | ✓ 0 errors |
| `cargo test -- --test-threads=1` | ✓ 27 passed |
| **`npm run repo-health -- --require-db`** | ✓ **PASS — 117 files, 904 tests, 242 integration tests ran, 0 skipped** |
| Server boot without `DATABASE_URL_APP` | ✓ refuses with the D-15.3-2 message |
| Server boot with it | ✓ `/v1/health` ok; `monitor=200 projects=200 search=200`; 0 deprecation warnings |

Decisive evidence (`.agents/qa/m15-signoff/15.3-rls-evidence.md`): as `420ai_app` with no org
context, `visible_events_with_no_context = 0`; as owner, `owner_visible_events = 413765`.

## What Went Well

- **The two-role suite paid for itself immediately.** Building `rls.int.test.ts` on a non-owner
  handle is what made the whole slice falsifiable; without it every assertion would have been
  theatre against a `rolbypassrls` role.
- **Negative tests were verified by actually breaking the policies**, both ways (dropped, and
  `USING (true)`), rather than assumed. That produced an honest, documented limit rather than a
  false claim of database-enforced isolation at the HTTP layer.
- **The rollback drill found two real bugs before merge** (default-ACL residue that `REVOKE`
  leaves behind; a cluster-wide role that a per-database migration cannot drop). Automating it
  in `rollback.int.test.ts` means it runs in CI instead of by hand.
- **`withOrg` stayed tiny.** One function, one `set_config`, a `Db`-not-`DbClient` parameter as
  the only guard the compiler can offer. Nothing else in the slice needed to know how RLS works.
- Splitting the wrapping (reads inside, `insertReportArtifact` outside) fell out of an existing
  constraint — the version-conflict retry — rather than being invented.

## Challenges Encountered

- **`ALTER ROLE … PASSWORD $1` is not parameterizable.** The plan asserted it was. It is a
  utility statement like `SET`, so it fails 42601 — the same trap as 15.0 Finding 4, one
  statement over, with the same tempting injection-shaped "fix".
- **Deleting the `Promise.all`s.** Wrapping reads in a transaction silently turned seven
  "parallel" queries into queued ones on a single connection, which node-postgres deprecates.
  Nothing failed; it only printed a warning that would become a breakage in pg@9.
- **A best-effort/swallow path hid a total functional loss.** See the divergence below — the
  alert-delivery bug produced no error, no log, and a 200 response.
- **Phantom test failures from Docker Postgres.** Up to 23 files failed with a *different* set
  each run while every file passed in isolation. The cause was I/O starvation, not code:
  `checkpoint complete: write=32.005 s, sync=67.281 s, sync files=83749`, and an explicit
  `CHECKPOINT` on the small test DB took 24.5 s. Statements stalled past vitest's 5 s/10 s
  timeouts and surfaced as bogus 401s and `Failed query: …` with **no matching ERROR in the
  Postgres log** — the giveaway that the failure was client-side. After `CHECKPOINT; VACUUM`,
  the same tree went 904/904 green with no code change. Roughly an hour was spent bisecting
  code that was never wrong.

## Divergences from Plan

**1. `ALTER ROLE … PASSWORD` cannot take a bind parameter**

- **Planned:** a GOTCHA note stating the password could be passed as `$1`.
- **Actual:** Postgres builds the statement — `SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', $1, $2)` — and we execute the returned text, with a scrubbed re-throw so a pg error cannot carry the secret.
- **Reason:** `ALTER ROLE` is a utility statement; `$1` is a syntax error (42601).
- **Type:** Plan assumption wrong.

**2. Deployment-wide ops needed explicit `orgId`, not just the policy**

- **Planned:** `repriceAll` / `reparseAll` / `rebuildSearchIndex` scoped purely by RLS inside a per-org loop.
- **Actual:** all three take `orgId` as their second parameter and filter explicitly; `indexSessions` takes it optionally; both CLIs loop per org.
- **Reason:** it violated the slice's own D-M15-3 "keep both layers" rule, and `reparse.int.test.ts` measured the consequence — every **owner-role** caller (all other int suites, plus `db:reprice`/`db:reparse`) bypasses RLS, so each per-org pass saw every org and the summed counts were N_orgs too large. `rebuildSearchIndex` was worse: an unqualified `DELETE` would have wiped every org's index on each pass.
- **Type:** Plan assumption wrong (and a correctness bug it would have shipped).

**3. The down migration must not `DROP ROLE`**

- **Planned:** revoke, then drop the role last.
- **Actual:** `DROP OWNED BY` (which also clears the `pg_default_acl` entry a mirror-image `REVOKE` leaves behind), and the role is deliberately left privilege-less.
- **Reason:** a role is **cluster-wide** while a migration is **per-database** — the same role is granted in `420ai` and `420ai_test`, so `DROP ROLE` from either fails on the other's grants, and if it ever succeeded it would break a different database's running server.
- **Type:** Plan assumption wrong (found by running the drill, not by reading).

**4. `Promise.all` → sequential awaits inside transactions**

- **Planned:** not addressed.
- **Actual:** `buildSnapshot` and 8 orchestrator read blocks now await in sequence.
- **Reason:** a transaction is one connection; node-postgres queues concurrent `client.query()` and deprecates it (removed in pg@9). The "parallel" form never overlapped.
- **Type:** Better approach found.

**5. Alert delivery had to own its RLS context internally** *(found by `/lril:code-review`, not the plan)*

- **Planned:** wrap route handlers in `withOrg`.
- **Actual:** `deliverPendingFirings` / `deliverResolvedFirings` take `Db` + `orgId` and open short `withOrg` transactions around each statement, with `deliver()` running between them.
- **Reason:** the naive application of the plan left both on the unwrapped `app.db`. `alert_firings` carries a strict policy, so under the app role they read **zero rows** — M12 12.6 / M13 13.5 webhook + SMTP delivery was completely dead, with no error, no log and a 200 response. Wrapping the *call site* instead would have held a pooled connection across a third-party network round-trip on every SSE tick, so the scoping belongs inside.
- **Type:** Security/correctness concern.

**6. Extra `0015_snapshot.json`**

- **Planned:** only the journal entry.
- **Actual:** also added the snapshot.
- **Reason:** keeps the `drizzle-kit generate` chain intact for the next migration.
- **Type:** Better approach found.

## Skipped Items

- **Collector round-trip (pair → watch → events in Monitor) and a desktop-app start from Settings.** Reason: the plan listed these as optional Level-4 manual checks; the equivalent paths are covered by `capture-engine.int.test.ts`, `push.int.test.ts` and the Rust `ingest_env` quartet tests, and the desktop change is a keychain field plus a form input.
- **Rollback drill "on a COPY of the real archive."** Reason: run against the test database instead and, better, *automated* in `rollback.int.test.ts` so it runs on every `--require-db` gate rather than once by hand.

## Recommendations

**Plan command**

- When a plan asserts a specific SQL statement is parameterizable, **cite it or mark it unverified**. Two of six divergences were confidently-worded SQL claims that fail at runtime (`ALTER ROLE … $1`, and the DROP-ROLE ordering). A plan's GOTCHA section reads as verified; these were not.
- When a plan introduces a defence, it should ask **"which existing call sites of the affected tables are NOT on the path being converted?"** The alert-delivery bug lived in a helper the plan never enumerated because it is not a route handler.

**Execute command**

- Add an explicit step: **before treating a red integration run as signal, confirm the infrastructure is healthy.** Concretely — if the failure set differs between runs and files pass in isolation, check the DB server's own log (here: checkpoint timings) rather than bisecting code. This cost about an hour.

**CLAUDE.md**

Added this slice (now a fourth corollary to `bypassed ≠ enforced`):

> **A per-FILE grep exempts the file, not the call site.** `org-scoping.test.ts` skips any route
> file containing `withOrg(` anywhere, so `monitor.ts` passed it while the delivery pass still
> ran unwrapped. A structural grep cannot decide whether an identifier is a `Tx` or a `Db` —
> pair it with a **behavioural test on the app role** that asserts the side effect happened.
> Corollary: **a best-effort/swallow path is the worst place to lose a policy** — it is
> designed not to complain.

Worth adding next (not yet written, pending a second sighting): the Docker-Postgres checkpoint
gotcha, currently captured in agent memory as `pg-checkpoint-phantom-test-failures`.
