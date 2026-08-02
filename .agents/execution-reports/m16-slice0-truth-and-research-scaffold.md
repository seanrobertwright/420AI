# Execution report — M16 slice 16.0, Truth + Research Scaffold

**Plan:** [`.agents/plans/m16-slice0-truth-and-research-scaffold.md`](../plans/m16-slice0-truth-and-research-scaffold.md)
(confidence **9.4/10**)
**Commit:** `25e0ab9` · **Date:** 2026-08-02 · 37 files, +3507/−58

## What shipped

Four parts, as planned, with zero schema change and zero behavioural change beyond two CLI lines:

1. **Renumber.** `M16` (Cloud-hosted SaaS) → **M20**, returned to the unsequenced bucket with scope
   unchanged; `M16` redefined as _Dogfood Instrumentation & Data Trust_. 38 live sites repointed
   (17 doc + 21 source comments across 14 files). 32 historical hits deliberately untouched behind
   one erratum legend (D-16.0-1).
2. **Research scaffold.** `.agents/research/` — 8 files, §3 privacy rule restated in every
   observation-holding file, `participants.md` with zero rows.
3. **Data boundary.** `docs/guide/data-boundary.md`, every claim cited by `file:line`.
4. **Timed clean-room deploy.** `.agents/research/cleanroom-2026-08-02.md` + 6 incidents.

Plus F1/F2 in `apps/collector/src/cli.ts` (the stated D-16.0-2 exception).

## How well the plan held up

**The plan was unusually accurate where it counted, and the one place it was wrong is instructive.**

**What the plan got exactly right:**

- **The enumeration.** 21 source hits / 14 files / 17 doc / 32 historical / 1 lockfile false positive
  — reproduced exactly on first run. This was named as the single largest risk and it cost nothing,
  because the planning spike had already machine-derived it per-file.
- **The pathspec warning.** `'apps/*/src'` matches nothing and reads identically to "clean". The plan
  demanded the negative gate be proven capable of failing; running it at `HEAD` reported 21, so the
  gate has teeth. **This is the single highest-value instruction in the plan** — without it the
  slice's central acceptance criterion would have been a no-op that reported success.
- **`check-summary.mjs` semantics**, read from source rather than assumed: the ✅-within-4-characters
  rule and the `is **DONE**` self-relaxing trap. Both mattered; the second would have silently
  disabled per-slice checking for 16.1–16.4.
- **F1/F2**, found by spiking, located at the cited lines (F2 at `:507`, one line off the cited
  `:506` — the snippet matched verbatim, so the drift was cosmetic).

**Where the plan was wrong:**

- **Redaction rule count.** The plan said "15 redaction rule kinds"; the source has **13** regex rules
  plus **1** entropy backstop = **14**. Caught only because the plan's own "derive, do not aspire"
  GOTCHA made me count rather than transcribe. A plan is not a source of truth about the code, and a
  plan instructing you to verify is worth more than a plan asserting a number.

**What the plan did not anticipate — the enumeration was `git grep`-based and therefore blind to
untracked files.** `.agents/supplemental docs/outline.md` was untracked at planning time and carries
**7** stale "M16 = SaaS" references. It only surfaced at commit time, when deciding what to stage.
Had it been committed unexamined, the slice would have shipped its own counterexample. The plan's
"38 live sites" was correct *for tracked files* and the number was never wrong — the **method's
scope** was narrower than the claim it supported.

> **Lesson for the next truth slice:** `git grep` answers "what does the repo say", not "what is about
> to be in the repo". Run the enumeration over `git status --porcelain` output too, or run it after
> `git add -A` and before commit.

## Surprises

**Part 4 found far more than expected, and most of it was not onboarding friction.** The plan's
prime suspect was the post-15.9 auth chain eating the 30-minute budget. The auth chain was **fine**
(login → pairing code → pair, ~3 s). What broke was everything around it:

- **The documented path fails twice.** `quickstart.md` never says to `tsc -b`, so `ingest:dev` dies on
  `ERR_MODULE_NOT_FOUND`; and it omits `db:provision-app-role` — which `setup-env.mjs` **itself
  prints as its own next step** — so ingest then dies on Postgres `28P01`. Two sources of truth for
  the setup sequence, disagreeing.
