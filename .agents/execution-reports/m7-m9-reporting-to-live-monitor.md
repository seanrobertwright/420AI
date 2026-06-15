# Execution Report — M7→M9: Reporting → AI Interpretation → Live Monitor

**Scope:** the three milestones that turned the M6 deterministic-metrics layer into durable
artifacts (M7), AI-interpreted findings (M8), and a real-time, *visible* product (M9 — the first
frontend). Provenance: **M9 is first-hand** (implemented in this session); **M7 and M8 are
reconstructed** from their commits, plan files, and their own per-milestone artifacts
(`.agents/execution-reports/m7-reporting-foundation.md`, `.agents/code-reviews/m7*.md`,
`.agents/code-reviews/m8*.md`). This report's value is the **cross-milestone arc and the
recurring lessons**, not a re-derivation of M7/M8 internals.

---

## The arc in one paragraph

M6 produced read-time projections over the event log. **M7** rendered them to durable, **versioned
Markdown report artifacts** (`report_artifacts` table, pure `pie`/`xychart-beta` renderers). **M8**
added the **AI Interpretation Pipeline** — a redaction stage (regex + entropy) that masks secrets
*before anything leaves the archive*, the first **decrypt-for-render** read (`sessionTranscript`),
and a provider-agnostic Analysis Provider (Anthropic + OpenAI-compatible) — storing findings as a
new `reportType` in M7's same store (no migration). **M9** made all of it *observable*: a
collector→server **heartbeat**, clock-free **monitor projections** + pure status derivation, an
admin-gated snapshot + **SSE** stream, and the repo's **first frontend** (`apps/dashboard`, Next 16
+ shadcn + theGridCN) talking to ingest only through token-holding server-side proxy Route Handlers.

Each milestone thickened one proven layer — except M9, which opened three new surfaces at once (a
workspace, a transport, a collector→server signal).

---

## Per-milestone summary

### M7 — Reporting Foundation (commit `c26a2af`)
- **Shipped:** `report_artifacts` table + migration `0002` (versioned, append-on-regenerate),
  pure Markdown renderers in `@420ai/shared` (`reports.ts`), a version-bumping CRUD repo, and a
  generation orchestrator (`generate-report.ts`) composing M6 projections → renderer → store with
  admin-gated generate/fetch/list routes.
- **Meta:** ~+3,274 lines across 20 files. New: `reports.ts`(+test), `reports` repo(+int test),
  `generate-report.ts`, `routes/reports.ts`. Migration `0002`.
- **Validation (per its own report/review):** typecheck 0, units + int round-trips green (version
  bump, fetch, history ordering). Renders from plaintext projections only — never decrypts.

### M8 — AI Interpretation Pipeline (commit `a7f3633`)
- **Shipped:** a pure **Redaction Pipeline** (`redaction.ts` — regex + Shannon-entropy secret
  masking, 24 tests), a provider-agnostic bundle/prompt builder (`analysis.ts`), the first
  **decrypt-for-render** read (`transcript.ts`: message events → raw records → decrypt → order →
  dedupe → cap), an injected **Analysis Provider** (`anthropic.ts`/`openai.ts`/`provider.ts`), and a
  generation orchestrator that **redacts before send/store**. Findings reuse M7's `report_artifacts`
  store as a new `reportType` — **no migration, no new dependency**.
- **Meta:** ~+3,157 lines across 24 files.
- **Validation:** units + int tests green (redaction-before-send asserted, provider-failure→502,
  empty-scope→404 with no billable call). **BUT see the headline divergence below — M8 merged with a
  red root typecheck.**

### M9 — Live Monitor (this session, branch `m9-live-monitor`, not yet committed)
- **Shipped:** `HeartbeatRequest`/`Response` wire types + `monitor.ts` (pure view types + clock-
  injected `deriveMachineStatus`/`isBacklogHigh`) in `@420ai/shared`; four nullable `machines`
  columns + migration `0003` + `recordHeartbeat`/`machineStatuses`/`activeSessions` in `@420ai/db`;
  machine-authed `POST /v1/heartbeat`, admin-gated `GET /v1/monitor` + `GET /v1/monitor/stream`
  (SSE, injectable interval) in `apps/ingest`; a throttled best-effort heartbeat sender wired into
  the collector sync loop; and the **first frontend** — `apps/dashboard` (20 files: Next 16 +
  shadcn + theGridCN, Live Monitor page, client SSE component, token-holding proxy Route Handlers).
  Plus the enforced `repo-health` dashboard typecheck lane (D9).
