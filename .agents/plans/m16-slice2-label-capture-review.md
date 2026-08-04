# Feature: M16 Slice 16.2 — Label capture (tray) + review (dashboard)

The following plan should be complete, but it is important that you validate documentation, codebase
patterns and task sanity before you start implementing.

Pay special attention to the naming of existing utils, types and models. Import from the right files.

Conventions are **not re-pasted here** — they live in [`CLAUDE.md`](../../CLAUDE.md) and are the source
of truth. This plan links to them at the points where they bite.

---

## Feature Description

Slice 16.1 shipped the outcome-label **model and API** (research plan §4.3 / §7 P0.2): seven
principal-authed, `withOrg`-wrapped endpoints over an org-scoped `outcome_labels` table with an
append-only revision history. It shipped with **no way for a human to reach it** — every label today
must be created with `curl`.

16.2 builds the two surfaces that make the model usable, which is the half of §7 P0.2 that says
"and lightweight UI":

1. **Capture** — a "Sessions to label" panel in the desktop app: a server-computed queue of settled,
   unlabeled sessions, a 15-second form, and a one-click **Skip**.
2. **Review** — a `/labels` page in the dashboard: filter, edit, retract-to-skip, delete, export;
   plus a label affordance on the session rows already rendered in the project detail view.
3. **Decision links** (§7 P1.5) — a "Log a decision" action that renders a pre-filled `DEC-YYYY-NN`
   stub, carrying **IDs and closed-set values only**, for pasting into `.agents/research/decisions.md`.

One new server endpoint (`GET /v1/labels/queue`) supports #1. Everything else consumes 16.1's
existing API.

## User Story

**As** the sole operator of a 24-week research period
**I want** to record a 15-second judgement of a session from the app that is already running on my
machine, and to correct or retract that judgement later from the dashboard
**So that** 16.4's outcome metrics have a denominator that reflects what I actually did, rather than
a `curl` habit I will not sustain for 24 weeks.

## Problem Statement

Research plan §12 names the risk directly and the M16 plan carries it as **Risk 3**: _"if the
15-second label is not actually 15 seconds, completion collapses and 16.4's outcome metrics have no
denominator."_ Right now the label costs a terminal, a session id looked up by hand, and a JSON body
— call it 90 seconds — so completion will be zero and every outcome metric in 16.4 will be computed
over an empty set.

There is a second, quieter problem. §4.3 requires "offer skip and **do not nag repeatedly**", and no
surface exists that could obey or violate that rule, so nothing has been designed to obey it.

## Solution Statement

**The queue is the design.** A server endpoint answers "which of my sessions are finished, recent,
and carry no label row yet?" Because D-16.1-2 made **a skip a row**, "never nag" is not a feature
that has to be built — it is the queue's `count(labels.id) = 0` predicate. A skipped session leaves
the queue permanently and by construction.

The desktop panel is **pull-only** (D-16.2-3): it never raises a window, fires a notification, or
steals focus. Nagging is made structurally impossible rather than tuned.

The dashboard consumes 16.1's `GET /v1/labels`, `PATCH`, `DELETE` and `/export` unchanged, and adds
no endpoint of its own.

§7 P1.5 is satisfied **without a new data model** (D-16.2-6): the decision log already exists as
`.agents/research/decisions.md`, is a research-plan §3 source-of-truth artifact, and its §11 template
is verbatim in that file. The product's job is to remove the copy-the-session-id friction and to
enforce the file's privacy rule by construction.

## Feature Metadata

**Feature Type**: New Capability (UI surfaces over an existing model) + one additive read endpoint
**Estimated Complexity**: Medium
**Primary Systems Affected**: `packages/shared`, `packages/db`, `apps/ingest`, `apps/dashboard`,
`apps/desktop` (webview + Rust)
**Dependencies**: **None new.** Every package and CLI this plan invokes is already present —
verified (see NOTES → spike S7).
**Schema change**: **NONE.** No migration. 16.1's tables are sufficient.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**The 16.1 model you are building on (read all three — they are heavily commented and the comments
are load-bearing):**

- `packages/shared/src/outcome-labels.ts` (all 157 lines) — Why: the closed value sets
  (`TASK_TYPES`, `OUTCOMES`, `FRICTIONS`, `LABEL_CONFIDENCE`, `LABEL_STATUSES`), `INTENT_MAX_LENGTH`,
  `FOLLOW_UP_MAX_LENGTH`, the `OutcomeLabelFields` shape, and the guards. **Both new UIs build their
  dropdowns from these arrays** — never re-type the strings. Note `model_tool` is §4.3's `model/tool`
  normalized (line 26-30); render it with a human label, do not "fix" the value.
- `packages/db/src/repositories/outcome-labels.ts` (lines 55-73 `OutcomeLabelRow`, 187-196
  `PatchOutcomeLabelInput`, 402-498 `updateOutcomeLabel`, 593-620 `listOutcomeLabels`) — Why: the
  exact row shape the UIs render, what a PATCH may clear, and the `explicitSkip` rule at line 466-475
  (**a patch that supplies §4.3 fields to a `skipped` row is a 400** — the dashboard edit form must
  send `status: "labeled"` with the full judgement when upgrading a skip, not a partial patch).
- `apps/ingest/src/routes/outcome-labels.ts` (all 415 lines) — Why: the seven handlers you consume,
  their role gates (reads `viewer`, writes `member`, DELETE force at `admin`), and the file you will
  add the queue handler to. Lines 110-187 are the POST template your new handler mirrors.

**The query you are mirroring:**

- `packages/db/src/repositories/monitor.ts` (lines 71-121, `activeSessions`) — Why: the new
  `labelQueue` is this query with two changes (a `leftJoin` on `outcome_labels`, and an inverted
  `having` window). **Lines 76-85 carry the two gotchas verbatim** — the bound-param-in-HAVING rule
  and the `toIso` normalization. Copy `toIso` (line 85), do not re-derive it.
- `packages/db/src/repositories/projections.ts` (lines 265-307, `sessionProjections` /
  `sessionDetail`) — Why: `sessionDetail` is the existence guard the POST route already uses, and
  `SessionProjection` is the shape the project detail page renders.

**Ingest route + schema patterns:**

- `apps/ingest/src/schemas.ts` (lines 757-775, `listOutcomeLabelsQuerySchema`) — Why: the querystring
  schema your new `labelQueueQuerySchema` mirrors exactly (bounded `limit`, `additionalProperties:
  false`).
- `apps/ingest/src/app.ts` (lines 302-317) — Why: the `OutcomeLabelError` → status mapping is already
  complete. **You are adding no new error reason**, so this file needs no change beyond nothing.
- `apps/ingest/src/routes/org-scoping.test.ts` (lines 1-45) — Why: the structural grep, and its
  **KNOWN LIMIT** — one `withOrg(` anywhere exempts the whole file, so `outcome-labels.ts` already
  passes and will keep passing even if your new handler forgets the wrapper. The behavioural two-role
  test is the real proof (see TESTING STRATEGY).

**Two-role integration harness (this is the harness the plan tells you to mirror — it exists):**

- `packages/db/src/repositories/outcome-labels.int.test.ts` — Why: the exact seeding you will reuse.
  Specifically: `batch()` (lines 45-67), `errorChain()` (lines 76-84), `expectRlsRejection()`
  (lines 87-100), `WRITE_ROLE = "member"` (line 103), the `beforeEach` TRUNCATE + `ensurePersonalOrg`
  + `machines` + `ingestBatch` block (lines 134-158), and **test 1, the role-identity assertion**
  (lines 182-195). Without test 1 the file is theatre — CLAUDE.md's rule, and it applies to your new
  file too.
- `apps/ingest/src/outcome-labels.int.test.ts` — Why: the HTTP-layer sibling; mirror it for the queue
  endpoint's role gates.

**Dashboard patterns:**

- `apps/dashboard/src/app/team/page.tsx` (all 69 lines) — Why: the Server-Component page shape you
  mirror exactly — `export const dynamic = "force-dynamic"`, `getIngestJson` for the first paint,
  `PageShell`, and the **"an unreachable archive is not an empty team"** rule at lines 38-53. Your
  `/labels` page must say "could not reach the archive", never render an empty table.
- `apps/dashboard/src/components/team/team-view.tsx` (lines 1-120 minimum, ideally all) — Why: the
  client-island pattern: `"use client"`, a `useCallback` loader, `let cancelled = false` armed before
  the first await, per-row `busy` keyed by id, `FORBIDDEN_MESSAGE` for 403, `router.refresh()` after a
  mutation, and the **first-paint-seed-only** caveat at lines 76-86 (a changed prop does NOT update a
  mounted island — the client re-fetch owns every subsequent update).
