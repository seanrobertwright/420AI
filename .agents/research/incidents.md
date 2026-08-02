# Incident log

Every capture, data-quality, or onboarding failure — recorded, categorized, and left **unfixed until
it earns a fix**. Backs the "Incidents and data gaps" section of each weekly scorecard
([`weekly/TEMPLATE.md`](./weekly/TEMPLATE.md)) and the §4.4 mismatch log of
[`research-analysis-plan.md`](../supplemental%20docs/research-analysis-plan.md).

> **PRIVACY RULE (§3).** No captured session content, secrets, access tokens, or personally
> identifying source data. Aggregate metrics, anonymized consented quotes, and links/IDs only.
> An incident describes a **failure**, which means the temptation to paste a payload is at its
> highest here — paste the session id and the parser version instead. Refer to participants by code
> (`P-01`).

## Why entries sit here unfixed

**D-16.0-2:** a measured problem is not fixed on sight. §2's scope-change rule requires a named
data-quality failure before a feature is built, and an entry here is exactly how that justification
gets created. Fixing friction the moment it is observed converts measured evidence into a guess, and
leaves any later "we improved this" claim with no before-number behind it.

The exception is severity: §5.3 makes _no unresolved high-severity capture/data-loss incident for
more than one week_ a guardrail metric. High severity is fixed now; everything else earns a slice.

## Categories (§4.4)

Every entry carries exactly one: **capture** · **parser** · **attribution** · **pricing** ·
**projection** · **UX** · **user-understanding**.

The last two are as real as the first five. "The number was right and the user read it wrong" is a
product failure, and §12 warns specifically against treating a user-understanding problem as a
feature request.

## Severity

| Severity | Meaning                                                                                  |
| -------- | ---------------------------------------------------------------------------------------- |
| **high** | Data loss, unrecoverable capture gap, or a leaked secret. Fix within one week (§5.3).      |
| **med**  | Metric is wrong or misleading; a workflow is blocked but has a workaround.                 |
| **low**  | Friction, confusion, or slowness with no effect on data correctness.                       |

## Entry format

```markdown
## INC-YYYY-NN — <short title>

- **Date / observed by:**
- **Severity:** high / med / low
- **Category (§4.4):** capture / parser / attribution / pricing / projection / UX / user-understanding
- **What happened:**
- **User impact:**
- **Root cause:** (or "not yet diagnosed")
- **Evidence:** session/report IDs, parser version, connector, log excerpt with secrets removed
- **Disposition:** fixed now (high severity) / backlog item / earns a slice — which one
- **Regression test?** yes (name it) / no (why not)
```

§6 Phase 1 step 5 is the rule for parser and capture fixes: **add a regression test and fixture for
each one.** A fixed parser bug with no fixture is a bug that returns.

---

## Entries

<!-- Newest first. -->

All five below were raised by the 2026-08-02 clean-room deploy
([`cleanroom-2026-08-02.md`](./cleanroom-2026-08-02.md), slice 16.0 part 4). **None is fixed** —
D-16.0-2: the exercise measures, and each entry is the evidence that earns a fix under §2's
scope-change rule.

## INC-2026-06 — a separate DATABASE is not isolation: Postgres ROLES are cluster-wide

- **Date / observed by:** 2026-08-02 / clean-room deploy, slice 16.0
- **Severity:** med
- **Category (§4.4):** capture _(tooling/environment — the closest §4.4 fit; it is an isolation defect
  in the operating procedure, not in captured data)_
- **What happened:** The clean room used a **separate database** (`420ai_cleanroom`) on the shared
  Postgres instance, per the slice plan's isolation constraint. Running `npm run db:provision-app-role`
  inside it reset the password of the **`420ai_app` role**. Roles in Postgres are **cluster-scoped, not
  database-scoped**, so this reached straight out of the clean room and invalidated the real repo's
  `DATABASE_URL_APP` / `DATABASE_URL_TEST_APP`. The next full `npm test` produced **223 failures across
  12 files**, every one a Postgres `28P01 auth_failed`.
- **User impact:** For a window, the real repository's entire two-role integration layer was broken by
  an exercise that had been designed — and reviewed — as isolated. The failure is loud (`28P01`) but
  the *cause* is not: nothing points from "223 auth failures in the main repo" back to "a second
  checkout provisioned a role an hour ago". Anyone hitting this without having just run a clean room
  would reasonably suspect their own `.env`, Docker, or the RLS work itself.
- **Root cause:** the slice plan's isolation checklist specified a separate **database**, a separate
  **collector home**, and separate **ports** — but not a separate **role** or a separate **Postgres
  instance**. `provision-app-role` issues a cluster-level `ALTER ROLE … PASSWORD`, and there is nothing
  database-scoped about it. Self-healed once the real repo's own tooling re-provisioned the role with
  its own password (verified: both handles authenticate, full suite 148 files / 1313 tests green).
