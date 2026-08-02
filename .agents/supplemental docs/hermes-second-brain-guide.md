# Using Hermes as 420AI's Research Second Brain

**Audience:** Sean, running Hermes Agent locally on Windows  
**Validated against:** Hermes Agent `v0.19.0` on this machine, 2026-08-02  
**Purpose:** create a small set of Hermes skills and scheduled jobs that make the 420AI dogfooding/research plan happen consistently.

## 1. The intended split of responsibilities

Hermes should be the research coach and operating rhythm. 420AI remains the system that captures, archives, calculates, and exposes evidence about AI-assisted engineering work.

```text
AI coding tools → 420AI collector → archive + projections + reports
                                           ↓
                              redacted, aggregate research summary
                                           ↓
                                  Hermes research-coach skill
                                           ↓
                  daily reflection · weekly draft · monthly decision gate
                                           ↓
              .agents/research/ notes, decision log, and approved actions
```

Do **not** make Hermes the source of truth for session data, cost, Git outcomes, or capture health. Do **not** let it invent those facts from memory. Hermes is allowed to summarize, ask questions, identify uncertainty, and draft Markdown from a prepared evidence bundle.

## 2. Safety and privacy rules

The first version should be intentionally narrow.

1. Hermes reads aggregate, redacted 420AI summaries, not decrypted raw transcripts, secrets, tool arguments, or entire database tables.
2. Hermes writes only Markdown under `.agents/research/` unless you explicitly approve a broader capability later.
3. Hermes must never commit code, modify the database, alter collector configuration, send external messages, or create cron jobs on its own.
4. Every conclusion must identify the evidence range and any missing-data caveat.
5. Hermes may propose an action, but only you may mark a decision as accepted or completed.
6. Do not commit generated reports that contain session content, credentials, personal data, or provider account information. Prefer a local ignored directory for generated evidence bundles.

This separation matters because 420AI is proving whether its data can be trusted. A fluent Hermes summary cannot repair incomplete capture, bad attribution, or uncertain cost data.

## 3. What to create

Start with **one skill** and three scheduled uses of it. Do not create several overlapping skills yet.

| Item | Name | Purpose | Build now? |
|---|---|---|---|
| Hermes skill | `420ai-research-coach` | Reads the prepared research summary, asks for reflection, and writes structured drafts | Yes |
| Deterministic summary generator | `scripts/generate-research-summary.mjs` | Queries/exports aggregate 420AI evidence into a fixed local format | Later, after defining the hero report |
| Daily job | `420ai-daily-checkin` | Prompts for one meaningful outcome or friction | Yes, after manual testing |
| Weekly job | `420ai-weekly-review` | Produces a research draft and asks for one next action | Yes, after manual testing |
| Monthly job | `420ai-monthly-gate` | Evaluates the current 4–6 month phase gate | Yes, after two successful weekly reviews |

Use one skill because each job shares the same data boundary, writing rules, and decision vocabulary. Split it later only if a specialized job develops a materially different workflow.

## 4. Pre-flight

The following was verified on this machine:

- Hermes CLI is installed at `C:\Users\seanr\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe`.
- `hermes --version` reports `v0.19.0`.
- The Hermes gateway is running, so scheduled cron jobs can execute.
- Existing cron jobs already deliver to Telegram. Reuse your existing delivery target; do not put its numeric chat ID in this repository.
- User-local Hermes skills live under `C:\Users\seanr\.hermes\skills\`.

Before proceeding, create the local research directories. These are project artifacts, but their generated evidence should be ignored by Git until you deliberately choose what to commit.

```powershell
New-Item -ItemType Directory -Force `
  '.agents\research', `
  '.agents\research\weekly', `
  '.agents\research\interviews', `
  '.agents\research\generated' | Out-Null
```

Recommended repository-ignore entry:

```gitignore
# Local, generated 420AI research evidence. Do not commit raw or sensitive summaries.
.agents/research/generated/
```

Keep hand-authored templates, anonymized scorecards, and the decision log versioned if useful. Keep raw exports and Hermes-generated evidence bundles local.

## 5. Define the research-summary contract before automation

Hermes needs one concise file to read. It should not scrape the dashboard, guess data from Git history, or search a database ad hoc.

Create this local input file first:

```text
.agents/research/generated/current-summary.md
```

For the first two weeks, write it manually from the relevant 420AI reports. That forces the evidence format to earn its place before you automate it.

Use this structure:

```markdown
# 420AI Research Summary

## Window

- Start: 2026-08-03T00:00:00-04:00
- End: 2026-08-03T23:59:59-04:00
- Generated at: 2026-08-03T18:00:00-04:00
- Data confidence: provisional

## Capture health

