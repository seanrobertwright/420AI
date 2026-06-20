# Code Review — M10 Slice 3A: Archive & Report Exports (PRD §22)

Reviewed against repo conventions in `CLAUDE.md` (module/TS/naming, library-no-logging
boundary, the Drizzle/SQL `mode:"string"` gotchas, the validation GATE) and the existing
route/repository/redaction patterns.

**Stats:**

- Files Modified: 6 (`apps/ingest/src/app.ts`, `apps/ingest/src/schemas.ts`,
  `packages/db/src/index.ts`, `packages/shared/src/index.ts`,
  `packages/shared/src/redaction.ts`, `packages/shared/src/redaction.test.ts`)
- Files Added: 5 (`apps/ingest/src/routes/exports.ts`,
  `apps/ingest/src/exports.int.test.ts`, `packages/db/src/repositories/exports.ts`,
  `packages/shared/src/serialize.ts`, `packages/shared/src/serialize.test.ts`)
- Files Deleted: 0
- New lines: ~960 (incl. tests)
- Deleted lines: 1

---

## Issues

```
severity: high
file: packages/db/src/repositories/exports.ts
line: 95 (exportEvents return mapping; column select line ~83)
issue: Exported `ts` is Postgres timestamptz text ("2026-06-14 00:00:00+00"), not ISO 8601
detail: `events.ts` is a `mode:"string"` timestamptz. A PLAIN column select returns the
  driver's text rendering ("2026-06-14 00:00:00+00"), NOT the canonical ISO 8601
  ("2026-06-14T00:00:00.000Z"). Verified empirically against the live test DB via
  exportEvents: the returned `ts` === "2026-06-14 00:00:00+00" and
  `ts === new Date(ts).toISOString()` is FALSE. The `EventExportRow.ts` doc comment claims
  "ISO string verbatim", the manifest's `exportedAt` is ISO, and every other API endpoint
  emits ISO — so this export's primary timestamp field is inconsistent and non-standard for a
  "portable data bundle" (§22), and would break external consumers / re-import that expect ISO.
  This is the SAME `mode:"string"` format bug CLAUDE.md flags (M5 lastActivity, M9
  activeSessions); the plan's Spike 1 mis-cleared it because its only evidence
  (`.toContain("2026-06-14")`) passes for BOTH formats.
suggestion: Normalize in exportEvents: map rows to `{ ...row, ts: new Date(row.ts).toISOString() }`
  (per CLAUDE.md "normalize through new Date(v).toISOString() if the wire contract is ISO").
  Add an int-test assertion that pins the exact ISO string so this can't regress.
```

```
severity: high
file: apps/ingest/src/routes/exports.ts
line: ~300 (transcript route entry mapping: `ts: e.ts`)
issue: Transcript export entries carry the same non-ISO `ts` (inherited from sessionTranscript)
detail: `sessionTranscript` returns `ts` from the same `mode:"string"` plain-column select, so
  the transcript export's per-entry `ts` is also "2026-06-14 00:00:00+00", not ISO — the same
  inconsistency as the events export, surfaced through a different route. (sessionTranscript is
  pre-existing and used by the AI-interpretation path, which does not expose `ts`, so the format
  only becomes observable here.)
suggestion: Normalize in the transcript route's entry map: `ts: new Date(e.ts).toISOString()`
  (keep the fix inside the new export code; do not change shared transcript.ts behavior).
```

```
severity: low
file: packages/db/src/repositories/exports.ts
line: ~58 (doc comment) and ~95 (the gte/lte note)
issue: Comment says the ts range filter is a "lexicographic ISO compare"; it is a real timestamptz compare
detail: `gte(events.ts, start)` emits `"events"."ts" >= $1` against a TIMESTAMPTZ column, so
  Postgres casts the bound to timestamptz and does a true temporal comparison — not a
  lexicographic text compare. The behavior is correct (and the int test proves
  start=00:00:30 → 3 rows); only the comment is misleading.
suggestion: Reword to "Postgres compares the bound as a timestamptz; the route normalizes the
  bound to canonical ISO before binding." Optional.
```

---

## Reviewed and cleared (not issues)

- **`redactJson` masking the sha256 fingerprint via the entropy backstop** — investigated as a
  potential CRITICAL (the entropy pass runs over every string, fingerprints are 64-char hex).
  Empirically measured 100,000 real sha256 hex digests: 0% masked. A 64-char hex sample's
  Shannon entropy tops out at ~3.99 bits/char, always under the 4.0 threshold, so fingerprints
  (and UUID/hex session ids) survive intact. Safe. (A base64 token ≥24 chars WOULD be masked,
  but no export column carries one.)
- **§18 redaction gate** — every payload passes through `redactJson`/`redact`; the transcript
  route is the only decrypt path and redacts each entry immediately. Int test proves a home-path
  username and a transcript `sk-ant-…` secret are masked and absent from every response body.
- **Auth / id guards** — all three routes are admin-gated (→401); `isUuid` screens malformed
  ids (→404); well-formed-unknown project id → 200 empty (M6 semantics). No SQL injection (all
  drizzle-parameterized); no secrets exposed; no `reply.hijack()` (global error handler stays
  active); no new long-lived resources (no teardown/leak-window class).
- **CSV serializer** — RFC-4180 quoting (comma/quote/CR/LF, doubled inner quotes), CRLF rows,
  header-always, column subsetting — covered by unit tests.

---

## Verdict

Two HIGH findings, both the same root cause (a `mode:"string"` timestamp returned in Postgres
text format instead of ISO) on the events and transcript export paths. Fix by normalizing `ts`
to ISO at the data layer (events) and in the transcript route's entry map, and pin the format
with a regression assertion. Everything else passes.
