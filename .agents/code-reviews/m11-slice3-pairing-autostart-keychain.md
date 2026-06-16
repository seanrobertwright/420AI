# Code Review — M11 Slice 3: GUI Pairing & Autostart + Keychain Secrets

Reviewed: the working-tree changes implementing `.agents/plans/m11-slice3-pairing-autostart-keychain.md`.

**Stats:**

- Files Modified: 6 (`Cargo.lock`, `Cargo.toml`, `lib.rs`, `sidecar.rs`, `App.tsx`, `bridge.ts`)
- Files Added: 4 (`autostart.rs`, `keychain.rs`, `pairing.rs`, `Pairing.tsx`)
- Files Deleted: 0
- New lines: ~664 (179 tracked diff + 485 in new files)
- Deleted lines: 17

---

## Issues

```
severity: high   [FIXED — pairing.rs now falls back to COMPUTERNAME when name is blank; cargo test + clippy clean]
file: apps/desktop/src-tauri/src/pairing.rs
line: 78-86
issue: Empty machine name is sent verbatim → ingest 400, breaking the form's documented default
detail: The pair command uses `name` straight from the webview to build `Machine { name, .. }`.
  The ingest contract (apps/ingest/src/schemas.ts:28) requires `machine.name` with `minLength: 1`,
  so an empty/whitespace name is rejected by Fastify with HTTP 400 *before* the handler runs. The
  Pairing.tsx form defaults `name` to "" and its placeholder ("defaults to this computer's name")
  explicitly invites leaving it blank — so the MOST COMMON path produces "pairing failed: HTTP 400
  Bad Request". The CLI path does not have this bug: cli.ts:349 falls back to `osHostname()` when
  `--name` is absent. The plan also states the intent ("default empty → Rust falls back to
  COMPUTERNAME"), but neither the plan's snippet nor the implementation actually did the fallback.
suggestion: In `pair`, when `name.trim()` is empty, fall back to `COMPUTERNAME` (mirroring the CLI's
  `?? osHostname()`), with a final literal fallback if that env var is unset. Reuse the same value
  the `hostname` field already reads.
```

```
severity: low
file: apps/desktop/src-tauri/src/keychain.rs
line: 47-52
issue: `clear()` is dead code (only the test's `clear_in` is exercised)
detail: The public `clear()` wrapper is unused — it's annotated `#[allow(dead_code)]` and the
  round-trip test calls `clear_in` directly. This is intentional scaffolding for the deferred
  "unpair" button (plan NOTES), so it is acceptable, but it is genuinely unreferenced today.
suggestion: Keep as-is (planned API surface for the next slice's unpair). No action required; noting
  only so the `#[allow(dead_code)]` is not mistaken for an oversight.
```

```
severity: low (informational — not a bug)
file: apps/desktop/src/components/Pairing.tsx
line: 92-100, 102-109
issue: `onPair`/`onToggleAutostart` setState after `await` without a mounted-guard
detail: Unlike the mount effect (which correctly uses a `disposed` flag), the button handlers call
  `setState` after awaiting an invoke with no mount check. In this single-page shell the Pairing
  panel never unmounts, and React 18 no longer warns on setState-after-unmount, so this is not a
  live bug. Flagged only for completeness against the CLAUDE.md leak-window discipline.
suggestion: No change needed given the panel's lifetime. If the panel ever becomes conditionally
  mounted, thread a mounted-ref guard through the handlers.
```

---

## Verified NOT issues (checked, then cleared)

- **Token isolation** — `PairResult { machineId }` and `PairingStatus { paired, machineId }` carry no
  token; the token is stored in the keychain and read back only to build the `configure` stdin JSON.
  The webview never receives it. ✓ (matches the acceptance criterion).
- **serde field-name drift** — `PairRequest`/`PairResponse`/`Machine` field names (`code`, `name`,
  `os`, `hostname`, `machineId` via `rename_all = "camelCase"`) match the wire schema exactly. The
  `skip_serializing_if = "Option::is_none"` on `os`/`hostname` is safe: both are optional (not in the
  schema's `required`) and `os` is always `Some` (`std::env::consts::OS`). ✓
- **reqwest non-2xx handling** — the explicit `is_success()` guard is present (410 for an expired code
  maps to `Err`, not a JSON-parse fall-through). ✓
- **Event pass-through unchanged** — `auto_configure_on_ready` runs AFTER `app.emit`, so the `ready`
  event still reaches the webview before the configure injection; the existing `parse_event_line`
  tests still pass. ✓
- **No leaked long-lived resource** — the Pairing panel adds no `setInterval`/listener/stream; the
  only async are one-shot `invoke`s, so there is no teardown to arm. ✓
- **keyring v3 pin + features** — `version = "3"`, `default-features = false`, `windows-native`. ✓
  (cargo test round-trip hit the real Credential Manager.)

---

## Summary

One **high-severity** functional bug: the GUI pairing form's default (blank machine name) sends an
empty `name`, which ingest rejects with a confusing HTTP 400 instead of pairing with the computer's
name as the UI promises. Fix is a small Rust-side fallback mirroring the CLI. The remaining notes are
informational. All validation gates (cargo test, typecheck:desktop, repo-health --require-db) pass.