- **Two of four isolation constraints did not hold**, both through dimensions the plan's checklist did
  not name. The checklist enumerated a database, a home directory, and ports. It did not enumerate
  **roles** (cluster-scoped, so a separate database is not isolation — INC-2026-06, which broke the
  real repo's test suite for a window: 223 failures) or **poll-mode connectors** (`cursor.ts:331`
  discards the `home` its contract passes it — INC-2026-01, so the isolated clean room read 350 real
  Cursor sessions).

**INC-2026-01 is the most valuable output of the slice** and would not have been found any other way.
No test asserts it, `tsc` cannot see it, and the tail-mode connectors all honour `home` correctly, so
a code reading generalises the wrong way. It took actually running an isolated collector and noticing
64,433 queued items in a home that contained two files.

**The generalisable form:** an isolation claim is only as good as its enumeration of how state is
shared. Both breaches came through a sharing channel nobody listed, not through a listed channel
implemented badly. That is the same shape as CLAUDE.md's `skipped ≠ passed` and `bypassed ≠ enforced`
— a check that passes because it never examined the thing.

**Write-side isolation held**, and was verified by mtime and row counts. Worth noting *why that is not
reassuring*: **every write-side check passed while a read breach was in progress.** The checks were
well-chosen for the threat model that was written down, and the threat model was incomplete.

## Process notes

- **D-16.0-2 was load-bearing and slightly uncomfortable.** Six incidents found, six left unfixed —
  including a HIGH one. The discipline is right (a fix with no before-number is unfalsifiable), but it
  requires writing down a defect and walking away, which is against instinct. The plan's narrowly
  drawn F1/F2 exception made the boundary decidable: those were defects in the *measurement's own
  safety mechanism*, INC-2026-01 is a defect in the product. Without that stated test I would have
  fixed INC-2026-01 on sight and destroyed the evidence.
- **The clean room damaged the host.** Provisioning a cluster-wide role from an "isolated" checkout
  broke the main repo's integration suite (223 failures, `28P01`). It self-healed and was verified
  green, but a future clean room needs a **separate Postgres container**, not a separate database.
  The procedure has been corrected in the incident entry.
- **Two transient OneDrive dehydrations** made 9 just-edited files appear deleted mid-slice. No data
  was lost; the correct response was to verify (`git cat-file`, absolute-path `ls`) rather than
  `git checkout`. Recorded in memory, because the instinct at that moment is to restore, which would
  have destroyed real work.
- **The `%20` in `supplemental docs`** silently broke a link-checking script (`printf '%b'` mangled
  `\x20`), producing 13 false "BROKEN" reports. Verified manually before reporting — a reminder that a
  checker's own failure mode looks exactly like the failure it checks for.

## Follow-ups this slice created

| Item                                                              | Destination            |
| ----------------------------------------------------------------- | ---------------------- |
| INC-2026-01 — `--home` does not scope poll-mode connectors        | candidate **16.3**     |
| INC-2026-02/03 — quickstart's two undocumented steps              | backlog (doc fix)      |
| INC-2026-04 — `setup-env.mjs` hardcodes `INGEST_URL=8420`         | backlog                |
| INC-2026-05 — cannot distinguish "no work" from "capture broken"  | **16.3** headline case |
| INC-2026-06 — clean-room procedure needs a separate PG container  | procedure, corrected   |
| Repeat the timed deploy with UI steps performed by a human        | after 02/03 close      |

## Validation

| Gate                                | Result                                   |
| ----------------------------------- | ---------------------------------------- |
| `npm run typecheck` (root `tsc -b`) | exit 0                                   |
| `npm run lint`                      | exit 0                                   |
| `npm run format:check`              | exit 0                                   |
| `npm test`                          | 148 files / 1313 tests passed            |
| `npm run repo-health`               | PASS                                     |
| `npm run repo-health -- --require-db` | PASS — **516 int tests ran, 0 skipped** |
| `node scripts/check-summary.mjs`    | PASS, incl. simulated with this report present |

**Code review:** [`m16-slice0-truth-and-research-scaffold.md`](../code-reviews/m16-slice0-truth-and-research-scaffold.md)
— 4 findings (1 high, 2 medium, 1 low), no critical, no security, no logic errors in the executable
change. The HIGH is `data-boundary.md` asserting a connector allow-list the product does not enforce
— i.e. the consent document contradicted by this slice's own incident log.
