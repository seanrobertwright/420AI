# 420AI Research and Analysis Execution Plan

**Horizon:** 24 weeks (4–6 months)  
**Primary objective:** prove that 420AI helps AI-heavy developers make repeatable, better engineering decisions from their real AI-assisted work.  
**North-star metric:** useful decisions per active user per month (target: at least 2).  
**Plan owner:** Sean  
**Status:** proposed

## 1. The thesis to test

420AI should be a private, cross-tool flight recorder for AI-assisted engineering. It captures work from local AI coding tools, preserves the evidence, maps it to projects and outcomes, and answers questions that vendor-specific dashboards cannot.

The thesis is **not** that developers need another token dashboard. The thesis is that an AI-heavy developer can use trustworthy historical evidence to change a tool, model, workflow, context rule, or project practice for the better.

The product is worth pursuing if, within 24 weeks:

- Sean uses it continuously on real work and can point to at least 8 documented decisions it changed.
- At least 3 external design partners generate trustworthy data for four consecutive weeks.
- At least 2 design partners independently report a decision they made because of 420AI.
- One report or workflow is consistently requested, used, and understood more than the rest.

The product needs narrowing or repositioning if it produces activity charts but no decisions, cannot collect trustworthy data with low maintenance, or cannot distinguish itself from vendor dashboards and basic spend trackers.

## 2. Product focus and scope guardrails

### The job to be done

> When I use several AI coding tools across projects, help me understand which workflows create useful engineering outcomes, where time/cost/context is wasted, and what to change next, without sending my work history to a third party.

### Primary early user

A privacy-conscious developer who:

- uses AI coding tools several times a week, preferably more than one tool;
- works in real repositories with Git history;
- pays for, or faces limits on, one or more tools/models;
- wants retrospective evidence, not just live quota information; and
- is willing to run a self-hosted service during a design-partner trial.

### Explicitly in scope for this period

- Reliable capture and attribution for tools the participant actually uses.
- Data-quality visibility and recovery.
- A lightweight outcome-labeling loop.
- One high-value analysis/report workflow, selected from evidence.
- Design-partner onboarding, support, and research interviews.
- Privacy, consent, retention, and export expectations that match a self-hosted product.

### Explicitly out of scope unless it unblocks the above

- New connector breadth for tools no active participant uses.
- General AI chat capture.
- Enterprise sales features, broad RBAC/SSO expansion, billing, or cloud hosting.
- New dashboard sections that do not improve capture quality or the selected hero insight.
- Automated “AI recommendations” that cannot explain their evidence or confidence.

### Scope-change rule

Before starting any feature, write one sentence in the weekly decision log:

> Which current data-quality failure, user workflow, or hero-insight evidence does this feature improve?

If there is no specific answer, place the item in the backlog rather than building it.

## 3. Operating model

### Weekly cadence

| Day | Ritual | Output | Timebox |
|---|---|---|---:|
| Daily | Verify capture status; resolve obvious collector/ingest failures | Healthy capture or incident note | 5 min |
| End of each meaningful work session | Add lightweight outcome label | Task/outcome ground truth | 15 sec |
| Monday | Review last week’s capture and data-quality metrics | Weekly scorecard | 30 min |
| Wednesday | Triage product observations and participant support | Prioritized issue list | 30 min |
| Friday | Generate the candidate hero reports and log one action | Decision log entry | 30 min |
| Every 2 weeks | Interview one participant or review recordings/feedback | Research note and backlog updates | 45 min |
| Monthly | Evaluate the phase gate below | Continue, narrow, or stop decision | 60 min |

### Source-of-truth artifacts

Create these records before enrolling external users:

| Artifact | Location | Purpose |
|---|---|---|
| Weekly scorecard | `.agents/research/weekly/YYYY-WW.md` | Capture coverage, quality, use, incidents, and decisions |
| Decision log | `.agents/research/decisions.md` | Evidence → action → expected result → follow-up |
| Participant registry | `.agents/research/participants.md` | Consent, tools, environment, trial dates, support status |
| Interview notes | `.agents/research/interviews/<participant>-YYYY-MM-DD.md` | Direct user language and pain points |
| Research backlog | GitHub issues or `.agents/research/backlog.md` | Observations ranked by evidence |
| Experiment register | `.agents/research/experiments.md` | Hypothesis, cohort, metric, result, decision |