- **Meta:** tracked changes **+392 / −16** (existing workspaces) + **~1,611 new source LOC**
  (new monitor/heartbeat/dashboard files; ~20 dashboard files). Migration `0003` (4 additive
  nullable columns).
- **Validation:** root `tsc -b` **0**; dashboard `tsc --noEmit` **0**; `build:dashboard` **success**;
  `repo-health --require-db` **PASS — 274 tests, 72 integration ran, 0 skipped**; Level-4 acceptance
  (live stack) — all 4 assertions pass (rendered HTML, **token absent from page source**, SSE frames,
  live online→offline transition). Then a code-review pass added 5 fixes (below), re-validated green.

---

## What went well (across all three)

- **The "thicken one proven layer" discipline paid compounding interest.** M8 reused M7's
  `report_artifacts` store verbatim (zero migration); M9's `machineStatuses`/`activeSessions` were
  near-clones of M6's `connectorHealth` (same machines-join scoping, same clock-free contract). Each
  milestone's hardest decisions were already made.
- **Clock injection as a first-class pattern.** M7 (`generatedAt`), M8 (deterministic stub
  provider), and M9 (route-owned clock + injected SSE interval + injected heartbeat `now`) are all
  deterministically testable *because* the wall clock is always an argument, never a hidden read.
  M9's SSE int test (recipe B, 50 ms injected interval, `reader.cancel()`) only works because of it.
- **Anchor-type-threading end-to-end.** M9's `LiveMonitorSnapshot`/`MachineStatusRow` flow from
  `@420ai/shared` → db repo → ingest route → dashboard component unchanged — the same single-source-
  of-truth shape the dashboard imports with `import type`.
- **The spike retired the genuinely novel M9 risks.** Next-in-monorepo, theGridCN, Fastify SSE in
  the real `buildApp`, and server-side proxy auth were all proven before a line of plan was executed.
  The dashboard built first try; SSE wired in with no surprises.
- **`--require-db` did its job.** Every M9 DB/ingest change was exercised against a real Postgres
  (72 int tests, 0 skipped) — the gate that *should* have caught the M8 defect.

---

## Challenges encountered (M9, first-hand)

- **SSE inside the real `buildApp` vs. the standalone spike probe.** Getting guards-before-hijack,
  post-hijack error emission, and disconnect cleanup right required care; the code-review pass later
  found a real leak window (below).
- **Drizzle `mode:"string"` does NOT apply inside a raw `sql` aggregate.** `min/max(events.ts)` came
  back as Postgres text (`2026-06-14 11:59:00+00`), not ISO — the int test caught the mismatch and
  forced a `toIso()` normalization. (The CLAUDE.md gotcha is real; the plan even cited it, yet its
  illustrative code still asserted "already ISO — do NOT re-coerce.")
- **First frontend, no React test infra.** The deterministic gate had to be `tsc --noEmit` +
  `next build` (catches type + theGridCN barrel breakage) + an out-of-band acceptance gate — there
  is no unit-test safety net for the UI yet.
- **Active-window vs. real clock in the int test.** `GET /v1/monitor` reads the real wall clock for
  its 15-min window, so the test had to timestamp its seed event at `new Date()`, not a fixed past
  date, or the active-session assertion would (correctly) find nothing.

---

## Divergences from plan

**M8 shipped with a red root typecheck (the headline lesson).**
- Planned: M8 sign-off behind a green `repo-health`.
- Actual: `apps/ingest/src/analysis/provider.test.ts` set `maxOutputTokens` on two
  `AnalysisProviderConfig` literals after review moved that field to `AnalysisRequest` (TS2353 ×2).
  Root `tsc -b` was red on `main` for the entire M8→M9 interval; the **M9 spike (§8) discovered it**,
  and it was fixed on `fix-m8-provider-config-test` (PR #8) before M9 branched.
- Reason: `repo-health`'s typecheck was bypassed or stale at M8 sign-off (a per-workspace build, or a
  skipped hook, hid the cross-project/test-only import error the root `tsc -b` would have caught).
- Type: **Plan assumption wrong / process gap.** This is *the* recurring lesson of the arc.

**M9 — `server-only` import removed.**
- Planned: implicit (spike used `process.env` reads in server modules).
- Actual: started with `import "server-only"` in `src/lib/ingest.ts` for a hard compile-time guard;
  the package isn't installed, so removed it and documented the server-only convention instead.
