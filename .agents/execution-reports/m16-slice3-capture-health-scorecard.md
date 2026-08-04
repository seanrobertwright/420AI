# Execution report — M16 slice 16.3, capture health scorecard

## Meta

- **Plan**: [`.agents/plans/m16-slice3-capture-health-scorecard.md`](../plans/m16-slice3-capture-health-scorecard.md)
- **Code review**: [`.agents/code-reviews/m16-slice3-capture-health-scorecard.md`](../code-reviews/m16-slice3-capture-health-scorecard.md)
- **Commit**: `60eec90` on `m16-slice3-capture-health-scorecard`
- **Lines changed**: **+9346 / −158** across 47 files (5,065 of the additions are the plan document)

### Files added (16)

| Path                                                             | Purpose                                            |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| `packages/shared/src/capture-health.ts`                          | Wire types, state union, `deriveCaptureHealth`      |
| `packages/shared/src/capture-health.test.ts`                     | Exhaustive state-table units                        |
| `packages/db/src/repositories/capture-health.ts`                 | Upsert+prune, declared×observed join, observed agg  |
| `packages/db/src/repositories/capture-health.int.test.ts`        | Two-role suite (role identity first)                |
| `packages/db/drizzle/0025_naive_overlord.sql`                    | `machine_connectors` + hand-appended policy block   |
| `packages/db/drizzle/down/0025_naive_overlord.down.sql`          | Hand-authored down                                  |
| `packages/db/drizzle/meta/0025_snapshot.json`                    | Generated snapshot                                  |
| `apps/ingest/src/routes/capture-health.ts`                       | `GET /v1/capture-health`                            |
| `apps/ingest/src/capture-health.int.test.ts`                     | Role gates + behavioural app-role test              |
| `apps/collector/src/connectors/connector-info.ts`                | Extracted `mapConnectorInfo` + wire narrowing       |
| `apps/collector/src/connectors/connector-info.test.ts`           | Mapping + `watchGlobs` exclusion pin                |
| `apps/dashboard/src/app/api/capture-health/route.ts`             | Same-origin proxy                                   |
| `apps/dashboard/src/components/monitor/capture-health-panel.tsx` | The panel                                           |
| `apps/dashboard/src/lib/capture-health-display.ts`               | Pure state → label/description/tone maps            |
| `apps/dashboard/src/lib/capture-health-display.test.ts`          | Exhaustiveness over the shared union                |
| `.agents/plans/m16-slice3-capture-health-scorecard.md`           | The plan                                            |

### Files modified (31)

`packages/shared/{index.ts,ingest.ts,package.json}` · `packages/db/src/{index.ts,schema.ts}` ·
`packages/db/src/repositories/{projections.ts,rls.int.test.ts,tenancy.int.test.ts}` ·
`packages/db/src/rollback.int.test.ts` · `packages/db/drizzle/meta/_journal.json` ·
`apps/ingest/src/{app.ts,schemas.ts,app.int.test.ts}` · `apps/ingest/src/routes/heartbeat.ts` ·
`apps/collector/src/{capture-engine.ts,cli.ts,cli.test.ts,heartbeat.ts,heartbeat.test.ts,serve.ts}` ·
`apps/collector/src/queue/queue-store.{ts,test.ts}` ·
`apps/collector/src/watcher/file-watcher.{ts,test.ts}` · `apps/collector/src/sync/sync-worker.ts` ·
`apps/dashboard/src/components/monitor/monitor-view.tsx` ·
`docs/guide/{operations.md,data-boundary.md}` · `.agents/plans/m16-dogfood-instrumentation.md` ·
`SUMMARY.md` · `vitest.config.ts`

---

## Validation results

| Lane                                   | Result                                                        |
| -------------------------------------- | ------------------------------------------------------------- |
| Syntax & linting (`npm run lint`)      | **✓** clean                                                    |
| Type checking (root `tsc -b`)          | **✓** 0 errors                                                 |
| `typecheck:dashboard`                  | **✓** 0 errors                                                 |
| `typecheck:desktop`                    | **✓** 0 errors                                                 |
| `repo-health:fast` (7 checks)          | **✓** PASS                                                     |
| Unit tests (7 slice files)             | **✓** 84 passed, 0 failed                                      |
| **Integration tests**                  | **NOT YET RUN** — see below. `skipped ≠ passed`.                |
| `build:dashboard`                      | **NOT YET RUN** — pre-push gate                                 |
| Level-4 manual round-trip              | **NOT DONE** — `.agents/qa/m16-signoff/` does not exist         |