- `apps/dashboard/src/lib/proxy.ts` (all 96 lines) — Why: `proxyJson` (forwards upstream status
  verbatim — this is what lets the UI tell 403 from 404) and `proxyStream` (for the export download,
  forwards the `x-export-*` headers).
- `apps/dashboard/src/app/api/members/[userId]/route.ts` (all 31 lines) — Why: the dynamic
  Route-Handler proxy template. Note `params` is a **Promise** in this Next version — `await` it.
- `apps/dashboard/src/components/settings/api-keys-card.tsx` (lines 137-160) — Why: **the clipboard
  pattern with its secure-context guard.** `navigator.clipboard` is `undefined` outside a secure
  context; the comment explains why an optional call (`?.writeText`) is worse than a check. The
  decision-stub copy button MUST mirror this, including the "clipboard unavailable — select and copy
  manually" fallback.
- `apps/dashboard/src/components/export/export-view.tsx` (lines 80-100) — Why: the native `<select>`
  + `selectCls` idiom. **There is no shadcn `select` primitive in this repo** — do not add one, and
  do not run the shadcn CLI (CLAUDE.md "Frontend workspace").
- `apps/dashboard/src/components/projects/project-detail-view.tsx` (lines 182-220) — Why: the
  Sessions table and the `<SessionReportActions sessionId={s.sessionId} />` slot at line 217. Your
  `<SessionLabelActions>` goes in an adjacent cell and mirrors that component's shape.
- `apps/dashboard/src/lib/mutation-error.ts` (all 29 lines) — Why: `FORBIDDEN_MESSAGE` /
  `FORBIDDEN_SHORT`, and the reasoning for why they are constants rather than a formatter.
- `apps/dashboard/src/lib/format.ts` — Why: `formatDate(iso)` and `formatAgo(iso, nowMs)`. Use them;
  do not hand-roll a date format.

**Desktop patterns:**

- `apps/desktop/src-tauri/src/proxy.rs` (all 107 lines) — Why: **the file you extend.**
  `monitor_credentials()` (lines 42-67) is the keychain→env credential resolution you will rename and
  reuse; `get_monitor_snapshot()` (lines 72-92) is the command template; the `#[cfg(test)] mod tests`
  at lines 94-107 is where your `label_url` unit tests go. **The header comment at lines 17-20 says
  "a `viewer` key is sufficient for this panel" — that becomes false in this slice (D-16.2-4) and
  the comment must be updated, not left to rot.**
- `apps/desktop/src/lib/bridge.ts` (all 188 lines) — Why: every `invoke` wrapper, and the doc-comment
  discipline. Add your three wrappers here; nothing else in the webview calls `invoke` directly.
- `apps/desktop/src/components/SyncHealth.tsx` (lines 1-90 minimum) — Why: the panel template — a
  `refresh()` that surfaces a rejection as panel state (never an unhandled rejection), degrading
  gracefully when the API key is unset or ingest is down. Your panel must degrade the same way.
- `apps/desktop/src/App.tsx` (all 42 lines) — Why: the panel is registered here, in the `space-y-6`
  stack.
- `apps/desktop/src-tauri/src/tray.rs` (all 61 lines) — Why: the tray menu. Note lines 15-18: a
  **live** tray label needs a stored `MenuItem` handle + a poll task and was deliberately excluded in
  M11 Slice 4. D-16.2-3 keeps that exclusion — you add a **static** menu item only.

**Research + governance:**

- `.agents/supplemental docs/research-analysis-plan.md` §4.3 (lines 118-139) — Why: the six fields
  and the four rules that are **acceptance criteria for this slice, not suggestions** (M16 plan,
  Risk 3). §7 P1.5 (lines 388-390) — the decision-link acceptance criterion. §11 (lines 487-503) —
  the decision-log entry template.
- `.agents/research/decisions.md` (all 48 lines) — Why: **the exact template your stub must emit**,
  and the **PRIVACY RULE at lines 7-10**: "No captured session content… links/IDs only — **this file
  is committed to a public repository**." This is what makes D-16.2-5 non-negotiable.
