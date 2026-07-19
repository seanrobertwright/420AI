# Code Review — M14 Slice 14.4: Per-event search granularity

Reviewed commit: `d07f3fa` on branch `m14-slice4-per-event-search` (against `main` @ `339f0fc`).

**Stats:**

- Files Modified: 10
- Files Added: 3
- Files Deleted: 0
- New lines: 2591
- Deleted lines: 72

(2225 of the added lines are the auto-generated drizzle-kit schema snapshot
`packages/db/drizzle/meta/0013_snapshot.json` — not hand-written logic.)

## Scope

Adds per-message / per-tool-call rows to `search_documents` alongside the existing
per-session rows (hybrid), grouped by session in the dashboard UI. Reviewed files:

- `packages/shared/src/search.ts`
- `packages/db/src/schema.ts`
- `packages/db/drizzle/0013_married_tarot.sql` + `down/0013_married_tarot.down.sql`
- `packages/db/src/repositories/search.ts`
- `apps/ingest/src/schemas.ts`
- `apps/dashboard/src/components/search/search-view.tsx`
- `packages/db/src/repositories/search.int.test.ts`, `apps/ingest/src/search.int.test.ts`
- `packages/db/src/rollback.int.test.ts` (collateral: migration `0013` is now latest)

## Verification performed

- Re-read every changed file in full (not just the diff).
- Re-ran `npm run typecheck`, `typecheck:dashboard`, `build:dashboard`, `npm test`
  (757 passed), `npm run repo-health -- --require-db` (186 integration tests, 0
  skipped), `npm run lint`, `npx prettier --check`. All green — see execution
  report for the transcript.
- Manually exercised the live UI (paired a machine, ingested a session with a
  secret, verified: hybrid session+event grouping renders correctly, `type=event`
  filter narrows and synthesizes a session-id-only header, the secret is redacted
  everywhere, `ADMIN_TOKEN` never appears in the served HTML — grep count 0).
- Grepped the diff for `console.`/`TODO`/`FIXME`/`debugger` — none found.
- Traced the `(entity_type, entity_id)` upsert target, the redact-then-store gate,
  and the `events ⋈ raw_source_records` join against `transcript.ts` — all match
  the established pattern exactly.

## Findings

severity: low
file: packages/db/src/repositories/search.ts
line: 186-230
issue: `indexSessionEvents` re-decrypts and re-upserts a session's ENTIRE indexed-event history (up to 500 rows) on every incremental touch, not just newly-added events
detail: Every call to `indexOneSession` (triggered on every ingest that touches a session) re-runs the full `events ⋈ raw_source_records` scan for that session and re-decrypts + re-upserts every matching event doc, even ones already indexed with unchanged content. For an actively-syncing session with many small incremental ingests, this is O(session event count) decrypt+upsert work repeated on every sync rather than only the delta, so cumulative cost across a session's lifetime trends toward O(n²) in its event count. This exactly mirrors the pre-existing behavior of the session body itself (`indexOneSession` already re-decrypts and re-concatenates every raw record for the session on every touch, capped at `SESSION_BODY_MAX_CHARS`), so it is not a new architectural pattern — 14.4 extends an already-accepted tradeoff to a second decrypt path. The plan's own "Index-size / reindex-cost mitigation" notes call this out explicitly as "a perf, not correctness, concern — caps in place," and `upsertDoc` is a pure idempotent upsert so there is no correctness impact, only extra DB round trips bounded by `MAX_EVENT_DOCS_PER_SESSION` (500).
suggestion: No action needed for this slice — behavior matches the existing session-doc convention and is explicitly bounded. If reindex cost becomes a measured problem in production, a future slice could track a per-session high-water mark (e.g. last-indexed event `ts`) and only decrypt/upsert events newer than it, mirroring how the collector's cursor-based sync avoids re-reading already-synced lines.

## Verdict

No critical, high, or medium issues. One low-severity, already-accepted performance
tradeoff noted above for visibility (matches existing codebase convention, bounded
by caps, explicitly discussed in the plan). Redaction gate, fingerprint invariant,
upsert idempotency, XSS-safety of the new UI rendering path, and the `(entity_type,
entity_id)` uniqueness target are all intact and verified live.
