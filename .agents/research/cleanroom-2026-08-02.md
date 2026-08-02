# Clean-room deploy — 2026-08-02

A timed, isolated bring-up of archive + API + dashboard + collector following
[`docs/guide/quickstart.md`](../../docs/guide/quickstart.md), run by milestone slice **16.0** part 4.
Baseline for research-plan §5.2 **time to first capture < 30 min**, and the first entry in
[`incidents.md`](./incidents.md).

> **D-16.0-2: this exercise MEASURES, it does not fix.** Every defect below is logged and left
> standing. None was fixed in 16.0. That is deliberate — §2's scope-change rule requires a named
> failure before a feature is built, and fixing friction the moment it is observed converts measured
> evidence into a guess.

---

## Headline result

**The documented path does not work as written.** Following `quickstart.md` verbatim, the ingest API
fails to start — twice, for two different undocumented reasons. A first verified capture *was*
eventually reached, but only after two interventions that appear nowhere in the guide.

**And the isolation the exercise depends on does not hold.** `collector watch --home <isolated>`
read **350 real Cursor sessions** out of the operator's real `%APPDATA%` store and enqueued
16,916 records / 39,888 events from outside the clean room. See **INC-2026-01** — this is the most
important finding of the slice, and it is more serious than the F1/F2 defects 16.0 fixed.

