# System Review — Milestones 1–3 (Walking Skeleton → Archive → Collector Foundation)

> **System review, not code review.** This analyzes how well execution followed the plans and where
> the *process* (planning, validation, tooling) leaked — not whether the code is correct.

## Meta Information

- **Plans reviewed:**
  - `.agents/plans/m1-walking-skeleton-claude-code.md` (Confidence 9.5/10)
  - `.agents/plans/m2-archive-deployment.md` (Confidence ~9/10)
  - `.agents/plans/m3-collector-foundation.md` (Confidence 9/10)
- **Commands reviewed:** `lril/commands/plan-feature.md`, `lril/commands/execute.md`
- **Execution evidence:** the M3 execution this session (direct observation) + git history (`82f5f86` M1, `edebf99` M2, `eb6aa5b` plan, `d02f390` M3 impl, `ed0080f` encoding fix) + the live state of all four workspaces.
- **Date:** 2026-06-13

---

## Overall Alignment Score: 8.5/10

Execution adhered to the plans unusually well — the plans are exceptional (executed PRE-FLIGHT spikes, file:line references, real-code "Patterns to Follow", leveled validation, explicit deferred scope). Nearly every M3 divergence was **good** (fixing a latent predecessor defect or faithfully honoring a spike the plan transcribed imperfectly). The score is held below 9 by **three systemic process gaps that all share one root cause: validation commands were treated as documentation rather than as gates that actually ran and blocked on a non-zero exit.** One of them (a broken `typecheck` since M2) survived two milestone sign-offs undetected.

---

## Divergence Analysis

```yaml
divergence: typecheck (tsc -b) was already broken at M2 sign-off
planned: M1/M2/M3 plans all list "npm run typecheck → 0 errors" as Level-1 validation; M2 acceptance + completion checklists claim it passed
actual: clean-HEAD `npm run typecheck` exits 2 — push.int.test.ts imports apps/ingest/src/app.js across the project boundary, violating the collector tsconfig rootDir. Fixed in M3 by excluding *.int.test.ts from tsc -b.
reason: integration tests legitimately import across app boundaries; M2 added that import without a tsconfig exclude or project reference, and the failure was never gated on.
classification: bad ❌ (the latent defect) / good ✅ (the M3 fix)
justified: fix yes; the original miss no
root_cause: missing validation gate — the validation command was listed but its exit code was not enforced at M2 sign-off (likely per-workspace `build` was run, not the root `tsc -b`)
```

```yaml
divergence: tailer `grew`/`text` semantics differ from the plan's code snippet
planned: M3 "Patterns to Follow" snippet returns the whole-file text with grew:true whenever any newline exists
actual: grew is true only when a NEW complete-line boundary appears beyond the cursor; a partial-only append returns text:"" grew:false — which is what the plan's OWN stated PRE-FLIGHT #4 assertions require
reason: the snippet contradicted the spike assertions it claimed to encode; I implemented to the assertions
classification: good ✅
justified: yes
root_cause: unclear/contradictory plan — a transcribed code snippet drifted from the spike behavior it documents
```

```yaml
divergence: file-watcher.ts committed with 95 embedded NUL bytes (binary blob)
planned: a normal UTF-8 TypeScript source file
actual: the Write produced embedded NULs; typecheck + 97 tests + commit ALL passed (NULs sat in comment/whitespace regions esbuild tolerates); git stored it as "Bin 0 -> 3546 bytes". Found during this review and rewritten clean (commit ed0080f).
reason: a Windows Write-tool encoding glitch; no validation step inspects file encoding/binary-ness
classification: bad ❌
justified: no
root_cause: missing validation — no gate detects non-text/corrupt source; the compiler/test toolchain silently tolerates NULs in comments
```

```yaml
divergence: capture-engine adds an internal AbortController + runSyncLoop onStop callback
planned: "Promise.race so a fatal stop/abort ends both, then abort the other"
actual: an internal controller chained to the external signal so a 401 ("stop") also aborts the watcher; onStop surfaces the re-pair message
classification: good ✅
justified: yes — a faithful, slightly-elaborated implementation of the planned intent
root_cause: n/a (normal implementation latitude)
```

```yaml
divergence: started M3 on a feature branch
planned: not in the plan; came from auto-memory ("M3+ on feature branches; M1/M2 stay on main")
actual: created m3-collector-foundation branch before implementing
classification: good ✅
justified: yes — honored a durable user preference outside the plan
root_cause: n/a
```

```yaml
divergence: commit message + PR body picked up stray "@" characters (twice)
planned: clean conventional-commit message / PR body
actual: PowerShell here-string syntax (@'...'@) used inside the Bash tool injected literal "@" lines; required an amend + a gh pr edit to correct
classification: bad ❌ (operational, not plan-related)
justified: no
root_cause: tool-syntax confusion — PowerShell vs Bash quoting; recurred 2x in one session
```