| Measure | Value | Caveat |
|---|---:|---|
| Captured sessions | 5 | Claude Code + Codex only |
| Sessions with project mapping | 5 / 5 | Manual mapping checked |
| Sessions with usable model/token data | 4 / 5 | One connector omitted token field |
| Stale or unhealthy connectors | 0 | — |
| Parse/sync failures | 0 | — |

## Activity by project/tool

| Project | Tool/model | Sessions | Tokens | Estimated cost | Confidence |
|---|---|---:|---:|---:|---|

## Notable evidence

- `report:<id>` — concise factual observation with date range and confidence.
- `session:<id>` — concise factual observation; do not include raw prompt or transcript text.

## Known gaps

- State what is unknown. Do not treat absence as zero.

## Open decisions and prior follow-ups

- `DEC-YYYY-NN`: action, expected effect, follow-up date, status.
```

### Required properties

- A time range and generated timestamp are always present.
- Every numeric claim has an explicit source/caveat.
- Session identifiers may be included, but raw session contents may not.
- “No data” means unknown unless the capture-health section establishes coverage.
- Summary size should be less than about 8 KB. Hermes needs a decision brief, not the archive.

### When to automate it

After two weeks of manual summaries, implement a deterministic script that writes the same shape. Its eventual contract should be:

```powershell
node scripts/generate-research-summary.mjs --from 2026-08-03 --to 2026-08-09 `
  --output .agents/research/generated/current-summary.md
```

The script should query 420AI/report APIs or a safe aggregate export, not use an LLM. Unit test it with known fixtures. Hermes comes after this script, not before it.

## 6. Create the user-local Hermes skill

Create this directory outside the repository. It is a personal operating skill, so it belongs in the Hermes user-local tree instead of `420AI` source code.

```powershell
New-Item -ItemType Directory -Force `
  "$env:USERPROFILE\.hermes\skills\420ai-research-coach" | Out-Null
```

Then create:

```text
C:\Users\seanr\.hermes\skills\420ai-research-coach\SKILL.md
```

Paste the following initial version. It is deliberately conservative.

````markdown
---
name: 420ai-research-coach
description: Use when reviewing 420AI dogfooding evidence, prompting a daily outcome reflection, drafting a weekly research review, or evaluating a monthly research gate. Read only the aggregate research summary and write only approved Markdown research artifacts.
version: 0.1.0
author: Sean Wright
license: MIT
metadata:
  hermes:
    tags: [420ai, research, second-brain, dogfooding, reporting]
    related_skills: [hermes-agent]
---

# 420AI Research Coach

## Overview

Help Sean run a disciplined personal research loop for 420AI. 420AI is the evidence system; this skill is the reflection, synthesis, and follow-through layer.

Use only these inputs:

- `.agents/research/generated/current-summary.md`
- `.agents/research/decisions.md`, if it exists
- `.agents/research/weekly/`, for prior weekly reviews

Write only Markdown under `.agents/research/`. Do not read raw session exports, decrypted transcripts, secrets, `.env` files, database credentials, or provider account information.

## Non-Negotiable Rules

1. Treat the research summary as evidence and its known gaps as binding.
2. Never convert missing data into zero, success, failure, or causal proof.
3. Every factual conclusion must name the applicable time window and confidence/caveat.
4. Never modify source code, Git state, database rows, Hermes configuration, connector settings, or cron jobs.
5. Never send external messages. Return a draft for Sean to approve.
6. Keep raw prompts, session text, tool arguments, command output, and secrets out of all output.
7. End every review with exactly one recommended next action. It may be “repair data quality first.”

## Daily Check-In

Use when asked for a daily 420AI reflection.

1. Read `current-summary.md`. If it is missing, state that no evidence bundle is available and ask Sean to generate it. Stop.
2. State capture health in one sentence, including a caveat if data is provisional or incomplete.
3. Ask at most three short questions:
   - Which session/task was most meaningful today?
   - What was its outcome: shipped, useful_partial, blocked, abandoned, or incorrect?
   - Was the main friction context, model/tool, tool failure, unclear task, verification, non-AI, or none?
4. If Sean provides answers, draft an append-only `DEC-` or daily-note entry. Do not claim it is accepted until Sean explicitly confirms it.
5. Keep the total reply under 180 words.

Completion criterion: Sean receives a concise prompt grounded in today’s data, or a clear explanation of why no prompt can be grounded.

## Weekly Review

Use when asked to produce the weekly 420AI research review.

1. Read the current summary, decision log, and most recent weekly review if available.
2. Draft `.agents/research/weekly/YYYY-WW.md` using this exact outline:
   - Window and data confidence
   - Capture health
   - What changed in AI-assisted work
   - Outcomes and friction, using only confirmed labels
   - Evidence worth investigating
   - Follow-up on prior decisions
   - One recommended action for next week
   - Known gaps / what not to conclude
3. Separate facts, interpretations, and proposed action into distinct bullets.
4. Include source report/session IDs when they exist in the summary, but never raw content.
5. Do not overwrite a prior weekly report. If one exists for the same week, write a `-draft-2` file and explain why.

Completion criterion: the draft has a stated evidence window, caveats, no unsupported causal claims, and one actionable recommendation.

## Monthly Gate

Use when asked to assess the current research phase.

1. Read the last four weekly reviews and decisions.
2. Answer these five questions with evidence:
   - Is capture trustworthy enough to act on?
   - Did 420AI change at least one real decision this month?
   - Which report or workflow produced the most action?
   - What blocked trust or repeat use?
   - What is the single highest-value focus for next month?
3. Recommend one of: continue, repair reliability, narrow the workflow, or pause expansion.
4. Write a dated draft under `.agents/research/monthly/` only after the directory exists. Otherwise return the draft in chat and ask before creating a new category.

Completion criterion: the recommendation is explicit, evidence-linked, and does not confuse product activity with product value.

## Common Pitfalls

1. **Dashboard prose treated as truth.** Use numeric/source evidence and retain caveats.
2. **False productivity claims.** A Git commit near a session is correlation unless the user confirms the outcome.
3. **Overlong reports.** A weekly review must lead to one action, not reproduce the archive.
4. **Sensitive detail leakage.** Refer to IDs and aggregate observations, never raw session text.
5. **Automated busywork.** If no meaningful activity or summary exists, send a short “no evidence to review” message rather than inventing a report.

## Verification Checklist

- [ ] Read only the permitted aggregate/research files.
- [ ] Evidence window and data confidence are named.
- [ ] Missing data is stated rather than guessed.
- [ ] No raw session content or secrets appear in output.
- [ ] Exactly one recommended next action is present.
- [ ] No source-code, database, Git, configuration, cron, or external-message action was taken.
````

### Validate the skill

The installed Hermes tooling expects `SKILL.md` frontmatter that begins at byte zero, has `name` and `description`, and has a non-empty body. Check the file before testing it:

```powershell
$skill = "$env:USERPROFILE\.hermes\skills\420ai-research-coach\SKILL.md"
$content = Get-Content -Raw $skill
if (-not $content.StartsWith('---')) { throw 'SKILL.md must begin with --- at byte zero.' }
if ($content.Length -gt 100000) { throw 'SKILL.md exceeds the 100,000-character limit.' }
if ($content -notmatch '(?s)^---\r?\n.*?\r?\n---\r?\n.+') { throw 'Frontmatter or body is malformed.' }
Write-Host 'Basic skill structure looks valid.'
```

Start a new Hermes process when testing. Skills are loaded per invocation/session.

```powershell
hermes --skills 420ai-research-coach -z `
  'Run the daily 420AI check-in. Read only the allowed research files. Do not write anything yet.'
```

