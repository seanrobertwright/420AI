# Code Review — M14 slices 14.0 + 14.1 (chat-capture spike + truth & hygiene)

**Date:** 2026-07-14 · **Branch:** `m14-slice0-1-spike-and-truth` · **Reviewer:** automated
pre-commit review (this diff is docs + comment-only TS; the review surface is factual accuracy,
link integrity, and same-PR self-consistency rather than runtime behavior).

**Stats:**

- Files Modified: 8
- Files Added: 3
- Files Deleted: 0
- New lines: 392 (83 in modified files + 309 in new files)
- Deleted lines: 26

**Verified clean:** the two TS changes (`auth.ts`, `server.ts`) are comment-only and their new
claims were checked against the code (`app.rateLimitLogin` is decorated in `buildApp` and on by
default via `server.ts` — accurate). `db:reprice` script + `POST /v1/replay/reprice` route both
exist as newly claimed in CONTEXT.md/CATALOG-SIGNING.md. The closed spike follow-ups cite real
evidence (`codex-cli.ts` extracts `payload.cwd`/`payload.git.branch`; `gemini-roots.ts` documents
the projectHash contract; 13.7 live-run numbers match SUMMARY). No secrets in the diff; the spike
recon was read-only. `repo-health` PASS (743/743, int layer ran), `eslint` 0, `prettier` 0.

## Issues

```
severity: medium
file: SUMMARY.md
line: 57 (§0 M14 paragraph) + §6 M14 entry
issue: Same-PR self-inconsistency — SUMMARY says the 14.0 spike "is genuinely unrun" and "Next
       action: run 14.0", but this very PR ships 14.0 + 14.1 done.
detail: A reader of the merged main would be told to run a spike whose output file the same
        commit contains. The M13 precedent is that SUMMARY §0/§6 track live slice status.
suggestion: Mark 14.0 ✅ (link docs/research/chat-capture-spike.md) and 14.1 ✅ in both the §0
            paragraph and the §6 entry; next action becomes planning 14.2 (or 14.5).
```

```
severity: medium
file: docs/research/chat-capture-spike.md
line: 37-38, 49-50, 86-87
issue: Three inline code spans are split across a line break, so the rendered path contains a
       spurious space (e.g. "…<uuid>/<uuid>/ local_*.json", "%LOCALAPPDATA%\Programs\ ChatGPT",
       "apps/collector/src/ serve.ts").
detail: Markdown joins a multi-line code span with a space — the rendered paths are wrong as
        copy-paste targets, in the document whose whole job is naming exact paths.
suggestion: Rewrap so each code span sits on one line (prettier proseWrap=preserve will keep it).
```

```
severity: low
file: .agents/system-reviews/m10-m13-review.md
line: 47
issue: "three weeks after its runbook shipped" — the runbook shipped in 13.1 (merged 2026-07-07/08);
       as of this review that is one week, not three.
detail: A retrospective's credibility rests on its dates being right.
suggestion: "a week after its runbook shipped".
```

```
severity: low
file: README.md
line: 165
issue: "M13 — Capability Gap Closure (7 slices)" is followed by a list of only 6 deliverables
       (13.1 truth & small fixes is omitted).
detail: Count and list disagree in the same sentence.
suggestion: Add "truth fixes" to the list (or drop the count).
```

## Verdict

4 issues (2 medium, 2 low), all documentation accuracy/consistency — no logic, security, or
performance findings possible in this diff class. Fix all four before commit.

## Fix pass (same session, pre-commit)

All four fixed: SUMMARY §0/§6 now mark 14.0/14.1 ✅ DONE with the spike verdict inline (next
action → plan 14.2/14.5); the three split code spans rewrapped onto single lines; "three weeks" →
"a week"; README M13 list now names all 7 slices. Gates re-run green after the fixes.
