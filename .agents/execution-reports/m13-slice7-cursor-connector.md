# Execution Report — M13 Slice 13.7: Cursor connector (SQLite poll capture mode)

## Meta Information

- **Plan file:** `.agents/plans/m13-capability-gap-closure.md` (Slice 13.7)
- **Branch:** `m13-slice7-cursor-connector` (off `main` @ `ab9d322`)
- **Files added (4):**
  - `apps/collector/src/connectors/cursor-store.ts` — node:sqlite read layer
  - `apps/collector/src/connectors/cursor-store.test.ts`
  - `apps/collector/src/connectors/cursor.ts` — pure `parseCursorComposer` + connector + poll
  - `apps/collector/src/connectors/cursor.test.ts`
- **Files modified (9):**
  - `apps/collector/src/connectors/connector.ts` — `PollCapability`/`PollContext`/`PollOutcome`
    contract + `captureMode: "poll"` + registry append
  - `apps/collector/src/capture-engine.ts` — exported `pollLoop`, wired per poll-connector
  - `apps/collector/src/queue/queue-store.ts` — `poll_state` table + `pollChanged`/`pollCommit`
  - `apps/collector/src/connectors/connector-approvals.ts` — poll sources folded into the
    capture-surface fingerprint
  - `packages/shared/src/connector-catalog.ts` — `captureMode` union widened to include `"poll"`
  - test files for the above + `docs/CONTEXT.md`
- **Lines changed:** +362 −13 (source + tests), 4 new files

## Validation Results

- **Syntax & Linting:** ✓ (`prettier --check` on touched markdown passed; NUL + stray-artifact
  scans clean via repo-health)
- **Type Checking:** ✓ `npm run typecheck` (root `tsc -b`) — 0 errors; dashboard + desktop lanes 0
- **Unit Tests:** ✓ `npm run repo-health` — 743 passed / 743 (101 files). +21 new unit tests for
  this slice (cursor parser 16, store 7, poll loop 2, pollChanged/Commit 3, approvals 1, minus
  overlaps).
- **Integration Tests:** N/A for this slice — 13.7 touches `apps/collector` + a type-only widening
  in `packages/shared` only; it adds NO `@420ai/db`/`apps/ingest` schema or query surface, so the
  plan's `--require-db` gate (scoped to 13.2–13.6) is not triggered. No `*.int.test.ts` is affected.
- **Level-4 (live):** partial — validated the novel capture-side logic by running the REAL store
  reader + parser against `%APPDATA%\Cursor\…\state.vscdb` read-only (92 composers → 30 parsed →
  6950 raw records / 18934 events, 0 costed, no ItemTable leak). The full `collector watch → archive
  → Monitor` round-trip was NOT run (needs the paired live stack; the queue→sync→ingest path it
  reuses is unchanged and already tested). See Skipped Items.

## What Went Well

- **Gemini snapshot parser was an exact template.** `parseCursorComposer` mirrors
  `parseGeminiSession` (whole-blob → per-message raw records + events, `makeEvent` closure,
  `mapTokens`, tolerant JSON.parse), so the shape landed quickly and consistently.
- **The spike facts held on real data.** The live read confirmed the plan's spike numbers and the
  fidelity labels: composers are cheap to sweep, `modelName` is "default" almost everywhere (0 of
  30 composers produced a `cost.estimated`), and the `cursorDiskKV`-only discipline keeps
  `ItemTable` secrets out.
- **Additive contract.** `poll?` on `Connector` and `captureMode: "poll"` left every existing
  connector, the FileWatcher, discovery, and both entrypoints byte-for-byte unchanged — the empty
  `watchGlobs` makes the watcher ignore Cursor entirely.
- **node:sqlite BLOB coercion caught early.** A quick probe confirmed `node:sqlite` returns BLOB
  columns as `Uint8Array`; the fixture stores values as Buffers so the coercion path is exercised,
  not just the string path.

## Challenges Encountered

- **The queue's `ack` DELETEs rows, so it can't be the poll change-memory.** The plan's phrasing
  ("the queue's (kind, dedup_key) + content-hash dedup makes unchanged composers a no-op") is only
  true *before* a sync; after ack+delete, a re-enqueue looks brand-new and would re-fetch the whole
  196 MB bubble corpus every tick. Resolved by adding a dedicated persistent `poll_state` table to
  `QueueStore` (a sibling of `file_cursors`) that survives ack. (See Divergence 1.)
- **`captureMode: "poll"` rippled into `@420ai/shared`.** `mergeConnectorCatalog` operates on a
  structural `ConnectorLike` whose `captureMode` is `"tail" | "snapshot"`; widening the `Connector`
  union broke assignability. Fixed by widening `ConnectorLike.captureMode` and the catalog entry
  override to include `"poll"` (both additive).
