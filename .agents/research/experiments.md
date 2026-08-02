# Experiment register

One entry per meaningful product/research change. Required by
[`research-analysis-plan.md`](../supplemental%20docs/research-analysis-plan.md) §3; the entry format
below is its §9 template, verbatim.

> **PRIVACY RULE (§3).** No captured session content, secrets, access tokens, or personally
> identifying source data. Aggregate metrics, anonymized consented quotes, and links/IDs only.

## How this file is used

- An experiment is a change made **to find something out**, with a metric decided **before** the
  change. A change made because it is obviously right is not an experiment — it is just work, and it
  belongs in a slice plan.
- **Guardrails are not optional.** §5.3's guardrail metrics (zero plaintext secret leakage, zero
  unconsented collection, no recommendation without its source metrics/range/confidence, no
  unresolved high-severity data-loss incident beyond a week) apply to every experiment; name the ones
  this experiment could plausibly breach.
- **Write the observation window before the result.** A window chosen after seeing the data is not a
  window.

## Entry template

```markdown
## EXP-YYYY-NN — <short name>

- **Date / owner:**
- **Hypothesis:**
- **User segment:**
- **Change or intervention:**
- **Primary metric:**
- **Guardrails:**
- **Observation window:**
- **Result:**
- **Decision:** double down / iterate / defer / stop
- **Evidence links:** weekly scorecard, report IDs, interview notes, issues
```

Worked example of a hypothesis, from §9:

> Showing attribution confidence beside a cost-to-outcome comparison will increase the number of
> conclusions users trust enough to act on, without increasing false certainty.

---

## Entries

_None yet._
