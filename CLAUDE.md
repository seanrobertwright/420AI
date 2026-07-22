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
- **A guard sufficient for a READ is insufficient for a WRITE that adds an FK.** The M6 projection reads
  return 200-zeros for an unknown project uuid (`isUuid → 404` only screens _malformed_ ids, never
  inserts). An M7-style _write_ whose row carries a FK (`report_artifacts.project_id → projects.id`)
  turns a well-formed-but-nonexistent id into an **FK-violation 500** at insert. Guard write paths with an
  **existence check** (e.g. `getProjectName(id)` undefined → 404), not just `isUuid`, to preserve the
  repo-wide "unknown id → 404, never a DB-constraint/cast 500" invariant.
