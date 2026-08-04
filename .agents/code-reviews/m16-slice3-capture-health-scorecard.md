# Code review — M16 slice 16.3, capture health scorecard

Reviewed against `.agents/plans/m16-slice3-capture-health-scorecard.md` (acceptance criteria at
§ACCEPTANCE CRITERIA) and `CLAUDE.md`. Commit `60eec90` on
`m16-slice3-capture-health-scorecard`.

**Stats:**

- Files Modified: 31
- Files Added: 16
- Files Deleted: 0
- New lines: 9346 (5,065 of which are the plan document itself)
- Deleted lines: 158

**Validation run during review:**

- `npx vitest run` over the seven slice unit files — **84 passed**
- `npm run lint` — clean
- `npm run repo-health:fast` — PASS (root `tsc -b`, dashboard and desktop lanes all 0 errors)
- Integration suites not run in this pass (no `DATABASE_URL_TEST` in the review shell); they are
  the pre-push gate's job (`--require-db`).

**Acceptance-criteria greps (plan Level 5):**

- `grep -rn "function mapConnectorInfo" apps/collector/src` → **1** (extraction left no second copy)
- `grep -c "filterConnectors\|filterByApproval" apps/collector/src/cli.ts` → **3** (F-16.3-1 fixed at
  the call site, not merely importable)
- `watchGlobs` appears in the wire type, the table and the heartbeat schema **only in comments
  explaining its exclusion** — D-16.3-3 holds at the type level, the schema level and the DB level.

---

## Summary

This is unusually strong work. The DECLARED × OBSERVED split is the right decomposition, the two
"cannot tell" states are genuinely first-class rather than decorative, the two timestamp mechanisms
are correctly distinguished ten lines apart with the distinction written down, and the `0025`
migration's hand-appended policy block matches the `0024` template exactly. The
`Omit<ConnectorInfo, "watchGlobs">` privacy boundary is enforced in three independent places. The
plan's own anti-pattern list was followed — no integer literal was edited in `rls.int.test.ts`, the
join is on `machine_id`, the route uses `principal.role`, and the comment explicitly refuses to
claim the org predicate is what makes the join correct.

Seven findings, of which three matter.

**Two are real defects in the error path of the very fix this slice exists to make** (F-16.3-2), and
they share one shape: an error *reporter* that can itself throw, unguarded, inside a `catch`.
`heartbeat.ts` guards exactly this case and says why; the other two sites do not.

**One is a comment that names the wrong mechanism** — three of them, in fact, asserting a 400 that
the slice's own integration test measured as a 200-with-strip. SUMMARY.md and `data-boundary.md`
were both corrected; `schemas.ts` was not. CLAUDE.md's 15.5 rule treats this as a defect in its own
right, and this slice's F-16.3-2 write-up makes the same argument about the file-watcher header.

---

## Findings