Do not put captured session content, secrets, access tokens, or personally identifying source data in the repository artifacts above. Store only aggregate metrics, anonymized quotes with consent, and links/IDs to the participant’s own archive where necessary.

## 4. Data-generation plan

### 4.1 Use natural work, not synthetic product telemetry

The core research dataset must come from normal development work: feature work, debugging, refactors, tests, incidents, and investigations. Synthetic fixtures remain valuable for parser and regression tests, but must never be used as evidence that the product works for users.

The initial personal target is **20 captured sessions per week**. The target is not a quota to game; it is a signal that the collector is running during enough authentic work to reveal reliability and workflow patterns.

### 4.2 Capture automatically

For every session that a connector supports, preserve or derive:

- Connector and tool version.
- Machine, workspace, repository, project, branch, and timestamp.
- Tool-native session identifier and durable fingerprint.
- Model and reported/estimated token fields.
- Reported/estimated cost, price source, and cost-confidence label.
- Event and tool-call type, status, duration where available, and failure classification.
- Raw-source reference and parser version.
- Queue/sync state and connector health markers.
- Git commits and available repository metadata near the session.

The existing architecture is designed for this: the collector’s capture engine, durable queue, connector registry, ingest API, raw records, normalized events, reports, and replay flows should remain the canonical path. Do not add a parallel analytics-only store.

### 4.3 Add minimum human ground truth

Automatic events cannot reliably answer whether the work was useful. Add a voluntary, editable end-of-session label that takes less than 15 seconds.

Required fields:

| Field | Values | Why it exists |
|---|---|---|
| `task_type` | feature, bug_fix, investigation, refactor, test, documentation, incident, other | Enables meaningful comparisons |
| `intent` | Short free text, max 200 characters | Captures what success meant before hindsight |
| `outcome` | shipped, useful_partial, blocked, abandoned, incorrect | Separates activity from result |
| `quality_rating` | 1–5 | Fast user judgment of usefulness |
| `primary_friction` | none, context, model/tool, tool_failure, unclear_task, verification, non_ai | Makes failure modes actionable |
| `follow_up_commit_or_pr` | optional Git SHA/URL/ID | Improves outcome attribution |

Rules:

- Offer “skip” and do not nag repeatedly.
- Make every label editable later.
- Make clear that labels are private to the user’s archive.
- Use neutral wording. Do not imply a low rating is user failure.
- Never infer a human outcome from token count or a commit alone without marking confidence.

### 4.4 Gather external ground truth

Each week, capture enough independent truth to audit metrics:

- Provider invoices, usage exports, or account spend snapshots when available.
- Git commits, PRs, code-review outcomes, and issue closures where practical.
- A weekly self-assessment: did the analysis change a real workflow?

For a sample of ten sessions per month, reconcile:

1. tool-native session exists;
2. 420AI raw record exists;
3. normalized event and token data are plausible;
4. project/workspace attribution is correct;
5. reported or estimated cost is explained by its confidence label; and
6. the session is visible in the chosen report/search surface.

Log every mismatch. Categorize it as capture, parser, attribution, pricing, projection, UX, or user-understanding failure.

## 5. Metrics and definitions

### 5.1 Data-quality metrics

| Metric | Formula | Target by end of Month 1 |
|---|---|---:|
| Capture coverage | captured sessions ÷ observed tool-native sessions in audit sample | ≥95% |
| Project attribution | sessions with correct project/workspace ÷ captured sessions | ≥90% |
| Token completeness | sessions with usable model + token data ÷ captured sessions for eligible connectors | ≥95% |
| Parse success | successfully normalized raw records ÷ captured raw records | ≥99% |
| Duplicate rate | duplicate event fingerprints ÷ ingested events | <1% |
| Sync freshness | sessions visible in archive within agreed connector liveness window | ≥95% |
| Recoverability | sampled raw records reparse successfully with expected output | 100% of monthly sample |

