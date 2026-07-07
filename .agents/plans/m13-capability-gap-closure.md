# Feature: M13 — Capability Gap Closure (milestone bundle, Slices 13.1–13.7)

The following plan should be complete, but it is important that you validate documentation and
codebase patterns and task sanity before you start implementing. Pay special attention to naming of
existing utils, types, and models — import from the right files.

Conventions live in [`CLAUDE.md`](../../CLAUDE.md) (linked, not re-pasted — per its own rule).
Background: [`SUMMARY.md`](../../SUMMARY.md), [`docs/PRD.md`](../../docs/PRD.md) §14/§15/§17/§19/§20/§21/§23.

> **How to execute this milestone:** like M12, each slice below is run through the build loop
> (`/lril:execute` on ONE slice at a time → `/lril:code-review` → commit) **in the stated order**.
> Every slice is independently shippable and gate-green on its own. Do NOT start a slice before the
> previous one is committed. All facts below were verified during planning (2026-07-07) against
> commit `298f9b9` on `m13-capability-gap-closure`; spike outputs are quoted in NOTES.

## Feature Description

M13 closes every promised-vs-actual gap surfaced by the 2026-07-07 codebase reconciliation, taking
the product from "capture-and-archive platform with a thin intelligence layer" to the full PRD
promise:

1. **13.1 Truth & small fixes** — stale doc claims, the `lastSyncAt` TODO, updater signing-key
   runbook + wiring.
2. **13.2 Report engine expansion + §17** — the 5 missing PRD §15 report types + deterministic
   context-governance recommendations.
3. **13.3 Archive re-parse engine (12.5b)** — server-side decrypt → re-parse → upsert-by-fingerprint
   + orphan-event GC; parsers relocated to `@420ai/shared`.
4. **13.4 Incremental search + dashboard polish** — at-ingest index maintenance, `<b>` highlight,
   rich Markdown/Mermaid report rendering, list pagination.
5. **13.5 Alert delivery completion** — SMTP deliverer + fan-out, deliver-on-resolve, windowed
   connector-failure-rate alert.
6. **13.6 Scheduled reports + guided onboarding** — OS-cron report generation script + quickstart +
   setup script + first-run dashboard empty state.
7. **13.7 Cursor connector** — the new SQLite **poll** capture mode over
   `%APPDATA%\Cursor\User\globalStorage\state.vscdb` (research gate re-opened and CLOSED by live
   spike — see NOTES).

Out of scope (stays parked per earlier decisions): MSI/WiX, CA/Authenticode code signing, CI release
workflow, Antigravity connector, multi-user/RBAC (V2), semantic/vector search (V2).

## User Story

As an AI-heavy developer running 420AI self-hosted
I want the product to actually deliver every capability its PRD promises — the full report suite,
history that heals under improved parsers, search that stays fresh, alerts that reach me, and
capture of my Cursor sessions
So that the "Session Intelligence Platform" name is earned: I can see which tools/models are worth
the spend, where context is wasted, and trust that nothing silently drifts from the written scope.

## Problem Statement

A code-vs-PRD reconciliation (2026-07-07, following UAT) found the intelligence layer is the
thinnest part of the product: only 2 of 7 §15 report types exist, §17 context governance has no
deterministic implementation, parser improvements never reach history (no 12.5b), the search index
goes stale between manual reindexes, alert delivery is webhook-only, reports are manual-only, the
desktop updater cannot verify (placeholder pubkey), a `lastSyncAt` TODO renders "—" forever, two doc
claims are false, and Cursor sessions are not captured despite a verified-recoverable store.

## Solution Statement

Seven dependency-ordered slices, each additive and gate-green. The two load-bearing design decisions
(resolved during planning — do not re-litigate):

- **D-M13-1 (encryption split vs. reports):** tool names, file paths, and `failureClass` live in the
  ENCRYPTED event payload; `model`, `event_type`, `tokens`, `cost`, `ts`, `session_id`,
  `project_path` are plaintext (schema.ts:42-48, verified). Therefore: *tool/model comparison*,
  *project efficiency*, and *trend anomalies* are pure-plaintext orchestrators (existing D3
  "reports never decrypt" discipline). *Failed tool call* and *context waste* get a **decrypt →
  redact → aggregate** orchestrator following the established M8/search-reindex server-side decrypt
  precedent (`transcript.ts:67`, `search.ts:103`) — decrypted values are classified/counted and only
  `redact()`-ed strings may appear in the markdown/metrics. We do NOT promote encrypted fields to
  plaintext columns (no migration, no privacy regression, no fingerprint ripple).
- **D-M13-2 (12.5b scope):** re-parse covers **Claude Code + Codex only**. Gemini raw records are
  per-message re-serializations that cannot reconstruct the parser's whole-file input (session
  envelope `startTime`/`lastUpdated`/`projectHash` is not stored — verified). The engine skips
  Gemini sessions and reports them in its response (`skipped.gemini` count) — "label honestly."

## Feature Metadata

**Feature Type**: New Capability (milestone bundle)
**Estimated Complexity**: High (bundle) — individually: 13.1 Low, 13.2 High, 13.3 High, 13.4 Medium,
13.5 Medium, 13.6 Low-Medium, 13.7 High
**Primary Systems Affected**: `packages/shared`, `packages/db`, `apps/ingest`, `apps/dashboard`,
`apps/collector`, `apps/desktop` (runbook/docs only), `docs/`
**Dependencies (new, verified available 2026-07-07)**: `nodemailer@9.0.3` (engines node>=6),
`react-markdown@10.1.0`, `remark-gfm@4.0.1`, `mermaid@11.16.0`

---

## CONTEXT REFERENCES

### Relevant Codebase Files — READ THESE BEFORE IMPLEMENTING (per slice)

**13.1:**

- `docs/CONTEXT.md` (line 237) — false claim: first release captures "…and Antigravity sessions". Fix.
- `apps/ingest/src/routes/exports.ts` (line 29) — stale "Parquet deferred" comment above working Parquet.
- `apps/collector/src/serve.ts` (lines 181-184) — `TODO(Slice 2)`: `lastSyncAt` hardcoded `null`.
- `apps/collector/src/capture-engine.ts` — `runCaptureEngine` must surface last successful sync time
  (the sync loop already knows success/failure via `syncOnce` outcomes; see `sync-worker.ts`).
- `apps/desktop/src-tauri/tauri.conf.json` — `plugins.updater.pubkey` = `"REPLACE_WITH_TAURI_UPDATER_PUBKEY"`.
- `docs/guide/operations.md` — home of runbooks; add the key-ceremony runbook here.

**13.2:**

- `apps/ingest/src/reports/generate-report.ts` (94 lines, whole file) — the orchestrator pattern:
  `Promise.all(projections) → metrics → pure renderer → insertReportArtifact`; clock injected.
- `packages/shared/src/reports.ts` — `ReportType` union (:25), `REPORT_VERSION="m7-report-v1"` (:36),
  `renderCostOverTimeReport` (:63), `renderSessionAutopsyReport` (:146), `fmtUsd` (:43).
