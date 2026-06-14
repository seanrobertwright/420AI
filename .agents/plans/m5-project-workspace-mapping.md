# Feature: Milestone 5 — Project / Workspace Mapping (repo discovery, project creation, attribution resolver)

The following plan should be complete, but it is important that you **validate documentation and
codebase patterns and task sanity before you start implementing**. Pay special attention to naming of
existing utils, types, and models — import from the right files (`@420ai/shared`, `@420ai/db`, `.js`
relative specifiers, `import type` for type-only imports). Conventions live in
[`CLAUDE.md`](../../CLAUDE.md) and [`SUMMARY.md`](../../SUMMARY.md) — **read them, do not re-paste them
here.** This plan links to the source of truth rather than duplicating it.

> **Branch:** all M5 work lands on `m5-project-mapping` (already created off `m4-connectors`). M4 is not
> yet merged to `main`, so M5 stacks on it — this is intentional (M5 attributes the events M4's three
> connectors produce).

> **PRE-FLIGHT recon is done and baked into this plan.** The Gemini reverse-mapping mechanism, the git
> metadata format, and the connector store shapes below were verified against REAL on-disk files on this
> machine during planning. Each grounded fact is marked **[VERIFIED]** with the evidence that proved it.
> If a fixture you build contradicts a **[VERIFIED]** assertion, the fixture is wrong — fix the fixture.

---

## Feature Description

After M4, all three required connectors (Claude Code, Codex CLI, Gemini CLI) capture full-fidelity
events into the Central Archive. Every event already carries a `project_path` (plaintext, queryable —
the schema comment says it is "needed for project attribution in M5") and a `git_branch`. But there is
**no notion of a Project or a Workspace yet** — the archive holds a flat stream of events tagged with
raw path strings, and those strings are inconsistent across connectors:

- **Claude Code / Codex CLI** stamp the **real working directory** (`cwd`, e.g.
  `C:\Users\seanr\...\420AI`) on each event's `project_path`.
- **Gemini CLI** stamps an **opaque `projectHash`** (e.g. `2025fdb554a6…`) — the M4 connector left a
  `knownGap`: *"projectHash is a hash, not a path (M5 maps it)."* Without reverse-mapping, every Gemini
  session is unattributable.

M5 gives this stream **structure and resolution**, headless (no dashboard — see Scope Decision):

1. **Data model** — `projects` + `workspaces` (+ a `workspace_keys` alias table) in the archive
   (`@420ai/db`), with cross-machine project identity via git remote.
2. **Repo discovery (collector)** — each connector enumerates the distinct project roots in its on-disk
   store; the collector enriches each real root with git remote/branch (parsing `.git/config` +
   `.git/HEAD`, no `git` subprocess) and builds the Gemini `projectHash → realPath` map from
   `.project_root` sidecars; it POSTs these hints to the archive.
