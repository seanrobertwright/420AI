# Execution Report — M12 Slice 12.8 (Export & Distribution Polish)

Executed: 2026-06-21 · Branch `m12-slice8-export-distribution-polish`

## Meta Information

- **Plan file:** `.agents/plans/m12-slice8-export-distribution-polish.md`
- **Files added (source):**
  - `apps/ingest/src/exports-parquet.ts` — pure `eventsToParquetBuffer` serializer
  - `apps/ingest/src/exports-parquet.test.ts` — co-located unit test (round-trip via `hyparquet`)
  - `apps/desktop/src/lib/updater.ts` — `checkForUpdateOnLaunch()`
- **Files added (process docs):** `.agents/code-reviews/…` + this report
- **Files modified (16):** `packages/shared/src/serialize.ts`, `apps/ingest/src/routes/exports.ts`,
  `apps/ingest/src/schemas.ts`, `apps/ingest/src/exports.int.test.ts`, `apps/ingest/package.json`,
  `apps/dashboard/src/components/export/export-view.tsx`,
  `apps/desktop/src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json,capabilities/default.json}`,
  `apps/desktop/src-tauri/src/{server.rs,lib.rs}`,
  `apps/desktop/src/{App.tsx,components/Settings.tsx,lib/bridge.ts}`, `apps/desktop/package.json`,
  `docs/PRD.md`, `docs/guide/operations.md`, `SUMMARY.md`, `package-lock.json`
- **Lines changed:** +705 −39 (across 20 tracked files; the `Cargo.lock`/`package-lock.json` deltas
  are dependency resolution)

## Validation Results

- **Syntax & Linting:** ✓ — `npm run format:check` clean (TS/TSX/JSON/MD); `cargo clippy --all-targets
  -- -D warnings` clean.
- **Type Checking:** ✓ — root `tsc -b` exit 0; `typecheck:dashboard` exit 0; `typecheck:desktop` exit 0
  (all three lanes inside `repo-health`). `cargo check` exit 0.
- **Unit Tests:** ✓ — `repo-health` full suite **593 passed / 0 failed** (84 files), incl. the new
  `exports-parquet.test.ts` (3 cases: PAR1 magic, deep-equal round-trip with nulls/int/float, empty rows).
- **Integration Tests:** ✓ — `repo-health -- --require-db` ran **159 integration tests, 0 skipped**
  (test DB migrated separately first), incl. the new parquet HTTP case (200 +
  `application/vnd.apache.parquet` + `PAR1` body + redaction header).
- **Rust build:** ✓ — `cargo check` + `cargo clippy -- -D warnings` clean after the process-plugin fix
  and the deadlock fix.
- **Frontend build:** ✓ — `next build` (dashboard) and `vite build` (desktop) both succeed.

> **Manual (Level-4) acceptance NOT performed — out of automatable scope, by design:** the restore
> end-to-end (real `.sql.gz` → confirm → DB reflects dump; corrupt-gzip → error), the live auto-update
> hop (install v0.1.0 → publish v0.1.1 → relaunch self-updates), and the one-time updater **signing-key
> ceremony** (`tauri signer generate`, interactive password) remain for the maintainer. The plan
> explicitly classifies these as manual acceptance, not automated gates.

## What Went Well

- **Phase A was a true 1-line-per-seam extension.** The plan's pre-read of `exports.ts`
  (`CONTENT_TYPE`/`flattenEventRow`/`EVENT_CSV_COLUMNS`/`sendExport`) was exact; widening `sendExport`
  to `string | Buffer` and adding the `else` parquet branch was mechanical. The `ExportFormat` union
  change correctly forced the `CONTENT_TYPE` `Record` exhaustiveness via `tsc`.
- **The Parquet library spike held.** `hyparquet-writer`'s `parquetWriteBuffer({ columnData })` →
  `ArrayBuffer`, `Buffer.from(...)`, null round-trip, and `PAR1` magic all behaved exactly as the plan's
  NOTES predicted — zero library surprises.
- **The Rust restore command mirrored `start_ingest`/`run_docker` cleanly** — `compose_args`, `Command`,
  `Stdio`, keychain load, and the docker-not-found error message were all in scope as the plan promised.
- **Build-time capability validation caught the missing plugin instantly** — the `cargo check` error
  enumerated every valid permission, making the missing `process:*` obvious.

## Challenges Encountered

- **Two long Rust compiles.** The first `cargo check` pulled and built `tauri-plugin-updater` + the full
  Tauri graph (minutes); subsequent incremental checks were ~3–16 s. Running it in the background while
  doing the docs/UI work hid the latency.