- Reason: `server-only` is a separate package the spike never installed; D8 is still satisfied (only
  Server Components / Route Handlers import the module; the token is never bundled — verified: 0
  occurrences in served HTML, no `NEXT_PUBLIC`).
- Type: Plan assumption wrong (minor).

**M9 — hand-wrote shadcn primitives instead of `shadcn init`.**
- Planned: Task 17 runs `npx shadcn init` + `add card table badge`.
- Actual: hand-wrote `card`/`table`/`badge`/`globals.css`/`cn` (deterministic, standard shadcn v4
  source); used the CLI only for the theGridCN `@thegridcn/data-card` (which installed + built).
- Reason: `shadcn init` mutates `tsconfig`/`globals.css`/`components.json` and can prompt — risky in
  non-interactive execution. Hand-writing is reproducible and gave identical output.
- Type: Better/safer approach.

**M9 — `activeSessions` timestamp normalization added.**
- Planned: illustrative repo code returned `min/max(ts)` directly ("already ISO").
- Actual: added `toIso()` to normalize the Postgres text form to strict ISO.
- Reason: the `mode:"string"` parser doesn't apply in a raw `sql` aggregate (caught by the int test).
- Type: Plan assumption wrong (the very gotcha the plan referenced).

**M9 — Level-4 visual gate via headless Edge, not the `browse` skill.**
- Planned: `agent-browser`/`browse` drives the live page.
- Actual: the gstack `browse` daemon wouldn't start on this Windows host (`EEXIST .gstack` /
  start-timeout); used **headless Edge** for screenshots + HTTP-layer verification of all 4
  assertions (captured both online and offline machine states live).
- Type: Tooling/environment issue (honestly labeled in `.agents/qa/m9/level4-acceptance.md`).

**M9 — code-review pass added 5 post-plan hardening fixes** (not plan divergences, but worth logging):
SSE interval-leak-on-disconnect-during-initial-push, dashboard SSE proxy missing upstream abort
signal, `deriveMachineStatus` returning "online" on an unparseable timestamp (now fail-safe to
offline), an O(n²) spread-in-reduce in `monitor-view`, and a duplicated `emptySnapshot` (hoisted to
a shared `emptyMonitorSnapshot`).

---

## Skipped items (deferred by design — not gaps)

- **The operational-alert engine** (threshold eval + delivery) — M10. M9 emits *states/flags* only.
- **Backlog-GROWING (derivative)** and **heartbeat history** — needs a time-series; M10.
- **The other dashboard surfaces** (reports/projects/search/catalog/settings), **multi-user
  dashboard auth**, **archive-export UI** — M9 ships only the Live Monitor page + minimal shell.
- **Code-level Playwright E2E** — net-new flaky CI browser infra; a hardening item.
- (M8) The §21 redacted-search projection, scheduled analysis, and report comparison — deferred.

---

## Recommendations

**Process (highest priority — the M8-red lesson):**
- The fix is already structural: a **CI `repo-health` workflow** now exists (commit `30c52d7`, a
  required check on `main`), and CLAUDE.md now mandates `repo-health -- --require-db` for any
  milestone touching `@420ai/db`/`apps/ingest`. Keep both. The single rule that would have prevented
  the M8 defect: **never sign off a milestone on a per-workspace build — only the root `tsc -b`
  (inside `repo-health`) sees cross-project + test-only imports.**

**Plan-authoring:**
- When a plan ships illustrative SQL using `min/max/date_trunc` over a `mode:"string"` column,
  it should **show the `toIso()`/`Number()` normalization**, not assert "already ISO." The gotcha is
  in CLAUDE.md, but plans keep pasting code that ignores it. (M5 `lastActivity`, M9 `activeSessions`.)
- For a new frontend, prescribe **hand-writing shadcn primitives** in automated execution and reserve
  the CLI for registry-only components (theGridCN) — more reproducible than `shadcn init`.

**CLAUDE.md additions worth considering:**
- A short "Frontend workspace" note: dashboards stay **out of the root `tsc -b` graph** and get an
  **enforced** `repo-health` typecheck lane (the D9 pattern M9 established) — so the next frontend
  doesn't silently ship type errors.
- A "visual acceptance gate" note: the `browse` skill is unreliable on this Windows host; **headless
  Edge** (`msedge --headless=new --screenshot`) is the dependable fallback for screenshot evidence.

**Execute-loop:**
- The pattern of *seeding via curl with explicit `content-type: application/json`* matters — a dropped
  header silently produced a form-encoded body and a no-op pair during the M9 acceptance run. Worth a
  one-line reminder when scripting ingest seeds.