```
severity: high
file: apps/collector/src/watcher/file-watcher.ts
line: 91
issue: `onError` is called unguarded inside `tickOnce`'s per-file catch, so an error reporter that throws re-kills the whole capture engine — the exact F-16.3-2 failure, reached through the error path.
detail: The catch at 88-94 is the mechanism the slice's headline fix depends on, and the header
  comment (lines 20-34) states that a per-file failure is now reported "rather than unwinding the
  whole engine". But `this.deps.onError?.(connector, err)` is the last statement in the catch and is
  not itself guarded. The wired handler is `recordConnectorError` (capture-engine.ts:239-242), which
  performs a `node:sqlite` write and then `log(...)`. A sqlite write is not infallible — a locked or
  full `queue.sqlite`, or a closed handle during shutdown, throws. When it does, `tickOnce` rejects,
  `runLoop` rejects, `Promise.race([watcherLoop, syncLoop])` rejects, and every connector stops
  capturing. That is F-16.3-2 restored, now reachable only when a connector is ALREADY failing —
  i.e. precisely when the scorecard is supposed to start working.
  VERIFIED, not inferred: a scratch test built a `FileWatcher` whose `onError` throws
  "queue.sqlite is locked" and asserted `tickOnce()` rejects with it. It passed on the first run.
  `heartbeat.ts:80-86` already recognises this exact hazard for its own `onError` and wraps it,
  commenting "an observer that throws must not become the failure it was reporting". The same
  reasoning applies here with more force, because here the blast radius is the whole engine rather
  than one skipped ping.
suggestion: Wrap the reporter, mirroring heartbeat.ts:
    } catch (err) {
      try {
        this.deps.onError?.(connector, err);
      } catch {
        /* an error reporter that throws must not become the outage it was reporting (F-16.3-2) */
      }
    }
  Same treatment for the `discover()` catch at line 77, which has the identical shape. Pin it with a
  test in `file-watcher.test.ts` asserting `tickOnce()` RESOLVES when `onError` throws and that a
  sibling file is still captured — the sibling assertion is what makes it a real F-16.3-2 pin rather
  than a "does not reject" tautology.
```

```
severity: high
file: apps/ingest/src/schemas.ts
line: 130
issue: Three comments in the heartbeat schema state that `additionalProperties: false` produces a 400. The slice's OWN integration test proves it does not — ajv strips and returns 200 — and SUMMARY.md records the correction. The source comments were left behind.
detail: `apps/ingest/src/capture-health.int.test.ts:285-292` and `:324-331` document and pin the
  measured behaviour: "Fastify configures ajv with `removeAdditional: true` by default, so
  `additionalProperties:false` STRIPS an undeclared property instead of rejecting the body." SUMMARY
  and `docs/guide/data-boundary.md` both say the same. But `schemas.ts` still carries the pre-
  measurement belief in three places:
    - :126 (pre-existing, M12 12.6) "additionalProperties:false means it MUST be declared or a
      sender 400s."
    - :130 (NEW in this slice) "a NEWER collector posting this to an OLDER server 400s the ENTIRE
      heartbeat, and `maybeSendHeartbeat` swallows the failure — the machine then goes `offline`…"
    - :157 (NEW in this slice) "a collector that sent them would 400 rather than leak them."
  This is the CLAUDE.md 15.5 defect class stated verbatim — "a comment naming the wrong mechanism is
  worse than no comment, because the next reader trusts it instead of re-deriving it" — and it is
  the same failure the slice's own F-16.3-2 write-up calls out ("the comment claiming otherwise IS
  the defect"). It matters concretely in two ways. First, :157 asserts a SECURITY property that does
  not hold as described: `watchGlobs` are excluded because ajv *strips* them, so the protection is
  real but the mechanism is the opposite of what is written, and someone who later sets
  `removeAdditional: false` to "make validation stricter" would silently convert a strip into a 400
  and think they had hardened the leak. Second, :130 misstates the deploy-order hazard in the safer
  direction — the true failure of a newer collector against an older archive is a **200 with the
  inventory silently dropped**, which is *harder* to notice than a 400, not easier, and is exactly
  the silent capture-health failure this slice exists to end.
suggestion: Rewrite all three to the measured behaviour, and say what the residual hazard actually
  is. Something like: "`additionalProperties:false` does NOT reject here — Fastify's ajv runs
  `removeAdditional: true`, so an undeclared property is STRIPPED and the request succeeds with 200
  (measured, `capture-health.int.test.ts`). A newer collector against an older archive therefore
  loses its inventory silently rather than 400ing, which is milder but LESS visible — the `onError`
  seam does not fire, so the archive-before-collector deploy order is what protects this, not the
  schema." Fix :126 in the same pass; it is pre-existing but it is the sentence the two new ones
  were copied from.
```

