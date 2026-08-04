# M16 — Dogfood Instrumentation & Data Trust

> **Milestone definition** — the output of the 2026-08-02 deferral audit + scope conversation
> (the same process that produced M12, M13, M14 and M15). Conventions live in `CLAUDE.md`; this
> links, not re-pastes. Each slice below still goes through the build loop (`SUMMARY.md` §2) with
> its own `/lril:plan-feature` plan.
>
> **This milestone is the engineering half of
> [`.agents/supplemental docs/research-analysis-plan.md`](../supplemental%20docs/research-analysis-plan.md).**
> That document owns the research method, the metrics and the phase gates; this plan owns only the
> code and artifacts that make its measurements possible. Where the two disagree, the research plan
> wins on *what to measure* and this plan wins on *how it is built*.

M16 is the second V2 milestone promoted from the committed-but-unsequenced bucket (PRD §25,
committed 2026-07-21). It was chosen on the same stated criterion as M15 — _who the next milestone
is for_ — and this time the answer is different, and it is the whole reason the milestone exists:

**Sean alone, for a 24-week research period, on his own machine.**

Not a customer. Not a design partner (they arrive in research Phase 3, weeks 9–10). One operator
generating real evidence from real work, whose only requirement of the product is that the evidence
be **trustworthy**.

---

## Origin — the 2026-08-02 deferral audit

M15 closed on 2026-08-02 having built a tenancy foundation, four fixed roles, all four identity
paths, sessions, SSO, MFA and per-user API keys — for a deployment with **one install and one
human**. That was the correct call at the time (retrofitting `org_id` after customers exist is a
downtime migration on live data), and it is also the clearest possible signal about what to do next:
the product now has a great deal of *platform* and very little *evidence that it works*.

The audit asked one question of every open thread: **does this produce evidence, or does it produce
surface?** Findings:

- **A. The research plan already exists and is unstarted.**
  `.agents/supplemental docs/research-analysis-plan.md` defines a 24-week program with a Phase 0
  that must complete before any user is enrolled. None of its Phase 0 artifacts exist. Its §7 **P0**
  backlog — capture health scorecard, outcome labels, data-quality audit, privacy artifacts — is
  labelled *"required for truthful research"*, i.e. required before its own measurements mean
  anything. → **the spine of this milestone.**

- **B. `M16` already meant something else, in 38 live places.** The number was assigned to
  "Cloud-hosted SaaS" in `SUMMARY.md`, `docs/PRD.md`, `docs/guide/operations.md` and **21 source
  comments**. Redefining the number without repointing them leaves `members.ts:383` saying "REVISIT
  AT M16" about multi-org membership, pointing at a milestone that has nothing to do with it. →
  **16.0**, and see D-16.0-1.

- **C. Nobody has measured onboarding since 15.9 removed `ADMIN_TOKEN`.** The documented path grew
  from "paste one env var" to a six-step credential chain (`ADMIN_PASSWORD` → login → mint API key →
  pair). The research plan's §5.2 target is time-to-first-capture **< 30 min**, and no gate in this
  repo can measure a property of the *human* path. → **16.0 part 4** (measure only, D-16.0-2).

- **D. Four tracked deferrals inherited from M14/M15** — dispositioned below rather than silently
  carried.

---

## Why the old M16 moved

The previous M16 was **Cloud-hosted SaaS**: multi-tenancy, managed archive, quotas and rate limits
beyond 12.4, billing, hosted onboarding. Every one of those items is named **explicitly out of
scope** by the research plan's §2 guardrails:

> Enterprise sales features, broad RBAC/SSO expansion, billing, or cloud hosting.

That is not a coincidence of wording — it is the same judgement from the other side. A 24-week
research period whose purpose is to find out whether anyone gets value cannot simultaneously build
the infrastructure for selling it to them.

**The SaaS milestone is renumbered M20** and returns to the committed-but-unsequenced bucket
alongside M17–M19. Nothing about it is cancelled or reduced; it is still committed scope, and it
still genuinely depends on M15. It also still inherits D-15.10-1's deferred multi-org membership and
org switcher, plus the tenant slugs (`schema.ts:57`) and user-defined roles (`roles.ts:2`) that
several source comments park there.