Record unknown values explicitly. Do not substitute zero for absent data.

### 5.2 User-value metrics

| Metric | Definition | Target by Month 6 |
|---|---|---:|
| Active user | User with at least 4 captured workdays in a calendar month | Track, not optimize prematurely |
| Time to first capture | Setup start to first verified captured session | <30 min for supported setup |
| Time to first insight | Setup start to user-confirmed useful finding | <7 days |
| Useful decision | A user records a change they made because of 420AI evidence | ≥2 per active user/month |
| Decision follow-through | Useful decisions with a documented later result ÷ useful decisions | ≥60% |
| Weekly return | Active users who open/review data in consecutive weeks | ≥60% in design-partner cohort |
| Trust score | 1–5 answer to “I trust this enough to act on it” | ≥4 average |

### 5.3 Guardrail metrics

- Zero known plaintext secret leakage in logs, reports, repository artifacts, or external exports.
- Zero unconsented collection from a design partner.
- No recommendation presented without its source metrics, data range, and confidence caveat.
- No unresolved high-severity capture/data-loss incident for more than one week.

## 6. 24-week execution roadmap

## Phase 0 — Prepare the research system (Week 1)

**Outcome:** one owner, one environment, clear records, and a frozen product focus.

1. Create the research artifact folders listed in Section 3.
2. Write the first weekly scorecard template and decision-log template.
3. Merge or explicitly park currently in-progress platform/security work; start the research period from a clean, deployable baseline.
4. Deploy one personal archive, API, dashboard, and collector using the documented installation path.
5. Select the actual tools and repositories to observe. Do not activate connectors for tools you do not use.
6. Configure a backup and restore drill for the archive before it accumulates valuable history.
7. Document local data boundaries: what is captured, encrypted, searchable, exported, and deleted.
8. Set an initial feature freeze: only capture reliability, attribution, labeling, and report usability work may enter the next four weeks.

**Exit criteria:** an end-to-end personal capture is visible in the dashboard and replayable from raw data; the scorecard and decision log exist; the data boundary is written down.

## Phase 1 — Personal reliability baseline (Weeks 2–4)

**Outcome:** 420AI runs during normal work without manual babysitting.

1. Use the collector every workday across at least two real repositories.
2. Capture at least 20 authentic sessions per week.
3. Run the ten-session audit each week for the first three weeks, then consolidate it monthly once stable.
4. Record every collection incident in the weekly scorecard:
   - missed session;
   - stale sync;
   - parsing failure;
   - bad project mapping;
   - cost/token discrepancy;
   - dashboard/search/report discrepancy.
5. Fix the highest-frequency or highest-severity failure first. Add a regression test and fixture for each fixed parser/capture failure.
6. Manually add outcome labels to at least 70% of meaningful personal sessions, then identify where labeling is too burdensome.
7. Generate every current report weekly, but do not enhance all of them. Record which one changes thinking or triggers a question.

**Implementation focus:** collector health/readiness, connector error messages, ingest idempotency, project/workspace mapping, report correctness, and the smallest labeling surface.

**Exit criteria:** capture coverage ≥95% in the audit sample, project attribution ≥90%, no known unrecoverable data-loss path, and one documented decision made from personal data.

## Phase 2 — Find and validate the hero insight (Weeks 5–8)

**Outcome:** choose one report/workflow based on evidence of usefulness.

1. Review personal data every Friday using the same questions:
   1. What cost, time, or context pattern changed?
   2. Which sessions produced a useful outcome?
   3. Which failures were preventable?
   4. What will I change next week?
2. Create at least one decision-log entry per week. Each entry must include:
   - the evidence viewed;
   - the action chosen;
   - the expected result;
   - a follow-up date; and
   - the later result, if known.
3. Compare candidate hero workflows:
   - session autopsy;
   - cost-to-outcome by project/task;
   - context waste and recommended context rules;
   - tool/model/workflow comparison;
   - recurring tool-call failure analysis.
4. Score each candidate 1–5 for frequency of use, clarity, actionability, data confidence, and unique value versus vendor dashboards.
5. Select only one winner. Keep the runner-up as a deferred hypothesis.
6. Define the selected workflow’s exact promise in user language, for example:

   > “Show me why this expensive or failed AI-assisted work session happened and the one thing I should change before doing similar work again.”

