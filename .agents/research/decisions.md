# Decision log

Evidence → action → expected result → follow-up. Required by
[`research-analysis-plan.md`](../supplemental%20docs/research-analysis-plan.md) §3; the entry format
below is its §11 template, verbatim.

> **PRIVACY RULE (§3).** No captured session content, secrets, access tokens, or personally
> identifying source data in this file. **Aggregate metrics, anonymized quotes with consent, and
> links/IDs only** — a session id, report artifact id, event fingerprint or git SHA points into the
> archive without copying anything out of it. This file is committed to a public repository.

## How this file is used

- **Cadence:** Friday, 30 min (§3) — generate the candidate hero reports and log one action. During
  research Phase 2 (weeks 5–8) at least **one entry per week** is required, and gate **G2** at the
  end of Week 8 needs **four entries** plus a clear hero-workflow winner (§13).
- **The scope-change rule (§2) lives here.** Before starting any feature, write one sentence
  answering: _which current data-quality failure, user workflow, or hero-insight evidence does this
  feature improve?_ If there is no specific answer, it goes in [`backlog.md`](./backlog.md) instead
  of getting built.
- **The north-star metric counts a subset of these.** Only count an entry toward _useful decisions
  per active user per month_ when the last question is answered **"no"**, or when the evidence made
  the decision materially faster or more confident (§11).
- **Newest first.** Number entries `DEC-YYYY-NN` within the year.

## Entry template

```markdown
## DEC-YYYY-NN — <short decision>

- **Date / user / project:**
- **Question:**
- **Evidence reviewed:** report/session IDs, data range, confidence caveats
- **Finding:**
- **Action taken:**
- **Expected effect:**
- **Follow-up date:**
- **Observed result:**
- **Would I make this decision without 420AI?** yes / no / uncertain
```

---

## Entries

_None yet. The first entry is due in **Week 1**: §15 ("First seven days checklist") item 7 asks for
the log to be started with "the first question 420AI should answer."_