The renumber is the work of slice 16.0. See **D-16.0-1** for which references move and which
deliberately do not.

---

## Scope — the research plan's P0, plus two P1 items

Taken directly from `research-analysis-plan.md` §7. The priority labels are the research plan's, not
this plan's; this milestone builds P0 in full and two of P1.

**P0 — required for truthful research**

1. **Capture health scorecard** (§7 P0.1) — connector enabled/disabled state, last successful event,
   sync freshness, queue depth, last error, parser version, known permission gaps. Acceptance: _a
   user can distinguish "no work happened" from "capture is broken."_ → **16.3**
2. **Outcome-label data model and lightweight UI** (§7 P0.2) — a separately auditable label linked
   to a session, never a mutation of a raw record; preserves author, timestamp, edits, optional
   confidence. Acceptance: _label can be created, edited, skipped, exported, and deleted according
   to archive policy._ → **16.1** (model + API) and **16.2** (capture + review surfaces)
3. **Data-quality audit query/report** (§7 P0.3) — unmapped sessions, missing tokens, stale
   connectors, parser failures, sample reconciliation status. Acceptance: _weekly scorecard values
   are queryable rather than manually guessed._ → **16.4**
4. **Privacy-safe research artifacts and documentation** (§7 P0.4) — retention/export/delete and
   connector-permission documentation. Acceptance: _a design partner can make an informed decision
   before pairing a machine._ → **16.0** (`docs/guide/data-boundary.md` + `.agents/research/`)

**P1 — the two that P0 depends on or that fall out for free**

5. **Decision log links from a report/session** (§7 P1.5) — "I changed X because this evidence showed
   Y," with a follow-up date. Folded into **16.2**: the label surface and the decision link are the
   same interaction at different granularity, and shipping them apart means building the
   session→artifact linkage twice.
7. **Git outcome confidence** (§7 P1.7) — separate confirmed linkage, heuristic linkage, and no
   linkage. Folded into **16.4**: it is a data-quality claim about the M10 attribution heuristic, and
   the audit report is where an unearned causal claim would otherwise be laundered into a metric.

---

## Slices (dependency order)

| #        | Slice                        | Size | Content                                                                                                                                                                                                                                                                                                                                             |
| -------- | ---------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **16.0** | Truth + research scaffold    | S–M  | Renumber the SaaS milestone M16 → **M20** across 38 live sites (D-16.0-1); create `.agents/plans/m16-dogfood-instrumentation.md` (this file) and the `.agents/research/` artifact set required by research plan §3; write `docs/guide/data-boundary.md` (§7 P0.4 / Phase 0 item 7); run and log a **timed clean-room deploy** against the §5.2 < 30 min target. **No schema change; no behavioural code change** beyond F1/F2 (see below). |
| **16.1** | Outcome label model + API    | M    | The §7 P0.2 data model: a separately auditable label table linked to a session — **never** a mutation of `raw_source_records` or `events` (CLAUDE.md "raw sacred / events disposable"). Author, timestamp, edit history, optional confidence. The six fields from research plan §4.3 (`task_type`, `intent`, `outcome`, `quality_rating`, `primary_friction`, `follow_up_commit_or_pr`). CRUD + export + delete routes. |
| **16.2** | Label capture + review       | M    | The 15-second surface (§4.3: _offer skip, never nag, always editable, neutral wording_) in the desktop tray, plus a dashboard review/edit table. Folds in §7 P1.5 decision links.                                                                                                                                                                     |
| **16.3** | Capture health scorecard     | M    | §7 P0.1. Builds on the existing `routes/heartbeat.ts` + `routes/monitor.ts` + dashboard monitor surfaces. ~~**Inherits D3**~~ — **stale, see the D3 erratum**: the windowed connector-failure-rate shipped in M13 13.5, so 16.3 inherits nothing and consumes the existing alert rather than rebuilding it.                                                                                                                                                                 |
| **16.4** | Data-quality audit report    | M–L  | §7 P0.3, as a report artifact in the M7 versioned-artifact shape rather than a new surface. Powers the §5.1 metric table (capture coverage, project attribution, token completeness, parse success, duplicate rate, sync freshness, recoverability) and the §4.4 ten-session monthly reconciliation. Folds in §7 P1.7 git outcome confidence.        |

