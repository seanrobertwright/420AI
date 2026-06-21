# Code Review — M12 Slice 12.7c (Connector-catalog-as-data, §10.4)

Reviewer: automated technical review (post-implementation, pre-commit)
Branch: `m12-slice7-connector-hardening`
Date: 2026-06-21

## Stats

- Files Modified: 19
- Files Added: 11
- Files Deleted: 0
- New lines: ~466 (+ 11 new files)
- Deleted lines: ~56

## Scope reviewed

Generalized ed25519 signer (`catalog-signing.ts`), new `connector-catalog.ts` (types + bundled
key/baseline + pure `mergeConnectorCatalog`), `connector_catalogs` table + migration `0011` + repo,
five ingest endpoints (`routes/connector-catalog.ts`), collector cache/pull
(`connector-catalog-cache.ts`), registry overlay (`registry.ts`), entrypoint wiring
(`cli.ts`/`serve.ts`), offline signer (`sign-catalog.ts`), and docs.

---

## Issues found (2 — both FIXED in this pass)

```
severity: medium
file: apps/collector/src/connectors/connector-catalog-cache.ts
line: 111 (fetchActiveConnectorCatalog)
issue: the awaited startup pull had no request timeout
detail: `runWatch` AWAITS fetchActiveConnectorCatalog before capture starts. The bare global
        fetch has no default timeout, so a HUNG connection (a silent firewall drop, or a server
        that accepts the socket but never replies) would block capture startup indefinitely —
        violating the slice's offline-first guarantee ("capture must start even if the fetch
        fails"). A refused connection fails fast, but a hang does not.
suggestion: bound the request with AbortSignal.timeout(timeoutMs ?? 5000); the existing catch
        turns the abort into undefined → cache → baseline.
status: FIXED — added `timeoutMs` (default 5000) + `signal: AbortSignal.timeout(...)`, plus a
        unit test ("a HUNG request is aborted after timeoutMs ⇒ undefined") driving an injected
        fetch that only settles on abort.
```

```
severity: low
file: scripts/CATALOG-SIGNING.md
line: 147 (connector-catalog JSON example)
issue: example overrode a built-in's watchGlobs with `~`-relative globs
detail: the watcher does NOT expand `~` (documented in custom-connectors.md), and a `watchGlobs`
        override resolves to an ABSOLUTE, machine-specific path — yet the connector catalog is a
        GLOBAL document applied to every machine. The example implied portable `~` expansion that
        does not happen, and would silently watch the literal `~/...` path.
suggestion: drop the watchGlobs override from the built-in example (override portable fidelity/
        permissions instead) and add a callout that watchGlobs overrides are absolute + not
        `~`-expanded + machine-specific.
status: FIXED — example now overrides only `requiredPermissions` on the built-in; added the
        absolute/machine-specific callout. (The data-only entry keeps its absolute glob, which is
        correct.)
```

---

## Verified correct (no action)

- **Backward-compatible signer generalization.** `CatalogContent<P = Record<string, ModelPricing>>`
  default keeps all pricing call sites + `catalog-signing.test.ts` byte/type-identical (typecheck +
  the pricing int suite both pass). `canon` bytes unchanged ⇒ existing signatures still verify.
- **Leaf-dependency discipline.** `mergeConnectorCatalog` operates on a structural `ConnectorLike`
  (mirrors the established `ConnectorInfo` pattern) and takes an injected `compileCustom`, so
  `@420ai/shared` never imports `apps/collector`. The generic `<C extends ConnectorLike>` + object
  spread preserves `parse`/`discoverRoots` on real connectors (decision A — parsers stay code);
  verified by the "parser preserved" registry test.
- **Default-on / regression guarantee.** `mergeConnectorCatalog(reg, undefined, …)` returns the
  registry unchanged; `loadRegistry` with no catalog is byte-identical to today (explicit regression
  test). `stripUndefined` ensures a partial fidelity overlay never clobbers a base field with
  `undefined`.
- **Server lifecycle is a faithful pricing mirror.** Idempotent insert (`onConflictDoNothing` by
  version), demote-before-promote approve txn, partial-unique ≤1-active, Date→ISO `toRow`. Int test
  proves the ≤1-active invariant and idempotency against a real DB (0 skipped).
- **Auth ladder.** 4 admin endpoints (`adminAuthorized` → bad sig 400 → `isUuid` 404 → repo
  undefined 404); the 5th (`/active`) is the ONLY machine-authed one (`app.authenticate`), returning
  204 when none active. Verified by the endpoint int test (401 non-admin, 401 bad machine token, 400
  tampered sig, 404 bad id, 204 none, 200 + signature on active).
- **Defense-in-depth signature re-verify.** The active endpoint ships the `signature`; the collector
  re-verifies against the bundled key both on pull and on cache-load — a tampered cache file is
  ignored (unit tests for tamper + wrong-key + corrupt).
- **Leak-window compliance (serve.ts).** The cached catalog is read SYNCHRONOUSLY before the Promise
  executor arms listeners/timer; the async refresh is fired AFTER `cleanupAndExit` is armed
  (one-shot promise, not a timer/stream — no leak), guarded by `closed` against a late write/log, and
  gated to production (`!deps.connectorRegistry`) so the serve tests never run a network call.
- **Migration rollback coverage.** `down/0011` drops the table; `rollback.int.test.ts` was retargeted
  from the stale `0010` pin to roll back `0011` and assert `connector_catalogs` is dropped + restored.
- **No secrets exposed.** Only the ed25519 PUBLIC key is bundled; the private key lives in gitignored
  `.secrets/` (`*.pem`, `.secrets/` are gitignored — confirmed). No NUL bytes / binary files staged.

---

## Gate results (post-fix)

- `npm run typecheck` → exit 0
- `npm run lint` → exit 0
- `npm run format:check` → all files use Prettier style
- `npm run repo-health -- --require-db` → PASS (588 tests; 158 integration tests ran, 0 skipped)

**Verdict: APPROVED.** Two issues found and fixed in-pass; no remaining technical blockers.
