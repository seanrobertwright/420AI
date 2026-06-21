# Code Review — M12 Slice 12.7d (Cursor + Antigravity connector gate resolution)

**Reviewed:** `m12-slice7d-cursor-antigravity-connectors` branch vs `main` (HEAD)
**Reviewer:** technical pre-commit review (lril:code-review)
**Date:** 2026-06-21

## Stats

- Files Modified: 1 (`docs/PRD.md`)
- Files Added: 0
- Files Deleted: 0
- New lines: 23
- Deleted lines: 11

## Scope & nature

This slice is a **gate-resolution report**, not a code-implementation plan (PRD §25-M12.7:
Cursor + Antigravity = "ship if feasible, never block GA"). The live read-only spike was already
run (2026-06-20) and recorded in the plan + `SUMMARY.md` §6. The only executable deliverable was
documentation consistency: flip the Cursor/Antigravity research gate from "open" to
"resolved → deferred" in the PRD, which still presented it as open in four places.

No source, schema, fingerprint, server, migration, or test change. The standard logic / security /
performance / race-condition lenses do not apply to a docs-only diff; review instead targets
**factual accuracy against the spike evidence** and **internal cross-reference consistency**.

## Verification performed

- `npm run repo-health` → **PASS** (tsc -b 0 errors, dashboard 0, desktop 0, 83 files / 589 tests).
- `npx prettier --check docs/PRD.md SUMMARY.md` → **PASS** (widened §10.1 GFM table is valid).
- Cross-references resolve: §10.1 (connector table) and §25-M12.7d (slice entry) both exist.
- Every factual claim reconciled against the plan's spike evidence:
  - "22k message bubbles" ← plan: 22,368 `bubbleId:` rows. ✓
  - "model in `composerData.modelConfig`" ← plan: model absent on bubbles, lives on composer. ✓
  - "partial token data" ← plan: non-zero `tokenCount` in 606/22,368, aggregate real. ✓
  - "WAL-mode SQLite … `parse(fileText)` can't ingest" ← plan blocker analysis. ✓
  - Antigravity "schema-less binary protobuf, no shipped `.proto`, no token/cost" ← plan. ✓
  - "secret keys to avoid" ← plan (`cursorAuth/*`, `blobEncryptionKey`) — described, **not** exposed. ✓

## Issues

Code review passed. No technical issues detected.

### Notes (non-blocking)

- **Secret hygiene:** the PRD correctly describes the Cursor secret-key hazard in the abstract
  ("secret keys to avoid") without copying any real token value into the doc — consistent with the
  repo's "browser never holds ADMIN_TOKEN" / redaction discipline.
- **Date consistency:** §25 dates the spike "2026-06-20" (matching the plan's "run live … 2026-06-20")
  while the sub-slicing note is 2026-06-21 — intentional (spike ran a day before it was written up),
  parallel to how 12.7c is dated "implemented 2026-06-21".
- **SUMMARY §3/§4 first-spike findings table** left untouched on purpose — it is a historical Q1–Q4
  research snapshot and remains factually correct; the authoritative resolution lives in §6 + the PRD.