| Measure                                       | Result                                                  |
| --------------------------------------------- | ------------------------------------------------------- |
| Total **mechanical** time to first capture     | **≈ 2 min** (see the honesty caveat — this is not a human's 30-min budget) |
| Steps requiring undocumented intervention      | **2** (build, provision-app-role)                        |
| Steps that failed following the guide verbatim | **2** (both halves of quickstart step 3)                 |
| Incidents raised                               | **6** (1 high, 5 medium)                                 |
| Real credentials / queue modified              | **No** — mtimes byte-identical to baseline               |
| Real archive modified                          | **No** — 0 machines before and after                     |
| Real repo collaterally broken                  | **Yes, temporarily** — 223 test failures (INC-2026-06); repaired, full suite green |

---

## Honesty caveat — read before quoting the 2-minute number

**This measurement is not a substitute for timing a human, and must not be reported as one.**

1. **It was executed by an agent, non-interactively.** Quickstart steps 4 and 9–11 are dashboard **UI**
   steps ("open the Pairing page and click Generate pairing code"; "review each connector's fidelity
   and permission scope on the Catalog page"). Those were performed as direct API calls instead. That
   is a **deviation from the documented path**, and it removes precisely the part of the budget a
   human spends — reading, navigating, and deciding.
2. **It measures machine time, not time-on-task.** The dominant human costs — reading the guide,
   diagnosing `ERR_MODULE_NOT_FOUND`, discovering that `db:provision-app-role` exists — are compressed
   to near zero here. A human hitting the step-3 failures with no prior knowledge would plausibly
   spend 10–30 minutes on those two alone, which is the whole budget.
3. **Clone and install are not representative.** The clone was from a **local path** (1 s), not
   GitHub, and `npm install` ran against a **warm npm cache** (31 s). Per the plan's residual-risk
   note these are recorded **separately** and must not be folded into the headline: a design partner
   running a released installer pays neither.

**What this run does establish reliably:** the *sequence* of steps that actually works, the two places
the documented path is broken, and the isolation defect. Those are facts about the product. The
wall-clock is a floor, not an estimate.

---

## Isolation setup (not part of the 13 documented steps)

Per **D-16.0-3** and the plan's mandatory isolation constraints:

| Constraint            | How                                                                             | Verified |
| --------------------- | -------------------------------------------------------------------------------- | -------- |
| Outside OneDrive      | Clone into the session scratchpad under `AppData/Local/Temp`                     | ✅       |
| Separate database     | `CREATE DATABASE "420ai_cleanroom"` on the existing instance (host port 5433)     | ❌ **insufficient — see INC-2026-06** |
| Separate collector home | Every collector call took `--home <scratchpad>/cleanroom-home`                 | ❌ **breached — see INC-2026-01** |
| Separate ports        | ingest **8999** (not 8420), dashboard **3999** (not 3000)                        | ✅       |

**Two of the four isolation constraints did not hold.** That is the most useful thing this exercise
produced, and it is worth stating as a general lesson rather than two bugs:

> **The isolation checklist was written in terms of the resources the plan could see** — a database, a
> home directory, a port. Both breaches came through a dimension the checklist did not name: Postgres
> **roles** are cluster-scoped and ignore the database boundary (INC-2026-06), and a **poll-mode
> connector** derives its path from an environment variable and ignores the home boundary
> (INC-2026-01). An isolation claim is only as good as its enumeration of the ways state is shared,
> and enumerating those is exactly what a first run is for.

The next clean room needs a **separate Postgres container**, not a separate database, and a way to
confine or disable poll-mode connectors.

> **Gotcha for whoever repeats this.** A naive `case "$PATH" in *OneDrive*)` guard reports a **false
> positive**: the scratchpad directory *name* embeds the literal string
> `C--Users-seanr-OneDrive-Documents-420AI` (it is derived from the project path) while the
> *location* is `AppData/Local/Temp`. Match on the prefix `C:/Users/<user>/OneDrive/`, not on the
> substring.

Baseline captured before starting, for the leakage check:

```
/c/Users/seanr/.420ai/credentials.json  mtime=1782064326
/c/Users/seanr/.420ai/queue.sqlite      mtime=1785671362
```

---

## Timing table

`intervention?` means the documented path did not carry the step and something outside the guide was
required.

| Quickstart step                      | Wall-clock | Intervention?         | Notes                                                                 |
| ------------------------------------ | ---------: | --------------------- | --------------------------------------------------------------------- |
| _(pre) create clean-room DB_          |       1 s | isolation-only        | Not a documented step.                                                 |
| _(pre) `git clone`_                   |       1 s | —                     | **Local path clone.** A GitHub clone is materially slower — report apart. |
| **1.** `npm install`                  |      31 s | —                     | **Warm npm cache.** npm also blocked postinstall scripts (`esbuild`, `sharp`) with an `approve-scripts` warning; did not bite this run. |
| **1.** `npm run setup`                |       1 s | —                     | Wrote `.env` + `apps/dashboard/.env.local`. Its own "next steps" output names a step the guide omits — see INC-2026-03. |
| **1.** set `ADMIN_PASSWORD`           |       0 s | —                     | Guide is explicit that this is not optional post-15.9.                 |
| _(iso) repoint DB + ports_            |       0 s | isolation-only        | Also had to fix `apps/dashboard/.env.local` — see **INC-2026-04**.     |
| **2.** `npm run db:migrate`           |       3 s | —                     | Clean.                                                                 |
| **3a.** `npm run ingest:dev`          |      — | ❌ **FAILED**            | `ERR_MODULE_NOT_FOUND: @420ai/db/dist/index.js`. See **INC-2026-02**. |
| ↳ intervention: `npm run build`       |       8 s | ⚠️ **undocumented**    | `tsc -b`. Not mentioned anywhere in quickstart.                        |
| **3a.** `npm run ingest:dev` (retry)  |      — | ❌ **FAILED**            | Postgres `28P01` password auth failed for `420ai_app`. See **INC-2026-03**. |
| ↳ intervention: `db:provision-app-role` | 2 s | ⚠️ **undocumented**    | Confirmed absent: `grep -c provision-app-role docs/guide/quickstart.md` → **0**. |
| **3a.** `npm run ingest:dev` (3rd)    |     ~5 s | —                     | Healthy at `/v1/health` (note: **not** `/health` — the guide names no path). |
| **3b.** dashboard `next dev`          |       5 s | —                     | `Ready in 527ms`; `/login` 200. A first attempt cost **5 min** to *operator error* — see below. |
| **4.** generate pairing code          |       1 s | **deviation**         | Documented as a UI click; performed as `POST /v1/pairing-codes`.       |
| ↳ login (`POST /v1/auth/login`)       |       1 s | —                     | Admin auto-seeded from `ADMIN_EMAIL`/`ADMIN_PASSWORD` on ingest boot, as documented. |
| ↳ mint API key                        |       — | ⚠️ note                | `POST /v1/auth/api-keys` returned **401 `password_required`** on a valid session — minting requires password step-up. Correct by design; **undocumented** in quickstart, and a plausible stall point. |
| **5–6.** `collector pair … --home`    |       1 s | —                     | Succeeded — **and printed the wrong path (F2), reproduced live.** See below. |
| **7–8.** `collector discover --home`  |       1 s | —                     | `0 workspaces, 0 projects` — the isolated home contains no git repo.   |
| **9–11.** connector review/approval   |       — | **skipped (UI-only)**  | Not performed. Capture happened anyway — see **INC-2026-05**.          |
| **12.** `collector watch --home`      |    ~60 s | —                     | First events reached the archive within the first sync passes.        |
| **13.** first capture verified        |      — | ✅                     | `539 raw / 461 events / 1 commit` in the clean-room archive.           |

**Excluded from the product timing: 5 minutes of operator error.** The first dashboard attempt ran
`npx next dev` from the **repo root** instead of the dashboard workspace, so Next inferred the wrong
workspace root and served nothing. That was my mistake, not a product defect, and it is recorded here
rather than in the timing so the measurement is not inflated. (It did surface a real nuisance: a stray
`C:\Users\seanr\package-lock.json` in the home directory makes Next's root inference pick the home
directory. Worth deleting, unrelated to 420AI.)

---

## F1 / F2 confirmed live

The clone is at `main`, i.e. **before** 16.0's fixes, so the exercise reproduced both defects in situ.

**F2, verbatim from the run:**

```
Paired. machineId=65c2fb63-c88b-4282-b613-d680bda3d4f6
Ingest token (store securely): t9dOIQ8fE9CTVmeD85YL0e9wFPglwK5sDtBCrZiK7-Y
Saved credentials to C:\Users\seanr\.420ai\credentials.json     <-- WRONG. Real profile.
```

The credentials were in fact written to
`<scratchpad>/cleanroom-home/.420ai/credentials.json`, and the real file's mtime never changed. This
is exactly the harm F2 describes: **an operator verifying "did the clean room touch my real
collector?" reads that line and concludes it did.** The 16.0 fix makes the message print
`credentialsPathFor(home)`, pinned by a unit test that was confirmed to fail against the old code.

F1 (the `pair` usage line omitting `[--home <dir>]`) was likewise present; fixed in 16.0.

---

## Verification that isolation held where it was checked

| Check                              | Baseline      | After         | Verdict |
| ---------------------------------- | ------------- | ------------- | ------- |
| `~/.420ai/credentials.json` mtime  | `1782064326`  | `1782064326`  | ✅ unchanged |
| `~/.420ai/queue.sqlite` mtime      | `1785671362`  | `1785671362`  | ✅ unchanged |
| Real `420ai` DB `machines`          | 0             | 0             | ✅ untouched |
| Clean-room DB dropped               | —             | absent from `pg_database` | ✅ |
| Clone + clean-room home deleted     | —             | absent        | ✅ |

**But note what these checks do and do not prove.** They prove the clean room never *wrote* to real
state. They say nothing about *reads* — and INC-2026-01 is a read breach. A future repeat of this
exercise must add a read-side check, because the write-side checks all passed while the collector was
ingesting the operator's real Cursor history.

---

## Result against the §5.2 target

**Mechanical time to first verified capture: ≈ 2 minutes** — nominally far inside the < 30 min target.

**This should not be recorded as a pass**, for the three reasons in the honesty caveat, and for one
more: a path that fails twice with unexplained errors has no meaningful wall-clock for a first-time
user, because the distribution is dominated by how long diagnosis takes. The honest statement is:

> The mechanical path is fast. The **documented** path is broken in two places, and the isolation
> guarantee it relies on does not hold. Time-to-first-capture cannot be claimed against §5.2 until
> INC-2026-02 and INC-2026-03 are closed and the exercise is repeated **with the UI steps actually
> performed by a human**.

That repeat belongs in a later slice, with the incidents closed first. It is not 16.0's job to fix
them (D-16.0-2).