- **Commit-point ordering (found in self-review).** The first cut recorded the composer hash inside
  the change *check*; a transient failure between check and enqueue would strand the composer. Split
  into read-only `pollChanged` + post-enqueue `pollCommit`. (See Divergence 2.)

## Divergences from Plan

**1. Persistent `poll_state` table instead of relying on queue dedup for change detection**

- **Planned:** "the queue's `(kind, dedup_key)` + content-hash dedup makes unchanged composers a
  no-op … dedup_key = `cursor:<composerId>`, content = composer value hash."
- **Actual:** Added a `poll_state(connector_id, key, content_hash)` table + `pollChanged`/
  `pollCommit` to `QueueStore`; the poll gate uses that, not `queue_items`.
- **Reason:** `queue_items` rows are DELETEd on `ack`, so they cannot remember an already-synced
  composer — the queue-dedup approach would re-sweep all bubbles every tick after the first sync.
  The new table mirrors `file_cursors` (persistent, survives ack) and is the correct analog.
- **Type:** Plan assumption wrong (queue lifecycle).

**2. Split change gate (`pollChanged` + `pollCommit`) with commit-after-enqueue ordering**

- **Planned:** a single change-detection call (implied by "content-hash change detection").
- **Actual:** a read-only `pollChanged` plus a `pollCommit` invoked only after `enqueue` succeeds;
  `PollContext` exposes both.
- **Reason:** honors the FileWatcher's commit-point discipline — recording on the read would strand
  a composer whose enqueue failed. Raised and fixed during code review.
- **Type:** Correctness / better approach.

**3. `run(path, ctx)` poll shape instead of `run(store, enqueue)`**

- **Planned:** `poll.run(store: CursorStoreReader, enqueue: EnqueueFn)`.
- **Actual:** `poll.run(path: string, ctx: PollContext)` where the connector opens/closes its own
  store and `ctx` carries `changed`/`enqueue`/`commit`.
- **Reason:** the connector owns its store layer (open/close, fail-soft on missing/locked), and the
  persistent change gate must be threaded from the engine — a `PollContext` is the clean seam. Keeps
  store lifecycle inside the connector and change-memory inside the engine/queue.
- **Type:** Better approach found.

**4. `parseCursorComposer` lives in `apps/collector` (not `packages/shared`)**

- **Planned/Actual match:** the New-Files table places `cursor.ts` under `apps/collector` — followed
  as written. Noting explicitly because the sibling 13.3 parsers live in `@420ai/shared`: Cursor's
  parser stays collector-local because the server re-parse engine (13.3) covers Claude+Codex only
  and cleanly skips `"cursor"` into `skipped.other` (verified `reparse.ts:156`). The composer-
  envelope raw record is still stored so a FUTURE re-parse is possible.
- **Type:** N/A (documentation of intent).

## Skipped Items

- **Full live `collector watch` → archive → Monitor round-trip (Level-4).** Requires a paired,
  running ingest stack + dashboard; not run autonomously. Mitigation: the capture-side novelty
  (store read + parse + poll gate) was validated directly against the real store, and the
  downstream queue→sync→ingest path is unchanged and already covered by existing tests. Recommend a
  manual live capture before milestone sign-off.
- **Milestone-wrap SUMMARY.md §0/§3/§6 + PRD §25 M13 retrospective.** The plan lists this as "the
  final task" of the whole milestone spanning all 7 slices' actual outcomes. Slice 13.7 makes the
  one direct doc change it owns (CONTEXT.md: Cursor now captured); the comprehensive milestone
  retrospective is best written as a deliberate M13-completion pass with every slice's outcome in
  hand, and is left for that step.

## Recommendations

- **Plan command:** when a plan says "the queue dedups it for free," verify the persistence
  lifecycle (does `ack`/GC delete the row?) before treating dedup as durable change-detection. A
  one-line note on queue-row lifetime would have pre-empted Divergence 1.
- **Execute command:** the commit-point-ordering rule (record state only after the side effect
  succeeds) generalizes beyond the FileWatcher — worth a standing check for any new "observe →
  act" loop.
- **CLAUDE.md addition:** consider a short "Poll-mode connectors" note under the collector section:
  poll change-memory lives in `poll_state` (persistent, survives ack, unlike `queue_items`), and
  poll loops honor commit-point ordering (`pollChanged` read-only; `pollCommit` after enqueue) —
  so future poll connectors (e.g. Antigravity) copy the discipline rather than re-derive it.
