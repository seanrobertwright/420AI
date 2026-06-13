# Feature: Milestone 3 — Collector Foundation (durable queue, machine identity, ingest sync, connector framework, per-file capture cursors)

The following plan should be complete, but it is important that you **validate documentation and
codebase patterns and task sanity before you start implementing**. Read the M1 + M2 code first — M3
extends the exact same conventions (ESM + NodeNext, `kebab-case.ts`, strict TS, `verbatimModuleSyntax`,
co-located vitest, "raw records sacred / events disposable", the deterministic machine-independent
fingerprint, libraries never log — only `cli.ts` writes to stdout/exits). Do **NOT** change the M1
fingerprint formula, the normalized token/event shapes, or the M2 ingest wire types — M3 produces those
same shapes and feeds them through the **existing** `ingest-client` (`postIngest`) into the **existing**
M2 Ingest API. M3 adds no new server code and no new database tables in Postgres.

The single load-bearing new contract introduced here is the **collector-local durable queue + per-file
cursor store** (a `node:sqlite` database under `~/.420ai/`). Get its dedup semantics and its
claim/ack/retry state machine right — everything about offline capture, restart-resume, and
"never send a half-written line" depends on them. **All of these mechanics were proven by an executed
throwaway spike (see PRE-FLIGHT VERIFICATION) — implement to that proven shape.**

## Feature Description

After M2, the pipe reaches the server but only as a **manual one-shot**: a human runs `collector push
<file>` and it does a single direct `fetch` that fails loudly if the server is down (M2 NOTES:
"No durable queue yet"). M3 turns the collector into a **continuously-running background capture agent**
that:

1. **Discovers and watches** each tool's on-disk session files (Claude Code in M3; the framework is
   built so M4 adds Codex/Gemini by implementing one interface).
2. **Tails** each file with a **per-file byte-offset cursor** `(path, last-byte-offset, size)` so a
   collector restart **resumes instead of re-sending**, and a **partially-written line is never
   captured** until it is newline-terminated (PRD §8.1).
3. **Buffers** captured raw records + normalized events into a **local disk-backed durable queue**
   (offline capture; survives crashes/restarts), deduplicated so re-reading a growing file does not
   re-enqueue unchanged data.
4. **Syncs** the queue to the M2 Ingest API via a **retrying sync worker** (exponential backoff on
   network/5xx failure, stop-and-surface on 401), acknowledging items only after the server confirms,
   then continues — so data captured offline lands once the archive is reachable.
5. Anchors all of this to a persisted **machine identity** (the M2 pairing credentials in `~/.420ai/`),
   exposed as a typed module instead of being buried in `cli.ts`.

