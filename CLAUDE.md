# 420AI — Project Conventions

Single source of truth for how this repo is built. Plans should **link here, not re-paste**
conventions. Background: `SUMMARY.md` (build loop + decisions), `docs/PRD.md`, `docs/CONTEXT.md`
(domain glossary — name code after these terms), `.agents/plans/` (per-milestone plans),
`.agents/system-reviews/` (process retrospectives).

## Workspaces

npm workspaces, all strict TS, Node ≥ 24:

- `packages/shared` — token shape, event taxonomy, fingerprint, pricing, cost, ingest wire types
- `packages/db` — Drizzle Postgres schema + migrations, AES-256-GCM field encryption, repositories
- `apps/ingest` — Fastify Ingest API (pairing, bearer-authed idempotent ingest, health)
- `apps/collector` — headless capture agent (parser, durable queue, watcher, sync, CLI)
- `apps/dashboard` — Next.js + shadcn/theGridCN frontend (M9 Live Monitor). **Out of the root
  `tsc -b` graph** — see "Frontend workspace" below.

## Module / TS / naming

- ESM, `"type": "module"`, `module`/`moduleResolution` NodeNext, `verbatimModuleSyntax`.
- Relative imports end in `.js`. Use `import type` for type-only imports.
- `kebab-case.ts` files, `PascalCase` types, `camelCase` functions, `snake_case` SQL columns.
- Strict mode across all workspaces; the **four backend** workspaces' root `tsc -b` must stay at 0
  errors (the dashboard typechecks via its own enforced lane — see "Frontend workspace").

## Invariants — do NOT change without a milestone-level decision

- **Event fingerprint** (`packages/shared/src/fingerprint.ts`) and the normalized **token/event
  shapes**. They are the load-bearing dedup/idempotency keys (PRD §12, §23). Reordering fields or
  changing the delimiter silently breaks dedup across parser versions.
- **"Raw records sacred / events disposable"** — raw payloads are immutable (insert-once); events are
  re-derivable and upsert by fingerprint.
- **What may become a COLUMN on `events`** (M15 15.1, D-M15-2): a column belongs on `events` if it is
  **fixed at capture time and never re-derived**. `org_id` passes (whose data it is, fixed by which
  machine uploaded it) and is therefore a column as of M15 15.1. `project_id` fails (attribution
  changes when a workspace is remapped) and stays a JOIN. The **fingerprint is unchanged** — `org_id`
  is never a fingerprint input, the primary key is still `fingerprint` alone, and a re-ingest never
  overwrites an existing row's `org_id` — it is deliberately absent from the ingest upsert's
  `set:` block, so a converging cross-org ingest cannot flip a row's owner (pinned by
  `packages/db/src/repositories/tenancy.int.test.ts`).
- The M2 **ingest wire types** and server contract — the collector produces these shapes; M3+ feed
  them through the existing ingest client/API. No new server code or Postgres tables were added in M3.

## Frontend workspace (`apps/dashboard`)

A frontend stays **out of the root `tsc -b` graph** — it needs `moduleResolution: bundler` + `jsx`,
incompatible with the root NodeNext/composite graph, so its `tsconfig.json` is **not referenced** by
the root `tsconfig.json` (mirrors how `*.int.test.ts` are excluded). Consequence: **root `tsc -b` will
NEVER catch dashboard type errors.** It therefore gets its own **enforced** lanes, wired into the gate
(not just a convention): `typecheck:dashboard` (`tsc --noEmit`) runs inside `repo-health`, and
`build:dashboard` (`next build`, which also catches theGridCN barrel breakage) gates milestone sign-off.

- **In automated execution, hand-write shadcn primitives** (`card`/`table`/`badge`/`cn`/`globals.css`)
  rather than running `npx shadcn init` — the CLI mutates `tsconfig`/`globals.css`/`components.json` and
  can prompt. Reserve the CLI for **registry-only** components (e.g. `@thegridcn/data-card`), and
  **build-verify every add** (the `@thegridcn/hud` barrel ships broken — missing siblings).