```
severity: medium
file: apps/collector/src/capture-engine.ts
line: 201
issue: The same unguarded-reporter shape in `pollLoop`'s best-effort catch silently kills one connector's poll loop forever.
detail: `opts.onError?.(opts.connector, err)` sits inside the catch whose comment now reads "it is no
  longer INVISIBLE ... a best-effort/swallow path is the worst place to lose a signal". If the
  reporter throws, the `while` loop's promise rejects. The blast radius is smaller than the watcher's
  because `pollLoops` are absorbed by `Promise.allSettled` at line 355 rather than joining the race —
  but that is what makes it worse to diagnose: Cursor's polling stops permanently, the engine keeps
  running, the heartbeat keeps flowing, the machine stays `online`, and the connector renders `idle`
  or `silent` rather than `erroring`. A capture failure that presents as "no work happened" is
  exactly the confusion this slice was built to end.
suggestion: Same `try { opts.onError?.(...) } catch {}` guard. Consider extracting one shared
  `reportSafely(fn)` helper in `capture-engine.ts` and wiring `recordConnectorError` through it once,
  so the three call sites cannot drift.
```

```
severity: medium
file: apps/dashboard/src/components/monitor/monitor-view.tsx
line: 68
issue: The summary tile still shows an OBSERVED-only connector count directly above a panel whose entire thesis is that observed-only counts are misleading.
detail: `connectors.length` comes from `snapshot.connectors`, i.e. `connectorHealth` — the
  `GROUP BY events.source_connector` projection the slice documents as unable to see a
  declared-but-broken connector (spike S3). The old Connectors card was replaced for exactly that
  reason, but the DataCard field survived the replacement. The result is two connector counts on one
  screen with different denominators: a broken connector is in neither, a disabled one is in the
  panel but not the tile, and an `unreported` one is in both. D-16.3-1 rejects rebuilding the
  windowed failure rate specifically to avoid "two independently-derived numbers on one screen"; this
  is the same problem in a smaller box.
suggestion: Either drop the field, or label it for what it is ("Connectors seen"), or feed the tile
  from the capture-health snapshot's row count. Dropping it is cleanest — the panel below already
  carries a per-verdict summary row, which is strictly more informative.
```

```
severity: low
file: apps/collector/src/cli.ts
line: 270
issue: The `connectorState` thunk re-reads `connectors.json` and `approvals.json` from disk once per connector, per heartbeat.
detail: `connectorState: (c) => ({ enabled: loadCfg().connectors[c.id]?.enabled !== false, approval:
  approvalStatus(c, loadApprovals(), home) })` is invoked inside `connectorReports`' `registry.map`
  (capture-engine.ts:230-238), so with 8 built-ins that is 16 synchronous file reads every 30 s,
  forever. Correct, and it does buy live config pickup — but the reads are hoistable to once per
  report with no behaviour change, and `serve.ts:174-176` already demonstrates the hoisted form in
  `emitConnectors`. Flagged as low because `serve.ts`'s own `connectorState` has the identical shape,
  so this is consistent with its sibling rather than novel.
suggestion: Hoist inside the thunk: `const cfg = loadCfg(); const approvals = loadApprovals();`
  computed once per `connectorReports()` call, closed over by the per-connector callback. If the
  seam's shape must stay `(c) => …` for testability, change `connectorState` to take the whole
  registry and return a map.
```