This implements PRD §8.1 (Collector: durable queue, connector runtime, file-watch capture, per-file
cursors, sync status), §10.1/§10.1.1 (connector liveness labels + fidelity fields as a typed
`Connector` contract), and SUMMARY §3 milestone 3 + §4 "Liveness (Q2)" (byte-offset cursor; read only
newly appended lines; restart resumes). It is the foundation milestone 4 ("complete Claude Code
end-to-end") builds the first real connector on top of.

**Explicitly deferred to later milestones — do NOT build in M3:**
- Codex CLI / Gemini CLI connectors (M4) — M3 ships **only the Claude Code connector** plus the
  framework that makes adding the next two a matter of implementing the `Connector` interface.
- Project/workspace mapping, repo discovery UI (M5).
- Event projections — sessions/usage/cost/git_outcomes/connector_health tables (M6).
- Reports (M7), redaction + AI analysis (M8), the Next.js dashboard + Live Monitor UI (M9).
- The Tauri tray/control surface (deferred per PRD §9 — M3's "control surface" is the headless
  `collector watch` daemon + `collector queue` status command, nothing graphical).
- Per-connector **permission scopes** as an enforced subsystem (PRD §8.1 bullet) — M3 watches only the
  Claude Code path the user already consented to in M1/M2; a real permission-grant store is later.
- `fs.watch`/`chokidar` event-driven watching — M3 uses a **poll-based** watcher (see Decisions). The
  spike confirmed `fs.watch` fires on this machine, but poll is the robust, deterministic, testable V1
  primary; event-driven is an additive optimization later.

## User Story

As an AI-heavy developer who has paired my Windows machine to the archive,
I want a background collector that automatically watches my Claude Code sessions, captures new activity
as it is written, buffers it durably on disk, and syncs it to my archive whenever the archive is
reachable — resuming exactly where it left off after a reboot and never losing or duplicating data,
So that my session history is captured continuously and reliably without me remembering to run a manual
`push`, even across offline periods and restarts.

## Problem Statement

The M2 collector can only push one already-complete file on demand, synchronously, with no buffering:
if the archive is down the push throws and the data is not retried; if the same growing file is pushed
twice the whole file is re-read; there is no notion of "only the new lines"; there is no persistent,
crash-safe staging area; and there is no running process that notices new sessions or new activity. PRD
§8.1's collector (durable queue, file-watch capture, per-file cursors, connector runtime, sync status)
does not exist yet. M3 must stand up that always-on capture loop while reusing — unchanged — the M1
parser, the M2 wire types, and the M2 ingest client/API.

## Solution Statement

Everything in M3 lives inside the **existing `apps/collector` workspace** (no new package, no new
server code). New internal modules, each small and independently testable:

1. **Machine identity** (`src/identity.ts`) — extract the `Credentials` type + `load/saveCredentials`
   currently inline in `cli.ts` into a typed module; add `requireCredentials()` that throws a typed
   `NotPairedError`. `~/.420ai/` becomes the documented collector home (credentials + queue + cursors).
2. **Durable queue + cursor store** (`src/queue/queue-store.ts`) — a `node:sqlite` database
   (`~/.420ai/queue.sqlite`) with two tables: `queue_items` (outbound raw/event payloads with a
   `dedup_key`, `content_hash`, `status`, `attempts`, `next_attempt_at`) and `file_cursors`
   (`connector_id`, `path`, `byte_offset`, `size`). Methods: `enqueue` (dedup: insert-once for
   immutable raw, update-on-change for events, no-op when unchanged), `claimBatch`, `ack`, `markFailed`
   (backoff), `recoverInflight`, `getCursor`/`saveCursor`, `stats`. Mirrors the M1 `SqliteStore`
   conventions exactly.
3. **Connector framework** (`src/connectors/connector.ts`) — a typed `Connector` interface
   (`id`, `fidelity` per PRD §10.3, `watchGlobs()`, `parse(fileText) → ParseResult`) + a `connectors`
   registry. `src/connectors/claude-code.ts` is **extended** with a `claudeCodeConnector` object that
   wraps the **unchanged** `parseClaudeCodeSession`.
4. **Tailer + watcher** (`src/watcher/tailer.ts`, `src/watcher/file-watcher.ts`) — `tailer` is a pure
   function that reads a file's complete-line prefix `[0 .. last '\n']`, returning the text to parse +
   the new cursor offset + growth/truncation flags (partial trailing line held back). `file-watcher`
   is a **poll-based** loop: glob-discover session files, stat each, and on growth hand the connector +
   prefix text to a callback; re-glob periodically to pick up new session files.
5. **Sync worker** (`src/sync/sync-worker.ts`) — drains the queue: `claimBatch` → group raw+events into
   one `IngestBatch` → `postIngest` (existing M2 client) → `ack` on 2xx / `markFailed`+backoff on
   network|5xx / **stop** on 401 (credentials revoked — surface, do not spin). `recoverInflight` on
   boot so a crash mid-send re-sends, never drops.
6. **Capture engine + daemon** (`src/capture-engine.ts`) — wires identity + queue + connectors +
   watcher + sync worker into the `collector watch` command; SIGINT does a graceful final drain + clean
   close.
7. **CLI** (`src/cli.ts`, EXTEND) — add `watch` (run the daemon), `sync` (one-shot drain, testable/ops),
   and `queue` (print backlog/stats). Keep M1 `ingest`/`report` and M2 `pair`/`push` **unchanged**.

No new runtime dependencies (uses `node:sqlite`, `node:fs`, `node:fs/promises` `glob`, global `fetch` —
all Node 24 built-ins, all already used in the repo or proven in the spike).

## Feature Metadata

**Feature Type**: New Capability (the collector's first always-on background loop, durable buffering,
file-watch capture, and the connector-plugin contract)
**Estimated Complexity**: High
**Primary Systems Affected**: EXTEND `apps/collector` only (new internal modules + 3 new CLI commands).
EXTEND `packages/shared` with one tiny mapper (`toRawRecordPayload`) for symmetry with `toEventPayload`.
No server, no Postgres schema, no new workspace.
**Dependencies**: none new. Node 24 built-ins: `node:sqlite` (`DatabaseSync`), `node:fs`
(`openSync`/`readSync`/`fstatSync`/`appendFileSync`), `node:fs/promises` (`glob`), `node:crypto`
(`createHash`), `node:os` (`homedir`), global `fetch`. Reuses M1 `parseClaudeCodeSession` + M2
`postIngest`/wire types verbatim.

---

## PRE-FLIGHT VERIFICATION (a focused throwaway spike was EXECUTED on this machine — these risks are RETIRED with evidence)

A single throwaway script exercising every novel M3 runtime mechanic was **run end-to-end** on this
machine (Node v24.16.0, win32) before finalizing this plan; **24/24 assertions passed**. The spike is
destroyed; the evidence stands. (Reproduce by re-deriving the snippets in "Patterns to Follow" — the
executor should NOT re-run it.) What was proven:

1. **Environment — VERIFIED.** `node v24.16.0`; `node:sqlite` `DatabaseSync` present; global `fetch` is
   a function; `node:fs/promises` `glob` is present and usable; platform `win32`. → "are the built-ins
   I'm leaning on actually here on Node 24" closed.
2. **Durable-queue dedup semantics — VERIFIED (the core mechanic).** A `queue_items` table with
   `UNIQUE(kind, dedup_key)` and the upsert
   `INSERT ... ON CONFLICT(kind, dedup_key) DO UPDATE SET content_hash, payload_json, status='pending',
   attempts=0, next_attempt_at=epoch WHERE queue_items.content_hash <> excluded.content_hash` behaves
   exactly as needed: an immutable **raw** record re-enqueues as a **no-op**; an **event whose content
   changed** (e.g. `session.ended` whose `ts` advanced as the file grew) **updates and resets to
   pending** (so the change re-syncs and the server upserts it); an **unchanged event re-enqueues as a
   no-op** (no wasted re-send). → "how do I avoid re-sending the whole file every tick, yet still
   propagate the one event that legitimately changed" closed. **This is the keystone — it is why M3 can
   re-parse the whole file each tick and stay cheap + correct.**
3. **Claim/ack/retry/backoff + restart recovery — VERIFIED.** `claimBatch` flips `pending → inflight`;
   closing and reopening the DB (simulated crash mid-send) leaves the items `inflight` and **present**
   (durable, not lost); a recovery sweep returns `inflight → pending`; `markFailed` sets
   `next_attempt_at = now + min(30s, 1s·2^attempts)` and the backed-off item is correctly **excluded**
   from the next `claimBatch` until its time arrives. → "does the queue survive a crash and not
   double-fire or lose items" closed.
4. **Byte-offset tail correctness — VERIFIED (the second keystone).** Reading a file's new region and
   slicing to the **last `\n`**: two complete appended lines are emitted; a **partial trailing line
   (no newline) is NOT emitted and the cursor does NOT advance over it**; once the line is completed it
   is emitted **exactly once**; restarting at the saved cursor with no growth re-sends **zero** lines
   (resume, not re-send); a **truncation** (new size < saved cursor) is detected and the offset resets
   to re-read from 0. → "will I ever capture a half-written JSON line, or re-send everything on
   restart" closed (both: no).
5. **Glob discovery incl. new files mid-run — VERIFIED.** `node:fs/promises` `glob("…/projects/*/*.jsonl")`
   found the existing session file, and after a new session file was created it was discovered on the
   next scan. → "can a poll loop pick up brand-new session files without a restart" closed.
6. **`fs.watch` vs poll on Windows — DECIDED.** `fs.watch` fired 2/2 for two appends on this machine,
   **but** abruptly exiting the process with an open watch handle produced a libuv
   `UV_HANDLE_CLOSING` assertion — a teardown hazard. Stat-based **poll** detected growth 100%
   reliably with none of that risk. → **Decision: poll-based watcher is the V1 primary** (deterministic,
   testable, portable, no teardown hazard); `fs.watch` is a later additive optimization.
7. **Sync worker happy/failure/auth paths — VERIFIED end-to-end (no Docker).** Against a local
   `node:http` stub: claimed items were grouped into one `{ records, events }` `IngestBatch`-shaped
   body and POSTed with `authorization: Bearer …`; a **2xx** acked both items; a **503** left the item
   `pending` with `attempts` incremented (retry); a **401** returned a `stop` signal and left the item
   `pending` for re-pair (no infinite spin, no data loss). → "does the drain → POST → ack/backoff/stop
   loop actually work over real `fetch`" closed.

**Residual risk (cannot retire before execution):** only the genuine first-write of the *real* product
wiring the spike intentionally did not build — composing the proven primitives into `capture-engine.ts`,
the SIGINT graceful-shutdown drain, the exact `ParseResult → queue → IngestBatch` mapping reusing the
M2 helpers, and the live-Postgres integration test. Every mechanic underneath is now proven on this
machine; the wiring is low-risk and fully covered by the validation ladder below.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — IMPORTANT: YOU MUST READ THESE BEFORE IMPLEMENTING!

- `.agents/plans/m2-archive-deployment.md` — Why: the house style for this plan AND the conventions M3
  mirrors (PRE-FLIGHT-spike discipline, task format, "patterns defined by the plan become repo
  conventions", testing split with `describe.skipIf`, the confidence-scoring honesty). Read its NOTES —
  it explicitly scopes the durable queue / cursors / connector framework / machine-identity persistence
  to **this** milestone.
- `apps/collector/src/cli.ts` — Why: the ONLY collector file allowed to log/exit/read argv/write files.
  M3 extracts its `Credentials`/`loadCredentials`/`saveCredentials`/`CREDENTIALS_PATH` into
  `identity.ts` (refactor, no behavior change) and adds `watch`/`sync`/`queue` commands mirroring the
  existing `runX` (pure exported fn) + thin `main()` split. Note `runPush` already maps
  `ParseResult → IngestBatch` — M3 reuses that exact mapping through the queue.
- `apps/collector/src/store/sqlite-store.ts` — Why: the **exact `node:sqlite` conventions** the queue
  store mirrors — `new DatabaseSync(path)`, `PRAGMA journal_mode=WAL`, `CREATE TABLE IF NOT EXISTS`,
  prepared statements, `INSERT … ON CONFLICT(…) DO UPDATE`, the experimental-warning note, synchronous
  API, `close()`. The queue store is a sibling of this class, not a new pattern.
- `apps/collector/src/connectors/claude-code.ts` — Why: `parseClaudeCodeSession`, `ParseResult`,
  `CLAUDE_CODE_CONNECTOR`, `PARSER_VERSION` are reused **verbatim**; M3 wraps them in a
  `claudeCodeConnector: Connector`. Note the raw `id` = `record.uuid ?? \`${session}:${lineIndex}\``
  and that the parser is **whole-file** (it derives `session.started`/`session.ended` from the
  earliest/latest timestamp across all records) — this is WHY M3 re-parses the whole complete-line
  prefix each tick rather than only new bytes (so lifecycle events + uuid-less fallback ids stay
  stable), and why the queue's content-hash dedup (PRE-FLIGHT #2) is what keeps that cheap + correct.
- `apps/collector/src/ingest-client.ts` — Why: `postPair`/`postIngest` are reused **unchanged** by the
  sync worker. `postIngest` already throws a descriptive `Error` on non-2xx including the status — the
  sync worker inspects the thrown error / re-issues the request to distinguish 401 (stop) from 5xx
  (retry). **Read its `expectOk`**: it throws on any non-ok; M3's worker needs the **status code**, so
  either extend `postIngest` to surface `res.status` on the error (recommended — see Task 9 GOTCHA) or
  have the worker call `fetch` knowledge via a thin status-aware wrapper. Decide and document.
- `apps/collector/src/push.int.test.ts` — Why: the template for M3's capture-engine integration test —
  it builds the M2 ingest app in-process (`buildApp` with a test `Db`), `listen({ port: 0 })`, pairs,
  and asserts idempotency. M3's integration test does the same but drives the **watcher → queue → sync**
  path instead of a direct `runPush`.
- `packages/shared/src/ingest.ts` — Why: `IngestBatch`/`RawRecordPayload`/`EventPayload`/`IngestResponse`
  + `toEventPayload` are the wire contract the queue stores and the sync worker sends. M3 adds a
  symmetric `toRawRecordPayload(r: RawSourceRecord): RawRecordPayload` here (Task 4).
- `packages/shared/src/events.ts` — Why: `RawSourceRecord`/`NormalizedEvent`/`EventType` shapes the
  queue serializes. `RawSourceRecord.id` (machine-local) → wire `sourceRecordId`; the queue's raw
  `dedup_key` namespaces it by connector.
- `packages/shared/src/fingerprint.ts` — Why: `eventFingerprint` is the event `dedup_key` — already
  globally unique + machine-independent, so it is the natural queue key for events (and the server's
  upsert key). Do NOT recompute or alter it.
- `docs/PRD.md` §8.1 (Collector — durable queue, file-watch, per-file cursor `(path, last-byte-offset,
  size/inode)`, sync status), §10.1 + §10.1.1 (connector store locations + liveness labels —
  Streaming/Near-real-time/Snapshot/Batch), §10.3 (the fidelity fields the `Connector.fidelity` type
  encodes), §23 (replay/idempotency the queue + fingerprint preserve) — Why: the spec for every M3
  decision.
- `docs/research/connector-capture-spike.md` — Why: the **verified** Claude Code store location
  (`~/.claude/projects/<cwd-slug>/<uuid>.jsonl`, append-only JSONL, one file per session) the watcher
  globs, and the liveness label ("Streaming (tail)") the connector's fidelity declares.
- `docs/CONTEXT.md` (Local Durable Queue, Collector, Ingest Token, Collector Pairing, Connector,
  Connector Fidelity, Event Fingerprint, Background Collector, Control Surface) — Why: canonical
  terminology; name code after these.
- `vitest.config.ts`, `vitest.global-setup.ts`, `tsconfig.base.json`, `apps/collector/tsconfig.json`,
  `.gitignore` — Why: the test harness + TS config M3 plugs into unchanged. `.gitignore` already ignores
  `*.sqlite`/`*.db` (the queue DB is local state — confirm it is not committed) and `~/.420ai/` is
  outside the repo entirely.

### New Files to Create

```
apps/collector/src/
  identity.ts                       # Credentials type + load/save/require + collector-home paths (extracted from cli.ts)
  identity.test.ts                  # load/save round-trip + requireCredentials throws NotPairedError (tmp HOME)
  queue/
    queue-store.ts                  # QueueStore (node:sqlite): queue_items + file_cursors; enqueue/claim/ack/markFailed/recover/cursor/stats
    queue-store.test.ts             # dedup (insert-once raw / update-on-change event / no-op), claim/ack/backoff, cursor persist, recover (tmp sqlite)
  connectors/
    connector.ts                    # Connector + ConnectorFidelity interfaces + `connectors` registry
    connector.test.ts               # registry shape: claude-code present, fidelity fields populated, watchGlobs expands ~ + HOME
  watcher/
    tailer.ts                       # PURE: readGrownPrefix(path, cursor) -> { text, newOffset, grew, reset } (complete-line prefix, partial held back)
    tailer.test.ts                  # complete-lines-only, partial held, resume (no growth -> empty), truncation reset (tmp file)
    file-watcher.ts                 # poll-based: discover via globs, per-file growth/truncation detect, tickOnce() + runLoop(signal)
    file-watcher.test.ts            # tickOnce on a tmp session file: new lines -> callback with prefix; append -> only-new; new file discovered
  sync/
    sync-worker.ts                  # syncOnce(deps) drain->group->postIngest->ack/markFailed/stop; runSyncLoop(deps, signal)
    sync-worker.test.ts             # against a local node:http stub: 2xx acks, 5xx retries+backoff, 401 stops, empty queue no-op
  capture-engine.ts                 # wires identity+queue+connectors+watcher+sync into the `watch` daemon; SIGINT graceful drain
  capture-engine.int.test.ts        # skipIf(!DATABASE_URL_TEST): tmp Claude file -> watch tick -> queue -> in-process M2 ingest app -> Postgres; append -> only-new; restart -> 0 re-sent
packages/shared/src/
  (EXTEND ingest.ts — add toRawRecordPayload; no new file)
```

### Files to MODIFY

```
apps/collector/src/cli.ts            # extract identity helpers -> identity.ts (import them back);
                                     #   add watch/sync/queue commands + runWatch/runSync/runQueueStatus; extend usage()
packages/shared/src/ingest.ts        # add toRawRecordPayload(r: RawSourceRecord): RawRecordPayload (symmetry with toEventPayload)
apps/collector/package.json          # add script "watch": "tsx src/cli.ts watch" (optional convenience); no new deps
README.md                            # add "Development (Milestone 3)" section; bump Status line
.gitignore                           # (verify only) *.sqlite/*.db already ignored; queue DB lives in ~/.420ai (outside repo)
```

### Relevant Documentation — read before implementing

- **Node `node:sqlite` (DatabaseSync)**: https://nodejs.org/docs/latest-v24.x/api/sqlite.html
  - Why: the queue/cursor store API — `new DatabaseSync(path)`, `.exec`, `.prepare(...).run/get/all`,
    `ON CONFLICT … DO UPDATE`, WAL pragma. Same surface M1's `SqliteStore` already uses. Experimental in
    Node 24 (prints `ExperimentalWarning` on import — expected, do not suppress in a test-breaking way).
- **Node `node:fs/promises` glob**: https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisesglobpattern-options
  - Why: session-file discovery (`glob("~/.claude/projects/*/*.jsonl")` with `~` pre-expanded to
    `homedir()`). Proven in the spike. (Stable in Node 24; if a lint flags it as experimental, the
    sync `fs.globSync` or a tiny `readdir` walk is an equivalent fallback — note the choice.)
- **Node `fs` low-level read (openSync/readSync/fstatSync)**: https://nodejs.org/docs/latest-v24.x/api/fs.html#fsreadsyncfd-buffer-options
  - Why: byte-offset tail — read the new region from a saved offset, slice to last `\n`. Proven in spike.
- **PRD §8.1 / §10.1.1** (in-repo) — Why: the cursor tuple `(path, last-byte-offset, size/inode)` and
  the liveness label vocabulary the `Connector.fidelity` must use.
- **Exponential backoff (concept)**: standard `min(cap, base · 2^attempts)` with the cap at ~30s — no
  library; the formula is in "Patterns to Follow" and was proven in the spike.

### Patterns to Follow (extend M1/M2 conventions — do NOT invent new ones)

**Module system / TS / naming / logging:** identical to M1/M2 — ESM, `"type": "module"`, NodeNext,
`verbatimModuleSyntax`, relative imports end in `.js`, `import type` for types, `kebab-case.ts` files,
`PascalCase` types, `camelCase` fns, `snake_case` SQL columns. **No file under `apps/collector/src`
except `cli.ts` writes to stdout/stderr or calls `process.exit`** — the daemon's user-facing logging
goes through `cli.ts` (`runWatch` accepts an optional `onEvent`/`logger` callback that `main()` wires to
`process.stdout`; libraries stay silent and testable).

**Durable queue + cursor store (the proven shape — `node:sqlite`, mirrors `SqliteStore`):**
```ts
// apps/collector/src/queue/queue-store.ts (essential shape — proven in PRE-FLIGHT #2,#3,#4)
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const EPOCH = "1970-01-01T00:00:00.000Z";
export type QueueKind = "raw" | "event";
export type SyncOutcome = "ok" | "retry" | "stop";

export class QueueStore {
  private db: DatabaseSync;
  constructor(path: string, private now: () => Date = () => new Date()) {  // inject clock for tests
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS queue_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL, dedup_key TEXT NOT NULL, content_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL DEFAULT '${EPOCH}',
      UNIQUE(kind, dedup_key))`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS file_cursors (
      connector_id TEXT NOT NULL, path TEXT NOT NULL,
      byte_offset INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL, PRIMARY KEY (connector_id, path))`);
  }
  /** Insert-once for immutable raw; update-and-reset-pending only when content changed (PRE-FLIGHT #2). */
  enqueue(kind: QueueKind, dedupKey: string, payload: unknown): "inserted" | "updated" | "noop" {
    const json = JSON.stringify(payload);
    const hash = createHash("sha256").update(json).digest("hex");
    const prev = this.db.prepare(`SELECT content_hash FROM queue_items WHERE kind=? AND dedup_key=?`)
      .get(kind, dedupKey) as { content_hash: string } | undefined;
    this.db.prepare(`INSERT INTO queue_items (kind,dedup_key,content_hash,payload_json,status,attempts,next_attempt_at)
      VALUES (?,?,?,?,'pending',0,'${EPOCH}')
      ON CONFLICT(kind,dedup_key) DO UPDATE SET content_hash=excluded.content_hash,
        payload_json=excluded.payload_json, status='pending', attempts=0, next_attempt_at='${EPOCH}'
      WHERE queue_items.content_hash <> excluded.content_hash`).run(kind, dedupKey, hash, json);
    return !prev ? "inserted" : prev.content_hash === hash ? "noop" : "updated";
  }
  claimBatch(limit: number): QueueRow[] { /* SELECT pending AND next_attempt_at<=now ORDER BY id LIMIT ?; UPDATE -> inflight */ }
  ack(ids: number[]): void { /* UPDATE status='acked' (or DELETE) WHERE id IN (...) */ }
  markFailed(id: number, attempts: number): void {
    const next = new Date(this.now().getTime() + Math.min(30_000, 1000 * 2 ** attempts)).toISOString();
    this.db.prepare(`UPDATE queue_items SET status='pending', attempts=attempts+1, next_attempt_at=? WHERE id=?`).run(next, id);
  }
  releaseInflight(ids: number[]): void { /* 401 path: status inflight->pending, no attempt bump */ }
  recoverInflight(): void { this.db.exec(`UPDATE queue_items SET status='pending' WHERE status='inflight'`); } // call on boot
  getCursor(connectorId: string, path: string): { byteOffset: number; size: number } | undefined { /* ... */ }
  saveCursor(connectorId: string, path: string, byteOffset: number, size: number): void { /* upsert (connector_id,path) */ }
  stats(): { pending: number; inflight: number; acked: number } { /* counts by status */ }
  close(): void { this.db.close(); }
}
```

**Byte-offset tail (PURE, proven in PRE-FLIGHT #4):**
```ts
// apps/collector/src/watcher/tailer.ts
import { openSync, readSync, fstatSync, closeSync } from "node:fs";
export interface TailResult { text: string; newOffset: number; grew: boolean; reset: boolean; }
/** Read the complete-line prefix that appeared since `fromOffset`. Holds back a partial trailing line.
 *  Returns the WHOLE-FILE prefix [0 .. lastNewline] as `text` so a whole-file connector parser keeps
 *  lifecycle events + uuid-less fallback ids stable (see claude-code.ts note). */
export function readGrownPrefix(path: string, fromOffset: number): TailResult {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const reset = size < fromOffset;            // truncation/rotation -> re-read from 0
    if (!reset && size === fromOffset) return { text: "", newOffset: fromOffset, grew: false, reset };
    const buf = Buffer.allocUnsafe(size);
    readSync(fd, buf, 0, size, 0);              // read whole file (<=~1MB sessions, PRD §8.5)
    const lastNL = buf.lastIndexOf(0x0a);
    if (lastNL < 0) return { text: "", newOffset: reset ? 0 : fromOffset, grew: false, reset }; // no complete line yet
    return { text: buf.subarray(0, lastNL + 1).toString("utf8"), newOffset: lastNL + 1, grew: true, reset };
  } finally { closeSync(fd); }
}
```
> Cursor stores `newOffset` (end of last complete line). Growth = `size > byte_offset`. The connector
> parses `text` (the full complete-line prefix); the queue's dedup (raw insert-once, event content-hash)
> ensures only genuinely new/changed items enqueue — so re-parsing the whole prefix each tick is cheap.

**Connector contract (PRD §10.3 fidelity fields as types):**
```ts
// apps/collector/src/connectors/connector.ts
import type { ParseResult } from "./claude-code.js";
export type Liveness = "streaming" | "near-real-time" | "snapshot" | "batch";
export interface ConnectorFidelity {
  status: "stable" | "experimental" | "planned";
  captureMethod: string;            // "tail-jsonl"
  liveness: Liveness;               // "streaming" for Claude Code
  tokens: "exact" | "estimated" | "none";
  cost: "reported" | "computed" | "none";
  knownGaps: string[];
  testedVersions?: string[];
}
export interface Connector {
  id: string;                                   // CLAUDE_CODE_CONNECTOR
  fidelity: ConnectorFidelity;
  watchGlobs(home: string): string[];           // e.g. [join(home, ".claude/projects/*/*.jsonl")]
  parse(fileText: string): ParseResult;         // delegates to parseClaudeCodeSession
}
export const connectors: Connector[] = [claudeCodeConnector];   // M3: Claude only; M4 appends Codex/Gemini
```

**Sync worker (drain → group → post → ack/backoff/stop, proven in PRE-FLIGHT #7):**
```ts
// apps/collector/src/sync/sync-worker.ts — essential control flow
export interface SyncDeps {
  queue: QueueStore; url: string; token: string; batchSize?: number;
  post?: typeof postIngest;                     // injectable for tests (default = real postIngest)
}
export async function syncOnce(deps: SyncDeps): Promise<SyncOutcome> {
  const items = deps.queue.claimBatch(deps.batchSize ?? 500);
  if (items.length === 0) return "ok";
  const batch: IngestBatch = {
    records: items.filter(i => i.kind === "raw").map(i => JSON.parse(i.payloadJson)),
    events:  items.filter(i => i.kind === "event").map(i => JSON.parse(i.payloadJson)),
  };
  try {
    await (deps.post ?? postIngest)(deps.url, deps.token, batch);
    deps.queue.ack(items.map(i => i.id));
    return "ok";
  } catch (err) {
    if (isUnauthorized(err)) { deps.queue.releaseInflight(items.map(i => i.id)); return "stop"; } // 401 -> surface
    for (const i of items) deps.queue.markFailed(i.id, i.attempts);                                // 5xx/network -> backoff
    return "retry";
  }
}
```
> `isUnauthorized(err)` keys off the HTTP status. **`postIngest` currently throws an `Error` string
> containing `HTTP 401`** — Task 9 either (a) parses that, or (b) preferably extends `expectOk`/`postIngest`
> to attach `err.status = res.status` (additive, M1/M2 callers unaffected) so the check is robust. Pick (b).

**Collector home / identity (formalize `~/.420ai/`):**
```ts
// apps/collector/src/identity.ts
import { homedir } from "node:os"; import { join } from "node:path";
export const COLLECTOR_HOME = join(homedir(), ".420ai");
export const CREDENTIALS_PATH = join(COLLECTOR_HOME, "credentials.json"); // M2 file (unchanged shape)
export const QUEUE_PATH = join(COLLECTOR_HOME, "queue.sqlite");
export interface Credentials { url: string; token: string; machineId: string; }
export class NotPairedError extends Error {}
export function loadCredentials(): Credentials | undefined { /* existsSync + JSON.parse, undefined on miss/parse-fail (as cli.ts does today) */ }
export function saveCredentials(c: Credentials): void { /* mkdirSync recursive + writeFileSync mode 0o600 (as cli.ts does today) */ }
export function requireCredentials(): Credentials { const c = loadCredentials(); if (!c) throw new NotPairedError("not paired — run `collector pair <code> --url <baseUrl>` first"); return c; }
```

---

## IMPLEMENTATION PLAN

### Phase 1: Local state primitives (`identity.ts`, `queue/queue-store.ts`)
The collector home, typed credentials, and the durable queue + cursor store. Fully unit-testable with no
network and no Postgres. This is the proven foundation (PRE-FLIGHT #2,#3).

### Phase 2: Capture primitives (`watcher/tailer.ts`, `connectors/connector.ts`, claude-code wrapper)
The pure byte-offset tailer and the `Connector` contract + the Claude connector object wrapping the
unchanged M1 parser. Pure/unit-testable (PRE-FLIGHT #4,#5).

### Phase 3: Moving parts (`watcher/file-watcher.ts`, `sync/sync-worker.ts`)
The poll-based watcher (discover + growth-detect + per-file cursor) and the retrying sync worker. Each
exposes a deterministic `tickOnce`/`syncOnce` for tests plus a `runLoop(signal)` for the daemon
(PRE-FLIGHT #6,#7).

### Phase 4: Engine + CLI (`capture-engine.ts`, extend `cli.ts`, extend `shared/ingest.ts`)
Wire identity + queue + connectors + watcher + sync into the `watch` daemon with graceful shutdown; add
`watch`/`sync`/`queue` commands; add the `toRawRecordPayload` mapper.

### Phase 5: Tests, validation, docs
Unit suites (no infra) + one Postgres-backed integration test reusing the M2 in-process app + the full
validation ladder + README.

---

## STEP-BY-STEP TASKS

IMPORTANT: Execute every task in order, top to bottom. Run each task's VALIDATE before moving on.

### Task 1 — CREATE `apps/collector/src/identity.ts` (extract + formalize machine identity)
- **IMPLEMENT**: `COLLECTOR_HOME`, `CREDENTIALS_PATH`, `QUEUE_PATH`, `Credentials`, `NotPairedError`,
  `loadCredentials`, `saveCredentials`, `requireCredentials` exactly as in "Patterns to Follow". Move
  the logic **verbatim** from `cli.ts` (do not change file mode `0o600`, the `mkdirSync({recursive})`,
  or the tolerant `undefined`-on-parse-fail behavior).
- **PATTERN**: `apps/collector/src/cli.ts` lines 18–40 (current `CREDENTIALS_PATH`/`saveCredentials`/
  `loadCredentials`/`Credentials`).
- **GOTCHA**: library file — no logging/exit. `requireCredentials` THROWS `NotPairedError`; only
  `cli.ts main()` catches and prints. Keep `Credentials` shape byte-identical to M2 (the existing
  `~/.420ai/credentials.json` must still load).
- **VALIDATE**: `npm run -w @420ai/collector build` (after Task 2 imports it back, or `npx tsc -p apps/collector --noEmit`).

### Task 2 — UPDATE `apps/collector/src/cli.ts` to import identity from `identity.ts`
- **IMPLEMENT**: delete the inline `CREDENTIALS_PATH`/`Credentials`/`saveCredentials`/`loadCredentials`
  from `cli.ts`; import them from `./identity.js`. `runPair` keeps calling `saveCredentials`; `push`
  keeps calling `loadCredentials`. **No behavior change** — `pair`/`push`/`ingest`/`report` all still
  work exactly as before.
- **GOTCHA**: `usage()` references `CREDENTIALS_PATH` — keep it importing from `identity.js`.
- **VALIDATE**: `npx vitest run apps/collector/src/cli.test.ts` (existing CLI tests still green — proves
  the refactor is behavior-preserving).

### Task 3 — CREATE `apps/collector/src/identity.test.ts`
- **IMPLEMENT** (NO infra): point the home at a tmp dir (set `process.env` HOME/USERPROFILE or, cleaner,
  pass paths explicitly — see GOTCHA). Assert `saveCredentials` then `loadCredentials` round-trips
  `{url,token,machineId}`; `loadCredentials` returns `undefined` when the file is absent and when it is
  corrupt JSON; `requireCredentials` throws `NotPairedError` when absent.
- **GOTCHA**: `COLLECTOR_HOME` is computed from `homedir()` at import time. To test against a tmp dir
  **without** mutating real `~/.420ai`, prefer giving `load/saveCredentials` an **optional `path`
  parameter** (defaulting to `CREDENTIALS_PATH`) so the test passes a tmp path — a tiny, justified
  testability seam. (Alternative: set `process.env.USERPROFILE`/`HOME` before importing — brittle on
  Windows; the param is cleaner.)
- **VALIDATE**: `npx vitest run apps/collector/src/identity.test.ts`.

### Task 4 — EXTEND `packages/shared/src/ingest.ts`: add `toRawRecordPayload`
- **IMPLEMENT**: `export function toRawRecordPayload(r: RawSourceRecord): RawRecordPayload` returning
  `{ sourceConnector: r.sourceConnector, sessionId: r.sessionId, sourceRecordId: r.id, payload: r.payload, ingestedAt: r.ingestedAt }`.
  `import type { RawSourceRecord } from "./events.js"`. This mirrors the existing `toEventPayload` and
  replaces the inline mapping in `cli.ts runPush` (have `runPush` use it too — DRY, no behavior change).
- **GOTCHA**: keep `packages/shared` pure + dependency-free. Add nothing else.
- **VALIDATE**: `npm run -w @420ai/shared build && npx vitest run packages/shared`.

### Task 5 — CREATE `apps/collector/src/queue/queue-store.ts` (durable queue + cursors)
- **IMPLEMENT**: the `QueueStore` class exactly as in "Patterns to Follow" — `queue_items` +
  `file_cursors` tables; `enqueue` (the proven `ON CONFLICT … WHERE content_hash <> excluded` upsert),
  `claimBatch(limit)` (`SELECT … WHERE status='pending' AND next_attempt_at<=now ORDER BY id LIMIT ?`
  then flip those rows to `inflight`; return typed `QueueRow[]` with `id,kind,dedupKey,payloadJson,attempts`),
  `ack(ids)`, `markFailed(id, attempts)` (capped exponential backoff via injected clock),
  `releaseInflight(ids)`, `recoverInflight()`, `getCursor`/`saveCursor`, `stats()`, `close()`. Constructor
  takes `(path, now = () => new Date())` so tests inject a clock.
- **IMPORTS**: `import { DatabaseSync } from "node:sqlite"; import { createHash } from "node:crypto";`
- **PATTERN**: mirror `apps/collector/src/store/sqlite-store.ts` (WAL pragma, `CREATE TABLE IF NOT
  EXISTS`, prepared statements, synchronous API, the experimental-warning note in a top comment).
- **GOTCHA**: `claimBatch` must read-then-update **in the same synchronous call path** (node:sqlite is
  synchronous + single-threaded, so there is no interleaving — the spike confirmed this is safe for one
  collector process). One daemon owns the queue; document "single-writer". `ack` can `DELETE` rather than
  keep `acked` rows to bound growth — pick DELETE (simpler, queue stays small); keep a `stats()` that
  still reports pending/inflight. Use `id IN (...)` with a bound list or loop per id.
- **VALIDATE**: `npx vitest run apps/collector/src/queue/queue-store.test.ts` (Task 6).

### Task 6 — CREATE `apps/collector/src/queue/queue-store.test.ts`
- **IMPLEMENT** (NO infra; tmp sqlite file via `node:os` tmpdir + a unique name, or `:memory:`):
  - **Dedup (PRE-FLIGHT #2):** `enqueue("raw","claude-code:rec1",p)` → `"inserted"`; same again →
    `"noop"`; `enqueue("event","fp1",{ts:"T1"})` → `"inserted"`; same → `"noop"`; with `{ts:"T2"}` →
    `"updated"` and the row is back to `pending`.
  - **Claim/ack:** enqueue 2; `claimBatch(10)` returns 2 and flips them to inflight (a second
    `claimBatch` returns 0); `ack` removes/acks them; `stats().pending === 0`.
  - **Backoff (PRE-FLIGHT #3):** with an injected fixed clock, `markFailed(id, 0)` sets
    `next_attempt_at` 1s ahead → `claimBatch` excludes it; advance the clock past it → it is claimable.
  - **Recover:** `claimBatch` (→ inflight), reopen the store on the same path, `recoverInflight()` →
    those rows are `pending` again (durable across restart).
  - **Cursor:** `saveCursor("claude-code","/p",128,128)` then `getCursor` returns `{byteOffset:128,size:128}`;
    re-save updates in place.
- **GOTCHA**: clean up the tmp DB file in `afterEach`. Inject the clock via the constructor — never call
  the real clock in assertions.
- **VALIDATE**: `npx vitest run apps/collector/src/queue/queue-store.test.ts`.

### Task 7 — CREATE `apps/collector/src/watcher/tailer.ts` + `tailer.test.ts`
- **IMPLEMENT**: `readGrownPrefix(path, fromOffset): TailResult` exactly as in "Patterns to Follow"
  (whole-file read, slice to last `\n`, partial held back, truncation `reset` when `size < fromOffset`,
  `grew:false` when no growth / no complete line).
- **IMPLEMENT** test (NO infra, tmp file): append 2 complete lines → `text` has both, `newOffset` at the
  2nd `\n`+1, `grew:true`; append a partial line (no `\n`) from `newOffset` → `text:""`, `grew:false`,
  `newOffset` unchanged; complete it → the completed line appears once; call again with no growth →
  `text:""`, `grew:false`; `writeFileSync` a shorter content (truncate) → `reset:true` and re-reads
  from 0. (These mirror the PRE-FLIGHT #4 assertions exactly.)
- **GOTCHA**: read the **whole file** `[0,size)` (not just the delta) — the connector parser is
  whole-file. Cursor still advances to the last-newline boundary so a partial line is never consumed.
  `lastIndexOf(0x0a)` on the Buffer (byte), not on a decoded string (multi-byte safety).
- **VALIDATE**: `npx vitest run apps/collector/src/watcher/tailer.test.ts`.

### Task 8 — CREATE `apps/collector/src/connectors/connector.ts` + EXTEND `claude-code.ts` + `connector.test.ts`
- **IMPLEMENT** `connector.ts`: `Liveness`, `ConnectorFidelity`, `Connector` interfaces + the
  `connectors` registry array, exactly as in "Patterns to Follow".
- **IMPLEMENT** in `claude-code.ts` (EXTEND — keep ALL existing exports unchanged): add
  `export const claudeCodeConnector: Connector = { id: CLAUDE_CODE_CONNECTOR, fidelity: { status:"stable",
  captureMethod:"tail-jsonl", liveness:"streaming", tokens:"exact", cost:"computed",
  knownGaps:["tool.call completion not yet correlated (M4)","session.ended ts settles only when the file stops growing"],
  testedVersions:[] }, watchGlobs: (home) => [join(home, ".claude", "projects", "*", "*.jsonl")],
  parse: (text) => parseClaudeCodeSession(text) };` (import `join` from `node:path`, the `Connector`
  type from `./connector.js`).
- **GOTCHA**: importing `Connector` from `./connector.js` while `connector.ts` imports `ParseResult`
  from `./claude-code.js` is a **type-only cycle** — fine under `verbatimModuleSyntax` because both are
  `import type` (erased at compile). Confirm `tsc -b` stays clean. Do NOT change `parseClaudeCodeSession`.
- **IMPLEMENT** `connector.test.ts`: assert the registry contains the claude connector; `id ===
  CLAUDE_CODE_CONNECTOR`; `fidelity.liveness === "streaming"`; `watchGlobs("/home/u")` contains a path
  ending in `.claude/projects/*/*.jsonl`; `parse(fixtureText)` returns a `ParseResult` with events
  (reuse the M1 fixture).
- **VALIDATE**: `npx vitest run apps/collector/src/connectors`.

### Task 9 — EXTEND `apps/collector/src/ingest-client.ts`: surface HTTP status on error
- **IMPLEMENT**: in `expectOk`, attach the status to the thrown error so the sync worker can branch on
  401 vs 5xx without string-matching. Minimal additive change:
  `const e = new Error(\`${what} failed: HTTP ${res.status} ${res.statusText} — ${body}\`); (e as any).status = res.status; throw e;`
  (Or define a small `class IngestHttpError extends Error { constructor(public status:number, msg:string){super(msg);} }`
  and export it + an `isUnauthorized(err)` helper.) **Recommended**: export `IngestHttpError` +
  `isUnauthorized`. Keep `postPair`/`postIngest` signatures unchanged — M1/M2 callers are unaffected.
- **GOTCHA**: do not change the success path or the message text M2 tests may assert; only ADD `.status`.
  Update `ingest-client.test.ts` to assert the thrown error carries `status === 401` on a 401 response.
- **VALIDATE**: `npx vitest run apps/collector/src/ingest-client.test.ts`.

### Task 10 — CREATE `apps/collector/src/sync/sync-worker.ts` + `sync-worker.test.ts`
- **IMPLEMENT** `syncOnce(deps): Promise<SyncOutcome>` exactly as in "Patterns to Follow" — claim →
  group raw+events into one `IngestBatch` → `post(url,token,batch)` → `ack` on success;
  `releaseInflight`+`return "stop"` on `isUnauthorized`; `markFailed` each + `return "retry"` on any
  other error (network/5xx). Also `runSyncLoop(deps, signal: AbortSignal, idleMs = 2000)` — loop
  `syncOnce` until `signal.aborted`; on `"stop"` break (surface via the returned reason); on `"ok"` with
  an empty queue, `await delay(idleMs)`; on `"retry"`, short delay then continue (backoff is already
  encoded in `next_attempt_at`).
- **IMPLEMENT** test (NO Docker — local `node:http` stub like PRE-FLIGHT #7, OR inject a fake `post`):
  prefer **injecting `deps.post`** (a `vi.fn`) for unit speed — assert: empty queue → `"ok"`, no post;
  2 items → one `post` call with `{records:[…1], events:[…1]}` + items acked (`stats().pending===0`);
  `post` throws `IngestHttpError(503)` → `"retry"`, item pending with `attempts===1`; `post` throws
  `IngestHttpError(401)` → `"stop"`, item still pending (not dropped). Add ONE end-to-end check against a
  real `node:http` stub to prove `fetch`/`postIngest` wiring (mirrors the spike).
- **GOTCHA**: `runSyncLoop` must be cancellable — use `AbortSignal` + a `delay` that rejects/resolves on
  abort so SIGINT stops it promptly. Library file: no logging (return outcomes; the engine/cli logs).
- **VALIDATE**: `npx vitest run apps/collector/src/sync/sync-worker.test.ts`.

### Task 11 — CREATE `apps/collector/src/watcher/file-watcher.ts` + `file-watcher.test.ts`
- **IMPLEMENT** a poll-based `FileWatcher`:
  - Constructor deps: `{ connectors, home, queue, onChange }` where `onChange(connector, prefixText)` is
    called when a file grew. (Engine passes an `onChange` that parses + enqueues — see Task 12.)
  - `discover(): Promise<string[]>` — for each connector, `glob` each `watchGlobs(home)` pattern; return
    `{ connector, path }[]`. (Use `node:fs/promises` `glob`; fallback `fs.globSync` if needed.)
  - `tickOnce(): Promise<void>` — discover; for each file: `getCursor`; `readGrownPrefix(path, offset)`;
    if `reset`, start from 0; if `grew`, `onChange(connector, text)` then `saveCursor(connector.id, path,
    newOffset, size)`. Persist cursor **after** `onChange` returns (so enqueue is the commit point —
    if enqueue throws, the cursor is not advanced and the lines are retried next tick).
  - `runLoop(signal, intervalMs = 1500): Promise<void>` — `tickOnce` every `intervalMs` until aborted.
- **IMPLEMENT** test (NO infra, tmp project dir + tmp queue): create `…/projects/slug/<uuid>.jsonl`,
  write 1 Claude record line; `tickOnce` → `onChange` called once with that line, cursor saved; append
  another line → `tickOnce` → `onChange` called with the **whole** prefix (2 lines) and the queue, after
  the engine's enqueue, holds 1 raw per line (dedup means the first is a no-op); create a **second**
  session file → `tickOnce` discovers + captures it. Use the real `QueueStore` + a tiny `onChange` that
  parses with `claudeCodeConnector` and enqueues (or assert `onChange` call args directly).
- **GOTCHA**: cursor stores BOTH `byte_offset` (last-newline) and `size`; growth check is `size >
  byte_offset` OR `reset`. New files have no cursor → treated as offset 0. Do not advance the cursor
  when `grew:false` (partial line). `discover` is async; `tickOnce` awaits it.
- **VALIDATE**: `npx vitest run apps/collector/src/watcher/file-watcher.test.ts`.

### Task 12 — CREATE `apps/collector/src/capture-engine.ts` (wire it all + graceful shutdown)
- **IMPLEMENT** `runCaptureEngine(opts: { creds: Credentials; queuePath?: string; home?: string;
  intervalMs?: number; signal: AbortSignal; logger?: (msg: string) => void }): Promise<void>`:
  - `const queue = new QueueStore(opts.queuePath ?? QUEUE_PATH); queue.recoverInflight();` (boot recovery).
  - `onChange = (connector, text) => { const parsed = connector.parse(text); for (const r of parsed.rawRecords) queue.enqueue("raw", \`${r.sourceConnector}:${r.id}\`, toRawRecordPayload(r)); for (const e of parsed.events) queue.enqueue("event", e.fingerprint, toEventPayload(e)); }`
  - Start the watcher loop and the sync loop **concurrently**: `await Promise.race([ watcher.runLoop(signal, intervalMs), runSyncLoop({ queue, url: creds.url, token: creds.token }, signal) ])` (or `Promise.all`; race so a fatal `"stop"`/abort ends both — then abort the other).
  - On `signal` abort (SIGINT): stop the watcher, do a **final best-effort `syncOnce`** to flush what is
    queued, `queue.close()`. Wrap in try/finally so the DB always closes.
  - `logger?.(…)` for lifecycle/sync milestones (the only way the daemon talks — wired by `cli.ts`).
- **GOTCHA**: the engine is a library (no direct stdout) — it takes a `logger` callback. The dedup keys:
  raw = `\`${connector}:${sourceRecordId}\`` (machine-local; aligns with the server's
  `unique(machine_id, source_connector, source_record_id)`); event = `fingerprint` (global). The sync
  worker reads `creds.token`/`creds.url`; a 401 (`"stop"`) means the token was revoked — log a clear
  "re-pair needed" and stop the loop (do not spin).
- **VALIDATE**: covered by Task 14 (integration) + the manual run (Validation Level 4).

### Task 13 — EXTEND `apps/collector/src/cli.ts`: `watch`, `sync`, `queue` commands
- **IMPLEMENT**:
  - `runWatch(opts: { url?: string; token?: string; intervalMs?: number; logger; signal }): Promise<void>`
    — resolve creds via `requireCredentials()` (or `--url/--token` overrides), call `runCaptureEngine`.
  - `runSync(opts: { url?; token? }): Promise<{ pending: number }>` — one-shot: open `QueueStore`,
    `recoverInflight`, loop `syncOnce` until it returns `"ok"` on an empty queue or `"stop"`; return
    `stats()`.
  - `runQueueStatus(): { pending; inflight; acked }` — open `QueueStore`, return `stats()`.
  - Wire into `main()`: `collector watch [--url <u>] [--token <t>] [--interval <ms>]` (creates an
    `AbortController`, registers `process.on("SIGINT")` → `controller.abort()`, passes a `logger` that
    writes to `process.stdout`, prints "watching… Ctrl-C to stop"); `collector sync [--url --token]`;
    `collector queue`. Extend `usage()`.
- **PATTERN**: mirror the existing `runPair`/`runPush` (pure exported fn) + thin async `main()` split.
  Only `main()` logs/exits/handles signals.
- **GOTCHA**: `watch` is long-running — this is the FIRST collector command that does not return
  promptly. SIGINT must trigger a graceful `controller.abort()` (engine flushes + closes), then a clean
  `process.exit(0)`. Catch `NotPairedError` in `main()` and print the friendly "run `collector pair`…".
- **VALIDATE**: `npm run -w @420ai/collector build`; manual `npx tsx apps/collector/src/cli.ts queue`
  prints `{pending:0,...}` on a fresh machine.

### Task 14 — CREATE `apps/collector/src/capture-engine.int.test.ts` (Postgres-backed end-to-end)
- **IMPLEMENT** `describe.skipIf(!process.env.DATABASE_URL_TEST)` (self-skips with no Docker, like every
  M2 `*.int.test.ts`). Reuse the `push.int.test.ts` scaffold:
  - `beforeAll`: `createDb(DATABASE_URL_TEST)`, `buildApp({ db, adminToken:"test-admin" })`,
    `app.listen({ port: 0 })`, read the port. `beforeEach`: TRUNCATE + seed a user; create a pairing
    code; `runPair` against the live app to get `{url,token,machineId}`.
  - Write a tmp Claude session file under a tmp `home/.claude/projects/slug/<uuid>.jsonl` (reuse the M1
    fixture content). Run **one watcher tick** (construct the engine's `onChange` + a `FileWatcher`, call
    `tickOnce`) then `syncOnce({queue,url,token})`. Assert the rows landed in Postgres (raw count, event
    count > 0) and that `raw_source_records.payload_ciphertext` is ciphertext (encryption still applies —
    it is the server's job, unchanged).
  - **Append more lines** to the file → `tickOnce` → `syncOnce` → assert only the **new** raw records
    were inserted server-side (`recordsInserted` for the delta; total grows by exactly the new lines) —
    proves the cursor + dedup deliver incremental, idempotent capture.
  - **Restart resume**: construct a fresh `QueueStore` + `FileWatcher` on the **same** queue path with no
    file growth → `tickOnce` enqueues nothing → `syncOnce` posts nothing (`pending` stays 0) — proves
    restart resumes, not re-sends.
- **IMPORTS**: `buildApp` from `@420ai/ingest` app (as `push.int.test.ts` does), `createDb` from
  `@420ai/db`, the fixture via `readFileSync`.
- **GOTCHA**: this reuses the real M2 server path — no new server code. Close the app + pools + queue in
  `afterAll`. Keep tmp dirs unique per test; clean them up.
- **VALIDATE**: `npm run db:up && npm run db:migrate && npx vitest run apps/collector/src/capture-engine.int.test.ts`.

### Task 15 — UPDATE `README.md` "Development (Milestone 3)" + Status
- **IMPLEMENT**: append an M3 section: what the collector now does (continuous capture, durable queue,
  per-file cursors, offline-safe sync, restart-resume); the new commands —
  `collector watch [--interval <ms>]` (runs the background agent; Ctrl-C to stop), `collector sync`
  (one-shot drain), `collector queue` (backlog/stats); note `~/.420ai/` holds `credentials.json` +
  `queue.sqlite` (local state, never committed, gitignored as `*.sqlite`); note the M3 connector is
  Claude Code only (Codex/Gemini land in M4) and the liveness label is "Streaming (tail)"; note
  integration tests need Docker + filled `.env` and self-skip otherwise. Bump the top "Status" line to
  Milestones 1–3.
- **VALIDATE**: follow the README M3 flow from a clean state (Validation Level 4).

---

## TESTING STRATEGY

Mirror M1/M2's co-located vitest layout. Split by infra need so `npm test` passes with **no** Docker.

### Unit Tests (`*.test.ts`, NO database, NO network — always run)
- `identity.test.ts` — credentials round-trip, `undefined` on missing/corrupt, `NotPairedError`.
- `queue/queue-store.test.ts` — dedup (insert-once/update-on-change/no-op), claim/ack, backoff (injected
  clock), recover-inflight across reopen, cursor persist. **(Highest-value suite — the keystone.)**
- `watcher/tailer.test.ts` — complete-lines-only, partial held back, no-growth resume, truncation reset.
- `connectors/connector.test.ts` — registry shape, fidelity fields, `watchGlobs`, `parse` reuses M1.
- `sync/sync-worker.test.ts` — empty no-op, 2xx ack, 5xx retry+backoff, 401 stop (injected `post`) + one
  real `node:http` stub round-trip.
- `watcher/file-watcher.test.ts` — `tickOnce`: new lines → `onChange` w/ prefix + cursor saved; append →
  whole-prefix + dedup; new file discovered.
- `ingest-client.test.ts` (EXTEND) — thrown error carries `status` (401).

### Integration Test (`*.int.test.ts`, real Postgres, `describe.skipIf(!DATABASE_URL_TEST)`)
- `capture-engine.int.test.ts` — tmp Claude file → watcher tick → queue → in-process M2 ingest app →
  Postgres; append → only-new inserted; restart on same queue → 0 re-sent. Reuses the M2 server verbatim.

### Edge Cases (must be covered)
- Re-running a tick on an unchanged file → 0 new enqueued (cursor at EOF; dedup no-ops). 
- A partially-written final JSON line → never captured until newline-terminated (no corrupt raw record).
- `session.ended` ts advancing as the file grows → event re-enqueued (content-hash changed) → server
  upserts the later ts (PRE-FLIGHT #2). An unchanged event mid-session → not re-sent.
- Archive unreachable (`fetch` throws) → items stay `pending`, `attempts` increments, backoff applies,
  data is retried on the next loop — nothing lost (offline capture).
- 401 (revoked token) → sync loop stops with a clear "re-pair needed", items left `pending`, no spin.
- Crash mid-send (inflight items) → `recoverInflight()` on next boot returns them to `pending` → re-sent
  (server idempotency means no duplicate rows).
- File truncated/replaced (size < cursor) → cursor resets, file re-read from 0 (dedup prevents dup rows).
- New session file created while watching → discovered on the next tick, captured from offset 0.
- Empty queue → `sync` is a clean no-op (no error, `pending:0`).
- SIGINT during `watch` → graceful final drain + `queue.close()`, exit 0, no orphaned DB handle.

---

## VALIDATION COMMANDS

Run every level; zero regressions, feature correct.

### Level 1: Syntax & Types
- `npm install` (no new deps; just confirms the workspace still resolves)
- `npm run typecheck` (`tsc -b` across shared, db, collector, ingest — 0 errors)

### Level 2: Unit Tests (no infra)
- `npx vitest run apps/collector/src/identity.test.ts apps/collector/src/queue apps/collector/src/watcher apps/collector/src/connectors apps/collector/src/sync apps/collector/src/ingest-client.test.ts apps/collector/src/cli.test.ts packages/shared`
  (all green with **no** database and **no** Docker — proves unit isolation + the M2 refactor is
  behavior-preserving)

### Level 3: Integration Test (Postgres up)
- `npm run db:up` → wait for `archive` healthy
- `cp .env.example .env` (first time) + fill `ARCHIVE_ENCRYPTION_KEY`, `ADMIN_TOKEN`
- `npm run db:migrate`
- `npx vitest run` (all suites incl. `capture-engine.int.test.ts` — green)

### Level 4: Manual Validation (real end-to-end, real Claude data)
- Ensure paired (M2): `npm run ingest:dev` (terminal A); create a code; `collector pair <code> --url http://localhost:8420 --name win-dev`.
- `npx tsx apps/collector/src/cli.ts queue` → `{ pending: 0, inflight: 0 }` on a fresh queue.
- Start the agent (terminal B): `npx tsx apps/collector/src/cli.ts watch --interval 1000`
  → prints "watching… Ctrl-C to stop"; within a few seconds it discovers existing Claude sessions and
  begins capturing. (Optionally have a Claude Code session running so a file is actively appended.)
- In another terminal: `npx tsx apps/collector/src/cli.ts queue` → shows pending draining toward 0 as the
  sync worker posts; the ingest API logs show `POST /v1/ingest 200`.
- **Encryption-at-rest still holds:** `docker compose exec archive psql -U 420ai -d 420ai -c "SELECT left(payload_ciphertext,40) FROM raw_source_records LIMIT 1;"` → base64 ciphertext.
- **Restart-resume:** Ctrl-C the watcher (graceful stop), restart `collector watch` → it does NOT
  re-send already-captured lines (`recordsInserted` stays 0 for unchanged files); only new appended
  lines flow. Confirm via the ingest API logs / row counts.
- **Offline capture:** stop `ingest:dev` (terminal A); let the watcher capture (queue `pending` grows);
  restart `ingest:dev` → the backlog drains automatically (retry with backoff), `pending → 0`.

### Level 5: Additional
- **Revoked token → stop:** `UPDATE ingest_tokens SET revoked_at = now()` in psql → the watcher's sync
  loop logs "re-pair needed" and stops syncing (items remain `pending`, not dropped); re-pair restores
  flow.

---

## ACCEPTANCE CRITERIA

- [ ] `collector watch` runs as a continuous background agent that discovers + tails Claude Code session
      files and captures new activity without manual `push` (PRD §8.1).
- [ ] Per-file **byte-offset cursors** persist in `~/.420ai/queue.sqlite`; a restart **resumes** (no
      re-send of already-captured lines) and a **partially-written line is never captured** until
      newline-terminated (PRD §8.1; verified by `tailer.test.ts`).
- [ ] A **durable, disk-backed queue** buffers raw records + events, survives process restart
      (`recoverInflight`), and **dedups** so re-reading a growing file does not re-enqueue unchanged data
      (verified by `queue-store.test.ts`).
- [ ] The **sync worker** drains the queue to the M2 Ingest API, **acks only on 2xx**, **retries with
      capped exponential backoff** on network/5xx (offline-safe), and **stops + surfaces** on 401 — never
      losing or duplicating data (verified by `sync-worker.test.ts` + the integration test; server
      idempotency from M2/PRD §23 is unchanged).
- [ ] A typed **`Connector` framework** (`id` + §10.3 fidelity fields + `watchGlobs` + `parse`) exists
      with **Claude Code** as the one stable connector; adding Codex/Gemini in M4 is implementing the
      interface (no framework change).
- [ ] **Machine identity** is a typed module over `~/.420ai/credentials.json` (`requireCredentials` →
      `NotPairedError` when unpaired); the M2 credentials file still loads unchanged.
- [ ] `collector sync` (one-shot drain) and `collector queue` (backlog/stats) work; SIGINT stops `watch`
      gracefully (final drain + clean DB close).
- [ ] `npm run typecheck` passes (strict, all 4 workspaces, 0 errors).
- [ ] `npx vitest run` passes WITHOUT Docker (units only; integration self-skips) AND WITH Docker (all
      green incl. the Postgres-backed integration test).
- [ ] **No M1/M2 behavior changed**: `ingest`/`report`/`pair`/`push` still work; the fingerprint formula,
      token/event shapes, wire types, and server code are untouched. No new runtime dependency.
- [ ] README "Development (Milestone 3)" documents the agent, the new commands, `~/.420ai/` layout, and
      the Claude-only-connector scope; Status bumped to Milestones 1–3.

## COMPLETION CHECKLIST

- [ ] All 15 tasks completed in order, each VALIDATE passing immediately.
- [ ] Unit suite green with no Docker; full suite green with Docker + filled `.env`.
- [ ] No type/lint errors; libraries log nothing (only `cli.ts` writes stdout / handles SIGINT / exits).
- [ ] Manual real-data run confirms: continuous capture, queue draining, restart-resume, offline-then-
      drain, encryption-at-rest intact, revoked-token stop.
- [ ] `git status` clean of `*.sqlite`/`.env` (queue DB lives in `~/.420ai`, outside the repo).
- [ ] Acceptance criteria all met.

## NOTES

**Design decisions / trade-offs:**

- **Whole-file re-parse per tick + content-hash queue dedup (the central decision).** The M1 Claude
  parser is whole-file (it derives `session.started`/`session.ended` from the earliest/latest timestamp
  across *all* records, and falls back to `${session}:${lineIndex}` ids for records lacking a `uuid`).
  Parsing only the newly-appended bytes would break lifecycle events and destabilize those fallback ids.
  So M3 re-parses the **whole complete-line prefix** each time a file grows and relies on the queue's
  content-hash dedup (PRE-FLIGHT #2) to enqueue only genuinely new/changed items: immutable raw records
  insert once; `session.ended` (whose `ts` advances) re-enqueues on change and the server upserts it;
  everything unchanged is a no-op. At PRD §8.5 session sizes (~0.5–1 MB) this is negligible work and is
  the **simplest provably-correct** option. The byte-offset cursor still does its PRD §8.1 job —
  restart-resume at file granularity and never consuming a partial line. A true line-incremental,
  per-connector streaming parser (better fidelity, no whole-file re-read) is a later optimization once
  M4's richer per-record events justify it; the `Connector` interface can grow a `parseIncremental`
  method without disturbing M3.

- **Poll-based watcher over `fs.watch`/`chokidar` (V1).** The spike showed `fs.watch` fires on this
  machine but leaves a libuv teardown hazard on abrupt exit; polling (`fstat` size vs saved cursor) is
  deterministic, trivially unit-testable (`tickOnce`), portable (Windows-first), dependency-free, and
  matches the PRD's allowance for poll-style liveness. Near-real-time at a ~1–1.5 s interval is well
  within "Streaming (tail)" honesty for the Live Monitor. Event-driven watching is an additive
  optimization (layer `fs.watch` as a *signal* that triggers an immediate `tickOnce`, keeping poll as the
  safety-net) — not needed for M3.

- **One `node:sqlite` DB for queue + cursors, under `~/.420ai/`.** Reuses the exact M1 `SqliteStore`
  conventions (zero native build, synchronous, WAL), co-locates all collector-local state with the M2
  credentials, and keeps it outside the repo (gitignored anyway as `*.sqlite`). A single daemon owns it
  (single-writer) — no cross-process locking needed in V1. `ack` deletes rows so the queue stays small;
  raw records are already durably in Postgres (the sacred copy lives server-side), so the local queue is
  a transient outbox, not an archive.

- **Dedup keys mirror the server's idempotency.** Raw `dedup_key = \`${connector}:${sourceRecordId}\``
  aligns with the server's `unique(machine_id, source_connector, source_record_id)` (the collector is one
  machine, so machine is implicit locally). Event `dedup_key = fingerprint` is the same machine-
  independent key the server upserts on (PRD §23). So local dedup and server dedup agree — a re-send is a
  no-op at both layers.

- **No new server code, no new Postgres tables.** M3 is entirely collector-side; it feeds the *existing*
  M2 Ingest API through the *existing* `postIngest` client. The integration test reuses `buildApp`
  in-process exactly like `push.int.test.ts`. This keeps the milestone tightly scoped and the server
  contract frozen.

- **`session.ended` semantics (known gap, documented in fidelity).** Because the watcher emits whatever
  the whole-file parser produces, `session.ended`'s `ts` reflects the latest event seen *so far* and only
  settles once the file stops growing (the dedup re-syncs each advance). True "session closed on idle"
  detection (emit `session.ended` once after N seconds of no growth) is a small future refinement; it is
  declared in `claudeCodeConnector.fidelity.knownGaps` so the Live Monitor (M9) can label it honestly.

- **Permission scopes deferred.** PRD §8.1 lists per-connector permission scopes; M3 watches only the
  Claude Code path the user already consented to across M1/M2. A real grant store + capture-surface
  approval (PRD §10.3/§18) is a later milestone; M3 does not silently widen capture.

**Confidence Score: 9/10** for one-pass success — earned, not assumed. A focused throwaway spike was
**executed** on this machine and all **24 assertions passed**, retiring every novel runtime mechanic the
milestone rests on: the `node:sqlite` durable-queue dedup (insert-once raw / update-on-change event /
no-op unchanged), the claim/ack/retry/backoff state machine *surviving a simulated crash*, the
byte-offset tail (complete-lines-only, partial held back, restart-resume, truncation reset), glob
discovery of new session files, the `fs.watch`-vs-poll decision, and the full drain → POST →
ack/backoff/stop sync loop over real `fetch`. On top of that, M3 **reuses proven code unchanged** — the
M1 parser, the M2 wire types, the M2 ingest client, and the M2 server (the integration test drives the
real `buildApp` exactly like `push.int.test.ts`). What keeps it at 9 and not 10 is the irreducible
first-write of the *composition* the spike intentionally did not build: `capture-engine.ts` wiring the
proven parts together, the SIGINT graceful-drain lifecycle, and the live-Postgres integration test — all
low-risk given the proven primitives and all caught by the Level 1–3 ladder before the Level 4 real-data
run. The honest way to a literal 10 is to **build and run it**, not to inflate the estimate.

**Relevant Documentation (sources):**
[Node node:sqlite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) ·
[Node fs/promises glob](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisesglobpattern-options) ·
[Node fs readSync](https://nodejs.org/docs/latest-v24.x/api/fs.html#fsreadsyncfd-buffer-options) ·
PRD §8.1 / §10.1.1 / §10.3 / §23 (in-repo) · `docs/research/connector-capture-spike.md` (in-repo)
