# Code review — M16 slice 16.0, Truth + Research Scaffold

**Reviewed:** commit `25e0ab9` on `m16-slice0-truth-and-research-scaffold`
**Plan:** [`.agents/plans/m16-slice0-truth-and-research-scaffold.md`](../plans/m16-slice0-truth-and-research-scaffold.md)
**Date:** 2026-08-02

**Stats:**

- Files Modified: 21
- Files Added: 16
- Files Deleted: 0
- New lines: 3507
- Deleted lines: 58

This is a documentation + scaffolding slice. The only executable change is **8 lines** in
`apps/collector/src/cli.ts` plus its test, so the review weight falls on **factual accuracy of the
prose**, which for this slice is a correctness property rather than a style one — `data-boundary.md`
exists to be trusted by a design partner deciding whether to point a capture agent at their work.

## What was verified mechanically

| Check                                                          | Result |
| -------------------------------------------------------------- | ------ |
| Renumber gate `git grep M16 -- 'apps/**/src/**' 'packages/**/src/**'` | 0 matches; **21 `M20` across 14 files** |
| Gate proven capable of failing (same command at `HEAD~1`)      | reports **21** — the negative test can fail |
| Historical records untouched (`.agents/execution-reports`, `.agents/code-reviews`, `.agents/plans/m15-slice*`) | empty diff ✅ |
| `package-lock.json` (base64 `M16` false positive)              | unmodified ✅ |
| db/ingest/shared diff is comment-only                          | 21+/21− , **every changed line a comment** ✅ |
| All relative markdown links (71)                               | **all resolve** ✅ |
| `data-boundary.md` `file:line` citations (32 sampled)          | **31 correct, 1 off-by-one** (see #3) |
| `PairResponse` vs test fixture                                 | `{token, machineId}` — fixture satisfies it ✅ |
| `cli-home.test.ts` in `tsc -b` graph                           | yes (only `*.int.test.ts` excluded) ✅ |
| F2 regression test fails against old code                      | **verified** — reverted, observed fail, restored ✅ |
| `repo-health -- --require-db`                                  | PASS, **516 int tests ran, 0 skipped** ✅ |

---

## Findings

### 1. HIGH — `data-boundary.md` asserts a connector allow-list that the product does not enforce

```
severity: high
file: docs/guide/data-boundary.md
line: 41-43
```

**issue:** The document states that connectors other than Claude Code and Codex CLI "are **not
enabled** for this period" and that "a connector that is not enabled reads nothing." Neither the
first clause nor its implication is true of the shipped state.

**detail:** Connectors are **default-ON**. `apps/collector/src/connectors/connector-config.ts:33-34`
documents the config map as _"a missing id ⇒ enabled (default-on)"_, `:37` calls the empty override
set _"the safe default — so every connector is enabled"_, and `filterConnectors` at `:67-71` removes
only connectors **explicitly** disabled. D-M16-1 is a written intention in a plan file; nothing in
this slice wrote a `connectors[id].enabled = false` override, so no allow-list is in force.

This is not a hypothetical. **This slice's own clean-room run disproved the sentence**: the collector
logged `watching 8 connector(s)` and the Cursor connector captured
`260/350 session(s) changed → 16916 record(s), 39888 event(s)` from the operator's real `%APPDATA%`
store — recorded in the same commit as **INC-2026-01**. So the repository simultaneously ships a
document saying Cursor is not enabled and an incident report proving Cursor captured 350 real
sessions.

Severity is HIGH rather than medium for three compounding reasons: this is the one document written
for **informed consent** before someone pairs a machine; the false claim is specifically about
*which of a user's tools get read*, which is the exact question the document exists to answer; and it
appears in a page whose own opening rule is _"Where the code does not do something, this document
says so rather than describing an intention."_ The document breaks its own stated contract, which
also undermines the reader's warrant for trusting the other five sections.

**suggestion:** Rewrite §1's framing to describe the mechanism truthfully and separate intent from
enforcement:

- State that **all registered connectors are enabled by default**, and that disabling is an explicit,
  per-connector action (`filterConnectors` / the `connectors.set` surface).
- Present the Claude Code + Codex CLI table as **"the connectors D-M16-1 commits to observing"**, and
  say plainly that until the others are explicitly disabled they **will** capture if their source
  paths exist.
- Cross-reference INC-2026-01 for the sharper point: `--home` does not scope the Cursor poll
  connector, so even an isolated collector reads the real store.
- Either apply the disable overrides for the research period and say so, or state that the allow-list
  is aspirational and pending. Both are honest; the current text is neither.

### 2. MEDIUM — summary paragraph overstates the deletion story that §6 gets right

```
severity: medium
file: docs/guide/data-boundary.md
line: 21-22
```

**issue:** The one-paragraph summary says **"Nothing is ever deleted automatically"**, while §6 —
correctly — enumerates **four** automatic deletions.

**detail:** §6 is accurate and carefully hedged: raw records, events, git commits, report artifacts
and search documents are never automatically deleted, but backup **files** prune at
`RETENTION_DAYS` (default 14), machine heartbeat samples prune at 24 h, ingest auth-failure rows at
7 days, and orphaned events are deleted on re-parse. The intro's absolute is a stronger claim than
the section it forward-references, and it is the sentence most likely to be quoted, because it is in
the summary. A reader who later discovers heartbeat pruning has caught the document in an error it
did not need to make.

**suggestion:** Narrow the intro to the claim §6 actually supports — e.g. "**Your captured work is
never deleted automatically** — see §6, which lists the four bounded exceptions (none of them your
sessions)." Preserves the intended reassurance without the overstatement.

### 3. LOW — one citation off by one line

```
severity: low
file: docs/guide/data-boundary.md
line: 168
```

**issue:** `EXPORT_MAX_ROWS` is cited as `repositories/exports.ts:23`; it is declared on line **22**.

**detail:** Trivial in isolation, and I checked 32 citations to find it — the other 31 are correct,
including every encryption and redaction claim. It is worth fixing only because this document's
entire value proposition is that its citations are checkable, and it explicitly instructs the reader
to "trust the code and fix this page" on a mismatch. A reader who spot-checks the first citation they
try and finds it wrong will discount the rest.

**suggestion:** Change `exports.ts:23` → `exports.ts:22`.

### 4. MEDIUM — `SUMMARY.md` cites a PR number that does not exist

```
severity: medium
file: SUMMARY.md
line: 821
```

**issue:** The 16.0 entry reads **DONE `2026-08-02` (PR #72)**. `gh pr list --head
m16-slice0-truth-and-research-scaffold` returns empty — no PR exists, and #72 is a guess extrapolated
from the last merged PR (#71).

**detail:** `SUMMARY.md` is described in CLAUDE.md as a **projection of ground truth**, and
`check-summary.mjs` exists precisely because that projection drifts. Committing a predicted PR number
writes an unverified fact into the artifact whose job is accuracy. If the PR lands as #73 — trivially
possible if any other PR opens first — the roadmap permanently cites the wrong one, and nothing in
the gate would catch it (`sliceMarkedDone` only looks for a ✅ near the token).

**suggestion:** This is exactly what the post-execute flow's Phase 4 handles — open the PR, then
backfill the real number into both blocks before merge. No change needed now beyond ensuring that
step is not skipped. Flagging it so it is not forgotten, since the wrong number is already written
down.

---

## Deliberately not flagged

- **Remaining `M16` strings in `.agents/plans/m16-slice0-*.md`** — that file is the slice's own
  planning record describing the renumber; it is the HISTORICAL population under D-16.0-1 and
  correctly says `M16` throughout.
- **Renumber notices that name both numbers** ("was M16, now M20") in `SUMMARY.md`, `docs/PRD.md`,
  `outline.md` — unavoidable, and each states the mapping explicitly, so no reader is misdirected.
- **Redaction rule count of 14** — the plan said 15; the implementation has 13 regex rules
  (`redaction.ts:67-155`) plus one entropy backstop (`:215-226`). The document is right and the plan
  was wrong. Correct call.
- **`pairSummary` exported from an entrypoint** — it builds a string; `main()` prints it. Consistent
  with CLAUDE.md's library/entrypoint rule, and extraction was necessary to make F2 testable.
- **INC-2026-06's §4.4 category** — "capture" is a slightly forced fit for a procedure defect, but
  the entry says so explicitly in a parenthetical rather than pretending otherwise.

## Verdict

**Four findings: one HIGH, two MEDIUM, one LOW. No critical issues, no security issues, no logic
errors in the executable change.**

The renumber is complete and correct, and was verified with a negative control rather than asserted.
The F1/F2 fixes are minimal, correctly scoped to the entrypoint, and the F2 test was proven to fail
against the old code — which is the only evidence that a regression test regresses anything.

Finding #1 is the one that matters and should be fixed before merge. It is not a typo: it is the
research period's consent document making a claim about which of the user's tools are read, that the
same commit's incident log disproves. Fixing it costs a paragraph; shipping it costs the document's
credibility at exactly the moment its purpose begins.
