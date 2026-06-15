# Code Review — M11 Slice 1 (Walking Skeleton)

**Date:** 2026-06-15
**Scope:** the Slice 1 working-tree changes (collector `serve` + SEA, `apps/desktop` Tauri shell + webview, gate wiring). Reviewed against `CLAUDE.md` conventions (stdout/process boundary, frontend-workspace lane, leak-window discipline, token-never-in-webview).

**Stats:**
- Files Modified: 4 (`package.json`, `package-lock.json`, `packages/shared/src/index.ts`, `scripts/repo-health.mjs`)
- Files Added (source): 27 (collector `serve.ts`/`serve.test.ts`/`build-sea.mjs`; `packages/shared/control-protocol.{ts,test.ts}`; full `apps/desktop` webview + `src-tauri` Rust)
- Files Added (non-source): 3 (`Cargo.lock`, `app-icon.png` seed, `binaries/.gitkeep`)
- Files Deleted: 0
- New source lines: ~1,042 across the six core files

**Gate status at review time:** `repo-health` PASS (302 tests); `repo-health --require-db` PASS (73 int tests ran, 0 skipped); `cargo test` 3 pass; SEA `.exe` + `cargo tauri build --no-bundle` both succeed.

No **critical** or **high** issues. No security issues (token stays in the sidecar process; the webview only receives state/counts; the shell capability is scoped to the `binaries/collector` sidecar). The findings below are correctness-adjacent polish for Slice 2.

---

severity: low
file: apps/desktop/src-tauri/src/sidecar.rs
line: 110
issue: Sidecar restart uses a FIXED 1 s delay with no cap — the plan specified "restart-with-backoff".
detail: On a permanently-failing spawn (missing/corrupt `collector-*.exe`, denied capability) the loop emits an `error`/`log` event, sleeps exactly `RESTART_BACKOFF_MS` (1000 ms), and retries forever. There is no exponential growth and no max-attempts / circuit-breaker, so a broken binary produces ~1 error event per second indefinitely with no terminal state for the UI to settle on.
suggestion: Track consecutive failures; grow the delay exponentially (cap ~30 s, mirroring `queue-store.ts` `BACKOFF_CAP_MS`) and after N straight failures emit a terminal `{type:"error"}` and stop respawning until a manual retry. Reset the counter after a successful spawn that stays up.

