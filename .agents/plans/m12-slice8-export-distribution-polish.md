# Feature: M12 Slice 12.8 — Export & Distribution Polish (Parquet export · Restore UI · Auto-update via GitHub)

The following plan should be complete, but it's important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to naming of existing
utils/types/models. Import from the right files. Project conventions live in
[`CLAUDE.md`](../../CLAUDE.md) and [`SUMMARY.md`](../../SUMMARY.md) — **read them; they are the source of
truth and are NOT re-pasted here.**

> **Scope decided with the maintainer (2026-06-21):** "fuller" 12.8 = **Parquet export + Restore UI +
> Auto-update via GitHub**. **Code signing (Authenticode cert) and MSI/WiX are PARKED INDEFINITELY** —
> do NOT add a CA-signed-installer step or an MSI/WiX target. NSIS stays the only bundle target. Tauri's
> auto-updater uses its OWN free signing key (minisign-style, `tauri signer generate`), which is a
> SEPARATE thing from an OS Authenticode cert — that is why auto-update is in scope without a paid cert.

## Feature Description

The final M12 slice. Three independent "polish" capabilities that take the product from feature-complete
to a refined, distributable, single-user self-hosted GA:

1. **Parquet export** — add a binary, columnar `parquet` format to the existing events export surface
   (today: MD/JSON/JSONL/CSV). Parquet is the analytics-friendly format for loading the event stream into
   DuckDB / pandas / Spark. It maps onto the **already-flat** events export only (report/transcript are
   document-shaped and stay text-only).
2. **Restore UI** — a "Restore from backup" button in the **desktop** Settings panel that drives the same
   restore flow the `scripts/restore-archive.sh` CLI already performs (gunzip-verify → `psql` into the
   compose `archive` container). The dashboard (browser) **cannot** do this — it has no shell/Docker
   access — so this lives only in the Tauri desktop app, which already supervises the server stack.
3. **Auto-update via GitHub** — wire `tauri-plugin-updater` so an installed desktop app checks GitHub
   Releases on launch, verifies the update payload against a baked-in updater public key, downloads, and
   relaunches. Distribution + the update endpoint are both GitHub Releases.

## User Story

As a **self-hosted 420AI operator**
I want to **export my event archive as Parquet, restore a backup from the desktop UI, and have the
collector app update itself**
So that **I can analyze data in standard tooling, recover from data loss without the CLI, and stay current
without manual reinstalls.**

## Problem Statement

- Exports are text-only (MD/JSON/JSONL/CSV); large event streams are slow/bulky to analyze and don't load
  natively into columnar analytics tools (PRD §22 names Parquet as the deferred V1 format).
- Backup restore is CLI-only (`scripts/restore-archive.sh`); the desktop app supervises the stack but
  offers no restore affordance (the "restore UI" deferral named in SUMMARY 12.2).
- The desktop app has no update path — every fix requires a manual rebuild + reinstall.

## Solution Statement

- **Parquet:** add a pure `eventsToParquetBuffer()` serializer in `apps/ingest` (NOT in `@420ai/shared`,
  which is dependency-free) using **`hyparquet-writer`** (spiked — see NOTES), extend the export route's
  `format` enum + `sendExport` to carry a `Buffer`, and add a `parquet` option to the dashboard export
  form. The `proxyStream` dashboard hop already forwards binary bodies + `content-type` unchanged.
- **Restore:** add a `restore_archive(backup_path)` `#[tauri::command]` in `apps/desktop/src-tauri/src/server.rs`
  mirroring `start_ingest`/`run_docker`, decompressing the `.gz` in-process with the `flate2` crate and
  streaming plain SQL into `docker compose exec -T archive psql`. Surface it as a confirm-gated button in
  `Settings.tsx` via a new `bridge.ts` wrapper.
- **Auto-update:** add `tauri-plugin-updater` (Rust) + `@tauri-apps/plugin-updater`/`-process` (JS),
  configure `plugins.updater` + `bundle.createUpdaterArtifacts` in `tauri.conf.json`, add the
  `updater:default` + `process:allow-restart` capabilities, run a check-on-launch in the webview, and
  document the signed-release process (manual build with `TAURI_SIGNING_*` env vars → `gh release create`
  with the installer + `.sig` + `latest.json`).

## Feature Metadata

**Feature Type**: Enhancement (three independent legs)
**Estimated Complexity**: **High** (spans `apps/ingest` TS, `apps/dashboard` TSX, `apps/desktop` Rust +
TSX + Tauri config; adds one npm dep, two Rust crates, two JS plugin packages; introduces the codebase's
first **binary** export and first **auto-update** path)
**Primary Systems Affected**: `apps/ingest` (export route + serializer), `apps/dashboard` (export form),
`apps/desktop` (Rust commands, updater plugin, Settings UI, Tauri config, capabilities), `docs/guide/operations.md`
**Dependencies (new)**: `hyparquet-writer` (ingest runtime), `hyparquet` (ingest dev/test);
`flate2` + `tauri-plugin-updater` (desktop Rust); `@tauri-apps/plugin-updater` + `@tauri-apps/plugin-process`
(desktop JS)

---

## EXECUTE IN THREE ATOMIC PHASES (one commit each)

The three legs are independent and very different in risk/validation profile (exactly why M12.7 was
sub-sliced a–d). **Execute and commit in this order; do not interleave:**

- **Phase A — Parquet export** (highest confidence; fully gated by `npm run repo-health`). Do first.
- **Phase B — Restore UI** (Rust; validated by `cargo check`/`clippy` + a manual restore test).
- **Phase C — Auto-update** (Rust + config + release infra; validated by `cargo`/`tauri build` + a manual
  release-and-update E2E — intrinsically not an automated gate).