**Ordering rationale.** 16.0 first because the renumber gets more expensive with every document
written against the wrong number, and because the research plan's Phase 0 must complete before
Phase 1 (weeks 2–4) starts collecting. 16.1 before 16.2 because a label surface with no auditable
model behind it is the exact "mutate the raw record" mistake §7 P0.2 exists to prevent. 16.3 before
16.4 because the audit report reads the health signals the scorecard defines.

---

## Decisions

### D-M16-1 — The observation set is FIXED and narrow

Research plan §4.1 requires the dataset to come from natural work, and Phase 0 item 5 says: _"Do not
activate connectors for tools you do not use."_ This decision names the set, so that a later
"capture coverage = 95%" is a statement about a known denominator rather than whatever happened to be
switched on.

**Connectors enabled:** Claude Code, Codex CLI. **Nothing else.**
**Repositories observed:** `scrap-kanban`, `420AI`.
**Explicitly NOT enabled:** Cursor, Antigravity, Windsurf, Continue.

**The browser extension is NOT run during research Phase 1.** This is the load-bearing half of the
decision. `docs/research/extension-spike.md:122` records a known, unresolved gap: cross-connector
dedup of `claude-live` vs `claude-export` — one conversation captured both ways produces **two
sessions** sharing a `chat:claude:<uuid>` key. Running the extension during the reliability baseline
would inject known duplicates into the one period whose purpose is to measure the **duplicate rate
against a <1% target** (§5.1). The metric would then be measuring a configuration choice, not the
product.

_Consequence:_ any capture-coverage or duplicate-rate figure in a weekly scorecard is scoped to this
set. Changing the set is a decision-log entry (§11 template), not a settings change.

### D-16.0-1 — LIVE artifacts get repointed; HISTORICAL records do not

`git grep "M16"` returns 70 hits (excluding one `package-lock.json` false positive — the substring
appears inside a base64 integrity hash). They split into two populations, treated differently:

| Population                                        | Where                                                                                              | Hits   | Action                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -----: | ----------------------------------- |
| **LIVE** — read as current guidance               | `SUMMARY.md`, `docs/PRD.md`, `docs/guide/operations.md`, 14 source files                            | **38** | Repoint to **M20**                  |
| **HISTORICAL** — dated records of past decisions   | `.agents/plans/m15-*.md`, `.agents/code-reviews/*`, `.agents/execution-reports/*`                  | **32** | **Do NOT edit** — one erratum legend |

**Rationale.** `.agents/execution-reports/` is the repo's ground truth — `scripts/check-summary.mjs`
literally derives what shipped from those filenames. Rewriting them to say "M20" would make them
assert a decision that had not been taken on the date they carry. A plan that recorded "deferred to
M16" on 2026-08-02 *did* defer to what was then M16; that statement is true and stays true.

Source comments and live docs are the opposite: nobody reads `members.ts:383` as a historical record.
They read it as an instruction about what to do next, and it is now wrong.

One erratum blockquote at the top of `.agents/plans/m15-multi-user-access-control.md` disambiguates
all 32 historical hits at once. That is a legend, not a revision.

**Do not use `sed`.** Three independently sufficient reasons: the lockfile false positive would be
corrupted; the historical hits must survive; and CLAUDE.md's twice-proven lesson — _a per-FILE grep
exempts the file, not the call site_ — means each of the 21 source sites must be **read** and
confirmed SaaS/multi-org-semantic before it is changed.

### D-16.0-2 — Slice 16.0 part 4 MEASURES; it does not fix

The timed clean-room deploy will very likely show the post-15.9 auth chain eating a large share of
the 30-minute budget. **Do not fix it in 16.0.** Research plan §2's scope-change rule requires a
named data-quality or workflow failure before any feature is built, and an incident-log entry is
exactly how that justification gets created. Fixing it pre-emptively converts measured evidence into
a guess, and a "we improved onboarding" claim with no before-number behind it is unfalsifiable.

