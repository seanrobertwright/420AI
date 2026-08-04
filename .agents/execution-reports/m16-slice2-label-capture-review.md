# Execution report — M16 slice 16.2: label capture (desktop) + review (dashboard)

**Date:** 2026-08-04
**Commits:** `e8e3258` (slice), `eb198c0` (code-review fixes)
**Plan:** `.agents/plans/m16-slice2-label-capture-review.md`
**Code review:** `.agents/code-reviews/m16-slice2-label-capture-review.md`

---

## What shipped

The two surfaces that make 16.1's outcome-label model reachable by a human. Before this, every
label cost a terminal, a session id looked up by hand and a JSON body — so completion across a
24-week research period would have been zero and every 16.4 outcome metric would have been computed
over an empty set (research plan §12 / M16 Risk 3).

- **Capture** — a "Sessions to label" panel in the desktop app: a server-computed queue of settled,
  unlabeled sessions, a six-field form, and a one-click Skip.
- **Review** — `/labels` in the dashboard: filter, edit, retract-to-skip, delete, export; plus the
  same affordance on each row of a project's Sessions table.
- **Decision links** (§7 P1.5) — a "Log a decision" action rendering a pre-filled `DEC-YYYY-NN` stub
  for `.agents/research/decisions.md`.

**One additive endpoint** (`GET /v1/labels/queue`, `viewer`-gated). **No schema change, no
migration, no new dependency** in any `package.json` or `Cargo.toml`.

## Plan adherence

All 24 planned tasks executed in order. Five deviations, each measured rather than assumed:

| # | Plan said | Reality | Resolution |
|---|---|---|---|
| 1 | Task 2 validates via `apps/ingest/src/monitor.test.ts` | That file does not exist | Ran `packages/shared/src/monitor.test.ts` (15 passed) |
| 2 | Task 12: `additionalProperties:false` "will 400 an unexpected key" | No custom ajv instance is registered, so Fastify's default `removeAdditional:true` **strips** unknown querystring keys → **200** | Test pins the measured behaviour and names which mechanism is loud (`limit` → 400) and which is silent (unknown key → stripped) |
| 3 | — | `@420ai/shared/outcome-labels` subpath did not exist; the bare `@420ai/shared` vitest alias then swallowed it | Added the subpath export + **ordered** vitest aliases (`/outcome-labels`, `/roles`) ahead of the bare key |
| 4 | Task 16: fetch labels once "in the parent" | `project-detail-view.tsx` is a Server Component — no client parent exists to hold the state | Module-scoped shared in-flight promise, invalidated on every mutation. Same one-request-not-N outcome without moving a large server-rendered table into the browser bundle |
| 5 | D-16.2-5 excludes `intent` + `followUpCommitOrPr` | A `projectPath` routinely carries a client or employer name (`C:\work\acme-corp\…`) | Excluded it at the type level too |

## Decisions settled

- **D-16.2-1** — the queue is a SERVER read, not client-side filtering. A client cannot bound
  "my sessions", and "never nag" would become client behaviour a reinstall resets.
- **D-16.2-2** — "settled" is `max(ts) < now − ACTIVE_WINDOW_MS`, the Live Monitor's own active
  window **promoted** into `@420ai/shared` rather than duplicated; the 14-day lookback follows §3's
  Friday cadence (one missed week of slack).
- **D-16.2-3** — pull-only. No window raise, no notification, no poll, no focus steal; the tray item
  is static with no count.
- **D-16.2-4** — the desktop API key rung rises `viewer` → `member`, because the panel now writes.
- **D-16.2-5** — the decision stub carries IDs and closed-set values only, enforced at the type
  level (`never`).
- **D-16.2-6** — §7 P1.5 gets no new table; the markdown decision log already exists.

## What the process caught, and where it caught it

Three defects, each found by a different layer. Worth recording because the layers are not
interchangeable.

**1. The join-side `orgId` predicate — caught in PLANNING, re-caught in EXECUTION.**
`session_id` is connector-supplied and globally scoped, so the queue's `leftJoin` needs
`eq(outcomeLabels.orgId, orgId)` on the join condition. Planning reproduced the missing-predicate
bug as a negative control (spike S5); execution reproduced it again by deleting the predicate and
re-running: exactly one test failed, the cross-org one, on the **owner** handle so it measures the
predicate rather than the RLS backstop. Its failure mode is silence — the session never appears, so
it is never labelled, so 16.4's denominator is quietly wrong.

Note the placement is also load-bearing: the same predicate in the `where` would turn the left join
into an inner one and drop every unlabeled session. Right guard, wrong clause, opposite bug.

