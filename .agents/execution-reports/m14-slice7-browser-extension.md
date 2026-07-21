# Execution Report — M14 Slice 14.7 (Browser Extension + collector `push` capture mode)

## Meta Information

- **Plan file:** `.agents/plans/m14-slice7-browser-extension.md`
- **Branch:** `m14-slice7-browser-extension` · **Commits:** `5bbbcbc` (feature), `66ef18d` (review fixes)
- **Files added (17):**
  - `packages/shared/src/parsers/claude-wire.ts`
  - `packages/shared/src/parsers/claude-wire.test.ts`
  - `packages/shared/src/parsers/fixtures/sample-claude-wire.json`
  - `apps/collector/src/push/push-token.ts`
  - `apps/collector/src/push/push-token.test.ts`
  - `apps/collector/src/push/push-server.ts`
  - `apps/collector/src/push/push-server.test.ts`
  - `apps/collector/src/connectors/claude-live.ts`
  - `apps/extension/package.json`, `manifest.json`, `.gitignore`, `README.md`
  - `apps/extension/src/background.js`, `options.html`, `options.js`
  - `docs/research/extension-spike.md`
  - `.agents/code-reviews/m14-slice7-browser-extension.md`
- **Files modified (13):**
  - `packages/shared/src/index.ts`, `packages/shared/src/connector-catalog.ts`
  - `apps/collector/src/capture-engine.ts`, `cli.ts`
  - `apps/collector/src/connectors/connector.ts`, `connector-approvals.ts`
  - `apps/collector/src/connectors/connector.test.ts`, `connector-approvals.test.ts`
  - `eslint.config.js`, `scripts/repo-health.mjs`
  - `README.md`, `SUMMARY.md`, `.agents/plans/m14-general-ai-chat-capture.md`
- **Lines changed:** +2674 / −16 (across both commits)

## Validation Results

- **Syntax & Linting:** ✓ `npm run lint` (eslint .) → 0 errors
- **Formatting:** ✓ `prettier --check` on all changed files clean (the 4 `apps/desktop/src-tauri/gen/schemas/*.json` warnings are gitignored generated artifacts, absent in a fresh CI clone; `.agents/**` is Prettier-ignored)
- **Type Checking:** ✓ root `tsc -b` = 0 errors; dashboard + desktop `tsc --noEmit` lanes = 0
- **Unit Tests:** ✓ 794 passed / 0 failed (added 26: claude-wire 12, push-token 4, push-server 8→then 14 incl. review test, approvals +2, connector.test +1)
- **Integration Tests:** ✓ `repo-health --require-db` → **186 integration tests ran, 0 skipped** against a real Postgres (both `420ai` and `420ai_test` migrated). `skipped ≠ passed` bar met.

## What Went Well

- **The "additive over proven seams" thesis held exactly.** The receiver reuses `connector.parse` +
  `queue.enqueue`; the parser reuses `eventFingerprint`/`NormalizedEvent`; the engine wiring mirrors
  `pollLoop`'s best-effort/abort lifecycle. Zero change to the fingerprint, queue schema, ingest wire,
  or migrations — so the DB-backed gate had a clean path to green with no schema churn.
- **`parseClaudeWire` as a near-clone of `parseClaudeExport`** made the parser fast and low-risk; the
  only real delta (stamp conversation `model` on assistant events) was a two-line change and is
  directly tested.
- **Leak-window discipline transferred cleanly** from `abortableDelay`/`pollLoop`: arm the abort
  listener before `listen`, resolve on `close`/`error`, remove the listener on every path. The
  abort + already-aborted tests prove prompt teardown.
- **Real-HTTP tests over `fetch`** (not mocks) gave genuine receiver evidence — asserting status
  codes AND queue depth (dedup) — which made the optional Level-5 curl smoke redundant.

## Challenges Encountered

- **The `captureMode` union is duplicated in two places.** Adding `"push"` to `connector.ts` broke
  `tsc` at `connector-catalog.ts`'s structural `ConnectorLike` (and its `CatalogConnectorEntry`
  override), which mirror the union for the catalog-overlay engine. Fixed by widening both. Not in the
  plan's file list — found only because the root `tsc -b` covers cross-project types (the exact reason
  the plan mandates root typecheck as Level 1).