_Exception, narrowly drawn:_ **F1 and F2** (below) are fixed in 16.0. They are not onboarding
friction — they are defects in the **isolation mechanism the measurement's own safety constraint
depends on**. Leaving them means the clean-room exercise cannot prove it did not touch real data.

### D-16.0-3 — The clean room lives outside OneDrive

The fresh clone goes in the scratchpad, never under `OneDrive/Documents/`. OneDrive has already
corrupted this repo's `.git` once (2026-07-14), and a second synced clone of the same repository
invites a repeat. It also keeps the clean room genuinely disposable.

---

## Deferrals inherited from the 2026-08-02 audit

Four threads were open at M15 close. Each is dispositioned here rather than carried silently.

| #      | Deferral                                                                                                                     | Disposition                                                                                                                                                                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | **Cross-connector dedup** — `claude-live` vs `claude-export` produce two sessions for one conversation (`extension-spike.md:122`) | **Avoided by configuration, deferred as work.** D-M16-1 does not run the extension during Phase 1, so the gap cannot contaminate the duplicate-rate metric. The dedup itself stays deferred to the M14 connector-ecosystem thread (→ M19).                  |
| **D2** | **`discoverRoots`** refinement                                                                                                 | **Deferred.** No research metric depends on it; project attribution is measured (§5.1, ≥90%) and if it misses that target the failure earns a fix under the scope-change rule with evidence attached.                                                       |
| **D3** | **Windowed connector-failure-rate**                                                                                            | ~~**FOLDS INTO 16.3.**~~ **ERRATUM (D-16.3-1, 2026-08-04): this row was STALE when written — D3 shipped in M13 13.5 and 16.3 inherits nothing.** See the erratum note below the table.                                                                     |
| **D4** | **Antigravity connector**                                                                                                      | **Deferred.** D-M16-1 does not enable it, and research plan §2 places connector breadth for tools no active participant uses explicitly out of scope.                                                                                                     |

> **ERRATUM — D3 (recorded 2026-08-04 during 16.3 planning; D-16.3-1).** The D3 row above, and the
> "**Inherits D3**" note on the 16.3 roadmap row, were both **wrong when written**. The windowed
> connector-failure-rate did not need building: it **shipped in M13 13.5**. `CONNECTOR_RATE_ALERT` and
> `deriveConnectorFailureRateAlerts` (`packages/shared/src/alerts.ts`) and `connectorHealthWindowed`
> (`packages/db/src/repositories/projections.ts`) exist and are wired into `routes/monitor.ts`;
> `SUMMARY.md` records it.
>
> The entries are corrected here rather than rewritten, because the mistake is instructive: it is a
> deferral that had already been resolved elsewhere and was carried forward on the strength of the
> list rather than the code. 16.3 therefore inherits **nothing** here and deliberately does **not**
> rebuild it — the capture health panel consumes the existing windowed alert rather than deriving a
> second failure rate, since two independently-derived failure rates on one screen is exactly the
> "which number do I believe?" problem this milestone exists to remove.

---

## Findings carried into 16.0 from planning spikes

**F1 — `pair` accepts `--home` but its help text does not say so.** `apps/collector/src/cli.ts:426`
omits `[--home <dir>]` from the `pair` usage line, while the handler passes `home: resolveHome(args)`
and `runPair` persists via `credentialsPathFor(opts.home ?? homedir())`. `--home` **works**; the help
is what is wrong. An operator performing an isolated pair reads `--help` and reasonably concludes
pairing will clobber the real `~/.420ai/credentials.json`.

**F2 — the pair success message prints the wrong path under `--home`.** The confirmation interpolated
`CREDENTIALS_PATH`, the module-level `homedir()`-derived constant (`identity.ts:20`). Under
`pair … --home <dir>` the credentials are saved **correctly** to `<dir>/.420ai/credentials.json` but
the message printed `C:\Users\<you>\.420ai\credentials.json`. No data loss — but actively misleading
during exactly the exercise part 4 performs.

Both fixed in 16.0 per D-16.0-2's stated exception.

---

## Non-goals (name in every PR; do NOT build here)