- **Test-DB migration is a separate step** (per memory): `db:migrate` only migrates the main DB; the
  `420ai_test` DB had to be migrated by overriding `DATABASE_URL` before `--require-db` would pass with
  0 skipped.
- **A pre-existing `docs/PRD.md` prettier violation** (malformed `**…**` markdown in the old 12.8 entry)
  would have failed CI's `format:check`; rewriting the entry fixed both the content and the formatting.

## Divergences from Plan

**1. Added the Rust `tauri-plugin-process` crate + registration (plan gap)**

- **Planned:** C1 listed only `tauri-plugin-updater = "2"` (Rust) and the JS `@tauri-apps/plugin-process`
  package; C5 added the `process:allow-restart` capability.
- **Actual:** Also added `tauri-plugin-process = "2"` to `Cargo.toml` and
  `.plugin(tauri_plugin_process::init())` to `lib.rs`.
- **Reason:** `cargo check` failed with `Permission process:allow-restart not found` — that capability is
  contributed by the **Rust** process plugin, not the JS wrapper. `relaunch()` needs the Rust plugin
  registered. The plan named the JS package but omitted its Rust half.
- **Type:** Plan assumption wrong (incomplete dependency set).

**2. Fixed a stdin/stderr pipe deadlock in `restore_archive` (found in code review)**

- **Planned:** The plan's snippet wrote the whole decompressed dump to psql's stdin with `write_all(&sql)`
  inline, then called `wait_with_output()`.
- **Actual:** stdin is now written on a separate `std::thread` so `wait_with_output()` drains psql's
  stderr concurrently; psql's exit status is checked before the writer is joined (so a psql failure
  surfaces its stderr, not a downstream BrokenPipe).
- **Reason:** A `pg_dump` restore emits many NOTICE/ERROR lines to stderr. With stderr piped and written
  only after the full stdin write, a stderr buffer fill (~64KB) blocks psql → it stops reading stdin →
  `write_all` blocks → permanent deadlock with no timeout. The CLI `gunzip -c | psql` it mirrors streams
  both ends concurrently and so is immune.
- **Type:** Correctness bug (inherited from the plan snippet).

**3. Kept `version` at `0.1.0` and left `pubkey` as a documented placeholder**

- **Planned:** C3 generates the updater signing key (interactive password) and pastes the real `.pub`
  into `tauri.conf.json`; C4 bumps `version` `0.1.0 → 0.1.1` "to test the update hop."
- **Actual:** `plugins.updater.pubkey` holds `REPLACE_WITH_TAURI_UPDATER_PUBKEY`; `version` stays
  `0.1.0`; the signing ceremony + version bump are documented as the first steps of the release runbook
  in `operations.md`.
- **Reason:** The signing key is a long-lived release **credential** the maintainer must own, choose a
  password for, and back up — not something an automated executor should fabricate. The version bump is
  meaningful only paired with the (manual) live-release E2E. Both are honestly deferred to the maintainer
  with a complete runbook, matching the plan's own "manual Level-4 acceptance" framing.
- **Type:** Security concern (credential ownership) + correct treatment of a manual step.

## Skipped Items

- **C3 updater signing-key generation** — interactive, credential-creating, maintainer-owned (see
  Divergence 3). Runbook documents it.
- **Level-4 manual acceptance** for restore (B6) and auto-update (C8), and the optional DuckDB/pandas
  smoke test — intrinsically not automatable; flagged for the maintainer.
- **Nothing else** from the plan's automatable surface was skipped.

## Recommendations

- **Plan command:** When a Tauri JS plugin is added, the plan should pair it with its Rust crate **and**
  the `.plugin(...)` registration as a single unit — the capability is build-validated against the Rust
  side. (Divergence 1.)
- **Plan command:** Any "stream bytes into a child via a piped stdin while a pipe is also captured"
  snippet should default to the concurrent-write (separate-thread) form; the inline `write_all` →
  `wait_with_output` shape is a latent deadlock. (Divergence 2.)
- **CLAUDE.md:** Consider a one-liner under "Drizzle/process gotchas": _piping a large payload into a
  child whose stderr/stdout is also captured must write on a separate thread — inline write-then-wait
  deadlocks when the captured pipe fills._
- **CLAUDE.md / memory:** The `tauri signer generate` ceremony and the `gh release create` runbook now
  live in `docs/guide/operations.md` §12.8 — a memory pointer would save re-deriving the release path.
