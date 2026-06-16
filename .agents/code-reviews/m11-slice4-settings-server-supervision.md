# Code Review — M11 Slice 4: Settings + Full Server-Stack Supervision

**Date:** 2026-06-16
**Branch:** `m11-slice3-pairing-autostart-keychain`
**Scope:** Desktop app only (`apps/desktop`). No collector/ingest/db/shared changes.

## Stats

- Files Modified: 6 (`keychain.rs`, `lib.rs`, `proxy.rs`, `tray.rs`, `App.tsx`, `bridge.ts`)
- Files Added: 2 (`server.rs`, `Settings.tsx`)
- Files Deleted: 0
- New lines: ~272 (diff) + ~620 (new files)
- Deleted lines: ~31

## Validation status (all green)

- `npm run typecheck` (root `tsc -b`): 0 errors
- `npm run typecheck:desktop`: 0 errors
- `cargo test` (desktop): 26 passed, 0 failed (incl. new server-config keychain round-trip + all `server.rs` pure-helper + masking tests)
- `npm run repo-health`: PASS
- `npm run repo-health -- --require-db`: PASS (73 integration tests ran, 0 skipped)
- `npm run build -w @420ai/desktop`: dist/ produced
- Invariants: `Cargo.toml` no diff (no new crate), `capabilities/default.json` no diff (no capability edit), `CONTROL_PROTOCOL_VERSION` still `m11-control-v2`, no stray artifacts.

---

## Issues found & fixed

```
severity: high
file: apps/desktop/src/components/Settings.tsx
line: 87 (helper) / onSave / onUnpair
issue: Success of a void-returning invoke was detected via `run()`'s resolved value, which is always `undefined` for Promise<void> — so the success branch was dead code.
detail: `run<T>(fn): Promise<T | undefined>` returns `await fn()`. For `setServerConfig`/`unpair`
        (both `Promise<void>`), `await fn()` evaluates to `undefined` on SUCCESS — identical to the
        `catch` path's `return undefined`. The guards `if (ok !== undefined)` (onSave) and
        `if (ok !== undefined)` (onUnpair) therefore NEVER executed on success. Concretely: after a
        successful Save the secret inputs were not cleared, the "Saved to the keychain." confirmation
        never showed, and the masked view (presence placeholders) was not re-read; after a successful
        Unpair the panel kept showing "paired" even though the keychain entry was cleared. The
        keychain writes themselves succeeded — only the post-success UI updates were dead.
        Type-valid (so tsc passed) but logically wrong — exactly the class CLAUDE.md flags as
        invisible to tsc+tests.
suggestion: FIXED — added a boolean-returning `runOk(fn): Promise<boolean>` for void invokes
            (true on success, false on rejection, surfacing the error either way), and switched
            `onSave`/`onUnpair` to it. `run()` is retained only for the value-returning
            `getServerConfig()` re-read. Re-typechecked + rebuilt clean.
```

---

## Observations (LOW — not changed; documented tradeoffs)

```
severity: low
file: apps/desktop/src-tauri/src/server.rs
line: start_archive / stop_archive (run_docker)
issue: `docker compose` runs via a blocking std::process::Command::output() inside an async command.
detail: A first-run `up -d` that pulls postgres:17 can block one tokio worker for tens of seconds.
        Tauri's runtime is multi-threaded so it isn't a full freeze, and clicks are sequential in a
        single-window app. This is the plan's explicitly-sanctioned mechanism ("a short
        Command::output() inline is acceptable — mirrors the spike"). If responsiveness during a
        cold image pull ever matters, wrap the docker calls in `tauri::async_runtime::spawn_blocking`.
suggestion: No change — intentional per plan; noted for future polish.
```

```
severity: low
file: apps/desktop/src-tauri/src/server.rs
line: set_server_config (ingestUrl validation)
issue: `reqwest::Url::parse` accepts a schemeless string like "localhost:8420" (parsed as scheme).
detail: Such a value stores fine but fails later at request time as "ingest unreachable", rather than
        being rejected up front. This is not a regression (proxy.rs never validated the URL) and the
        downstream error is clear; the default form value carries a scheme.
suggestion: No change — optional hardening would be to require scheme ∈ {http, https} after parse.
```

```
severity: low
file: apps/desktop/src-tauri/src/server.rs
line: start_ingest
issue: A node process that boots then immediately exits (e.g. DB down, bad ANALYSIS_PROVIDER) is
       reported as "started"; the failure only shows on the next health poll (ingest: false).
detail: By design this slice runs a one-shot managed child with stdout/stderr nulled (secret hygiene)
        and no restart-with-backoff (deferred polish per the plan). Health surfaces the down state.
suggestion: No change — matches the plan's documented one-shot-child decision.
```

## Security review

- Secrets stored only in the Windows Credential Manager (second entry, distinct user), never plaintext.
- `get_server_config` returns a MASKED view (presence booleans only); a dedicated test asserts no
  secret string is reachable even through a `Debug` log path.
- Ingest secrets injected as process env (win over the repo `.env`), never logged; child stdio nulled.
- `get_monitor_snapshot` bearer sourced from keychain (env fallback) and never returned to the webview.
- No SQL/XSS/eval surfaces introduced. No exposed keys.

## Resource-teardown review (CLAUDE.md leak-window discipline)

- `Settings.tsx` adds no `setInterval`/SSE/listeners; the mount effect uses a `disposed` flag and the
  panel is listener-free (Rust `#[command]`s only — correct, no `onControlEvent`).
- The supervised ingest `Child` is held in `ServerState` and killed+reaped on `RunEvent::Exit`
  (`server::shutdown`), and any stale child is killed+reaped before a re-spawn in `start_ingest`.
- `reqwest` clients in the health probe are short-lived and dropped per call.

## Verdict

One real **high**-severity logic bug (dead success-branch on void invokes) found and **fixed**;
re-validated (typecheck + webview build green). Remaining items are low-severity documented tradeoffs
that match the plan's explicit decisions — no further changes warranted.