Everything research plan §2 places out of scope, plus what M16's own shape excludes:

- **Multi-tenant hosting, managed archive, billing/subscriptions, quotas and per-tenant rate limits
  beyond 12.4, hosted onboarding** — this is the renumbered **M20**, and §2 names cloud hosting and
  billing out of scope for the whole 24-week period.
- **Multi-org membership + the org switcher** (D-15.10-1) — still deferred, now to **M20**.
- **Enterprise SAML/OIDC, SCIM/directory sync, user-defined roles, broad RBAC/SSO expansion** (§2).
- **General AI chat capture** (§2) — M14 shipped it; it is not extended here, and D-M16-1 does not
  run the extension during Phase 1.
- **New connector breadth for tools no active participant uses** (§2) — Antigravity (D4), Cursor,
  Windsurf, Continue.
- **Cross-platform collectors, portable signed installers** (**M17**), **semantic/vector search**
  (**M18**), **mobile** (**M19**), **MSI/code signing** (still parked).
- **New dashboard sections that do not improve capture quality or the selected hero insight** (§2).
- **Automated "AI recommendations" that cannot explain their evidence or confidence** (§2).
- **Onboarding-friction fixes in 16.0** (D-16.0-2) — measured there, fixed later with evidence.

### Deliberately NOT a slice: the hero workflow evidence panel

Research plan §7 **P1.6** (hero workflow evidence panel — every conclusion shows its source
sessions, time range, missing-data caveats and confidence) is a real, wanted capability. **It is not
a slice of M16, and that is not an oversight.**

The hero workflow is *selected in research Phase 2 (weeks 5–8) from evidence* — §6 Phase 2 step 5
says "select only one winner" after scoring five candidates on frequency, clarity, actionability,
data confidence and unique value. Naming a slice for its evidence panel now would pre-commit to a
guess about which workflow wins, and would do so at exactly the moment the milestone's entire premise
is that guesses get replaced by measurements.

It becomes a slice when Phase 2's gate G2 (end of Week 8) names the winner. Do not add it earlier
thinking it was forgotten.

---

## Risks

1. **The research period outlasts the milestone.** M16 ships the instrumentation in weeks 1–4;
   research Phases 2–6 run to week 24 and will generate work that is not M16. Mitigation: the
   scope-change rule (§2) is the gate — new work enters the backlog with its evidence, not the
   milestone.
2. **Measuring the thing you are also building.** 16.3 and 16.4 produce the metrics that judge
   capture quality, and the same operator writes both. Mitigation: §4.4's external ground truth
   (provider invoices, git history, tool-native session files) is deliberately *outside* the product
   — the ten-session monthly reconciliation is the check that the product's own numbers are honest.
3. **Labeling burden kills the ground truth** (research plan §12). If the 15-second label is not
   actually 15 seconds, completion collapses and 16.4's outcome metrics have no denominator.
   Mitigation: §4.3's rules are acceptance criteria for 16.2, not suggestions — skip always
   available, never nag, always editable.
4. **`m16-slice0` interacts with the `check-summary` gate.** Once
   `.agents/execution-reports/m16-slice0-*.md` exists, `SUMMARY.md` must carry `**16.0**` with a ✅
   within 4 characters. Writing `**M16 …** is **DONE**` would instead *disable* per-slice checking
   for 16.1–16.4. M16 is IN PROGRESS; do not declare it done.

---

## Pre-sign-off checklist (maintainer manual — every box)

Adopted from M14/M15 practice. Evidence under `.agents/qa/m16-signoff/`.

- [ ] A label round-trips: created from the tray, visible and editable in the dashboard, exported,
      deleted — with the raw record provably unmutated
- [ ] The capture health scorecard distinguishes "no work happened" from "capture is broken" on a
      **deliberately broken** connector, not merely a healthy one
- [ ] The data-quality audit's numbers reconcile against a hand-counted ten-session sample (§4.4)
- [ ] `docs/guide/data-boundary.md` re-verified against source after the last schema-touching slice
- [ ] Four consecutive weekly scorecards exist in `.agents/research/weekly/`
- [ ] `npm run repo-health -- --require-db` green with **0 skipped**
