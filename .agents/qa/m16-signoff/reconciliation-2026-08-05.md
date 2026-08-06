# §4.4 ten-session reconciliation — 2026-08-05

Box 3 of the M16 pre-sign-off checklist: _"the data-quality audit's numbers reconcile against a
hand-counted ten-session sample."_ Method is `research-analysis-plan.md` §4.4; metric definitions
are §5.1.

> **PRIVACY.** IDs, counts and hashes only. Session ids point into the operator's own archive.

## Why this is done by hand

The audit report grades capture quality, and the same operator built the audit (M16 Risk 2). §4.4's
ground truth is therefore taken from **outside the product** — the tool-native session files on
disk — and the join runs disk → archive, never archive → archive. Anything computed from captured
sessions alone scores a perfect result by construction.

16.4 already encodes this: `captureCoverage` and `attributionCorrectness` ship permanently
`unknown` (D-16.4-4) with a `reason` that tells the operator to hand-count them. This document is
that hand count. **The two halves are designed to meet here**, and they did.

## Sample

Deterministic (mulberry32, seed `20260805`) so it is reproducible and auditable.

- **Population: 373 sessions** — 366 `claude-code` + 7 `codex-cli`; 222 `scrap-kanban` + 151 `420AI`.
- Read from `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/*.jsonl`, with the session id
  taken the way the parsers take it (`record.sessionId`; `payload.id`) so the join key matches
  without importing the parsers.
- **Sample: 10**, drawn uniformly at random. A curated sample measures the curator.

**Two sampling traps hit on the first pass, both recorded because they would recur:**

1. **D-M16-1 names the repo `scrap-kanban`; on disk it is the directory `…/scrap/kanban`.** A
   literal string match returned **zero** of its 267 sessions and reported a population of 151
   instead of 373. The decision's label is not the path.
2. **Drive-letter case varies** — both `C:\…\420AI` and `c:\…\420AI` occur, as do both cases for
   `scrap\kanban`. They are the same project and must not split the denominator.

**Sample composition caveat, stated rather than hidden:** the draw contains **0 Codex sessions**.
That is correct behaviour (Codex is 7/373 ≈ 1.9%, so P(none in 10) ≈ 0.82), and it means this
sample has **no power over the Codex connector**. Per §5.1's closing rule, that is recorded as a
known limit, not silently generalised.

## Results (n = 10)

Checks per §4.4. Check 1 is true by construction. Check 4 is the human judgement.

| # | repo | raw | events | tokens | search | attribution | captured? |
| - | ---- | --: | -----: | -----: | -----: | ----------- | --------- |
| 1 | 420ai | 0 | 0 | 0 | 0 | — | **NO** |
| 2 | scrap-kanban | 0 | 0 | 0 | 0 | — | **NO** |
| 3 | scrap-kanban | 22 | 39 | 14 | 15 | `kanban` ✓ | yes |
| 4 | scrap-kanban | 0 | 0 | 0 | 0 | — | **NO** |
| 5 | scrap-kanban | 782 | 1348 | 500 | 166 | `kanban` ✓ | yes |
| 6 | 420ai | 0 | 0 | 0 | 0 | — | **NO** |
| 7 | scrap-kanban | 0 | 0 | 0 | 0 | — | **NO** |
| 8 | scrap-kanban | 0 | 0 | 0 | 0 | — | **NO** |
| 9 | 420ai | 17 | 25 | 8 | 10 | `420AI` ✓ | yes |
| 10 | scrap-kanban | 857 | 1501 | 428 | 111 | `kanban` ✓ | yes |

| §4.4 check | result |
| ---------- | ------ |
| 2 — 420AI raw record exists | **4/10** |
| 3 — events + token data plausible | 4/4 of captured |
| 4 — attribution **correct** (human) | **4/4 of captured** |
| 5 — cost explained by confidence label | 4/4 of captured |
| 6 — visible in a search/report surface | 4/4 of captured |

Each captured session also shows exactly **2 unmapped events** — verified to be `session.started`
and `session.ended`, which carry no `project_path` by design. Not misattributions.

Cost confidence is `estimated-model-known` / `estimated-model-unknown` only, never `reported` —
matching the documented ladder (no connector reports cost). Parser version uniform at `2.0.0`.

## Reconciliation against the 16.4 audit

Artifact `6d98daa1-b80f-4d97-aa5d-e4f4990f743b`, `scopeKind: org`, params `{windowDays: 30,
sampleSize: 10}`, `m16-data-quality-v1` / `m16-capture-health-v1`.

| §5.1 metric | audit | hand count | verdict |
| ----------- | ----- | ---------- | ------- |
| Parse success | `measured` **46,293 / 60,909** | **46,293 / 60,909** (independent query) | **exact match** |
| Capture coverage | `unknown` + reason | **4/10 = 40%** | audit correctly declines; hand supplies |
| Attribution correctness | `unknown` + reason | **4/4 correct** | audit correctly declines; hand supplies |
| Attribution coverage | `measured` 140/141 = 99.29% | consistent | agree |
| Duplicate rate | `measured` 0 / 98,637 | — | — |
| Recoverability | `sampled` 10/10 | — | — |
| Sync freshness | `unknown` + reason | — | see below |
| Token completeness | `unknown` + reason | 4/4 of captured | see below |

**The headline is the first row.** The audit's parse-success numerator and denominator match a
hand-run query built independently of it, to the row. That is the reconciliation succeeding.

