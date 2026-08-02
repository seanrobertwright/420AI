# Feature: M16 Slice 16.0 — Truth + Research Scaffold

The following plan should be complete, but it is important that you validate documentation and
codebase patterns and task sanity before you start implementing.

Pay special attention to naming of existing utils, types and models. Import from the right files.

## Feature Description

Slice 16.0 opens milestone **M16 — Dogfood Instrumentation & Data Trust** by doing the three things
that must be true *before* any research data is collected, plus the measurement that tells us where
onboarding actually hurts:

1. **Truth / renumber.** The number `M16` currently means "Cloud-hosted SaaS" in 38 live places across
   docs and source comments. That milestone is being renumbered to **M20** and returned to the
   unsequenced bucket; `M16` is being redefined. Every *live* reference must be repointed, or the
   codebase carries 21 source comments that silently misdirect the next reader.
2. **Research scaffold.** Create `.agents/research/` — the artifact set that
   `.agents/supplemental docs/research-analysis-plan.md` §3 requires *before* enrolling any user.
3. **Local data boundary note.** A written, code-derived statement of what 420AI captures, encrypts,
   indexes, exports and deletes (research plan Phase 0 item 7).
4. **Timed fresh deploy.** Stand up an isolated archive/API/dashboard/collector following the
   documented path, timing each step, producing the first incident-log entry.

## User Story

As the **sole operator about to start a 24-week research period on my own machine**
I want **the roadmap to say what it means, the research artifacts to exist, the data boundary written
down, and a measured baseline for how long setup actually takes**
So that **the evidence I collect over the next six months is trustworthy, and the first thing I learn
is not "the docs lied about which milestone this was."**

## Problem Statement

Three concrete problems, all of which get worse the longer they wait:

- **The number `M16` is about to mean two things.** 21 source comments and 17 doc lines say "M16" to
  mean hosted SaaS / multi-org. Redefining M16 without repointing them produces a codebase where
  `apps/ingest/src/routes/members.ts:383` says "REVISIT AT M16" and M16 turns out to be a markdown
  scaffold slice. This is the exact failure class slice 15.0 was created to fix, and CLAUDE.md already
  records the lesson twice.
- **The research plan's required artifacts do not exist.** `.agents/research/` is absent. §3 states
  these records must be created *"before enrolling external users"*, and the weekly scorecard is due
  the first Monday.
- **Nobody has measured the onboarding path since 15.9 removed `ADMIN_TOKEN`.** The documented setup
  grew from "paste one env var" to a six-step chain, and the research plan's §5.2 target is
  time-to-first-capture **< 30 min**. No gate in this repo can measure that — it is a property of the
  human path, not the code.

## Solution Statement

A documentation + scaffolding slice with **zero schema change and zero behavioural code change**,
plus two one-line CLI corrections found during planning (see F1/F2 below) that the isolation safety
constraint depends on.

The central design decision is the **live-vs-historical rule** (see DESIGN DECISIONS). It is what
keeps the renumber from turning into a 71-site find-and-replace that falsifies the project's own
history.

## Feature Metadata

**Feature Type**: Enhancement (truth/documentation slice, mirroring 15.0 and 13.1)
**Estimated Complexity**: **Medium** — low technical risk, high *enumeration* risk. The work is easy;
missing one of 38 live sites is the failure mode.
**Primary Systems Affected**: `SUMMARY.md`, `docs/PRD.md`, `docs/guide/operations.md`, comments in
`apps/ingest/src` + `packages/db/src` + `packages/shared/src`, new `.agents/research/`,
new `docs/guide/data-boundary.md`, `apps/collector/src/cli.ts` (2 lines)
**Dependencies**: None. No new packages. No migration.

---

## DESIGN DECISIONS

### D-16.0-1 — LIVE artifacts get repointed; HISTORICAL records do not

`git grep "M16"` returns **70 hits** (excluding one `package-lock.json` false positive). They split
into two populations that must be treated differently:

| Population | Files | Hits | Action |
|---|---|---:|---|
| **LIVE** — read as current guidance | `SUMMARY.md` (11), `docs/PRD.md` (5), `docs/guide/operations.md` (1), **14 source files** (21) | **38** | **Repoint to M20** |
| **HISTORICAL** — dated records of past decisions | `.agents/plans/m15-*.md`, `.agents/code-reviews/*`, `.agents/execution-reports/*` | **32** | **Do NOT edit** — add one erratum legend |

Verified by count during planning: `38 + 32 = 70`.

**Rationale.** `.agents/execution-reports/` and `.agents/code-reviews/` are the repo's ground truth —
`scripts/check-summary.mjs` literally derives what shipped from the execution-report filenames.
Rewriting them to say "M20" would make them assert a decision that had not been taken on the date they
carry. A plan that recorded "deferred to M16" on 2026-08-02 *did* defer to what was then M16; that
statement is true and must stay.

Source comments and live docs are the opposite: nobody reads `members.ts:383` as a historical record.
They read it as an instruction about what to do next, and it is now wrong.

**Erratum instead of rewrite.** One legend line added to
`.agents/plans/m15-multi-user-access-control.md` (which has 10 hits and is the entry point to the
other M15 documents) disambiguates all 33 historical hits at once. That is a legend, not a revision.

> **GOTCHA — do not use `sed`.** Three reasons, each independently sufficient:
> (a) `package-lock.json:3058` contains the substring `M16` inside a base64 integrity hash
> (`...5M16ZJcUv...`) — a blanket replace corrupts the lockfile;
> (b) the 33 historical hits must survive untouched;
> (c) CLAUDE.md's twice-proven lesson — *"a per-FILE grep exempts the file, not the call site"* — cuts
> both ways: each of the 21 source sites must be **read** to confirm it is SaaS/multi-org-semantic
> before it is changed. They all are (verified during planning), but the executor must confirm rather
> than trust this sentence.