- **The browser never holds `ADMIN_TOKEN`.** It talks to ingest only through same-origin **proxy Route
  Handlers** that read `ADMIN_TOKEN`/`INGEST_URL` from server env and add the bearer on the
  server→ingest hop. Never expose the token via a `NEXT_PUBLIC_*` var (assert: 0 occurrences in served
  HTML). `next dev`/`next build` load env from the **dashboard CWD**, not the repo root — pass
  `ADMIN_TOKEN`/`INGEST_URL` inline (or via `apps/dashboard/.env.local`) when running it standalone.
- **For any long-lived resource** (SSE stream, `setInterval`, listener, upstream `fetch`): arm its
  teardown BEFORE the first `await` (a disconnect during the initial await fires `close` before a
  later-attached listener exists → leaked timer), and pass `request.signal` to proxy `fetch` so the
  upstream hop cancels with the client. `tsc`+tests do not catch these leak windows — `/lril:code-review`
  does (it found exactly this class in M9).

## Logging / process boundaries

Library files **never** write to stdout/stderr or call `process.exit`. Only entrypoints
(`apps/collector/src/cli.ts`, `apps/ingest/src/server.ts`) log, read argv, handle signals, and exit.
Libraries throw typed errors (e.g. `NotPairedError`, `IngestHttpError`); the entrypoint catches and
prints. Daemons take an optional `logger` callback wired by the entrypoint.

## Collector outbound HTTP (UAT C.6/C.8)

Every outbound `fetch` in the collector MUST be **timeout-bounded AND abort-cancellable** — both, not
either. An unbounded `fetch` is a latent SIGINT-shutdown hang: on Ctrl-C the capture engine awaits its
in-flight sync POST (`Promise.allSettled` over the watcher/sync/git loops), and a stalled/half-open
archive connection never resolves nor cancels, so shutdown hangs **before** the bounded drain
(`SHUTDOWN_DRAIN_MS`) can ever apply — the drain deadline is checked only _between_ `syncOnce` calls,
never _inside_ a stuck one (C.8). Use `ingest-client.ts` `requestSignal({ signal, timeoutMs })` for
every request: it `AbortSignal.any`s a default 30 s timeout with the daemon's abort signal, so a
stall self-cancels AND SIGINT cancels the in-flight hop instantly. Thread the engine's abort signal
through `syncOnce`/`runSyncLoop` (never let the sync loop hold an un-cancellable request), and bound
the shutdown drain's own call with `timeoutMs: SHUTDOWN_DRAIN_MS`. This is the same long-lived-resource
discipline the dashboard proxy rule states — the collector is a daemon, so it applies here too.

**Never POST one mega-body.** Chunk large request bodies (`chunkCommitsBySize` for `collector git`;
batched `claimBatch` for ingest) so no single body exceeds the ingest server's **16 MiB `bodyLimit`**
(`apps/ingest/src/app.ts`). One unchunked body over the limit is rejected mid-stream and surfaces to
the client as an opaque `ECONNRESET` _with the server still up_ (C.6) — not a clean 413. Endpoints that
dedup server-side (`/v1/git` by SHA, `/v1/ingest` by fingerprint) make chunking exact: sum the
per-chunk inserted counts.

## Local state

`~/.420ai/` is the collector home: `credentials.json` (M2 pairing) + `queue.sqlite` (M3 durable queue

- per-file cursors). It lives outside the repo and is never committed (`*.sqlite` is gitignored).