**Two lanes are outstanding and are stated rather than glossed**, because this slice touches both
`packages/db` and `apps/ingest` and the repo's own rule is that a plain `repo-health` PASS does not
prove the DB-backed layer ran:

1. `npm run repo-health -- --require-db` with **0 skipped**, after migrating `420ai_test`
   separately. This is where the two-role suite, the RLS inventory, the rollback drill and the
   behavioural app-role HTTP test actually execute.
2. The plan's Level-4 **deliberately-broken-connector** round-trip, with evidence in
   `.agents/qa/m16-signoff/`. This is the pre-sign-off checklist item the milestone plan assigns to
   this slice by name, and it is the only check that exercises the whole loop on real hardware.

Both run in the ship pipeline before merge; neither is claimed as done here.

---

## What went well

- **Spiking before planning changed what got built.** Ten spikes ran during planning, and three
  produced results that contradicted the plan-in-progress: S2 found a *shipped* bug on a live
  endpoint (`connectorHealth.lastEventAt` emitting Postgres text on `GET /v1/monitor`), S3 measured
  the core gap rather than asserting it, and S7 confirmed F-16.3-1 by grep rather than by reading
  comprehension. S8 caught a field-name trap (`approvals.approved`, not `approvals.connectors`) that
  a from-memory plan would have got wrong.