- `packages/db/src/repositories/projections.ts` — `usageTotals` (:77), `usageByModel` (:98),
  `usageOverTime` (:126), `sessionProjections` (:228), `sessionAggregateColumns` (:161),
  `connectorHealth` (:264); the `tokenSum`/`costSum` SQL fragments (:39-48) — MIRROR these for new
  aggregates (they already obey the DB gotchas).
- `packages/db/src/repositories/git.ts` — `gitCommitsByProject(db, projectId)` for outcome proxies.
- `packages/db/src/repositories/transcript.ts` (:67-141) — the decrypt-join pattern
  (`events → rawSourceRecords ON sourceRecordId=rawRecordId AND sessionId`) for the two
  decrypt-bearing reports.
- `packages/shared/src/redaction.ts` — `redact()`; every decrypted string that reaches
  markdown/metrics passes through it first.
- `apps/ingest/src/routes/reports.ts` (:38-88) — the two POST endpoints; the `type` body field is a
  single-value enum today (schemas.ts:192,202) — this slice turns it into the dispatch switch.
- `apps/ingest/src/schemas.ts` (:192,202) — `generateProjectReportBodySchema` /
  `generateSessionReportBodySchema`.
- `apps/dashboard/src/components/projects/project-report-actions.tsx` — `busy: null|"cost"|"ai"`
  button pattern to extend.
- `docs/PRD.md` lines 435-525 — §14 metric categories, §15 the 7 report types, §17 the 8 ignore
  categories (lock files, generated files, build outputs, dependency folders, logs, large irrelevant
  artifacts, repeated duplicated context, binary/base64 blobs).

**13.3:**

- `apps/collector/src/connectors/claude-code.ts` — `parseClaudeCodeSession` (:98-298) is PURE
  (string→ParseResult); node-only imports (`glob`, `join`, `scanLines`) are used ONLY by
  discovery/watch code. Same structure in `codex-cli.ts` (`parseCodexSession` :158-334,
  `classifyCodexOutput` :119) and `gemini-cli.ts` (`parseGeminiSession` :96-201).
- `apps/collector/src/connectors/connector.ts` (:21-27) — `ParseResult` type; MOVES to shared (it
  references only shared types).
- `packages/db/src/repositories/ingest.ts` (:18-114) — `ingestBatch(db, machineId, batch, repricing?)`;
  events `ON CONFLICT (fingerprint) DO UPDATE` re-stamps parserVersion/catalogVersion/tokens/cost/payload.
  This IS the re-parse write path. It NEVER deletes → the GC step is this slice's responsibility.
- `packages/db/src/repositories/search.ts` (:103-226, `rebuildSearchIndex`) — the "read all raw
  records for a session, decrypt, process" loop to mirror for the re-parse sweep.
- `packages/db/src/crypto.ts` — `decryptField({ciphertext,iv,tag})` (:105-117), keyring-aware.
- `apps/ingest/src/routes/replay.ts` (:11,14-25) — the reprice route to mirror; header comment
  already reserves `/v1/replay/reparse`.
- `packages/db/src/repositories/reprice.ts` (:20-26) — batched-sweep + idempotency pattern.
- `packages/db/src/reprice-run.ts` + `reprice-cli.ts` — the CLI orchestrator/entrypoint split to
  mirror for `db:reparse`.
- `packages/shared/src/ingest.ts` — `toRawRecordPayload` (:88), `toEventPayload` (:103), and the
  "server must NOT recompute fingerprints" contract note (:11-14).
- `apps/ingest/src/replay.int.test.ts` — int-test template.
- `apps/collector/src/connectors/codex-cli.ts` (:21-27) — the PARSER_VERSION comment assigning
  stale-typed-event GC to this slice.

**13.4:**

- `packages/db/src/repositories/search.ts` — PRIVATE `upsertDoc(db, doc)` (:68-91) + `DocInput`
  (:53-60): export a session-scoped variant; the session-doc build steps at :169-222 are the code to
  extract into a reusable `buildSessionDoc`.