severity: low
file: apps/desktop/src/components/StatusBar.tsx
line: 81, 109-111
issue: `sendCommand(...)` results are never awaited or `.catch`-ed — a rejected Tauri `invoke` becomes an unhandled promise rejection.
detail: The mount-time `void sendCommand({ cmd: "status" })` and the three button `onClick={() => sendCommand({ cmd: ... })}` calls ignore the returned promise. `send_command` rejects with `"sidecar not running"` whenever the sidecar is between restarts (which, given finding #1, is a real window), surfacing as an `unhandledrejection` in the webview instead of user feedback.
suggestion: Wrap each call in a small helper that `.catch`-es and routes the error into the panel (e.g. a transient toast or a `lastError` state), e.g. `const run = (c) => sendCommand(c).catch((e) => setError(String(e)))`.

severity: low
file: apps/collector/src/serve.ts
line: 56-63, 100-106
issue: `defaultQueueStats()` constructs a brand-new `QueueStore` (reopen + `PRAGMA`/`CREATE TABLE IF NOT EXISTS`) on every status tick (default 5 s) concurrently with the engine's own writer connection.
detail: It works under WAL (readers don't block the writer, and the idempotent DDL/PRAGMA short-circuit), so this is not a correctness bug — but it reopens the SQLite file on a timer for the life of the process and carries a small transient `SQLITE_BUSY` risk that would surface as recurring `"queue stats unavailable"` warn-log spam under heavy write contention.
suggestion: Open ONE read handle in `runServe` and reuse it for stats (closing it in `cleanupAndExit`), or have `runCaptureEngine` expose a `stats()` accessor so serve reads the engine's existing connection instead of opening a second one.

severity: low
file: apps/collector/src/serve.ts
line: 86, 105
issue: `lastSyncAt` is declared but never assigned — every `status` event ships `lastSyncAt: null` and the StatusBar always renders "—".
detail: The field is plumbed end-to-end (protocol type → event → `StatusView` → UI) but nothing populates it, because `runCaptureEngine` does not surface its last successful `syncOnce` time. It is dead on the wire for Slice 1.
suggestion: Either add a `// TODO(Slice 2): populate from the engine's last sync` next to the declaration, or drop the field from the Slice-1 emit until the engine exposes it — so a reader isn't misled into thinking it's wired.

severity: low
file: apps/collector/src/serve.ts
line: 145-159 (pause path) — behavioral note
issue: `pause` triggers the engine's final-drain, so `pending` DROPS on pause rather than "holding steady" as the spike prototype modeled.
detail: `pause` calls `controller.abort()`, and `runCaptureEngine` runs a best-effort drain loop on abort (`capture-engine.ts:87-94`) that `syncOnce`s pending items to the archive before resolving. So against a reachable server, pausing flushes the backlog (pending → ~0) instead of freezing it. No data is lost (the queue is durable and items are synced, not dropped) — but it diverges from the spike's throwaway `[2,2]` "pause holds" behavior, because Slice 1 correctly reuses the REAL engine (which the spike did not). The unit test models a non-draining fake engine, so it does not catch this divergence.
suggestion: Accept and DOCUMENT it (a comment on `pause` and in `SUMMARY.md` at Slice-5 sign-off): "pause flushes-then-stops; the durable queue is retained, pending drains to the server." Do NOT alter the engine (it is a locked invariant). If a true freeze is ever wanted, that is a new non-draining abort path in a later slice, not a Slice-1 change.

severity: low
file: apps/collector/scripts/build-sea.mjs
line: 130-141
issue: Hardcoded `node_modules/postject/dist/cli.js` path assumes root hoisting.
detail: The postject invocation builds the CLI path as `join(repoRoot, "node_modules", "postject", "dist", "cli.js")`. It resolves in this repo (postject is a root devDep and hoists), but a future workspace-local install or a pnpm-style layout would break it with a confusing ENOENT rather than a clear "postject not found".
suggestion: Resolve it portably, e.g. `fileURLToPath(import.meta.resolve("postject/dist/cli.js"))` (or `createRequire(import.meta.url).resolve(...)`), so the path follows the actual install location.

---

## Resolutions (applied this pass)

- **#1 (backoff)** — FIXED. `run_sidecar_loop` now tracks consecutive failures by uptime: a run that stays up ≥5 s resets the counter; fast failures escalate the delay 1→2→4…→30 s (cap), and after 6 straight fast failures it emits a terminal `error` and stops respawning. Spawn/relay extracted into `spawn_and_relay`. `cargo test` green, no warnings.
- **#2 (unhandled rejection)** — FIXED. `StatusBar` routes every command through a `run()` helper that `.catch`-es and shows the error in a `lastError` line; mount + all three buttons use it. `typecheck:desktop` green.
- **#4 (dead `lastSyncAt`)** — annotated with a `TODO(Slice 2)` so it isn't mistaken for wired.
- **#5 (pause drains)** — documented with a `NOTE` comment on `pause()` (behavior is correct; reusing the locked engine is the cause).
- **#6 (postject path)** — FIXED. Resolved via `createRequire(import.meta.url).resolve("postject/dist/cli.js")`; `--check` green.
- **#3 (per-tick QueueStore reopen)** — DEFERRED to Slice 2 (harmless under WAL; best paired with the engine exposing a `stats()` accessor).

Re-validation after fixes: root `typecheck` + `typecheck:desktop` 0 errors; `vitest` 9 (serve+protocol) / 302 (full) pass; `cargo test` 3 pass, no warnings; `build-sea --check` pass; `repo-health` PASS. (`--require-db` not re-run — the fixes touch only Rust, the webview, comments, and a build script; no `@420ai/db`/`apps/ingest`/collector-runtime code changed, and the prior `--require-db` run was 73 int tests / 0 skipped.)

## What was checked and is correct

- **stdout discipline (CLAUDE.md):** `serve.ts` writes ONLY JSON-lines to stdout; the engine `logger` maps to a `{type:"log"}` event and warnings go to stderr. Verified empirically — the SEA `.exe` produced pure JSON on stdout with empty stderr.
- **Leak-window discipline:** `serve.ts` arms the readline listeners + status timer synchronously inside the Promise executor before any `await`; `cleanupAndExit` clears the interval and closes readline (guarded by `closed`). `StatusBar.tsx` handles the async-`listen` unmount-before-resolve window via the `disposed` flag + immediate unlisten. Rust `shutdown` kills the child on `RunEvent::Exit` and latches `shutting_down` so the restart loop won't respawn during teardown.
- **Command serialization:** `serve.ts` funnels commands through a promise `chain`, so an awaiting `pause`/`stop` cannot interleave with the next command — pause→resume ordering is preserved.
- **Token-never-in-webview:** Slice 1 loads creds from disk inside the sidecar; the webview only receives `state`/`pending`/`inflight`. No token crosses the bridge. Shell capability scoped to the sidecar with `args:["serve"]`.
- **Frontend-workspace rule:** `apps/desktop` is OUT of the root `tsc -b` graph and gets its own enforced `typecheck:desktop` lane wired into `repo-health` ([5/6]); shadcn primitives hand-copied, not CLI-initialized.
- **Rust relay parser:** `parse_event_line` passes valid objects through and synthesizes an `error` event for malformed / non-object lines — covered by `cargo test` (3 golden cases).
