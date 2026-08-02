# Research backlog

Observations ranked by **evidence**, not by appeal. Required by
[`research-analysis-plan.md`](../supplemental%20docs/research-analysis-plan.md) §3 (which permits
either GitHub issues or this file; this file is the record, and an item may link an issue).

> **PRIVACY RULE (§3).** No captured session content, secrets, access tokens, or personally
> identifying source data. Aggregate metrics, anonymized consented quotes, and links/IDs only.
> Refer to participants by code (`P-01`), never by name.

## What this file is for

This is where things go **instead of** getting built. §2's scope-change rule:

> Before starting any feature, write one sentence in the weekly decision log: _which current
> data-quality failure, user workflow, or hero-insight evidence does this feature improve?_
> **If there is no specific answer, place the item in the backlog rather than building it.**

So an entry here is not a rejection — it is an item whose evidence has not arrived yet. §12 names the
failure mode this guards against directly: _"scope returns through 'one small feature' requests"_,
whose early warning is a backlog growing faster than the decision log.

**Cadence:** Wednesday triage, 30 min (§3) — produce a prioritized issue list.

## Ranking

Rank by the strength of the evidence behind an item, not by how easy or appealing it is:

| Rank | Meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| **A** | Blocks capture, trust, or the hero workflow. Named in an incident or a decision entry. |
| **B** | Repeated observation with evidence (≥2 occurrences, or ≥2 participants).              |
| **C** | Single observation, or a feature request. **Desire is not evidence of value** (§8).   |
| **D** | Idea with no observation behind it yet.                                               |

During research Phase 4, §6 is explicit: _"fix only blockers to capture, trust, and the hero
workflow. Log everything else in the research backlog."_ That means rank **A** only.

## Entry format

```markdown
- **[rank] <short title>** — <one line>
  - _Evidence:_ incident/decision/interview IDs, or "none yet"
  - _Would improve:_ which data-quality failure / user workflow / hero-insight evidence (§2)
  - _Links:_ issue, slice plan, report IDs
```

---

## Items

_None yet._

## Deferred by decision (not backlog — these have been ruled on)

These are recorded in [`../plans/m16-dogfood-instrumentation.md`](../plans/m16-dogfood-instrumentation.md)
and are listed here only so nobody re-files them as new observations:

- **Cross-connector `claude-live` ↔ `claude-export` dedup** (D1) — avoided during Phase 1 by
  configuration (D-M16-1 does not run the browser extension), deferred as work.
- **`discoverRoots` refinement** (D2) — deferred; earns a fix if project attribution misses its ≥90%
  target with evidence attached.
- **Antigravity connector** (D4) — deferred; §2 places connector breadth for unused tools out of
  scope.
- **Hero workflow evidence panel** (§7 P1.6) — deliberately not scheduled until Phase 2 selects the
  hero workflow from evidence.