```yaml
divergence: unexpected non-fast-forward on first push
planned: a clean `git push -u`
actual: the pre-amend commit had already reached origin (an auto-push mechanism), so the corrected commit needed --force-with-lease
classification: neutral / process-surprise
justified: yes (force-with-lease was guarded on the exact expected sha; trees were identical)
root_cause: an auto-push hook/automation whose behavior wasn't accounted for in the commit→amend→push flow
```

---

## Pattern Compliance (M3)

- [x] **Followed codebase architecture** — extended `apps/collector` only; reused M1 parser, M2 wire types, M2 ingest client/API verbatim; no new server code or Postgres tables, exactly as scoped.
- [x] **Used documented patterns** — ESM/NodeNext, `kebab-case.ts`, `snake_case` SQL, co-located vitest, "raw sacred / events disposable", injected-clock testability, libraries silent (only `cli.ts` logs). Mirrored `SqliteStore` for `QueueStore`.
- [x] **Applied testing patterns** — co-located `*.test.ts` (no infra) + `*.int.test.ts` with `describe.skipIf(!DATABASE_URL_TEST)`; integration test reuses M2 `buildApp` in-process like `push.int.test.ts`.
- [~] **Met validation requirements** — all levels were *run* this milestone (Level 1–4), but Level 1 only passed because it was actually executed and the latent M2 failure was then fixed. Prior milestones demonstrably did **not** enforce Level 1.
- [N/A] **CLAUDE.md conventions** — there is no project-level `CLAUDE.md`; conventions live in `SUMMARY.md` and are re-stated verbatim in each plan's preamble (see Improvements).

---

## Root-Cause Themes

1. **Validation commands were not enforced as gates.** The single highest-value finding. `execute.md` says "continue only when it passes," yet a broken root `tsc -b` shipped through M2's acceptance/completion checklists. Plans *list* commands; nothing structurally forces the executor to paste the exit code and block on non-zero. When the executor (this session) actually ran them, the gap surfaced immediately.

2. **No "is it even a valid text file" check.** A NUL-corrupted source passed typecheck, 97 tests, and commit. The toolchain tolerates NULs in comments, so green ≠ clean. Encoding/binary validation is a missing class of check entirely.

3. **Plan code snippets can drift from the spike they encode.** The tailer snippet contradicted its own PRE-FLIGHT #4 assertions. Spikes retire risk, but the *transcription* of spike behavior into the plan's "Patterns to Follow" is hand-copied and unverified against the spike's assertions.

4. **Conventions are duplicated per-plan, not centralized.** Each plan re-states the same house style ("ESM + NodeNext, kebab-case, raw sacred…"). This works but drifts: there is no single source of truth a reviewer or new agent can diff against, and the plan-feature template even tells the planner to "Check CLAUDE.md" — which doesn't exist here.

5. **Operational tooling friction (Windows).** PowerShell-vs-Bash quoting caused two message-corruption incidents, and an auto-push surprised the commit flow. These are environment-specific and cheap to document once.

---

## System Improvement Actions

### Create a project `CLAUDE.md` (highest leverage)
There is none today. Extract the convention block that every plan currently re-states, plus the hard-won M3 lessons. Suggested content:

```markdown
# 420AI — Project Conventions

## Module / TS / naming
- ESM, "type": "module", NodeNext, verbatimModuleSyntax. Relative imports end in `.js`.
- `import type` for type-only imports. `kebab-case.ts` files, `PascalCase` types,
  `camelCase` fns, `snake_case` SQL columns.
- Strict TS across all 4 workspaces (packages/shared, packages/db, apps/ingest, apps/collector).

## Invariants — do NOT change without a milestone-level decision
- The event fingerprint formula (`packages/shared/fingerprint.ts`) and the normalized
  token/event shapes. They are the load-bearing dedup/idempotency keys (PRD §12, §23).
- "Raw records sacred / events disposable": raw payloads are immutable; events upsert by fingerprint.

## Logging / process boundaries
- Library files never write stdout/stderr or call process.exit. Only `cli.ts` / `server.ts`
  log, read argv, handle signals, and exit. Libraries throw typed errors; the entrypoint prints.

## Local state
- `~/.420ai/` holds `credentials.json` + `queue.sqlite` (outside the repo, gitignored as *.sqlite).

## Validation is a GATE, not a list
- `npm run typecheck` is the root `tsc -b` and MUST exit 0 before any commit. Per-workspace
  `build` is not a substitute — it misses cross-project test imports.
- `*.int.test.ts` are excluded from `tsc -b` (they import across app boundaries) and run by
  vitest/esbuild; they self-skip without DATABASE_URL_TEST.

## Tooling gotchas (Windows)
- The Bash tool is Git Bash (POSIX sh). For multi-line commit/PR text use a heredoc
  (`<<'EOF'`), NOT PowerShell here-strings (`@'...'@`) — the latter injects literal `@`.
- An auto-push may carry a commit to origin before you push manually; if you amend, expect a
  non-fast-forward and use `git push --force-with-lease` guarded on the expected sha.
```