### D-16.0-2 — Part 4 measures; it does not fix

The timed deploy will very likely show the post-15.9 auth chain eating a large share of the 30-minute
budget. **Do not fix it in this slice.** The research plan's §2 scope-change rule requires a named
data-quality failure before any feature is built; an incident-log entry is exactly how that
justification gets created. Fixing it pre-emptively converts measured evidence into a guess.

**This does not apply to F1/F2** (below). Those are defects in the *isolation mechanism this slice's
own safety constraint relies on* — not onboarding friction. Different category, fixed here.

### D-16.0-3 — The clean room lives outside OneDrive

The fresh clone goes in the **scratchpad**, never under `OneDrive/Documents/`. OneDrive has already
corrupted this repo's `.git` once, and a second synced clone of the same repository is an invitation
to repeat it. It also keeps the clean room genuinely disposable.

---

## FINDINGS FROM PLANNING SPIKES

Two real defects, both found by spiking part 4's isolation requirement, both in the path of the
safety constraint.

### F1 — `pair` accepts `--home` but its help text does not say so

`apps/collector/src/cli.ts:426` reads:

```
"  collector pair <code> --url <baseUrl> [--name <n>] [--os <os>] [--hostname <h>]",
```

but the handler at `cli.ts:502` passes `home: resolveHome(args)`, and `runPair` at `cli.ts:123`
persists via `credentialsPathFor(opts.home ?? homedir())`. So `--home` **works** on `pair`; only the
usage string omits it. CLAUDE.md's claim that `--home` covers `pair` is **correct**; the CLI help is
what is wrong.

This matters because the operator performing an isolated clean-room pair reads `--help`, sees no
`--home` on the `pair` line, and reasonably concludes pairing will clobber the real
`~/.420ai/credentials.json`.

### F2 — the pair success message prints the wrong path under `--home`

`apps/collector/src/cli.ts:506`:

```ts
`Saved credentials to ${CREDENTIALS_PATH}\n`,
```

`CREDENTIALS_PATH` is the module-level constant derived from `homedir()`
(`apps/collector/src/identity.ts:20`). Under `collector pair … --home <dir>` the credentials are
**saved correctly** to `<dir>/.420ai/credentials.json`, but the confirmation **prints**
`C:\Users\<you>\.420ai\credentials.json`.

No data loss — but it is actively misleading during precisely the exercise part 4 performs. An
operator verifying "did the clean room touch my real collector?" reads that line and concludes it
did.

**Both are fixed in this slice** (Tasks 12–13), because part 4's safety verification is not
trustworthy while they stand.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — IMPORTANT: YOU MUST READ THESE BEFORE IMPLEMENTING

- `CLAUDE.md` — **the source of truth for all conventions.** Do not re-paste it into new docs; link it.
- `.agents/plans/m15-slice0-truth-and-rls-spike.md` (Tasks 4–8, lines 355-410) — Why: **the pattern
  this slice mirrors.** Note especially its GOTCHA style: name the exact lines, name what must *not*
  change, give each task a grep-based VALIDATE.
- `scripts/check-summary.mjs` (lines 52-70) — Why: the hard gate. `sliceMarkedDone` requires a ✅
  **within 4 characters** of the `**16.0**` token, either ordering. `doneMilestones` (regex
  `/\*\*M(\d+)\b[^*\n]*\*\*\s+is\s+\*\*DONE\*\*/`) makes a milestone-level DONE declaration *disable*
  per-slice checking for that whole milestone.
- `apps/collector/src/cli.ts` (lines 106-127 `runPair`, 389-395 `resolveHome`, 425-441 usage,
  491-510 pair handler) — Why: F1/F2 live here, and part 4's isolation depends on this code.
- `apps/collector/src/identity.ts` (lines 20, 35-38) — Why: `CREDENTIALS_PATH` vs
  `credentialsPathFor(home)` / `queuePathFor(home)` — the distinction F2 gets wrong.
- `scripts/setup-env.mjs` (lines 117-136) — Why: **it refuses to overwrite an existing `.env`**
  (line 120-123). The repo root already has one, so the clean room cannot run `npm run setup` in
  place — this is why D-16.0-3 uses a fresh clone.
- `docs/guide/quickstart.md` (13 numbered steps) — Why: **this is "the documented installation path"**
  part 4 must follow verbatim. Deviating from it invalidates the measurement.
- `packages/shared/src/redaction.ts` (line 18 `REDACTION_VERSION`, lines 70-151 rule kinds) — Why:
  factual input for the data-boundary note.
- `packages/db/src/crypto.ts` (lines 1-30) — Why: factual input — AES-256-GCM, keyring, key never in DB.
- `packages/db/src/schema.ts` (lines 43, 422-424, 472-475, 638, 682-687) — Why: exactly which columns
  are ciphertext and which are deliberately not.

### New Files to Create

- `.agents/plans/m16-dogfood-instrumentation.md` — the **milestone** plan (mirrors
  `m15-multi-user-access-control.md` sitting above its slices)
- `.agents/research/README.md` — what these artifacts are + the §3 privacy rule
- `.agents/research/weekly/TEMPLATE.md` — scorecard template (research plan §10)
- `.agents/research/decisions.md` — decision log + entry template (§11)
- `.agents/research/experiments.md` — experiment register + template (§9)
- `.agents/research/participants.md` — participant registry (empty; headers only)
- `.agents/research/backlog.md` — research backlog
- `.agents/research/interviews/.gitkeep` — interview notes directory
- `.agents/research/incidents.md` — incident log (part 4 writes the first entry)
- `docs/guide/data-boundary.md` — the local data boundary note
- `.agents/research/cleanroom-2026-08-02.md` — the timed deploy log