```
severity: low
file: apps/ingest/src/schemas.ts
line: 133
issue: The heartbeat schema's `required` list omits three fields that `MachineConnectorReport` declares as non-optional, so the handler's static type overstates what the wire guarantees.
detail: `required` covers eleven keys but not `lastErrorMessage`, `lastErrorAt` or `custom`, while
  the shared type declares `lastErrorMessage: string | null`, `lastErrorAt: string | null` and
  inherits `custom` from `ConnectorInfo`. A hand-rolled or older-but-not-that-old client can post a
  connector object without them; `request.body.connectors` is nonetheless typed as
  `MachineConnectorReport[]`, so `r.lastErrorMessage` is `undefined` where the type promises
  `string | null`. Nothing breaks today — `replaceMachineConnectors` handles `custom` with `?? false`
  and `lastErrorAt` with a truthiness check, and Drizzle maps an `undefined` value to column-omitted
  → NULL — so this is a type-honesty gap, not a live bug. It is worth closing anyway because the
  next person to add a required-in-TS field here will not get a runtime guarantee they will assume
  they have.
suggestion: Add the three keys to `required` (the collector always sends them), or make them
  optional in `MachineConnectorReport`. The first is better: it keeps the type honest and turns a
  malformed client into a loud 400 rather than a silently-null row.
```

```
severity: low
file: packages/db/src/repositories/capture-health.ts
line: 130
issue: The prune DELETE carries no `orgId` predicate, unlike the INSERT beside it.
detail: `delete(machineConnectors).where(eq(machineConnectors.machineId, machineId))` (and the
  `notInArray` branch) is scoped by machine only. This is SAFE today on two independent grounds —
  `machine_id` is a uuid whose org is fixed by `machines.org_id` (D-M15-1), and the route always
  wraps the call in `withOrg` against a FORCE-RLS table whose `FOR ALL` policy applies to DELETE via
  `USING`. But the function takes `orgId` as its second parameter and uses it only in the INSERT, so
  the two halves of one "replace" operation are scoped by different predicates, and 15.4's lesson is
  that a blocked DELETE is the one case Postgres cannot make loud. Defence-in-depth symmetry costs
  one `and(...)`.
suggestion: `and(eq(machineConnectors.orgId, orgId), eq(machineConnectors.machineId, machineId))` in
  both branches. It also makes the function correct standalone rather than correct-because-the-
  caller-wrapped-it, which is the property the header comment already claims for the INSERT.
```

---

## Checked and found correct (no action)

- **`toIso` on aggregates, `.toISOString()` on plain columns** — both applied, both commented with
  the mechanism named, and the live `connectorHealth` / `connectorHealthWindowed` bug (spike S2)
  fixed in the same place. `events.sourceConnector` is `notNull`, so no phantom NULL group.
- **`principal.role` not `SERVICE_ROLE`** on `GET /v1/capture-health`, with the contrast against
  `routes/monitor.ts` explained at the handler. Reads are sequential, not `Promise.all`.
- **`undefined` vs `[]`** preserved end to end: `heartbeat.ts` omits the field entirely when no thunk
  is wired, the schema leaves it optional, and the route gates on `!== undefined`.
- **Migration 0025** — `ENABLE` + `FORCE`, one PERMISSIVE `FOR ALL` org policy with the mandatory
  `nullif(…, '')` guard, three RESTRICTIVE role policies, no `GRANT`, unique index leading with
  `machine_id`. The rollback drill retargets to 0025 with every count derived, and correctly asserts
  0024's label tables survive.
- **`rls.int.test.ts` / `tenancy.int.test.ts`** — one list entry each, no integer literal touched.
- **Dashboard teardown** — `let cancelled = false` armed synchronously before the first await, the
  interval cleared in the same cleanup, `request.signal` threaded into the proxy fetch. 403/401/502
  are distinguished, and an unreachable archive renders as an error rather than an empty table.
- **Display maps** keyed on the shared union with `satisfies Record<...>`, so a new state is a
  compile error rather than a blank cell.

## Not verified in this pass

The DB-backed layer (`capture-health.int.test.ts`, `capture-health.int.test.ts` at the HTTP layer,
`rls`, `rollback`, `tenancy`) did not run here — `skipped ≠ passed`. They must run under
`npm run repo-health -- --require-db` with **0 skipped** before push. The plan's Level-4 manual
round-trip on a **deliberately broken** connector, with evidence in `.agents/qa/m16-signoff/`, is
also outstanding and is the milestone checklist item this slice owns.
