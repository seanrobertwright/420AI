# Participant registry

Consent, tools, environment, trial dates and support status for design-partner participants.
Required by [`research-analysis-plan.md`](../supplemental%20docs/research-analysis-plan.md) §3.

> **PRIVACY RULE (§3) — this file holds records about REAL PEOPLE, in a PUBLIC repository.**
> No captured session content, secrets, access tokens, or personally identifying source data.
> **Aggregate metrics, anonymized quotes with consent, and links/IDs only.**
>
> Concretely, for this file: identify a participant by a **code** (`P-01`, `P-02`) and nothing else.
> No names, no email addresses, no employer, no repository names, no machine hostnames. Keep the
> mapping from code to person **outside this repository**. A participant who consented to a trial
> did not thereby consent to being listed publicly as a user of an early-stage product.

## Why this table is empty

**Headers only, zero rows — deliberately.** There is no example row and no placeholder participant,
because a template row containing a plausible fake name is exactly the kind of thing that later gets
mistaken for data — by a reader, by a script, or by a future maintainer counting participants.

The registry fills during research **Phase 3** (weeks 9–10), which requires a written invitation, a
consent checklist, a support runbook, and an onboarding checklist with explicit verification steps
before anyone is enrolled (§6 Phase 3). Gate **G3** at the end of Week 10 requires onboarding,
consent and offboarding to be **testable** (§13). Until then this file stays empty, and that is the
correct state, not an omission.

## Registry

| Code | Consent recorded | Tools used | Environment | Trial start | Trial end | Status | Support notes |
| ---- | ---------------- | ---------- | ----------- | ----------- | --------- | ------ | ------------- |

## Field notes

- **Consent recorded** — date, plus where the signed/acknowledged consent lives (outside this repo).
  §5.3 makes _zero unconsented collection_ a guardrail metric.
- **Tools used** — which AI coding tools, so cohort diversity is visible (§6 Phase 3 prefers
  diversity in tool usage over cohort size).
- **Environment** — OS and deployment shape only, at a granularity that does not identify the
  person or their employer.
- **Status** — `invited` / `onboarding` / `active` / `completed` / `withdrawn`. A withdrawal is data,
  not a failure; record the stated reason.
- **Offboarding** — how to stop, export, and delete/archive their data must be documented before
  enrolment (§6 Phase 3 step 1), and honoured on withdrawal.
