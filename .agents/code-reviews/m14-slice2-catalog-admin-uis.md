# Code Review — M14 Slice 14.2 (Catalog admin UIs)

**Reviewed:** working tree on branch `m14-slice2-catalog-admin-uis` vs `HEAD`
**Date:** 2026-07-16
**Scope:** dashboard-only additive slice (connector-catalog approve/reject UI + pricing-catalog
upload UI). Zero backend change.

## Stats

- Files Modified: 5 (`api/catalog/route.ts`, `catalog/page.tsx`, `components/catalog/catalog-view.tsx`,
  `lib/types.ts`, `scripts/CATALOG-SIGNING.md`)
- Files Added: 7 — 6 code (`api/connector-catalog/route.ts`,
  `api/connector-catalog/[id]/approve/route.ts`, `api/connector-catalog/[id]/reject/route.ts`,
  `components/catalog/catalog-upload.tsx`, `lib/signed-catalog.ts`, `lib/signed-catalog.test.ts`)
  + 1 plan (`.agents/plans/m14-slice2-catalog-admin-uis.md`)
- Files Deleted: 0
- New lines: ~200 in modified files + ~259 in new code files (11 new unit tests)
- Deleted lines: 87 (the `catalog-view.tsx` single-table → generic two-section refactor)

## Result

**Code review passed. No technical issues detected.**

All automated gates are green with evidence (root `tsc -b` 0; `typecheck:dashboard` 0;
`next build` 0; `repo-health --require-db` PASS — 754 tests, 183 integration ran / 0 skipped;
`eslint .` 0; `prettier --check` 0). The review below records the correctness questions that were
traced to ground and cleared, so a future reader doesn't re-open them.

## Verified non-issues (traced, not assumed)

1. **Re-serialization of the signed upload cannot break signature verification.**
   `catalog-upload.tsx:44` submits `JSON.stringify(parsed.doc)` — the *parsed-then-restringified*
   document, not the raw pasted text. This is safe **only because** ingest re-verifies the ed25519
   signature over a **recursive canonical serialization** of `payload` (M10 slice 3d,
   `@420ai/shared/catalog-signing.ts`), so key reordering / whitespace changes from the JSON
   round-trip are irrelevant. Confirmed the server is the integrity gate; the client parse is a
   convenience pre-check only (`signed-catalog.ts` header comment states this explicitly). No
   signature-breakage risk.

2. **`formatDate` handles the nullable `approvedAt`.** `catalog-view.tsx:113` calls
   `formatDate(c.approvedAt)` where `approvedAt: string | null`. `lib/format.ts:34-37` returns
   `"—"` on `null`/unparseable input — no "Invalid Date" render. (Behavior is identical to the
   pre-refactor view, which already did this.)

3. **Shared `STATUS_BADGE` / generic `CatalogTable` are type-sound across both row types.**
   `CatalogTableRow.status` is typed `PricingCatalogRow["status"]`; `ConnectorCatalogRow.status` is
   the same `"pending" | "active" | "superseded" | "rejected"` union, so the connector rows spread
   in (`...c`) with no widening. Extra fields (`payload`, `signature`) on the spread are harmless
   under structural typing. `tsc --noEmit` confirms.

4. **Entry-count column does not trust the permissive server schema.**
   `catalog-view.tsx:188-190` guards `Array.isArray(c.payload.connectors)` before `.length`
   rather than assuming the array exists — correct defensive read of a signed-but-not-shape-enforced
   payload.

5. **Proxy discipline intact — token never in the browser.** All three new connector-catalog
   routes and the upload POST go through `proxyJson`, which adds the admin bearer on the
   server→ingest hop only (`lib/proxy.ts`). The upload form POSTs same-origin `/api/catalog` with
   no auth header. `grep`-in-served-HTML == 0 is the Level-4 manual assertion; structurally there is
   no `NEXT_PUBLIC_*` token and no client-side header.

6. **Upstream status is forwarded, not collapsed.** `proxyJson` passes 400 (bad signature) / 404
   (non-pending id) through verbatim; the upload form maps 400 → ingest's `error` message inline,
   and the table maps 404 → "No longer pending." Only an unreachable hop becomes 502 → "Ingest
   unreachable." Matches the mutation-discipline pattern in `alerts-panel.tsx`.

7. **Idempotent re-upload shows the real status.** `catalog-upload.tsx:59-62` reads the returned
   row's `status` rather than assuming `"pending"`, so re-uploading an already-active version
   surfaces `active` (ingest returns the existing row on a version match).

8. **No new long-lived resources.** The slice uses only one-shot request/response `fetch`es — no
   SSE, `setInterval`, listeners, or proxied streams — so the M9 teardown-before-first-`await`
   discipline is not triggered. `grep` for `setInterval|setTimeout|EventSource|addEventListener|new
   ReadableStream` in the new files == none.

## Standards adherence

- ESM `.js` import specifiers, `import type` for type-only (`ConnectorCatalogPayload`,
  `NextRequest`), `kebab-case.ts` filenames, `force-dynamic` per route file — all consistent with
  the dashboard conventions.
- New pure helper (`parseSignedCatalogText`) is dependency-free and unit-tested co-located
  (`signed-catalog.test.ts`, 11 cases incl. array/null payload, empty fields) — mirrors the
  `snippet.ts` precedent named in the plan.
- Scope guard held (D-M14-3): connector-catalog **upload** stays CLI-only; only pricing gained a
  dashboard upload form. Comment in `api/connector-catalog/route.ts` documents the deliberate
  omission.

## Recommendation

Ship. No fixes required. Remaining item is the Level-4 manual live-stack check (render both
sections, approve/reject round-trip, corrupt-upload 400, token-in-HTML == 0) — a maintainer
pre-sign-off step, not a code defect.