3. **Project creation + mapping** — the discover endpoint upserts workspaces and **auto-creates one
   project per workspace** (the user's one-repo-one-project default), unifying across machines by git
   remote. An admin can rename a project, create projects, and remap a workspace to a different project.
4. **Attribution resolver** — `resolveWorkspaceId(db, userId, projectKey)` and a per-project events
   query that joins `events.project_path → workspace_keys.project_key → workspaces.project_id`. This is
   the building block M6 ("event projections") materializes; M5 ships the resolver + a thin summary
   endpoint/CLI to prove the wiring end-to-end.

This implements PRD §6 (Project / Workspace / Project Mapping concepts), §11.2 (scoped capture — derive
candidates from where AI work actually happened, do not walk all of disk), §19 steps 7–8 (discover
repositories/workspaces → map to projects), and SUMMARY §3 milestone 5.

### Scope Decision (confirmed with the user during planning)

- **Headless M5.** There is no dashboard app today (`apps/` is only `collector` + `ingest`); M1–M4 are
  all headless Node/TS by deliberate design. M5 delivers the data model + discovery + mapping +
  resolver behind **Ingest API endpoints + collector CLI commands**. The graphical "mapping UI" named in
  PRD §25.5 is **deferred to a dedicated dashboard milestone** that consumes this exact API. No
  `apps/web`. Building the UI later is purely additive — the API is the contract, nothing is thrown away.
- **One project per repo, auto-created, editable.** The user's workflow is one-repo-one-project, so
  discovery auto-creates a project per discovered workspace (named from the git-remote repo name, else
  the folder basename) and the user can rename/remap afterward. Cross-machine unification is by git
  remote (same remote → same project).
- **Gemini reverse-mapping via `.project_root` sidecar** (NOT hash-cracking — see Key Design D3).

### Explicitly deferred — do NOT build in M5

- Any dashboard / web UI (its own later milestone).
- **Materialized** project/usage/cost projections and the per-project rollup tables — that is **M6**
  ("Event projections"). M5 ships the *resolver* + the join; M6 materializes attribution at scale.
- Git **outcome** tracking + diff capture + outcome attribution scoring (PRD §11.3/§11.4) — M6+.
- The full hybrid attribution scorer; M5's only heuristic is "auto-create one project per workspace,
  unify by remote," editable — never asserted as an immutable fact.
- Capturing Gemini legacy **hash-only** sessions (dirs with no `.project_root`) — left unattributed with
  a recorded gap (see D3). Also out of scope: the M4-era capture gaps surfaced during this spike
  (Gemini `.jsonl` sessions; see NOTES "Discovered out-of-scope issues").
- Per-connector enforced permission scopes; multi-user UX (schema stays multi-user-capable per M2).

## User Story

As an AI-heavy developer whose Claude Code, Codex, and Gemini sessions are already captured into my
archive,
I want those sessions automatically organized into Projects (one per repo) — including my Gemini
sessions, which only store a hashed project id — and to be able to rename or re-point that mapping,
So that every later report and metric (M6/M7) can attribute cost, tokens, and context behavior to the
right project, across all three tools and across machines, without me hand-tagging anything.

## Problem Statement

The archive has a flat event stream tagged with raw `project_path` strings that (a) have no Project or
Workspace entity to belong to, (b) are real paths for Claude/Codex but opaque hashes for Gemini, and
(c) are not unified across machines (the same repo on two machines has two different absolute paths).
There is no way to ask "show me everything for project X," no project identity, and one of the three
required connectors (Gemini) is entirely unattributable. PRD §6/§19's Project + Workspace + Project
Mapping concepts do not exist in code yet.

## Solution Statement

Add three small tables to `@420ai/db` (`projects`, `workspaces`, `workspace_keys`) via one Drizzle
migration. Add a connector-owned `discoverRoots(home)` capability (optional method on the existing
`Connector` contract — additive, mirrors how each connector already owns `watchGlobs`) so each connector
reports the distinct project roots in its store, plus a shared, pure git-metadata reader
(`.git/config` + `.git/HEAD`) and a Gemini `.project_root` sidecar reader. A collector `discover` command
enumerates roots → enriches with git remote/branch → POSTs to a new machine-authed
`POST /v1/workspaces/discover` endpoint, which upserts workspaces, records each connector's `project_key`
alias (the path or the Gemini hash), and find-or-creates one project per workspace (unifying by git
remote). Admin endpoints list projects/workspaces, create a project, and remap a workspace. A
`resolveWorkspaceId` repository + a per-project events query join `events.project_path` (path or hash)
through `workspace_keys` to a project — the attribution building block M6 will materialize. No change to
the M1 fingerprint, the M2 wire types for events, the encryption split, or any connector's `parse`.

## Feature Metadata

**Feature Type**: New Capability (Project/Workspace entities, repo discovery, attribution resolver)
**Estimated Complexity**: Medium-High (first new Postgres tables + migration since M2; a new server
surface; cross-connector discovery; the Gemini reverse-map). Lower risk than M4 — no token arithmetic,
no fingerprint/encryption changes, and the one novel mechanic (Gemini reverse-map) is verified.
**Primary Systems Affected**: `packages/db` (3 tables + migration + repositories), `apps/ingest` (4–5
routes + schemas), `apps/collector` (discovery module + `discover`/`projects` CLI commands + optional
`discoverRoots` per connector), `packages/shared` (discovery wire types). **No dashboard.**
**Dependencies**: none new. Node ≥ 24 built-ins (`node:fs`, `node:path`, `node:crypto`), `drizzle-orm` +
`drizzle-kit` (already present), Fastify (already present). No `git` subprocess (parse `.git` files).

---

## PRE-FLIGHT VERIFICATION (executed against REAL on-disk files this session)

The novel runtime risk in M5 was "how do we attribute Gemini sessions when the store only has a hashed
id." It is **RETIRED with evidence**:

1. **Gemini writes a `.project_root` sidecar with the real path — [VERIFIED].** `~/.gemini/tmp/420ai/.project_root`
   contains `c:\users\seanr\onedrive\documents\420ai` (lowercased, backslashes). 41 of 61 tmp dirs have
   one. → reverse-mapping needs NO hash algorithm; read the sidecar.
2. **In-file `projectHash` == the tmp directory name — [VERIFIED].** A real session
   (`…/2025fdb554a6…/chats/session-….json`) has `projectHash: "2025fdb554a6…"` exactly equal to its
   containing dir name. So a Gemini event's `project_path` (= `projectHash`) can be joined to the dir
   that owns the `.project_root`. (Confirm across a few more dirs during execution — Task 9 test.)
3. **Hash-cracking is unnecessary AND unreliable — [VERIFIED negative].** sha256/md5/sha1 of the
   `.project_root` value (and case/slash variants) matched NO existing tmp dir name; the slug-named dirs
   (with `.project_root`) and the legacy hash-named dirs are disjoint Gemini generations. → Do not try to
   reverse the hash. Sessions in hash-only dirs (no sidecar; ~60 of 71 `.json` sessions) stay
   unattributed with a recorded gap.
4. **Git metadata is plain-text-parseable — [VERIFIED].** `.git/HEAD` = `ref: refs/heads/<branch>`
   (branch = substring after last `/`); `.git/config` has `[remote "origin"]\n\turl = <url>`. No `git`
   subprocess needed — parse the files (pure, deterministic, testable, no PATH dependency).
5. **Claude/Codex carry the real cwd — [VERIFIED in M4].** Claude records carry `cwd`/`gitBranch`
   (M4 `claude-code.ts:164` maps `projectPath: base.cwd`); Codex `session_meta.payload.cwd` +
   `git.branch` (M4 `codex-cli.ts:114-131`). So their `project_key` IS the real path — direct join.

**Residual risk (cannot retire before execution):** the genuine first-write — the Drizzle migration,
the new Fastify routes, the discovery enumeration cost across many sessions, and wiring the resolver
join. All low-risk and covered by the validation ladder. One quick execution check is recommended before
Task 1 (see "Recommended quick spike").

### Recommended quick spike (≤15 min, before Task 1 — optional but de-risks the migration)

Run `npm run db:up && npm run db:migrate` against a scratch DB to confirm the M2 migration applies
cleanly on this machine, then after writing the M5 schema run `npm run db:generate` and eyeball the
generated SQL. This confirms the drizzle-kit toolchain round-trips before you build routes on top.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

- `packages/db/src/schema.ts` — Why: the table-definition style to mirror EXACTLY (`pgTable`, `uuid`
  `.primaryKey().defaultRandom()`, `text`, `timestamp({withTimezone:true})`, `index`/`uniqueIndex`,
  `.references(() => users.id)`). Read the header comment on the encryption split + the `events`
  `project_path`/`git_branch` plaintext rationale (lines 22-28, 110-111). M5 adds tables here; it does
  NOT alter `events` (attribution is a join, not a column — see D5).
- `packages/db/src/index.ts` — Why: the barrel that re-exports every table + repository fn. Add the new
  tables + repository functions here (the ingest app imports from `@420ai/db`, never deep paths).
- `packages/db/src/repositories/ingest.ts` — Why: the repository style (typed args, Drizzle
  `insert().onConflictDoNothing/DoUpdate`, `db.transaction`, `.returning`). The find-or-create-project +
  upsert-workspace repos mirror this exactly. Read the `onConflictDoUpdate` shape.
- `packages/db/src/repositories/pairing.ts` and `machines.ts` — Why: smaller repository examples
  (find-or-create, typed errors like `PairingError`). Mirror the error style for any M5 typed error.
- `packages/db/drizzle.config.ts` + `packages/db/src/migrate.ts` + `migrate-cli.ts` — Why: the migration
  toolchain. `npm run db:generate` writes a new file under `packages/db/drizzle/`; `npm run db:migrate`
  applies it. Do NOT hand-edit migration SQL — generate it from the schema.
- `packages/db/drizzle/0000_mean_demogoblin.sql` — Why: the ONLY existing migration; your generated M5
  migration sits beside it as `0001_*.sql`. Read it to see the generated style (the M2 baseline).
- `apps/ingest/src/app.ts` — Why: `buildApp` registers each route plugin + the central error handler
  (maps typed errors → status). Register the new route plugins here; map any new typed error.
- `apps/ingest/src/routes/pairing-codes.ts` — Why: the **admin-gated** route pattern (`adminAuthorized`
  constant-time bearer check against `app.adminToken`) — mirror it for the admin project/workspace CRUD.
  Also the single-user `users` upsert-by-email pattern you reuse to resolve the `userId`.
- `apps/ingest/src/routes/ingest.ts` — Why: the **machine-authed** route pattern (`preHandler:
  app.authenticate`, then `request.machineId`). The `POST /v1/workspaces/discover` endpoint mirrors this
  (discovery is machine-scoped, like ingest). READ THIS to copy the preHandler wiring.
- `apps/ingest/src/plugins/auth.ts` — Why: `app.authenticate` resolves a bearer token → `machineId` and
  the module augmentation that types `request.machineId`. Discovery resolves `userId` from the machine.
  (You will likely need a `findMachineById`/`userId` lookup — check `repositories/machines.ts`; add a
  tiny `getMachineUserId(db, machineId)` if absent.)
- `apps/ingest/src/schemas.ts` — Why: the **plain JSON-schema** body-validation style (NOT zod;
  `as const`, `additionalProperties:false`, `required:[…]`). Add the discover/project/workspace body
  schemas here in the same style.
- `apps/ingest/src/routes/ingest.ts` + `apps/ingest/src/app.int.test.ts` + `apps/collector/src/push.int.test.ts`
  — Why: the integration-test template — build the app in-process (`buildApp` with a test `Db`), pair (or
  inject a token), `app.inject`/`listen({port:0})`, assert idempotency. M5's int test drives discover →
  upsert → resolve.
- `apps/collector/src/connectors/connector.ts` — Why: the `Connector` contract M5 extends with an
  OPTIONAL `discoverRoots(home)` method (additive, like M4's `captureMode`), and the `connectors`
  registry the discovery engine iterates. READ how `watchGlobs`/`captureMode` are declared.
- `apps/collector/src/connectors/claude-code.ts`, `codex-cli.ts`, `gemini-cli.ts` — Why: each connector's
  store layout + where the real path lives. Claude: `cwd` per record (`claude-code.ts:164`); Codex:
  `session_meta.payload.cwd` + `git.branch` (`codex-cli.ts:114-131`); Gemini:
  `projectHash`/`.project_root` (`gemini-cli.ts:52,109-110,217` — the `knownGap` this milestone closes).
  `discoverRoots` lives next to each connector because each owns its store knowledge.
- `apps/collector/src/watcher/file-watcher.ts` — Why: how globs are expanded/normalized (`\`→`/`,
  `node:fs/promises glob`) — discovery reuses the same glob discipline to enumerate session files.
- `apps/collector/src/cli.ts` — Why: the ONLY collector file that logs/exits/reads argv. Add
  `discover` and `projects` commands mirroring the `runX` (pure exported fn) + thin `main()` split; the
  discovery library stays silent and takes results back to `cli.ts` to print.
- `apps/collector/src/ingest-client.ts` — Why: `postIngest`/`IngestHttpError`/`isUnauthorized` —
  add a `postDiscover(url, token, hints)` sibling (same fetch+bearer+expectOk shape) for the discover
  endpoint. Do NOT reinvent the HTTP error handling.
- `apps/collector/src/identity.ts` — Why: `requireCredentials()` → `{url, token, machineId}`; the
  `discover` CLI command resolves creds the same way `watch`/`sync` do.
- `packages/shared/src/ingest.ts` + `events.ts` — Why: the wire-type style + `RawSourceRecord`/
  `NormalizedEvent` shapes. Add the M5 discovery wire types (`DiscoveredWorkspace`, the discover request/
  response) here, in the same plain-interface style.

### Relevant Documentation — READ BEFORE IMPLEMENTING

- `docs/PRD.md` §6 (Project / Machine / Workspace / Connector definitions — name code after these), §11.2
  (Scoped Source Capture — discovery derives candidates from where work happened, does NOT broadly walk
  disk or ingest source), §19 steps 7–9 (discover → map → select), §25.5 (this milestone). §12/§23 (the
  fingerprint + replay invariants you must NOT touch).
- `docs/CONTEXT.md` — canonical terms: **Project**, **Workspace**, **Project Mapping**, **Workspace
  Discovery**, **Machine**, **Attribution Confidence**. Name tables/columns/functions after these.
- `.agents/plans/m2-archive-deployment.md` — Why: the last milestone that added Postgres tables + Drizzle
  migrations + Fastify routes; mirror its migration discipline and route/repo/int-test patterns. M5 is
  "M2-shaped" on the server side.
- `.agents/plans/m4-connectors-full-fidelity.md` — Why: the `[VERIFIED]`/spike discipline, the
  additive-optional-method pattern (`captureMode`) that `discoverRoots` mirrors, and the exact connector
  store facts M5 builds on.
- `.agents/system-reviews/milestones-1-3-review.md` — Why: the hard-won process gates (validation is a
  GATE: repo-root `tsc -b`, NUL scan, stray-artifact scan; snippet↔spike fidelity; no per-workspace build
  substitution). Honor all of them.
- Drizzle ORM Postgres column types + `onConflictDoUpdate`: https://orm.drizzle.team/docs/column-types/pg
  and https://orm.drizzle.team/docs/insert#upserts-and-conflicts — Why: get the new table DSL + upsert
  exactly right. drizzle-kit generate: https://orm.drizzle.team/docs/migrations

### New Files to Create

```
packages/db/src/
  repositories/
    projects.ts                 # findOrCreateProjectByRemote, createProject, listProjects, renameProject
    projects.test.ts            # (unit where pure) — most coverage is in repositories/*.int.test.ts
    workspaces.ts               # upsertWorkspace, addWorkspaceKey, remapWorkspace, listWorkspaces, resolveWorkspaceId
    workspaces.int.test.ts      # skipIf(!DATABASE_URL_TEST): upsert+key+resolve+remap, find-or-create-by-remote, cross-machine unify
packages/db/drizzle/
  0001_<generated>.sql          # GENERATED by `npm run db:generate` — do NOT hand-write
apps/ingest/src/routes/
  workspaces.ts                 # POST /v1/workspaces/discover (machine-authed); GET /v1/workspaces; PATCH /v1/workspaces/:id (admin)
  projects.ts                   # GET /v1/projects; POST /v1/projects; PATCH /v1/projects/:id (admin); GET /v1/projects/:id/summary
apps/collector/src/
  discovery/
    git-meta.ts                 # PURE: readGitMeta(repoRoot) -> { remote?, branch? } from .git/config + .git/HEAD
    git-meta.test.ts            # tmp .git fixtures: remote+branch parsed; no .git -> undefined; detached HEAD
    gemini-roots.ts             # PURE: scanGeminiProjectRoots(home) -> { dirName -> realPath } from .project_root sidecars
    gemini-roots.test.ts        # tmp ~/.gemini/tmp fixtures: sidecar read; missing sidecar skipped
    discover-engine.ts          # enumerate connector roots -> enrich (git + gemini map) -> DiscoveredWorkspace[]
    discover-engine.test.ts     # with fake connectors + tmp dirs: dedup roots, gemini hash->path, git enrich
packages/shared/src/
  discovery.ts                  # DiscoveredWorkspace, DiscoverRequest/Response wire types + (optional) toDiscoveredWorkspace
  discovery.test.ts             # shape/normalize-path unit tests (if any pure helpers)
```

### Files to MODIFY

```
packages/db/src/schema.ts             # ADD projects, workspaces, workspace_keys tables (+ indexes)
packages/db/src/index.ts              # export the new tables + repository functions
apps/ingest/src/app.ts                # register projectRoutes + workspaceRoutes; map any new typed error
apps/ingest/src/schemas.ts            # ADD discoverBodySchema, createProjectBodySchema, patch schemas
apps/ingest/src/routes/...            # (new files above) registered in app.ts
packages/db/src/repositories/machines.ts # ADD getMachineUserId(db, machineId) if not present (discovery needs userId)
apps/collector/src/connectors/connector.ts        # ADD optional discoverRoots?(home): Promise<RootHint[]> to Connector
apps/collector/src/connectors/claude-code.ts       # IMPLEMENT discoverRoots (distinct cwds from sessions)
apps/collector/src/connectors/codex-cli.ts         # IMPLEMENT discoverRoots (session_meta cwd + git.branch)
apps/collector/src/connectors/gemini-cli.ts        # IMPLEMENT discoverRoots (dirName/projectHash + .project_root realPath)
apps/collector/src/ingest-client.ts                # ADD postDiscover(url, token, req)
apps/collector/src/cli.ts                          # ADD `discover` + `projects` commands + runDiscover/runProjects; extend usage()
packages/shared/src/index.ts                       # export discovery wire types
README.md                                          # bump Status; brief M5 note (do not re-paste conventions)
```

### Patterns to Follow

**New tables (mirror `packages/db/src/schema.ts` exactly):**

```ts
// projects: a software effort. Cross-machine identity via git_remote (nullable).
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    gitRemote: text("git_remote"),                 // natural key for unify-by-remote (nullable)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("projects_user_remote").on(t.userId, t.gitRemote)], // see GOTCHA on NULL remotes
);

// workspaces: a local dev context where sessions occurred (PRD §6). One per (user, root_path).
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    projectId: uuid("project_id").references(() => projects.id), // nullable until mapped (auto-mapped on create)
    machineId: uuid("machine_id").references(() => machines.id),
    rootPath: text("root_path").notNull(),         // normalized real path (Claude/Codex cwd, Gemini .project_root)
    gitRemote: text("git_remote"),
    gitBranch: text("git_branch"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workspaces_user_root").on(t.userId, t.rootPath)],
);

// workspace_keys: maps the RAW event.project_path string (real path for Claude/Codex, projectHash for
// Gemini) to a workspace. This alias table is what bridges the path/hash mismatch at attribution time.
export const workspaceKeys = pgTable(
  "workspace_keys",
  {
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    sourceConnector: text("source_connector").notNull(),
    projectKey: text("project_key").notNull(),     // == events.project_path as emitted by the connector
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workspace_keys_key").on(t.userId ?? t.projectKey)], // see GOTCHA — key is global per user
);
```
> **GOTCHA (unique on nullable / scoping):** Postgres treats `NULL`s as distinct in a UNIQUE index, so
> `projects_user_remote` will NOT dedup two remote-less projects — that is acceptable (folder-named
> projects are not unified). For `workspace_keys`, the join key is `events.project_path`, which has no
> `user_id` column on the event; scope correctness by joining through `workspaces.user_id`. Make
> `workspace_keys.project_key` unique **per workspace owner** — simplest correct form: store `user_id` on
> `workspace_keys` too and `uniqueIndex(user_id, project_key)`. Decide and document; do not leave the
> snippet's `t.userId ?? t.projectKey` placeholder — add a real `userId` column to `workspace_keys`.

**Admin-gated route (mirror `routes/pairing-codes.ts` `adminAuthorized`):** reuse the constant-time
bearer check against `app.adminToken` for project/workspace CRUD (create/list/rename/remap).

**Machine-authed route (mirror `routes/ingest.ts`):** `POST /v1/workspaces/discover` uses
`{ preHandler: app.authenticate }`, reads `request.machineId`, resolves `userId` via
`getMachineUserId(db, request.machineId)`. Discovery is machine-scoped exactly like ingest.

**Repository upsert (mirror `repositories/ingest.ts`):** `db.transaction`, `insert().values().
onConflictDoUpdate({ target: …, set: … }).returning(…)`. find-or-create-project:
`insert(projects).onConflictDoUpdate(target: [userId, gitRemote], set: { name })` when remote present,
else a plain insert (no natural key).

**Pure git-meta reader (no subprocess — [VERIFIED] formats):**
```ts
// apps/collector/src/discovery/git-meta.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
export interface GitMeta { remote?: string; branch?: string; }
/** Read remote+branch from a repo's .git files. Returns {} if not a git repo. PURE + synchronous. */
export function readGitMeta(repoRoot: string): GitMeta {
  const gitDir = join(repoRoot, ".git");
  if (!existsSync(gitDir)) return {};
  let branch: string | undefined;
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();   // "ref: refs/heads/<branch>"
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    branch = m ? m[1] : undefined;                                    // detached HEAD (bare sha) -> undefined
  } catch { /* no HEAD */ }
  let remote: string | undefined;
  try {
    const cfg = readFileSync(join(gitDir, "config"), "utf8");         // [remote "origin"]\n\turl = <url>
    const m = /\[remote "origin"\][^[]*?url\s*=\s*(.+)/s.exec(cfg);
    remote = m ? m[1].trim() : undefined;
  } catch { /* no config */ }
  return { remote, branch };
}
```
> **Spike-snippet fidelity:** this encodes PRE-FLIGHT #4 — `.git/HEAD` = `ref: refs/heads/m5-project-mapping`
> and `.git/config` has `[remote "origin"]\n\turl = https://github.com/seanrobertwright/420AI.git` on this
> repo. The test (Task 5) MUST assert exactly those two extractions plus the detached/no-.git cases.

**Pure Gemini sidecar reader ([VERIFIED] — D3):**
```ts
// apps/collector/src/discovery/gemini-roots.ts
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
/** Map each ~/.gemini/tmp/<dirName> that has a .project_root to its real path.
 *  dirName == the in-file projectHash == events[].project_path for Gemini ([VERIFIED]). */
export function scanGeminiProjectRoots(home: string): Map<string, string> {
  const tmp = join(home, ".gemini", "tmp");
  const out = new Map<string, string>();
  if (!existsSync(tmp)) return out;
  for (const dirName of readdirSync(tmp)) {
    const pr = join(tmp, dirName, ".project_root");
    if (existsSync(pr)) out.set(dirName, readFileSync(pr, "utf8").trim());
  }
  return out;
}
```

**Optional connector method (additive — mirror M4 `captureMode`):**
```ts
// apps/collector/src/connectors/connector.ts — ADD to the Connector interface
export interface RootHint {
  projectKey: string;     // exactly what this connector emits as event.projectPath (real path OR gemini hash)
  rootPath?: string;      // resolved real path (== projectKey for Claude/Codex; from .project_root for Gemini)
  gitBranch?: string;     // best-effort from the store record (enrichment also re-reads .git)
  sessionCount?: number;
}
export interface Connector {
  // ...existing fields...
  /** Enumerate distinct project roots in this connector's on-disk store (M5 discovery). Optional. */
  discoverRoots?(home: string): Promise<RootHint[]>;
}
```

**Wire types (mirror `packages/shared/src/ingest.ts` plain-interface style):**
```ts
// packages/shared/src/discovery.ts
export interface DiscoveredWorkspace {
  sourceConnector: string;
  projectKey: string;          // event.project_path as emitted (path or gemini hash)
  rootPath: string;            // normalized real path
  gitRemote?: string;
  gitBranch?: string;
  sessionCount?: number;
}
export interface DiscoverRequest { workspaces: DiscoveredWorkspace[]; }
export interface DiscoverResponse {
  workspacesUpserted: number;
  projectsCreated: number;
  mappings: { projectKey: string; workspaceId: string; projectId: string; projectName: string }[];
}
```

**Library files never log / `process.exit`** (CLAUDE.md). Discovery modules + repositories are silent;
only `cli.ts` (collector) and the Fastify error handler (server) surface anything. Inject clocks/paths
for tests (e.g. `scanGeminiProjectRoots(home)` takes `home` so tests pass a tmp dir).

---

## KEY DESIGN DECISIONS (read before coding)

### D1 — Discovery derives candidates from where work happened, not a disk walk (PRD §11.2)
Each connector's `discoverRoots(home)` enumerates the distinct project roots **in its own store** (Claude
`~/.claude/projects/*`, Codex `~/.codex/sessions/**`, Gemini `~/.gemini/tmp/*`). This is scoped capture:
the only roots considered are ones where AI coding actually occurred. The collector then enriches each
resolved `rootPath` with `readGitMeta(rootPath)` (remote/branch). No broad filesystem scan, no source
ingestion.

### D2 — Cheap enumeration: read minimally per session, dedup by root
`discoverRoots` must be cheap across potentially hundreds of sessions. Per connector:
- **Claude:** for each `~/.claude/projects/<slug>/` dir, read session files line-by-line only until the
  first record carrying `cwd` is found (then stop); `projectKey = rootPath = cwd`. Dedup by `cwd`.
  (Do NOT full-parse every session — discovery is a metadata sweep.)
- **Codex:** read each rollout's **first `session_meta` line** → `cwd` + `git.branch`;
  `projectKey = rootPath = cwd`. Dedup by `cwd`.
- **Gemini:** build the `dirName → realPath` map via `scanGeminiProjectRoots(home)`; for each session dir
  that HAS a sidecar, emit `projectKey = dirName` (== projectHash == event.project_path), `rootPath =
  realPath`. Dirs without a sidecar → skip + count toward a "geminiUnattributed" gap (logged by cli).
> **GOTCHA:** path normalization must be CONSISTENT between (a) what the connector emits as
> `event.project_path` at capture time and (b) the `projectKey` discovery sends. For Claude/Codex,
> `event.project_path` is the raw `cwd` string verbatim — so `projectKey` MUST be that same verbatim
> string (do not lowercase/normalize it, or the join breaks). `rootPath` MAY be normalized for display,
> but `project_key` is matched byte-for-byte against `events.project_path`. Add a test asserting this.

### D3 — Gemini reverse-map = `.project_root` sidecar, NOT hash-cracking ([VERIFIED])
`event.project_path` for Gemini is the `projectHash` (= tmp dir name). The sidecar gives
`dirName → realPath`. So `workspace_keys` gets a row `{ sourceConnector:"gemini-cli", projectKey:dirName,
workspaceId }` whose workspace has `rootPath = realPath`. Legacy hash-only dirs (no sidecar) cannot be
mapped (the hash algorithm is unconfirmed and unreliable — PRE-FLIGHT #3) → leave unattributed; record
the count as a gap. Do NOT attempt to reverse the hash.

### D4 — One project per workspace, auto-created, unified by remote, editable
On discover, for each workspace: `findOrCreateProjectByRemote(userId, gitRemote, name)` when a remote
exists (so the same repo across machines maps to ONE project); otherwise create a project named from the
folder basename. Workspace `project_id` is set to that project. The mapping is **editable** —
`PATCH /v1/workspaces/:id { projectId }` repoints it, and `PATCH /v1/projects/:id { name }` renames.
Auto-creation is a default, never asserted as immutable (PRD §11.4 spirit).

### D5 — Attribution is a JOIN, not a column on `events` (event-sourcing discipline)
Do NOT add `project_id` to the `events` table. Events are disposable projections; attribution is
re-derivable. M5 ships `resolveWorkspaceId(db, userId, projectKey)` and a query that joins
`events.project_path = workspace_keys.project_key` → `workspaces` → `projects`. M6 ("event projections")
materializes per-project rollups from this join. M5's `GET /v1/projects/:id/summary` (event count, last
activity) proves the join works end-to-end without committing to a materialization strategy. This keeps
the FROZEN event shape + migration surface minimal (3 new tables, `events` untouched).

### D6 — No change to fingerprint / wire events / encryption / connector parse
M5 reads `events.project_path` (already plaintext + queryable) and adds tables/routes around it. The M1
fingerprint, the M2 event wire types + ingest path, the AES-GCM split, and every connector's `parse` are
untouched. The only connector change is the additive optional `discoverRoots` (no effect on capture).

---

## IMPLEMENTATION PLAN

### Phase 1: Data model (`@420ai/db`)
Add the three tables + the migration + the repositories (projects, workspaces, resolver). Integration-
tested against Postgres; pure where possible.

### Phase 2: Shared wire types
`packages/shared/src/discovery.ts` — the discover request/response + `DiscoveredWorkspace`. Pure, no deps.

### Phase 3: Server surface (`apps/ingest`)
Machine-authed `POST /v1/workspaces/discover` (upsert + auto-create project + record keys) and admin-
gated project/workspace CRUD + `/summary`. Mirror existing route/auth patterns.

### Phase 4: Collector discovery
Pure `git-meta` + `gemini-roots` readers; per-connector `discoverRoots`; the `discover-engine` that
enumerates → enriches → builds `DiscoveredWorkspace[]`; `postDiscover` client; `discover` + `projects`
CLI commands.

### Phase 5: Tests, validation, docs
Unit suites (no infra) + Postgres-gated int tests (db repos + the discover→resolve round-trip via
`buildApp`) + the full `repo-health` gate + README.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Run each task's VALIDATE before moving on. (Optional: run the
"Recommended quick spike" above before Task 1.)

### Task 1 — UPDATE `packages/db/src/schema.ts`: add `projects`, `workspaces`, `workspace_keys`
- **IMPLEMENT** the three tables per "Patterns to Follow", resolving the GOTCHA: add a `userId` column to
  `workspace_keys` and `uniqueIndex("workspace_keys_user_key").on(t.userId, t.projectKey)`. Add
  `index`es you will query on: `workspaces.projectId`, `workspaceKeys.workspaceId`.
- **PATTERN**: existing tables in the same file (uuid PK, `.references`, timestamp tz, indexes array).
- **GOTCHA**: name SQL columns `snake_case` (drizzle maps from the camelCase key). `projectId`/`machineId`
  are nullable FKs. Do NOT touch the `events` table.
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 2 — GENERATE the migration
- **RUN**: `npm run db:generate` → writes `packages/db/drizzle/0001_*.sql` + updates `drizzle/meta/`.
- **GOTCHA**: do NOT hand-edit the generated SQL. Eyeball it: three `CREATE TABLE`s + the unique/indexes,
  FKs to `users`/`projects`/`machines`. Requires `DATABASE_URL` in `.env` (drizzle-kit loads repo-root
  `.env`). The generate step reads the schema, not the DB, so it works even before `db:up`.
- **VALIDATE**: the new `0001_*.sql` exists and contains `create table "projects"`, `"workspaces"`,
  `"workspace_keys"`; `git status` shows the migration + meta staged-able (no stray artifacts).

### Task 3 — CREATE `packages/db/src/repositories/projects.ts`
- **IMPLEMENT**: `findOrCreateProjectByRemote(db, userId, gitRemote, name)` (upsert on `[userId,
  gitRemote]` when remote present; else plain insert), `createProject(db, userId, name, gitRemote?)`,
  `listProjects(db, userId)`, `renameProject(db, projectId, name)`, `archiveProject` (set `archivedAt`).
- **PATTERN**: `repositories/ingest.ts` (transaction, `onConflictDoUpdate`, `.returning`).
- **GOTCHA**: when `gitRemote` is null the unique index does not dedup (Postgres NULL distinct) — that is
  intended (folder-named projects are not unified). Return the existing row on remote conflict.
- **VALIDATE**: `npm run typecheck` (exit 0); covered by Task 5 int test.

### Task 4 — CREATE `packages/db/src/repositories/workspaces.ts`
- **IMPLEMENT**:
  - `upsertWorkspace(db, { userId, machineId, rootPath, gitRemote, gitBranch, projectId })` — upsert on
    `[userId, rootPath]`, update `gitRemote/gitBranch/lastSeenAt/projectId`.
  - `addWorkspaceKey(db, { userId, workspaceId, sourceConnector, projectKey })` — upsert on `[userId,
    projectKey]` (idempotent; re-discovery is a no-op).
  - `remapWorkspace(db, workspaceId, projectId)` — the editable mapping.
  - `listWorkspaces(db, userId)`.
  - `resolveWorkspaceId(db, userId, projectKey)` — join `workspace_keys` → return `workspaceId` +
    `projectId` (or undefined). This is the D5 resolver.
  - `projectEventSummary(db, projectId)` — count events + max(ts) by joining `events.project_path =
    workspace_keys.project_key` for keys whose workspace.project_id = projectId. (Read-only; proves D5.)
- **PATTERN**: `repositories/ingest.ts` + drizzle `inArray`/`eq`/`sql` for the join/count.
- **GOTCHA**: `projectEventSummary` joins on a TEXT key (`project_path` ↔ `project_key`) — ensure the
  byte-for-byte match invariant from D2 holds. Scope every query by `userId`.
- **VALIDATE**: `npm run typecheck` (exit 0); covered by Task 5.

### Task 5 — CREATE `packages/db/src/repositories/workspaces.int.test.ts` (+ tiny projects coverage)
- **IMPLEMENT** (`describe.skipIf(!process.env.DATABASE_URL_TEST)`, mirror `repositories/ingest.int.test.ts`):
  - upsertWorkspace inserts then updates-in-place on the same `(userId, rootPath)`.
  - addWorkspaceKey is idempotent; resolveWorkspaceId returns the workspace+project for a known key, and
    `undefined` for an unknown key.
  - find-or-create-by-remote: two workspaces with the SAME `gitRemote` (different `rootPath`, e.g. two
    machines) map to ONE project (cross-machine unify, D4).
  - remapWorkspace repoints `project_id`.
  - **Gemini path:** a `workspace_keys` row with `projectKey = "<hash>"` (Gemini) and a workspace whose
    `rootPath` is the real path resolves correctly — and an event with `project_path = "<hash>"` is
    counted by `projectEventSummary` (insert a couple of events via the existing `ingestBatch` or direct
    insert to assert the join).
- **GOTCHA**: integration tests import across boundaries and are EXCLUDED from `tsc -b` (see
  `apps/collector/tsconfig.json` precedent) and self-skip without `DATABASE_URL_TEST`. Confirm
  `packages/db/tsconfig.json` excludes `*.int.test.ts` (add if missing — mirror the collector tsconfig).
- **VALIDATE**: `npm test` (self-skips, exit 0) AND, with DB up,
  `DATABASE_URL_TEST=postgres://420ai:420ai@localhost:5433/420ai_test npm test` (passes).

### Task 6 — UPDATE `packages/db/src/index.ts` + `repositories/machines.ts`
- **IMPLEMENT**: export `projects`, `workspaces`, `workspaceKeys` tables and all new repository functions
  from the barrel. ADD `getMachineUserId(db, machineId): Promise<string | undefined>` to `machines.ts`
  (the discover route needs `userId` from the authed machine) and export it.
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 7 — CREATE `packages/shared/src/discovery.ts` (+ export from `index.ts`)
- **IMPLEMENT**: `DiscoveredWorkspace`, `DiscoverRequest`, `DiscoverResponse`, `RootHint` types per
  "Patterns to Follow". Optionally a pure `normalizeRootPath` helper IF you normalize for display (keep
  `projectKey` raw — D2 GOTCHA). Export all from `packages/shared/src/index.ts`.
- **GOTCHA**: keep `packages/shared` dependency-free. Types only (+ tiny pure helpers).
- **VALIDATE**: `npm run -w @420ai/shared build && npm test -w @420ai/shared` (exit 0).

### Task 8 — UPDATE `apps/ingest/src/schemas.ts` + CREATE `routes/workspaces.ts` + `routes/projects.ts`
- **IMPLEMENT schemas** (plain JSON-schema, `as const`, `additionalProperties:false`):
  `discoverBodySchema` (`{ workspaces: [{ sourceConnector, projectKey, rootPath, gitRemote?, gitBranch?,
  sessionCount? }] }`), `createProjectBodySchema` (`{ name, gitRemote? }`), `patchProjectBodySchema`
  (`{ name }`), `patchWorkspaceBodySchema` (`{ projectId }`).
- **IMPLEMENT `routes/workspaces.ts`**:
  - `POST /v1/workspaces/discover` — `{ preHandler: app.authenticate }`; `userId =
    getMachineUserId(db, request.machineId)`; in ONE transaction, for each hint: `upsertWorkspace` →
    `findOrCreateProjectByRemote` (or basename) → set workspace `project_id` → `addWorkspaceKey`; return
    `DiscoverResponse`.
  - `GET /v1/workspaces` — admin-gated (`adminAuthorized`), `listWorkspaces`.
  - `PATCH /v1/workspaces/:id` — admin-gated, `remapWorkspace`.
- **IMPLEMENT `routes/projects.ts`** (admin-gated): `GET /v1/projects` (list), `POST /v1/projects`
  (create), `PATCH /v1/projects/:id` (rename), `GET /v1/projects/:id/summary` (`projectEventSummary`).
- **PATTERN**: `routes/ingest.ts` (machine-authed preHandler) + `routes/pairing-codes.ts`
  (`adminAuthorized`). Resolve the single-user `userId` the same way pairing-codes does where needed.
- **GOTCHA**: discovery is machine-authed (like ingest); admin CRUD is admin-token-gated (like
  pairing-codes). Do not cross the two. Validate bodies via the schemas so a bad body 400s before the
  handler.
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 9 — UPDATE `apps/ingest/src/app.ts` — register routes
- **IMPLEMENT**: `app.register(projectRoutes); app.register(workspaceRoutes);` after the existing
  registrations. Map any new typed error in the error handler if you add one (else the generic path is
  fine).
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 10 — CREATE `apps/ingest/src/app.int.test.ts` additions (discover → resolve round-trip)
- **IMPLEMENT** (extend the existing int test, `skipIf(!DATABASE_URL_TEST)`): build the app, pair a
  machine (reuse the existing pairing helper / `push.int.test.ts` flow) to get a token + machineId; POST
  `/v1/workspaces/discover` with 2 Claude hints (same remote, different rootPath) + 1 Gemini hint
  (projectKey = a fake hash, rootPath = real path); assert `projectsCreated` unifies the 2 same-remote
  Claude workspaces into 1 project; then assert `GET /v1/projects` lists it and `resolveWorkspaceId`
  (or `GET /v1/projects/:id/summary` after inserting events with matching `project_path`) attributes
  correctly. Assert admin endpoints 401 without the admin token.
- **VALIDATE**: `npm test` (self-skips) / with DB: full int passes.

### Task 11 — UPDATE `apps/collector/src/connectors/connector.ts` + the three connectors
- **IMPLEMENT**: add the optional `discoverRoots?(home): Promise<RootHint[]>` + `RootHint` to the
  contract (additive — absent is fine, mirrors `captureMode`). Then implement it per connector (D2):
  - `claude-code.ts`: glob `watchGlobs(home)`; per project-dir, read session lines until first `cwd` →
    `{ projectKey: cwd, rootPath: cwd, gitBranch }`. Dedup by cwd.
  - `codex-cli.ts`: per rollout file, read first `session_meta` line → `{ projectKey: cwd, rootPath: cwd,
    gitBranch: git.branch }`. Dedup by cwd.
  - `gemini-cli.ts`: `scanGeminiProjectRoots(home)` → for each dir WITH a sidecar emit `{ projectKey:
    dirName, rootPath: realPath }`; count sidecar-less dirs as the gap. Update the connector `knownGaps`
    to reflect "M5 maps via .project_root; legacy hash-only sessions unattributed."
- **GOTCHA**: `projectKey` MUST equal what the connector emits as `event.project_path` byte-for-byte
  (Claude/Codex: raw `cwd`; Gemini: `projectHash` = dirName). Add a unit assertion tying `discoverRoots`'
  `projectKey` to the same value `parse` puts in `projectPath` for a shared fixture.
- **VALIDATE**: `npm test -w @420ai/collector -- connectors` (exit 0).

### Task 12 — CREATE `apps/collector/src/discovery/git-meta.ts` + `gemini-roots.ts` (+ tests)
- **IMPLEMENT** both pure readers per "Patterns to Follow".
- **IMPLEMENT tests** (tmp fixtures, no infra):
  - `git-meta.test.ts`: write a tmp `.git/HEAD` (`ref: refs/heads/feature-x`) + `.git/config`
    (`[remote "origin"]\n\turl = git@github.com:me/repo.git`) → assert `{remote, branch}`; no `.git` → `{}`;
    detached HEAD (a bare sha in HEAD) → `branch: undefined`.
  - `gemini-roots.test.ts`: tmp `<home>/.gemini/tmp/<dir>/.project_root` → map has `dir → value`; a dir
    with no sidecar is absent from the map; no `.gemini/tmp` → empty map.
- **VALIDATE**: `npm test -w @420ai/collector -- "git-meta|gemini-roots"` (exit 0).

### Task 13 — CREATE `apps/collector/src/discovery/discover-engine.ts` (+ test)
- **IMPLEMENT**: `discoverWorkspaces({ connectors, home }): Promise<DiscoveredWorkspace[]>` — for each
  connector with `discoverRoots`, gather `RootHint[]`; dedup by `projectKey`; for each hint with a
  `rootPath`, enrich via `readGitMeta(rootPath)` (remote/branch; branch falls back to the hint's); emit
  `DiscoveredWorkspace`. Return the list + a small summary (e.g. gemini-unattributed count) the cli logs.
- **IMPLEMENT test**: inject FAKE connectors returning canned `RootHint[]` + tmp `.git` dirs → assert
  dedup, git enrichment, and that a Gemini hint keeps `projectKey=hash` while `rootPath=realPath`.
- **GOTCHA**: library file — no logging; return data. Inject `home` + the connector list for tests.
- **VALIDATE**: `npm test -w @420ai/collector -- discover-engine` (exit 0).

### Task 14 — UPDATE `apps/collector/src/ingest-client.ts`: add `postDiscover`
- **IMPLEMENT**: `postDiscover(url, token, req: DiscoverRequest): Promise<DiscoverResponse>` mirroring
  `postIngest` (POST `/v1/workspaces/discover`, `Authorization: Bearer`, `expectOk`, return parsed JSON).
- **GOTCHA**: reuse `expectOk`/`IngestHttpError`; do not reinvent error handling. Update
  `ingest-client.test.ts` with a stub asserting the POST shape + bearer.
- **VALIDATE**: `npm test -w @420ai/collector -- ingest-client` (exit 0).

### Task 15 — UPDATE `apps/collector/src/cli.ts`: `discover` + `projects` commands
- **IMPLEMENT**:
  - `runDiscover(opts: { url?; token? }): Promise<DiscoverResponse>` — `requireCredentials()`,
    `discoverWorkspaces({ connectors, home: homedir() })`, `postDiscover(...)`, return the response.
  - `runProjects(opts: { url?; token? }): Promise<…>` — GET `/v1/projects` (admin token via `--token` or
    creds) and print id/name/remote + summary. (If admin-only, document that `projects` needs the admin
    token; discovery uses the machine token.)
  - Wire into `main()`: `collector discover` (prints "discovered N workspaces, created M projects",
    gemini-unattributed count); `collector projects` (lists). Extend `usage()`.
- **PATTERN**: existing `runWatch`/`runSync`/`runPush` (pure exported fn) + thin `main()`; only `main()`
  logs/exits. Mirror their arg parsing.
- **GOTCHA**: the daemon (`watch`) is NOT changed. `discover` is a one-shot ops command. Keep all M1–M4
  commands unchanged.
- **VALIDATE**: `npm test -w @420ai/collector -- cli` (existing CLI tests green; add a `discover`-parses
  test if the suite asserts command routing).

### Task 16 — UPDATE README "Status" + run the gate
- **UPDATE** README Status to note M5 added Project/Workspace mapping (discovery + auto-create + resolver;
  headless; UI deferred to a dashboard milestone). Brief — do not re-paste conventions.
- **VALIDATE (the gate)**: `npm run repo-health` (root `tsc -b` + full `vitest run` + NUL-byte scan +
  stray-artifact scan; exit 0). This is the enforced pre-commit gate (CLAUDE.md). With DB up, also run
  the Postgres-gated int suite (Level 3 below).

---

## TESTING STRATEGY

### Unit Tests (co-located `*.test.ts`, no infra — always run)
- `git-meta`: remote+branch parse; no `.git`; detached HEAD.
- `gemini-roots`: sidecar read; missing sidecar skipped; no tmp dir.
- `discover-engine`: dedup by projectKey; git enrichment; Gemini hash→path preserved.
- connectors: `discoverRoots` returns the correct distinct roots; `projectKey` matches `parse`'s
  `projectPath` byte-for-byte (shared-fixture assertion).
- shared `discovery`: type/shape (+ any pure normalizer).
- ingest-client: `postDiscover` POST shape + bearer.

### Integration Tests (`*.int.test.ts`, `DATABASE_URL_TEST`-gated, excluded from `tsc -b`)
- `packages/db/.../workspaces.int.test.ts`: upsert/key/resolve/remap; cross-machine unify by remote;
  Gemini hash key resolves; `projectEventSummary` join counts events.
- `apps/ingest/.../app.int.test.ts` additions: pair → discover (2 same-remote Claude + 1 Gemini) →
  1 project; admin list/rename/remap; admin endpoints 401 without admin token; discover idempotent on
  re-POST (no duplicate workspaces/projects).

### Edge Cases (must be covered)
- Re-running `discover` is idempotent (upserts; no duplicate workspaces, projects, or keys).
- A workspace whose root is NOT a git repo → `gitRemote` undefined → project named from folder basename;
  two such (different folders) are NOT unified.
- Gemini dir with no `.project_root` → not emitted; counted as unattributed (gap surfaced, not an error).
- `resolveWorkspaceId` for an unknown `project_key` → `undefined` (events stay unattributed, no throw).
- Path with trailing slash / case differences: `project_key` is matched verbatim to `events.project_path`
  — assert the connector emits the SAME string at discovery and capture (no normalization drift).
- Two connectors reporting the SAME real root (e.g. Claude + Codex in the same repo) → two
  `workspace_keys` rows (different `project_key`? same if both use the real path) but ONE workspace.

---

## VALIDATION COMMANDS

Run from the repo root. Each is a GATE with the stated pass signal.

### Level 1: Typecheck / Build (repo-root — catches cross-project + test-only imports)
- `npm run typecheck` → root `tsc -b`, **exit 0**. (Per-workspace build is NOT a substitute.)

### Level 2: Unit Tests
- `npm test` → full `vitest run`; units always run, `*.int.test.ts` self-skip without `DATABASE_URL_TEST`.
  **All pass, exit 0.**
- Focused: `npm test -w @420ai/collector -- "git-meta|gemini-roots|discover-engine|connectors|cli"`;
  `npm test -w @420ai/shared`.

### Level 3: Integration Tests (Postgres)
- `npm run db:up && npm run db:migrate && DATABASE_URL_TEST=postgres://420ai:420ai@localhost:5433/420ai_test npm test`
  → the new `0001` migration applies; db-repo + ingest discover/resolve int tests pass. **Exit 0.**
  (Confirm the M5 migration is applied by `db:migrate` before the int run.)

### Level 4: Manual Validation (real data, read-only-ish)
- With a paired archive: `npx tsx apps/collector/src/cli.ts discover` → prints discovered workspace count
  + projects created + gemini-unattributed count. Re-run → idempotent (0 new). Then `collector projects`
  → your real repos appear, one project each; the 420AI repo's Gemini sessions (the `420ai` slug dir with
  `.project_root`) attribute to the same project as its Claude/Codex sessions.
- Spot-check: a project's `/summary` event count is non-zero for a repo you actually used.

### Level 5: The enforced gate
- `npm run repo-health` → typecheck + full vitest + NUL-byte scan + stray-artifact scan. **Exit 0.**
  Pre-commit hook runs the fast subset; the migration SQL + meta are tracked text (not stray artifacts).

---

## ACCEPTANCE CRITERIA

- [ ] `projects`, `workspaces`, `workspace_keys` tables exist via a generated `0001_*.sql` migration; the
      `events` table is UNCHANGED (attribution is a join — D5).
- [ ] `npm run db:migrate` applies the new migration cleanly on a fresh DB.
- [ ] `POST /v1/workspaces/discover` (machine-authed) upserts workspaces, records `workspace_keys`, and
      auto-creates one project per workspace, unifying by git remote across machines; idempotent on re-POST.
- [ ] Admin endpoints (`GET/POST /v1/projects`, `PATCH /v1/projects/:id`, `GET /v1/workspaces`,
      `PATCH /v1/workspaces/:id`, `GET /v1/projects/:id/summary`) work and 401 without the admin token.
- [ ] Collector `discover` enumerates roots from all three connectors, enriches git remote/branch from
      `.git` files (no subprocess), reverse-maps Gemini via `.project_root`, and POSTs them; `projects`
      lists the result.
- [ ] Gemini sessions WITH a `.project_root` attribute to the right project; sidecar-less legacy sessions
      are reported as unattributed (gap), not errored. The `gemini-cli` `knownGap` is updated.
- [ ] `resolveWorkspaceId` + `projectEventSummary` correctly join `events.project_path` (path OR hash) to
      a project; unknown keys resolve to undefined (no throw).
- [ ] No change to the fingerprint, event wire types, encryption split, or any connector `parse`.
- [ ] `npm run repo-health` passes (exit 0); no stray artifacts, no NUL bytes. Postgres int suite passes
      with `DATABASE_URL_TEST`.

---

## COMPLETION CHECKLIST

- [ ] All tasks completed in order; each task's VALIDATE passed immediately (paste exit codes).
- [ ] Migration generated by drizzle-kit (not hand-written) and applied by `db:migrate`.
- [ ] Full suite passes (unit always; integration with `DATABASE_URL_TEST`).
- [ ] Manual `discover` run on real data attributed your repos (incl. a Gemini-via-sidecar session).
- [ ] Deferred scope honored (no dashboard; no materialized projections — that's M6; no outcome
      attribution; legacy Gemini hashes left unattributed with a recorded gap).
- [ ] README Status updated. `npm run repo-health` green.

---

## NOTES

**Why a join, not a `project_id` on events (D5):** events are disposable projections (PRD §23); baking
attribution into them would require a backfill on every remap and re-parse, and contradict
"events re-buildable." The `workspace_keys` alias table makes attribution a pure join that M6
materializes — and makes remapping a project a single-row update with no event rewrite.

**Why `.project_root` and not hash-cracking (D3 / PRE-FLIGHT #3):** the Gemini `projectHash` algorithm is
unconfirmed and the on-disk evidence shows slug-named (sidecar) and hash-named (no sidecar) dirs are
disjoint generations — no matched oracle exists to confirm an algorithm, and every hash variant tried
missed. The sidecar is the reliable, forward-compatible reverse-map. Revisit hash recovery only if
Gemini's source pins the algorithm (not required for M5).

**Discovered out-of-scope issues (file follow-ups, do NOT fix in M5):**
- The Gemini M4 connector globs `session-*.json`, but the store ALSO has 136 `session-*.jsonl` files
  (newer format) that are NOT captured — an M4 capture gap, larger than mapping. Capture it as a separate
  ticket / next-connector-pass; M5 only maps what is captured.
- ~60 of 71 captured Gemini `.json` sessions live in hash-only dirs (no sidecar) and remain unattributed.

**Cross-machine identity:** project unification is by `git_remote`. A repo with no remote (local-only)
gets a folder-named project per machine — acceptable for V1; the user can merge via remap. Merging
projects (combining two) is deferred.

**Server-side alternative considered + rejected:** discovering distinct `project_path`s by querying
`events` server-side (no collector scan) gives paths but cannot enrich git remote or reverse-map Gemini
hashes (both need machine-local files). Collector-side discovery is required for those; the server query
is a fine future optimization for "which projectKeys exist but are unmapped."

**Confidence score: 8.5/10.** The novel risk (Gemini reverse-map) is `[VERIFIED]` retired via the
`.project_root` sidecar, and the server/db work is a faithful repeat of M2's proven table+migration+route+
int-test pattern. The −1.5 reflects the irreducible first-write of: the Drizzle migration round-trip on
this machine (run the recommended quick spike), the `project_key` byte-for-byte match invariant between
discovery and capture (guarded by a shared-fixture test — get this wrong and the join silently returns
nothing), and the discovery enumeration cost across many real sessions (cheap-metadata-read discipline in
D2). All are covered by the validation ladder.