7. Improve only the evidence chain for this workflow: data completeness, explanation, caveats, drill-down, and recommendation framing.

**Exit criteria:** at least four personal decision-log entries, one hero workflow selected with a written rationale, and one before/after workflow change that can be checked after two weeks.

## Phase 3 — Design-partner readiness (Weeks 9–10)

**Outcome:** a supported, ethical, repeatable trial package.

1. Write a one-page design-partner invitation that states:
   - 420AI is self-hosted and early;
   - what data it captures and does not capture;
   - what the participant must run/provide;
   - the expected four-week commitment;
   - how to stop, export, and delete/archive their data;
   - that feature requests are not promises.
2. Create a consent checklist and a support runbook.
3. Create an onboarding checklist with explicit verification steps:
   - archive reachable;
   - collector paired;
   - approved connector enabled;
   - first session captured;
   - project mapped;
   - first report generated;
   - participant understands confidence and privacy boundaries.
4. Add product instrumentation only for privacy-safe aggregate research metrics: setup milestones, connector health, report generation, and optional feedback. Do not transmit source/session content to a central research service.
5. Complete a clean-room onboarding yourself from fresh credentials and document every step that takes more than five minutes or needs founder intervention.
6. Recruit 3–5 people who use at least two AI coding tools or one tool heavily and are willing to discuss their workflow. Prefer diversity in tool usage over a large cohort.

**Exit criteria:** a participant can reach a verified first capture with the written guide; consent, support, and offboarding are documented; at least three suitable participants are scheduled.

## Phase 4 — Four-week design-partner trial (Weeks 11–14)

**Outcome:** real external evidence of trust and actionability.

1. Onboard participants one at a time. Do not batch unresolved setup problems across the cohort.
2. Hold a 20-minute setup call or observe first-run setup with consent.
3. Confirm data quality after the first day and first week using a compact audit.
4. Ask each participant to use the outcome label on meaningful work, with skip always allowed.
5. Send a weekly, non-leading check-in:
   - Did you review 420AI this week?
   - Did it reveal anything you did not already know?
   - Did you change anything because of it?
   - What did you not trust or understand?
6. Run one 30-minute interview per participant during the trial. Ask for a concrete recent session and walk backward from their decision, not from a feature wishlist.
7. Fix only blockers to capture, trust, and the hero workflow. Log everything else in the research backlog.
8. At week four, conduct a closeout interview and ask the participant whether they would keep it running, why, and what they would miss if it disappeared.

**Exit criteria:** at least three participants completed four weeks or supplied an explicit failure reason; two or more participants can name a real decision influenced by 420AI; known data-quality gaps have severity and frequency estimates.

## Phase 5 — Synthesize evidence and narrow (Weeks 15–16)

**Outcome:** an evidence-backed product decision, not an accumulation of requests.

1. Synthesize decision logs, scorecards, interviews, and support issues.
2. Segment findings into:
   - proven pain;
   - desired but nonessential;
   - reliability blocker;
   - user-understanding problem;
   - unsupported assumption.
3. Write a one-page research readout answering:
   - Who got value?
   - What job did they hire 420AI for?
   - What exact evidence changed a decision?
   - Where did they not trust it?
   - What did they compare it against?
   - What would make them stop using it?
4. Pick a 90-day product wedge:
   - **Double down** if the hero workflow created repeatable decisions.
   - **Narrow** if one user/tool/workflow segment stands out.
   - **Repair reliability** if value exists but data trust is inadequate.
   - **Reposition** if the value is archival/forensics rather than optimization.
   - **Stop or pause** if neither Sean nor design partners changed behavior from the data.
5. Publish a “not building” list for the next quarter.

**Exit criteria:** a written wedge decision, a ranked backlog tied to evidence, and a committed list of deferred work.

## Phase 6 — Productize the proven loop (Weeks 17–24)

**Outcome:** a new suitable user can reach a trusted, actionable insight with little founder intervention.

