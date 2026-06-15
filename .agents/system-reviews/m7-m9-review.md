# System Review — M7→M9 (Reporting → AI Interpretation → Live Monitor)

## Meta Information

- **Plan reviewed:** `.agents/plans/m9-live-monitor.md` (primary; M7/M8 plans referenced for the arc)
- **Execution report:** `.agents/execution-reports/m7-m9-reporting-to-live-monitor.md`
- **Plan command:** `~/.claude/skills/lril/commands/plan-feature.md`
- **Execute command:** `~/.claude/skills/lril/commands/execute.md`
- **Date:** 2026-06-15
- **Scope note:** M9 is assessed first-hand (executed this session). M7/M8 are assessed at the
  *process* level from their commits + the consolidated report. This is a **process** review, not a
  code review.

## Overall Alignment Score: 9/10

M9 execution adhered tightly to an unusually strong, spike-backed plan: every divergence was
justified, minor, or post-plan hardening. The −1 is for **one recurring plan-authoring defect** (a
gotcha the plan *cited* but its own illustrative code violated) plus two spike-coverage gaps
(`server-only`, the shadcn CLI) that a slightly wider spike would have closed. The single most
serious *process* finding in the arc — M8 shipping with a red root typecheck — is **already fixed
structurally** and is evidence the review loop is working, not an open wound.

---

## Divergence Analysis

```yaml
divergence: M8 merged with a red root `tsc -b`
planned: milestone sign-off behind a green repo-health
actual: provider.test.ts set maxOutputTokens on AnalysisProviderConfig after review moved the field;
        root tsc -b was red on main for the whole M8->M9 window; the M9 spike found it (PR #8 fixed it)
reason: repo-health typecheck was bypassed/stale at M8 sign-off (per-workspace build hid a
        cross-project/test-only import error)
classification: bad ❌
justified: no
root_cause: missing validation enforcement at sign-off (per-workspace build != root build)
status: ALREADY FIXED — CI repo-health required check (commit 30c52d7) + both lril commands now warn
        "Level 1 must be the repo-root build ... a broken root typecheck once shipped through two
        milestones" + the M9 plan added the --require-db gate. The loop self-corrected.
```

```yaml
divergence: activeSessions normalizes min/max(ts) to ISO via toIso()
planned: illustrative repo code returned min/max(ts) directly ("already ISO — do NOT re-coerce")
actual: added toIso() because a raw `sql` aggregate does NOT apply the mode:"string" parser
        (pg returned "2026-06-14 11:59:00+00"); the int test caught the mismatch
reason: the plan's own illustrative SQL contradicted the CLAUDE.md Drizzle gotcha it referenced
classification: good ✅ (the fix) / but reveals a bad plan-authoring pattern
justified: yes
root_cause: unclear/contradictory plan — illustrative code violated the gotcha it cited
status: RECURRING — same class as the M5 `lastActivity` bug. Actionable below.
```

```yaml
divergence: removed `import "server-only"` from src/lib/ingest.ts
planned: implicit (spike used process.env reads in server modules)
actual: the server-only package isn't installed; replaced with a server-only-by-convention doc comment
reason: spike never verified server-only is present; D8 still satisfied (0 token occurrences in HTML,
        no NEXT_PUBLIC, module imported only by server code)
classification: good ✅
justified: yes
root_cause: missing context (spike coverage gap)
```

```yaml
divergence: hand-wrote shadcn primitives instead of running `shadcn init`
planned: Task 17 runs `npx shadcn init` + add card/table/badge
actual: hand-wrote card/table/badge/globals.css/cn (standard v4 source); used the CLI only for the
        theGridCN data-card (registry-only component)
reason: `shadcn init` mutates tsconfig/globals.css/components.json and can prompt — non-deterministic
        in automated execution; hand-writing is reproducible
classification: good ✅
justified: yes
root_cause: plan assumed an interactive CLI is safe in non-interactive execution
```

```yaml
divergence: Level-4 visual gate run via headless Edge, not the browse/agent-browser skill
planned: agent-browser/browse drives the live page
actual: the gstack browse daemon failed to start on Windows (EEXIST .gstack / start-timeout);
        used `msedge --headless=new --screenshot` + HTTP-layer verification of all 4 assertions
reason: tooling/environment failure, honestly labeled in .agents/qa/m9/level4-acceptance.md
classification: good ✅ (adapted; gate still met)
justified: yes
root_cause: external tool unreliable on this platform; no documented fallback
```

```yaml
divergence: post-plan code-review pass added 5 robustness fixes
planned: not a divergence — the SUMMARY/loop includes /lril:code-review before commit
actual: SSE interval-leak-on-disconnect, dashboard proxy missing upstream abort signal,
        deriveMachineStatus returning "online" on NaN timestamp, O(n^2) spread-in-reduce, duplicated
        emptySnapshot (hoisted to shared emptyMonitorSnapshot)
classification: good ✅
justified: yes
root_cause: validation gate (typecheck+tests) does not catch resource-leak/robustness issues — the
        code-review gate is a necessary separate layer (and it worked)
```

---

## Pattern Compliance (M9)

- [x] **Followed codebase architecture** — `machineStatuses`/`activeSessions` clone `connectorHealth`
  scoping; monitor route mirrors `routes/projections.ts`; `buildApp` DI for `monitorStreamIntervalMs`.
- [x] **Used documented CLAUDE.md patterns** — library files never log/exit; clock injection
  end-to-end; `.js` specifiers + `import type`; additive migration (nullable columns); guard write
  paths. *One miss, then corrected:* the `mode:"string"`-in-aggregate gotcha (activeSessions).
- [x] **Applied testing patterns** — co-located `*.test.ts` (always run) + `*.int.test.ts`
  (`skipIf`), injected clocks, SSE recipe-B with injected interval.
