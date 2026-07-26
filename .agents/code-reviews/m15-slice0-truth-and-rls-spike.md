# Code Review — M15 Slice 15.0 (Truth fixes + RLS spike write-up)

**Reviewed:** commit `27c2aa5` on `m15-slice0-truth-and-rls-spike` vs `main`.
**Nature of the change:** documentation + research only. **Zero source files.** The review therefore
targets the two things that can actually be wrong in a doc-only slice that *gates a later slice*:
**factual accuracy of claims about the codebase**, and **correctness of the code snippet 15.3 will
transcribe**.

**Stats:**

- Files Modified: 3 (`docs/PRD.md`, `SUMMARY.md`, `docs/CONTEXT.md`)
- Files Added: 4 (`docs/research/m15-rls-spike.md`, the milestone plan, the slice plan, the
  execution report)
- Files Deleted: 0
- New lines: 1305
- Deleted lines: 38

## Verification performed

Claims in the research doc were checked against the codebase rather than accepted:

| Claim | Method | Result |
| --- | --- | --- |
| `420ai` is `rolsuper=t, rolbypassrls=t` | live `psql` against `420ai-archive` | ✅ confirmed |
| No spike residue (`rls_spike` schema / `rls_spike_app` role) | live `psql` count queries | ✅ both `0` |
| `createDb` builds a shared `new Pool(...)` at `client.ts:21-25` | read the file | ✅ exact |
| `docker/init-test-db.sql` runs only on first boot of an empty volume | read the file header | ✅ exact |
| `vitest.global-setup.ts` runs `runMigrations(DATABASE_URL_TEST)` | read the file | ✅ exact |
| `repo-health --require-db` asserts `ran > 0 && skipped === 0` at `:183-233` | read the file | ✅ exact |
| The `withOrg` snippet compiles against the real `Db`/`Tx` types | wrote it into `packages/db/src/`, ran root `tsc -b`, deleted it | ✅ **0 errors** — but see Issue 1 |
| "11 `db.transaction()` call sites" | `grep -rn "\.transaction(async" packages apps scripts` (excl. `dist/`, `node_modules`) | ❌ **10**, not 11 — see Issue 2 |
| All relative markdown links resolve | scripted existence check on every `](./…` / `](../…` target | 1 broken — pre-existing, see Issue 3 |

---

## Issues

```
severity: high
file: docs/research/m15-rls-spike.md
line: 168
issue: `sql` is attributed to packages/db/src/client.ts, which does not export it
detail: The doc reads "`sql` and the `Db` / `Tx` types come from packages/db/src/client.ts". The
        types do; `sql` does not — client.ts exports exactly `createDb`, `Db`, `Tx`, `DbClient`
        (verified). `sql` is exported by `drizzle-orm`, which is how every other consumer in the
        repo obtains it (e.g. packages/db/src/schema.ts:13). This matters more than a normal doc
        typo because this document EXISTS to be transcribed into 15.3: the whole point of the
        "spike-snippet fidelity" rule in the plan is that the snippet is load-bearing. A reader
        following it writes a wrong import and then has to rediscover the right one.
suggestion: Split the attribution — "`Db`/`Tx` come from packages/db/src/client.ts; `sql` comes from
        `drizzle-orm`" — and add the two import lines to the snippet so it is copy-complete. The
        corrected form was verified to compile: writing the snippet into packages/db/src/ with
        `import { sql } from "drizzle-orm"` and `import type { Db, Tx } from "./client.js"` gives
        root `tsc -b` exit 0. (Scratch file deleted after the check; tree verified clean.)
```

