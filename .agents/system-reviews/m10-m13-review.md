# System Review — M10→M13 (Hardening → Desktop → GA → Capability Gap Closure)

## Meta Information

- **Written:** 2026-07-14 (M14 slice 14.1 — this review was itself an audit finding: the retro
  cadence broke after `m7-m9-review.md` (2026-06-15), leaving four milestones and ~40 slices of
  process signal uncaptured).
- **Scope:** M10 (hardening bundle, slices 1–3d), M11 (Tauri desktop, slices 1–5), M12 (GA,
  slices 12.1–12.8 incl. sub-slices), M13 (capability gap closure, slices 13.1–13.7).
- **Sources:** the per-slice plans / code-reviews / execution-reports under `.agents/`, PRD §25,
  SUMMARY §0/§6, and the 2026-07-14 deferral audit
  (`.agents/plans/m14-general-ai-chat-capture.md`).

## Overall Alignment Score: 8/10

Every planned slice shipped, gates stayed green (622 → 743 tests through M13, `--require-db`
0-skipped at every db/ingest sign-off), and both big reconciliations (2026-06-19, 2026-07-07)
found gaps in *scope memory*, not in *shipped quality*. The two docked points are process, not
product: manual pre-sign-off steps slipped unrecorded, and truth-debt (stale "deferred" wording)
accumulated exactly where deferrals later shipped.

## What worked (keep doing)

1. **Reconciliation-driven milestones.** M12 and M13 were both born from code-vs-PRD audits, not
   from plan momentum. Both times the audit surfaced silently-dropped scope the plans had stopped
   carrying (custom connector, git outcomes; then the thin intelligence layer). This is now the
   institutionalized path to a new milestone (M14 followed it on 2026-07-14).
2. **Research gates that actually gate.** 12.7d's "ship if feasible, never block GA" resolved
   Cursor/Antigravity with a cheap live spike instead of a doomed build — and the deferred Cursor
   work landed cleanly later (13.7) once its real prerequisite (a poll capture mode) was named.
3. **Settle load-bearing decisions at planning time.** D-M13-1/D-M13-2 (and M11's control-protocol
   / NSIS resolutions) were decided once, written down, and never re-litigated mid-slice. Slices
   that started with settled decisions show near-zero divergence in their execution reports.
4. **Frozen-primitive discipline.** `deriveAlerts` FROZEN + siblings (3c, 13.5), the fingerprint
   untouched through re-price/re-parse/catalog work, additive capture modes (13.7's `poll` beside
   `tail`) — every risky evolution happened *beside* a frozen core, and nothing regressed.
5. **`--require-db` as a sign-off gate.** The M5 `lastActivity` class of bug (int test that never
   ran) did not recur across four milestones.

## Divergence Analysis (patterns across the four milestones)

- **Manual pre-sign-off steps slip when they live only in prose.** 13.7 named a live Cursor
  round-trip "a manual pre-sign-off step" — M13 was signed off without recording it. 12.8's
  Level-4 items (restore drill, live-update E2E) and 12.3's live QA + screenshots
  (`.agents/qa/m12-slice3/` never created) met the same fate. The updater signing-key ceremony —
  on which auto-update is *non-functional* — is still undone a week after its runbook
  shipped. **Root cause:** checklists lived in execution-report epilogues, which nothing reads at
  sign-off time.
- **Truth-debt accrues at deferral-shipping seams.** When a deferral ships, the comments/docs that
  said "deferred" don't get swept: auth.ts still said "DEFERRED to 12.4" after 12.4c shipped it;
  CONTEXT.md + CATALOG-SIGNING.md still said "deferred replay engine" after 12.5a/13.3; README
  froze at "M12 in progress". 13.1 and 14.1 were both truth slices cleaning exactly this class.
- **Deferral records scatter.** The "2026-06-20 audit" exists only as SUMMARY/PRD prose; the
  2026-07-07 reconciliation lives inside the M13 plan's premise. Re-running an audit requires an
  agent sweep of ~40 files. (M14's plan embeds its audit as a named section — better; a standing
  ledger was considered and rejected as a second source of truth to drift.)
- **Retro cadence broke at the busiest stretch.** M10–M13 (the four fastest milestones) produced
  zero system-reviews — the reviews stopped precisely when their signal was highest.

## System Improvement Actions

### Adopted in M14 (already in force)

- **Named pre-sign-off checklist in the milestone plan** (D-M14-4): every outstanding manual
  action is a checkbox in `m14-general-ai-chat-capture.md`; the milestone cannot sign off with an
  unchecked box. This moves the checklist from execution-report epilogues (write-only) to the plan
  (read at sign-off).
- **Audit-embedded-in-plan** as the standard shape for milestone origins (M14 §"Origin").

### Update the loop (recommended, small)

- **`/lril:commit` / milestone-wrap habit:** when a slice ships a previously-deferred item, grep
  for the deferral's name in comments/docs (`grep -ri "deferred" --include="*.ts" --include="*.md"`
  scoped to the touched area) and sweep stale wording in the same PR — don't bank it for a truth
  slice.
- **Milestone-wrap checklist gains two lines:** update the README roadmap; write the system-review
  (this file's absence was itself a finding).

## Key Learnings

1. A gate that isn't *read at sign-off time* is not a gate — it's a wish. (Manual steps, Level-4
   items.)
2. Deferrals need a tombstone: the moment one ships, its "deferred" markers become misinformation
   with a green typecheck.
3. The audit → scope-conversation → settled-decisions → thin-slices pipeline has now produced
   three well-shaped milestones (M12, M13, M14). It is the de-facto milestone-planning process
   and should be treated as such.
