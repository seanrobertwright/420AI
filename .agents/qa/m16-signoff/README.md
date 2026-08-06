# M16 pre-sign-off evidence — 2026-08-05

Evidence for the checklist in
[`.agents/plans/m16-dogfood-instrumentation.md`](../../plans/m16-dogfood-instrumentation.md)
("Pre-sign-off checklist (maintainer manual — every box)"). Adopted from M14/M15 practice.

> **PRIVACY.** Same rule as `.agents/research/` — IDs, counts and hashes only. No session content,
> no tokens, no secrets. Session ids below point into the operator's own archive.

## Box status

| # | Box | Result |
| - | --- | ------ |
| 1 | Label round-trips (create → edit → export → delete), raw record provably unmutated | ✅ [below](#box-1--label-round-trip) |
| 2 | Scorecard distinguishes "no work happened" from "capture is broken" on a **deliberately broken** connector | ✅ [below](#box-2--deliberately-broken-connector) |
| 3 | Data-quality audit reconciles against a hand-counted ten-session sample (§4.4) | ✅ [reconciliation-2026-08-05.md](./reconciliation-2026-08-05.md) |
| 4 | `docs/guide/data-boundary.md` re-verified against source | ✅ [below](#box-4--data-boundary-re-verification) |
| 5 | Four consecutive weekly scorecards in `.agents/research/weekly/` | ⛔ **BLOCKED — calendar** |
| 6 | `repo-health --require-db` green with 0 skipped | ✅ [below](#box-6--repo-health) |

**Box 5 is the one open blocker.** The research scaffold landed 2026-08-02 (slice 16.0) and
`weekly/` holds only `TEMPLATE.md`. Four consecutive Monday scorecards require ~4 weeks of elapsed
calendar time; no amount of work closes it today. **M16 therefore stays IN PROGRESS.**

This exercise also produced **INC-2026-07** and a shipped-code defect fixed as **slice 16.5** — see
[reconciliation-2026-08-05.md](./reconciliation-2026-08-05.md), which is where the substance is.

---

## Box 1 — label round-trip

Session `e64de0e3-de31-4017-b39d-5c09040e6259` (claude-code, 17 raw / 25 events).

| Step | Call | Result |
| ---- | ---- | ------ |
| create | `POST /v1/sessions/:id/label` | **201** — `revision: 1`, all six §4.3 fields stored |
| read | `GET /v1/sessions/:id/label` | **200** |
| edit | `PATCH /v1/sessions/:id/label` | **200** — `revision: 2`, rating 4→5, friction `context`→`none` |
| export | `GET /v1/labels/export?format=json` | **200** — 1 row, 14 fields, our session present |
| delete | `DELETE /v1/sessions/:id/label` | **204** |
| read back | `GET /v1/sessions/:id/label` | **404** |

**Immutability proof.** A content hash over every raw row of the session
(`md5(string_agg(id ‖ ciphertext ‖ iv ‖ tag ‖ ingested_at))`) taken before and after the whole
cycle: `8d1678af3259127c…` → `8d1678af3259127c…`, **identical**. Counts unchanged (17 raw / 25
events). A count comparison alone would not have proved this — an in-place payload rewrite keeps
the count identical, and "raw records sacred" is a claim about bytes.

`outcome_labels` = 0 and `outcome_label_revisions` = 0 for the session afterwards, confirming
D-16.1-6's stated cascade: the delete is HARD and takes the revision history with it.

## Box 2 — deliberately broken connector

The break: a real `.jsonl` file inside Claude Code's declared capture scope
(`~/.claude/projects/*/*.jsonl`) with read access denied via `icacls`, so the connector's `open()`
fails. Reversible, touches no real session data, breaks exactly one connector. Removed afterwards
(`icacls /reset` + delete, verified absent).

A first attempt — a *directory* named `…​.jsonl` — produced **no** error, because the connector's
glob excludes directories. Recorded because it is the more likely thing a future tester reaches for.

| connector | before | after | errors |
| --------- | ------ | ----- | ------ |
| **claude-code** | `idle` / `capturing` | **`erroring` / `broken`** | 1 — `EPERM … open '~\.claude\projects\…'` |
| chatgpt-export | `idle` / `capturing` | `idle` / `capturing` | 0 |
| claude-export | `idle` / `capturing` | `idle` / `capturing` | 0 |
| claude-live | `silent` / `broken` | `silent` / `broken` | 0 |
| codex-cli | `idle` / `capturing` | `idle` / `capturing` | 0 |
| cursor | `idle` / `capturing` | `idle` / `capturing` | 0 |
| gemini-cli | `silent` / `broken` | `silent` / `broken` | 0 |
| gemini-export | `idle` / `capturing` | `idle` / `capturing` | 0 |

**§7 P0.1's criterion is met**, and on three distinguishable states rather than two:

- `idle` / `capturing` — declared, enabled, no error, no recent events = **no work happened**
- `erroring` / `broken` — declared, enabled, carrying a real diagnostic = **capture is broken**
- `silent` / `broken` — declared but has never produced anything

No other connector moved, so the signal is specific rather than a blanket degrade.

**A privacy claim verified live, not just read.** The stored error is
`Error: EPERM: operation not permitted, open '~\.claude\projects\C--Users-seanr\zz-…'` — the home
directory is **home-relativized to `~`** before it leaves the machine, exactly as
`data-boundary.md` §1 promises. The diagnostic survives; the username does not.

**One D-M16-1 compliance gap, observed rather than inferred.** `collector watch` logs
`watching 8 connector(s)` and all eight report `enabled: true` / `approved`. D-M16-1 fixes the
observation set at **Claude Code + Codex only**. `data-boundary.md` §1 already states that this is
"a written commitment, not an enforced configuration" — this run is the measurement confirming it.
The queue drained in this exercise was nonetheless clean (`claude-code` 150,441 / `codex-cli` 9,387
and nothing else), so no off-set data entered the archive; the other six found nothing to capture.
That is luck of the file system, not a control.

## Box 4 — data-boundary re-verification

Every load-bearing `file:line` citation re-checked against source. **Exact and unchanged:**
`redaction.ts:18` (`m8-redact-v1`), the 13 named rules at 69–150 **plus** `high_entropy` at 225
(= 14, as documented), `crypto.ts:17-19`, `machines.ts:11` (24 h), `auth-failures.ts:15-16` (7 d),
`reparse.ts:253-263`, `connector-config.ts:33-34`, `schemas.ts:343` (`sampleSize` max 50),
`exports.ts:150/193/232/252/299/320`, `search.ts:29-32/135-136/156-157/256/317-318`,
`repositories/exports.ts:22` (`EXPORT_MAX_ROWS = 100_000`), `cursor.ts:331`,
`members.ts:179-181`, `backup-archive.sh:11,29,37`, and the 8-connector registry.

**Four citations had drifted, all of them in the M16-added content** — 16.1's routes grew as 16.2
extended them and nobody re-checked. Corrected in this commit per the page's own rule ("trust the
code and fix this page"):

| claim | was | now |
| ----- | --- | --- |
| `git_commits.message_ciphertext` | `schema.ts:717` | `schema.ts:719` |
| label export (§5 intro) | `outcome-labels.ts:331-343` | `outcome-labels.ts:393-432` |
| label export route + redaction | `outcome-labels.ts:358` / `:375` | `:415` / `:432` |
| label DELETE route | `outcome-labels.ts:262` | `outcome-labels.ts:273` |

No **substantive** claim was found false — the drift is positional only. Box 2 additionally
verified the §1 home-relativization claim behaviourally.

## Box 6 — repo-health

`npm run repo-health -- --require-db`, after the 16.5 fix:

```
✓ tsc -b: 0 errors
✓ dashboard tsc --noEmit: 0 errors
✓ desktop tsc --noEmit: 0 errors
  Test Files  164 passed (164)
       Tests  1571 passed (1571)
✓ vitest: all tests passed (635 integration tests ran, 0 skipped)
repo-health: PASS
```

1571 tests / 635 integration, up from 1570 / 634 — the added test is 16.5's index guard in
`data-quality.int.test.ts`. `0 skipped` is the assertion that matters (`skipped ≠ passed`).