The home is **`homedir()`-derived** (`CREDENTIALS_PATH`/`QUEUE_PATH` in `identity.ts`), and the
connectors glob sessions under `homedir()` too (`~/.claude`, `~/.codex`, `~/.gemini`). The `--home <dir>`
flag (on `watch`/`sync`/`discover`/`git`/`queue`/`pair`) repoints **all three together** via
`credentialsPathFor`/`queuePathFor`/connector-home — it is **comprehensive on purpose**: a flag that
moved only the connector home but not creds+queue is a footgun (looks paired, captures nothing). The
load-bearing use is a **Windows service**: under LocalSystem `homedir()` is `…\config\systemprofile`,
not the user profile, so the service runs `watch --home C:\Users\<you>`. Service install via WinSW lives
in `apps/collector/service/` (`.xml` + README; the WinSW exe is third-party, not committed). Only **one**
collector may own a given `queue.sqlite` — a service AND the desktop "Run on login" is a double-writer
bug. `QueueStore` `mkdir`s its parent (node:sqlite won't), so a fresh `--home` works before pairing.

## Testing

- Co-located vitest: `*.test.ts` (no infra — always run) beside the code.
- Integration: `*.int.test.ts` with `describe.skipIf(!process.env.DATABASE_URL_TEST)` so `npm test`
  passes with no Docker; they reuse the real server in-process (`buildApp`).
- `*.int.test.ts` import across app boundaries, so they are **excluded from `tsc -b`** (see
  `apps/collector/tsconfig.json`) and are type-stripped by vitest/esbuild instead.
- Inject clocks/dependencies for determinism (e.g. `QueueStore(path, now)`, `syncOnce({ post })`).
- **Workspaces have NO per-workspace `test` script** — only the root defines `test` (`vitest run`). For
  a focused run use `npx vitest run <path>` from the repo root; `npm test -w <pkg>` fails with
  `Missing script: "test"`.

## Validation is a GATE, not a list

Before any commit, `npm run repo-health` must pass. It is the enforced gate and runs:

1. **Root `tsc -b`** (`npm run typecheck`) — must exit 0. Per-workspace `build` is NOT a substitute;
   it misses cross-project/test-only imports (this is how a broken typecheck shipped through M2).
   **A clean INCREMENTAL `tsc -b` can be a false green** (M16): `tsc -b` trusts `.tsbuildinfo`, so
   after a run that reported errors it can skip a project whose inputs it believes unchanged and
   exit 0 over genuinely broken source — `routes/monitor.ts` referenced a deleted local (TS18004)
   through a passing `npm run typecheck`, and an integration test, not the compiler, caught the 500.
   Treat a clean incremental build as untrustworthy immediately after any failing run and re-run
   with `tsc -b --force`. This is the third member of the "`tsc` is a FILE-level checklist, not a
   CALL-SITE one" family (15.2's deleted-import, 15.2's arity change), and it undermines this gate
   item directly rather than merely narrowing it.
2. **Full `vitest run`** — units always; integration self-skips without `DATABASE_URL_TEST`.
3. **NUL-byte scan** of tracked text sources — a source file written with embedded NULs passes
   typecheck + tests (the compiler tolerates NULs in comments) yet is corrupt; this catches it.
4. **Stray-artifact scan** — no emitted `*.js`/`*.d.ts`/`*.map` under any `src/`, no `dist/` or
   `*.sqlite` staged.
5. **SUMMARY consistency** (`scripts/check-summary.mjs`) — every shipped slice (one with a
   `.agents/execution-reports/m<M>-slice<S>-*.md`) must be marked done in `SUMMARY.md` with a ✅
   next to its `**<slice>**` token, UNLESS its milestone is declared `is **DONE**` (milestone-level
   done subsumes per-slice marks). Pure/fast, so it runs in `--fast` too.

A pre-commit hook (`.githooks/pre-commit`, enabled via `git config core.hooksPath .githooks`) runs
the fast subset (typecheck + NUL + artifact + SUMMARY scans) automatically.

**SUMMARY.md is a rebuildable projection, not a free-text log — keep it in sync as a build-loop
step, not an afterthought.** It drifted once (M14 slices 14.2–14.4 shipped with execution reports +
merged PRs while SUMMARY still showed them un-done and the milestone "IN PROGRESS") precisely because
updating it was discretionary — done when someone remembered to narrate a slice, skipped for the
"un-narratable" mechanical ones. So: **when you write a slice's `/lril:execution-report` (or at the
latest, its `/lril:commit`), update `SUMMARY.md` in the SAME commit** — flip the slice to `✅` with a
one-line "DONE `<date>` (PR #NN)" note in both the §0 status block and the §6 roadmap, and adjust the
milestone status line if it was the last open slice. Check 5 above is the backstop that FAILS the
gate when this is forgotten (the honor-system version is what let it rot).

