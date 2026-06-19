# Feature: Git Outcomes & Attribution (V1 close-out Slice 1 — PRD §11.3 + §11.4)

The following plan should be complete, but it is important that you validate documentation and
codebase patterns and task sanity before you start implementing. Pay special attention to the naming
of existing utils, types, and models — import from the right files.

> **Conventions are NOT re-pasted here.** `CLAUDE.md` (repo root) is the source of truth for module
> rules, the validation gate, and the DB/Drizzle gotchas. Read it first. This plan links to it.

## Feature Description

Capture **Git outcomes** (commits, diffs, changed-file stats, reverts) per repository and **attribute**
AI coding sessions to those commits with an explicit confidence level. This restores the README's
headline value proposition — *"correlate AI activity with Git outcomes"* — which a code-vs-PRD
reconciliation (SUMMARY.md §4, 2026-06-19) found was deferred-by-drift (punted M4→M6→"its own later
slice") and **never built**. The user's confirmed scope is **FULL §11.3/§11.4**.

## User Story

```
As a developer tracking my AI coding spend and outcomes
I want each project's git commits captured and linked to the AI sessions that likely produced them
So that I can see which AI work actually shipped code — with honest confidence, never as fact
```

## Problem Statement

The archive captures AI sessions (tokens, cost, tool calls, files touched) but has **zero git-outcome
data**. There is no commit capture, no diff/line-count capture, and no session→commit linking. The
event taxonomy *names* `git.commit.detected`/`git.diff.detected` but **no connector emits them** and
**no table stores them**. `projectGitMetadata` only surfaces `git_branch` already stamped on tool
events — it is **not** the missing piece (correct that mental model: git *commits* are genuinely new
data, not "empty plumbing waiting to be filled").

## Solution Statement

Add a **dedicated git-outcome capture path** that mirrors three proven precedents rather than inventing
machinery:

1. **Dedicated plaintext tables** (`git_commits`, `git_commit_files`) + a **dedicated machine-authed
   endpoint** (`POST /v1/git`) — exactly as M7 stores reports in `report_artifacts` (NOT as
   `report.generated` events; "Scope Decision 2") and M5 discovers via `POST /v1/workspaces/discover`
   (NOT via `/v1/ingest`). **`/v1/ingest`, the `events` table, and the fingerprint stay UNTOUCHED.**
2. **The commit SHA is the idempotency key** (git's own content hash) — `onConflictDoNothing` on
   `(machine_id, commit_sha)`. Re-scanning a repo is a no-op. This is the git analogue of the event
   fingerprint (PRD §23 idempotency, with zero new fingerprint logic).
3. **Attribution as a persisted side-table** (`session_git_links`, M5's "D5 — attribution is a JOIN,
   never a column" discipline) computed by a server-side heuristic that reuses **M8's decrypt-for-render**
   to read the session's modified-file paths (they live in encrypted event payloads).

Git history is read via a **`git` subprocess** (`node:child_process` `execFile`) — see Design Decision
D1 for why this deviates from M5's `readGitMeta` no-subprocess pattern, and the pre-flight spike that
gates it.

## Feature Metadata

**Feature Type**: New Capability
**Estimated Complexity**: **High** (new capture path + 3 tables/migration + new endpoints + a
decrypt-for-render attribution heuristic; the single largest V1 close-out slice)
**Primary Systems Affected**: `packages/shared` (types + pure heuristic), `packages/db` (schema +
repos), `apps/ingest` (routes), `apps/collector` (git reader + capture + CLI)
**Dependencies**: **None new** — `git` CLI (assumed present; graceful-degrade if absent) +
`node:child_process` (built-in). Do NOT add `isomorphic-git` or any package (D1).

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**Capture path / collector**
- `apps/collector/src/discovery/git-meta.ts` (whole file) — the **no-subprocess** `.git` reader. You
  REUSE its repo-detection idea but go BEYOND it (D1). Its "NO git subprocess" comment is a *local
  pattern*, not a repo invariant — D1 overrides it for full history.
- `apps/collector/src/connectors/claude-code.ts:97-298` — the parser→raw-records→events emit pattern
  AND `discoverRoots`/`firstClaudeCwd` (lines 300-352): how a connector enumerates project roots. Your
  git sweep enumerates the SAME roots (`event.project_path == cwd == repo root`).
- `apps/collector/src/discovery/discover-engine.ts` (whole file) — the sweep that gathers
  `discoverRoots` across connectors + enriches with `readGitMeta`. **Mirror this** for the git sweep.
- `apps/collector/src/capture-engine.ts:32-98` — the watch loop wiring (`onChange`→queue→sync). Your
  continuous git capture hooks in here on a SLOWER cadence (Task: watch integration).
- `apps/collector/src/cli.ts:208-232` (`runDiscover`) + `:418-431` (the `discover` command block) +
  `:275-309` (`usage`) — **mirror `discover` exactly** for the new one-shot `git` command.
- `apps/collector/src/ingest-client.ts` (read for `postDiscover`/`postIngest` shape) — add `postGit`.

**Wire types / shared**
- `packages/shared/src/events.ts` (whole) — `EventType` union + `NormalizedEvent`. **Do NOT add git
  types to the `EventType` union** (no `NormalizedEvent` will use them — see D2/D4). Update only the
  doc comment to note git outcomes are a dedicated projection (M7-style).
- `packages/shared/src/discovery.ts` (whole) — the M5 wire-type module shape to mirror for a new
  `git.ts` (pure types + a pure helper, dependency-free).
- `packages/shared/src/fingerprint.ts` (whole) — DO NOT touch. Read it only to confirm the SHA-as-key
  rationale (you are NOT adding a new fingerprint).
- `packages/shared/src/index.ts` — barrel; add `export * from "./git.js";`.

**DB**
- `packages/db/src/schema.ts:105-262` — `events`, the M5 `projects`/`workspaces`/`workspace_keys`
  tables, and **M7 `report_artifacts`** (the dedicated-table + encryption-split precedent, lines
  221-262). Mirror the table style (uuid pk, `withTimezone`, `mode:"string"` for ts you order on,
  unique/index tuples).
- `packages/db/src/repositories/ingest.ts` (whole) — how raw+events encrypt at the write boundary
  (`encryptField`) and dedup (`onConflictDoNothing`/`onConflictDoUpdate`). Your `recordGitCommits`
  mirrors this for `git_commits`.
- `packages/db/src/repositories/workspaces.ts` (whole) — `upsertWorkspace` (onConflict), the D5
  attribution join (`resolveWorkspaceId`, `projectEventSummary`), "scope every query by userId".
- `packages/db/src/repositories/projections.ts` (whole) — the Drizzle `sql` aggregate patterns you
  MUST mirror: `::int` casts, `Number()` on `numeric`, `sql.raw` for closed-set keywords, and
  **ISO-normalization** of `max/min(ts)`/`date_trunc` (`new Date(v).toISOString()` — projections.ts:147
  is the canonical example). `projectGitMetadata` (lines 296-310) is the existing git-branch projection.
- `packages/db/src/repositories/transcript.ts` (whole) — **THE decrypt-for-render precedent** for the
  attribution file-overlap. Reuse `decryptField` exactly like this (the join `events.rawRecordId =
  raw_source_records.sourceRecordId AND sessionId`, then `decryptField({ciphertext,iv,tag})`). Note:
  **file paths are in `events.payload_*`** (not raw) — see D5.
- `packages/db/src/crypto.ts` (whole) — `encryptField`/`decryptField` + the `EncryptedField` shape.
- `packages/db/src/index.ts` — barrel; export the new tables, `git.ts` repo fns, and attribution fns.
- `packages/db/drizzle.config.ts` + `packages/db/drizzle/0003_*.sql` + `meta/_journal.json` — migration
  layout. You generate the next migration with `npm run db:generate` (do NOT hand-write SQL).

**Ingest API**
- `apps/ingest/src/routes/workspaces.ts` (whole) — **the canonical pattern to mirror**: a
  machine-authed `POST` (`/v1/workspaces/discover`, `preHandler: app.authenticate`,
  `getMachineUserId`) PLUS admin-gated reads/writes with the **existence-check → 404 (not FK-500)**
  guard (lines 129-139). Your `/v1/git` (machine) + `/v1/projects/:id/git/*` (admin) clone this.
- `apps/ingest/src/routes/projections.ts` (whole) — admin-gated `GET /v1/projects/:id/...` with
  `adminAuthorized` + `isUuid → 404`. Clone for `GET /v1/projects/:id/git/commits` and `/git/links`.
- `apps/ingest/src/routes/ingest.ts` (whole) — the minimal machine-authed write route shape.
- `apps/ingest/src/schemas.ts` (whole) — Fastify JSON-schema bodies (no zod). Add `gitCaptureBodySchema`
  + `manualLinkBodySchema` in this style.
- `apps/ingest/src/app.ts:56-67` — register the new `gitRoutes` here (one `app.register` line).
- `apps/ingest/src/auth.ts` (read) — `adminAuthorized`, `isUuid`.

### New Files to Create
- `packages/shared/src/git.ts` — pure git wire types + the pure attribution-confidence helper.
- `packages/shared/src/git.test.ts` — unit tests for the pure helper + payload type guards.
- `apps/collector/src/discovery/git-reader.ts` — `git` subprocess reader (`execFile`) → `GitCommit[]`.
- `apps/collector/src/discovery/git-reader.test.ts` — parser tests over a **fixture** `git log` blob
  (NO live git in unit tests — feed the reader captured stdout; see Testing).
- `apps/collector/src/discovery/git-capture.ts` — sweep: enumerate roots → readGitLog per repo → build
  `GitCommitPayload[]`. (Library: pure of process concerns.)
- `apps/collector/src/discovery/git-capture.test.ts`
- `packages/db/src/repositories/git.ts` — `recordGitCommits`, `gitCommitsByProject`, `gitCommitDetail`.
- `packages/db/src/repositories/attribution.ts` — `computeSessionGitSuggestions`, `addManualLink`,
  `setLinkStatus`, `listProjectLinks`, `sessionModifiedPaths` (decrypt-for-render).
- `apps/ingest/src/routes/git.ts` — the git capture + attribution endpoints.
- `packages/db/drizzle/0004_*.sql` — **generated** by `npm run db:generate` (do not hand-write).
- Integration tests: `packages/db/src/repositories/git.int.test.ts`,
  `apps/ingest/src/git.int.test.ts` (mirror `app.int.test.ts` / `workspaces.int.test.ts` setup).

### Relevant Documentation
- `docs/PRD.md` §11.3 (Git Outcome Tracking — note **Git Diff Capture / full patches is explicitly
  OPTIONAL per-project**), §11.4 (Outcome Attribution + **Attribution Confidence**), §12 (Event Model),
  §18.1 (encryption split), §23 (replay/idempotency).
- `SUMMARY.md` §4 "Q4" (the V1 attribution decision: **manual link + ONE heuristic** — same repo +
  commit within X min of session end + ≥1 file overlap → low/med confidence; **defer the weighted
  scorer**) and the 2026-06-19 close-out decision.
- `.agents/plans/m5-project-workspace-mapping.md` §D5 (attribution is a JOIN/side-table).

### Patterns to Follow
- **Naming**: `kebab-case.ts`, `PascalCase` types, `camelCase` fns, `snake_case` SQL (CLAUDE.md).
- **Silent libraries**: repos/readers THROW typed errors, never log/exit. Only `cli.ts`/`server.ts`
  log+exit (CLAUDE.md "Logging / process boundaries").
- **Scope every DB query by `userId`** (workspaces.ts pattern).
- **Existence-check before an FK write** → 404, never a constraint-500 (workspaces.ts:129-139; CLAUDE.md
  M6–M9 gotcha). Applies to `/v1/git` (machine exists via auth), `session_git_links` writes (project +
  commit must exist), and the suggest endpoint (project must exist).
- **DB aggregate gotchas** (CLAUDE.md "Drizzle / SQL"): `count(...)::int`, `Number()` a `numeric`,
  `sql.raw` for closed-set keywords, and **ISO-normalize** any `max/min`/`date_trunc` over a
  `mode:"string"` timestamptz. Every illustrative snippet below already obeys these.

---

## IMPLEMENTATION PLAN

### Phase 0 — PRE-FLIGHT SPIKE (gate; do this FIRST, do not skip)

Prove the **tooling**, not just the pattern (CLAUDE.md / skill rule):

1. **`git` resolves**: run `git --version`. If absent, the feature degrades (capture returns `[]`); but
   for THIS dev machine confirm it is present so the manual validation (Level 4) can run.
2. **Pin the exact `git log` invocation + parse it.** Run THIS against the repo root and capture stdout:
   ```bash
   git -C . log -n 5 --numstat --date=iso-strict \
     --format='%x1fCOMMIT%x1f%H%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%P%x1f%s%x1f%b%x1e'
   ```
   - `\x1f` (unit sep) delimits fields, `\x1e` (record sep) ends the header line — this survives commit
     messages with newlines/pipes/commas. After the header line, `--numstat` prints `ins\tdel\tpath`
     rows until the next record. Verify the parse on a **merge commit** (two `%P` parents,
     `--numstat` may be empty) and a commit that **renames** a file (`old => new` path form — normalize).
   - **Revert detection**: `%s` starting with `Revert ` OR a `This reverts commit <sha>` line in `%b`.
3. **`execFile` (built-in)**: confirm `import { execFile } from "node:child_process"` + `promisify`
   works (no dependency). Use the **arg-array** form (no shell) → no injection from repo paths.
4. **Path normalization**: confirm `git_commit_files.file_path` is **repo-relative** (`src/x.ts`) while
   session `file.modified` paths are **absolute** (`C:\...\repo\src\x.ts` / `/home/.../src/x.ts`).
   Pin the overlap rule: `absoluteSessionPath` matches `repoRelative` iff
   `normalize(abs).endsWith(normalize(join(repoRoot, rel)))` (handle `\`/`/`).
5. **Decrypt-for-render reachability**: confirm a `file.modified` event stores `{path}` in
   `events.payload_*` (claude-code.ts:258-263 + ingest.ts:51) so `decryptField` yields `{"path": "..."}`.
   (This needs the test DB; assert it in `git.int.test.ts`, not a unit test.)

Write findings inline in this plan's NOTES or a scratch comment before coding. If `git log` format
differs from the assumption, **fix the parser tasks below to match the spike**, not the other way.

### PHASE-0 SPIKE FINDINGS — VERIFIED on this repo 2026-06-19 (DONE — do not re-run, just honor)

- **Tooling present**: `git version 2.54.0.windows.1`; `node:child_process.execFile` is built-in (no
  dep). Repo HEAD = **58 commits** total → `cap=500` reads full history; `capped` will be false here
  (still implement the cap+log for large repos elsewhere).
- **The pinned format string works** exactly as written. Verified per-record layout:
  `\x1fCOMMIT\x1f<sha>\x1f<an>\x1f<ae>\x1f<aI>\x1f<cI>\x1f<parents>\x1f<subject>\x1f<body>\x1e\n<numstat
  rows>\n` — i.e. the `\x1e` (RS) terminates the **header**, then a newline, then the `ins\tdel\tpath`
  numstat block, then the next record's `\x1fCOMMIT\x1f`.
- **PARSE STRATEGY (refined — use THIS, supersedes a naive `split('\x1e')`)**: split the whole stdout on
  the literal delimiter **`"\x1fCOMMIT\x1f"`** → drop the empty leading element → each block is
  `"<sha>\x1f<an>\x1f<ae>\x1f<aI>\x1f<cI>\x1f<parents>\x1f<subject>\x1f<body>\x1e<newline><numstat>"`.
  Then `block.split("\x1f")` for the 7 header fields where the **last field** is `"<body>\x1e<numstat
  block>"` → split THAT on `"\x1e"` → `[body, numstatText]`. This is robust because `\x1fCOMMIT\x1f`
  (two US control bytes around `COMMIT`) cannot occur inside a commit message. Numstat lines =
  `numstatText.trim().split("\n")`, each `ins\tdel\tpath`.
- **Merge commits emit NO numstat rows** (verified on `9ef9ec0`, two `%P` parents, zero file rows). So a
  merge → a valid commit row with `filesChanged=0, insertions=0, deletions=0` and an **empty files
  array**. Do NOT pass `-m`/`--first-parent` — the real code lands in the child non-merge commits, which
  ARE captured; the merge is a harmless 0-stat marker. The parser must tolerate an empty numstat block.
- **Binary files** → numstat row is `-\t-\t<path>` (verified, e.g. `app-icon.png`). Map `-` ins/del to
  **0** (never `NaN`).
- **Renames** appear in numstat as the path with a `old => new` / `{prefix => prefix2}` form when content
  is unchanged; here the rename commit also changed content so it showed the plain new path. Parser MUST
  detect ` => ` in the path field and take the **new** path (strip `{...}` brace groups).
- **Empty body is normal** (verified on `fdd72a8`: `%b` was empty → adjacent `\x1f\x1e`). Body field may
  be `""`.
- **Author can be a bot** (`copilot-swe-agent[bot]`, email `...+Copilot@users.noreply.github.com`) — store
  verbatim plaintext; brackets/`+` cause no parse issue (US-delimited).
- **Timestamp forms vary**: `--date=iso-strict` yields offset form `2026-06-16T12:49:10-04:00`, and some
  commits show `...Z`. Both are valid ISO 8601 — store the string verbatim (`mode:"string"`); for the
  attribution window use `new Date(aI).getTime()` (parses both).

### Phase 1 — Foundation (shared types + schema + migration)
- `packages/shared/src/git.ts`: payload + projection types + the pure confidence helper.
- `packages/db/src/schema.ts`: `gitCommits`, `gitCommitFiles`, `sessionGitLinks`.
- `npm run db:generate` → review `drizzle/0004_*.sql` (3 `CREATE TABLE` + indexes, **additive**; no
  ALTER to `events`/`raw_source_records`).

### Phase 2 — Core (collector reader/capture + db repos)
- `git-reader.ts` (subprocess + parser), `git-capture.ts` (sweep), `repositories/git.ts`,
  `repositories/attribution.ts`.

### Phase 3 — Integration (ingest routes + collector CLI/watch + barrels)
- `routes/git.ts` + register, schemas, `postGit` client, `collector git` command, watch-loop cadence.

### Phase 4 — Testing & Validation
- Unit (reader parser, confidence helper, capture sweep) + integration (capture→tables, suggest→links,
  decrypt-overlap) + the `--require-db` gate.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Each task is atomic and independently validated.

### 1. CREATE `packages/shared/src/git.ts`
- **IMPLEMENT**: Pure, dependency-free module (mirror `discovery.ts`):
  - `GitFileChange { path: string; status: "added"|"modified"|"deleted"|"renamed"; insertions: number; deletions: number }`
  - `GitCommitPayload { commitSha: string; repoRootPath: string; gitBranch?: string; authorName: string; authorEmail: string; authoredAt: string /*ISO*/; committedAt: string; message: string; parents: string[]; isRevert: boolean; filesChanged: number; insertions: number; deletions: number; files: GitFileChange[] }`
  - `GitCaptureRequest { commits: GitCommitPayload[] }`, `GitCaptureResponse { commitsInserted: number }`
  - `GitCommitRow` (projection: plaintext fields the API returns; NO message/patch), `SessionGitLink { sessionId: string; commitSha: string; projectId: string|null; confidence: AttributionConfidence; status: "suggested"|"confirmed"|"rejected"; minutesDelta: number|null; fileOverlap: number; }`
  - `type AttributionConfidence = "high"|"medium"|"low"|"manual"`
  - `const ATTRIBUTION_WINDOW_MINUTES = 30` (exported; the §11.4 time window)
  - **Pure helper** (the §11.4 heuristic core, DB-free + unit-testable):
    ```ts
    export function suggestConfidence(p: { minutesDelta: number; fileOverlap: number }): AttributionConfidence | null {
      if (Math.abs(p.minutesDelta) > ATTRIBUTION_WINDOW_MINUTES) return null; // out of window → no suggestion
      return p.fileOverlap >= 1 ? "medium" : "low"; // Q4: low/med only; manual/high set elsewhere
    }
    ```
- **GOTCHA**: Do NOT import anything (keeps `@420ai/shared` dep-free). `authoredAt`/`committedAt` are
  ISO strings end-to-end (no `Date`).
- **VALIDATE**: `npm run typecheck`

### 2. UPDATE `packages/shared/src/index.ts` + `events.ts` doc
- **ADD**: `export * from "./git.js";` (barrel).
- **UPDATE** `events.ts` header comment ONLY: note `git.commit.detected`/`git.diff.detected` are
  materialized as the dedicated `git_commits` projection (M7 Scope-Decision-2 style), **not** rows in
  the `events` table — so they are intentionally absent from the `EventType` union. Do NOT change the union.
- **VALIDATE**: `npm run typecheck`

### 3. CREATE `packages/shared/src/git.test.ts`
- **IMPLEMENT**: table-driven tests for `suggestConfidence` (in-window+overlap→medium; in-window+0→low;
  out-of-window→null; negative delta symmetric) + a shape sanity test for a `GitCommitPayload` literal.
- **VALIDATE**: `npx vitest run packages/shared/src/git.test.ts`

### 4. ADD tables to `packages/db/src/schema.ts`
- **IMPLEMENT** (mirror `report_artifacts` style; **additive only**):
  - `gitCommits` (plaintext metadata + encrypted message):
    - `id uuid pk`, `machineId uuid → machines`, `commitSha text notNull`, `repoRootPath text notNull`
      (the join key == `events.project_path`), `gitBranch text`, `authorName text`, `authorEmail text`,
      `authoredAt timestamp({withTimezone:true, mode:"string"}) notNull`, `committedAt timestamp(... mode:"string")`,
      `parents text` (space-joined SHAs), `isRevert boolean notNull default(false)`,
      `filesChanged integer notNull`, `insertions integer notNull`, `deletions integer notNull`,
      `messageCiphertext text`, `messageIv text`, `messageTag text` (encrypted commit message, §18.1),
      `createdAt timestamp(...).defaultNow()`
    - indexes: `uniqueIndex("git_commits_machine_sha").on(machineId, commitSha)` (**idempotency key**),
      `index("git_commits_by_root").on(repoRootPath)` (attribution + project join)
  - `gitCommitFiles` (plaintext path + numstat; patch deferred):
    - `id uuid pk`, `commitId uuid → gitCommits`, `filePath text notNull`, `status text notNull`,
      `insertions integer notNull`, `deletions integer notNull`
    - index: `index("git_commit_files_by_commit").on(commitId)`
  - `sessionGitLinks` (the attribution side-table; D5):
    - `id uuid pk`, `userId uuid → users`, `sessionId text notNull`, `commitId uuid → gitCommits`,
      `projectId uuid → projects` (nullable), `confidence text notNull`, `status text notNull`,
      `minutesDelta integer`, `fileOverlap integer notNull default(0)`,
      `createdAt timestamp(...).defaultNow()`
    - index: `uniqueIndex("session_git_links_unique").on(userId, sessionId, commitId)` (idempotent
      re-suggest; a manual confirm upserts the same row's status/confidence)
- **GOTCHA**: `authoredAt`/`committedAt` use `mode:"string"` (you order/return them as ISO — never
  coerce; same reason as `events.ts`). Author email is git metadata (public in the repo) → **plaintext**,
  like `project_path` (NOT on the §18.1 encrypt-list). Only the **message** is encrypted (it is a
  "message body" per §18.1; full patch text is deferred per §11.3's "optional" diff capture).
- **VALIDATE**: `npm run typecheck` (the `$type`/Drizzle column types compile)

### 5. GENERATE migration
- **RUN**: `npm run db:generate` → produces `packages/db/drizzle/0004_<name>.sql` + a `meta/0004_snapshot.json`.
- **VALIDATE**: open the SQL — confirm it is **3 `CREATE TABLE` + indexes only**, with **no `ALTER`/`DROP`**
  touching `events`, `raw_source_records`, `projects`, `workspaces`, `workspace_keys`, or
  `report_artifacts`. Then `npm run db:up && npm run db:migrate` applies cleanly (exit 0).

### 6. UPDATE `packages/db/src/index.ts` barrel
- **ADD**: export `gitCommits, gitCommitFiles, sessionGitLinks` from `./schema.js`; export the new repo
  fns (Task 7/8) and their row types.
- **VALIDATE**: `npm run typecheck`

### 7. CREATE `packages/db/src/repositories/git.ts`
- **IMPLEMENT** (silent library; mirror `ingest.ts` encryption-at-write + `onConflictDoNothing`):
  - `recordGitCommits(db, machineId, req: GitCaptureRequest): Promise<{ commitsInserted: number }>` —
    in ONE transaction, per commit: `encryptField(message)`; insert `git_commits`
    `.onConflictDoNothing({ target: [gitCommits.machineId, gitCommits.commitSha] }).returning({id})`;
    only if a row was inserted, bulk-insert its `git_commit_files`. (Re-capture = no-op, no dup files.)
  - `gitCommitsByProject(db, projectId): Promise<GitCommitRow[]>` — join
    `git_commits.repo_root_path = workspace_keys.project_key` → `workspaces.project_id = projectId`
    (the SAME D5 join projections.ts uses). Return plaintext fields only (NO message). Order by
    `authoredAt desc` (it is `mode:"string"` ISO — return verbatim, do NOT `new Date()` it).
  - `gitCommitDetail(db, machineId, commitSha)` — one commit + its files (for the link/manual path).
- **GOTCHA**: `commitsInserted` counts only `.returning()` rows (dedup-aware, like `ingestBatch`).
  Scope reads by the project join (not userId directly — `git_commits` has no userId; it attributes via
  `repo_root_path → workspace_keys`). Any `count(...)` → `::int`.
- **VALIDATE**: `npm run typecheck`

### 8. CREATE `packages/db/src/repositories/attribution.ts`
- **IMPLEMENT** (the §11.4 heuristic; reuse M8 decrypt precedent):
  - `sessionModifiedPaths(db, sessionId): Promise<string[]>` — select `file.modified`/`file.read`
    events for the session that HAVE a payload, `decryptField({ciphertext: events.payloadCiphertext,
    iv: events.payloadIv, tag: events.payloadTag})`, `JSON.parse`, collect `.path` (dedupe). **This is
    the second decrypt-for-render read after transcript.ts — cite it.** Throws on key error (silent lib).
  - `sessionEndTs(db, sessionId)` — `max(events.ts)` for the session (ISO string, `mode:"string"` — no
    coercion needed; it is already ISO).
  - `computeSessionGitSuggestions(db, userId, sessionId): Promise<SessionGitLink[]>`:
    1. resolve the session's `project_path` + `projectId` (D5 join) and `sessionEndTs`.
    2. candidate commits = `git_commits` for the same repo root within `±ATTRIBUTION_WINDOW_MINUTES`
       of `sessionEndTs` (compare ISO via `authoredAt` between bounds — compute bounds in JS:
       `new Date(end).getTime() ± window*60000` → `.toISOString()`).
    3. for each candidate: `fileOverlap = |sessionModifiedPaths ∩ commitFiles|` using the **Phase-0
       path-normalization rule** (absolute endsWith join(root, relative)); `minutesDelta =
       (authoredAtMs - endMs)/60000`; `confidence = suggestConfidence({minutesDelta, fileOverlap})`.
    4. skip nulls; upsert each surviving suggestion into `session_git_links`
       `.onConflictDoUpdate(target: [userId, sessionId, commitId])` with `status:"suggested"` —
       **but PRESERVE a prior `confirmed`/`rejected`** (do not overwrite a human decision: in the
       conflict `set`, only update confidence/overlap/minutesDelta, and set status to `suggested`
       **only when the existing status is null** — implement by reading existing status first OR a
       `where` guard; simplest: `onConflictDoNothing` for status, separate update of the metric fields).
  - `addManualLink(db, userId, sessionId, commitId, projectId)` — upsert with `confidence:"manual",
    status:"confirmed"` (existence of commit + project checked in the route → 404).
  - `setLinkStatus(db, userId, linkId, status)` — confirm/reject a suggestion.
  - `listProjectLinks(db, projectId): Promise<SessionGitLink[]>` — links whose commit's repo maps to
    the project.
- **CONFLICT RESOLUTION (explicit — do not ship both)**: the suggest path MUST NOT clobber a
  human-set `manual`/`confirmed`/`rejected` link. The unique key is `(userId, sessionId, commitId)`.
  **Rule that wins**: a re-run of `computeSessionGitSuggestions` refreshes `fileOverlap`/`minutesDelta`/
  `confidence` for rows it owns but **never changes `status` away from `confirmed`/`rejected`**. If
  this is awkward in one upsert, do: `insert ... onConflictDoNothing`, then `update ... set {metrics}
  where status = 'suggested'`.
- **GOTCHA**: time math in JS (ms), not SQL `interval` (keeps the window injectable + testable). The
  decrypt is per-session, capped implicitly by the session's file-event count; no global cap needed,
  but if a session has >1000 file events, that is fine (paths are small).
- **VALIDATE**: `npm run typecheck`

### 9. CREATE `apps/collector/src/discovery/git-reader.ts`
- **IMPLEMENT**: `readGitLog(repoRoot: string, opts?: { cap?: number }): Promise<GitCommit[]>`
  (internal `GitCommit` ≈ `GitCommitPayload` minus `repoRootPath`/`gitBranch`, which the caller adds).
  - `execFile("git", ["-C", repoRoot, "log", "-n", String(cap ?? 500), "--numstat",
    "--date=iso-strict", "--format=<PINNED from Phase 0>"], { maxBuffer: 64*1024*1024 })`.
  - Parse stdout using the **VERIFIED Phase-0 parse strategy** (split on `"\x1fCOMMIT\x1f"`, then per
    block split header fields on `\x1f`, then split the last field on `\x1e` into `[body, numstatText]`).
    Map `status` from the numstat row (`-\t-` → binary, 0/0; ` => ` → rename, take new path); set
    `isRevert` (subject starts `Revert ` or body has `This reverts commit`). Sum
    `filesChanged/insertions/deletions`. **Merges have an empty numstat block → 0 files (valid).**
  - Export the pure parser as `parseGitLog(stdout: string): GitCommit[]` so Task 11 can unit-test it
    with the captured fixture (no live git).
  - **Graceful degrade**: wrap in try/catch — `ENOENT` (git missing) or non-zero exit (not a repo)
    → return `[]`. NEVER throw out of the sweep (a non-repo root is normal). Library file: no logging.
  - **No-silent-cap (CLAUDE.md)**: if `git rev-list --count` (or a full-history sentinel) shows more
    than `cap` commits exist beyond what was read, surface it via the return (e.g. a `capped: true`
    flag the CLI logs) — do not silently drop.
- **GOTCHA**: `execFile` arg-array (NOT `exec` with a string) → no shell injection from `repoRoot`.
  `--numstat` reports binary files as `-\t-\t<path>` → treat as 0/0. Renames `old => new` → take the
  new path.
- **VALIDATE**: `npm run typecheck` (runtime exercised in Task 11 test via fixture)

### 10. CREATE `apps/collector/src/discovery/git-capture.ts`
- **IMPLEMENT**: `captureGitCommits(opts: { connectors, home, readLog?: typeof readGitLog }):
  Promise<{ commits: GitCommitPayload[]; reposScanned: number; capped: number }>` —
  - Enumerate distinct roots via the SAME `discoverRoots` sweep `discover-engine.ts` uses (reuse
    `discoverWorkspaces` to get `{rootPath}` list, OR factor the root-enumeration out and share it).
  - For each resolved `rootPath`: `readGitMeta(rootPath)` for the branch + `readLog(rootPath)`; build
    `GitCommitPayload[]` (`repoRootPath = rootPath` so it matches `events.project_path`/`project_key`).
  - Inject `readLog` for tests (default = real `readGitLog`), mirroring `syncOnce({post})` DI style.
- **GOTCHA**: `repoRootPath` MUST be byte-for-byte the connector's `projectKey`/`cwd` (the join
  invariant — discovery.ts:21 comment). Use the resolved root exactly as discovery emits it.
- **VALIDATE**: `npm run typecheck`

### 11. CREATE reader/capture unit tests
- **IMPLEMENT**:
  - `git-reader.test.ts`: feed a **captured `git log` stdout fixture string** (from Phase 0) to the
    pure parser portion (refactor parsing into an exported `parseGitLog(stdout): GitCommit[]` so the
    test needs NO live git). Cover: multi-file commit, merge (empty numstat), rename, binary (`-/-`),
    revert, multiline message.
  - `git-capture.test.ts`: inject a fake `readLog` + a 2-connector `discoverRoots` stub; assert
    `repoRootPath == projectKey`, dedupe across connectors, `capped` propagation.
- **GOTCHA**: NO subprocess in unit tests (deterministic; CLAUDE.md "no infra — always run").
- **VALIDATE**: `npx vitest run apps/collector/src/discovery/git-reader.test.ts apps/collector/src/discovery/git-capture.test.ts`

### 12. ADD `postGit` to `apps/collector/src/ingest-client.ts`
- **IMPLEMENT**: `postGit(url, token, req: GitCaptureRequest): Promise<GitCaptureResponse>` — mirror
  `postDiscover` (bearer auth, POST `/v1/git`, same error handling incl. `isUnauthorized`).
- **VALIDATE**: `npm run typecheck`

### 13. CREATE `apps/ingest/src/routes/git.ts` + schemas + register
- **IMPLEMENT** (mirror `workspaces.ts` machine+admin split):
  - `POST /v1/git` — **machine-authed** (`preHandler: app.authenticate`, `schema: {body:
    gitCaptureBodySchema}`): `getMachineUserId` guard (401 if none) → `recordGitCommits(app.db,
    request.machineId, request.body)` → 200 `{commitsInserted}`. Idempotent.
  - `GET /v1/projects/:id/git/commits` — **admin** (`adminAuthorized` 401, `isUuid` 404) →
    `gitCommitsByProject`.
  - `GET /v1/projects/:id/git/links` — admin → `listProjectLinks`.
  - `POST /v1/projects/:id/git/suggest` — admin, `isUuid`→404, **existence-check project**
    (`getProjectName` undefined → 404, NOT a 500) → run `computeSessionGitSuggestions` for each session
    in the project (or accept a `{sessionId}` body to scope to one). Return the persisted links.
  - `POST /v1/sessions/:sessionId/git-links` — admin, body `{commitSha}` (`manualLinkBodySchema`):
    resolve `commitId` via `gitCommitDetail`; **existence-check commit → 404** (not FK-500) → `addManualLink`.
  - `PATCH /v1/git-links/:id` — admin, body `{status: "confirmed"|"rejected"}` → `setLinkStatus`.
- **schemas.ts**: add `gitCaptureBodySchema` (array of commit objects: required `commitSha`,
  `repoRootPath`, `authorName`, `authorEmail`, `authoredAt`, `message`, `filesChanged`, `insertions`,
  `deletions`, `files`; permissive on optional) + `manualLinkBodySchema` ({commitSha minLength 1}) +
  `patchGitLinkBodySchema` ({status enum}). Follow the `discoverBodySchema` style (`additionalProperties:false`).
- **app.ts**: `app.register(gitRoutes);` after `workspaceRoutes`.
- **GOTCHA**: every WRITE that adds an FK (`/v1/git` machineId via auth; manual link's commit/project;
  suggest's project) needs an **existence guard → 404**, per the CLAUDE.md M6–M9 write-vs-read gotcha.
- **VALIDATE**: `npm run typecheck`

### 14. ADD the `git` CLI command + watch-loop cadence
- **IMPLEMENT** in `apps/collector/src/cli.ts` (mirror `runDiscover`/`discover` exactly):
  - `runGit(opts: {url?, token?, home?}): Promise<{response: GitCaptureResponse; reposScanned: number; capped: number}>`
    — `resolveCreds`, `captureGitCommits`, `postGit`. Pure of process concerns.
  - a `git` command block: prints `Captured N commits across M repos (K capped — run again / raise cap)`.
  - add `collector git [--url <baseUrl>] [--token <token>]` to `usage()`.
  - **Watch integration**: in `capture-engine.ts`, add an OPTIONAL slow git sweep (e.g. every
    `gitIntervalMs ?? 5*60_000`) alongside the watcher/sync loops, enqueueing nothing (it POSTs via
    `postGit` directly OR enqueues a new `"git"` queue kind — simplest V1: a periodic direct `postGit`
    inside the loop, best-effort, behind the same AbortSignal). Keep it BEST-EFFORT (a git error never
    stops capture). **Arm teardown before the first await** (CLAUDE.md long-lived-resource rule).
- **GOTCHA**: the CLI is the ONLY place that logs/exits. If watch-loop git integration risks scope,
  land the one-shot `git` command first (MUST) and the watch cadence second (SHOULD) — both in this slice.
- **VALIDATE**: `npm run typecheck` + `npx tsx apps/collector/src/cli.ts git` prints usage when unpaired.

### 15. CREATE integration tests
- **IMPLEMENT** (`describe.skipIf(!process.env.DATABASE_URL_TEST)`, reuse `buildApp`/test-DB harness
  from `app.int.test.ts` + `workspaces.int.test.ts`):
  - `packages/db/src/repositories/git.int.test.ts`: `recordGitCommits` inserts commits+files;
    **re-running is a no-op** (`commitsInserted: 0`); `gitCommitsByProject` returns them via the D5 join.
  - `apps/ingest/src/git.int.test.ts`: pair a machine → `POST /v1/git` → 200; `GET
    /v1/projects/:id/git/commits` (admin) returns them; ingest a session with `file.modified` on an
    overlapping path → `POST /v1/projects/:id/git/suggest` → a `medium` link persists;
    `POST /v1/sessions/:id/git-links` manual → `manual`/`confirmed`; re-suggest does NOT clobber it;
    unknown project id → 404 (not 500); the **decrypt-for-render** overlap path actually runs.
- **GOTCHA**: these import across app boundaries → they are **type-stripped, excluded from `tsc -b`**
  (see `apps/collector/tsconfig.json` exclude). Confirm they self-skip with no DB and RUN with it.
- **VALIDATE**: `npm run db:up && npm run db:migrate && npm run repo-health -- --require-db`

### 16. FINAL gate
- **VALIDATE**: `npm run repo-health -- --require-db` (typecheck 0 + full vitest incl. int **0 skipped**
  + NUL/stray scans). Then Level-4 manual (below).

---

## TESTING STRATEGY

### Unit Tests (no infra — always run)
- `suggestConfidence` truth table (window edges, overlap 0 vs ≥1, negative delta symmetry).
- `parseGitLog` over captured fixtures (multi-file, merge/empty-numstat, rename, binary `-/-`, revert,
  multiline message) — **the highest-risk parser; cover it densely.**
- `captureGitCommits` with injected `readLog` + stub `discoverRoots` (root==projectKey, cross-connector
  dedupe, `capped` propagation).

### Integration Tests (self-skip without `DATABASE_URL_TEST`)
- `recordGitCommits` idempotency (re-run → 0 inserted, no dup files).
- End-to-end: `POST /v1/git` → tables → `GET .../git/commits`; suggest → `session_git_links` with
  correct confidence; manual link; re-suggest preserves human status; **decrypt-overlap exercised**;
  unknown ids → 404.

### Edge Cases
- Repo with `git` absent / not a repo → capture returns `[]`, no throw, watch loop unaffected.
- Merge commit (empty numstat) and binary files (`-/-`) → 0/0 stats, no NaN.
- Session with NO overlapping files but in-window commit → `low` (not dropped).
- Commit with no matching `workspace_keys` (git-only repo, no tool sessions) → captured but
  unattributed in `gitCommitsByProject` (counted, not joined) — assert it does not error.
- Renamed file path → new path used; overlap still matches if the session touched the new path.

---

## VALIDATION COMMANDS

All run from the repo root. `repo-health` is the single enforced gate (CLAUDE.md). **Expected pass
signal in parentheses.**

### Level 1 — Typecheck (root graph)
- `npm run typecheck`  (root `tsc -b`, **exit 0** — catches cross-project/test-only imports; per-workspace
  build is NOT a substitute). The dashboard is out of this graph and is **not touched** by this slice.

### Level 2 — Unit tests
- `npx vitest run packages/shared/src/git.test.ts apps/collector/src/discovery/git-reader.test.ts apps/collector/src/discovery/git-capture.test.ts`  (all pass)
- `npm test`  (full vitest; int self-skips with no DB — **all non-skipped pass**)

### Level 3 — Integration (DB-backed; the REAL gate for this slice)
- `npm run db:up && npm run db:migrate`  (migration `0004_*` applies, exit 0)
- `npm run repo-health -- --require-db`  (**FAILS if `DATABASE_URL_TEST` unset or any `*.int.test.ts`
  self-skipped** — asserts the git/attribution int layer actually ran, 0 skipped). This is the
  CLAUDE.md sign-off requirement for any `@420ai/db`/`apps/ingest` change — a plain green `repo-health`
  is NOT sufficient evidence here.

### Level 4 — Manual
1. `npm run ingest:dev` (separate shell), pair a machine (README M2 flow), `collector discover`.
2. `npx tsx apps/collector/src/cli.ts git --url http://localhost:8420`  → "Captured N commits across M repos".
3. `curl -s localhost:8420/v1/projects/<id>/git/commits -H "authorization: Bearer $ADMIN_TOKEN"` →
   real commits (paths/numstat plaintext; **no message field leaked**).
4. `curl -s -X POST localhost:8420/v1/projects/<id>/git/suggest -H "authorization: Bearer $ADMIN_TOKEN"`
   → links with `confidence` and `status:"suggested"`.
5. Verify encryption-at-rest: `docker compose exec archive psql -U 420ai -d 420ai -c "SELECT
   left(message_ciphertext,30), author_email, files_changed FROM git_commits LIMIT 1;"` → ciphertext is
   base64 (NOT the message), author_email + counts are readable plaintext.

---

## ACCEPTANCE CRITERIA
- [ ] `collector git` captures commits (sha/author/authoredAt/branch/numstat/changed files/isRevert) per
      discovered repo and POSTs them; re-running is idempotent (`commitsInserted: 0`).
- [ ] `git_commits`/`git_commit_files`/`session_git_links` exist via an **additive** migration; `events`,
      `raw_source_records`, the M5/M7 tables, and the fingerprint are **unchanged**.
- [ ] `/v1/ingest` wire contract + `events` table are **untouched** (git is its own endpoint/tables —
      M7 Scope-Decision-2 style).
- [ ] Attribution produces `suggested` links with `low`/`medium` confidence (window + file-overlap, Q4);
      manual link → `manual`/`confirmed`; re-suggest never clobbers a human decision; **always carries a
      confidence + status (suggestions are not facts).**
- [ ] Commit **message encrypted at rest**; author/email/paths/counts plaintext + queryable (§18.1).
- [ ] Unknown project/commit/session ids → **404, never a constraint-500**.
- [ ] `git` absent / non-repo degrades to `[]` with no crash.
- [ ] `npm run repo-health -- --require-db` passes with **0 int tests skipped**.

## COMPLETION CHECKLIST
- [ ] Phase-0 spike findings recorded; `git log` parser matches REAL output (not the assumed format).
- [ ] All tasks 1–16 done in order, each Level-1/2 validated immediately.
- [ ] Full `repo-health -- --require-db` green (typecheck 0 + vitest incl. int 0-skipped + scans).
- [ ] Level-4 manual confirms capture + attribution + encryption-at-rest.
- [ ] Migration SQL reviewed: additive only, no ALTER/DROP on existing tables.

---

## NOTES — Design Decisions (resolve-up-front; the executor should NOT re-litigate these)

- **D1 — `git` subprocess (`execFile`), NOT no-subprocess, NOT a new dep.** Full §11.3 (commits, diffs,
  numstat, patches) is infeasible by reading `.git` objects directly (packfiles/zlib/trees = reimplementing
  git). `readGitMeta`'s "no subprocess" note is a *local pattern* for trivial HEAD/config scalars, **not a
  repo invariant** (CLAUDE.md lists none). `git` is virtually always present where AI CLIs run; absence
  degrades gracefully. `isomorphic-git` is rejected (adds a dependency for no gain over the CLI). Gated by
  the Phase-0 spike.
- **D2 — Git outcomes are a DEDICATED projection, not `events`-table rows.** Direct precedent: M7
  `report_artifacts` ("the row IS the record — NOT a `report.generated` event", Scope Decision 2). This
  keeps `/v1/ingest`, the `events` table, and the fingerprint fully untouched (invariants), avoids
  synthetic git "session" noise in session projections, and lets git metadata be queryable **plaintext**.
  The `git.commit.detected`/`git.diff.detected` taxonomy is satisfied conceptually by `git_commits`/
  `git_commit_files`; the `EventType` union is intentionally NOT extended (nothing emits them as events).
- **D3 — Commit SHA is the idempotency key.** It is git's own content hash → `onConflictDoNothing` on
  `(machine_id, commit_sha)` gives PRD §23 idempotency with zero new fingerprint code.
- **D4 — Encryption split.** Encrypt the **commit message** (a "message body", §18.1). Keep author
  name/email, branch, changed-file **paths**, and numstat **counts** plaintext (git metadata/metrics,
  same class as the already-plaintext `project_path`/token counts) so attribution + reports query them
  WITHOUT decrypting. **Full patch text** is deferred (§11.3 marks Git Diff Capture "optional per-Project").
- **D5 — Attribution file-overlap needs decrypt-for-render.** Session `file.modified` paths live in
  **encrypted `events.payload_*`** (claude-code.ts:258 → ingest.ts:51). The linker decrypts them
  server-side (M8 `transcript.ts` precedent — the 2nd such read), intersects with plaintext
  `git_commit_files.file_path`, and persists only the overlap COUNT. Paths never leave the archive. If a
  future slice promotes file paths to plaintext, this decrypt can be dropped.
- **D6 — Suggest never clobbers a human decision.** `(userId, sessionId, commitId)` is unique; a re-run
  refreshes metrics for `suggested` rows only, never flipping `confirmed`/`rejected`. (Same spirit as
  M5's "re-discovery preserves a manual remap".)
- **Scope guard**: full-patch capture, the weighted attribution scorer, scheduled/auto suggestion, and a
  dashboard UI are OUT (V1 keeps attribution manual+one-heuristic per Q4; the dashboard is close-out
  Slice 5). Per-repo commit **cursor** (read `<lastSha>..HEAD`) is an optional optimization — V1 uses a
  `cap`-bounded `git log` + SHA dedup, and logs when capped (no silent truncation).

**Confidence (one-pass success): 7/10.** The architecture is heavily grounded in existing precedents
(M5 endpoint/join, M7 dedicated-table, M8 decrypt, ingest.ts idempotency), which de-risks the wiring.
The remaining risk is concentrated in three spots the executor must get empirically right: (1) the
`git log --numstat` parser against real output (merges/renames/binary/multiline — hence the Phase-0
spike + dense fixtures), (2) the absolute-vs-repo-relative path-overlap normalization, and (3) the
no-clobber upsert on `session_git_links`. None are architectural; all are covered by tests.