The expected result is either a concise, evidence-grounded check-in or a clear statement that `current-summary.md` is missing. It must not read `.env`, session exports, or unrelated repository files.

## 7. Create the initial research files

Create a blank decision log before the first daily prompt:

```markdown
# 420AI Decision Log

<!-- Hermes may draft entries; Sean confirms acceptance and follow-up results. -->
```

Save it as:

```text
.agents/research/decisions.md
```

When Hermes drafts an entry, use this format:

```markdown
## DEC-2026-001 — <short decision>

- **Date / project:**
- **Question:**
- **Evidence reviewed:** report/session IDs, time range, confidence caveats
- **Finding:**
- **Proposed action:**
- **Accepted by Sean:** yes / no / pending
- **Expected effect:**
- **Follow-up date:**
- **Observed result:**
- **Would I make this decision without 420AI?** yes / no / uncertain
```

Do not count a proposed action as a useful decision until “Accepted by Sean” is `yes` and it is grounded in the evidence bundle.

## 8. Test manually before scheduling

Do not begin with automation. Complete this sequence first.

1. Add a real, small `current-summary.md` from one day of personal 420AI activity.
2. Run the skill manually with the daily prompt above.
3. Check that Hermes respects the input/output boundary.
4. Ask Hermes for a weekly review draft, but tell it to return the draft in chat first.
5. Inspect the output for unsupported claims, sensitive text, and excessive verbosity.
6. Improve the skill prompt or evidence bundle if necessary.
7. Only then allow it to write the weekly file.

Manual weekly test:

```powershell
hermes --skills 420ai-research-coach -z `
  'Draft this week''s 420AI review from the permitted files. Return it in chat only; do not write files.'