1. Improve onboarding to reduce time to first verified capture below 30 minutes for the supported path.
2. Build data-quality confidence directly into the hero workflow:
   - connector/source coverage;
   - missing-data caveats;
   - cost confidence;
   - attribution confidence;
   - time range and sample size.
3. Build a weekly insight/digest flow around the hero workflow:
   - what changed;
   - evidence;
   - confidence;
   - suggested next action;
   - link to supporting sessions/report.
4. Add self-service diagnostics for the top three support incidents observed during the trial.
5. Make data export, retention, and removal understandable and tested.
6. Enroll a second small cohort only after the first cohort’s top capture and trust issues are resolved.
7. Repeat the four-week trial with the refined workflow.

**Exit criteria:** median time to first insight under seven days, at least 60% weekly return among active trial users, trust score ≥4/5, and useful decisions ≥2 per active user per month.

## 7. Implementation backlog, in priority order

This is intentionally a capability backlog, not a commitment to build every item.

### P0 — Required for truthful research

1. **Capture health scorecard**
   - Show connector enabled/disabled state, last successful event, sync freshness, queue depth, last error, parser version, and known permission gaps.
   - Source areas: `apps/collector/src`, `apps/ingest/src/routes/heartbeat.ts`, `apps/ingest/src/routes/monitor.ts`, dashboard monitor surfaces.
   - Acceptance: a user can distinguish “no work happened” from “capture is broken.”

2. **Outcome-label data model and lightweight UI**
   - Add a separately auditable label linked to a session/work session, not mutation of raw records.
   - Preserve author, timestamp, edits, and optional confidence.
   - Acceptance: label can be created, edited, skipped, exported, and deleted according to archive policy.

3. **Data-quality audit query/report**
   - Surface unmapped sessions, missing tokens, stale connectors, parser failures, and sample reconciliation status.
   - Acceptance: weekly scorecard values are queryable rather than manually guessed.

4. **Privacy-safe research artifacts and documentation**
   - Provide clear retention/export/delete and connector-permission documentation.
   - Acceptance: a design partner can make an informed decision before pairing a machine.

### P1 — Required for the hero insight

5. **Decision log links from a report/session**
   - Let the user record “I changed X because this evidence showed Y,” with a follow-up date.
   - Acceptance: a report or session can link to a decision without exposing raw contents externally.

6. **Hero workflow evidence panel**
   - Every conclusion shows its source sessions/metrics, time range, missing-data caveats, and confidence.
   - Acceptance: a user can challenge or verify a recommendation without trusting a black box.

7. **Git outcome confidence**
   - Separate confirmed linkage, heuristic linkage, and no linkage.
   - Acceptance: reports never imply causal productivity from a weak correlation.

### P2 — Build only after evidence supports it

8. Weekly digest and action queue.
9. Self-service repair flows for common connector/collector incidents.
10. The runner-up report from Phase 2.
11. Additional connectors used by active participants.
12. Broader multi-user and organization administration surfaces.

## 8. Research interview guide

Use open questions. Do not ask “would you use X?”

1. Tell me about the last time you felt an AI coding tool was expensive, slow, or unhelpful.
2. How do you currently decide which model/tool/workflow to use?
3. What evidence do you have today, and what is missing?
4. Walk me through one recent 420AI session/report. What did you trust? What did you ignore?
5. Did it cause a real action? What was it?
6. If it did not cause action, what was missing: relevance, confidence, clarity, timing, or control?
7. What data would you refuse to capture, even locally?
8. If 420AI disappeared tomorrow, what would you miss, if anything?

Document direct quotes separately from interpretation. A feature request is evidence of desire, not evidence that solving it creates value.

## 9. Experiment register template

Use one entry per meaningful product/research change.

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

Example:

> Hypothesis: showing attribution confidence beside a cost-to-outcome comparison will increase the number of conclusions users trust enough to act on, without increasing false certainty.

## 10. Weekly scorecard template