### Files to Modify

| File | Hits | Nature |
|---|---:|---|
| `SUMMARY.md` | 11 | §0 status, §3 roadmap, §6 roadmap — redefine M16, renumber SaaS→M20, add 16.0 ✅ |
| `docs/PRD.md` | 5 | §25 post-V1 milestone list |
| `docs/guide/operations.md` | 1 | line 1253 |
| `apps/ingest/src/routes/members.ts` | 5 | comments (121, 377, 383, 388, 398) |
| `apps/ingest/src/routes/pairing-codes.ts` | 1 | comment (59) |
| `apps/ingest/src/api-keys.int.test.ts` | 1 | comment (505) |
| `apps/ingest/src/identity.int.test.ts` | 1 | comment (393) |
| `apps/ingest/src/sessions.int.test.ts` | 2 | comments (518, 524) |
| `packages/db/src/schema.ts` | 2 | comments (57, 68) |
| `packages/db/src/repositories/principal.ts` | 2 | comments (39, 79) |
| `packages/db/src/repositories/api-keys.ts` | 1 | comment (359) |
| `packages/db/src/repositories/members.ts` | 1 | comment (180) |
| `packages/db/src/repositories/organizations.ts` | 1 | comment (41) |
| `packages/db/src/repositories/reports.ts` | 1 | comment (176) |
| `packages/db/src/repositories/members.int.test.ts` | 1 | comment (255) |
| `packages/db/src/repositories/principal.int.test.ts` | 1 | comment (138) |
| `packages/shared/src/roles.ts` | 1 | comment (2) |
| `apps/collector/src/cli.ts` | — | F1 (line 426) + F2 (line 506) |
| `.agents/plans/m15-multi-user-access-control.md` | — | **erratum legend only**, per D-16.0-1 |

**Total live M16 sites: 38** (17 doc + 21 source).

### Relevant Documentation

- [`.agents/supplemental docs/research-analysis-plan.md`](../supplemental%20docs/research-analysis-plan.md)
  - §3 (source-of-truth artifacts + privacy rule), §9 (experiment template), §10 (scorecard template),
    §11 (decision-log template), Phase 0 items 4 & 7
  - Why: **this document defines the acceptance criteria for parts 2 and 3.** Follow its templates
    verbatim rather than inventing a format.
- [`docs/guide/quickstart.md`](../../docs/guide/quickstart.md) — the 13-step documented install path
  - Why: part 4 must follow it exactly; deviation invalidates the timing.