- **The two negative controls earned their cost.** S5 wrote the join the wrong way on purpose and
  reproduced a cross-tenant merge (org A counting org B's events) before any real code existed. That
  is why the shipped join is on `machine_id` — and, just as importantly, why the comment beside it
  *refuses* to claim the org predicate is what makes it correct. That refusal is the CLAUDE.md 15.5
  lesson applied prospectively.
- **The two "cannot tell" states survived contact with the implementation.** The easy failure here
  was to let `unreported` collapse into `disabled` at some layer — in the SQL set difference, in the
  route, or in the badge map. It did not: the set difference is done in the pure function, and
  `STATE_TONE` gives both unknown states `neutral`, with a test asserting neither reads as success
  or failure.
- **`Omit<ConnectorInfo, "watchGlobs">` turned a privacy rule into a type.** The exclusion is
  enforced at the type level, pinned by a collector test, absent from the DB schema, and undeclared
  at the HTTP edge. Four independent places, none of which requires anyone to remember it.
- **The migration template worked.** `0024` documents its own hand-edits, so `0025`'s policy block
  was a substitution rather than a re-derivation, and the rollback drill retargeted with every count
  derived from list lengths — no integer literal was edited in `rls.int.test.ts`, exactly as the
  plan's anti-pattern list demanded.

---

## Challenges encountered

- **Two timestamp mechanisms, ten lines apart, in one new file.** `max(events.ts)` is an aggregate
  over a `mode:"string"` column and returns Postgres text; `machineConnectors.reportedAt` is a plain
  timestamptz and returns a JS `Date`. They need opposite fixes (`toIso` vs `.toISOString()`) and
  they sit in the same `.map()`. The mitigation was to write the distinction into the file header
  rather than trusting it to be re-derived.
- **`registry` vs `connectors` is a genuinely confusing split** and needed a new engine option plus a
  `connectorState` callback. The engine receives the already-filtered capture set, and "absent from
  that set" is ambiguous — disabled or withheld-pending-approval are different states with different
  remedies. Guessing would have fabricated a fact, so the caller (which holds config and approvals)
  supplies it. The default is honest only because `registry` defaults to `connectors`.
- **`runWatch` had no test seam at all**, which is precisely how F-16.3-1 survived unnoticed. Fixing
  the defect required first inventing the seam (`runEngine`, `loadConnectorConfig`,
  `loadConnectorApprovals`, `saveConnectorApprovals`) so the fix could be pinned — an unpinned fix in
  this file is undone by the next refactor.
- **F-16.3-2 could not be reproduced end-to-end** without an unreadable file on a real capture path,
  so the failing unit test was written first and the correctness argument rests on reading. The code
  review found that this was not quite enough — see below.

---

## Divergences from plan

**`observedOnlyConnectors` became `observedConnectorAggregates`**

- Planned: `observedOnlyConnectors(db, orgId, declaredKeys)` — the set difference passed into SQL.
- Actual: `observedConnectorAggregates(db, orgId)` — returns every observed pair; the set difference
  is done in the pure `deriveCaptureHealth`.
- Reason: the plan itself offered both and said "prefer that" of the simpler form. The name was
  changed to match what the function does, since it no longer takes `declaredKeys`.
- Type: **Better approach found** (and the one the plan recommended).

**A `@420ai/shared/capture-health` subpath export was added**

- Planned: not mentioned. The plan's file table listed only `packages/shared/src/index.ts`.
- Actual: `packages/shared/package.json` gained an `exports` entry and `vitest.config.ts` gained the
  matching alias.
- Reason: the panel is a client island. Importing the root barrel would pull `catalog-signing` and
  eight parsers into the browser bundle. The alias is required or the test lane resolves to `dist/`.
- Type: **Plan assumption wrong** (it did not consider the bundle boundary).

**`rollback.int.test.ts` and `tenancy.int.test.ts` were updated**

- Planned: the file table listed neither.
- Actual: the rollback drill was retargeted from 0024 to 0025 and `machine_connectors` was added to
  `TENANT_TABLES`.
- Reason: repo convention — the drill retargets with every migration-adding slice, and the tenancy
  inventory must agree with `rls.int.test.ts`. Both are gate-enforced, so omitting them would have
  failed `--require-db`.
- Type: **Other** (a standing convention the plan's file table did not restate).

**D-16.3-6's premise was wrong, and was corrected under measurement**

- Planned: `additionalProperties: false` means a newer collector against an older archive **400s the
  entire heartbeat**, silently, because `maybeSendHeartbeat` swallows it. The `onError` seam existed
  to make that 400 visible.
- Actual: Fastify configures ajv with `removeAdditional: true`, so the undeclared property is
  **stripped and the request returns 200**. Measured and pinned by two tests in
  `apps/ingest/src/capture-health.int.test.ts`.
- Reason: the plan reasoned about JSON Schema semantics rather than about Fastify's ajv defaults.
- Type: **Plan assumption wrong.** The consequences were kept, correctly: the failure is *milder*
  than feared but *less* visible (a 200 with the inventory dropped is harder to notice than a 400),
  so the `onError` seam and the archive-before-collector deploy order both stayed.
- **Incomplete, and caught by the code review**: `SUMMARY.md` and `docs/guide/data-boundary.md` were
  updated to the measured behaviour but `apps/ingest/src/schemas.ts` was not — it still carries three
  comments asserting the 400. That is the CLAUDE.md 15.5 defect class in the same slice that names
  it. See finding 2 of the code review.

---

## Skipped items

- **The Level-4 manual round-trip and `.agents/qa/m16-signoff/` evidence.** Not done. This includes
  the deliberately-broken-connector demonstration, the `disabled`-stops-producing-events proof for
  F-16.3-1, the `silent`-vs-`idle` screenshots, and the `grep -c "$API_KEY"` → 0 check on the served
  HTML. It is the milestone's own pre-sign-off item for this slice and remains open.
- **Integration suites** have not been executed in this session. They are written and they are wired
  into the gate; they have not been *proved* to run.

---

## Recommendations

**For `CLAUDE.md`** — one addition earns its place, because it has now bitten twice in two slices:

> **An error reporter invoked inside a `catch` must itself be guarded.** A `catch` that ends with
> `onError?.(…)` is not a boundary if the handler can throw — it is a rethrow with extra steps. This
> matters most in best-effort loops, where the reporter is typically a `queue.sqlite` write or a log
> and the failure is only reachable when something is *already* wrong, i.e. exactly when the
> reporting was supposed to start working. 16.3 guarded this in `heartbeat.ts` and left it unguarded
> in `file-watcher.ts` and `pollLoop`, re-arming the very engine-unwind (F-16.3-2) it had just fixed.

**For the plan command** — the D-16.3-6 miss is instructive and generalisable: the plan reasoned
about a *specification* (JSON Schema's `additionalProperties`) where the behaviour is determined by
a *configuration* (Fastify's ajv defaults). Ten spikes ran and none of them posted a body with an
extra field. Suggested rule: **when a plan states a failure mode at a framework boundary, spike the
framework, not the spec.** One `app.inject` with a junk property would have cost a minute.

**For the execute command** — when a measurement invalidates a plan decision mid-implementation,
grep for every place the old belief was written down before moving on. Here the correction landed in
SUMMARY, the docs and two tests, but the three source comments that stated it most emphatically were
missed — and source comments are the copy a future reader reaches first.