**2. `next build` caught what two type lanes did not.** `typecheck:dashboard` accepted a
`./label-display.js` relative import; webpack rejected it. This is exactly why CLAUDE.md makes
`build:dashboard` a gate rather than a convention — the dashboard is out of the root `tsc -b` graph,
and its two type lanes agreeing is not the same as the thing building.

**3. The POST/PATCH null asymmetry — caught only by CODE REVIEW, and it was the important one.**
`createOutcomeLabelBodySchema` types `followUpCommitOrPr` and `confidence` as `type: "string"` with
no null member; the PATCH schema allows `["string","null"]`. Fastify's default ajv **coerces** null
to `""`, which then fails `minLength: 1` and the `enum`. Both new capture surfaces sent null for an
unset optional, so both 400'd on their **default** path — a 15-second label usually leaves both
blank.

Three things about this are worth carrying forward:

- **It hid behind a working sibling.** The edit path is a PATCH, where null is legal. Editing worked
  perfectly, so the surface looked functional right up until a *new* label was saved.
- **Reading the schema does not predict it.** The rejection arrives as a length/enum complaint, not
  a type one, because of a coercion step that is not in the schema at all. It had to be measured —
  a throwaway int test against the live DB gave 400 / 400 / 201 for null / null-confidence /
  omitted.
- **Every automated gate was green.** `tsc -b`, three type lanes, 1389 tests, 567 integration tests,
  lint, format, `next build`, `cargo test` — all passed with the primary user path broken, because
  nothing exercised a POST with the optional fields blank. That gap is now a regression test.

The asymmetry itself was left intact rather than widened: a POST has no prior value to CLEAR, so
null and absent would mean the same thing, and one spelling for one meaning is the better contract.
What was missing was a test saying so.

## Validation

| Gate | Result |
|---|---|
| `npm run repo-health -- --require-db` | **PASS** — 154 files, 1390 tests, **567 integration, 0 skipped** |
| `npm run typecheck` (root `tsc -b`) | 0 errors |
| `typecheck:dashboard` / `typecheck:desktop` | 0 errors |
| `npm run lint` / `format:check` | PASS |
| `npm run build:dashboard` | Compiled successfully |
| `cargo test` / `cargo check` (desktop) | 36 passed / 0 errors |
| Negative control (predicate removed) | 1 test failed, the right one; restored → 10/10 |

**Not run: the Level-4 manual round-trip.** It needs the Tauri GUI and an authenticated browser
session, so `.agents/qa/m16-signoff/` has no new evidence and the rendered UI is unverified. The
create → edit → revisions → redacted export → delete → **raw records provably unmutated** chain *is*
machine-verified by `apps/ingest/src/outcome-labels.int.test.ts`. This deferral is not free: the
critical defect above is precisely the class one manual submit would have caught in five seconds.

## Environment note — OneDrive interference (three episodes)

The repo lives under OneDrive and is synced across two machines, and a concurrent session was
planning slice 16.3 on the other one. Three distinct episodes during this slice, all recovered:

1. `label-queue.ts` vanished mid-slice and did **not** return; `tsc -b` reported one missing module
   and cascaded into ~40 unrelated errors. It resurfaced at the end as a `-Living-Room` **conflict
   copy** holding the *newer* content, with the *older* version restored under the real name.
2. `.git` itself synced from the other machine and moved `HEAD` onto the 16.3 branch mid-session.
   Caught in preflight by checking branch identity before committing.
3. Committed files dehydrated twice and rehydrated within ~20–60 s with working-tree edits intact.

**The one worth acting on:** during episode 3, a full `repo-health --require-db` run reported
**PASS with 549 integration tests instead of 566** — 17 tests silently absent because their files
were not on disk to collect. `0 skipped` does **not** mean "all files collected". Re-running on a
stable tree gave the expected 567. A gate that counts what ran cannot see what was never there.

## Follow-ups

- **Deferred to 16.4** (maintainer decision at the triage gate): a failed shared label read is
  cached for 30 s, so one failure becomes N per-row requests until it ages out. Degraded-path only,
  self-healing; 16.4 touches these reads.
- **For 16.3/16.4:** `QUEUE_PAGE_SIZE` (desktop display) mirrors `DEFAULT_QUEUE_LIMIT` (ingest
  route) as a second constant. Documented, low drift risk, not worth a shared export for a display
  hint — but worth folding in if 16.4 needs the limit anyway.
- **Sign-off blocker:** the M16 pre-sign-off checklist item "a label round-trips: created from the
  tray, visible and editable in the dashboard, exported, deleted — with the raw record provably
  unmutated" is **half** satisfied. The API half is proven; the UI half needs the manual pass.