**Integration tests self-skip without `DATABASE_URL_TEST` (which lives in gitignored `.env`), and a
skipped layer still reports green — `skipped ≠ passed`.** A plain `repo-health` PASS does NOT prove the
DB-backed layer ran. Before signing off ANY milestone that touches `@420ai/db` or `apps/ingest`, run
`npm run db:up && npm run db:migrate` and then **`npm run repo-health -- --require-db`**, which FAILS if
`DATABASE_URL_TEST` is unconfigured or if any `*.int.test.ts` self-skipped (it asserts the int tests
actually ran, 0 skipped). This is the gap that hid the M5 `lastActivity` type bug through M5 sign-off —
the int test asserting it could never have passed against a real DB, so the layer was never exercised.

**A single-role integration suite proves nothing about isolation — `bypassed ≠ enforced` is the
sibling of `skipped ≠ passed`** (M15 15.3). Postgres RLS is INERT against a superuser or any role with
`rolbypassrls`, and `DATABASE_URL_TEST` is exactly that (it owns the tables). An owner-only suite
therefore reports green while enforcing **nothing** — the same shape as a skipped layer, one level
deeper. So **any slice that touches tenancy MUST carry a TWO-ROLE suite**: the owner handle for setup
only (`TRUNCATE` requires ownership), a non-owner handle (`DATABASE_URL_TEST_APP` → `420ai_app`) for
every assertion, and a **role-identity assertion as the suite's first test**
(`current_setting('is_superuser') = 'off'` AND `rolbypassrls = false`). Without that first test the
whole file is theatre: point the "app" handle at the owner URL by mistake and every isolation test
still passes. `repo-health --require-db` now checks the same thing before it runs vitest, and it is
deliberately out of `--fast` (it needs a live DB).

Four corollaries the 15.3 conversion measured rather than assumed:

- **Verify a negative test FAILS with the policy removed** — and remove it the RIGHT way. Dropping a
  policy while RLS stays ENABLED makes Postgres deny _everything_, so tests fail for the wrong
  reason. Replace it with `USING (true)` to simulate the actual leak.
- Under that real simulation, **9 of 10 HTTP-level tests still passed**, because 15.2's explicit
  `orgId` predicates scope those reads on their own. That is the layering working as designed — but
  it means an endpoint-level suite validates the PRIMARY defence, not the backstop. Put the backstop
  proof in a repository-level two-role suite, where dropping one policy fails most of the file.
- **A per-FILE grep exempts the file, not the call site** — the same shape as the `tsc` lesson above,
  now proven twice. 15.3's `org-scoping.test.ts` skips any route file containing `withOrg(`
  anywhere, so `monitor.ts` passed it while `deliverPendingFirings`/`deliverResolvedFirings` still
  ran on the unwrapped `app.db`. Under the app role that read `alert_firings` (a strict-policy
  table) as ZERO rows: outbound alert delivery was **completely dead**, with no error, no log and a
  200 response — and every existing delivery test stayed green because they all build on the owner
  handle. A structural grep cannot decide whether an identifier is a `Tx` or a `Db`; **pair it with
  a BEHAVIOURAL test on the app role** that asserts the side effect actually happened
  (`delivered.length > 0`), which is what caught this. Corollary of the corollary: **a
  best-effort/swallow path is the worst place to lose a policy** — it is designed not to complain.
- **A grep that exempts a whole FILE is not a call-site check** — the same shape as the `tsc`
  file-level lesson above, one layer up. `org-scoping.test.ts` skips any file containing `withOrg(`
  anywhere, so `monitor.ts` passed while its alert-DELIVERY pass still ran on the unwrapped
  `app.db`: under a strict policy that reads **zero rows silently**, so every webhook and email
  stopped going out while the UI still showed the alert and every owner-connected test stayed green.
  Source text cannot tell a `Tx` from a `Db`, so do not try to make the regex exact — pair it with a
  **behavioural** test on the non-owner role (`rls.int.test.ts` asserts a firing is actually
  delivered and stamped). Corollary of the corollary: **an org-scoped read reached through a
  best-effort `try/catch` is the worst case** — RLS filters rather than errors, so there is nothing
  for the catch to swallow and nothing to log. Audit those paths first.