```markdown
# Week YYYY-WW

## Capture health

| Measure | This week | Target | Notes |
|---|---:|---:|---|
| Captured sessions | | 20+ | |
| Capture coverage (audit) | | 95% | |
| Correct project attribution | | 90% | |
| Token completeness | | 95% | |
| Parse success | | 99% | |
| Duplicate rate | | <1% | |
| Stale/unhealthy connectors | | 0 unresolved | |

## Value

- Reports reviewed:
- Useful insights:
- Decisions made because of 420AI:
- Follow-ups completed:
- Trust score / explanation:

## Incidents and data gaps

| Severity | Category | What happened | User impact | Root cause | Fix / owner | Regression test? |
|---|---|---|---|---|---|---|

## This week’s decision

- **Evidence:**
- **Action:**
- **Expected result:**
- **Check again on:**

## Next week’s single priority

```

## 11. Decision log template

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

Only count an entry toward the north-star metric when the user answers “no” or makes a materially faster/more-confident decision because of the evidence.

## 12. Risks and responses

| Risk | Early warning | Response |
|---|---|---|
| Capture is incomplete or vendor formats change | Audit gaps, stale connector, parser errors | Treat connector health as product surface; add fixtures/regression tests; show confidence instead of hiding gaps |
| The product becomes a dashboard with no action | Reports viewed but no decision logs | Narrow to the report that changes behavior; remove/defer passive metrics |
| Outcome attribution overclaims causality | Weak Git linkages presented as success | Label confidence; require manual confirmation for strong claims |
| Outcome labeling is too much work | Low completion or negative feedback | Reduce to one-click outcome plus optional detail; ask only at useful times |
| Privacy concerns block adoption | Participants hesitate at pairing | Be explicit about local data flow, encryption, exports, and offboarding; minimize central telemetry |
| Founder support does not scale | Every onboarding needs live debugging | Convert top incidents into diagnostics and guided repair before cohort two |
| Scope returns through “one small feature” requests | Backlog grows faster than decisions | Enforce the scope-change rule and monthly gate |
| Data does not support a differentiated insight | Findings duplicate vendor spend/usage views | Reposition toward archival/replay/forensics or stop adding product surface |

## 13. Monthly decision gates

| Gate | Date | Continue only if | If not true |
|---|---|---|---|
| G1: personal capture | End of Week 4 | Personal data is trustworthy and yields one decision | Repair capture before adding any new surface |
| G2: hero workflow | End of Week 8 | Four decision entries and a clear winner | Extend dogfood; do not recruit yet |
| G3: trial readiness | End of Week 10 | Onboarding, consent, and offboarding are testable | Fix setup/privacy documentation |
| G4: external value | End of Week 14 | Two participants name real decisions | Narrow or revise hero workflow |
| G5: wedge choice | End of Week 16 | Evidence identifies a segment and job | Pause expansion; conduct more discovery |
| G6: repeatability | End of Week 24 | New users reach trusted insight with limited support | Focus on activation/reliability, not growth |

## 14. Definition of success at Week 24

The research period is successful when all of these are true:

- 420AI has captured authentic work continuously enough to be trusted.
- Capture quality and missing data are visible to the user.
- At least one hero workflow gives an evidence-backed, understandable answer to a frequent user question.
- At least three external users have tried the product under clear consent/privacy terms.
- At least two users have documented actions they would not otherwise have taken.
- The next product investment is obvious because it is tied to observed behavior, not an imagined roadmap.

If these conditions are not met, the result is still valuable: it tells us whether the failure is data access, trust, onboarding, actionability, or market fit. Record that conclusion plainly and choose the smallest next experiment.

## 15. First seven days checklist

1. [ ] Create the research artifact folders and templates from Section 3.
2. [ ] Decide which in-progress platform work must be completed versus parked.
3. [ ] Bring up the personal archive, API, dashboard, and collector from a clean setup.
4. [ ] Enable only the connectors Sean actually uses this week.
5. [ ] Verify the first session from raw source through dashboard/report visibility.
6. [ ] Run the first ten-session audit, even if fewer than ten are available.
7. [ ] Start the decision log with the first question 420AI should answer.
8. [ ] Write a one-page local data boundary and retention note.
9. [ ] Schedule the first Monday scorecard review and Friday decision review.
10. [ ] Do not begin a new feature until it passes the scope-change rule.