Each phase is self-contained and independently revertible. If time-boxed, Phase A alone is a shippable,
valuable commit.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — READ THESE BEFORE IMPLEMENTING

**Phase A — Parquet:**

- `apps/ingest/src/routes/exports.ts` (whole file, ~343 lines) — Why: the export route. `CONTENT_TYPE`
  map (L42), `EVENT_CSV_COLUMNS` (L50-68) + `flattenEventRow` (L70-90) are the EXACT tabular schema
  Parquet reuses; `sendExport` (L114-133) is the string-only sender you'll extend to `Buffer`; the
  events handler body-build branch is L201-208.
- `packages/shared/src/serialize.ts` (whole, 87 lines) — Why: `ExportFormat` union (L16) gains
  `"parquet"`; this file is **dependency-free / no I/O** — do NOT add the parquet writer here. `toJsonl`/
  `toCsv` live here for reference only.
- `packages/db/src/repositories/exports.ts` (L33-47 `EventExportRow`, L62-112 `exportEvents`) — Why: the
  row shape + the read backing the export (unchanged this slice).
- `apps/ingest/src/schemas.ts` (L241-253 `exportEventsQuerySchema`) — Why: add `"parquet"` to the events
  `format` enum (report/transcript enums stay unchanged).
- `apps/ingest/src/exports.int.test.ts` (L1-90 shown; read the whole file) — Why: the int-test harness
  (`buildApp`, `createCode`/`pair`/`discoverPayload`, TRUNCATE in `beforeEach`) to mirror for a parquet
  HTTP case.
- `apps/dashboard/src/components/export/export-view.tsx` (whole, 200 lines) — Why: the events `format`
  state is typed `"json" | "jsonl" | "csv"` (L39) with a `<select>` (L84-93); add `"parquet"` to both.
- `apps/dashboard/src/app/api/exports/events/route.ts` (16 lines) + `apps/dashboard/src/lib/proxy.ts`
  (`proxyStream` L56-82) — Why: confirm the proxy forwards `content-type` + body bytes verbatim → **no
  change needed** for binary Parquet; the route passes `req.nextUrl.search` through.

**Phase B — Restore UI:**

- `apps/desktop/src-tauri/src/server.rs` — Why: the model. `run_docker(args)` (L224-242),
  `compose_args(&cfg.server_dir, &[...])` (used at L317), `start_ingest` async command with keychain
  load + `Command` + `Stdio` + error mapping (L337-372), `start_archive` (L314-321). `restore_archive`
  mirrors these.
- `apps/desktop/src-tauri/src/lib.rs` — Why: register the command in `tauri::generate_handler![...]`
  (L26-41, add before `server::unpair` at L40) and (Phase C) register the plugin (L16-23).
- `apps/desktop/src-tauri/src/keychain.rs` — Why: `load_server()` returns `ServerConfig` with
  `server_dir` (the repo root the compose file lives under). Used exactly as `start_ingest` uses it.
- `apps/desktop/src/lib/bridge.ts` — Why: `invoke()` wrapper pattern (L136-173, e.g. `startIngest`);
  add `restoreArchive(backupPath)` after L173.
- `apps/desktop/src/components/Settings.tsx` — Why: server-stack control section + `StackButton`
  (L465-484), `run()` helper (L83-91), busy-state pattern `onArchive`/`onIngest` (L203-215), buttons
  block (L404-417). Add a confirm-gated "Restore Archive" button mirroring these.
- `scripts/restore-archive.sh` (20 lines) + `scripts/backup-archive.sh` — Why: the proven restore logic
  (gunzip-integrity-check → `psql` into the `archive` container) and the backup-file naming
  (`420ai-<STAMP>.sql.gz`) the UI lists.

**Phase C — Auto-update:**

- `apps/desktop/src-tauri/Cargo.toml` — Why: Tauri `2`; existing plugins `tauri-plugin-shell = "2"`
  (L20), `tauri-plugin-autostart = "2"` (L33). Add `tauri-plugin-updater = "2"` + `flate2 = "1"`.
- `apps/desktop/src-tauri/src/lib.rs` (L16-23 `.plugin(...)` chain) — Why: add
  `.plugin(tauri_plugin_updater::Builder::new().build())`.
- `apps/desktop/src-tauri/tauri.conf.json` (39 lines) — Why: add a `plugins.updater` block + set
  `bundle.createUpdaterArtifacts: true`. `version` is `0.1.0`; bump to `0.1.1` to test the update hop.
- `apps/desktop/src-tauri/capabilities/default.json` (17 lines) — Why: add `"updater:default"` +
  `"process:allow-restart"` to `permissions`.
- `apps/desktop/package.json` — Why: `@tauri-apps/api: ^2.9.0` present; add `@tauri-apps/plugin-updater`
  + `@tauri-apps/plugin-process`. React 19, Vite 7.
- `apps/desktop/src/App.tsx` — Why: the webview root; the check-on-launch effect lives here (or a new
  `lib/updater.ts` called from it).
- `apps/desktop/README.md` — Why: the build recipe (OneDrive `.cargo/config.toml` target-dir redirect,
  `npm run build:desktop`, NSIS output path). The release process doc extends this.

### New Files to Create

- `apps/ingest/src/exports-parquet.ts` — pure `eventsToParquetBuffer(rows, columns)` serializer.
- `apps/ingest/src/exports-parquet.test.ts` — co-located **unit** test (no DB) round-tripping via `hyparquet`.
- `apps/desktop/src/lib/updater.ts` (Phase C) — `checkForUpdateOnLaunch()` wrapping the JS plugin.
- `docs/guide/operations.md` — **extend** (not new): a "12.8 — Parquet export / Restore / Releases"
  section (restore-from-UI guardrail + the signed-release runbook).