- **The extension is plain JS in `src/`, which two guardrails assume is TypeScript-only.** ESLint
  flagged `chrome`/`document` as undefined, and repo-health's stray-artifact scan flagged
  `src/*.js` as "emitted build output." Both are the same underlying reality — the MV3 extension is a
  non-TS workspace out of the root graph, like the dashboard — and both got a scoped, documented
  exception (ESLint override on `apps/extension/**/*.js`; a `plainJsSrcWorkspaces` skip in the scan).
- **`BodyInit` isn't in the collector's TS lib** (no DOM lib) — a test helper typed a `fetch` body as
  `BodyInit` and failed `tsc` though vitest ran fine. Narrowed to `string`. A reminder that per-test
  green ≠ typecheck-green; the root `tsc -b` is the real gate.

## Divergences from Plan

**Two guardrail files edited that the plan did not enumerate**

- Planned: the "New files NOT to touch" list named `serve.ts`, the root `tsconfig` references, and
  the fingerprint — but did not anticipate `eslint.config.js` or `scripts/repo-health.mjs`.
- Actual: both were edited to accommodate the plain-JS extension workspace (browser globals; artifact
  scan exclusion).
- Reason: the plan correctly kept the extension out of the root `tsc` graph but did not trace the two
  *other* repo-wide guardrails (ESLint, the artifact scan) that also assume TS-only workspaces.
- Type: Plan assumption incomplete (the "out of the TS graph" precedent needed two more exceptions).

**`connector-catalog.ts` union widened**

- Planned: not mentioned.
- Actual: `ConnectorLike.captureMode` and `CatalogConnectorEntry.captureMode` widened to include `"push"`.
- Reason: the catalog-overlay engine has its own structural mirror of the connector `captureMode`
  union; adding `"push"` upstream requires it downstream for `tsc` to pass.
- Type: Plan assumption incomplete (a duplicated union the plan's symbol survey didn't flag).

**Two hardening fixes from code review (post-commit)**

- Planned: n/a (surfaced by `/lril:code-review`, per gate 4.5).
- Actual: (1) swallow response/request socket `'error'` in the receiver so a client disconnect
  mid-response can't crash it; (2) reject an empty configured token in `authOk`.
- Reason: the "never crashes on a bad request" invariant needed the disconnect path closed; the
  empty-token guard is defense-in-depth.
- Type: Security/robustness concern (correctly caught by the review gate, not by `tsc`/tests — the
  exact class the plan says `/lril:code-review` exists to catch).

## Skipped Items

- **Level 4 — manual Chrome load-unpacked end-to-end** (`browser → collector → archive → Monitor`).
  Deferred to a **maintainer pre-sign-off step**, as the plan explicitly permits ("or noted as a
  maintainer pre-sign-off step if a live Chrome isn't available"). Rationale: the claude.ai API shape
  the extension depends on was already proven live during planning (recon in the plan NOTES), and the
  receiver pipe is fully covered by real-HTTP tests + the DB-backed gate. No automated gate is blocked.
- **Level 5 — standalone curl smoke** (optional). Skipped as redundant: the vitest suite already
  drives `runPushServer` over real HTTP (`fetch`), asserting status codes and queue state.
- Everything explicitly out of scope in the plan (ChatGPT/Gemini extension origins, SSE interception,
  cross-connector dedup, signed Web Store distribution) remains deferred and documented in the gate.

## Recommendations

- **Plan command:** when a plan adds a value to a union type, its symbol survey should grep for
  *structural mirrors* of that union (here `ConnectorLike` in `connector-catalog.ts`) and for the
  *repo-wide guardrails* keyed on it (ESLint envs, the artifact scan) — not just the primary
  definition. A new plain-JS/non-TS workspace should list ESLint + artifact-scan exceptions alongside
  the tsconfig-exclusion it already calls out.
- **CLAUDE.md:** the "Frontend workspace" section documents the dashboard's tsc-graph exclusion; a
  one-line note that a **plain-JS workspace also needs an ESLint globals override AND a repo-health
  artifact-scan exclusion** would pre-empt the two guardrail edits this slice discovered.
- **Execute command:** the practice of running root `tsc -b` (not per-workspace) immediately after a
  cross-cutting type change caught the `connector-catalog` mirror early — worth keeping as the first
  reflex after any shared-type edit.