- **Evidence:** 223 failing tests, all `28P01 / auth.c / auth_failed`; both `DATABASE_URL_TEST` and
  `DATABASE_URL_TEST_APP` verified authenticating afterwards; full suite re-run green.
- **Disposition:** **backlog → procedure fix, and it changes how the exercise is run next time.** A
  future clean room must use a **separate Postgres container** (a second `docker compose` project on
  another host port), not merely a second database — or, at minimum, a distinctly-named role. Record
  this in the clean-room procedure before repeating. **Not a product fix**, so D-16.0-2 does not apply
  to it; nothing in the shipped code changed.
- **Regression test?** Not applicable — this is a defect in the isolation *procedure*. The durable
  guard is the corrected procedure note above.

## INC-2026-01 — `--home` does not scope the Cursor poll connector; it reads the real `%APPDATA%` store

- **Date / observed by:** 2026-08-02 / clean-room deploy, slice 16.0
- **Severity:** **high**
- **Category (§4.4):** capture
- **What happened:** `collector watch --home <isolated>` logged
  `cursor: 260/350 session(s) changed → 16916 record(s), 39888 event(s)`. The isolated home contained
  exactly two seeded files. The 350 sessions came from the operator's **real** Cursor store.
- **User impact:** `--home` is documented — in `CLAUDE.md` and in the CLI's own help — as repointing
  credentials, the queue **and the session globs** together, and as "comprehensive on purpose". For
  the Cursor connector it is not. Two concrete consequences: (a) a Windows **service** running
  `watch --home C:\Users\<you>` under LocalSystem reads whichever account's `%APPDATA%` the service
  has, not the named home — the exact footgun `--home` exists to prevent, inverted; (b) any isolated
  or test collector silently ingests the real user's Cursor history into whatever archive it points
  at. In this run that was a throwaway database, now dropped. It might not be next time.
- **Root cause:** `apps/collector/src/connectors/cursor.ts:331` —
  `sources: () => [defaultCursorStorePath()]`. The `PollCapability.sources(home)` contract passes a
  `home` argument (`connectors/connector.ts`); this implementation **discards it** and derives the
  path from `process.env.APPDATA` instead. The comment above it explains the laziness of the env read
  (so a test can override it) but not the missing `home`. Every tail-mode connector honours `home`
  via `watchGlobs(home)`; the poll capability was added later (M13 13.7) and this one site did not
  follow.
- **Evidence:** collector watch log line above; `queue.sqlite` in the isolated home held
  **64,433 pending** items and `poll_state` 282 rows; the clean-room archive received
  539 raw / 461 events before teardown. Real archive: 0 machines throughout.
- **Disposition:** **earns a slice.** Not fixed in 16.0. Deliberately excluded from 16.0's
  narrowly-drawn F1/F2 exception: F1/F2 were one-line entrypoint defects, whereas this touches the
  connector contract and needs a decision about whether `sources(home)` should be *required* to
  derive from `home` (and what that means for a store that genuinely lives in `%APPDATA%`).
  Candidate home: **16.3**, whose subject is capture health and connector state.
- **Regression test?** Not yet. The fix must ship with one, and the honest shape is a test that calls
  `cursor.poll.sources(home)` with a synthetic home and asserts the returned path is **under** it —
  plus a check that no connector's declared sources escape a given home, so the next poll connector
  cannot repeat this.

## INC-2026-02 — quickstart's step 3 fails on a fresh clone: the workspaces are never built

- **Date / observed by:** 2026-08-02 / clean-room deploy, slice 16.0
- **Severity:** med
- **Category (§4.4):** UX
- **What happened:** Following `docs/guide/quickstart.md` verbatim, step 3's `npm run ingest:dev`
  exits immediately with
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/node_modules/@420ai/db/dist/index.js'`.
- **User impact:** The API cannot start, at the first step that produces anything visible. The error
  names an internal path inside `node_modules` and gives no hint that a build is required, so it
  reads as a broken install — the most likely user response is to delete and re-clone, which does not
  help.
- **Root cause:** `apps/ingest` imports the compiled `@420ai/db` (`dist/`), which only exists after
  `tsc -b`. `package.json` has both `build` and `typecheck` mapped to `tsc -b`, but **quickstart never
  mentions either**. `npm install` does not build workspaces.
- **Evidence:** full stack trace in the run; recovery was `npm run build` (8 s), after which ingest
  progressed to the next failure (INC-2026-03).
- **Disposition:** backlog → doc fix. Add a build step to quickstart step 1 or 2. Cheap, but **not
  fixed here** (D-16.0-2) — it is onboarding friction, which is the thing being measured.
