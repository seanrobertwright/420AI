# Code Review — M13 Slice 13.3: Archive re-parse engine (12.5b)

Branch: `m13-slice3-archive-reparse` · Reviewed: 2026-07-07

**Stats:**

- Files Modified: 9 (4 collector connectors, replay route, schemas, 2 package.json, 2 barrels)
- Files Added: 9 source + 1 test + 4 fixtures (3 moved, 1 copied)
- Files Deleted: 0 (3 test files + 3 fixtures MOVED to `packages/shared/src/parsers/`)
- New lines: ~1,980 (mostly the relocated parsers + new engine/tests)
- Deleted lines: ~835 (the relocated parser bodies leaving the collector)

## Scope reviewed

Every new file read in full; every modified file read in full against `CLAUDE.md`
(Drizzle gotchas, logging/process boundaries, "raw sacred / events disposable",
fingerprint invariants) and the M13 plan's resolved decisions (D-M13-1/2).

Verified with evidence, not by inspection alone:

- Root `tsc -b` exit 0; `repo-health` PASS (660 tests); `repo-health --require-db`
  PASS with **172 integration tests ran, 0 skipped**.
- The headline int test proves reclassification (`tool.call.completed` →
  `tool.call.failed` w/ `failureClass`/`exitCode` in the decrypted payload),
  orphan-GC of the stale fingerprint, stable event count, raw-record immutability,
  idempotent second run, Gemini skip reporting, and `sessionId` scoping.
- Codex reassembly reconstructs ORIGINAL line indices (gap left for a line that
  was malformed at capture) — proven by the fresh event's `model` carrying
  forward from `turn_context` across the gap, and by fingerprint stability.
- Structurally-significant-chars-in-values case exercised: the tool-output value
  embeds JSON braces/colons inside a string; parse + reassembly are unaffected.
- ESLint + Prettier clean on all touched files (both bit CI in 13.1/13.2).
- Security: route admin-gated; all SQL parameterized via Drizzle; decrypted
  plaintext never logged and only ever re-enters storage through `ingestBatch`'s
  encrypt-at-write boundary; GC deletes by exact fingerprint lists (chunked, 500).

## Issues

```
severity: low
file: packages/db/src/repositories/reparse.ts
line: 105
issue: Claude sessions containing uuid-less records (defensive fallback rawIds) can churn fingerprints on re-parse
detail: A Claude raw record without a `uuid` gets the positional fallback id `${session}:${lineIndex}`. If the timestamp-sorted reassembly ordering differs from the original file order, such a record's lineIndex — and therefore its events' fingerprints — change; the orphan GC then swaps old fingerprints for new ones. Event COUNT stays stable and no data is lost (raw is untouched), but history for those rare records is re-keyed. Real Claude records carry uuids (the fallback is defensive), and the plan explicitly accepted timestamp-sort bounding (NOTES: "Claude raw-record line order not persisted").
suggestion: Accepted as-is per plan decision; the carry-forward sort key keeps timestamp-less lines adjacent, bounding the drift. No code change.
```

```
severity: low (informational — pre-existing, not introduced by this slice)
file: packages/db/src/repositories/ingest.ts
line: 91
issue: The events ON CONFLICT DO UPDATE re-stamps parser/catalog/tokens/cost/payload but NOT ts/projectPath/gitBranch
detail: If a future parser version changes how it derives an event's timestamp or project path (same fingerprint), a re-parse will not refresh those columns. This is the §23 replay re-stamp scope shipped in M2 and relied on by every caller; widening it is a milestone-level decision on a CLAUDE.md invariant boundary, out of 13.3's scope.
suggestion: None now; note for the next parser change that touches ts/projectPath derivation.
```

No critical, high, or medium issues detected.

## Verdict

Code review passed. The two low findings are documented limitations (one
plan-accepted, one pre-existing), not defects — nothing to fix before commit.