- [x] **Met validation requirements** — root `tsc -b` Level 1, `repo-health --require-db` (72 int
  ran, 0 skipped), the new enforced dashboard typecheck lane (D9), and the agent acceptance gate.

The strongest signal: the M9 plan operationalized the prior review's lessons — `--require-db`, "Level
1 = root build", precedence rules (D1–D11) that pre-resolve conflicting guidance exactly as
`plan-feature.md` Phase 4 now demands. **Prior system reviews are visibly feeding forward.**

---

## System Improvement Actions

### Update CLAUDE.md

- [ ] **Strengthen the Drizzle aggregate-timestamp gotcha with a plan-authoring directive.** It has
  now bitten twice (M5 `lastActivity`, M9 `activeSessions`). Append to the existing Drizzle bullet:

  > **When writing illustrative aggregate SQL in a PLAN, always show the normalization** — a raw `sql`
  > template returns `max(ts)`/`min(ts)`/`date_trunc(...)` over a `mode:"string"` timestamptz as a
  > **Postgres text string** (`2026-06-14 11:59:00+00`), not ISO. Map it through
  > `new Date(v).toISOString()` and type the `sql<...>` result as `string`. Never write "already ISO —
  > do not re-coerce" for an aggregate. (This class of bug shipped in M5 and recurred in M9.)

- [ ] **Add a "Frontend workspace" note** (the D9 pattern M9 established, so the next frontend
  inherits it):

  > A frontend (e.g. `apps/dashboard`) stays **out of the root `tsc -b` graph** (it needs
  > `moduleResolution: bundler` + `jsx`). It MUST get its own **enforced** `repo-health` lane
  > (`typecheck:dashboard`) + a `build:dashboard` gate — the root `tsc -b` will never see its type
  > errors. In automated execution, **hand-write shadcn primitives** rather than running `shadcn init`
  > (the CLI mutates configs / can prompt); reserve the CLI for registry-only components, and
  > build-verify every add.

- [ ] **Add a visual-acceptance fallback note** (Tooling gotchas / Windows):

  > The gstack `browse`/`agent-browser` daemon is unreliable on this Windows host (`EEXIST .gstack`,
  > start-timeout). For screenshot evidence use headless Edge directly:
  > `"$EDGE" --headless=new --disable-gpu --screenshot="<abs>.png" <url>`. Pair it with HTTP-layer
  > assertions (rendered HTML contains the data; `grep -c "$ADMIN_TOKEN"` on page source == 0).

### Update Plan Command (`plan-feature.md`)

- [ ] **Phase 4 / spike fidelity: require the PRE-FLIGHT spike to verify package presence for any
  import it relies on.** The `server-only` gap was a spike that proved the *pattern* but not that the
  *package* resolves. Add: "If a plan's snippet imports a package (e.g. `server-only`), the spike must
  confirm it installs/resolves, or the plan must add it to the dependency list."
- [ ] **Add a lint rule to the plan quality checklist:** "Illustrative DB/aggregate code in the plan
  obeys the CLAUDE.md Drizzle gotchas (no `as`-cast of `numeric`, ISO-normalize aggregate timestamps,
  raw-literal closed-set keywords)." (Catches the recurring activeSessions/lastActivity class at
  plan-review time, not execution time.)

### Update Execute Command (`execute.md`)

- [ ] **Add a robustness/resource step to the hygiene gate (§4.5)** for features that add a new
  long-lived resource (stream, timer, subscription, socket): "For any `setInterval`/`setTimeout`/
  stream/listener added, confirm a teardown path on disconnect/abort and that it's armed *before* the
  first `await`. typecheck+tests do not catch leak windows — run `/lril:code-review` before commit."
  (Three of the five code-review findings were exactly this class.)

### New Command

- [ ] None warranted. No manual process repeated 3+ times that isn't already a command — seeding via
  curl recurred within one session but is a one-off acceptance-gate step, not a workflow.

---

## Key Learnings

**What worked well:**
- **The review loop is closing.** The M1-3 and M4-6 reviews' core lessons (root build is the gate;
  int layer must actually run; pre-resolve conflicting guidance) are now baked into *both* lril
  commands and the M9 plan's `--require-db` + D-rule structure. M9 inherited them and shipped clean.
- **Spike-before-plan removed the real risk.** Every novel M9 surface (Next-in-monorepo, theGridCN,
  SSE-in-real-buildApp, proxy auth) was proven before planning; the plan's precedence rules (D1–D11)
  pre-resolved the conflicts `plan-feature.md` Phase 4 warns about.
- **Multi-gate defense held:** the int test caught the timestamp-normalization bug; the code-review
  gate caught the SSE leak; the acceptance gate proved the token never reaches the browser. No single
  gate would have caught all three.

**What needs improvement:**
- **Plans keep pasting illustrative SQL that violates a gotcha they cite.** This is the one recurring,
  actionable plan-authoring defect across M5→M9. Fix at plan-review time (checklist + CLAUDE.md
  directive above).
- **Spikes prove patterns but skip package/tooling presence** (`server-only`, the shadcn CLI). Widen
  the spike's "does it actually resolve here" check.
- **No documented fallback for flaky acceptance tooling** — cost ~20 min fighting the browse daemon.

**For next implementation (M10 alert engine):**
- Reuse the heartbeat columns + `deriveMachineStatus` states as the alert engine's *inputs* — do not
  recompute liveness. M9 deliberately shipped states-only for exactly this.
- M10 adds heartbeat *history* (a time-series) for backlog-trend — that is a new table + migration;
  apply the M9 additive-migration discipline and the `--require-db` gate from day one.
- Apply the new execute.md robustness step: an alert *dispatcher* is a long-lived/scheduled resource —
  design its teardown + idempotency before coding.
```
