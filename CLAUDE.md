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

## Module / TS / naming

- ESM, `"type": "module"`, `module`/`moduleResolution` NodeNext, `verbatimModuleSyntax`.
- Relative imports end in `.js`. Use `import type` for type-only imports.
- `kebab-case.ts` files, `PascalCase` types, `camelCase` functions, `snake_case` SQL columns.
- Strict mode across all four workspaces; the root `tsc -b` must stay at 0 errors.

## Invariants — do NOT change without a milestone-level decision

- **Event fingerprint** (`packages/shared/src/fingerprint.ts`) and the normalized **token/event
  shapes**. They are the load-bearing dedup/idempotency keys (PRD §12, §23). Reordering fields or
  changing the delimiter silently breaks dedup across parser versions.
- **"Raw records sacred / events disposable"** — raw payloads are immutable (insert-once); events are
  re-derivable and upsert by fingerprint.
- The M2 **ingest wire types** and server contract — the collector produces these shapes; M3+ feed
  them through the existing ingest client/API. No new server code or Postgres tables were added in M3.

## Logging / process boundaries

Library files **never** write to stdout/stderr or call `process.exit`. Only entrypoints
(`apps/collector/src/cli.ts`, `apps/ingest/src/server.ts`) log, read argv, handle signals, and exit.
Libraries throw typed errors (e.g. `NotPairedError`, `IngestHttpError`); the entrypoint catches and
prints. Daemons take an optional `logger` callback wired by the entrypoint.

## Local state

`~/.420ai/` is the collector home: `credentials.json` (M2 pairing) + `queue.sqlite` (M3 durable queue
+ per-file cursors). It lives outside the repo and is never committed (`*.sqlite` is gitignored).

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

A pre-commit hook (`.githooks/pre-commit`, enabled via `git config core.hooksPath .githooks`) runs
the fast subset (typecheck + NUL + artifact scans) automatically.

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

## Drizzle / SQL gotchas (M6–M7)

- In a raw `sql` template a column's **`mode:"string"` parser does NOT apply** — `max(ts)` / `min(ts)` /
  `date_trunc(...)` over a `mode:"string"` timestamptz come back as **strings**, not `Date`. Type the
  `sql<...>` result as `string` (this exact mismatch was the latent M5 `projectEventSummary.lastActivity`
  bug). node-postgres also returns `numeric` as a **string** (wrap in `Number(...)`) but `::int` as a JS
  number — cast token/count sums `::int`, money `::numeric` + `Number()`.
- **Inline closed-set SQL keywords** (e.g. `date_trunc` granularity `'day'|'week'`) as raw literals via
  `sql.raw` from a guarded union — **never as a bound parameter**. A bound param makes Postgres treat the
  SELECT and GROUP BY/ORDER BY expressions as distinct and reject the query
  (`column ... must appear in the GROUP BY clause`).
- A `GROUP BY <col>` over the full event stream collapses rows with a NULL `<col>` into a phantom group;
  restrict the WHERE to the relevant `event_type`s when a null-keyed all-zero row would be noise (e.g.
  `usageByModel` filters to `usage.reported`/`cost.estimated`).
- **A guard sufficient for a READ is insufficient for a WRITE that adds an FK.** The M6 projection reads
  return 200-zeros for an unknown project uuid (`isUuid → 404` only screens *malformed* ids, never
  inserts). An M7-style *write* whose row carries a FK (`report_artifacts.project_id → projects.id`)
  turns a well-formed-but-nonexistent id into an **FK-violation 500** at insert. Guard write paths with an
  **existence check** (e.g. `getProjectName(id)` undefined → 404), not just `isUuid`, to preserve the
  repo-wide "unknown id → 404, never a DB-constraint/cast 500" invariant.