**A backstop that cannot be LOUD is not a substitute for a complete gate** (M15 15.4). A RESTRICTIVE
RLS policy blocks INSERT and UPDATE loudly (`WITH CHECK` → `new row violates row-level security
policy`) but filters DELETE **silently** — Postgres has no `WITH CHECK` for DELETE, so a blocked
delete is an unavoidable `DELETE 0` with no error, no log and a 200 response. Do not try to make it
loud; there is no mechanism. Instead make the ROUTE gate complete and **assert the silence
explicitly in a test**, so nobody later "fixes" it into an expectation the database cannot meet.
Three further 15.4 findings, each measured rather than assumed:

- **A `pg_policies` assertion keyed on `tablename` alone silently collapses.** `new Map(rows.map(r
=> [r.tablename, r.qual]))` kept reading `size === 15` after 39 policies were added, with `qual`
  becoming whichever row came last — green, and meaningless. Re-key on `(tablename, policyname)`;
  do **not** merely bump the expected number.
- **Evaluate-on-read means a GET performs a WRITE, so a read gate is not enough.** `GET /v1/monitor`
  reconciles alert firings. Wrapping it in `withOrg(..., principal.role, ...)` made it **500 for
  every viewer**. A write that is the ORG's bookkeeping — the reconcile, the alert-delivery stamp —
  must run under `SERVICE_ROLE`, not the role of whoever happened to open the page. Ask "whose
  action is this?", not "who triggered it?".
- **`setUserPassword` auto-creates a personal `owner` membership** (via `ensurePersonalOrg`), and
  `findPrincipalByEmail` resolves the FIRST membership by `(created_at, id)`. So seeding a
  second-rung user by INSERTing a membership is silently shadowed and every role assertion tests an
  owner. **Move** the existing membership instead. A multi-user fixture that has never existed
  before is exactly where this class of seeding bug hides.

**A shared transaction is ATOMICITY, not isolation** (M15 15.5). A read-then-write guard is still
racy inside one transaction, because `SELECT count(*)` takes **no locks** — under READ COMMITTED two
concurrent callers both see the pre-state and both proceed. 15.5's last-owner guard shipped with a
header comment asserting that sharing a transaction prevented exactly the race it described; it did
not, and the comment was the real defect, because the next reader trusts it instead of re-deriving
it. Lock the rows the decision depends on (`SELECT … FOR UPDATE`, hence rows-then-`length` — Postgres
cannot apply `FOR UPDATE` to an aggregate): a blocked transaction re-evaluates the predicate after
the lock releases (EvalPlanQual), so a row the winner mutated drops out of the loser's result set and
the guard correctly refuses. No SERIALIZABLE and no retry loop needed. **Name the mechanism in the
comment** — a lock, a unique index, or an isolation level. "It's in a transaction" almost never is.

Corollary about TESTING such a fix, which cost more than the fix: **a concurrency test at the wrong
LAYER cannot fail.** The first regression test for the above drove two concurrent HTTP requests and
passed identically with and without the lock, because requests serialise on their own at that
granularity — a green test advertising a guarantee nobody had checked. Only a repository-level test
with two hand-held transactions, asserting the second is _still unsettled_ after a wait,
discriminates. And **any test that holds a transaction open must release it in a `finally`**: when
that assertion first failed it skipped the release, the held transaction kept its pooled connection,
and five later tests in the file timed out at 10 s — one real failure wearing five fake ones.

