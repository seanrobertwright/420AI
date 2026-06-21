# Code Review — M12 Slice 12.5a (Archive-Replay: Retroactive Re-Pricing)

Reviewed the branch `m12-slice5-archive-replay` working tree against `HEAD`.

**Stats:**

- Files Modified: 6 (`SUMMARY.md`, `apps/ingest/src/app.ts`, `docs/guide/operations.md`, `package.json`, `packages/db/package.json`, `packages/db/src/index.ts`)
- Files Added: 5 (`packages/db/src/repositories/reprice.ts`, `packages/db/src/reprice-cli.ts`, `packages/db/src/repositories/reprice.int.test.ts`, `apps/ingest/src/routes/replay.ts`, `apps/ingest/src/replay.int.test.ts`)
- Files Deleted: 0
- New lines: ~59 (tracked diff) + 5 new source/test files
- Deleted lines: 2

## Summary

Code review passed. No technical issues detected (critical/high/medium). One informational
note on a deliberate, documented scaling trade-off — no action required for this slice.

The change is tightly scoped and additive: a single repo function, a thin admin-gated route,
a CLI entrypoint, two integration tests, plus barrel/registration/script/doc wiring. It mirrors
proven existing patterns (`reencryptAll`/`rotate-key-cli.ts` for the batched loop + entrypoint,
`metrics.ts`/`catalog.ts` for the admin gate, `ingestBatch` D2 for re-price semantics) byte-for-byte.

## Verification performed

- `npx tsc -b` → exit 0 (root backend typecheck, 4 workspaces).
- `npx vitest run packages/db/src/repositories/reprice.int.test.ts` → 2 passed, 0 skipped.
- `npx vitest run apps/ingest/src/replay.int.test.ts` → 3 passed, 0 skipped.
- `npm run repo-health -- --require-db` → PASS, 512 tests, **141 integration tests ran, 0 skipped**.
- `db:reprice` CLI smoke → throws the intended "no active catalog to re-price under" and closes the pool.

## Correctness checks (all clear)

- **Loop termination / progress:** each `UPDATE` stamps `catalogVersion = catalog.version`, so the
  updated row no longer satisfies `catalog_version IS DISTINCT FROM <version>` and is excluded from
  the next `SELECT`. Guaranteed forward progress; no infinite-loop risk. (Proven by the idempotency
  test returning `repriced: 0` on a second run.)
- **NULL-`catalog_version` inclusion:** `IS DISTINCT FROM` (not `<>`) correctly includes pre-replay
  rows. The classic `<>` NULL-exclusion trap is avoided and explicitly tested (`rp-a`).
- **Shape-preserving:** `isNotNull(events.cost)` in the predicate guarantees a costless event
  (`usage.reported`) never gains a cost — verified by `rp-d` staying `NULL`.
- **TS narrowing:** `r.tokens!` and `r.model ?? undefined` are safe — both columns are WHERE-guarded
  `isNotNull`. `computeCost` is a pure function (never throws).

## Security checks (all clear)

- **No SQL injection:** `catalog.version` is bound as a parameter inside the drizzle `sql` template
  (`${catalog.version}`), not raw-interpolated. The rest of the query is the typed query builder.
- **Admin gate:** `POST /v1/replay/reprice` is gated by `adminAuthorized` (constant-time bearer +
  HMAC session) before any DB access — same gate as the other 12 admin routes. 401 on missing/bad
  bearer, 409 when no catalog is active.
- **No secret exposure:** no tokens/keys logged or returned; the library function never logs
  (CLAUDE.md "Logging / process boundaries"); only the route/CLI entrypoints log.

## Convention adherence (all clear)

- Relative imports end in `.js`; `import type` used for type-only imports (`ModelPricing`, `Db`,
  `FastifyInstance`, `IngestBatch`).
- Library (`reprice.ts`) throws and never writes stdout/stderr; the CLI and route are the only
  entrypoints (log/exit), matching the codebase boundary rule.
- Route registered after `catalogRoutes` and imported alongside it, per the plan.
- Fingerprint untouched, no schema migration, no existing call site modified — invariants held.

## Informational note (no action required)

```
severity: low (informational)
file: packages/db/src/repositories/reprice.ts
line: 22
issue: The entire events sweep runs inside one db.transaction.
detail: At a very large archive size this holds a single long-lived transaction for the whole
        re-price pass. This is a deliberate, documented trade-off (NOTES "One transaction for the
        whole events sweep") and is identical to the already-shipped reencryptAll (12.4e) precedent.
        Acceptable at single-user self-hosted scale.
suggestion: None for this slice. If the archive later outgrows a comfortable single-transaction
        size, re-chunk the loop into per-batch transactions (the select→update structure already
        supports this with no semantic change). Noted, not done — matches the plan.
```

## Resource-teardown audit

No long-lived resources introduced: the route is a plain request→response handler (no
`setInterval`/`setTimeout`/SSE/listener/upstream proxy `fetch`); the CLI closes its pool in a
`finally`. No leak window to arm.