**The `unknown`s are the design working, not gaps.** Every one carries a reason naming what is
missing, and none substitutes zero — §5.1's closing rule enforced structurally (D-16.4-4).
`syncFreshness` and `tokenCompleteness` read `unknown` here because `machine_connectors` was empty
at audit time (the collector had run `sync`, which sends no heartbeat, not `watch`); the audit says
so in words rather than reporting a confident zero.

**The reconciliation also ran in the direction nobody plans for.** The first hand-count reported
attribution as **0/4 unmapped** while the audit said 140/141 attributed. The audit was right: the
chain is `events.project_path → workspace_keys.project_key → workspaces.id → workspaces.project_id
→ projects.id`, and the worksheet query had joined `projects.id = workspace_keys.workspace_id`,
skipping `workspaces` entirely. **The hand count was wrong and the product was right** — worth
recording, because a reconciliation whose worksheet is assumed correct is just a second way to
trust the same person.

## Against the §5.1 targets

| Metric | Measured | Target | |
| ------ | -------- | -----: | - |
| Capture coverage | **40%** | ≥95% | ❌ |
| Project attribution | 100% correct (n=4) | ≥90% | ✅ |
| Token completeness | 100% of captured | ≥95% | ✅ |
| Parse success | **76.0%** | ≥99% | ❌ |
| Duplicate rate | 0% | <1% | ✅ |
| Sync freshness | `unknown` | ≥95% | — |
| Recoverability | 10/10 | 100% | ✅ |

**Neither failing metric describes steady-state product behaviour**, and the distinction is the
whole finding — see INC-2026-07.

### Capture coverage 40% — two distinct loss mechanisms

The six uncaptured sessions separate perfectly by date, with no interleaving:

| file last written | captured? |
| ----------------- | --------- |
| 2026-07-07, 07-16, 07-18, 07-19, 07-21, 07-22 | **NO** (6) |
| 2026-07-23, 07-25, 07-26, 07-30 | yes (4) |

Cursor forensics explain it exactly. Every uncaptured file's `file_cursors` row was stamped in a
**four-minute burst on 2026-07-22 between 17:42 and 17:46**, at EOF, regardless of when the file
was actually written:

| file written | cursor stamped | state |
| ------------ | -------------- | ----- |
| 2026-07-16 | 2026-07-22 17:43:32 | at EOF |
| 2026-07-18 | 2026-07-22 17:44:10 | at EOF |
| 2026-07-19 | 2026-07-22 17:42:31 | at EOF |
| 2026-07-21 | 2026-07-22 17:46:13 | at EOF |

That is a **collector cold start cursoring pre-existing files at EOF** — INC-2026-05's documented
(and correct) behaviour, at scale. Everything written while the collector was down was skipped
permanently: never parsed, never queued, never ingested.

The seventh session (2026-07-07) is different: its cursor is contemporaneous (07-07 13:32), so it
*was* captured live — and it is present in `backups/420ai-20260722T125801Z.sql.gz` (149 rows), but
absent from the live archive, because the database was reset during M15 auth QA and never restored.

So: **1 of 6 is recoverable from the backup; 5 of 6 exist only on disk and no product path will
ever ingest them.** A single "capture coverage" percentage conflates a recoverable operational
mistake with a permanent, silent gap. Both are logged as INC-2026-07.

### Parse success 76.0% — measured, not yet explained

`46,293 / 60,909` raw records yielded at least one event. Below the ≥99% target, and the cause is
**not** established here. Some raw record types may legitimately yield no events, in which case the
metric's denominator is wrong rather than the parser. Recorded as measured and left for a slice to
diagnose (D-16.0-2) — guessing at it now would convert evidence into a story.

## The defect this exercise found

**The audit could not run at all** on a real archive. `rawRecordTotals` executes a correlated
`EXISTS` over `events` per raw record, and no index covered `(org_id, source_connector,
raw_record_id)`:

| | plan cost | wall clock |
| - | --------: | ---------- |
| as shipped (16.4) | 446,378,008 | **never returned** (>7 min, aborted twice) |
| with the index (16.5) | 519,564 | **402 ms** |

`POST /v1/audit/data-quality` hung, wrote no artifact, logged nothing — the client simply timed
out. §7 P0.3's acceptance criterion was therefore **unmet in production conditions for the whole
life of 16.4, with a green test suite**, because the integration fixtures are a handful of rows
where O(n·m) and O(n log m) are indistinguishable.

Fixed as **slice 16.5** (migration `0026`). After the fix the same request returns **201 in 4
seconds**, which is what made this reconciliation possible. Guard added in
`data-quality.int.test.ts` pinning the access path (not a timing assertion, which could only be
flaky at fixture scale), and the `rollback.int.test.ts` drill retargeted to 0026.

## Method notes for the next run

- Re-run with a **new seed** and record it; reusing `20260805` re-draws the same ten sessions.
- The worksheet is `.agents/qa/m16-signoff/` scratch only. If this becomes monthly, the disk-side
  sampler belongs in `scripts/` with a test, not in a temp directory.
- Draw **stratified by connector** if Codex coverage needs to be claimed; a uniform draw of 10 from
  this population will usually contain none.
- Check 4 cannot be automated and should not be. It is the one number in §5.1 whose ground truth is
  what the operator believes the session was about.