**An authorization ladder needs a CEILING AND A FLOOR** (M15 15.5). Gating on the _requested_ rung
answers "may I grant this?" and leaves "may I act on this person?" unasked. 15.5 shipped
`hasRole(principal.role, requestedRole)` on the member routes — faithful to its own decision, which
was worded purely about granting — and an `admin` could therefore demote an `owner` to `viewer`
(**200**) and `DELETE` an owner outright (**204**), because the requested rung was below the actor's
own and the delete path compared no roles at all. The last-owner guard bounded the damage to "never
zero owners", which is a **different and much weaker promise** that evaporates once a second owner
exists. So any route mutating another principal's standing needs BOTH checks, and the DELETE variant
needs the second one most precisely because it has no "requested role" to accidentally constrain it.
Allow EQUAL rank (`hasRole` is `>=`), or a co-owner becomes unremovable.

**`.env.example` ships keys with EMPTY values, so a documented env fallback MUST use `||`, never
`??`** (M15 15.5). `??` only falls through on null/undefined, so `SMTP_URL=` (empty, as shipped)
makes `process.env.SMTP_URL ?? process.env.ALERT_SMTP_URL` evaluate to `""` — and the fallback
silently fails for exactly the upgrading operator it was written for, who pastes the new block and
gets a disabled mailer that looks like a deliberate opt-out. `server.ts` already carried this rule
for `RATE_LIMIT_WINDOW`/`ANALYSIS_BASE_URL`; copy env idioms from the file you are editing rather
than from memory.

## Tooling gotchas (Windows)

- The **Bash tool is Git Bash (POSIX sh)**. For multi-line commit messages / PR bodies use a
  heredoc (`<<'EOF' ... EOF`), **not** PowerShell here-strings (`@'...'@`) — the latter injects
  literal `@` characters into the text. A quoted heredoc also eats `\\`; for content with regex
  backslashes, write the file with the Write/Edit tool instead of `cat`.
- An **auto-push** may carry a commit to `origin` before you push manually. If you then amend, expect
  a non-fast-forward; resolve with `git push --force-with-lease` guarded on the expected sha (only
  ever on your own unmerged feature branch).
- `node:sqlite` is experimental in Node 24 and prints an `ExperimentalWarning` on import **by
  design** — do not suppress it in a way that breaks tests.
- The gstack **`browse`/`agent-browser` daemon is unreliable here** (`EEXIST .gstack`, start-timeout).
  For screenshot evidence use **headless Edge** directly:
  `"$EDGE" --headless=new --disable-gpu --hide-scrollbars --screenshot="<abs>.png" <url>`
  (`$EDGE = /c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`). Pair it with HTTP-layer
  assertions (rendered HTML contains the expected data; `grep -c "$ADMIN_TOKEN"` on page source == 0).

## Drizzle / SQL gotchas (M6–M9)

- In a raw `sql` template a column's **`mode:"string"` parser does NOT apply** — `max(ts)` / `min(ts)` /
  `date_trunc(...)` over a `mode:"string"` timestamptz come back as **Postgres text**
  (`2026-06-14 11:59:00+00`), NOT ISO and NOT `Date`. Type the `sql<...>` result as `string` AND
  normalize through `new Date(v).toISOString()` if the wire contract is ISO. This shipped as the latent
  M5 `projectEventSummary.lastActivity` bug and **recurred in M9 `activeSessions`** — so **when writing
  illustrative aggregate SQL in a PLAN, always show the normalization; never write "already ISO — do not
  re-coerce" for an aggregate.** node-postgres also returns `numeric` as a **string** (wrap in
  `Number(...)`) but `::int` as a JS number — cast token/count sums `::int`, money `::numeric` + `Number()`.
- **Inline closed-set SQL keywords** (e.g. `date_trunc` granularity `'day'|'week'`) as raw literals via
  `sql.raw` from a guarded union — **never as a bound parameter**. A bound param makes Postgres treat the
  SELECT and GROUP BY/ORDER BY expressions as distinct and reject the query
  (`column ... must appear in the GROUP BY clause`).
- A `GROUP BY <col>` over the full event stream collapses rows with a NULL `<col>` into a phantom group;
  restrict the WHERE to the relevant `event_type`s when a null-keyed all-zero row would be noise (e.g.
  `usageByModel` filters to `usage.reported`/`cost.estimated`).
