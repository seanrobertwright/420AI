# Execution Report — M14 slices 14.0 (chat-capture spike) + 14.1 (truth & hygiene)

### Meta Information

- **Plan file:** `.agents/plans/m14-general-ai-chat-capture.md` (the milestone definition — see
  the first divergence: this run executed its two plan-free slices, not the whole milestone)
- **Files added:**
  - `docs/research/chat-capture-spike.md` (the 14.0 gating deliverable)
  - `.agents/system-reviews/m10-m13-review.md`
  - `.agents/plans/m14-general-ai-chat-capture.md` (authored in the planning step, ships in this
    branch)
  - `.agents/code-reviews/m14-slice0-1-spike-and-truth.md`
- **Files modified:** `README.md`, `SUMMARY.md`, `docs/PRD.md`, `docs/CONTEXT.md`,
  `docs/research/connector-capture-spike.md`, `scripts/CATALOG-SIGNING.md`,
  `apps/ingest/src/routes/auth.ts` (comment-only), `apps/ingest/src/server.ts` (comment-only)
- **Lines changed:** ~ +430 −30 (docs-dominated; 4 TS lines, all comments)

### Validation Results

- Syntax & Linting: ✓ (`eslint .` exit 0; `prettier --check` exit 0 on all touched `.md` — the
  two checks CI runs that `repo-health` does not)
- Type Checking: ✓ (root `tsc -b` via `repo-health`, 0 errors)
- Unit Tests: ✓ (743 passed, 0 failed)
- Integration Tests: ✓ (ran, not skipped — 743/743 with zero skips; `.env` supplies
  `DATABASE_URL_TEST` and the archive container was up)
- Post-review fix pass re-validated with `repo-health:fast` + prettier: ✓

### What Went Well

- **The spike answered its question decisively and cheaply.** Pure read-only filesystem recon
  (~6 commands) produced the milestone-shaping verdict: no chat surface stores conversations
  locally, so 14.5+ splits cleanly into export-file connectors (feasible now, honest Batch
  liveness) and a research-gated browser extension. No accounts touched, nothing written outside
  the repo.
- **The spike over-delivered two verified side-finds:** desktop-launched Claude Code sessions
  land in `%APPDATA%\Claude\claude-code-sessions\` outside the existing connector's glob (a real
  capture gap in the *shipped* product, filed for 14.5 planning), and Anthropic's own
  `ChromeNativeHost` bridge validates the extension→local-process delivery pattern before we
  build one.
- **Closing the old spike's follow-ups from shipped code** (Codex `session_meta` cwd/git in the
  parser, the Gemini projectHash contract in `gemini-roots.ts`) took two greps — evidence-based
  closure instead of "probably fine".
- The truth sweep + system-review made this PR self-documenting: the retro's central finding
  (unread checklists aren't gates) is the same mechanism this milestone adopts (D-M14-4).

### Challenges Encountered

- **Reviewing docs is a different bug surface.** With zero behavioral code, the code review's
  value was factual verification — and it found four real errors: a same-PR self-inconsistency
  (SUMMARY said "spike unrun" while the PR shipped the spike), three code spans split across
  line breaks (rendering paths with embedded spaces), a wrong elapsed-time claim, and a
  count/list mismatch. All fixed pre-commit.
- **`[documented]` vs `[verified]` discipline.** The export-flow claims (Claude/ChatGPT/Takeout
  archive shapes) can't be verified by filesystem recon and may have drifted since early 2026 —
  the spike marks every such claim and makes live verification an explicit follow-up before
  14.5 locks parser contracts.

### Divergences from Plan

**Executed two slices of a milestone definition, not "the plan"**

- Planned: `/lril:execute` was invoked on the milestone definition file.
- Actual: executed 14.0 + 14.1 only; stopped before 14.2–14.4.
- Reason: the definition itself mandates per-slice `/lril:plan-feature` plans and gates 14.5+ on
  14.0. Executing 14.2–14.4 unplanned would violate the loop the plan encodes.
- Type: Plan assumption wrong (the definition is not an executable plan; this was the correct
  reading of intent)

**14.1 grew two in-flight status updates**

- Planned: 14.1 = README + stale comments + system-review.
- Actual: also updated SUMMARY §0/§6 to mark 14.0/14.1 done (a code-review finding — the PR
  would otherwise tell readers to run a spike it contains the output of).
- Reason: same-PR self-consistency; SUMMARY is the live status tracker by repo convention.
- Type: Better approach found

### Skipped Items

- **Slices 14.2–14.4 and 14.5+** — not skipped, sequenced: each needs its own
  `/lril:plan-feature` pass per the milestone definition (14.5's gate is now lifted).
- **Live verification of the three export flows** — requires triggering real account exports
  (external, slow, email-delivered); recorded as the spike's first open follow-up, needed
  before 14.5 planning locks parser contracts.
- **The maintainer pre-sign-off checklist** — untouched by design; it gates milestone sign-off,
  not this slice.

### Recommendations

- **Plan command improvements:** milestone *definitions* and slice *plans* are different
  artifacts that both live in `.agents/plans/`. A one-line header convention ("type:
  milestone-definition | slice-plan") would let `/lril:execute` refuse-or-scope automatically
  instead of relying on the executor noticing.
- **Execute command improvements:** for docs-only diffs, the "validation gates" section should
  explicitly include the two CI-only checks (`npm run lint`, `prettier --check` on `.md`) —
  repo-health passing is not CI passing (this repo's memory has caught this twice).
- **CLAUDE.md additions:** none — the existing conventions covered this run; the truth-sweep
  habit recommendation already landed in the M10–M13 system-review written this slice.