- `apps/ingest/src/routes/ingest.ts` (:14-24) — the post-`ingestBatch` seam (AFTER the transaction
  returns; the hot path stays untouched — this was 12.1's explicit deferral rationale).
- `apps/dashboard/src/components/search/search-view.tsx` (:28-31,184) — `plainSnippet` strips `<b>`;
  ts_headline emits default `<b>`/`</b>` (no StartSel/StopSel override at search.ts:254).
- `apps/dashboard/src/components/reports/reports-view.tsx` (:24-25,101-103) — `<pre>` markdown render
  to replace with react-markdown + Mermaid client component.
- `apps/dashboard/next.config.ts` — NO CSP/headers() today; Mermaid inline SVG is unblocked.
- `apps/ingest/src/schemas.ts` (:400-411) — search querystring schema (limit 1..100, NO offset);
  projects/reports list endpoints have no limit/offset at all.
- `packages/db/src/repositories/projects.ts` `listProjects`, `reports.ts` `listReportArtifacts` —
  gain `{limit, offset}` opts.

**13.5:**

- `apps/ingest/src/delivery/alert-deliverer.ts` — `AlertDeliverer` interface (:13-15),
  `createWebhookDeliverer(cfg|null): AlertDeliverer|null` (:28-41). MIRROR for SMTP; add a fan-out.
- `apps/ingest/src/server.ts` (:88-102) — deliverer wiring from env; `app.ts:123`
  `app.decorate("alertDeliverer", …)` is a SINGLE slot → the fan-out composes into one.
- `packages/db/src/repositories/alert-firings.ts` — `deliverPendingFirings` (:213-244, at-most-once
  via `deliveryAttemptedAt`), `reconcileAlertFirings` (:100-142, stamps `status='resolved',
  resolvedAt=now`) — resolution already exists; deliver-on-resolve needs a NEW
  `resolve_delivered_at` column (migration 0012) + a `deliverResolvedFirings` sibling.
- `packages/db/src/schema.ts` (:436-467) — `alert_firings` columns.
- `packages/shared/src/alerts.ts` — `deriveAlerts` (:87, FROZEN), the windowed siblings
  `deriveAuthFailureAlerts` (:242) / `deriveArchiveUnreachableAlerts` (:264) to mirror for
  `deriveConnectorFailureRateAlerts`; `AlertCode` union (:37-45); `sortAlerts` (:149); the module
  doc (:50-56) explicitly names the windowed rate as the deferred refinement.
- `packages/db/src/repositories/projections.ts` `connectorHealth` (:264-294) — copy into a
  `connectorHealthWindowed(db, userId, sinceIso)` with `gte(events.ts, sinceIso)`.
- `apps/ingest/src/routes/monitor.ts` (:83-89 buildSnapshot merge; :102-108 deliverFirings) — where
  the new derive + the resolve-delivery pass plug in.
- `packages/db/drizzle/` + `drizzle/down/` — migration 0012 + rollback (`npm run db:generate`).

**13.6:**

- `docs/guide/operations.md` (:98-102) — "**no in-server scheduler — use the OS**": scheduled
  reports MUST follow this precedent (a script + Task Scheduler/cron docs), NOT an in-process loop.
- `apps/ingest/src/routes/reports.ts` — the endpoints the script calls; `ADMIN_TOKEN` (retained as
  the service credential precisely for machine-to-machine calls) is the script's auth.
- `.env.example` — the setup script's source of truth for required keys + inline gen commands.
- `apps/ingest/src/server.ts` (:12-23) — hard-fails without DATABASE_URL/ADMIN_TOKEN/SESSION_SECRET
  (what "setup complete" must produce).
- `apps/dashboard/src/components/live-monitor.tsx` + `app/monitor/page.tsx` — first-run empty state
  (machines list empty → onboarding card) goes in the monitor page shell.
- `docs/PRD.md` (:560-577) — the canonical 13 onboarding steps the quickstart mirrors.

**13.7:**

- `apps/collector/src/connectors/connector.ts` — the `Connector` contract; this slice adds an
  OPTIONAL `poll` capability (additive; existing connectors untouched).
- `apps/collector/src/capture-engine.ts` — `gitSweepLoop` is the exact precedent for a best-effort
  interval loop beside watcher/sync (mirror its structure, cadence config, and abort wiring).
- `apps/collector/src/queue/queue-store.ts` — `enqueue` dedups by `(kind, dedup_key)` + content-hash
  change detection — this is what makes snapshot polling cheap (unchanged composer → no-op).
- `apps/collector/src/connectors/gemini-cli.ts` — the snapshot-mode parser precedent (whole-blob →
  per-message raw records) that the Cursor parser mirrors.
- `apps/collector/src/connectors/registry.ts` + `connector-approvals.ts` — the new connector
  registers like the others and flows through approval fingerprinting (its "watchGlobs" equivalent =
  the vscdb path, so scope drift gates on approval).

### New Files to Create

| Slice | File | Purpose |
| --- | --- | --- |
| 13.1 | `docs/guide/operations.md` §13.1 (edit) | Updater key ceremony runbook |
| 13.2 | `packages/shared/src/report-metrics.ts` | Pure metric types + `detectAnomalies` + `classifyContextPath` |
| 13.2 | `packages/shared/src/report-metrics.test.ts` | Unit tests (anomaly + §17 classifier) |
| 13.2 | `packages/db/src/repositories/report-projections.ts` | `toolStatsByModel`, `failureSeries`, decrypt-bearing `failedToolBreakdown`, `contextPathSample` |
| 13.2 | `apps/ingest/src/reports/generate-report-m13.ts` | The 5 new orchestrators (keeps generate-report.ts small) |
| 13.2 | `apps/ingest/src/reports/reports-m13.int.test.ts` | Int tests per new type |
| 13.3 | `packages/shared/src/parsers/{claude-code,codex-cli,gemini-cli}.ts` | Relocated PURE parsers (+ `parse-result.ts` for `ParseResult`) |
| 13.3 | `packages/db/src/repositories/reparse.ts` | `reparseAll(db, opts)` sweep + orphan GC |
| 13.3 | `packages/db/src/reparse-run.ts` + CLI wiring | `db:reparse` (mirror reprice-run/reprice-cli) |
| 13.3 | `apps/ingest/src/reparse.int.test.ts` | Reclassification + GC int test |
| 13.4 | `apps/dashboard/src/components/reports/report-markdown.tsx` | react-markdown + Mermaid client island |
| 13.5 | `apps/ingest/src/delivery/smtp-deliverer.ts` (+ test) | `createSmtpDeliverer`, `createFanoutDeliverer` |
| 13.5 | `packages/db/drizzle/0012_*.sql` + `down/` | `alert_firings.resolve_delivered_at` |
| 13.6 | `scripts/generate-reports.mjs` | OS-cron report generation script |
| 13.6 | `scripts/setup-env.mjs` | Non-interactive `.env` generator (refuses to overwrite) |
| 13.6 | `docs/guide/quickstart.md` | PRD §19 guided walk (13 steps) |
| 13.7 | `apps/collector/src/connectors/cursor.ts` (+ test) | Pure `parseCursorComposer` + connector object |
| 13.7 | `apps/collector/src/connectors/cursor-store.ts` (+ test) | node:sqlite read layer (open live read-only, composer sweep, per-composer bubble fetch) |

### Relevant Documentation

- [Postgres ts_headline](https://www.postgresql.org/docs/current/textsearch-controls.html#TEXTSEARCH-HEADLINE)
  — default `StartSel=<b>, StopSel=</b>` (why the dashboard can bold without server change).
- [Tauri updater — signing](https://v2.tauri.app/plugin/updater/#signing-updates) — `cargo tauri
  signer generate`, `TAURI_SIGNING_PRIVATE_KEY`/`_PASSWORD` env at build time.
- [nodemailer SMTP transport](https://nodemailer.com/smtp/) — `createTransport(smtpUrl)` accepts a
  `smtps://user:pass@host:port` URL string (single-env-var config, mirrors `ALERT_WEBHOOK_URL`).
- [react-markdown](https://github.com/remarkjs/react-markdown#use) + [remark-gfm](https://github.com/remarkjs/remark-gfm)
  — tables require the gfm plugin (reports render tables).
- [mermaid API](https://mermaid.js.org/config/usage.html#api-usage) — `mermaid.render(id, code)`
  returns SVG; call from a `"use client"` island in `useEffect` (never SSR).
- [node:sqlite](https://nodejs.org/api/sqlite.html) — `new DatabaseSync(path, {readOnly: true})`;
  already the queue's engine (zero new native deps).

### Patterns to Follow

Aggregate SQL, error handling, logging, naming, module discipline: see
[`CLAUDE.md`](../../CLAUDE.md) — especially **Drizzle/SQL gotchas** (ISO-normalize aggregate
timestamps; `Number()` a numeric; `sql.raw` closed-set keywords), **Logging/process boundaries**
(libraries never log/exit), and **Collector outbound HTTP** (every fetch timeout-bounded AND
abort-cancellable).

**Spike-snippet fidelity — Cursor store reads (assertions from the live spike, 2026-07-07):**

```ts
// cursor-store.ts core reads — every line below was executed against the LIVE store during planning:
const db = new DatabaseSync(vscdbPath, { readOnly: true });          // live open OK while Cursor runs
// composer sweep: 383 rows, 14.3 MB total, max single 2.61 MB — cheap at poll cadence
const composers = db.prepare(
  "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND value IS NOT NULL"
).all();
// per-composer bubbles — key format PROVEN: bubbleId:<composerId>:<bubbleId>
const bubbles = db.prepare(
  "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:' || ? || ':%' AND value IS NOT NULL"
).all(composerId); // MUST filter NULLs: 26 of 22368 bubble values are NULL. May return 0 rows.
// NEVER read ItemTable — it holds 43 secret-ish keys (aiSettings/tokens). cursorDiskKV only.
```

**Report orchestrator shape (mirror generate-report.ts:32-70 exactly):** projections via
`Promise.all` → `metrics` object stored verbatim on the artifact → pure renderer in
`@420ai/shared` → `insertReportArtifact`. `generatedAt` is route-owned (`new Date().toISOString()`
in the route, never in the orchestrator/renderer).

---

## IMPLEMENTATION PLAN + STEP-BY-STEP TASKS

Execute slices in order; within a slice, tasks top-to-bottom. Each slice ends with the full gate.

---

### Slice 13.1 — Truth & small fixes (S)

**UPDATE `docs/CONTEXT.md`** (line 237)

- **IMPLEMENT**: remove "and Antigravity" from the first-release capture claim; note Antigravity is
  deferred (12.7d) and Cursor arrives in 13.7.
- **VALIDATE**: `grep -n "Antigravity sessions" docs/CONTEXT.md` → no first-release claim.

**UPDATE `apps/ingest/src/routes/exports.ts`** (line 29)

- **IMPLEMENT**: replace the stale "Parquet deferred" header comment with the actual state (Parquet
  events export shipped in 12.8; report/transcript remain MD/JSON/JSONL).
- **VALIDATE**: `grep -n "Parquet" apps/ingest/src/routes/exports.ts` — comment matches code.

**UPDATE `apps/collector/src/capture-engine.ts` + `apps/collector/src/serve.ts`**

- **IMPLEMENT**: engine tracks `lastSyncAt: string | null` — set to `new Date().toISOString()` after
  each `syncOnce` outcome of `"ok"` (the sync loop site; see how `consecutiveSyncFailures` is
  tracked in `sync-worker.ts` and mirror that wiring). Expose it on the engine handle/status the
  same way `state` is exposed; `serve.ts:181-184` replaces the hardcoded `null` and drops the TODO.
- **GOTCHA**: `serve.ts` is an entrypoint; the engine is a library — the engine RETURNS the value,
  it does not log (CLAUDE.md process boundaries).
- **VALIDATE**: `npx vitest run apps/collector/src/serve.test.ts apps/collector/src/capture-engine.test.ts`
  (extend: status after a successful sync carries a non-null ISO `lastSyncAt`).

**UPDATE `docs/guide/operations.md` + `apps/desktop/README.md`** — updater key ceremony runbook

- **IMPLEMENT**: a "13.1 Updater signing key (one-time ceremony)" section. Exact commands (verified
  on this machine — `cargo-tauri.exe` present in `~/.cargo/bin`):
  1. `cargo tauri signer generate -w .secrets/tauri-updater.key --ci` (from `apps/desktop`;
     `--ci` skips prompts; `.secrets/` is already gitignored — same home as the catalog key).
  2. Paste the printed PUBLIC key into `tauri.conf.json` `plugins.updater.pubkey`
     (replacing `REPLACE_WITH_TAURI_UPDATER_PUBKEY`).
  3. Build releases with `TAURI_SIGNING_PRIVATE_KEY` (file path or content) +
     `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty if none) in env; `createUpdaterArtifacts: true`
     (already set) emits `latest.json` + signatures for the existing GitHub Releases endpoint.
  4. Note: pubkey commit is safe; the private key NEVER commits (assert `git check-ignore .secrets/tauri-updater.key`).
- **GOTCHA**: the ceremony itself is the maintainer's manual action (user decision 2026-07-07) — the
  slice ships the runbook + verifies the config wiring, not the real key.
- **VALIDATE**: runbook section exists; `git check-ignore .secrets/tauri-updater.key` exits 0.

---

### Slice 13.2 — Report engine expansion + §17 context governance (L)

Five new `ReportType`s (all project-scoped except noted):
`project.tool_model_comparison`, `project.failed_tool_calls`, `project.context_waste`,
`project.efficiency`, `project.trend_anomalies`. `report_artifacts.report_type` is free text —
**no migration**.

**CREATE `packages/shared/src/report-metrics.ts`** (+ test)

- **IMPLEMENT**:
  - `ToolModelComparisonInput/Row`, `FailedToolReportInput`, `ContextWasteInput`,
    `EfficiencyInput`, `TrendAnomaliesInput` metric types.
  - `detectAnomalies(series: {bucket: string; value: number}[], opts?): AnomalyFlag[]` — pure
    rolling z-score (window default 4 trailing buckets, flag |z| ≥ 2, require ≥4 points; return
    `{bucket, value, zScore, direction}`); deterministic, clock-free.
  - `classifyContextPath(path: string): ContextWasteClass | null` — the §17 taxonomy as a pure
    classifier: `lockfile` (package-lock.json, yarn.lock, pnpm-lock.yaml, Cargo.lock, …),
    `dependency-dir` (/node_modules/, /vendor/, /.venv/, /target/), `build-output` (/dist/,
    /build/, /.next/, /out/), `generated` (*.min.js, *.map, *.d.ts), `log` (*.log),
    `binary-or-large` (extension list), else null (fine).
- **PATTERN**: pure/clock-free like `alerts.ts` derive family; export via `packages/shared/src/index.ts`.
- **VALIDATE**: `npx vitest run packages/shared/src/report-metrics.test.ts`

**CREATE `packages/db/src/repositories/report-projections.ts`**

- **IMPLEMENT** (plaintext aggregates — MIRROR the SQL fragments at projections.ts:39-48; obey the
  CLAUDE.md Drizzle gotchas — every `min/max/date_trunc` timestamp normalized
  `new Date(v).toISOString()`, counts `::int`, money `Number()`):
  - `toolStatsByModel(db, projectId)` → per `model`: tokens, costUsd, toolCalls, toolsCompleted,
    toolsFailed, sessions (`count(distinct session_id)`), firstSeen/lastSeen (ISO-normalized).
  - `failureSeries(db, projectId, bucket: "day"|"week")` → per bucket: toolCalls, toolsFailed
    (`sql.raw` the guarded bucket keyword — NEVER a bound param), plus sessions count.
  - **Decrypt-bearing** (D-M13-1; mirror the transcript.ts:83-114 join + decrypt loop):
    - `failedToolBreakdown(db, projectId)` — join `tool.call.failed` events → raw records, decrypt
      payloads, tally `failureClass` (Codex; absent → `"unclassified"`) and tool `name`
      (`redact()`-ed) → `{byClass: Record<string, number>, byTool: {tool, count}[], coverage: {classified, total}}`.
    - `contextPathSample(db, projectId)` — decrypt `file.read`/`file.modified`/`context.loaded`
      payloads, classify via `classifyContextPath`, count per class + top-10 offending paths per
      class (paths `redact()`-ed), plus per-connector event coverage counts (context.loaded is
      Claude-only; file.read Claude-only; Codex has file.modified only; Gemini none — the report
      MUST print this coverage table; "label honestly").
- **GOTCHA**: decrypt loops process only the project's matching event types (small row counts), not
  whole sessions; `decryptField` throws loudly on key mismatch — let it propagate (route → 500 is
  correct for a broken key).
- **VALIDATE**: `npm run repo-health` (unit layer) — int coverage lands with the orchestrator tests.

**CREATE `apps/ingest/src/reports/generate-report-m13.ts`**

- **IMPLEMENT**: five orchestrators mirroring `generateProjectCostReport` (:32) exactly:
  `generateToolModelComparisonReport`, `generateFailedToolCallsReport`,
  `generateContextWasteReport` (metrics also embed the §17 ignore-recommendation list derived from
  classified paths — this IS the deterministic §17 deliverable), `generateProjectEfficiencyReport`
  (usageTotals + sessionProjections ratios + gitCommitsByProject outcome proxies),
  `generateTrendAnomaliesReport` (usageOverTime + failureSeries → `detectAnomalies` per series).
  Renderers live in `packages/shared/src/reports.ts` (5 new `renderXxx` functions; Markdown tables
  authoritative + one Mermaid block each, mirroring renderCostOverTimeReport's style).
- **GOTCHA**: bump nothing on existing renderers; `REPORT_VERSION` stays `"m7-report-v1"` for the
  old two — new renderers stamp a new `REPORT_VERSION_M13 = "m13-report-v1"` constant carried in
  their artifacts' `reportVersion`.

**UPDATE `apps/ingest/src/schemas.ts` + `apps/ingest/src/routes/reports.ts`**

- **IMPLEMENT**: widen `generateProjectReportBodySchema.type` enum to the six project types; the
  POST handler switches on `body.type ?? "project.cost_over_time"` → orchestrator (default
  preserves today's behavior byte-for-byte). 404-guard (`getProjectName`) stays FIRST (unknown id →
  404, never a constraint 500).
- **VALIDATE**: `npm run repo-health -- --require-db` — new int tests in
  `reports-m13.int.test.ts`: seed events (mirror the seeding in the existing reports int test),
  POST each type, assert 201 + metrics shape + a redaction assertion (a seeded secret-looking
  string never appears in markdown), and `type` omitted still yields cost report.

**UPDATE dashboard: `project-report-actions.tsx`**

- **IMPLEMENT**: replace the two hardcoded buttons with a type-select + one Generate button
  (`busy` keyed by type); POST body `{type}` — the proxy already forwards verbatim (zero proxy change).
- **VALIDATE**: `npm run typecheck:dashboard && npm run build:dashboard`

---

### Slice 13.3 — Archive re-parse engine (12.5b) (L)

**CREATE `packages/shared/src/parsers/`** (relocation — behavior-identical move)

- **IMPLEMENT**: move the PURE units verified movable: `parse-result.ts` (`ParseResult` from
  connector.ts:21-27), `claude-code.ts` (`parseClaudeCodeSession` + `mapTokens` + `makeEvent` +
  `FILE_READ_TOOLS`/`FILE_MODIFY_TOOLS` + `CLAUDE_CODE_CONNECTOR` + `PARSER_VERSION`),
  `codex-cli.ts` (`parseCodexSession` + `classifyCodexOutput` + `CodexFailureClass` + consts),
  `gemini-cli.ts` (`parseGeminiSession` + consts). Discovery/watch code (`discover*Roots`,
  `first*Cwd`, `*WatchGlobs`, the `Connector` object literals) STAYS in collector and imports the
  parse functions from `@420ai/shared`. Re-export from `packages/shared/src/index.ts`. Collector's
  `connector.ts` re-exports `ParseResult` from shared (zero churn for its other importers).
- **GOTCHA**: `packages/shared` stays dependency-free (parsers use only shared helpers +
  `node:crypto` via `eventFingerprint` — verified). `apps/collector` already references shared in
  tsconfig + package.json — NO new edges. Parser files move with their tests.
- **VALIDATE**: `npm run typecheck` (root, 0 errors) + `npx vitest run packages/shared/src/parsers/`
  — the moved tests pass unmodified except import paths.

**CREATE `packages/db/src/repositories/reparse.ts`**

- **IMPLEMENT** `reparseAll(db, opts?: {sessionId?: string}): Promise<ReparseOutcome>`:
  1. Enumerate distinct `(sessionId, sourceConnector, machineId)` from `raw_source_records`
     (skip `sourceConnector === GEMINI_CLI_CONNECTOR` → count into `skipped.gemini`; D-M13-2).
  2. Per session: read raw rows (mirror search.ts:191-207), `decryptField` each payload.
     **Reassembly order**: Codex — sort by the numeric `lineIndex` suffix of
     `sourceRecordId` (`"${session}:${lineIndex}"`, verified format); Claude — sort by the
     `timestamp` field inside each decrypted JSONL line (parse, fall back to stored order).
     Join with `"\n"` → `fileText`.
  3. `parse*Session(fileText)` → `ParseResult`; map via `toRawRecordPayload`/`toEventPayload` →
     `ingestBatch(db, machineId, batch, activeCatalog?)` (re-stamps parser/catalog versions, re-prices).
  4. **Orphan GC (the 12.7a debt)**: after the upsert, `DELETE FROM events WHERE session_id = $s
     AND raw_record_id = ANY(reparsedRawIds) AND fingerprint NOT IN (freshFingerprints)` — i.e.
     per raw record, any fingerprint the fresh parse no longer produces. Return
     `{sessions, eventsUpserted, orphansDeleted, skipped: {gemini}}`.
- **GOTCHA**: session batches, not one mega-transaction (mirror reprice BATCH discipline); the
  raw-record upsert inside ingestBatch is a no-op by design (`ON CONFLICT DO NOTHING` on the same
  idempotency key) — raw records stay sacred/immutable.
- **VALIDATE**: int test (below).

**CREATE route + CLI**

- **IMPLEMENT**: `POST /v1/replay/reparse` in `routes/replay.ts` (admin gate, mirror reprice, body
  `{sessionId?}`); `packages/db/src/reparse-run.ts` + `db:reparse` npm script mirroring
  `reprice-run.ts`/`reprice-cli.ts` (clean refusal messages, no stack traces — the F.5 lesson).
- **VALIDATE**: `npm run db:up && npm run db:migrate && npm run repo-health -- --require-db`.
  `reparse.int.test.ts` MUST prove the headline: ingest a Codex session fixture under a simulated
  1.0.0 parse (a `tool.call.completed` for a failing call), run `reparseAll`, assert the event is
  now `tool.call.failed` with `failureClass`, the stale `completed` fingerprint row is DELETED
  (orphan GC), total event count is stable, and a second run is a no-op (idempotent).

---

### Slice 13.4 — Incremental search + dashboard polish (M)

**UPDATE `packages/db/src/repositories/search.ts`**

- **IMPLEMENT**: extract the session-doc build (:169-222) into an exported
  `indexSessions(db, sessionIds: string[]): Promise<number>` (decrypt→cap 48000→redact→upsert per
  session; reuse the private `upsertDoc`); `rebuildSearchIndex` calls it for all sessions
  (behavior-identical refactor).
- **UPDATE `apps/ingest/src/routes/ingest.ts`**: AFTER `ingestBatch` returns (post-transaction —
  the hot path stays untouched, honoring the 12.1 rationale), fire-and-forget
  `indexSessions(app.db, touchedSessionIds)` with `.catch(log)` — sessionIds from
  `request.body.records`. Also upsert project/report docs at their mutation sites
  (`routes/projects.ts` create/rename → project doc; `insertReportArtifact` call sites → report doc).
- **GOTCHA**: never let index maintenance fail the ingest response (best-effort, like
  `deliverFirings` in monitor.ts:102-108).
- **VALIDATE**: int test — ingest a batch, then `GET /v1/search?q=<seeded term>` hits WITHOUT
  calling reindex.

**UPDATE dashboard: search highlight + markdown + pagination**

- **IMPLEMENT**:
  - `search-view.tsx`: replace `plainSnippet` with a safe `<b>`-only renderer (split on
    `<b>`/`</b>` markers → `<strong>` elements; NEVER `dangerouslySetInnerHTML` — the snippet is
    redacted but the markers are the only trusted markup).
  - CREATE `report-markdown.tsx` (`"use client"`): react-markdown + remark-gfm; fenced
    ` ```mermaid ` blocks render via a lazy `mermaid.render` in `useEffect` (dynamic import so the
    ~1 MB lib never SSRs or blocks first paint); `reports-view.tsx` swaps `<pre>` for it.
    ADD deps to `apps/dashboard`: `react-markdown@^10`, `remark-gfm@^4`, `mermaid@^11`.
  - Pagination: add `{limit (default 50, max 200), offset}` querystring to `GET /v1/projects`,
    `GET /v1/reports`, and `offset` to `GET /v1/search` (schemas.ts + repos `listProjects`/
    `listReportArtifacts`/`searchDocuments`); dashboard lists gain a "Load more" pager.
- **VALIDATE**: `npm run typecheck:dashboard && npm run build:dashboard` (build catches barrel/dep
  breakage); unit test the `<b>`-splitter; Level-4: a report with a mermaid block renders a diagram,
  admin token grep in page source == 0 (D.18 discipline).

---

### Slice 13.5 — Alert delivery completion (M)

**CREATE `apps/ingest/src/delivery/smtp-deliverer.ts`** (+ unit test)

- **IMPLEMENT**: `createSmtpDeliverer(cfg: {url: string; from: string; to: string} | null)` →
  `AlertDeliverer | null` via `nodemailer.createTransport(cfg.url)` (URL form:
  `smtps://user:pass@host:port`); subject `[420AI] <severity> <alertKey>`, plain-text body.
  `createFanoutDeliverer(deliverers: (AlertDeliverer|null)[]): AlertDeliverer | null` — delivers to
  every non-null child, aggregates per-child errors (one child failing must not skip the others),
  null if none. ADD `nodemailer` + `@types/nodemailer` to `apps/ingest`.
- **UPDATE `server.ts`** (:88-102): compose webhook + SMTP through the fan-out into the single
  `alertDeliverer` slot; SMTP opt-in via `ALERT_SMTP_URL` + `ALERT_EMAIL_FROM` + `ALERT_EMAIL_TO`
  (document in `.env.example`).
- **GOTCHA**: deliverer unit tests inject a fake transport ({sendMail: vi.fn()}) — never a live
  SMTP hop in tests.

**Migration 0012 + deliver-on-resolve**

- **IMPLEMENT**: `alert_firings.resolve_delivered_at timestamptz` (nullable; `npm run db:generate`
  + hand-written `down/0012_*.down.sql` mirroring prior downs).
  `deliverResolvedFirings(db, userId, deliverer, now, log?)` in `alert-firings.ts` — select
  `status='resolved' AND resolved_at IS NOT NULL AND resolve_delivered_at IS NULL AND
  delivery_attempted_at IS NOT NULL` (only firings whose OPEN state was delivered get a resolve
  notice), deliver `{kind: "alert.resolved", firing}`, stamp regardless of outcome (at-most-once,
  mirroring :238-242). Call it beside `deliverFirings` in monitor.ts.
- **VALIDATE**: `npm run db:migrate` then `npm run db:rollback` then `db:migrate` again (rollback
  path proven); int test: open→deliver→resolve→resolve-delivered exactly once.

**Windowed connector-failure-rate alert**

- **IMPLEMENT**: `connectorHealthWindowed(db, userId, sinceIso)` (copy connectorHealth :264-294 +
  `gte(events.ts, sinceIso)`); pure `deriveConnectorFailureRateAlerts(rows)` in `alerts.ts`
  (mirror deriveAuthFailureAlerts; thresholds `CONNECTOR_RATE_ALERT = {windowMs: 3_600_000,
  minCalls: 5, ratio: 0.5}`); new `AlertCode` `"connector.failure_rate"`; merge in `buildSnapshot`
  via the existing `sortAlerts` composition. `deriveAlerts` stays FROZEN — sibling only.
- **GOTCHA**: `AlertsPanel` switches on severity, not code (verified 12.6 note) — renders unchanged.
- **VALIDATE**: `npm run repo-health -- --require-db` (0 int skips).

---

### Slice 13.6 — Scheduled reports + guided onboarding (S-M)

**CREATE `scripts/generate-reports.mjs`**

- **IMPLEMENT**: Node script (no deps): env `INGEST_URL` + `ADMIN_TOKEN` (the retained
  service-credential path — this is exactly what it exists for); args
  `--types <csv|all> [--project <uuid|all>]`; GET `/v1/projects` → POST
  `/v1/projects/:id/reports` per type; prints a summary line per artifact; exits non-zero if any
  call fails. Every fetch `AbortSignal.timeout(30_000)`.
- **UPDATE `docs/guide/operations.md`**: "Scheduled reports (opt-in)" section — Task Scheduler +
  cron lines mirroring the backup precedent verbatim (:98-102 style). Root package.json script
  `"reports:generate"`.
- **GOTCHA**: NO in-server scheduler — operations.md:98-102 is explicit; generation is
  non-idempotent by design (each run appends a version).
- **VALIDATE**: run against the dev stack: `node scripts/generate-reports.mjs --types all` →
  artifacts appear in `GET /v1/reports`.

**CREATE `scripts/setup-env.mjs` + `docs/guide/quickstart.md` + first-run empty state**

- **IMPLEMENT**:
  - `setup-env.mjs`: refuses if `.env` exists (the A.1 UAT footgun); copies `.env.example`,
    fills `ARCHIVE_ENCRYPTION_KEY` (32B base64), `ADMIN_TOKEN`/`SESSION_SECRET` (32B base64url)
    via `node:crypto`; prints next steps + reminds that `apps/dashboard/.env.local` needs the SAME
    `SESSION_SECRET` (the D.3 UAT bug) — and writes that file too if absent. npm script `"setup"`.
  - `quickstart.md`: the PRD §19 13 steps mapped to real commands (`npm run setup` → `db:up` →
    `db:migrate` → `ingest:dev` → dashboard login → Pairing page → `collector pair/discover/git/watch`
    → Monitor + first report) — the UAT file is the tone/ordering reference.
  - Monitor first-run: when the snapshot has zero machines, render an onboarding card (steps +
    link to `/pairing` + quickstart) instead of the empty tables. Client-side condition in
    `live-monitor.tsx`; no API change.
- **VALIDATE**: `node scripts/setup-env.mjs` in a temp dir with a copied `.env.example` produces a
  server-boot-valid `.env` (server.ts:12-23 required keys present); re-run refuses.
  `npm run build:dashboard` green.

---

### Slice 13.7 — Cursor connector (SQLite poll capture mode) (L)

All store facts below are spike-proven (NOTES). Fidelity labels: `captureMode: "poll"`,
liveness snapshot/poll, tokens **partial**, model **usually unknown** (`modelConfig.modelName` is
`"default"` in most composers → cost ladder rung 3 "estimated model unknown"), `status: "experimental"`.

**UPDATE `apps/collector/src/connectors/connector.ts`**

- **IMPLEMENT**: additive optional capability on `Connector`:
  `poll?: { intervalMs: number; sources(home?: string): string[]; run(store: CursorStoreReader, enqueue: EnqueueFn): PollOutcome }`
  — shape finalized against the engine wiring below; existing connectors untouched (optional field).

**CREATE `apps/collector/src/connectors/cursor-store.ts`** (+ test)

- **IMPLEMENT**: `openCursorStore(path)` → `new DatabaseSync(path, {readOnly: true})` (live open
  proven); `listComposers(db)` (the composer sweep — 14.3 MB total, fine per poll);
  `bubblesFor(db, composerId)` (prefix `bubbleId:<composerId>:%`, filter NULL values, may be empty);
  default path `join(process.env.APPDATA ?? "", "Cursor/User/globalStorage/state.vscdb")` with an
  injectable override (tests use a fixture db built in-memory by the test itself).
  **NEVER query ItemTable** (43 secret-ish keys live there — enforce by construction: no API reads it).
- **GOTCHA**: wrap the open in try/catch → connector reports "store not found/locked" as connector
  health, never crashes the engine (mirror git-reader's graceful degradation).

**CREATE `apps/collector/src/connectors/cursor.ts`** (+ test)

- **IMPLEMENT**:
  - `CURSOR_CONNECTOR = "cursor"`, `PARSER_VERSION = "1.0.0"`.
  - Pure `parseCursorComposer(composerJson: string, bubbles: {key: string; value: string}[]): ParseResult`
    (mirrors the Gemini snapshot parser): sessionId = composerId; raw records **per bubble**
    (`id = bubbleId` from the key's third segment; payload = verbatim bubble `value` string) + one
    envelope raw record for the composer (payload = composer `value`; id = `"<composerId>:composer"`)
    — this makes Cursor 12.5b-reassemblable from day one (the Gemini lesson, D-M13-2).
    Events: `session.started`/`session.ended` (ts = composer `createdAt`, ISO-normalized from epoch
    ms; `lastUpdatedAt` when present → ended), `message.user`/`message.assistant` (bubble `type`
    1=user / 2=assistant), `tool.call.*` from `toolFormerData` presence (status field → completed
    vs failed), `usage.reported` per bubble with non-zero `tokenCount`
    (`{inputTokens, outputTokens}` → NormalizedTokens input/output; zeros are common — skip),
    `cost.estimated` via `computeCost(modelName, tokens)` only when a real model name exists.
    Guards: null/zero-bubble composers produce only the session envelope events.
  - Connector object: fidelity block per §10.3 (knownGaps: no per-bubble timestamps — all events
    stamp the composer timestamps; token data partial; model usually "default"), watchGlobs `[]`,
    `poll` capability wired to cursor-store; registers in `registry.ts` beside the other three.
- **UPDATE `apps/collector/src/capture-engine.ts`**: `pollLoop` mirroring `gitSweepLoop` (same
  cadence/abort/best-effort structure; default `CURSOR_POLL_INTERVAL_MS = 300_000`): each tick,
  for changed composers enqueue a snapshot item — the queue's `(kind, dedup_key)` + content-hash
  dedup makes unchanged composers a no-op (verified queue behavior); dedup_key =
  `cursor:<composerId>`, content = composer value hash. Only changed composers fetch bubbles
  (196 MB total bubbles must NOT be swept — spike-measured).
- **GOTCHA**: approval surface — the vscdb path expresses as the connector's capture-surface
  fingerprint input so a path change gates on `connectors.approve` (12.7b discipline).
- **VALIDATE**: `npx vitest run apps/collector/src/connectors/cursor.test.ts
  apps/collector/src/connectors/cursor-store.test.ts` (fixture db: the test CREATES a tiny vscdb
  via `DatabaseSync` with the proven key formats — composerData + bubbleId rows incl. a NULL-value
  bubble and a zero-bubble composer); engine test extends capture-engine.test.ts for the poll loop
  (fake store, assert enqueue + unchanged-skip + abort). Level-4: run `collector watch` on this
  machine, confirm cursor events reach the archive and the Monitor shows the connector.

---

## TESTING STRATEGY

- **Unit** (always-run): pure metric/classifier/anomaly functions, renderers, parsers (moved tests),
  Cursor parser + store (self-built fixture db), deliverers (fake transport), `<b>`-splitter,
  setup-env (temp dir).
- **Integration** (`*.int.test.ts`, `describe.skipIf(!DATABASE_URL_TEST)`, excluded from tsc -b):
  each new report type end-to-end; re-parse reclassification + orphan GC + idempotence; incremental
  search visible without reindex; deliver-on-resolve exactly-once; windowed alert derivation;
  pagination params.
- **Edge cases**: report on empty project (mirrors "no events" 200 behavior); anomaly detector with
  <4 buckets (no flags); context report on a Gemini-only project (coverage table shows zero signal,
  no crash); re-parse of an already-current session (no-op); Cursor composer with 0 bubbles / NULL
  bubble / missing vscdb; SMTP child failing while webhook succeeds (fan-out isolation); reindex
  concurrent with incremental upsert (last-write-wins on the entity unique key — acceptable).

## VALIDATION COMMANDS

Per CLAUDE.md, validation is a GATE. After EVERY slice:

1. **Level 1**: `npm run typecheck` (repo-root `tsc -b` — exit 0) + `npm run typecheck:dashboard`
   (13.2/13.4/13.6 touch dashboard).
2. **Level 2**: `npm run repo-health` (full vitest; expect 622+N tests, PASS).
3. **Level 3** (every slice that touches `@420ai/db`/`apps/ingest` — 13.2 through 13.6):
   `npm run db:up && npm run db:migrate && npm run repo-health -- --require-db` — FAILS if any int
   test skipped (0 skips required). **Reminder (memory): migrate `420ai_test` separately before
   `--require-db`.** 13.5 additionally proves `npm run db:rollback` + re-migrate.
4. **Level 4 (manual)**: 13.2 — generate all 7 types from the dashboard, view rendered Markdown;
   13.3 — `npm run db:reparse` on the real archive after backup (`npm run backup` FIRST), verify
   monitor/report numbers stay sane; 13.4 — mermaid renders, token grep in page source == 0;
   13.6 — quickstart cold-run; 13.7 — live `collector watch` captures a real Cursor session.
5. **Before each commit**: `npx prettier --check` on touched `.md` files (CI lints markdown; local
   repo-health does not — memory: ci-prettier-checks-markdown).

## ACCEPTANCE CRITERIA

- [ ] All 7 PRD §15 report types generate versioned Markdown artifacts with tables + Mermaid;
      metrics stored on the artifact seam; comparison works via existing diffMetrics.
- [ ] §17: the context-waste report emits a deterministic, project-specific ignore-recommendation
      list from the 8-category classifier, with an honest per-connector coverage table.
- [ ] `POST /v1/replay/reparse` + `db:reparse`: Codex history reclassified under parser 2.0.0,
      orphaned stale-typed events deleted, idempotent re-run, Gemini skipped + reported.
- [ ] Search results reflect newly ingested sessions with NO manual reindex; snippets bold-highlight.
- [ ] Reports render as rich Markdown + Mermaid in the dashboard; projects/reports/search paginate.
- [ ] Alert firings deliver via webhook AND SMTP (fan-out), resolves notify exactly once, and a
      windowed connector-failure-rate alert fires on recent data only.
- [ ] `npm run reports:generate` + documented cron schedule produce scheduled artifacts;
      `npm run setup` yields a boot-valid `.env` (+ dashboard `.env.local` SESSION_SECRET);
      quickstart.md walks PRD §19; empty Monitor shows the onboarding card.
- [ ] Cursor sessions (composers) appear as archived sessions with honest fidelity labels; unchanged
      composers cost zero queue traffic; ItemTable is never read.
- [ ] `lastSyncAt` real in desktop StatusBar; CONTEXT.md + exports.ts claims true; updater-key
      runbook shipped and `.secrets/` ignore verified.
- [ ] Zero regressions: full gate + `--require-db` (0 skipped) green after every slice.

## COMPLETION CHECKLIST

- [ ] Slices executed in order, each through the build loop (execute → code-review → fix → commit)
- [ ] Every validation level passed per slice (incl. `--require-db` where applicable)
- [ ] `SUMMARY.md` §0/§3/§6 + `docs/PRD.md` §25 updated with the M13 milestone entry (mirror the
      M12 style) as the final task
- [ ] Manual Level-4 items done (real reparse after backup; live Cursor capture; mermaid render)

---

## NOTES — design decisions, trade-offs, and SPIKES RUN DURING PLANNING

**Spikes executed 2026-07-07 (throwaway scripts deleted; outputs preserved here):**

1. **Cursor store, copied DB** (node:sqlite over the 1.3 GB `state.vscdb`): tables `ItemTable,
   cursorDiskKV`; key families bubbleId=22368, agentKv=14577, checkpointId=5718,
   codeBlockDiff=3907, composerData=383. Bubble fields (40 sampled): `type`/`text`/`tokenCount`
   100%, `toolFormerData` 62%, `richText` 17%; `tokenCount = {inputTokens, outputTokens}` (often
   zeros → partial). 26/22368 bubble values are NULL. Composer: `createdAt` 100% (epoch ms),
   `lastUpdatedAt` only 112/350, `modelConfig` 315/350 but `modelName: "default"` (sample),
   `fullConversationHeadersOnly = [{bubbleId, type}]` (the composer→bubble linkage). ItemTable has
   43 secret-ish keys → cursorDiskKV only.
2. **Cursor store, LIVE open**: `new DatabaseSync(live, {readOnly: true})` succeeds while Cursor
   runs. Composer sweep = 383 rows / **14.3 MB** (max single 2.61 MB); bubbles total **195.9 MB**
   → poll design MUST fetch bubbles per changed composer only.
3. **Cursor key format**: `bubbleId:<composerId>:<bubbleId>`; per-composer prefix fetch verified;
   a composer may own 0 bubbles.
4. **tauri signer**: `cargo tauri signer generate [-p pwd] [-w file] [--ci]` — `--ci` skips
   prompts (verified via `--help` on this machine; `cargo-tauri.exe` present in `~/.cargo/bin`).
5. **Deps**: `nodemailer@9.0.3` (engines node>=6), `react-markdown@10.1.0`, `remark-gfm@4.0.1`,
   `mermaid@11.16.0` — none currently installed anywhere in the workspace (grep-verified).

**Symbol verification**: every referenced signature/file:line in this plan was read from source
during planning (three parallel deep-dives over reports/projections/parsers/raw-records/search/
alerts/delivery/ops-docs) — not from memory. Key confirmations: `upsertDoc` is private (must be
exported); `app.alertDeliverer` is a single slot (hence fan-out); `report_type` is free text (no
migration); `ts_headline` uses default `<b>`; parsers are pure and `packages/shared` stays
dependency-free after the move; `ingestBatch` upsert never deletes (hence explicit GC);
`resolvedAt` already exists (deliver-on-resolve needs only the marker column).

**Resolved conflicts (do not re-litigate during execution):**

- *"Reports never decrypt" (D3) vs. failed-tool/context-waste needing encrypted fields* → D-M13-1:
  the two new decrypt-bearing orchestrators follow the M8/search decrypt precedent with
  redact-before-render; the four pure ones keep D3. Do NOT promote encrypted fields to columns.
- *Gemini re-parse impossible from stored records* → D-M13-2: skip + report. The Cursor connector
  learns from this: it stores a composer-envelope raw record so ITS sessions are reassemblable.
- *Scheduled reports: in-server scheduler vs. repo's no-background-dispatcher discipline* → OS
  cron + script (operations.md precedent is explicit).
- *`ADMIN_TOKEN` retirement vs. script auth* → the token intentionally survives as the
  machine/service credential (12.3 hybrid design); scripts use it, humans use session login.
- *Claude raw-record line order not persisted* → reassembly sorts by each line's embedded
  `timestamp` field; fingerprints are order-independent, so only the synthetic session-start/end
  projections could drift, and the sort bounds that.

**Confidence: 9.5 / 10** (per-slice: 13.1 9.9 · 13.2 9.5 · 13.3 9.4 · 13.4 9.6 · 13.5 9.6 ·
13.6 9.7 · 13.7 9.5). Evidence: five spikes run with outputs above; all load-bearing symbols
verified by reading source; the test/seed harness confirmed (existing int tests named per slice as
templates); every design conflict resolved in writing. Residual deductions: 13.2's context-waste
decrypt volume on very large projects (mitigated: event-type-filtered rows only); 13.3's Claude
timestamp-sort fallback ordering (bounded, tested); 13.7's Cursor schema drift on future Cursor
versions (inherent to reverse-engineered stores; the connector is `experimental` and
fail-soft by design).