- **A partial unique index over a NULLABLE column constrains NOTHING for the NULL rows** (M16 16.7).
  `NULL <> NULL` under a unique index, so `unique (org_id, alert_key)` places no constraint at all on
  rows whose `org_id` is NULL — measured against real Postgres, not assumed: a second NULL-org row
  for the same key inserted cleanly. This is worst precisely when NULL is meaningful (16.7 uses
  `org_id IS NULL` for "belongs to the deployment, not a tenant"), because the index then looks like
  it covers the case it is silently ignoring: a single composite index would have "fixed" a
  one-row-per-org fan-out by permitting **unlimited** duplicates instead. Use **two** partial indexes
  that PARTITION rather than overlap — the org one carrying an explicit `AND org_id IS NOT NULL`.
  Corollary, also measured: **crossing the two arbiters in `ON CONFLICT` is LOUD.** Postgres
  suppresses conflicts only on the INFERRED arbiter index, so using the org arbiter against a global
  row raises `duplicate key value violates unique constraint "…_global_key"` rather than silently
  inserting a duplicate. That makes the split DB-enforced — but only while the two upserts remain two
  separate statements, so never merge them into one "clever" one with a computed target.
- **An aggregate over a tenancy/ownership column is a SMELL** (M15 15.1). `min(org_id)` in a query
  whose `GROUP BY` does not include `org_id` collapses two tenants into one row and silently picks a
  winner. In 15.1 this shipped into `indexSessions` — grouping by `session_id` alone (a
  connector-supplied, globally-scoped string two tenants can share) produced ONE search document
  owned by `min(org_id)` whose body concatenated **both** orgs' decrypted content. If a column is an
  ownership key it belongs in the `GROUP BY`, never in an aggregate. Corollary: **when you re-scope a
  unique index from `(X)` to `(org_id, X)`, audit every `GROUP BY X` and `WHERE X` on the WRITE path
  too** — those are precisely the places that assumed `X` was globally unique, and the index change
  alone does not fix them (the schema then permits two rows the builder can never emit).
- **A read keyed by a CONNECTOR-SUPPLIED string MUST take `orgId`** (M15 15.2). `session_id`,
  `project_path` and `fingerprint` are globally scoped — two tenants can hold the same value — so a
  query keyed on one merges tenants unless it also filters `eq(events.orgId, orgId)`. This was not
  theoretical: `sessionDetail` returned a single merged projection for two orgs sharing a session id,
  and the `events.project_path = workspace_keys.project_key` join in the M5/M6/M13 rollups merged two
  orgs' events, tokens and cost into whichever org owned the `projects` row. **`orgId` is always the
  SECOND parameter**, right after `db`, so a transposed argument between two adjacent `string` params
  is visible in review. Two corollaries the 15.2 conversion proved the hard way:
  - **The org predicate on the FACT table gives isolation, not ownership.** `eq(events.orgId, orgId)`
    stops org A seeing org B's events, but org B querying org A's `projectId` still gets a non-empty
    rollup of _its own_ events attributed to a project it does not own. You need
    `eq(workspaceKeys.orgId, orgId)` on the JOIN as well — and any read/write keyed by an org-owned
    uuid (`getProjectName`, `renameProject`, `archiveProject`) needs its own org predicate, or one
    tenant can rename another's project.
  - **"Replace `getOrgIdForUser` with `principal.orgId`" is only valid when the row belongs to the
    CALLER.** `createPairingCode` writes a row for a TARGET user who may not be the caller
    (`POST /v1/pairing-codes` accepts `body.email`), so it must keep resolving the org from that
    user — stamping the caller's org there would create exactly the cross-org row the schema exists
    to prevent. Both are `string`; the compiler cannot see the difference.