- **Regression test?** No. The durable fix is not a test but a **smoke script** that runs the
  documented path end-to-end on a fresh clone in CI; without that, the guide will drift again.

## INC-2026-03 — quickstart omits `db:provision-app-role`; ingest then fails Postgres auth

- **Date / observed by:** 2026-08-02 / clean-room deploy, slice 16.0
- **Severity:** med
- **Category (§4.4):** UX
- **What happened:** After INC-2026-02 was worked around, `npm run ingest:dev` failed again with
  Postgres `28P01` (`password authentication failed`, `routine: 'auth_failed'`) for the non-owner
  role `420ai_app`, because that role had never been created.
- **User impact:** A raw Postgres FATAL with no application-level guidance. The role is the M15 15.3
  RLS app role, so the failure is a consequence of a security decision the user has not read about
  yet.
- **Root cause:** the role must be provisioned by `npm run db:provision-app-role`. **`scripts/setup-env.mjs`
  prints this as its own "next steps" item 2** — but `docs/guide/quickstart.md` does not contain the
  string at all (`grep -c provision-app-role docs/guide/quickstart.md` → **0**). The tool knows; the
  guide does not. Two sources of truth for the setup sequence, disagreeing.
- **Evidence:** ingest log with the `28P01` payload; the grep above; recovery took 2 s once known.
- **Disposition:** backlog → doc fix, together with INC-2026-02. The deeper fix is to stop maintaining
  the sequence in two places — have the guide reference the setup script's output, or the script
  reference the guide. **Not fixed here** (D-16.0-2).
- **Regression test?** No — same reasoning as INC-2026-02; a fresh-clone smoke run is the only thing
  that actually pins a documented sequence.

## INC-2026-04 — `npm run setup` hardcodes `INGEST_URL=…:8420` into the dashboard env

- **Date / observed by:** 2026-08-02 / clean-room deploy, slice 16.0
- **Severity:** med
- **Category (§4.4):** capture
- **What happened:** `scripts/setup-env.mjs` writes `apps/dashboard/.env.local` with a literal
  `INGEST_URL=http://localhost:8420` — the default port — even when the rest of the environment is
  being pointed elsewhere.
- **User impact:** A second stack on the same machine (clean room, test instance, staging) gets a
  dashboard that talks to the **real** archive on 8420 while every other component talks to the
  isolated one. Nothing warns, and the dashboard looks like it is working. In this run the real ingest
  happened to be **down** (`HTTP=000` on 8420), so no cross-talk occurred — that is luck, not a
  control.
- **Root cause:** the generated dashboard env takes the default rather than deriving from the
  repo-root `.env`'s `INGEST_URL`/`INGEST_PORT`.
- **Evidence:** generated `.env.local` contents; corrected by hand to 8999 during the run.
- **Disposition:** backlog. **Not fixed here** (D-16.0-2). Note it is adjacent to, but not the same
  as, the F1/F2 class — it did not compromise this exercise's safety conclusion, because the write-side
  isolation checks all passed independently.
- **Regression test?** A unit test on `setup-env.mjs` asserting the dashboard `INGEST_URL` matches the
  root `.env` would pin it, and is cheap.

## INC-2026-05 — a fresh install captures nothing until new activity, and says nothing about it

- **Date / observed by:** 2026-08-02 / clean-room deploy, slice 16.0
- **Severity:** med
- **Category (§4.4):** user-understanding
- **What happened:** With a session file already present in the collector home, `watch` ran for 45 s
  and captured **zero** events, logging only `watching 8 connector(s) …`. The file watcher cursors
  pre-existing files at EOF (correct — it must not re-ingest history on every start), so a static
  file produces nothing until it grows. Capture only began when new content arrived.
- **User impact:** This is the precise failure mode research plan §7 P0.1 names: the user **cannot
  distinguish "no work happened" from "capture is broken."** A new user who installs the collector,
  looks at an empty dashboard, and sees a cheerful `watching 8 connector(s)` has no way to tell which
  of the two is true — and the most likely conclusion after a few minutes is that the product does not
  work.
- **Root cause:** correct-by-design cursor behaviour, with **no surfacing**. There is no
  "0 sessions seen yet, waiting for activity" state anywhere in the CLI output or the Monitor.
- **Evidence:** watch log; archive at 0 events after the first pass; events appeared only after a
  session file was added mid-run.
- **Disposition:** **this is 16.3's headline case.** Not a bug to fix in isolation — it is the
  acceptance criterion of the capture health scorecard, quoted verbatim in
  `.agents/plans/m16-dogfood-instrumentation.md` §7 P0.1. Recorded here so 16.3 has a concrete,
  observed instance to design against rather than an abstraction.
- **Regression test?** Deferred to 16.3, where the assertion is behavioural: a scorecard built from a
  collector that has seen no activity must report a state distinguishable from one whose connector is
  failing.