### Relevant Documentation — READ BEFORE IMPLEMENTING

- [hyparquet-writer (npm)](https://www.npmjs.com/package/hyparquet-writer) — `parquetWriteBuffer({ columnData })`
  → `ArrayBuffer` (SNAPPY, schema auto-inferred). `columnData` is `[{ name, data: unknown[] }]`.
  Why: the exact write API (verified by spike — see NOTES).
- [hyparquet (npm)](https://www.npmjs.com/package/hyparquet) — `parquetReadObjects({ file: ArrayBuffer })`
  → `Promise<row[]>`. Why: the test reads the buffer back to assert the round-trip.
- [Tauri v2 Updater plugin](https://v2.tauri.app/plugin/updater/) — Why: the exact config below was taken
  from here (verified 2026-06-21). Note **`dialog` is NOT a config field**; `windows.installMode` is.
- [Tauri v2 Process plugin](https://v2.tauri.app/plugin/process/) — `relaunch()` after install.
- [flate2 (crates.io)](https://docs.rs/flate2/latest/flate2/read/struct.GzDecoder.html) — `GzDecoder`
  errors on corrupt gzip (this IS the integrity check, replacing `gunzip -t`).

### Patterns to Follow

**Library/entrypoint boundary (CLAUDE.md):** the parquet serializer throws typed errors, never logs/exits.
The Rust command returns `Result<(), String>` (the `Err(String)` surfaces in the webview) — mirrors every
existing `#[tauri::command]`.

**Naming:** `kebab-case.ts` files; `camelCase` fns; `snake_case` Rust fns + Tauri command names
(`restore_archive`), `camelCase` JS bridge wrapper (`restoreArchive`); relative TS imports end in `.js`.

**Binary export (NEW — Phase A) — extend `sendExport` to accept `string | Buffer`:**

```ts
// apps/ingest/src/routes/exports.ts — CONTENT_TYPE gains parquet:
const CONTENT_TYPE: Record<ExportFormat, string> = {
  md: "text/markdown",
  json: "application/json",
  jsonl: "application/x-ndjson",
  csv: "text/csv",
  parquet: "application/vnd.apache.parquet", // binary
};

// sendExport: change `body: string` → `body: string | Buffer`. Fastify sends a Buffer as-is
// with the set content-type (no JSON serialization). Everything else unchanged.

// events handler body branch (replacing L201-208):
let body: string | Buffer;
if (format === "json") body = JSON.stringify({ manifest, rows: redacted });
else if (format === "jsonl") body = toJsonl(redacted);
else if (format === "csv") body = toCsv(redacted.map(flattenEventRow), EVENT_CSV_COLUMNS);
else body = eventsToParquetBuffer(redacted.map(flattenEventRow), EVENT_CSV_COLUMNS); // parquet
```

**Pure parquet serializer (NEW file) — column-oriented, deterministic, no clock/IO:**

```ts
// apps/ingest/src/exports-parquet.ts
import { parquetWriteBuffer } from "hyparquet-writer";

/**
 * Serialize flat export rows to a SNAPPY-compressed Parquet buffer (PRD §22). Column-oriented:
 * one column per `columns` entry, values pulled in row order (missing/undefined → null so the
 * column stays nullable). Pure + deterministic (the route owns redaction + the clock); the binary
 * is self-describing via its own schema, and the export manifest rides the X-Export-* headers
 * (as it does for CSV). Mirrors the `@420ai/shared` no-IO invariant — but lives HERE, not in
 * shared, because shared is dependency-free.
 */
export function eventsToParquetBuffer(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
): Buffer {
  const columnData = columns.map((name) => ({
    name,
    data: rows.map((r) => r[name] ?? null),
  }));
  const ab = parquetWriteBuffer({ columnData }); // ArrayBuffer, SNAPPY, schema auto-inferred
  return Buffer.from(ab);
}
```

> **Spike-snippet fidelity:** the snippet above matches the spike assertions in NOTES exactly —
> `parquetWriteBuffer({ columnData })` returns an `ArrayBuffer` (NOT a Buffer — wrap it), nulls round-trip,
> empty rows yield a valid 354-byte `PAR1` file. Do not "simplify" by passing rows directly; the lib is
> column-oriented.

**Rust restore command (NEW — Phase B) — mirrors `start_ingest`; flate2 in-process, no host `sh`/`gunzip`:**

```rust
// apps/desktop/src-tauri/src/server.rs
use flate2::read::GzDecoder;
use std::io::{Read, Write};

/// Restore the archive from a gzipped pg_dump (mirrors scripts/restore-archive.sh). DESTRUCTIVE on a
/// populated DB — the webview MUST confirm before calling. flate2 decodes in-process (GzDecoder errors
/// on a corrupt gzip → that IS the integrity check), then the plain SQL is streamed into psql inside the
/// compose `archive` container. No host gunzip/sh dependency; psql ships in the postgres:17 image.
#[tauri::command]
pub async fn restore_archive(backup_path: String) -> Result<(), String> {
    let cfg = keychain::load_server().ok_or("server not configured")?;
    let path = std::path::PathBuf::from(&backup_path);
    if !path.exists() {
        return Err(format!("backup file not found: {backup_path}"));
    }
    let args = compose_args(&cfg.server_dir, &["exec", "-T", "archive", "psql", "-U", "420ai", "-d", "420ai"]);
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        // Decompress fully in-process — a corrupt gzip fails HERE, before any psql statement runs.
        let file = std::fs::File::open(&path).map_err(|e| format!("open backup: {e}"))?;
        let mut sql = Vec::new();
        GzDecoder::new(file)
            .read_to_end(&mut sql)
            .map_err(|_| "corrupt gzip archive — aborting restore".to_string())?;
        let mut child = Command::new("docker")
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "Docker not installed/not running (docker not found on PATH)".to_string()
                } else {
                    format!("failed to run docker: {e}")
                }
            })?;
        child.stdin.take().ok_or("no stdin")?.write_all(&sql).map_err(|e| format!("write sql: {e}"))?;
        let out = child.wait_with_output().map_err(|e| format!("psql wait: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(format!("restore failed: {}", if stderr.is_empty() { out.status.to_string() } else { stderr }));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("task error: {e}"))?
}
```

> **VERIFY at implementation time:** confirm `compose_args` is in scope in `server.rs` (the agent map
> placed it there; if it's `pub(crate)` elsewhere, import it) and that `Command`/`Stdio` are the same
> `std::process` imports `start_ingest` uses. If `psql` is unexpectedly absent from the image, fall back
> to `compose_args(&server_dir, &["exec","-T","archive","sh","-c","psql -U 420ai -d 420ai"])`.

**Tauri updater config (Phase C) — verified from the v2 docs (2026-06-21):**

```jsonc
// apps/desktop/src-tauri/tauri.conf.json — add a top-level "plugins" block + the bundle flag:
"bundle": { /* …existing… */ "createUpdaterArtifacts": true },
"plugins": {
  "updater": {
    "pubkey": "<CONTENT OF ~/.tauri/420ai.key.pub — paste verbatim>",
    "endpoints": [
      "https://github.com/seanrobertwright/420AI/releases/latest/download/latest.json"
    ],
    "windows": { "installMode": "passive" }
  }
}
```

**Check-on-launch (Phase C) — JS plugin, runs once on mount:**

```ts
// apps/desktop/src/lib/updater.ts
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** Check GitHub Releases once on launch; if an update verifies against the baked pubkey, install + relaunch. */
export async function checkForUpdateOnLaunch(): Promise<void> {
  const update = await check();
  if (!update) return;
  await update.downloadAndInstall();
  await relaunch();
}
```

`latest.json` (uploaded to each GitHub release — the shape the updater expects):

```json
{
  "version": "0.1.1",
  "notes": "…",
  "pub_date": "2026-06-21T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<CONTENT OF the .sig emitted next to the NSIS installer>",
      "url": "https://github.com/seanrobertwright/420AI/releases/download/v0.1.1/420AI.Collector_0.1.1_x64-setup.exe"
    }
  }
}
```

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Each task is atomic and independently testable.

### PHASE A — PARQUET EXPORT

#### A1. ADD dependency `hyparquet-writer` (+ dev `hyparquet`) to `apps/ingest/package.json`

- **IMPLEMENT**: add `"hyparquet-writer": "^0.16.1"` to `dependencies` and `"hyparquet": "^1.26.1"` to a
  new `devDependencies` block. Run `npm install` from the repo root (workspaces).
- **GOTCHA**: both are pure-ESM `type:module`, ship `.d.ts`, zero transitive deps (spiked). The reader is
  test-only — keep it out of runtime `dependencies`.
- **VALIDATE**: `npm ls -w @420ai/ingest hyparquet-writer hyparquet` resolves both; `npm run typecheck` exits 0.

#### A2. UPDATE `packages/shared/src/serialize.ts` — extend `ExportFormat`

- **IMPLEMENT**: change `export type ExportFormat = "md" | "json" | "jsonl" | "csv";` →
  `… | "csv" | "parquet";`. Update the L15 comment ("Parquet deferred" → "Parquet for events").
- **GOTCHA**: do NOT import the parquet lib here — shared stays dependency-free. Only the union string changes.
- **VALIDATE**: `npm run typecheck` exits 0 (this surfaces every exhaustive `switch`/`Record<ExportFormat,…>`
  that now needs a parquet arm — including `CONTENT_TYPE` in A4).

#### A3. CREATE `apps/ingest/src/exports-parquet.ts`

- **IMPLEMENT**: the `eventsToParquetBuffer(rows, columns)` function from Patterns above.
- **PATTERN**: pure/no-IO like `serialize.ts`; column-oriented `columnData`.
- **IMPORTS**: `import { parquetWriteBuffer } from "hyparquet-writer";`
- **GOTCHA**: `parquetWriteBuffer` returns an **`ArrayBuffer`** — wrap in `Buffer.from(...)`. Coalesce
  `undefined → null` so a column with any missing value stays nullable.
- **VALIDATE**: `npm run typecheck` exits 0.

#### A4. UPDATE `apps/ingest/src/routes/exports.ts` — wire parquet into the events route

- **IMPLEMENT**: (a) add `parquet: "application/vnd.apache.parquet"` to `CONTENT_TYPE`; (b) change
  `sendExport`'s `body: string` param type to `body: string | Buffer`; (c) in the events handler, change
  `let body: string` → `let body: string | Buffer` and add the `else` parquet branch calling
  `eventsToParquetBuffer(redacted.map(flattenEventRow), EVENT_CSV_COLUMNS)`.
- **PATTERN**: reuse `flattenEventRow` + `EVENT_CSV_COLUMNS` (identical tabular schema to CSV).
- **IMPORTS**: `import { eventsToParquetBuffer } from "../exports-parquet.js";`
- **GOTCHA**: parquet is **events-only** — do NOT touch the report (L223) or transcript (L285) handlers.
  Their schemas stay `md|json[|jsonl]`. The manifest rides the existing `X-Export-*` headers (as for CSV);
  do not try to embed it in the binary this slice.
- **VALIDATE**: `npm run typecheck` exits 0.

#### A5. UPDATE `apps/ingest/src/schemas.ts` — accept `format=parquet`

- **IMPLEMENT**: in `exportEventsQuerySchema` (L246) change `enum: ["json", "jsonl", "csv"]` →
  `["json", "jsonl", "csv", "parquet"]`.
- **GOTCHA**: ONLY the events schema. `exportReportQuerySchema`/`exportTranscriptQuerySchema` unchanged.
- **VALIDATE**: `npm run typecheck` exits 0.

#### A6. CREATE `apps/ingest/src/exports-parquet.test.ts` — pure unit test (no DB, always runs)

- **IMPLEMENT**: build sample flat rows (mix strings, ints, floats, and **nulls** — mirror `flattenEventRow`
  output), call `eventsToParquetBuffer(rows, EVENT_CSV_COLUMNS-equivalent)`, assert: (1) result is a
  `Buffer` with `PAR1` magic at byte 0-3 and the last 4 bytes; (2) `await parquetReadObjects({ file: buf.buffer… })`
  returns rows deep-equal to the input (nulls preserved); (3) empty rows → a valid non-empty buffer.
- **PATTERN**: co-located vitest `*.test.ts` (CLAUDE.md "units always run").
- **IMPORTS**: `import { parquetReadObjects } from "hyparquet";` +
  `import { eventsToParquetBuffer } from "./exports-parquet.js";`
- **GOTCHA**: `parquetReadObjects` wants an `ArrayBuffer` via `{ file }`. From a Node `Buffer`, pass
  `buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)` (a `Buffer` is a view over a larger
  pooled ArrayBuffer — slicing gets just these bytes). Round-trip equality proven by spike.
- **VALIDATE**: `npx vitest run apps/ingest/src/exports-parquet.test.ts` → all pass.

#### A7. ADD a parquet HTTP case to `apps/ingest/src/exports.int.test.ts`

- **IMPLEMENT**: mirror an existing events-export case; `app.inject` `GET /v1/exports/events?format=parquet`
  with the admin bearer; assert `statusCode === 200`, `content-type` is `application/vnd.apache.parquet`,
  `x-export-redaction-version` header present, and `res.rawPayload` (a Buffer) starts with `PAR1`.
- **PATTERN**: the harness at L23-90 (`createCode`/`pair`/`discoverPayload`, seed events, then inject).
- **GOTCHA**: int tests self-skip without `DATABASE_URL_TEST` — see Level 3. Use `res.rawPayload` (Buffer),
  not `res.payload` (utf-8 string would corrupt binary).
- **VALIDATE**: `npm run repo-health -- --require-db` (with test DB up) — the export int layer runs, 0 skipped.

#### A8. UPDATE `apps/dashboard/src/components/export/export-view.tsx` — add the parquet option

- **IMPLEMENT**: change `evFormat` state type (L39) + the `setEvFormat` casts (L86) from
  `"json" | "jsonl" | "csv"` → `… | "parquet"`; add `<option value="parquet">Parquet</option>` to the
  events `<select>` (after L92).
- **GOTCHA**: NO proxy/route change — `proxyStream` forwards `content-type` + body bytes verbatim and the
  route passes `req.nextUrl.search` through (confirmed). `<a download>` downloads the `.parquet` bytes.
  Report/transcript selects stay unchanged.
- **VALIDATE**: `npm run typecheck:dashboard` exits 0; `npm run build:dashboard` succeeds.

#### A9. COMMIT Phase A

- **VALIDATE**: `npm run repo-health` passes (typecheck + units + NUL/artifact scans) **and**, with the
  test DB up, `npm run repo-health -- --require-db` (export int layer ran, 0 skipped). Commit
  `feat(m12): parquet events export (slice 12.8a)`.

### PHASE B — RESTORE UI (DESKTOP)

#### B1. ADD `flate2` to `apps/desktop/src-tauri/Cargo.toml`

- **IMPLEMENT**: add `flate2 = "1"` to `[dependencies]` (after the existing crates).
- **VALIDATE**: `cd apps/desktop/src-tauri && cargo fetch` resolves (or defer to B4's `cargo check`).

#### B2. ADD `restore_archive` command to `apps/desktop/src-tauri/src/server.rs`

- **IMPLEMENT**: the `restore_archive` function from Patterns above.
- **PATTERN**: `start_ingest` (L337-372) for keychain load + `Command`/`Stdio` + error mapping;
  `run_docker` (L224-242) for the docker-not-found message; `compose_args` for the arg vector.
- **IMPORTS**: add `use flate2::read::GzDecoder;` and `use std::io::{Read, Write};` (check whether
  `Read`/`Write` are already imported to avoid a duplicate-import warning).
- **GOTCHA**: DESTRUCTIVE — the **webview** owns the confirm gate (B5), not Rust. Decompress fully before
  spawning psql so a corrupt gzip aborts with zero statements applied.
- **VALIDATE**: B4 `cargo check`.

#### B3. REGISTER the command in `apps/desktop/src-tauri/src/lib.rs`

- **IMPLEMENT**: add `server::restore_archive,` to the `tauri::generate_handler![...]` list (before
  `server::unpair` at L40).
- **VALIDATE**: B4 `cargo check`.

#### B4. VALIDATE the Rust compiles

- **VALIDATE**: `cd apps/desktop/src-tauri && cargo check` exits 0 and `cargo clippy -- -D warnings` is
  clean. (Respect the OneDrive `.cargo/config.toml` target-dir redirect from `apps/desktop/README.md`.)

#### B5. ADD `restoreArchive` bridge wrapper + Settings button

- **IMPLEMENT**: (a) in `apps/desktop/src/lib/bridge.ts` after L173 add
  `export function restoreArchive(backupPath: string): Promise<void> { return invoke("restore_archive", { backupPath }); }`;
  (b) in `Settings.tsx` add `restoreBusy` state, an `onRestore` handler (mirror `onArchive` L203-215) that
  **first** `window.confirm("Restore will OVERWRITE the current archive. Continue?")`, takes a backup path
  (a text input or a `@tauri-apps/plugin-dialog` open — if not already a dep, use a text input for the
  `.sql.gz` absolute path this slice), calls `run(() => restoreArchive(path))`, then `refreshHealth()`;
  (c) add a confirm-gated `<StackButton disabled={restoreBusy}>` in the server-stack section (near L417).
- **GOTCHA**: invoke arg key is `backupPath` (camelCase) — Tauri maps it to the Rust `backup_path`
  (snake) automatically. Keep the `run()`/busy/`refreshHealth` discipline of the existing buttons.
- **VALIDATE**: `npm run typecheck:desktop` exits 0.

#### B6. DOCUMENT + COMMIT Phase B

- **IMPLEMENT**: add a "Restore from the desktop (12.8)" note to `docs/guide/operations.md` — the UI does a
  direct overwrite restore after a confirm; for maximum safety restore into a scratch DB first via
  `scripts/restore-archive.sh` (cite it). Note `format:check` lints markdown in CI (memory) — run
  `npm run format` before committing.
- **VALIDATE**: `npm run repo-health` passes; `npm run typecheck:desktop` + `cargo check` clean. Commit
  `feat(m12): desktop restore-from-backup UI (slice 12.8b)`. **Manual restore test: Level 4 below.**

### PHASE C — AUTO-UPDATE VIA GITHUB

#### C1. ADD Rust + JS updater dependencies

- **IMPLEMENT**: (a) `apps/desktop/src-tauri/Cargo.toml`: add `tauri-plugin-updater = "2"`; (b)
  `apps/desktop/package.json`: add `@tauri-apps/plugin-updater` + `@tauri-apps/plugin-process` (use the
  `^2` line matching `@tauri-apps/api: ^2.9.0`). `npm install` from repo root.
- **VALIDATE**: `npm ls -w @420ai/desktop @tauri-apps/plugin-updater` resolves; `cargo fetch` resolves the crate.

#### C2. REGISTER the updater plugin in `lib.rs`

- **IMPLEMENT**: add `.plugin(tauri_plugin_updater::Builder::new().build())` to the builder chain (after the
  autostart `.plugin(...)` at L23).
- **VALIDATE**: `cargo check` exits 0.

#### C3. GENERATE the updater signing key (one-time, manual)

- **IMPLEMENT**: run `cd apps/desktop && npm run tauri signer generate -- -w ~/.tauri/420ai.key` (set a
  password). This emits `~/.tauri/420ai.key` (private) + `~/.tauri/420ai.key.pub` (public). **Never commit
  the private key** (it goes in `.secrets/`-style storage / a GitHub Actions secret; mirror the M10 catalog
  private-key discipline). Paste the `.pub` content into `tauri.conf.json` `plugins.updater.pubkey`.
- **GOTCHA**: this is the Tauri updater key (free, minisign-style) — NOT an OS code-signing cert. The build
  reads `TAURI_SIGNING_PRIVATE_KEY` (path or content) + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from env.
- **VALIDATE**: `~/.tauri/420ai.key.pub` exists and its content is in the config (C4).

#### C4. CONFIGURE `tauri.conf.json`

- **IMPLEMENT**: add the `plugins.updater` block (pubkey + the
  `…/seanrobertwright/420AI/releases/latest/download/latest.json` endpoint + `windows.installMode: "passive"`)
  and set `bundle.createUpdaterArtifacts: true`, per Patterns. Bump `version` `0.1.0 → 0.1.1` for the test.
- **GOTCHA**: `dialog` is NOT a valid updater field (verified). Do not add an MSI/WiX target — `targets`
  stays `["nsis"]`.
- **VALIDATE**: the JSON parses; `npm run build -w @420ai/desktop` (vite) still succeeds.

#### C5. ADD updater + process capabilities

- **IMPLEMENT**: in `apps/desktop/src-tauri/capabilities/default.json` add `"updater:default"` and
  `"process:allow-restart"` to `permissions`.
- **VALIDATE**: `cargo check` exits 0 (capability identifiers resolve against the generated schema).

#### C6. ADD check-on-launch to the webview

- **IMPLEMENT**: create `apps/desktop/src/lib/updater.ts` (`checkForUpdateOnLaunch` from Patterns) and call
  it once from `App.tsx` in a mount effect (`useEffect(() => { checkForUpdateOnLaunch().catch(() => {}); }, [])`).
- **GOTCHA**: swallow errors (offline / no release / pre-pubkey) — a failed update check must never block
  app start. Imports: `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`.
- **VALIDATE**: `npm run typecheck:desktop` exits 0.

#### C7. DOCUMENT the signed-release runbook in `docs/guide/operations.md`

- **IMPLEMENT**: a "12.8 — Releasing a desktop update" section: (1) bump `tauri.conf.json` `version`; (2)
  `export TAURI_SIGNING_PRIVATE_KEY=… TAURI_SIGNING_PRIVATE_KEY_PASSWORD=…`; (3) `npm run build:desktop`
  (emits the NSIS `…_x64-setup.exe` + a `.sig` next to it); (4) author `latest.json` (shape in Patterns —
  paste the `.sig` content + the release-asset `url`); (5)
  `gh release create v0.1.1 "<setup.exe>" latest.json --title … --notes …`. Note: the **first** install is
  still an unsigned-by-CA NSIS (SmartScreen warns once) — code signing is parked; auto-update works
  regardless via the updater key.
- **VALIDATE**: `npm run format` then `npm run repo-health` (markdown lints clean).

#### C8. COMMIT Phase C

- **VALIDATE**: `npm run typecheck:desktop` + `cargo check`/`cargo clippy` clean; `npm run repo-health`
  passes (no backend regressions). Commit `feat(m12): desktop auto-update via GitHub Releases (slice 12.8c)`.
  **Manual update E2E: Level 4 below.**

---

## TESTING STRATEGY

### Unit Tests

- **`apps/ingest/src/exports-parquet.test.ts`** (Phase A, no DB, always runs): round-trips flat rows
  (strings/ints/floats/nulls) through `eventsToParquetBuffer` → `parquetReadObjects`; asserts `PAR1` magic
  + deep equality + null preservation + empty-rows validity. This is the load-bearing automated proof for
  Parquet.

### Integration Tests

- **`apps/ingest/src/exports.int.test.ts`** (Phase A, needs `DATABASE_URL_TEST`): `GET /v1/exports/events?format=parquet`
  returns 200 + `application/vnd.apache.parquet` + a `PAR1`-prefixed Buffer body + the redaction header.
  Must actually run (0 skipped) under `--require-db`.

### Rust validation (Phases B & C)

- Rust is **outside** `repo-health`. Gate with `cargo check` + `cargo clippy -- -D warnings` in
  `apps/desktop/src-tauri` (respect the OneDrive target-dir redirect). `npm run typecheck:desktop` gates the
  webview TS.

### Edge Cases

- Parquet: empty result set (valid 354-byte file, header emitted); all-null column; truncation (the
  `EXPORT_MAX_ROWS` cap + `x-export-truncated` header still apply — unchanged).
- Restore: missing file → `Err`; corrupt gzip → `Err` with zero statements applied (GzDecoder fails before
  psql spawns); Docker not running → the "docker not found" message; user cancels the confirm → no-op.
- Auto-update: offline / no release / response not signed by the baked pubkey → `check()` rejects or
  returns null → caught, app starts normally; same-version → no update offered.

---

## VALIDATION COMMANDS

All commands run from the repo root unless noted. **`repo-health` is the gate** (CLAUDE.md).

### Level 1: Syntax & Style

- `npm run typecheck` — root `tsc -b`, exit 0 (Phase A; catches the `ExportFormat` exhaustiveness).
- `npm run typecheck:dashboard` — exit 0 (Phase A8).
- `npm run typecheck:desktop` — exit 0 (Phases B/C webview).
- `npm run format && npm run format:check` — markdown/TS prettier clean (CI lints `.md`; local repo-health
  does not — memory).
- `cd apps/desktop/src-tauri && cargo clippy -- -D warnings` — clean (Phases B/C).

### Level 2: Unit Tests

- `npx vitest run apps/ingest/src/exports-parquet.test.ts` — all pass (Phase A, no infra).
- `npm run repo-health` — full units + typecheck + NUL/artifact scans, exit 0.

### Level 3: Integration Tests

- `npm run db:up && npm run db:migrate` then `npm run repo-health -- --require-db` — the export int layer
  runs (parquet HTTP case included), **0 skipped**. (Migrate `420ai_test` separately first — memory.)

### Level 4: Manual Validation

- **Parquet (optional, beyond the gated tests):** `curl -s -H "authorization: Bearer $ADMIN_TOKEN"
  "localhost:8420/v1/exports/events?format=parquet" -o out.parquet` then in DuckDB
  `SELECT count(*) FROM 'out.parquet';` returns the row count; columns match `EVENT_CSV_COLUMNS`.
- **Restore (Phase B — required, not automatable):** with the stack up and a real
  `backups/420ai-<stamp>.sql.gz`, click **Restore Archive** in desktop Settings → confirm → button shows
  busy → health refreshes → DB reflects the dump. Also test a corrupt `.gz` (truncate a copy) → error toast,
  archive unchanged.
- **Auto-update (Phase C — required, not automatable):** build + `gh release create v0.1.1` per C7; install
  the **v0.1.0** NSIS; launch v0.1.1 isn't installed yet → with v0.1.0 running and a v0.1.1 release live,
  relaunch the installed app → it detects, downloads, verifies against the pubkey, installs, relaunches as
  v0.1.1. Confirm a tampered `latest.json`/installer is REJECTED (signature mismatch).

### Level 5: Additional Validation (Optional)

- DuckDB/pandas load of an exported `.parquet` as a real-world consumer smoke test.

---

## ACCEPTANCE CRITERIA

- [ ] `GET /v1/exports/events?format=parquet` returns a valid SNAPPY Parquet file (`PAR1` magic) of the
      redacted, flattened event rows; `application/vnd.apache.parquet`; manifest in `X-Export-*` headers.
- [ ] Report/transcript exports are unchanged (still reject `parquet`).
- [ ] Dashboard export form offers **Parquet** for events and downloads it with no token in the browser.
- [ ] `exports-parquet.test.ts` (unit) + the parquet int case pass; `repo-health` and
      `repo-health --require-db` green (0 skipped).
- [ ] Desktop Settings has a **confirm-gated** "Restore Archive" button that drives a working restore;
      corrupt-gzip and missing-file are surfaced as errors with the archive untouched.
- [ ] `cargo check` + `cargo clippy -- -D warnings` + `typecheck:desktop` clean for Phases B & C.
- [ ] An installed desktop app auto-detects, verifies, installs, and relaunches a newer GitHub release;
      a tampered payload is rejected.
- [ ] `docs/guide/operations.md` documents restore-from-UI and the signed-release runbook.
- [ ] **No** MSI/WiX target and **no** CA code-signing step were added (parked).
- [ ] No regression: `npm run repo-health` passes; the fingerprint, ingest wire types, and existing export
      formats are untouched.

---

## COMPLETION CHECKLIST

- [ ] Phase A committed (`feat(m12): parquet events export (slice 12.8a)`) — gated green.
- [ ] Phase B committed (`feat(m12): desktop restore-from-backup UI (slice 12.8b)`) — cargo + manual restore.
- [ ] Phase C committed (`feat(m12): desktop auto-update via GitHub Releases (slice 12.8c)`) — cargo + manual update.
- [ ] All Level 1-3 commands pass; Level 4 manual checks performed for B & C.
- [ ] `SUMMARY.md` §6 M12 list + `docs/PRD.md` §25 M12.8 updated to reflect what shipped vs. parked
      (code signing / MSI / Parquet-for-report-transcript deferred).
- [ ] Branch `m12-slice8-export-distribution-polish` → PR; `repo-health` CI required check green before merge.

---

## NOTES

**Spikes actually run during planning (evidence for the confidence score):**

- **Parquet library spike (RUN, throwaway deleted).** In a temp dir on this machine (Node v24.16.0):
  - `npm install hyparquet-writer hyparquet` → "added 2 packages" — **zero transitive deps**; both
    `type:module`, ship `.d.ts` (`hyparquet-writer@0.16.1`, `hyparquet@1.26.1`).
  - Wrote 2 event-shaped rows (strings, ints, a float `0.0234`, and **nulls**) via
    `parquetWriteBuffer({ columnData })` → a **2269-byte ArrayBuffer**; read back with
    `parquetReadObjects({ file })` → **both rows deep-equal the input, nulls preserved, int stays `number`,
    float exact**. Empty rows → a valid **354-byte** file.
  - Magic bytes: head and tail both `"PAR1"` (valid Parquet).
  - TS: a `tscheck.ts` using `parquetWriteBuffer` under `module/moduleResolution: NodeNext, strict`
    compiled with `tsc` **exit 0** — the return type is `ArrayBuffer`, `Buffer.from(ab)` typechecks.
  - **Conclusion:** `hyparquet-writer` is the pick; the serializer snippet in Patterns matches these
    assertions exactly. This is the single biggest design risk, and it is retired.
- **Tauri updater config (verified against the live v2 docs, 2026-06-21):** the `plugins.updater` shape
  (`pubkey`/`endpoints`/`windows.installMode`), `bundle.createUpdaterArtifacts`, the `tauri signer generate`
  command, the `TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]` env vars, the `updater:default` + `process:allow-restart`
  capabilities, the `@tauri-apps/plugin-updater`/`-process` JS API, and the `latest.json` shape are all
  quoted from the official docs — **not** from memory. Correction caught: `dialog` is NOT a config field
  (an earlier draft had it).
- **Desktop map (verified by reading the files):** Tauri `2`; plugin registration via `.plugin()` in
  `lib.rs`; `restore_archive` mirrors `start_ingest`/`run_docker`/`compose_args` in `server.rs`; the bridge
  `invoke()` pattern; `@tauri-apps/api ^2.9.0` present, no JS plugin packages yet. Restore is a **direct
  Rust command**, NOT a control-protocol message (`CONTROL_PROTOCOL_VERSION` unchanged).

**Design decisions / trade-offs:**

- Parquet serializer lives in `apps/ingest`, NOT `@420ai/shared` — shared's "dependency-free, no I/O"
  invariant forbids a writer lib there. The route already owns the binary boundary.
- Restore decompresses with `flate2` in-process (no host `gunzip`/`sh` dependency — Windows-safe) and
  streams plain SQL to the container's `psql` (which the postgres:17 image guarantees). The gzip-integrity
  guarantee of `scripts/restore-archive.sh` is preserved (GzDecoder errors before any statement runs).
- Auto-update's end-to-end behavior is **intrinsically a manual release-and-observe test** (Level 4), not an
  automated gate — there is no way to assert a real cross-process self-update inside `vitest`/`cargo test`.
  The plan therefore maximizes the *automatable* surface (typecheck/cargo/clippy on all config+code) and
  treats the live update hop as a documented manual acceptance step. This is normal for desktop distribution,
  not a plan gap.
- **Parked (do not build):** CA/Authenticode code signing, MSI/WiX, a CI release workflow (`tauri-action`).
  The manual `gh release create` runbook is the validated release path; CI release can be a later slice.

**Confidence: 9.4 / 10.**

- Phase A ≈ **9.7** — the only real risk (the Parquet lib) was spiked end-to-end incl. types + nulls +
  magic bytes; every other change is a 1-line extension of an exhaustively-read seam, and it's fully gated
  by `repo-health` + the int layer.
- Phase B ≈ **9.2** — the Rust command mirrors a verified existing pattern line-for-line; deductions are
  that I could not run `cargo check` in this environment (long Rust compile + OneDrive target redirect) and
  the restore E2E is manual. Both are environmental, not knowledge gaps; the executor's `cargo check` +
  manual test close them.
- Phase C ≈ **9.2** — config/code is now exact (docs-verified), but the live update hop is manual by nature
  and the signing-key ceremony is a one-time human step. Implementation is one-pass; full E2E proof is the
  documented Level-4 step.
- Aggregate **9.4**: a competent agent can implement all three legs and pass every *automatable* gate in
  one pass with no further research; the only non-automatable proofs (restore + update E2E) are explicitly
  called out as manual Level-4 acceptance, which is the correct treatment for this class of work rather
  than a hidden assumption.