- **Deleting an auth helper makes `tsc` a FILE-level checklist, not a CALL-SITE one** (M15 15.2).
  Removing `adminAuthorized` was expected to raise ~45 errors (one per gate); it raised **16** — one
  per file, on the failed named `import`. TypeScript binds a failed import as an error type and stops
  re-reporting at each usage. So `tsc -b` exiting 0 does NOT prove every call site was converted; pair
  it with a `grep -rn "<deleted symbol>" apps/*/src packages/*/src` assertion.
- **Repository functions whose rows reach `reply.send()` MUST use explicit column lists** (M15 15.1).
  No `apps/ingest` route declares a Fastify `response` schema, so nothing strips extra properties: a
  bare `select()` / `returning()` turns every future column into an unannounced API addition. Adding
  `org_id` silently put it on the wire in six endpoints. Use a `const <name>RowColumns = {...}`
  constant that mirrors the exported `*Row` interface (see `projects.ts`, `workspaces.ts`,
  `reports.ts`) — it also stops the interface from lying about the runtime shape.
- **A table whose WRITERS STRADDLE the org-context boundary cannot use the strict policy** (M15 15.10).
  `audit_events` is appended to from two kinds of call site: `withOrg`-wrapped routes (`members.ts`,
  `org.ts`) and the ALLOW-LISTED identity routes that run with **no** org context at all
  (`api-keys.ts`, `auth.ts`, `sso.ts` — they read the row that ESTABLISHES the context). A strict
  `org_id = current_setting(...)` policy REJECTS the insert from the unwrapped half outright —
  measured as a negative control, not assumed: it raised `new row violates row-level security policy`,
  which would have made every `api_key.minted` audit a 500 surfacing much later as "minting is
  broken". The 15.4 RESTRICTIVE role policies are equally unusable, because a `viewer` is explicitly
  permitted to revoke their own key and that must produce a row rather than a 500. The answer is a
  **fifth classification** (`APPEND_ONLY_TABLES`, beside STRICT / BOOTSTRAP / ROLE-GATED-BOOTSTRAP
  / NO_RLS): RLS enabled, exactly one `PERMISSIVE ... FOR INSERT WITH CHECK (true)`
  policy, and no `SELECT`/`UPDATE`/`DELETE` policy — default-deny does the rest, so the app **appends
  always and reads zero rows even WITH a matching org context** (it is the ABSENT SELECT policy, not
  a failing predicate, which is what makes "write-only" a database guarantee). Three corollaries:
  - **`REVOKE UPDATE, DELETE` is what makes tampering LOUD.** With the grant intact, a blocked
    `UPDATE`/`DELETE` is a silent 0-row no-op — safe, undiagnosable. Both were measured; only one is
    debuggable. Same shape as 15.4's "a backstop that cannot be loud is not a complete gate".
  - **Omit `FORCE ROW LEVEL SECURITY` when the table's only reader is break-glass**, against the
    17 tenant tables that set it (13 strict + 3 bootstrap + `invites`). FORCE removes the
    table-OWNER exemption, and the owner IS the D-M15-7 reader.
    Assert `relforcerowsecurity = false` explicitly so nobody "completes the pattern" later.
  - **Denormalize the actor/target email onto an audit row**, against the repo's normalized habit,
    and the second reason is decisive: the only reader runs one `select *` under `psql`, and for
    `member.invited` there is **no target user id at all** — an invited address has no `users` row
    yet, so a normalized-only design cannot record the most common audited action. `metadata` carries
    the shape of a change and never a token, hash or password: the one table the app cannot DELETE
    from is the worst place to put a second copy of a secret.
- **A guard sufficient for a READ is insufficient for a WRITE that adds an FK.** The M6 projection reads
  return 200-zeros for an unknown project uuid (`isUuid → 404` only screens _malformed_ ids, never
  inserts). An M7-style _write_ whose row carries a FK (`report_artifacts.project_id → projects.id`)
  turns a well-formed-but-nonexistent id into an **FK-violation 500** at insert. Guard write paths with an
  **existence check** (e.g. `getProjectName(id)` undefined → 404), not just `isUuid`, to preserve the
  repo-wide "unknown id → 404, never a DB-constraint/cast 500" invariant.