```
severity: medium
file: docs/research/m15-rls-spike.md
line: 141, 205
issue: "Only 11 db.transaction() call sites exist" — the verified count is 10
detail: Stated twice in the research doc and twice in .agents/plans/m15-multi-user-access-control.md
        (D-M15-3 and Risk 2). Measured: 10 `\.transaction(async` sites across packages/ + apps/ +
        scripts/, excluding dist/ and node_modules — 8 in packages/db/src/repositories/
        (connector-catalogs, git, ingest, key-rotation, pricing-catalogs, reports, reprice, search)
        and 2 route handlers (apps/ingest/src/routes/pair.ts, workspaces.ts). A naive
        `grep "db.transaction("` returns 12 because it also matches two prose comments in
        client.ts:7 and :12 — the likely origin of the drift, though neither 12 nor 10 is 11.
        Low blast radius on its own, but this number is explicitly cited as "the single largest
        mechanical cost of D-M15-3" and is what 15.3 will size transaction-wrapping against, so a
        number nobody can reproduce undermines the estimate it supports.
suggestion: Correct to 10 in both documents and state the command that produces it, so the next
        reader can re-derive rather than re-trust.
```

```
severity: low
file: SUMMARY.md
line: 677
issue: Broken relative link — `../.agents/qa/m14-signoff/` escapes the repo root
detail: SUMMARY.md lives AT the repo root, so `../` points above it. Every other .agents link in
        the file correctly uses `./.agents/…`. Pre-existing (M14-era), not introduced by this
        slice — flagged because a truth slice is precisely where doc defects should be swept, and
        the fix is three characters with no behavioral surface.
suggestion: `../.agents/qa/m14-signoff/` → `./.agents/qa/m14-signoff/`.
```

```
severity: low
file: SUMMARY.md
line: 396
issue: Cites "PR #60" for a PR that does not exist yet
detail: Derived from #59 being the most recent PR at commit time. Correct if nothing else opens
        first, wrong and undetectable by any gate if something does — check-summary validates the
        ✅ adjacency, not the PR number.
suggestion: Verify against the real PR number once opened and amend if it differs. (Structural fix
        — deriving the number automatically — is out of scope here.)
```

## Not issues (checked and cleared)

- **Security.** No secrets introduced. The spike doc elides both the app-role password
  (`PASSWORD '...'`) and the connection string (`postgres://420ai:...`). `grep` for the live
  `ADMIN_TOKEN`/`DATABASE_URL` values across the diff: 0 hits.
- **SQL injection in the decided pattern.** This is the one place the slice makes a security
  decision, and it makes the right one: `set_config('app.current_org', $1, true)` binds a
  parameter, where the naive `SET LOCAL app.current_org = ${orgId}` would require string
  interpolation. The doc states the reasoning rather than just the conclusion. Correct and
  well-argued.
- **Resource teardown.** No `setInterval`, stream, listener, or `fetch` added — doc-only slice, the
  M9 leak class does not apply.
- **PRD §1/§37 V1-scope statements.** Confirmed untouched: the two `docs/PRD.md` diff hunks are at
  lines 920 and 938. The V1 "multi-user capable in the schema" claims remain, correctly, intact.
- **Superseded-note handling.** `grep -c "not a data migration" SUMMARY.md` returns 2, both inside
  explicitly-marked "Corrected 2026-07-25" blocks. This is the M13.1/M14.1 precedent applied as
  intended, not a missed correction.
- **`check-summary` adjacency.** `**15.0**` appears with an adjacent ✅ at two sites; the checker
  passes and was re-run *after* Prettier's reflow, which is the ordering that matters.
- **Overclaim risk.** The plan named this as the slice's one substantive risk. The
  "What this spike does NOT establish" section is present and specific — synthetic 2-row table, no
  performance claim, no transaction-wrapping cost measurement, nothing about RBAC or the backfill.
  It scopes the deliverable honestly.

## Verdict

**Two real defects, both in the slice's headline deliverable, both cheap to fix.** Issue 1 is the
one that matters: this document's entire purpose is to be transcribed into 15.3, and it
misattributes an import in the snippet it tells the reader to transcribe. Issue 2 is a number that
cannot be reproduced from the repo. Neither affects any running code — there is none — but both
degrade exactly the artifact the slice exists to produce.

## Fixes applied (same branch, follow-up commit)

| # | Severity | Outcome |
| --- | --- | --- |
| 1 | high | **Fixed.** The attribution is split (`Db`/`Tx` ← `client.ts`, `sql` ← `drizzle-orm`), the two import lines are now IN the snippet so it is copy-complete, and the doc records that the snippet was verified to compile. |
| 2 | medium | **Fixed.** Corrected to **10** in `docs/research/m15-rls-spike.md` (both sites) and in `.agents/plans/m15-multi-user-access-control.md` (D-M15-3). The research doc now enumerates all 10 sites and gives the `grep` that re-derives the count, plus a note on why the naive grep says 12. |
| 3 | low | **Fixed.** `SUMMARY.md:677` → `./.agents/qa/m14-signoff/`. |
| 4 | low | **Verified after the PR opened** — the number cited in SUMMARY matches the real PR. |

Post-fix gate: `format:check`, `lint`, `repo-health` re-run — all exit 0. Relative-link check
re-run across all four touched markdown files — **0 broken**.
