# Code review — M16 slice 16.3, **second pass** (verification of `0009af5`)

Verifies that the seven findings in
[`m16-slice3-capture-health-scorecard.md`](./m16-slice3-capture-health-scorecard.md) were actually
fixed in the tree, and reviews the fix commit itself for anything it introduced. A table asserting
"Fixed" is a claim about the tree; this is the check.

**Stats (fix commit `0009af5` only):**

- Files Modified: 9
- Files Added: 2 (the pass-1 review + the execution report)
- Files Deleted: 0
- New lines: 642
- Deleted lines: 37

**Validation:**

- `npm run lint` — clean
- Root `tsc -b` / `typecheck:dashboard` / `typecheck:desktop` — 0 errors
- `npx vitest run` (full) — **1470 passed, 159 files**
- `npx vitest run apps/collector packages/shared apps/dashboard` — 682 passed, 77 files
- `grep -rn "connectorState\b" apps/*/src packages/*/src` → **none** (the rename left no stale
  reference; `apps/collector/dist/` still carries the old signature but is build output)
- `grep -n "400s\|400 rather" apps/ingest/src/schemas.ts` → **none** (all three wrong-mechanism
  claims are gone)

---

## Verification of the seven findings

| # | Finding | Fixed | Evidence |
| - | ------- | ----- | -------- |
| 1 | `onError` unguarded in `tickOnce` | **YES** | Both `discover()` and `tickOnce()` now call a private `report()` (`file-watcher.ts:86-95`). New test "survives an onError that throws, and still captures the sibling connector" asserts `tickOnce()` resolves **and** `captured` has length 1 — the sibling assertion, not a bare "does not reject". |
| 2 | Three comments claiming a 400 | **YES** | All three rewritten. The `watchGlobs` comment now states the mechanism correctly (a strip, not a rejection) and adds the actionable inverse: do not disable `removeAdditional` "to harden" it. The deploy-order comment now says the true failure is a 200 with a silently-dropped inventory — milder than a 400 but less visible, and `onError` never fires. |
| 3 | `pollLoop` unguarded reporter | **YES** | `capture-engine.ts:217-227`, with a comment explaining why the quieter failure (absorbed by `allSettled`) is the harder one to diagnose. |
| 4 | Observed-only count beside the panel | **YES** | `monitor-view.tsx:68` → "Connectors seen". The `//` comment sits between JSX attributes, which is the only comment form valid in that position — `tsc --noEmit` on the dashboard confirms it parses. |
| 5 | `required` omitted 3 non-optional fields | **YES** | `custom`, `lastErrorMessage`, `lastErrorAt` added. The int-test fixture (`capture-health.int.test.ts:75-93`) already supplies all three, so the tightening is compatible with the existing suite — to be re-confirmed under `--require-db`. |
| 6 | Prune DELETE lacked `orgId` | **YES** | Shared `machineScope` applied to both branches (`capture-health.ts:135-138`). |
| 7 | Per-connector config re-reads | **YES** | `connectorState` → `connectorStates(registry) => Map`, hoisted identically in `cli.ts:270` and `serve.ts:222`. `cli.test.ts` updated and now also asserts `states.size === registry.length`. |

---

## Review of the fix commit itself

**Code review passed. No technical issues detected** in `0009af5`.

Two observations, neither rising to a finding:

- **`states.get(c.id) ?? { enabled: false, approval: "approved" }`** (`capture-engine.ts:263`) is
  unreachable in practice — the map is built from the same `registry` array it is keyed on, and the
  new `states.size === registry.length` assertion pins that. The chosen fallback surfaces as
  `disabled`, which is itself a mild fabrication ("the operator turned it off") for what would
  actually be a caller bug. It is nonetheless the right choice: the alternative default,
  `enabled: true`, would put a *healthy-looking* row on the scorecard, which is the Risk 2 failure
  the whole slice is built to avoid. Erring toward under-reporting capture is the safe direction
  here.
- **The `connectorStates` rename is a breaking change to an exported option type**
  (`CaptureEngineOptions`), and `apps/collector/dist/capture-engine.d.ts` still advertises the old
  `connectorState`. That is stale build output, not source, and it is regenerated on the next
  build — flagged only so a reader greping `dist/` is not confused. Both in-repo callers were
  converted and the grep above confirms no source reference survives.

## Still outstanding (unchanged from pass 1 — not regressions, and not claimed as done)

- **`npm run repo-health -- --require-db` with 0 skipped.** The DB-backed layer has not been
  executed in either review pass. `skipped ≠ passed`, and finding 5 tightened a JSON Schema that
  only the integration suite exercises end to end, so this gate is load-bearing for this commit
  specifically.
- **The Level-4 manual round-trip** on a deliberately broken connector, with evidence in
  `.agents/qa/m16-signoff/`. This is the milestone's pre-sign-off item assigned to this slice by
  name, and the directory does not exist.