### Update Plan Command (`plan-feature.md`)
- [ ] **Add a "Validation is a gate" instruction:** every Level-1/2/3 command must be runnable from repo root and the plan must state the *expected exit code / pass signal*, not just the command. Add to the template: "Level 1 must be the repo-root typecheck/build (not per-workspace), so cross-project/test-only imports are covered."
- [ ] **Add a snippet-fidelity check to Phase 4/5:** "Any code snippet in 'Patterns to Follow' that encodes a PRE-FLIGHT spike behavior MUST agree with that spike's stated assertions. State the assertions next to the snippet so the executor can detect drift." (This would have caught the tailer contradiction at planning time.)
- [ ] **Point at the real source of truth:** the template says "Check CLAUDE.md" — make it "Read `CLAUDE.md` and `SUMMARY.md`; do not re-paste conventions, link to them." Prevents per-plan convention drift.

### Update Execute Command (`execute.md`)
- [ ] **Make validation blocking + evidenced:** change step 4 to "Run each command from repo root, paste the actual exit code, and STOP if non-zero. Do not report a level as passed without showing its output." (The current "continue only when it passes" is too easy to satisfy by running a narrower command.)
- [ ] **Add a pre-commit hygiene gate (step 4.5):** before handing off to commit, run a fast repo-health check:
  - `git diff --cached --numstat | grep -P '^-\t-\t'` → flags files git treats as **binary** (catches the NUL-corruption class).
  - `git status --porcelain` shows no stray build artifacts (`*.js`/`*.d.ts`/`*.map`/`dist/`/`*.sqlite`).
- [ ] **Note the toolchain-tolerance trap:** "Green typecheck + tests do NOT prove a file is clean text. Verify new source files are UTF-8 (the binary check above)."

### Create New Command
- [ ] **`/lril:repo-health`** (or fold into execute's step 4.5) — one command that runs: root `tsc -b`, full `vitest run`, the binary-file check, the stray-artifact check, and a `*.int.test.ts`-excluded-from-tsc assertion. Justification: the same three checks (typecheck-from-root, no-binary-sources, no-stray-artifacts) were each needed manually this milestone and would recur every milestone.

### Validation Additions (repo)
- [ ] Add a `.gitattributes` entry forcing `*.ts text eol=lf` (and consider `* text=auto`). This would have made git reject/normalize the NUL file as text and surfaced the corruption in the diff immediately, and would stop the recurring "LF will be replaced by CRLF" warnings.
- [ ] Optional: a pre-commit hook (or the new command) wired so `npm run typecheck` actually blocks commits — turning the "gate" from a convention into enforcement.

---

## Key Learnings

**What worked well**
- **The PRE-FLIGHT spike discipline is the standout.** All three milestones retired their novel runtime risks (node:sqlite upsert/dedup, AES-GCM column split, byte-offset tail, claim/ack/backoff, glob discovery, fetch sync loop) with executed evidence before planning. M3's keystone mechanics worked first-try because of it — the integration test passed against real Postgres on the first run.
- **Scope discipline.** M3 added no server code and no Postgres tables, shipped Claude-only, and left M4 a clean `Connector` seam — exactly as the plan's "Explicitly deferred" section dictated.
- **Reuse over reinvention.** M3 fed the unchanged M1 parser + M2 wire types + M2 ingest client/API; the integration test drove the real `buildApp`. Nothing load-bearing was duplicated.
- **Honest confidence scores.** Each plan's "9/10, the missing point is the irreducible first-write of the composition" framing proved accurate.

**What needs improvement**
- **Validation as enforced gate, not a checklist.** A broken `tsc -b` survived two sign-offs. This is the one finding that, left unfixed, will keep producing "the checklist said green" surprises.
- **Encoding/binary hygiene.** A corrupt source file shipped clean through every existing gate.
- **Snippet↔spike fidelity in plans.** Transcribed code can contradict the very assertions it claims to encode.
- **Centralize conventions** in a project `CLAUDE.md` instead of re-stating them in each plan preamble.

**For the next implementation (M4 — Codex/Gemini connectors)**
- Land the project `CLAUDE.md` + `.gitattributes` first, so M4 starts on enforced rails.
- Treat Level-1 as repo-root `tsc -b` and paste the exit code; add the binary/artifact checks to the pre-commit step.
- When the plan includes a spike-derived snippet, put the spike's assertions beside it and verify agreement before coding.
- M4 should be a near-pure application of the `Connector` interface — if it needs framework changes, that's a signal the M3 contract was under-specified; capture it as a divergence.
```