```

Pass criteria:

- The report names its window and data confidence.
- It lists missing data instead of guessing.
- It contains no raw session content.
- It proposes exactly one next action.
- The action is either data-quality repair or a specific change supported by the evidence.

## 9. Schedule the jobs

Hermes on this machine supports `hermes cron create`, a `--skill` attachment, an absolute `--workdir`, and a `--deliver` target. Your existing jobs show the correct delivery form for your setup. Substitute your own target; do not commit it to this repository.

Set variables in the PowerShell session first:

```powershell
$projectRoot = 'C:\Users\seanr\OneDrive\Documents\420AI'
$deliveryTarget = 'telegram:<your-existing-chat-id>'
```

### 9.1 Daily reflection, weekdays at 6:10 PM

Create this only after the manual daily test passes:

```powershell
hermes cron create '10 18 * * 1-5' `
  --name '420AI daily research check-in' `
  --deliver $deliveryTarget `
  --skill 420ai-research-coach `
  --workdir $projectRoot `
  'Run the Daily Check-In. Read only the permitted aggregate research files. If today has no meaningful captured activity or the evidence bundle is missing, send a short explanation and do not invent an outcome. Do not write files or change any configuration.'
```

### 9.2 Weekly review draft, Friday at 6:30 PM

Create this only after the manual weekly test passes:

```powershell
hermes cron create '30 18 * * 5' `
  --name '420AI weekly research review' `
  --deliver $deliveryTarget `
  --skill 420ai-research-coach `
  --workdir $projectRoot `
  'Run the Weekly Review. Draft the review from the permitted research files. Write a new Markdown draft under .agents/research/weekly only if a current evidence bundle exists. Never overwrite an existing review. Send a concise summary and the one recommended action for Sean to approve.'
```

### 9.3 Monthly gate, first day of each month at 9:15 AM

Wait until Hermes has produced at least two trustworthy weekly reviews:

```powershell
hermes cron create '15 9 1 * *' `
  --name '420AI monthly research gate' `
  --deliver $deliveryTarget `
  --skill 420ai-research-coach `
  --workdir $projectRoot `
  'Run the Monthly Gate using the last four weekly reviews and the decision log. Return an evidence-backed recommendation: continue, repair reliability, narrow the workflow, or pause expansion. Do not create a new directory or write a monthly file unless Sean has already approved that artifact structure.'
```

### 9.4 Verify scheduled jobs

```powershell
hermes cron list
hermes cron status
```

Inspect execution history after each first scheduled run:

```powershell
hermes cron runs <job-id>
```

If a job needs changing, use `hermes cron edit <job-id>` rather than creating duplicates. Pause a job when investigating unexpected behavior:

```powershell
hermes cron pause <job-id>
```

## 10. Add the deterministic summary generator later

The first automation worth coding is the evidence-bundle generator, not more Hermes behavior.

Suggested implementation sequence:

1. Identify the existing 420AI API/repository queries needed for the selected hero report.
2. Add a script at `scripts/generate-research-summary.mjs` that produces the Section 5 contract.
3. Require an explicit `--from`, `--to`, and `--output` for testability and to prevent accidental broad export.
4. Ensure the script emits aggregate fields, IDs, source metadata, and caveats only.
5. Add fixture-based unit tests for complete data, missing tokens, unknown mapping, stale connector, and zero-activity windows.
6. Run the script on a schedule *before* the Hermes daily/weekly jobs. Use a no-agent Hermes cron script only if it is safe and deterministic.
7. Have the Hermes jobs refuse to proceed when the summary is stale or absent.

Do not ask Hermes to calculate cost, infer parse success, or decide project attribution. Those belong in 420AI’s deterministic domain.

## 11. Maintenance rules

Review this skill every two weeks during the research period.

- Remove instructions that do not change Hermes behavior.
- Add a rule only after a concrete failure occurs.
- Keep the skill focused on research reflection, not repository implementation.
- Update the template when the hero workflow is selected.
- If an output is consistently useful, promote its format into a deterministic 420AI report or dashboard feature.
- If an output is consistently ignored, delete the job before improving its prose.

## 12. Completion checklist

- [ ] `.agents/research/` and its local generated-evidence directory exist.
- [ ] Generated evidence is ignored by Git or reviewed before commit.
- [ ] `current-summary.md` has been written manually for at least one real workday.
- [ ] User-local `420ai-research-coach` skill exists under `~/.hermes/skills/`.
- [ ] The manual daily test passed its input/output and privacy checks.
- [ ] The manual weekly test passed its evidence/caveat/action checks.
- [ ] The daily and weekly cron jobs exist once each and have been observed to execute.
- [ ] Hermes has no direct access path to raw exports, `.env`, database credentials, or source-code mutation in this workflow.
- [ ] At least one accepted `DEC-` entry links a 420AI finding to a real action.
- [ ] The monthly gate is not scheduled until two useful weekly reviews exist.

Once this checklist is complete, Hermes will be doing the right job: keeping you in a weekly evidence-and-decision loop while 420AI demonstrates whether it deserves to become a product.