- [PostgreSQL `CREATE DATABASE`](https://www.postgresql.org/docs/17/sql-createdatabase.html)
  - Why: the clean room needs an isolated database on the existing instance.

### Patterns to Follow

**Truth-slice task shape** — from `m15-slice0-truth-and-rls-spike.md`: every task names the exact
line(s), states explicitly what must **not** change, and ends in a grep-based `VALIDATE` that a
machine can check.

**Doc correction style** — this repo *supersedes* rather than deletes. See `SUMMARY.md:100-104`:

```markdown
> **Corrected 2026-07-25 (slice 15.0).** This block previously said "…". That was true for
> **per-user** isolation, and is **false** under the org-level tenancy settled in **D-M15-1**…
```

Mirror this for the M16→M20 renumber so the history stays legible.

**Comment repointing style** — the existing comments are precise and reference decision ids. Preserve
that. Change the *number*, keep the reasoning:

```ts
// BEFORE (packages/db/src/repositories/organizations.ts:41)
 * "≤1 membership per user" (multi-org users are committed for M16, so such a constraint

// AFTER
 * "≤1 membership per user" (multi-org users are committed for M20, so such a constraint
```

> **Spike-snippet fidelity:** the F1/F2 snippets above were read from source during planning at the
> cited line numbers. If the executor finds different text there, **stop and re-read** rather than
> pattern-matching — it means the file moved under us.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation — define the new M16 before repointing the old one

Write the milestone plan first, so every subsequent edit has a target to point at. Repointing 38
sites at a milestone that is not yet defined anywhere produces 38 dangling references.

### Phase 2: The renumber — docs, then source

Docs first (they define the terms), then source comments (which reference the docs).

### Phase 3: The research scaffold + data boundary

Additive file creation. No dependency on Phases 1–2 beyond ordering convenience.

### Phase 4: The measured clean-room deploy

Last, because it is the only part whose output is unknown at planning time, and because F1/F2 must be
fixed before its isolation can be trusted.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom.

### 1. CREATE `.agents/plans/m16-dogfood-instrumentation.md`

- **IMPLEMENT**: The milestone plan. Sections, mirroring `m15-multi-user-access-control.md`:
  (a) **Origin** — the 2026-08-02 deferral audit + scope conversation; the criterion was *who the next
  milestone is for*, and the answer is **Sean alone, for a 24-week research period**;
  (b) **Why the old M16 moved** — billing/SaaS/multi-tenancy/remote hosting are all out, per
  `research-analysis-plan.md` §2 which places them explicitly out of scope; SaaS becomes **M20**;
  (c) **Scope** — the §7 **P0** backlog (P0.1 capture health scorecard, P0.2 outcome labels,
  P0.3 data-quality audit, P0.4 privacy artifacts) plus P1.5/P1.7;
  (d) **Slice table** — 16.0 truth+scaffold · 16.1 outcome label model+API · 16.2 label capture (tray)
  + review (dashboard) · 16.3 capture health scorecard · 16.4 data-quality audit report;
  (e) **Decisions** D-16.0-1…3 as recorded above, plus **D-M16-1** *the observation set*: connectors
  Claude Code + Codex only; repos `scrap-kanban` + `420AI`; Cursor/Antigravity/Windsurf/Continue **not**
  enabled; browser extension **not** run during Phase 1 (it sidesteps the known
  `claude-live`↔`claude-export` dedup gap, `docs/research/extension-spike.md:122`, which would corrupt
  the <1% duplicate-rate metric);
  (f) **The four audited deferrals** D1–D4 with their disposition — D1 dedup (avoided by config,
  deferred), D2 `discoverRoots` (deferred), D3 windowed connector-failure-rate (**folds into 16.3**),
  D4 Antigravity connector (deferred);
  (g) **Non-goals** — the full list from the slice brief.
- **PATTERN**: `.agents/plans/m15-multi-user-access-control.md` — overall shape and the decisions block.
- **GOTCHA**: **P1.6 (hero workflow evidence panel) is explicitly NOT a slice.** The hero workflow is
  selected in research Phase 2 (weeks 5–8) *from evidence*. Naming it as a slice now would pre-commit
  to a guess. State this in the plan so nobody adds it later thinking it was an oversight.
- **GOTCHA**: Do **not** write the phrase `**M16 …** is **DONE**` anywhere in `SUMMARY.md` (this task
  is a plan file, so it is safe here — but keep the habit). See Task 4's gate note.
- **VALIDATE**: `test -f .agents/plans/m16-dogfood-instrumentation.md && grep -c "D-M16-1" .agents/plans/m16-dogfood-instrumentation.md` → ≥ 1

### 2. UPDATE `docs/PRD.md` — §25 post-V1 milestone list

- **IMPLEMENT**: At the five M16 sites (**lines 920, 924, 927, 966, 981**): renumber the
  Cloud-hosted-SaaS entry to **M20**, and insert a new **M16 — Dogfood Instrumentation & Data Trust**
  entry marked **PROMOTED**, linking `.agents/plans/m16-dogfood-instrumentation.md`. Mirror the house
  promotion phrasing used for M14/M15 (see `docs/PRD.md:935-936`).
- **GOTCHA**: **line 981** is the open question about where the mobile app lives ("pairs at least as
  naturally with M16 SaaS as a consumption surface"). That sentence is about **SaaS**, so it becomes
  **M20** — do not repoint it at the new M16, which has nothing to do with mobile.
- **GOTCHA**: **line 966** says M17 is "largely parallelizable with the M15–M16 track". That range
  meant "the multi-user/SaaS track". Reword to `M15–M20 track` or, better, "the multi-user/SaaS track"
  in words, since a numeric range spanning a renumber is now misleading.
- **VALIDATE**: `grep -n "M16" docs/PRD.md` → every remaining hit refers to the NEW M16;
  `grep -c "m16-dogfood-instrumentation" docs/PRD.md` → ≥ 1

### 3. UPDATE `docs/guide/operations.md` — line 1253

- **IMPLEMENT**: `Multi-org membership and the org switcher (→ M16 with tenant slugs and hosting)`
  → `→ M20`.
- **VALIDATE**: `grep -n "M16" docs/guide/operations.md` → 0 matches

### 4. UPDATE `SUMMARY.md` — §0 status block, §3 roadmap, §6 roadmap

- **IMPLEMENT**: Across the 11 sites (lines **92, 98, 102, 228, 237, 253, 400, 401, 751, 768, 773**):
  (a) renumber the Cloud-hosted-SaaS bullet at **line 253** to **M20** and move it into the
  unsequenced bucket alongside M17–M19;
  (b) add a new **M16 — Dogfood Instrumentation & Data Trust** entry in §3 marked **IN PROGRESS**,
  linking the milestone plan and listing slices 16.0–16.4;
  (c) in §6, add the M16 roadmap entry whose first sub-item is **`**16.0**` ✅ DONE `2026-08-02`** with
  a one-line summary and the PR number;
  (d) update the §0 status block: M15 is DONE, **M16 is the active milestone**, and
  **M17–M20 remain committed and unsequenced**;
  (e) add a superseding note in the house style recording that the SaaS milestone was renumbered
  M16→M20 on 2026-08-02 by slice 16.0, and why.
- **GOTCHA — THIS IS A HARD GATE.** `scripts/check-summary.mjs` requires that once
  `.agents/execution-reports/m16-slice0-*.md` exists, `SUMMARY.md` contains the token `**16.0**` with
  a ✅ **within 4 characters** (either ordering: `**16.0** ✅` or `✅ **16.0**`). Anything further away
  fails `repo-health`. See `check-summary.mjs:60-70`.
- **GOTCHA**: Do **NOT** write `**M16 (…)** is **DONE**`. That phrasing matches `doneMilestones`
  (`check-summary.mjs:52-58`) and would *disable* per-slice drift detection for the whole of
  16.1–16.4. M16 is IN PROGRESS.
- **GOTCHA**: **line 773** is a `- [ ]` checklist item ("M16–M19 remain committed scope, unsequenced").
  It becomes **M17–M20**. Do not tick it — it is still open for those four.
- **VALIDATE**: `node scripts/check-summary.mjs` → exit 0, and
  `grep -n "M16" SUMMARY.md` → every hit refers to the NEW M16

### 5. UPDATE `apps/ingest/src/routes/members.ts` — 5 comment sites

- **IMPLEMENT**: Lines **121, 377, 383, 388, 398**. Change `M16` → `M20` in each. Preserve every word
  of the surrounding reasoning; these comments are load-bearing explanations of the last-owner guard
  and the rank floor.
- **GOTCHA**: **READ each comment before editing.** Confirm it is multi-org/SaaS-semantic. All five
  are (verified during planning), but per CLAUDE.md a file-level check is not a call-site check.
- **VALIDATE**: `grep -c "M20" apps/ingest/src/routes/members.ts` → `5`; `grep -c "M16" apps/ingest/src/routes/members.ts` → `0`

### 6. UPDATE the remaining `apps/ingest/src` comment sites

- **IMPLEMENT**: `routes/pairing-codes.ts:59`, `api-keys.int.test.ts:505`, `identity.int.test.ts:393`,
  `sessions.int.test.ts:518` and `:524`. `M16` → `M20`.
- **GOTCHA**: `identity.int.test.ts:393` reads *"…which was both wrong (multi-org went to M16) and…"* —
  this is a comment *about a past correction*. It is in live source, so it gets repointed to M20, but
  keep its self-referential structure intact; do not flatten it into a plain statement.
- **VALIDATE**: `git grep -c "M16" -- 'apps/ingest/src'` → no output (0 matches)

### 7. UPDATE `packages/db/src` comment sites

- **IMPLEMENT**: `schema.ts:57` and `:68`; `repositories/principal.ts:39` and `:79`;
  `repositories/api-keys.ts:359`; `repositories/members.ts:180`; `repositories/organizations.ts:41`;
  `repositories/reports.ts:176`; `repositories/members.int.test.ts:255`;
  `repositories/principal.int.test.ts:138`. `M16` → `M20` in each.
- **GOTCHA**: `schema.ts:57` reads *"no `slug` column — URL/tenant slugs are M16"* — tenant slugs are a
  SaaS concern → **M20**. Do not mistake this for a note about the new M16.
- **GOTCHA**: `reports.ts:176` reads *"widened (e.g. M16's shared-org views)"* — also SaaS → **M20**.
- **VALIDATE**: `git grep -c "M16" -- 'packages/db/src'` → no output (0 matches)

### 8. UPDATE `packages/shared/src/roles.ts:2`

- **IMPLEMENT**: *"No user-defined roles: that is an M16 …"* → **M20** (user-defined roles are the
  enterprise/SaaS concern).
- **VALIDATE**: `git grep -c "M16" -- 'packages/shared/src'` → no output

### 9. ADD erratum legend to `.agents/plans/m15-multi-user-access-control.md`

- **IMPLEMENT**: One blockquote near the top of the document:
  > **Erratum 2026-08-02 (slice 16.0).** Every "M16" in this document — and in the sibling
  > `m15-slice*.md` plans, code reviews and execution reports — means the **Cloud-hosted SaaS**
  > milestone, which was **renumbered to M20** on 2026-08-02. `M16` now means *Dogfood Instrumentation
  > & Data Trust* (`.agents/plans/m16-dogfood-instrumentation.md`). These historical documents are
  > deliberately **not** rewritten (D-16.0-1) — they record decisions as they were taken.
- **GOTCHA — this is the ONLY edit permitted anywhere under `.agents/plans/m15-*`,
  `.agents/code-reviews/`, or `.agents/execution-reports/`.** Do not "finish the job" by repointing
  the other 33 historical hits. That is the decision, not an oversight.
- **VALIDATE**: `grep -c "Erratum 2026-08-02" .agents/plans/m15-multi-user-access-control.md` → `1`;
  `git diff --name-only .agents/execution-reports .agents/code-reviews` → **empty**

### 10. CREATE the `.agents/research/` scaffold

- **IMPLEMENT**: All eight files listed under "New Files to Create". Copy the templates from
  `research-analysis-plan.md` **verbatim** — §10 → `weekly/TEMPLATE.md`, §11 → the entry template in
  `decisions.md`, §9 → the entry template in `experiments.md`. `README.md` explains what the directory
  is, links the research plan, and states the §3 privacy rule prominently.
- **GOTCHA — the §3 privacy rule is the load-bearing part.** Put it in `README.md` **and** as a comment
  header in each file that will hold observations (`decisions.md`, `participants.md`,
  `incidents.md`, `interviews/`): *no captured session content, secrets, access tokens, or personally
  identifying source data — aggregate metrics, anonymized consented quotes, and links/IDs only.*
- **GOTCHA**: `interviews/` needs `.gitkeep` — git does not track empty directories.
- **GOTCHA**: `participants.md` ships with **headers only, zero rows.** It will eventually hold consent
  records for real people; a template row containing a plausible fake name is exactly the kind of
  thing that later gets mistaken for data.
- **VALIDATE**: `ls .agents/research/ .agents/research/weekly .agents/research/interviews` and
  `test -f .agents/research/weekly/TEMPLATE.md && test -f .agents/research/interviews/.gitkeep`

### 11. CREATE `docs/guide/data-boundary.md`

- **IMPLEMENT**: The local data boundary note (research plan Phase 0 item 7). Six sections, every
  claim **derived from code and cited by `file:line`**:
  1. **What is captured** — per enabled connector; cite the connector registry.
  2. **What is encrypted at rest** — `raw_source_records.payload_*` and `events.payload_*` are
     AES-256-GCM ciphertext (`schema.ts:43`, `:422-424`, `:472-475`); git commit *messages* are
     encrypted (`repositories/git.ts:41`); the 32-byte key(s) come from env and are **never stored in
     the DB** (`crypto.ts:1-19`); keyring mode supports rotation.
  3. **What is deliberately NOT encrypted, and why** — `schema.ts:638` (timestamps/metrics are not on
     the §18.1 encrypt-list) and `schema.ts:682-687` (commit SHA is git's own content hash and is the
     idempotency key; author name/email, branch and changed-file stats are metadata).
  4. **What is searchable** — `search_documents` is **redact-then-store**: content is decrypted,
     redacted, then indexed; rows stamp `REDACTION_VERSION` (`redaction.ts:18` = `m8-redact-v1`).
     Encrypted originals are never indexed. List the 15 redaction rule kinds
     (`redaction.ts:70-151`): private key blocks, JWTs, Anthropic/OpenAI/AWS/GitHub/Google/Slack
     credentials, connection strings, bearer auth, generic secret assignments, home paths, emails,
     plus a high-entropy sweep.
  5. **What can be exported** — the export surfaces and that they are redacted.
  6. **What is deleted, and how** — retention/pruning from the M12 12.4 backup job.
- **GOTCHA — derive, do not aspire.** If the code does not do something, the note says so. This
  document's whole value is that a design partner can trust it; one aspirational sentence destroys
  that. Where behaviour is conditional (keyring vs legacy single-key), say both.
- **GOTCHA**: `REDACTION_VERSION` is `m8-redact-v1` — quote it exactly; it is a stamped value that
  appears in stored rows.
- **VALIDATE**: `test -f docs/guide/data-boundary.md && grep -c "m8-redact-v1" docs/guide/data-boundary.md` → ≥ 1

### 12. FIX F1 — add `--home` to the `pair` usage line

- **IMPLEMENT**: `apps/collector/src/cli.ts:426` →
  `"  collector pair <code> --url <baseUrl> [--name <n>] [--os <os>] [--hostname <h>] [--home <dir>]",`
- **PATTERN**: the adjacent `watch`/`sync`/`discover`/`git` lines (427-432) already carry `[--home <dir>]`.
- **GOTCHA**: This is a **help-text-only** change. The handler already honors `--home`
  (`cli.ts:502` → `runPair` → `credentialsPathFor(opts.home ?? homedir())` at `:123`). Do not "also
  wire it up" — it is wired.
- **VALIDATE**: `npx tsx apps/collector/src/cli.ts --help 2>&1 | grep "collector pair"` → contains `--home`

### 13. FIX F2 — print the resolved credentials path, not the OS-home constant

- **IMPLEMENT**: `apps/collector/src/cli.ts:506`. Replace `${CREDENTIALS_PATH}` with the path actually
  written — i.e. hoist `const home = resolveHome(args);` above the `runPair` call, pass `home`, and
  print `credentialsPathFor(home)`.
- **IMPORTS**: `credentialsPathFor` is already exported from `./identity.js`
  (`apps/collector/src/identity.ts:35`). Confirm it is in `cli.ts`'s import list; add it if not.
- **GOTCHA**: `CREDENTIALS_PATH` is still used elsewhere in the usage block (`cli.ts:441`) where the
  OS-home default **is** the correct thing to print. Change only line 506.
- **GOTCHA**: This is a **library/entrypoint boundary** case — `cli.ts` is an entrypoint, so printing
  here is allowed (CLAUDE.md). Do not push the print into `runPair`.
- **VALIDATE**: add/extend a unit test in `apps/collector/src/cli-home.test.ts` asserting the pair
  confirmation names the `--home`-resolved path; `npx vitest run apps/collector/src/cli-home.test.ts`

### 14. PERFORM the timed clean-room deploy → `.agents/research/cleanroom-2026-08-02.md`

- **IMPLEMENT**: Follow `docs/guide/quickstart.md` **verbatim**, timing each of its 13 steps. Record a
  table of `step | wall-clock | needed intervention? | notes`, then a summary: total time to first
  verified capture vs the **< 30 min** target (`research-analysis-plan.md` §5.2).
- **ISOLATION — MANDATORY, verify before starting:**
  - **Fresh clone into the scratchpad**, never under `OneDrive/Documents/` (D-16.0-3). This is also
    what makes step 1 (`npm run setup`) runnable at all — `setup-env.mjs:120-123` refuses to overwrite
    the existing root `.env`.
  - **Separate database.** `docker-compose.yml` serves `420ai` on host port **5433**; `420ai_test`
    already shares that instance. Create a **third** database (e.g. `420ai_cleanroom`) and point the
    clone's `DATABASE_URL`/`DATABASE_URL_APP` at it. Never run migrations against `420ai`.
  - **Separate collector home.** Every collector invocation takes `--home <scratchpad>/cleanroom-home`.
    Per F1/F2 (now fixed), `pair` honors this — confirm the printed path names the clean-room home.
  - **Separate ports** for ingest/dashboard if the real stack is running, so the clean room cannot
    talk to the real archive by accident.
- **GOTCHA — the deliverable is the log, not a passing time.** A result of "47 minutes, 6 of them
  minting an API key" is a **successful** slice outcome. Do not tune, shortcut, or use prior knowledge
  to skip a documented step; that destroys the measurement.
- **GOTCHA — D-16.0-2: do not fix what you find.** Any step over 5 minutes or needing intervention
  becomes an entry in `.agents/research/incidents.md`, categorized per §4.4 (capture / parser /
  attribution / pricing / projection / UX / user-understanding). It earns a fix in a later slice under
  the scope-change rule.
- **GOTCHA**: Watch the post-15.9 auth chain specifically — `ADMIN_EMAIL`/`ADMIN_PASSWORD` bootstrap →
  login → mint API key → pair collector. That is the prime suspect for the budget.
- **GOTCHA — tear down cleanly.** Drop `420ai_cleanroom`, delete the clone and the clean-room home.
  Confirm the real `~/.420ai/credentials.json` and `queue.sqlite` have unchanged mtimes.
- **VALIDATE**: `test -f .agents/research/cleanroom-2026-08-02.md`; the file contains a timing table
  and a stated total; `psql -l` shows no `420ai_cleanroom`; real credentials mtime unchanged.

### 15. UPDATE `SUMMARY.md` for slice completion + FORMAT

- **IMPLEMENT**: Confirm `**16.0**` ✅ is present with the PR number (Task 4c) — SUMMARY must be
  updated in the **same commit** as the slice (CLAUDE.md).
- **GOTCHA — CI lints markdown, `repo-health` does not.** This slice is almost entirely markdown, so
  `npm run format` is not optional here: CI's `format:check` covers `**/*.md` while local
  `repo-health` never runs Prettier. Skipping it fails CI after a green local gate.
- **GOTCHA**: CI also runs `npm run lint` (ESLint), which `repo-health` does not. Tasks 12–13 touch
  TypeScript, so run it.
- **VALIDATE**: `npm run format && npm run format:check && npm run lint && npm run repo-health`

---

## TESTING STRATEGY

### Unit Tests

Only Tasks 12–13 are behavioural. Extend `apps/collector/src/cli-home.test.ts` (it already exists and
already covers `--home` resolution — read it first and mirror its fixture style) with one case: the
`pair` confirmation message names the `--home`-resolved credentials path, not the OS-home constant.

Everything else in this slice is markdown and is validated by grep assertions, not by vitest.

### Integration Tests

**None required, and none should be added.** No schema change, no route change, no repository change.
`*.int.test.ts` files are touched only for comment repointing (Tasks 6–7), which must not alter
behaviour — the diff for those files should be comment-only.

> Because there is no DB-layer change, `--require-db` is **not** gating for this slice. That is a
> deliberate, stated exception, not an oversight: CLAUDE.md requires `--require-db` before signing off
> any milestone touching `@420ai/db` or `apps/ingest`, and this slice's touches there are comments
> only. Verify that claim: `git diff --stat` on those paths should show comment-line changes only.

### Edge Cases

- **The lockfile false positive.** `package-lock.json:3058` contains `M16` inside a base64 integrity
  hash. Assert it is unchanged: `git diff --name-only | grep -c package-lock.json` → `0`.
- **Historical artifacts untouched.** `git diff --name-only .agents/execution-reports .agents/code-reviews`
  → empty (Task 9's GOTCHA).
- **`check-summary` self-reference.** The gate only fires once
  `.agents/execution-reports/m16-slice0-*.md` exists — i.e. after `/lril:execution-report`. Re-run
  `node scripts/check-summary.mjs` *after* writing the execution report, not only before.
- **Clean-room leakage.** Real `~/.420ai/credentials.json` and `queue.sqlite` mtimes unchanged after
  Task 14.

---

## VALIDATION COMMANDS

### Level 1: Syntax & Style

```bash
npm run typecheck        # root tsc -b — must exit 0
npm run lint             # ESLint — NOT in repo-health; CI runs it
npm run format:check     # Prettier over **/*.md — NOT in repo-health; CI runs it
```

### Level 2: Unit Tests

```bash
npx vitest run apps/collector/src/cli-home.test.ts   # Task 13's assertion
npm test                                             # full suite — units always run
```

### Level 3: Integration Tests

Not gating for this slice (no DB/route change — see TESTING STRATEGY). Integration tests self-skip
without `DATABASE_URL_TEST` and that is acceptable **here only**.

### Level 4: The renumber is complete and correct

```bash
# NOTE the pathspec: 'apps/*/src' does NOT match here (verified during planning — it returns
# nothing and would give a FALSE PASS). Use the double-star form.

# No live source references the old number:
git grep -n "M16" -- 'apps/**/src/**' 'packages/**/src/**'   # → 0 matches
# Live docs reference only the NEW M16:
git grep -n "M16" -- SUMMARY.md docs/                        # → inspect each; all must be new-M16
# The renumber landed — 21 hits across 14 files:
git grep -c "M20" -- 'apps/**/src/**' 'packages/**/src/**' | awk -F: '{s+=$NF} END {print s}'  # → 21
git grep -c "M20" -- 'apps/**/src/**' 'packages/**/src/**' | wc -l                              # → 14
# Historical record untouched:
git diff --name-only .agents/execution-reports .agents/code-reviews   # → empty
git diff --name-only | grep -c package-lock.json             # → 0
```

> **GOTCHA — a pathspec that matches nothing reports success.** `git grep -c "M16" -- 'apps/*/src'`
> returns zero rows, which reads identically to "clean" in a checklist. This is the same class as
> CLAUDE.md's file-level-vs-call-site lesson: **verify the negative command can actually fail** by
> running it against the un-renumbered tree first and confirming it reports 21.

### Level 5: The gate

```bash
node scripts/check-summary.mjs   # exit 0
npm run repo-health              # the enforced gate — must PASS
```

---

## ACCEPTANCE CRITERIA

- [ ] `.agents/plans/m16-dogfood-instrumentation.md` exists, defines slices 16.0–16.4, records
      D-16.0-1…3 + D-M16-1 (observation set) + D1–D4 disposition, and names every non-goal
- [ ] All **38 live** M16 sites repointed: 17 doc + 21 source across 14 files;
      `git grep "M16" -- 'apps/**/src/**' 'packages/**/src/**'` returns nothing (with the pathspec
      proven capable of failing — see Level 4)
- [ ] All **32 historical** hits untouched; exactly one erratum legend added
- [ ] `package-lock.json` unmodified
- [ ] `SUMMARY.md` defines the new M16 as **IN PROGRESS**, lists SaaS as **M20** unsequenced, and
      carries `**16.0**` ✅ with the PR number
- [ ] `SUMMARY.md` does **not** contain `**M16 …** is **DONE**`
- [ ] `.agents/research/` scaffold complete (8 files); §3 privacy rule stated in README and in every
      observation-holding file; `participants.md` has zero rows
- [ ] `docs/guide/data-boundary.md` exists, every claim cited by `file:line`, quotes `m8-redact-v1`
- [ ] F1 fixed — `pair` usage line lists `[--home <dir>]`
- [ ] F2 fixed — pair confirmation prints the resolved path; covered by a unit test
- [ ] `.agents/research/cleanroom-2026-08-02.md` records a per-step timing table and a total against
      the 30-minute target; every >5-min or intervention step has an `incidents.md` entry
- [ ] Clean room fully torn down; real credentials + queue mtimes unchanged
- [ ] **No** onboarding-friction fix shipped in this slice (D-16.0-2)
- [ ] `npm run format && npm run lint && npm run repo-health` all pass

## COMPLETION CHECKLIST

- [ ] All 15 tasks completed in order
- [ ] Each task's VALIDATE ran and passed at the time
- [ ] `npm run repo-health` PASS
- [ ] `npm run lint` and `npm run format:check` PASS (CI-only gates)
- [ ] `node scripts/check-summary.mjs` PASS **after** the execution report is written
- [ ] Non-goals named in the PR body
- [ ] `SUMMARY.md` updated in the SAME commit

---

## NOTES

### Spikes actually run during planning (evidence for the confidence score)

| Spike | Result |
|---|---|
| `git grep -n "M16" -- .` (exhaustive) | **71 hits total**; 70 excluding the `package-lock.json` false positive, split **38 live / 32 historical**. The initial scope estimate of "four code comments" was wrong by 17 — a filtered grep had hidden them. |
| `git grep -c "M16"` per file, summed | 21 source hits across **14** files; 17 doc hits; 32 historical. Arithmetic checked: 38 + 32 = 70. |
| Pathspec sanity check | `'apps/*/src'` matches **nothing** — it would have produced a false PASS in the Level 4 gate. Corrected to `'apps/**/src/**'`, which reports 21. |
| `node scripts/check-summary.mjs` | Baseline **PASS** — "32 slice(s) under DONE milestones; nothing to enforce" |
| Read `check-summary.mjs:52-70` | Confirmed the ✅-within-4-chars rule and the `is **DONE**` self-relaxing behaviour |
| Read `cli.ts:425-441`, `:491-510`, `:106-127` | **Found F1 and F2** |
| Read `identity.ts:20,35-38` | Confirmed `CREDENTIALS_PATH` (homedir constant) vs `credentialsPathFor(home)` |
| `grep existsSync scripts/setup-env.mjs` + `test -f .env` | `.env` **exists**; `setup-env.mjs:120-123` refuses to overwrite → drove D-16.0-3 (fresh clone) |
| Read `docs/guide/quickstart.md` | 13 numbered steps — this is "the documented path" for Task 14 |
| Read `redaction.ts:18,70-151` | `REDACTION_VERSION = "m8-redact-v1"`; 15 rule kinds enumerated |
| Read `crypto.ts:1-30`, `schema.ts:43,422-424,472-475,638,682-687` | AES-256-GCM keyring; exact encrypted vs deliberately-unencrypted columns |
| `grep docker-compose.yml` | `420ai` on host port 5433; `420ai_test` shares the instance → clean room needs a third DB |

No throwaway artifacts were created; all spikes were read-only greps and file reads.

### Trade-offs

**Why the historical record is not rewritten.** Consistency would be simpler to explain, but
`.agents/execution-reports/` is the input to `check-summary.mjs` and to the system-reviews. Editing
dated records to match a later decision means the repo can no longer answer "what did we believe on
2026-08-02?" The erratum legend costs one blockquote and preserves that.

**Why F1/F2 are fixed here despite D-16.0-2.** D-16.0-2 forbids fixing *onboarding friction* because
friction is the thing being measured. F1/F2 are not friction — they are defects in the isolation
mechanism the measurement's safety constraint depends on. Leaving them means Task 14 cannot prove it
did not touch real data.

**Why part 4 is last.** Its output is unknown at planning time and it depends on F1/F2. It is also the
only task that can fail for reasons outside the repo (Docker, a slow `npm install`). If it stalls, the
first 13 tasks are independently shippable — split it into 16.0b rather than blocking the renumber.

### Residual risk

Task 14's wall-clock is genuinely unknown — that is its purpose. A fresh clone plus `npm install` on
this repo may itself take a non-trivial share of the 30-minute budget, which is worth recording
**separately** from the auth chain: "clone + install" is a one-time developer cost a design partner
running a released installer would not pay, so folding it into the headline number would overstate the
onboarding problem. Record both, report them apart.

### Confidence

**9.4 / 10** for one-pass success.

Earned by: the exhaustive enumeration is machine-derived and reproduced per-file with exact counts
(the single largest risk, and it is now retired); the `check-summary` gate semantics were read from
source rather than assumed, including the two ways to fail it; every referenced symbol
(`credentialsPathFor`, `resolveHome`, `runPair`, `CREDENTIALS_PATH`, `REDACTION_VERSION`) was verified
by reading its definition; the test harness for Task 13 (`cli-home.test.ts`) was confirmed to exist;
and the `.env`-refusal discovery changed the design of Task 14 before it could fail at execution time.

The 0.6 deduction is Task 14 alone: it involves Docker, a fresh clone, and a multi-service bring-up
whose failure modes are environmental rather than logical. Tasks 1–13 and 15 I would put at 9.8. If
Task 14 stalls, the stated fallback is to split it into 16.0b — which caps the blast radius at one
task rather than the slice.
