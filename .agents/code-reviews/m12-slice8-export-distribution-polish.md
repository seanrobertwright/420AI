# Code Review — M12 Slice 12.8 (Export & Distribution Polish)

Reviewed: 2026-06-21 · Branch `m12-slice8-export-distribution-polish`

**Stats:**

- Files Modified: 16 (incl. `Cargo.lock`/`package-lock.json`/docs)
- Files Added: 4 (`exports-parquet.ts`, `exports-parquet.test.ts`, `updater.ts`, the plan)
- Files Deleted: 0
- New lines: ~696 insertions
- Deleted lines: ~39

Scope reviewed: the three feature legs (Parquet export, desktop restore command + UI, auto-update
plugin/config) plus docs. Generated lockfiles and prose-only doc edits skimmed, not line-reviewed.

---

## Issues

```
severity: high
file: apps/desktop/src-tauri/src/server.rs
line: 433-439
issue: restore_archive can deadlock — full stdin write completes before stderr is drained
detail: stdin is piped and stderr is piped (stdout null). The code write_all()s the ENTIRE
  decompressed dump to psql's stdin synchronously, then calls wait_with_output() which only
  THEN starts draining stderr. A pg_dump restore emits many NOTICE/ERROR lines to stderr
  (e.g. "table … does not exist, skipping", sequence/constraint notices). If that stderr
  output fills the OS pipe buffer (~64KB) while we are still writing stdin, psql blocks on the
  stderr write → stops consuming stdin → our write_all blocks → permanent deadlock with no
  timeout. The CLI `gunzip -c | psql` it mirrors does NOT have this bug because the shell
  streams both ends concurrently. Realistic for a real (large, verbose) restore.
suggestion: Write stdin on a separate thread so wait_with_output() drains stderr concurrently:
  let mut stdin = child.stdin.take().ok_or("no stdin")?;
  let writer = std::thread::spawn(move || stdin.write_all(&sql));
  let out = child.wait_with_output()…?;
  writer.join().map_err(|_| "stdin writer panicked".to_string())?
        .map_err(|e| format!("write sql: {e}"))?;
  (FIXED in this review pass.)
```

---

## Verified-correct (no action)

- **`eventsToParquetBuffer`** uses `r[name] ?? null` (nullish, not `||`) so `0`/`""`/`false` survive;
  only undefined/null coalesce to null. Round-trip unit test (incl. nulls, int, float, empty rows)
  passes; int HTTP case asserts `PAR1` head+tail on `res.rawPayload`. Pure, no clock/IO.
- **`sendExport` `string | Buffer`** — Fastify sends a Buffer verbatim under the binary content-type;
  the report/transcript callers still pass `string` (valid). Parquet is events-only; report (L223) and
  transcript (L285) handlers untouched (verified).
- **Schema enum** adds `parquet` to events ONLY; the now-stale int assertion `format=parquet → 400`
  was correctly retargeted to `format=xml → 400`.
- **`restore_archive` integrity gate** — `GzDecoder::read_to_end` fails on a corrupt gzip BEFORE the
  psql child spawns, so a truncated archive applies zero statements (matches the script's `gunzip -t`).
  Missing file → `Err`; docker-not-found mapped to the same message as `run_docker`.
- **Auto-update** — `check()` rejection / null is swallowed in `App.tsx` (`.catch(() => {})`), so an
  offline / no-release / pre-pubkey state never blocks launch. The build-time gap (missing
  `tauri-plugin-process` Rust crate for `process:allow-restart`) was caught by `cargo check` and fixed.
- **Token isolation** — no secret crosses the bridge; restore takes only a file path. `cargo clippy
  --all-targets -- -D warnings` clean; `repo-health --require-db` green (159 int tests, 0 skipped).
- **No binary/NUL corruption** in any tracked source (`git diff --numstat` shows no `-\t-` rows).

---

## Verdict

One **high**-severity latent deadlock in `restore_archive` (pipe back-pressure), fixed in this pass.
Everything else is a minimal, well-gated extension of exhaustively-read seams. Re-validated after the
fix: `cargo check` + `cargo clippy -- -D warnings` clean.
