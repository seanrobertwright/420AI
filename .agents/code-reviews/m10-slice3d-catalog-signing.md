# Code Review — M10 Slice 3D: Catalog Signing

Reviewed: 2026-06-20 · Branch: `m10-slice3d-catalog-signing`

**Stats:**

- Files Modified: 18
- Files Added: 9 (excl. the plan doc; incl. generated migration `0007_*.sql` + `0007_snapshot.json`)
- Files Deleted: 0
- Tracked diff: +236 / −30 lines (new files add ~1.1k source lines + generated snapshot)

**Verdict: Code review passed.** No critical, high, or medium technical defects detected. The slice is
a faithful clone of proven repo patterns (partial-unique single-active index, admin route ladder, DI for
testability, ISO-normalizing row mapper, sibling pure alert deriver). All four plan-mandated review focus
areas verified clean:

- **(a) Private key never committed** — `git status` shows no `.secrets/` entry; `git check-ignore`
  confirms both keys ignored; `*.pem`/`*.key`/`.secrets/` all in `.gitignore`. ✓
- **(b) Re-pricing touches BOTH the insert AND the `onConflictDoUpdate.set`** (`ingest.ts`) — the §23
  re-stamp path is updated, so a replay under the active catalog re-stamps in place. ✓
- **(c) `approveCatalog` transactionality** — demote-active-then-promote-pending runs inside
  `db.transaction`; the partial unique is never momentarily violated at commit. ✓
- **(d) Signer & verifier share ONE `canonicalizeCatalog`** — `scripts/sign-catalog.ts` imports it from
  `@420ai/shared`; no re-implementation. Round-trip proven (bundled key → `true`, tamper → `false`). ✓

Full gate green: `repo-health -- --require-db` PASS, 436 tests, **116 integration tests ran, 0 skipped**.

---

## Low-severity observations (by-design / no change recommended)

```
severity: low
file: packages/db/src/repositories/pricing-catalogs.ts
line: 64 (insertPendingCatalog — onConflictDoNothing on version)
issue: Re-uploading an existing `version` with a DIFFERENT (changed) payload silently keeps the OLD row.
detail: `onConflictDoNothing({ target: version })` keys only on `version`. If an admin edits a rate but
        reuses the same version string, the new payload+signature are dropped and the response returns the
        pre-existing row (whose signature differs from what was POSTed). This is the CONFIRMED design
        (plan D6: version IS the idempotency key — bump the version for new rates), so it is correct, but
        it is a sharp edge for a careless operator.
suggestion: No change for this slice (matches the user-confirmed D6 contract + the int test). If hardening
        later: when a row with the same version but a DIFFERENT signature exists, return 409 Conflict —
        this preserves idempotency for identical re-uploads while closing the silent-drop hole.
```

```
severity: low
file: packages/db/src/repositories/pricing-catalogs.ts
line: ~125 (rejectCatalog sets approvedAt: now)
issue: A rejection stamps `approved_at` (with `approved_by` null).
detail: The column is named for approval but is used here as a generic "decision time". It is documented
        in the function's JSDoc and `approved_by` staying null distinguishes a rejection from an approval,
        so it is unambiguous in practice — only the column NAME is slightly broad.
suggestion: Acceptable as-is (documented). A future schema could rename to `decided_at` or add a dedicated
        `rejected_at`; not worth a migration in this slice.
```

```
severity: low (informational)
file: apps/ingest/src/routes/ingest.ts
line: 16-17 (getActiveCatalog read then ingestBatch — not one transaction)
issue: The active-catalog read and the batch write are separate operations.
detail: A catalog approved between the read and the write would price that one in-flight batch under the
        prior catalog. This is benign: re-pricing is explicitly "going forward" / eventually-consistent
        (plan D1/D3); the next batch picks up the new catalog. The read uses the partial `one_active`
        index (effectively a point lookup), so the extra round-trip is cheap and is once-per-batch (no
        N+1).
suggestion: No change — matches the plan's accepted cost ("ONE extra indexed read per ingest batch").
```

---

## Checks performed (no issue found)

- **Signature verify** never throws on malformed key/sig (try/catch → `false`); ed25519 `null` algorithm
  used correctly; base64 decode is lenient → clean 400, never 500. Covered by unit tests.
- **Canonicalization** is recursive + symmetric across signer/verifier; key-insertion-order independent
  (unit-proven). `undefined`/`null` handled symmetrically — no verify drift.
- **Partial unique `pricing_catalogs_one_active`** (`ON (status) WHERE status='active'`) correctly enforces
  ≤1 active globally; migration `0007` is purely additive (one CREATE TABLE + two indexes, no DROP/ALTER).
- **Re-pricing gate** keys on `e.cost !== undefined && e.tokens && e.model` (D2) — shape-preserving; never
  adds a cost to `usage.reported`/`message.*`. Verified by both int tests (cost re-priced to v2 rate;
  usage row stays `cost IS NULL`).
- **Fingerprint untouched**; no new event type; raw records unchanged; `deriveAlerts` frozen (the §20 alert
  is a sibling `deriveCatalogAlerts`, merged via `sortAlerts`).
- **Auth**: all four endpoints `adminAuthorized` (401); `:id` routes guard `isUuid` → 404 (no Postgres
  uuid-cast 500); ingest stays machine-authed. Bodyless approve/reject correctly take no body schema.
- **§20 firing** rides the existing 3c `reconcileAlertFirings` — opens while pending, resolves when the
  pending queue empties (int-test-proven), acks via the existing route. No new persistence machinery.
- **Library boundary**: `@420ai/shared` + `@420ai/db` repos throw, never log/exit; `scripts/sign-catalog.ts`
  is the only entrypoint that reads argv / logs / exits.
- **Secrets**: no `NEXT_PUBLIC_*` exposure (no dashboard change); admin token never in the catalog payload;
  the signature is a public value (safe to store/return).
- **Line endings**: new + edited files are CRLF, consistent with the existing repo working copy (git
  normalizes to LF on commit) — no inconsistency introduced.
```
```
