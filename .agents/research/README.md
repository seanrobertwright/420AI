# `.agents/research/` — the research record

These are the **source-of-truth artifacts** required by
[`.agents/supplemental docs/research-analysis-plan.md`](../supplemental%20docs/research-analysis-plan.md)
§3. The research plan's Phase 0 says they must exist **before enrolling external users**; they were
created on **2026-08-02** by milestone slice **16.0**
([`.agents/plans/m16-dogfood-instrumentation.md`](../plans/m16-dogfood-instrumentation.md)).

This directory is the **evidence** half of the project. `.agents/plans/` records what we decided to
build; this records what actually happened when we used it, and it is the input to every phase gate
in research plan §13.

---

## THE PRIVACY RULE — read this before writing anything here

> **Do not put captured session content, secrets, access tokens, or personally identifying source
> data in these artifacts. Store only aggregate metrics, anonymized quotes with consent, and
> links/IDs to the participant's own archive where necessary.**
>
> — `research-analysis-plan.md` §3, verbatim.

This is not boilerplate, and it has three teeth worth stating plainly:

1. **This directory is committed to a public git repository.** Anything written here is published and
   is in the history permanently, even if a later commit deletes it. There is no "just for now".
2. **It is a guardrail metric, not a preference.** §5.3 lists _"zero known plaintext secret leakage in
   logs, reports, repository artifacts, or external exports"_ as a guardrail — a leak here is a
   recorded failure of the research period itself, not a tidiness problem.
3. **The product's whole thesis is that your work history does not leave your machine.** An artifact
   in this directory that quotes a captured session contradicts the claim
   [`docs/guide/data-boundary.md`](../../docs/guide/data-boundary.md) makes to design partners.

**Write an ID, not the thing.** A session id, a report artifact id, an event fingerprint, a git SHA,
a `P-01` participant code — all of these point into the archive without copying anything out of it.
Every file below that holds observations restates this rule in its own header.

---

## What is here

| File                                  | Purpose (§3)                                                            | Cadence                       |
| ------------------------------------- | ----------------------------------------------------------------------- | ----------------------------- |
| [`weekly/`](./weekly/)                | Weekly scorecard — capture coverage, quality, use, incidents, decisions | Monday, 30 min (§3)           |
| [`weekly/TEMPLATE.md`](./weekly/TEMPLATE.md) | The §10 scorecard template — copy to `YYYY-WW.md`                | —                             |
| [`decisions.md`](./decisions.md)      | Decision log: evidence → action → expected result → follow-up           | Friday, 30 min (§3); ≥1/week in Phase 2 |
| [`experiments.md`](./experiments.md)  | Experiment register: hypothesis, cohort, metric, result, decision       | Per meaningful change         |
| [`participants.md`](./participants.md) | Participant registry: consent, tools, environment, trial dates, support | On enrolment (Phase 3+)       |
| [`interviews/`](./interviews/)        | Interview notes, `<participant>-YYYY-MM-DD.md`                          | Every 2 weeks, 45 min (§3)    |
| [`backlog.md`](./backlog.md)          | Research backlog — observations ranked by evidence                      | Wednesday triage, 30 min (§3) |
| [`incidents.md`](./incidents.md)      | Incident log — every capture/data-quality failure, categorized per §4.4 | As they happen                |

`weekly/` is empty until the first Monday. `interviews/` is empty until Phase 3 and holds a
`.gitkeep` so git tracks the directory. `participants.md` ships with **headers and zero rows** on
purpose — see its own note.

## How these connect to the rest of the repo

- **The scope-change rule (§2) runs through `decisions.md`.** Before starting any feature, one
  sentence there answers _"which current data-quality failure, user workflow, or hero-insight
  evidence does this improve?"_ No answer → it goes in `backlog.md` instead of getting built.
- **`incidents.md` is what earns a fix.** D-16.0-2: measured friction is not fixed on sight; it
  becomes an incident entry and earns a slice with evidence attached.
- **The metrics these files record are defined in §5**, not here. Do not invent a metric — if a
  number is worth tracking weekly it belongs in §5.1/§5.2 first.
- **`.agents/plans/` and `.agents/execution-reports/` remain the build record.** This directory never
  duplicates them; it links to them.