- `.agents/plans/m16-dogfood-instrumentation.md` — Why: the milestone's non-goals (name them in the
  PR) and the pre-sign-off checklist item this slice half-satisfies ("a label round-trips: created
  from the tray, visible and editable in the dashboard, exported, deleted").

### New Files to Create

| Path | Purpose |
|---|---|
| `packages/db/src/repositories/label-queue.ts` | `labelQueue()` — settled, in-window, unlabeled sessions for one org |
| `packages/db/src/repositories/label-queue.int.test.ts` | Two-role suite for the above (role identity first) |
| `apps/dashboard/src/app/labels/page.tsx` | `/labels` Server Component |
| `apps/dashboard/src/components/labels/labels-view.tsx` | The review table client island |
| `apps/dashboard/src/components/labels/label-form.tsx` | The shared §4.3 form (used by the review table's edit row) |
| `apps/dashboard/src/components/projects/session-label-actions.tsx` | The per-session-row affordance |
| `apps/dashboard/src/lib/decision-stub.ts` | **Pure**, unit-tested `DEC-` stub builder (§7 P1.5) |
| `apps/dashboard/src/lib/decision-stub.test.ts` | Unit tests for the above, incl. the privacy assertion |
| `apps/dashboard/src/lib/label-display.ts` | **Pure** value→human-label maps + `qualityStars` |
| `apps/dashboard/src/lib/label-display.test.ts` | Unit tests, incl. exhaustiveness over the shared arrays |
| `apps/dashboard/src/app/api/labels/route.ts` | Proxy → `GET /v1/labels` |
| `apps/dashboard/src/app/api/labels/export/route.ts` | Proxy (stream) → `GET /v1/labels/export` |
| `apps/dashboard/src/app/api/sessions/[sessionId]/label/route.ts` | Proxy → `POST`/`GET`/`PATCH`/`DELETE` |
| `apps/desktop/src/components/LabelQueue.tsx` | The desktop capture panel |

### Files to Update

| Path | Change |
|---|---|
| `packages/shared/src/monitor.ts` | Export `ACTIVE_WINDOW_MS` (promoted from the route) + `LABEL_QUEUE_LOOKBACK_MS` |
| `packages/shared/src/outcome-labels.ts` | Add the `LabelQueueRow` wire type |
| `packages/shared/src/index.ts` | Re-export the new symbols |
| `packages/db/src/index.ts` | Re-export `labelQueue` + `LabelQueueRow` |
| `apps/ingest/src/routes/monitor.ts` | Import `ACTIVE_WINDOW_MS` from shared instead of the local const |
| `apps/ingest/src/routes/outcome-labels.ts` | Add the `GET /v1/labels/queue` handler |
| `apps/ingest/src/schemas.ts` | Add `labelQueueQuerySchema` |
| `apps/ingest/src/outcome-labels.int.test.ts` | Add queue-endpoint role-gate + behaviour tests |
| `apps/desktop/src-tauri/src/proxy.rs` | Rename `monitor_credentials`→`ingest_credentials`; add 2 commands; update the header's rung claim |
| `apps/desktop/src-tauri/src/lib.rs` | Register the 2 new `#[command]`s |
| `apps/desktop/src-tauri/src/tray.rs` | Add a static "Label sessions — open the app" menu item |
| `apps/desktop/src/lib/bridge.ts` | Add 3 typed `invoke` wrappers |
| `apps/desktop/src/App.tsx` | Mount `<LabelQueue />` |
| `apps/dashboard/src/components/app-nav.tsx` | Add the `/labels` nav entry |
| `apps/dashboard/src/components/projects/project-detail-view.tsx` | Add the label cell to the Sessions table |
| `docs/guide/usage.md` | Document both surfaces + the decision-stub workflow |
| `docs/guide/operations.md` | **The desktop API key must now be `member`, not `viewer`** |
| `SUMMARY.md` | Flip **16.2** to ✅ in §0 and §6 (same commit as the execution report) |

### Relevant Documentation

- [Tauri v2 — Commands](https://v2.tauri.app/develop/calling-rust/#commands)
  - Section: passing arguments / returning `Result<T, String>`
  - Why: the two new `#[command]`s follow `get_monitor_snapshot` exactly; camelCase args from JS map
    to snake_case Rust params automatically (already relied on by `restoreArchive` →
    `backup_path`, `bridge.ts:186`).
- [Tauri v2 — Tray menus](https://v2.tauri.app/learn/system-tray/#menu)
  - Section: `MenuItem::with_id`, `enabled` flag
  - Why: the new item is display-and-focus only; a disabled item needs no `on_menu_event` branch
    (`tray.rs:23`).
- [reqwest — `RequestBuilder::json`](https://docs.rs/reqwest/0.12/reqwest/struct.RequestBuilder.html#method.json)
  - Why: the POST/PATCH body. The `json` feature is **already enabled** —
    `Cargo.toml:26` reads `features = ["json", "rustls-tls"]` (verified, spike S7).
- [Next.js — Route Handlers, dynamic segments](https://nextjs.org/docs/app/building-your-application/routing/route-handlers)
  - Why: `params` is a Promise in this version — see `api/members/[userId]/route.ts:14`.
- [Drizzle — `leftJoin` / `having`](https://orm.drizzle.team/docs/joins#left-join)
  - Why: the queue query's shape. **The plan's snippet below is the verified one — prefer it to the
    docs.**
- [MDN — `navigator.clipboard`](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API#security_considerations)
  - Section: secure context requirement
  - Why: the guard at `api-keys-card.tsx:153` exists for this reason.

### Patterns to Follow

**The queue query.** This snippet is **transcribed from the planning spike that ran green against
the live test database** (NOTES → S1–S6). Its assertions are stated beside it so drift is detectable.

```ts
// packages/db/src/repositories/label-queue.ts
import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { events, machines, outcomeLabels } from "../schema.js";

/** Postgres text → strict ISO. Copied from monitor.ts:85 — see the gotcha note below. */
const toIso = (v: string | null): string | null => (v ? new Date(v).toISOString() : null);

export async function labelQueue(
  db: DbClient,
  orgId: string,
  opts: { settledBeforeIso: string; sinceIso: string; limit?: number },
): Promise<LabelQueueRow[]> {
  const query = db
    .select({
      sessionId: events.sessionId,
      sourceConnector: sql<string>`max(${events.sourceConnector})`,
      startedAt: sql<string | null>`min(${events.ts})`,
      lastEventAt: sql<string | null>`max(${events.ts})`,
      eventCount: sql<number>`count(${events.fingerprint})::int`,
      models: sql<
        string[]
      >`coalesce(array_agg(distinct ${events.model}) filter (where ${events.model} is not null), '{}')`,
      projectPath: sql<string | null>`max(${events.projectPath})`,
      gitBranch: sql<string | null>`max(${events.gitBranch})`,
    })
    .from(events)
    .innerJoin(machines, eq(events.machineId, machines.id))
    // ── THE JOIN-SIDE `orgId` PREDICATE IS LOAD-BEARING. See the spike note below.
    .leftJoin(
      outcomeLabels,
      and(eq(outcomeLabels.sessionId, events.sessionId), eq(outcomeLabels.orgId, orgId)),
    )
    .where(and(eq(events.orgId, orgId), eq(machines.orgId, orgId)))
    .groupBy(events.sessionId)
    .having(
      sql`max(${events.ts}) < ${opts.settledBeforeIso}::timestamptz
          and max(${events.ts}) >= ${opts.sinceIso}::timestamptz
          and count(${outcomeLabels.id}) = 0`,
    )
    .orderBy(sql`max(${events.ts}) desc`)
    .$dynamic();
  if (opts.limit !== undefined) query.limit(opts.limit);
  const rows = await query;
  return rows.map((r) => ({
    ...r,
    // ── MANDATORY. Asserted by spike S2 (below); NOT optional, NOT already ISO.
    startedAt: toIso(r.startedAt),
    lastEventAt: toIso(r.lastEventAt),
    models: r.models ?? [],
  }));
}
```

> **Spike assertions this snippet must keep satisfying** (fold them into the int test):
>
> - **S2** — `max(ts)` came back as `"2026-08-01 00:00:00+00"`, i.e. **Postgres text, not ISO**
>   (`raw === new Date(raw).toISOString()` was `false`). The `toIso` calls are the fix. This is the
>   exact class of bug that shipped as M5 `lastActivity` and recurred as M9 `activeSessions` —
>   CLAUDE.md § "Drizzle / SQL gotchas".
> - **S5, the negative control** — with the join written as `eq(outcomeLabels.sessionId,
>   events.sessionId)` **alone**, a label written by **org B** on a session id **org A also owns**
>   removed org A's session from org A's queue. Measured on the **owner** handle (RLS inert), so it
>   measures the predicate and not the backstop. Queue without the predicate:
>   `['settled-unlabeled']`. With it: `['settled-unlabeled', 'SHARED-SESSION']`. This is CLAUDE.md's
>   15.2 rule ("a read keyed by a CONNECTOR-SUPPLIED string MUST take `orgId`") applied to the
>   **join condition**, which is the place it is easiest to forget.
> - **S6** — under the non-owner app role inside `withOrg`, the query returns the same two rows and
>   `eventCount === 2` for each: **the left join does not fan out**, because `outcome_labels` carries
>   a unique `(org_id, session_id)`. Do not "fix" a fan-out that does not exist by adding `distinct`.
> - **S3/S4** — a `labeled` row **and** a `skipped` row both remove the session from the queue. §4.3's
>   "do not nag repeatedly" is therefore the `count(labels.id) = 0` predicate, not extra logic.

**The bound-parameter rule, and why this query is safe.** CLAUDE.md forbids a bound parameter where
Postgres must match a `GROUP BY`/`ORDER BY` expression. The three predicates above are **value
comparisons inside `HAVING`**, not grouping expressions, so `${...}::timestamptz` is correct — the
identical construction is already shipped and commented at `monitor.ts:76-78`.

**The aggregate-over-an-ownership-column smell, and why `count(outcomeLabels.id)` is not one.**
CLAUDE.md flags aggregates over tenancy columns (15.1's `min(org_id)`). `outcomeLabels.id` is not an
ownership key, and the join is already confined to one org on both sides, so the aggregate cannot
merge tenants. State this in the file header so the next reader does not have to re-derive it.

**Repository conventions this file must follow** (all from `outcome-labels.ts`):

- `orgId` is **always the second parameter**.
- Silent library — throws typed errors, never logs.
- Explicit column list; **no `orgId` on the returned row** (it reaches `reply.send()` and no ingest
  route declares a response schema — CLAUDE.md 15.1).
- Do **not** call `withOrg` inside the function; the route wraps it.

**The route handler** (add to `apps/ingest/src/routes/outcome-labels.ts`; mirrors the existing
`GET /v1/labels` at lines 306-333):

```ts
  /**
   * GET /v1/labels/queue — settled, in-window, UNLABELED sessions (16.2 / §4.3).
   *
   * `viewer`-gated like every other read here. THE CLOCK IS THE ROUTE'S, not the repository's
   * (the repo-wide clock-injection rule), and the two windows are `@420ai/shared` constants so the
   * tray, the dashboard and 16.4 cannot disagree about what "settled" means.
   *
   * WHY A SKIPPED SESSION NEVER RETURNS: D-16.1-2 made a skip a ROW, so it is excluded by the same
   * `count(labels.id) = 0` predicate that excludes a judged one. §4.3's "do not nag repeatedly" is
   * a property of the query, not a feature layered over it.
   */
  app.get<{ Querystring: { limit?: number } }>(
    "/v1/labels/queue",
    { schema: { querystring: labelQueueQuerySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) return reply.code(401).send({ error: "admin authorization required" });
      if (!authorized(principal, "viewer")) return reply.code(403).send({ error: "insufficient role" });
      const nowMs = Date.now();
      const sessions = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
        labelQueue(tx, principal.orgId, {
          settledBeforeIso: new Date(nowMs - ACTIVE_WINDOW_MS).toISOString(),
          sinceIso: new Date(nowMs - LABEL_QUEUE_LOOKBACK_MS).toISOString(),
          limit: request.query.limit ?? DEFAULT_QUEUE_LIMIT,
        }),
      );
      return reply.code(200).send({ sessions });
    },
  );
```

**The decision stub** (pure; `apps/dashboard/src/lib/decision-stub.ts`):

```ts
/**
 * §7 P1.5 — build a DEC- entry stub for `.agents/research/decisions.md`.
 *
 * D-16.2-5 — WHAT THIS FUNCTION MAY NOT EMIT. `decisions.md` is COMMITTED TO A PUBLIC REPOSITORY
 * and its §3 privacy rule is "links/IDs only". `intent` is 200 characters of free human text and
 * `followUpCommitOrPr` is a URL a person pasted — either may carry a customer name, a token or a
 * credentialed URL that the person typing it never thought of as leaving the archive. They are the
 * two fields `GET /v1/labels/export` redacts for exactly this reason (D-16.1-7), and pasting them
 * into a public file is strictly worse than exporting them.
 *
 * So the stub carries: the session id, timestamps, the connector, counts, and the CLOSED-SET values
 * (`taskType`/`outcome`/`primaryFriction`/`qualityRating`/`confidence`) — every one of which is a
 * member of an array in `@420ai/shared/outcome-labels`, i.e. a value the operator SELECTED rather
 * than TYPED. Free text is structurally excluded, and `decision-stub.test.ts` asserts it.
 */
export function buildDecisionStub(input: DecisionStubInput): string { /* … */ }
```

**Anti-patterns to avoid (each has bitten this repo):**

- ❌ Adding a `decisions` table. D-16.2-6: one decision log, in markdown. Two logs diverge.
- ❌ Rendering an empty table when the archive is unreachable (`team/page.tsx:38-53`).
- ❌ Relying on hidden buttons for authorization. Role gating in the UI is **courtesy**; the 403 is
  the gate (`team-view.tsx:24-32`). Do both.
- ❌ `navigator.clipboard?.writeText(...)` — an optional call silently does nothing
  (`api-keys-card.tsx:141-152`).
- ❌ Running `npx shadcn init` or adding a `select` primitive (CLAUDE.md "Frontend workspace"). Use
  native `<select>` + `selectCls`.
- ❌ A `useEffect` whose teardown is armed after the first `await` (CLAUDE.md long-lived-resource
  rule; `team-view.tsx` shows the `let cancelled = false` form).
- ❌ Sending a partial PATCH of §4.3 fields to a **skipped** row — the repository returns 400
  (`outcome-labels.ts:466-475`). Upgrade a skip with `status:"labeled"` **plus the full judgement**.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation — shared constants + the queue read

The two time windows and the wire type land in `@420ai/shared` first, because the ingest route, the
repository test and both UIs all reference them. `ACTIVE_WINDOW_MS` is **promoted** out of
`routes/monitor.ts` rather than duplicated: a session must never be simultaneously "active now" in
the Live Monitor and "ready to label" in the tray, and one constant is the only way to guarantee it.

### Phase 2: Core — the endpoint

One additive `viewer`-gated handler on the existing, already-registered route file. No schema
change, no migration, no new error reason, no `app.ts` change.

### Phase 3: Integration — the two surfaces

Desktop (Rust proxy commands → bridge wrappers → panel → tray item) and dashboard (proxies → pure
display/stub libs → review page → session-row action → nav).

### Phase 4: Testing & Validation

A two-role repository suite (role identity first), HTTP role-gate tests, pure unit tests for the two
dashboard libs, then the full gate with `--require-db`, then the manual round-trip.

---

## STEP-BY-STEP TASKS

Execute in order. Each task is atomic and independently testable.

### 1. UPDATE `packages/shared/src/monitor.ts`

- **IMPLEMENT**: Export `ACTIVE_WINDOW_MS = 15 * 60 * 1000` with a doc comment naming its **two**
  consumers, and `LABEL_QUEUE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000`.
- **PATTERN**: `MONITOR_THRESHOLDS` at `monitor.ts:27-31` — a `const` with a rationale comment per
  member.
- **GOTCHA**: Explain the 14-day lookback rather than asserting it: the research plan's §3 cadence is
  a **Friday, 30-minute** review, so a full week can elapse between visits; 14 days leaves one
  missed week of slack before a session ages out of the queue unlabeled. Sessions older than that are
  deliberately unreachable from the queue — 16.4 counts them in the denominator as
  never-asked-about, and the dashboard `/labels` page is the way to label one late.
- **GOTCHA**: Say in the comment that `ACTIVE_WINDOW_MS` is the settle threshold **because** it is
  the active window — the two are the same number on purpose, not by coincidence.
- **VALIDATE**: `npx tsc -b packages/shared`

### 2. UPDATE `apps/ingest/src/routes/monitor.ts`

- **REFACTOR**: Delete the local `const ACTIVE_WINDOW_MS = 15 * 60 * 1000;` (line 46) and import it
  from `@420ai/shared`. Behaviour is unchanged.
- **GOTCHA**: This is the *only* edit to this file. Do not touch the reconcile path — CLAUDE.md
  (15.4) records that wrapping this route in the caller's role made it 500 for every viewer.
- **VALIDATE**: `npm run typecheck` — exit 0; `npx vitest run apps/ingest/src/monitor.test.ts`

### 3. UPDATE `packages/shared/src/outcome-labels.ts` + `packages/shared/src/index.ts`

- **ADD**: `export interface LabelQueueRow { sessionId, sourceConnector, startedAt: string | null,
  lastEventAt: string | null, eventCount: number, models: string[], projectPath: string | null,
  gitBranch: string | null }`.
- **IMPORTS**: none new.
- **GOTCHA**: Timestamps are `string | null` **ISO**, and the doc comment must say the repository
  normalizes them — an aggregate returns Postgres text (spike S2). Do not describe them as "already
  ISO"; that exact phrasing in an M5 plan is what shipped the `lastActivity` bug.
- **VALIDATE**: `npm run typecheck`

### 4. CREATE `packages/db/src/repositories/label-queue.ts`

- **IMPLEMENT**: `labelQueue(db, orgId, opts)` exactly as in PATTERNS above, plus a file header
  covering: (a) the join-side `orgId` predicate and the S5 measurement, (b) the `toIso` requirement
  and the S2 measurement, (c) why `count(outcomeLabels.id)` is not the 15.1 aggregate smell, (d) that
  the caller wraps it in `withOrg`.
- **PATTERN**: `packages/db/src/repositories/monitor.ts:71-121`.
- **IMPORTS**: `{ and, eq, sql }` from `drizzle-orm`; `type DbClient` from `../client.js`;
  `{ events, machines, outcomeLabels }` from `../schema.js`; `type LabelQueueRow` from
  `@420ai/shared`.
- **GOTCHA**: `orgId` second. No `withOrg` inside. No logging.
- **VALIDATE**: `npm run typecheck`

### 5. UPDATE `packages/db/src/index.ts`

- **ADD**: `export { labelQueue } from "./repositories/label-queue.js";`
- **PATTERN**: the adjacent `outcome-labels.js` re-export line.
- **VALIDATE**: `npm run typecheck` — must be 0; a missing re-export surfaces here, not at the route.

### 6. CREATE `packages/db/src/repositories/label-queue.int.test.ts`

- **IMPLEMENT**: A **two-role** suite. `describe.skipIf(!TEST_URL || !APP_URL)`. Tests:
  1. **Role identity first** — `is_superuser = 'off'`, `rolbypassrls = false`, `current_user =
     '420ai_app'`. Without it the file is theatre (CLAUDE.md).
  2. Returns only settled + in-window + unlabeled sessions.
  3. A **labeled** session leaves the queue.
  4. A **skipped** session leaves the queue (the §4.3 never-nag proof).
  5. A session with activity inside the settle window is **absent** (still active).
  6. A session older than the lookback is **absent**.
  7. **The cross-org negative control**: seed the same `session_id` in orgs A and B, label it in
     **B**, and assert A's queue still contains it. On the **owner** handle, so it measures the
     predicate rather than RLS.
  8. `eventCount` is the true event count (no left-join fan-out).
  9. Under the **app role** inside `withOrg`, the queue matches the owner's.
- **PATTERN**: `packages/db/src/repositories/outcome-labels.int.test.ts` — reuse `batch()` (adding a
  `ts` parameter), the `beforeEach` TRUNCATE block (lines 134-158), `ensurePersonalOrg`,
  `ingestBatch`, and `WRITE_ROLE = "member"`.
- **GOTCHA**: Inject the clock — build `settledBeforeIso`/`sinceIso` from a **fixed** `now`, and seed
  event timestamps relative to it. A test that uses the wall clock will pass today and fail in the
  15th minute of some future run.
- **GOTCHA**: The TRUNCATE list must include `outcome_label_revisions, outcome_labels` before
  `events`.
- **VALIDATE**: `npx vitest run packages/db/src/repositories/label-queue.int.test.ts` — **9 passed,
  0 skipped**. If it reports skipped, `DATABASE_URL_TEST`/`DATABASE_URL_TEST_APP` are unset and the
  suite proved nothing.

### 7. UPDATE `apps/ingest/src/schemas.ts`

- **ADD**: `labelQueueQuerySchema` — `{ type:"object", additionalProperties:false, properties:{
  limit:{ type:"integer", minimum:1, maximum:200 } } }`.
- **PATTERN**: `listOutcomeLabelsQuerySchema` at lines 757-775.
- **VALIDATE**: `npm run typecheck`

### 8. ADD the queue handler to `apps/ingest/src/routes/outcome-labels.ts`

- **IMPLEMENT**: the handler from PATTERNS above, plus `const DEFAULT_QUEUE_LIMIT = 25;` near
  `LABEL_CSV_COLUMNS`.
- **PATTERN**: `GET /v1/labels` at lines 306-333.
- **IMPORTS**: add `labelQueue` to the `@420ai/db` import; add `ACTIVE_WINDOW_MS`,
  `LABEL_QUEUE_LOOKBACK_MS`, `type LabelQueueRow` to the `@420ai/shared` import.
- **GOTCHA**: **`withOrg` with `principal.role`, never `SERVICE_ROLE`.** This is a read on the
  caller's behalf (the 15.4 "whose action is this?" test), and the file's header already commits to
  it. Also register it **before** any `/v1/labels/:something` route to avoid a path-precedence
  surprise — today there is none, but `/v1/labels/export` is a sibling literal and both are literals,
  so Fastify's radix tree handles it; state that you checked.
- **GOTCHA**: No `app.ts` change — you add no new `OutcomeLabelError` reason.
- **VALIDATE**: `npm run typecheck` && `npx vitest run apps/ingest/src/routes/org-scoping.test.ts`

### 9. UPDATE `apps/ingest/src/outcome-labels.int.test.ts`

- **ADD**: (a) 401 with no principal; (b) 403 for a role below `viewer` — or, if `viewer` is the
  floor, assert a **viewer succeeds** and document that there is no rung below it; (c) a behavioural
  test on the **app role**: ingest a settled session, `GET /v1/labels/queue` returns it, POST a skip,
  the queue no longer returns it.
- **PATTERN**: the existing role-gate tests in the same file.
- **GOTCHA**: (c) is the **behavioural** half of CLAUDE.md's grep rule — `org-scoping.test.ts` is
  file-granular and already exempts this file, so it cannot catch a handler that forgot `withOrg`.
  A read that silently returns zero rows under the app role is exactly the M15 `monitor.ts` failure.
- **VALIDATE**: `npx vitest run apps/ingest/src/outcome-labels.int.test.ts` — all pass, 0 skipped.

### 10. CREATE `apps/dashboard/src/lib/label-display.ts` + its test

- **IMPLEMENT**: `TASK_TYPE_LABELS`, `OUTCOME_LABELS`, `FRICTION_LABELS`, `CONFIDENCE_LABELS` as
  `Record<…, string>` keyed on the shared unions, plus `qualityStars(n: number | null): string`.
- **IMPORTS**: `import { TASK_TYPES, OUTCOMES, FRICTIONS, LABEL_CONFIDENCE, type TaskType, … } from
  "@420ai/shared/outcome-labels"` — **the subpath, never the package root.** `team-view.tsx:44-49`
  explains why: the root barrel drags `catalog-signing` and eight parsers into the browser bundle.
  **Verify the subpath export exists in `packages/shared/package.json` `exports`; if it does not, add
  it, mirroring the `/roles` entry.**
- **GOTCHA**: Type the maps as `Record<TaskType, string>` (not `Record<string, string>`) so **adding
  a value to the shared array is a compile error here** rather than a blank cell in the UI. The test
  asserts exhaustiveness over the arrays as a second net.
- **GOTCHA**: `model_tool` renders as "Model / tool". Neutral wording throughout (§4.3): the outcome
  `incorrect` renders as "Incorrect result", never "Failure"; `quality_rating` is labelled
  "Usefulness", never "Score".
- **VALIDATE**: `npx vitest run apps/dashboard/src/lib/label-display.test.ts`

### 11. CREATE `apps/dashboard/src/lib/decision-stub.ts` + its test

- **IMPLEMENT**: `buildDecisionStub(input)` emitting the §11 template **verbatim** from
  `.agents/research/decisions.md:28-40`, with `Date / user / project`, `Evidence reviewed` and the
  closed-set values pre-filled and every other line left blank for the human.
- **PATTERN**: the preview shape agreed with the user (see NOTES → decisions).
- **GOTCHA — D-16.2-5, the whole point**: the function's input type must **not contain** `intent` or
  `followUpCommitOrPr`. Excluding them at the type level is stronger than remembering not to
  interpolate them. The test asserts that a stub built from a label whose `intent` contains a
  distinctive token does not contain that token — but the test can only assert what the type already
  prevents, which is the right order.
- **GOTCHA**: The entry number is `DEC-YYYY-NN`; the builder does **not** know `NN` (that requires
  reading the file). Emit the literal `DEC-<YYYY>-NN` with the real year and leave `NN` for the human
  — a wrong number is worse than an obvious placeholder.
- **GOTCHA**: `nowIso` is a **parameter**, never `new Date()` inside — the repo's clock-injection
  rule, and it is what makes this testable.
- **VALIDATE**: `npx vitest run apps/dashboard/src/lib/decision-stub.test.ts`

### 12. CREATE the three dashboard proxy Route Handlers

- **IMPLEMENT**:
  - `app/api/labels/route.ts` — `GET` → `proxyJson("/v1/labels" + search)`. Forward the querystring
    from `req.nextUrl.searchParams`.
  - `app/api/labels/export/route.ts` — `GET` → `proxyStream("/v1/labels/export?" + search,
    req.signal)`.
  - `app/api/sessions/[sessionId]/label/route.ts` — `GET`/`POST`/`PATCH`/`DELETE` → `proxyJson`,
    threading `req.signal`.
- **PATTERN**: `api/members/[userId]/route.ts` (dynamic + PATCH/DELETE);
  `api/reports/[id]/export/route.ts` (stream).
- **IMPORTS**: `import { proxyJson } from "@/lib/proxy"` / `proxyStream`; `export const dynamic =
  "force-dynamic"` on every file.
- **GOTCHA**: `params` is a **Promise** — `await params`.
- **GOTCHA**: Pass the querystring through rather than reconstructing it; ingest's
  `additionalProperties:false` will 400 an unexpected key, which is the behaviour you want.
- **GOTCHA**: There is deliberately **no** `/api/labels/queue` proxy — the dashboard does not render
  the queue (that is the tray's job, D-16.2-3). Do not add one "for symmetry".
- **VALIDATE**: `npm run typecheck:dashboard`

### 13. CREATE `apps/dashboard/src/components/labels/label-form.tsx`

- **IMPLEMENT**: A controlled form over the six §4.3 fields + `confidence`, built from the shared
  arrays. Props: `initial: OutcomeLabelFields & { confidence }`, `onSubmit`, `onCancel`, `busy`.
- **PATTERN**: native `<select>` + `selectCls` from `export-view.tsx:80-100`.
- **GOTCHA (§4.3 acceptance criteria, not suggestions)**: `intent` is `maxLength={INTENT_MAX_LENGTH}`
  with a live remaining-character count; `followUpCommitOrPr` and `confidence` are visibly marked
  **optional**; neutral wording throughout; **no field is pre-selected with a guess** — an
  un-chosen `outcome` must submit nothing rather than default to a value no human picked
  (`routes/outcome-labels.ts:159-161` makes the same argument for the server).
- **GOTCHA**: A `qualityRating` of `1` must be as easy to click as `5` and must carry no red/negative
  styling — §4.3: "do not imply a low rating is user failure."
- **VALIDATE**: `npm run typecheck:dashboard`

### 14. CREATE `apps/dashboard/src/components/labels/labels-view.tsx`

- **IMPLEMENT**: The review island — a table of labels with filters (status / outcome / taskType),
  an inline edit row using `LabelForm`, a **Retract to skip** action, **Delete**, a **Log a decision**
  action rendering the stub in a copyable block, and an **Export** link.
- **PATTERN**: `team-view.tsx` — `useCallback` loader, `let cancelled = false` armed before the first
  await, per-row `busy` keyed by `sessionId`, `FORBIDDEN_MESSAGE` on 403, `router.refresh()` after a
  mutation, **plus the client re-fetch** (a changed prop does not update a mounted island —
  `team-view.tsx:76-86`).
- **GOTCHA — the skip/label transition**: "Retract to skip" sends `PATCH {"status":"skipped"}`, which
  the repository blanks all seven fields on (`outcome-labels.ts:448-477`) — tell the user that in the
  confirm copy, and tell them the prior revision is still readable. Upgrading a skip sends
  `status:"labeled"` **with the full judgement**; a partial patch is a 400 by design.
- **GOTCHA — the 403s are different**: PATCH 403 means "not the author" (no rung overrides it);
  DELETE 404 means "not yours" (never 403, so a colleague's judgement is not disclosed). Do not
  collapse them to one message.
- **GOTCHA**: The clipboard guard from `api-keys-card.tsx:153` — check `navigator.clipboard` first
  and keep the stub visible and selectable when it is unavailable.
- **VALIDATE**: `npm run typecheck:dashboard`

### 15. CREATE `apps/dashboard/src/app/labels/page.tsx`

- **IMPLEMENT**: Server Component; `getIngestJson<{labels: OutcomeLabelRow[]}>("/v1/labels?limit=200")`
  for the first paint; `PageShell title="Labels"`; render `<LabelsView labels={…} />`.
- **PATTERN**: `app/team/page.tsx`.
- **GOTCHA**: **An unreachable archive is not zero labels.** `getIngestJson` returns `null` on any
  non-200 — render "Could not reach the archive. Refresh to try again.", never an empty table. An
  empty table here is a *plausible* lie (unlike the team page, where it is impossible), which makes
  it more dangerous, not less.
- **GOTCHA**: `export const dynamic = "force-dynamic"`.
- **VALIDATE**: `npm run typecheck:dashboard` && `npm run build:dashboard`

### 16. CREATE `apps/dashboard/src/components/projects/session-label-actions.tsx` and wire it in

- **IMPLEMENT**: A per-row island: fetch `GET /api/sessions/:id/label`; **404 → "Label" button**
  (opens `LabelForm`, POSTs) / **200 → the label summary + "Edit"**. Include "Log a decision" here
  too — this is where the evidence is on screen.
- **UPDATE**: `project-detail-view.tsx` — add a `<TableHead>Label</TableHead>` and a `<TableCell>`
  rendering `<SessionLabelActions sessionId={s.sessionId} />` beside `SessionReportActions`
  (line 217).
- **PATTERN**: `session-report-actions.tsx`.
- **GOTCHA**: A 404 from `GET …/label` is the **expected** "no label yet" answer, not an error — same
  shape as `team-view.tsx` treating a 403 on invites as "no panel". Do not log it or show an error.
- **GOTCHA**: N sessions ⇒ N parallel fetches on mount. Bound it: only fetch for rows the user can
  see, or fetch `GET /api/labels?limit=200` **once** in the parent and pass each row its label. Prefer
  the single fetch — it is one request instead of N and the filter is already supported.
- **VALIDATE**: `npm run typecheck:dashboard` && `npm run build:dashboard`

### 17. UPDATE `apps/dashboard/src/components/app-nav.tsx`

- **ADD**: a `/labels` entry.
- **PATTERN**: the existing entries.
- **VALIDATE**: `npm run build:dashboard`

### 18. UPDATE `apps/desktop/src-tauri/src/proxy.rs`

- **REFACTOR**: `monitor_credentials()` → `ingest_credentials()` (it is no longer monitor-only).
  Keep the error message and its "name a remedy that exists" comment intact.
- **ADD**: a pure `fn label_path(base: &str, suffix: &str) -> String` beside `monitor_url`, and two
  commands:
  - `get_label_queue() -> Result<serde_json::Value, String>` — GET `/v1/labels/queue`.
  - `post_session_label(session_id: String, body: serde_json::Value) -> Result<serde_json::Value,
    String>` — POST `/v1/sessions/{session_id}/label`, `.json(&body)`.
- **UPDATE THE HEADER COMMENT**: lines 17-20 currently say "A `viewer` key is sufficient for this
  panel." **That becomes false** (D-16.2-4): writing a label is `member`-gated, so the configured API
  key must be `member` or above. Replace the claim — a stale comment asserting a weaker requirement
  is exactly the M15 15.5 defect class.
- **IMPORTS**: `reqwest` already has the `json` feature (`Cargo.toml:26`, verified).
- **GOTCHA**: URL-encode `session_id` into the path — it is a **connector-supplied string**, not a
  uuid, and may contain characters that are not path-safe. `monitor_url` never had to.
- **GOTCHA**: The token never crosses to the webview (the file's standing rule). Keep the same
  `MONITOR_TIMEOUT` bound on the new client builds.
- **ADD TESTS**: extend `#[cfg(test)] mod tests` with `label_path` cases including a trailing-slash
  base and a session id needing encoding.
- **VALIDATE**: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` — this is a **manual
  lane**; `repo-health` does not gate Rust (`scripts/repo-health.mjs:231-233`).

### 19. UPDATE `apps/desktop/src-tauri/src/lib.rs`

- **ADD**: `get_label_queue` and `post_session_label` to the `invoke_handler![…]` list.
- **GOTCHA**: A command that compiles but is not registered fails only at runtime, with an opaque
  "command not found" in the webview. `cargo check` will not catch it — the panel test will.
- **VALIDATE**: `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`

### 20. UPDATE `apps/desktop/src-tauri/src/tray.rs`

- **ADD**: a **static, enabled** menu item `"label_sessions"` captioned "Label sessions…" whose
  handler shows and focuses the main window.
- **GOTCHA — D-16.2-3**: **no live count.** A live tray label needs a stored `MenuItem` handle + a
  poll task, deliberately excluded in M11 Slice 4 (lines 15-18) and still excluded. The count lives
  in the panel.
- **GOTCHA**: This item **is** enabled, so unlike `server_status` it needs an `on_menu_event` branch.
- **VALIDATE**: `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`

### 21. UPDATE `apps/desktop/src/lib/bridge.ts`

- **ADD**: `getLabelQueue(): Promise<LabelQueueRow[]>`, `postSessionLabel(sessionId, body):
  Promise<{label: OutcomeLabelRow}>`, and a `skipSession(sessionId)` convenience that posts
  `{status:"skipped"}`.
- **PATTERN**: `getMonitorSnapshot` (lines 30-38) — Rust returns opaque JSON, the webview casts to the
  shared type, and the doc comment says what a rejection means.
- **IMPORTS**: `import type { LabelQueueRow, OutcomeLabelFields } from "@420ai/shared"`.
- **VALIDATE**: `npm run typecheck:desktop`

### 22. CREATE `apps/desktop/src/components/LabelQueue.tsx` and mount it

- **IMPLEMENT**: A `Card` panel: a count, the oldest-first queue, one expandable row at a time with
  the §4.3 form, a **Skip** button, and a "Nothing to label" empty state.
- **UPDATE**: `App.tsx` — mount `<LabelQueue />` in the stack, **after** `<SyncHealth />`.
- **PATTERN**: `SyncHealth.tsx` — a `refresh()` that surfaces a rejection as panel state rather than
  an unhandled rejection, and degrades to a hint when the API key is unset or ingest is down.
- **GOTCHA — D-16.2-3, the anti-nag contract**: this panel **must not** call
  `getCurrentWindow().show()`, request notification permission, or auto-focus. Say so in the file
  header so a later "improvement" has to argue with it. The tray item (task 20) is the only
  attention-getting affordance, and the human presses it.
- **GOTCHA**: If the API key is `viewer`, the queue **loads** and the submit **403s**. Render that
  refusal with the remedy ("this key is read-only — mint a `member` key at Settings → API keys"),
  not a bare status code. This is the D-16.2-4 consequence a user will actually hit.
- **GOTCHA**: Refresh the queue after a successful submit/skip; the row must disappear.
- **GOTCHA**: Arm the effect teardown before the first `await` (CLAUDE.md).
- **VALIDATE**: `npm run typecheck:desktop`

### 23. UPDATE the docs

- `docs/guide/usage.md` — a "Labelling sessions" section: the tray panel, the `/labels` review page,
  the skip semantics, and the decision-stub → `decisions.md` workflow **including its privacy rule**.
- `docs/guide/operations.md` — **the desktop API key must be `member` or above** (D-16.2-4). Find the
  15.9 section that currently says a `viewer` key suffices and correct it.
- **GOTCHA**: CI runs `prettier --check` on markdown; local `repo-health` does not. Run
  `npm run format` before pushing.
- **VALIDATE**: `npm run format:check`

### 24. UPDATE `SUMMARY.md`

- **IMPLEMENT**: Flip **16.2** to ✅ in **both** the §0 status block and the §6 roadmap, with a
  one-line "DONE `<date>` (PR #NN)".
- **GOTCHA**: `scripts/check-summary.mjs` requires the ✅ within 4 characters of the `**16.2**`
  token once `.agents/execution-reports/m16-slice2-*.md` exists. **Do not** write "M16 … is
  **DONE**" — that would disable per-slice checking for 16.3/16.4 (M16 plan, Risk 4).
- **GOTCHA**: Same commit as the execution report (CLAUDE.md).
- **VALIDATE**: `node scripts/check-summary.mjs`

---

## TESTING STRATEGY

### Unit Tests (always run, no infra)

| File | Asserts |
|---|---|
| `apps/dashboard/src/lib/decision-stub.test.ts` | The §11 template renders verbatim; ids/dates/closed-set values appear; **a distinctive token planted in `intent` does NOT appear** (D-16.2-5); the year comes from the injected clock; `NN` is left as a placeholder |
| `apps/dashboard/src/lib/label-display.test.ts` | Every member of `TASK_TYPES`/`OUTCOMES`/`FRICTIONS`/`LABEL_CONFIDENCE` has a human label (exhaustiveness loop over the shared arrays); `model_tool` → "Model / tool"; `qualityStars(null)` is not `0 stars` |
| `apps/desktop/src-tauri/src/proxy.rs` (`mod tests`) | `label_path` with and without a trailing slash; a session id containing a character requiring percent-encoding |

The dashboard has **no component-test lane** (only `src/lib/*.test.ts` exist), which is why every
piece of decidable logic above lives in `lib/` rather than inside a `.tsx`. Do not add a component
test runner in this slice.

### Integration Tests (`*.int.test.ts`, DB-backed)

- `packages/db/src/repositories/label-queue.int.test.ts` — the **two-role** suite, 9 tests, role
  identity first. This is the layer where a dropped policy or a missing predicate must turn the file
  red.
- `apps/ingest/src/outcome-labels.int.test.ts` — the queue endpoint's role gates plus the
  **behavioural app-role test** (queue → skip → gone), which is the only thing that catches a handler
  that forgot `withOrg` (the grep is file-granular and already exempts this file).

### Edge Cases (each must have a test or an explicit "not tested and why")

1. A session whose last event is **exactly** on the settle boundary (`< settledBefore` is strict —
   pin which side it falls on).
2. A session already **skipped** — never returns to the queue (§4.3 never-nag).
3. Two orgs sharing a `session_id`, one labeled — the other org's queue is unaffected (S5).
4. A session with events on **two machines** in the same org — one queue row, not two.
5. `GET …/label` 404 on the project page — renders "Label", not an error.
6. `PATCH` by a non-author — 403 with author-specific copy; `DELETE` by a non-author — 404.
7. A partial `PATCH` of §4.3 fields on a **skipped** row — 400, and the UI explains the upgrade path.
8. Archive unreachable — `/labels` says so; the desktop panel degrades and the local app still runs.
9. A `viewer` API key in the desktop — queue loads, submit 403s with the mint-a-`member`-key remedy.
10. Clipboard unavailable (non-secure context) — the stub stays visible and selectable.

---

## VALIDATION COMMANDS

All runnable from the repo root. Every one is a **gate**.

### Level 1: Syntax, style & types

```bash
npm run typecheck            # root tsc -b — MUST exit 0 (per-workspace build is NOT a substitute)
npm run typecheck:dashboard  # the dashboard's ONLY type enforcement
npm run typecheck:desktop    # the desktop webview's ONLY type enforcement
npm run lint                 # ESLint — NOT in repo-health, but CI runs it
npm run format:check         # prettier incl. markdown — NOT in repo-health, but CI runs it
```

### Level 2: Unit tests

```bash
npx vitest run apps/dashboard/src/lib/decision-stub.test.ts    # all pass
npx vitest run apps/dashboard/src/lib/label-display.test.ts    # all pass
npm test                                                        # full vitest run, 0 failures
```

### Level 3: Integration tests (**must actually run — `skipped ≠ passed`**)

```bash
npm run db:up && npm run db:migrate
# The TEST database is migrated separately from the dev one:
docker exec 420ai-archive psql -U 420ai -d 420ai_test -c "select 1 from outcome_labels limit 1;"
npx vitest run packages/db/src/repositories/label-queue.int.test.ts   # 9 passed, 0 skipped
npx vitest run apps/ingest/src/outcome-labels.int.test.ts             # all passed, 0 skipped
```

### The gate

```bash
npm run repo-health -- --require-db
```

**Pass signal**: exit 0, and the int-test layer is asserted to have **actually run with 0 skipped**.
A plain `repo-health` PASS does **not** prove the DB layer ran (CLAUDE.md). This slice touches
`@420ai/db` and `apps/ingest`, so `--require-db` is mandatory before sign-off.

### Level 4: Manual validation (the round-trip)

Rust is **not** gated by `repo-health` (CI is Linux), so these are the desktop lanes:

```bash
cargo test  --manifest-path apps/desktop/src-tauri/Cargo.toml   # label_path unit tests pass
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml   # 0 errors
npm run build:dashboard                                          # next build — also catches barrel breakage
```

Then, with the stack up and a **`member`** API key configured:

1. Generate a session; wait past the 15-minute settle window (or seed one with an older `ts`).
2. Desktop → the panel shows it. Fill the form → submit → the row disappears.
3. Dashboard `/labels` → the label is there, with the right author and revision 1.
4. Edit it → revision 2; `GET /v1/sessions/:id/label/revisions` shows both.
5. **Retract to skip** → all seven fields blank on the current row, judgement still readable in v1.
6. "Log a decision" → copy the stub; confirm it contains the session id and **not** the `intent`.
7. Export → CSV downloads, `intent` is redacted (D-16.1-7).
8. Delete → 204; re-query the raw record and **prove it is unmutated** (pre-sign-off checklist item 1).
9. Confirm the panel never raised a window or fired a notification at any point (D-16.2-3).

Evidence to `.agents/qa/m16-signoff/`.

### Level 5: Additional

```bash
grep -rn "ADMIN_TOKEN" apps/desktop/src-tauri/src/proxy.rs   # expect 0 live uses (only the historical note)
grep -c "$API_KEY" <served /labels HTML>                      # expect 0 — the browser never holds the key
```

---

## ACCEPTANCE CRITERIA

**Research plan §4.3 rules — acceptance criteria, not suggestions** (M16 plan, Risk 3):

- [ ] **Offer skip** — a one-click Skip in the desktop panel and a Retract-to-skip in the dashboard
- [ ] **Do not nag repeatedly** — a skipped session never reappears in the queue (int-tested), and the
      app never raises a window, fires a notification, or steals focus (D-16.2-3)
- [ ] **Always editable** — every label is editable from `/labels` and from the project session row
- [ ] **Private to the archive** — no label field is emitted to any surface that leaves the archive
      except the redacted export; the decision stub carries **no free text** (D-16.2-5)
- [ ] **Neutral wording** — no field or value implies user failure; a 1 is as easy to give as a 5
- [ ] **No inference** — nothing in this slice writes a label the operator did not choose, and no
      field is pre-filled with a guess

**§7 P0.2 / P1.5:**

- [ ] A label can be **created, edited, skipped, exported and deleted** from a UI (P0.2 acceptance)
- [ ] A session can link to a decision **without exposing raw contents** (P1.5 acceptance)

**Engineering:**

- [ ] `npm run repo-health -- --require-db` passes; int tests ran with **0 skipped**
- [ ] `npm run typecheck` (root), `typecheck:dashboard`, `typecheck:desktop` all exit 0
- [ ] `npm run lint` and `npm run format:check` pass
- [ ] `cargo test` + `cargo check` on `apps/desktop/src-tauri` pass; `npm run build:dashboard` passes
- [ ] The two-role suite's **first** test asserts role identity
- [ ] The cross-org negative control is a **test**, not just a comment
- [ ] **No migration and no schema change** — 16.1's tables are unchanged
- [ ] No new dependency in any `package.json` or `Cargo.toml`
- [ ] `SUMMARY.md` 16.2 → ✅ in §0 and §6, in the execution-report commit
- [ ] The PR names the M16 non-goals

---

## COMPLETION CHECKLIST

- [ ] All 24 tasks completed in order
- [ ] Each task's `VALIDATE` command passed immediately after that task
- [ ] All validation commands executed successfully
- [ ] Full suite passes (unit + integration, 0 skipped)
- [ ] No lint, format or type errors in any of the three type lanes
- [ ] The manual round-trip (Level 4) completed, evidence in `.agents/qa/m16-signoff/`
- [ ] Every acceptance criterion met
- [ ] Code reviewed via `/lril:code-review`, then `/lril:post-execute`

---

## NOTES

### Decisions taken in this plan

**D-16.2-1 — The queue is a SERVER endpoint, not client-side filtering.**
The alternative was for the tray to pull sessions and labels separately and diff them. Rejected: the
client has no bounded way to enumerate "my sessions" (`sessionProjections` is project-scoped and
`activeSessions` is the wrong window), and "never nag" would then be a client behaviour that a
reinstall resets. On the server it is a `count(labels.id) = 0` predicate over durable rows.

**D-16.2-2 — "Settled" means `max(ts) < now − ACTIVE_WINDOW_MS`; the lookback is 14 days.**
The settle threshold **is** the Live Monitor's active window, promoted from `routes/monitor.ts:46`
into `@420ai/shared`, so a session can never be simultaneously "active now" and "ready to label" —
the two surfaces would otherwise be able to disagree, and asking a human to judge a session they are
still in the middle of is the fastest route to Risk 3. The 14-day lookback follows §3's Friday
cadence: one full missed week of slack. Sessions older than that are deliberately unreachable from
the queue and are labelled from `/labels` instead; 16.4 counts them as never-asked-about.

**D-16.2-3 — Pull-only. The app never raises a window, notifies, or steals focus.**
§4.3's "do not nag repeatedly" is made structurally impossible rather than tuned. The cost is stated
honestly: completion depends on the operator opening an app they already run. The mitigation is the
tray menu item, which is an affordance the human presses. Rejected alternative: one OS notification
per settled session — higher completion, but it is a genuine interruption during exactly the deep
work being measured, and a measurement that changes the thing it measures is worse than a lower
completion rate. Also rejected: a **live** tray count, which needs a stored `MenuItem` handle and a
poll task that M11 Slice 4 deliberately excluded (`tray.rs:15-18`).

**D-16.2-4 — The desktop's API key rung rises from `viewer` to `member`.**
Writing a label is `member`-gated (D-16.1-4) and the tray now writes. `proxy.rs:17-20` currently
claims a `viewer` key suffices; that comment must change with the code, and `operations.md` with it.
A stale comment asserting a weaker requirement is the M15 15.5 defect class. The failure mode is
handled rather than hidden: a `viewer` key loads the queue and 403s the submit, so the panel renders
the mint-a-`member`-key remedy.

**D-16.2-5 — The decision stub carries IDs and closed-set values ONLY. Never free text.**
`.agents/research/decisions.md` is **committed to a public repository** and its §3 privacy rule is
"links/IDs only". `intent` (200 chars of free text) and `followUpCommitOrPr` (a pasted URL) are the
two fields `GET /v1/labels/export` redacts (D-16.1-7); pasting them into a public file is strictly
worse than exporting them. They are excluded **at the type level** of `buildDecisionStub`'s input, so
the exclusion is not a thing anyone has to remember. Everything the stub does emit
(`taskType`/`outcome`/`primaryFriction`/`qualityRating`/`confidence`) is a member of an array in
`@420ai/shared/outcome-labels` — a value the operator **selected**, not one they **typed**.

**D-16.2-6 — §7 P1.5 gets NO new table.**
The decision log already exists as a research-plan §3 source-of-truth artifact with a §11 template.
A `decisions` table would create a second log that diverges from the first, and would need a
migration, an RLS classification, a two-role suite and a dashboard surface to reach parity with a
markdown file that already works. The acceptance criterion — "a report or session can link to a
decision without exposing raw contents externally" — is met by generating the link. Revisit if a
design partner (research Phase 3, weeks 9-10) needs a decision log they cannot edit in git.

### Spikes actually RUN during planning (throwaway deleted)

A single throwaway two-role integration file
(`packages/db/src/repositories/spike-label-queue.int.test.ts`) was written, run against the **live
`420ai_test` database** with both the owner and `420ai_app` handles, and then deleted. **6/6 passed.**
Raw output:

| # | Spike | Result |
|---|---|---|
| **S1** | The candidate query returns only settled + in-window + unlabeled sessions | ✅ returned exactly `['settled-unlabeled', 'SHARED-SESSION']`; the still-active and the 7-months-old sessions were correctly absent |
| **S2** | Do aggregate timestamps arrive as ISO? | ❌ **No** — `max(ts)` returned the string `"2026-08-01 00:00:00+00"`; `raw === new Date(raw).toISOString()` was `false`. **`toIso` normalization is mandatory**, confirming the CLAUDE.md gotcha applies to this query (the M5/M9 bug class) |
| **S3** | A `labeled` session leaves the queue | ✅ queue went to `['SHARED-SESSION']` |
| **S4** | A `skipped` session leaves the queue | ✅ queue went to `['SHARED-SESSION']` — §4.3's never-nag is free, given D-16.1-2 |
| **S5** | **Negative control**: drop the join-side `orgId` predicate | ✅ **the bug reproduces** — with org B holding a label on a shared `session_id`, org A's queue lost the session (`['settled-unlabeled']`); with the predicate restored it returned (`['settled-unlabeled', 'SHARED-SESSION']`). Measured on the **owner** handle, so this measures the predicate, not RLS |
| **S6** | Runs under the non-owner `420ai_app` role inside `withOrg` | ✅ same two rows, `eventCount === 2` each — **no left-join fan-out** |
| **S7** | Package/tooling presence for everything the snippets touch | ✅ `reqwest` has `features = ["json", "rustls-tls"]` (`Cargo.toml:26`); `cargo 1.95.0` on PATH; test DB carries `outcome_labels` + `outcome_label_revisions`; native `<select>` is the established idiom (no shadcn CLI needed); `navigator.clipboard` pattern already shipped |

**S5 is the reason this plan is worth its length.** The join-side org predicate is a one-line
difference that no type checker, no `tsc -b` and no owner-connected test would have caught, and its
failure mode is silent: the operator's session simply never appears in the queue, so it never gets
labelled, so 16.4's denominator is quietly wrong. It is now a required test (task 6, test 7).

### Symbols verified by reading source (not from memory)

`createOutcomeLabel` · `updateOutcomeLabel` · `deleteOutcomeLabel` · `getOutcomeLabel` ·
`listOutcomeLabels` · `listOutcomeLabelRevisions` · `OutcomeLabelRow` · `PatchOutcomeLabelInput` ·
`CreateOutcomeLabelInput` · `OutcomeLabelError` (+ its four reasons and their status mapping at
`app.ts:302-317`) · `withOrg` · `resolvePrincipal` · `authorized` · `sessionDetail` ·
`sessionProjections` · `activeSessions` · `toIso` · `ACTIVE_WINDOW_MS` (`routes/monitor.ts:46`) ·
`MONITOR_THRESHOLDS` · `proxyJson` / `proxyStream` · `getIngestJson` · `adminHeaders` ·
`FORBIDDEN_MESSAGE` / `FORBIDDEN_SHORT` · `formatDate` / `formatAgo` · `PageShell` ·
`SessionReportActions` · `monitor_credentials` / `monitor_url` (Rust) · `build_tray` ·
`sendCommand` / `getMonitorSnapshot` (bridge).

### Harness confirmed to exist

`packages/db/src/repositories/outcome-labels.int.test.ts` — `batch()` (45-67), `errorChain()`
(76-84), `expectRlsRejection()` (87-100), `WRITE_ROLE` (103), the `beforeEach` seeding block
(134-158), `seedLabelA()` (161-176), and the role-identity test (182-195). `ensurePersonalOrg` and
`ingestBatch` are imported there and re-used here. The dashboard's test lane is `src/lib/*.test.ts`
only — no component runner — which is why tasks 10 and 11 put the decidable logic in `lib/`.

### Trade-offs accepted

- **Pull-only capture may under-collect.** Accepted per D-16.2-3; if completion is poor after two
  research weeks, the *evidence* for changing it will exist, which is the scope-change rule working.
- **N label fetches on the project page.** Task 16 resolves this to one `GET /api/labels?limit=200`
  in the parent rather than a per-row fetch.
- **Rust is not gate-enforced.** `cargo test`/`cargo check` are named as an explicit manual lane
  (Level 4) rather than assumed. The Rust surface is deliberately tiny — two commands mirroring an
  existing one, plus one static menu item.

### Confidence

**9.5 / 10** for one-pass success. The evidence: six spikes actually run against the live test
database (including a negative control that reproduced a real cross-tenant bug before any code was
written), every referenced symbol read rather than recalled, the two-role harness confirmed with
exact helper names and line numbers, zero new dependencies with the one non-obvious dependency
(`reqwest`'s `json` feature) verified present, and **no schema change**, which removes migration,
RLS-classification and down-SQL risk entirely.

The residual half-point is the Rust lane: `repo-health` cannot gate it, so tasks 18-20 rest on the
executor running `cargo check`/`cargo test` locally. It is not closable by more planning — only by
running the commands, which is why they are Level-4 gates with explicit pass signals rather than a
footnote.
