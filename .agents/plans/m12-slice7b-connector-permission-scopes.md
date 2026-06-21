# Feature: M12 Slice 12.7b — Per-connector permission scopes (§8.1)

The following plan should be complete, but it's important that you validate documentation and
codebase patterns and task sanity before you start implementing. Pay special attention to naming of
existing utils/types/models — import from the right files (relative imports end in `.js`; `import type`
for type-only). Conventions live in [`CLAUDE.md`](../../CLAUDE.md) — **read it; this plan links, never
re-pastes**.

> **Sibling slices (M12.7 bundle):** 12.7a (Codex failure classification), **12.7b (this)**, 12.7c
> (connector-catalog-as-data), 12.7d (Cursor/Antigravity gates). Each is an independent plan file.
> **Read the "Coupling with 12.7c" section below before touching the connector contract** — 12.7c owns
> the connector-definition *data shape*; this slice only adds a permission/approval *dimension* to the
> existing in-code contract.

## Feature Description

Add **per-connector permission scopes** (PRD §8.1, deferred since M3): every connector declares the
**capture scope** it requires — which directories / globs / data it reads (§10.3 "required
permissions") — and the user can **review and approve** that scope. Per §10.4, a **capture-surface
change** (a connector's read scope widening vs. what was last approved) requires **fresh user
approval** before that connector resumes capturing. Self-hosted single-user only (no RBAC/multi-user —
that's V2).

The display half already partly exists: the desktop **Connectors** panel renders a "Reads (permission
scope)" column from `ConnectorInfo.watchGlobs` (`apps/desktop/src/components/Connectors.tsx:98,121-130`).
What's missing is (1) a **declarative, human-readable** `requiredPermissions` field (the §10.3 contract
field — distinct from raw globs), and (2) an **approval mechanism** that gates capture when the surface
changes.

## User Story

As a self-hosting operator
I want each connector to declare exactly what it reads and to require my approval when that read scope
changes
So that a connector (or a future catalog update) can never silently widen what local data it captures
without my consent.

## Problem Statement

Connectors capture local files with no declared, reviewable permission scope and no approval gate. PRD
§8.1 lists "per-connector permission scopes" as a collector capability and §10.4 requires "user approval
for capture surface changes," but neither exists: `ConnectorFidelity` has no `requiredPermissions`
field, and the only persisted per-connector state is enable/disable (`connector-config.ts`). A connector
whose watch globs widen (e.g. a custom connector edited to read a new tree, or — once 12.7c lands — a
signed catalog update) takes effect with zero user review.

## Solution Statement

Two additive, pure layers mirroring the **two proven connector patterns** already in the repo:

1. **Declared scope (§10.3):** add `requiredPermissions: string[]` to `ConnectorFidelity`
   (additive contract field); each built-in + the custom-connector factory declares it; mirror it onto
   the `ConnectorInfo` wire shape and render it in the desktop panel.
2. **Approval state (§8.1/§10.4):** a new persistence module `connector-approvals.ts` —
   modelled **1:1 on `connector-config.ts`** (`~/.420ai/connector-approvals.json`, version stamp,
   tolerant load, `0o600` write) — that records, per connector id, the **approved capture-surface
   fingerprint** (a stable hash of its current `watchGlobs(home)` + `requiredPermissions`). At sidecar
   boot, any connector **not yet recorded is auto-seeded as approved** (default-on — a fresh install and
   any brand-new connector keep capturing, exactly as today). A connector whose **current** fingerprint
   ≠ its **recorded** fingerprint is `needs-approval` and is **withheld from capture** (filtered out,
   mirroring `filterConnectors`) until the user approves via a new `connectors.approve` control command.

**Conflict resolution — "default-on capture" vs "capture requires approval" (resolve up front, do NOT
ship both):** **Default-on wins for the initial/known scope; approval gates only a CHANGE.** Rationale:
§10.4 says approval is required for capture surface *changes*, not for initial capture — a self-hosted
user who installed the app implicitly accepted the bundled connectors' documented scopes (shown at
onboarding). Gating *initial* capture would regress the load-bearing default-on property (a fresh
install / an app upgrade would silently freeze all capture pending re-approval). So: **seed-on-first-
sight = approved; gate only when the fingerprint later drifts from the seeded value.**

Rust requires **no change**: the relay forwards commands and events as opaque `serde_json::Value`
(`apps/desktop/src-tauri/src/sidecar.rs:207-214,237-246` — *"Rust does not duplicate the command
union"*). Adding a `ConnectorInfo` field and a `connectors.approve` command is **TS-only**; no
`cargo` build is involved.

## Feature Metadata

**Feature Type**: Enhancement (additive contract field + new persistence module + UI surface)
**Estimated Complexity**: Medium
**Primary Systems Affected**: `packages/shared` (control-protocol types), `apps/collector` (connector
contract, the 4 connectors, new `connector-approvals` module, `serve.ts` wiring), `apps/desktop`
webview (bridge + Connectors panel). **No DB, no ingest/server, no Rust, no migration.**
**Dependencies**: none new (`node:crypto` is built-in).

---

## CONTEXT REFERENCES

### Relevant Codebase Files — READ THESE BEFORE IMPLEMENTING

- `apps/collector/src/connectors/connector.ts` (lines 32-70) — Why: the `Connector` +
  `ConnectorFidelity` contract you extend with `requiredPermissions` (additive). Note `watchGlobs(home)`
  is the existing raw read scope.
- `apps/collector/src/connectors/connector-config.ts` (whole file) — Why: the **exact pattern to
  mirror** for `connector-approvals.ts` — version stamp (`CONNECTOR_CONFIG_VERSION`), tolerant
  `loadConnectorConfig`/`saveConnectorConfig` (absent/corrupt ⇒ safe default, `0o600`, `path` seam), and
  `filterConnectors(registry, cfg)` (the filter you mirror as `filterByApproval`). DEFAULT-ON is
  load-bearing.
- `apps/collector/src/connectors/connector-config.test.ts` (whole file) — Why: the **test harness to
  mirror** for `connector-approvals.test.ts` — `mkdtempSync` temp-path seam, `fakeConnector(id)`,
  default-on assertions. Confirmed present.
- `apps/collector/src/serve.ts` (lines 19-20 `BUILTIN_IDS`; 46-71 `ServeDeps`; 79-93 `mapConnectorInfo`;
  111-130 seam defaults; 162-169 `emitConnectors`; 171-219 `startEngine` filter at 187;
  249-313 `handle` incl. `connectors.list`/`connectors.set` at 270-295) — Why: the wiring seam. You add
  approval seams to `ServeDeps`, extend `mapConnectorInfo`, seed at boot, filter by approval in
  `startEngine`, and add a `connectors.approve` case.
- `apps/collector/src/serve.test.ts` (READ FIRST — exists; not fully reproduced here) — Why: the serve
  state-machine harness (injected streams + a captured-events array + the `connectorRegistry` /
  `loadConnectorConfig` / `saveConnectorConfig` seams). Mirror it for the new approval seams and the
  `connectors.approve` case. The comment at `serve.ts:76-78` notes "a serve test asserts this mapping
  stays 1:1 with `ConnectorFidelity`" — that assertion must be updated to include `requiredPermissions`.
- `packages/shared/src/control-protocol.ts` (lines 31-41 `ControlCommand`; 50-62 `ConnectorInfo`; 71-88
  `ControlEvent` + `CONTROL_PROTOCOL_VERSION`) — Why: the wire schema. Add `requiredPermissions` +
  `approval` to `ConnectorInfo`, add the `connectors.approve` command, bump the version stamp.
- `packages/shared/src/control-protocol.test.ts` (whole file — exists) — Why: it pins
  `CONTROL_PROTOCOL_VERSION` + the wire shape; update it for the bump + new fields.
- `apps/collector/src/connectors/claude-code.ts`, `codex-cli.ts` (fidelity at lines 318-333),
  `gemini-cli.ts` — Why: each built-in's `fidelity` object gets a `requiredPermissions` entry.
- `apps/collector/src/connectors/custom-connector.ts` (lines 299-319 `makeCustomConnector` return) —
  Why: the custom factory's `fidelity` also needs `requiredPermissions` (derive from its `watchGlobs`).
- `apps/desktop/src/lib/bridge.ts` (lines 40-48 `listConnectors`/`setConnector`) — Why: add
  `approveConnector(id)` mirroring `setConnector`.
- `apps/desktop/src/components/Connectors.tsx` (lines 93-149 the table) — Why: render
  `requiredPermissions` + an "Approve" affordance when `approval === "needs-approval"`.
- `apps/desktop/src-tauri/src/sidecar.rs` (lines 207-214 `send_command`; 237-246 `parse_event_line`) —
  Why: **proof the relay is opaque** — confirms NO Rust change is needed for a new command/field.

### New Files to Create

- `apps/collector/src/connectors/connector-approvals.ts` — capture-surface fingerprint + approval
  persistence + filter (mirrors `connector-config.ts`).
- `apps/collector/src/connectors/connector-approvals.test.ts` — unit tests (mirrors
  `connector-config.test.ts`).

### Relevant Documentation — READ BEFORE IMPLEMENTING

- [`docs/PRD.md`](../../docs/PRD.md) §8.1 (per-connector permission scopes), §10.3 (the "required
  permissions" fidelity field), §10.4 ("user approval for capture surface changes"), §25 M12 slice 12.7.
- [`docs/CONTEXT.md`](../../docs/CONTEXT.md) — "Capture Permission" (a user-approved scope), "Capture
  Surface Change" (a connector/catalog change that expands or alters what local data may be captured).
  **Name code after these terms.**

### Patterns to Follow

**Persistence (mirror `connector-config.ts` exactly):** version stamp constant, `loadX(path = DEFAULT)`
returning a safe default on absent/corrupt (never throws), `saveX(cfg, path = DEFAULT)` with
`mkdirSync(dirname(path), {recursive:true})` + `writeFileSync(..., { mode: 0o600 })`, and a pure filter
function. Library file — **never** logs or exits (CLAUDE.md "Logging / process boundaries").

**Default-on (load-bearing):** absent file, unknown id, or an unrecorded connector all resolve to
**approved/enabled** so a fresh install and any future new connector keep capturing.

**Wire mirroring:** `@420ai/shared` is a leaf — it can NOT import `Connector` from `apps/collector`
(`control-protocol.ts:46-48`). `requiredPermissions` is therefore mirrored onto `ConnectorInfo` and
populated in `mapConnectorInfo` (the single conversion point), exactly like the existing fidelity
fields.

---

## IMPLEMENTATION PLAN

### Phase 1: Shared wire schema (`packages/shared`)

Extend `ConnectorInfo` and `ControlCommand`; bump the version stamp; update the pinning test.

### Phase 2: Connector contract + the four connectors (`apps/collector`)

Add `requiredPermissions: string[]` to `ConnectorFidelity`; declare it on each built-in + the custom
factory. (Pure additive — zero behavior change until Phase 3 reads it.)

### Phase 3: Approval module + serve wiring (`apps/collector`)

Create `connector-approvals.ts` (fingerprint + persistence + filter); seed-on-boot in `serve.ts`;
extend `mapConnectorInfo`/`emitConnectors`; filter capture by approval in `startEngine`; add the
`connectors.approve` command.

### Phase 4: Desktop surface (`apps/desktop` webview)

`approveConnector` bridge fn + render permissions/approval in the Connectors panel.

### Phase 5: Tests & validation

Unit tests for the approval module + serve cases; run the gate.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Each task is atomic and independently validatable.

### Task 1 — UPDATE `packages/shared/src/control-protocol.ts`

- **IMPLEMENT**:
  - Add to `ConnectorInfo` (after `watchGlobs`): `requiredPermissions: string[];` and
    `approval: "approved" | "needs-approval";`.
  - Add to the `ControlCommand` union: `| { cmd: "connectors.approve"; id: string }` (Slice 12.7b:
    record the current capture-surface scope as approved).
  - Bump `CONTROL_PROTOCOL_VERSION` from `"m11-control-v2"` to `"m12-control-v3"` (additive wire change
    — the stamp exists to flag wire-shape drift; comment lines 16-21 say to bump it).
- **PATTERN**: the existing `ConnectorInfo` fields + the `connectors.set` command shape
  (control-protocol.ts:40,50-62).
- **GOTCHA**: this is a leaf module — do NOT import from `apps/collector`. Keep it pure types + the
  stamp.
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 2 — UPDATE `packages/shared/src/control-protocol.test.ts`

- **IMPLEMENT**: update the assertion(s) pinning `CONTROL_PROTOCOL_VERSION` to `"m12-control-v3"`; if the
  test constructs a sample `ConnectorInfo`, add `requiredPermissions: []` + `approval: "approved"`; if it
  enumerates command `cmd` values, add `"connectors.approve"`.
- **PATTERN**: existing assertions in this file (read it first).
- **VALIDATE**: `npx vitest run packages/shared/src/control-protocol.test.ts` (pass).

### Task 3 — UPDATE `apps/collector/src/connectors/connector.ts`

- **IMPLEMENT**: add `requiredPermissions: string[];` to `ConnectorFidelity` (after `knownGaps`, before
  the optional `testedVersions?`). Add a doc line: "§10.3 declared capture scope — human-readable
  statements of what this connector reads (reviewed/approved by the user)."
- **GOTCHA**: making it **required** (not optional) forces every connector to declare it (compiler
  catches a missed one) — that's intended. You MUST update all four connectors (Tasks 4-5) in the same
  change or `tsc -b` fails.
- **VALIDATE**: `npm run typecheck` (will fail until Tasks 4-5 land — expected; run after Task 5).

### Task 4 — UPDATE the three built-in connectors' fidelity

- **IMPLEMENT** add `requiredPermissions` to each `fidelity` object:
  - `claude-code.ts`: `["Read Claude Code session transcripts under ~/.claude/projects/**/*.jsonl"]`
  - `codex-cli.ts` (fidelity at lines 321-329): `["Read OpenAI Codex CLI rollout logs under
    ~/.codex/sessions/**/rollout-*.jsonl"]`
  - `gemini-cli.ts`: `["Read Gemini CLI session files under ~/.gemini/tmp/**/chats/session-*.json",
    "Read ~/.gemini/**/.project_root sidecars for project attribution"]` (verify the actual globs in the
    file and word the statements to match what `watchGlobs`/`discoverRoots` truly read).
- **PATTERN**: the surrounding `fidelity` literal (e.g. codex-cli.ts:321-329).
- **GOTCHA**: word each statement to honestly match the connector's real `watchGlobs(home)` — this text
  is what the user reviews.
- **VALIDATE**: `npm run typecheck` after Task 5.

### Task 5 — UPDATE `apps/collector/src/connectors/custom-connector.ts`

- **IMPLEMENT**: in `makeCustomConnector`'s returned `fidelity` (lines 302-315), add
  `requiredPermissions: def.watchGlobs.map((g) => `Read user-configured file/log: ${g}`)`.
- **PATTERN**: the existing `fidelity` literal there; it already derives `knownGaps` from `def`.
- **GOTCHA**: a custom connector's scope is entirely user-defined globs — the statement just echoes them
  so the approval surface-fingerprint changes if the user edits the globs (which is exactly the §10.4
  capture-surface-change trigger).
- **VALIDATE**: `npm run typecheck` (NOW exit 0 — contract + all four impls aligned) and
  `npx vitest run apps/collector/src/connectors/custom-connector.test.ts`.

### Task 6 — CREATE `apps/collector/src/connectors/connector-approvals.ts`

- **IMPLEMENT** (mirror `connector-config.ts` structure):
  - `import { createHash } from "node:crypto";` and the same `node:fs`/`node:path`/`COLLECTOR_HOME`
    imports as `connector-config.ts`; `import type { Connector } from "./connector.js";`.
  - `export const CONNECTOR_APPROVALS_VERSION = "m12-approvals-v1" as const;`
  - `export const CONNECTOR_APPROVALS_PATH = join(COLLECTOR_HOME, "connector-approvals.json");`
  - Types:
    ```ts
    export interface ConnectorApprovals {
      version: string;
      /** Keyed by Connector.id → the approved capture-surface fingerprint. */
      approved: Record<string, { surfaceFingerprint: string }>;
    }
    ```
  - `captureSurfaceFingerprint(c: Connector, home: string): string` — pure:
    ```ts
    const globs = [...c.watchGlobs(home)].sort();
    const perms = [...c.fidelity.requiredPermissions].sort();
    return createHash("sha256")
      .update(JSON.stringify({ globs, perms }))
      .digest("hex");
    ```
    (Sort both so ordering never spuriously flips the fingerprint. Hash, not the raw scope, keeps the
    file compact + comparison trivial.)
  - `loadConnectorApprovals(path = CONNECTOR_APPROVALS_PATH): ConnectorApprovals` — tolerant
    (absent/corrupt ⇒ `{ version, approved: {} }`), exactly like `loadConnectorConfig`.
  - `saveConnectorApprovals(cfg, path = CONNECTOR_APPROVALS_PATH): void` — `mkdirSync` +
    `writeFileSync(..., { mode: 0o600 })`, like `saveConnectorConfig`.
  - `approvalStatus(c, approvals, home): "approved" | "needs-approval"`:
    absent id ⇒ `"approved"` (default-on); recorded fingerprint === current ⇒ `"approved"`;
    recorded ≠ current ⇒ `"needs-approval"`.
  - `seedMissingApprovals(registry, approvals, home): { approvals: ConnectorApprovals; changed: boolean }`
    — return a copy where any connector **absent** from `approved` is recorded with its current
    fingerprint (first-sight trust); `changed` true iff anything was added. (Do NOT overwrite an existing
    mismatched entry — that's the change we want to surface.)
  - `approveConnector(c, approvals, home): ConnectorApprovals` — pure; set
    `approved[c.id] = { surfaceFingerprint: captureSurfaceFingerprint(c, home) }`, return a new object.
  - `filterByApproval(registry, approvals, home): Connector[]` —
    `registry.filter((c) => approvalStatus(c, approvals, home) !== "needs-approval")` (mirror
    `filterConnectors`).
- **PATTERN**: `connector-config.ts` end-to-end (the load/save/filter trio).
- **GOTCHA**: library file — never log/exit. `node:crypto` is built-in (no dependency). Keep every
  function pure + `path`/`home`-injectable for tests.
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 7 — CREATE `apps/collector/src/connectors/connector-approvals.test.ts`

- **IMPLEMENT** (mirror `connector-config.test.ts`): a `fakeConnector(id, globs, perms)` returning a
  minimal `Connector` whose `watchGlobs` + `fidelity.requiredPermissions` are set; `mkdtempSync` temp
  path. Cover:
  - absent file ⇒ default; `approvalStatus` ⇒ `"approved"`; `filterByApproval` keeps the full registry
    (default-on).
  - `seedMissingApprovals` records every connector's current fingerprint; `changed === true`; a second
    seed over the result ⇒ `changed === false`.
  - after seeding, **changing a connector's globs** flips `approvalStatus` to `"needs-approval"` and
    `filterByApproval` drops it.
  - `approveConnector` over the changed connector restores `"approved"` and re-includes it.
  - save → load round-trips; corrupt file ⇒ safe default (never throws).
- **PATTERN**: `connector-config.test.ts` (the `describe`/`it`/temp-path shape).
- **VALIDATE**: `npx vitest run apps/collector/src/connectors/connector-approvals.test.ts` (pass).

### Task 8 — UPDATE `apps/collector/src/serve.ts`

- **IMPLEMENT**:
  - Imports: `loadConnectorApprovals`, `saveConnectorApprovals`, `seedMissingApprovals`,
    `approvalStatus`, `approveConnector`, `filterByApproval`, `captureSurfaceFingerprint`,
    `type ConnectorApprovals` from `./connectors/connector-approvals.js`.
  - `ServeDeps`: add seams `loadConnectorApprovals?: () => ConnectorApprovals;` and
    `saveConnectorApprovals?: (cfg: ConnectorApprovals) => void;` (mirror the connector-config seams at
    lines 65-68). Resolve defaults next to `loadConnectorCfg`/`saveConnectorCfg` (lines 129-130).
  - **Seed at boot:** inside `runServe`, after the registry is resolved (after line 128) and before the
    first `emit`, run `seedMissingApprovals(connectorRegistry, loadApprovals(), home)` and, if
    `changed`, `saveApprovals(...)`. (First-sight trust — establishes the baseline so a later drift is
    detectable.) Keep it synchronous (no await) to respect the leak-window rule.
  - `mapConnectorInfo(c, enabled, home, approval)`: add a param `approval: "approved" | "needs-approval"`
    and set `requiredPermissions: c.fidelity.requiredPermissions` + `approval` on the returned object.
  - `emitConnectors`: load approvals once; for each connector compute
    `approvalStatus(c, approvals, home)` and pass it into `mapConnectorInfo`.
  - `startEngine` (line 187): change the filter to
    `filterByApproval(filterConnectors(connectorRegistry, loadConnectorCfg()), loadApprovals(), home)` so
    a `needs-approval` connector is withheld from capture. (Both filters compose; default-on preserved.)
  - Add a `case "connectors.approve":` in `handle` (mirror `connectors.set`, lines 273-295): validate
    `typeof c.id === "string"` (defense-in-depth at the stdin boundary); find the connector in
    `connectorRegistry` by id (unknown id ⇒ `{type:"error", message:"unknown connector id", cmd}`);
    `const next = approveConnector(found, loadApprovals(), home); saveApprovals(next);` then
    `emit({type:"ack", cmd})` + `emitConnectors()`.
- **PATTERN**: `connectors.set` handler (serve.ts:273-295) and the existing seam-default wiring.
- **GOTCHA**: stdout is protocol-only — never `console.log`. Re-read approvals inside `startEngine`
  (like enablement is re-read) so an approval granted mid-session takes effect on the next start.
- **VALIDATE**: `npm run typecheck` (exit 0).

### Task 9 — UPDATE `apps/collector/src/serve.test.ts`

- **IMPLEMENT**: read the file first. Then:
  - update the existing `mapConnectorInfo`/`connectors` assertion to expect `requiredPermissions` (1:1
    with the connector's `fidelity.requiredPermissions`) + `approval: "approved"` on a freshly-seeded
    registry.
  - add a test: send `{cmd:"connectors.approve", id}` → expect an `ack` + a re-emitted `connectors`
    event; assert `saveConnectorApprovals` seam was called.
  - add a test: a connector whose current fingerprint differs from a pre-seeded approvals blob is
    reported `approval:"needs-approval"` and is **absent** from the filtered registry handed to the fake
    engine (assert via the injected `runEngine` capturing its `connectors` option).
- **PATTERN**: the existing serve harness (injected streams + captured events + the `connectorRegistry`/
  `loadConnectorConfig`/`saveConnectorConfig` seams). Pass the two new approval seams the same way.
- **VALIDATE**: `npx vitest run apps/collector/src/serve.test.ts` (pass).

### Task 10 — UPDATE `apps/desktop/src/lib/bridge.ts`

- **IMPLEMENT**: add, after `setConnector` (line 48):
  ```ts
  /** Approve a connector's CURRENT capture surface (records its scope fingerprint as approved). */
  export function approveConnector(id: string): Promise<void> {
    return sendCommand({ cmd: "connectors.approve", id });
  }
  ```
- **PATTERN**: `setConnector` (bridge.ts:46-48).
- **VALIDATE**: `npm run typecheck:desktop` (exit 0).

### Task 11 — UPDATE `apps/desktop/src/components/Connectors.tsx`

- **IMPLEMENT**:
  - import `approveConnector` alongside `listConnectors, setConnector, onControlEvent`.
  - in the "Reads (permission scope)" cell (or a new cell), render `c.requiredPermissions` as a list
    (do NOT truncate — the user reviews the real scope), beneath/alongside the existing `watchGlobs`.
  - when `c.approval === "needs-approval"`, render a warning `Badge variant="outline"` ("needs review")
    and an **Approve** button (style like the existing toggle button) whose `onClick` calls
    `approveConnector(c.id).catch((err) => setError(String(err)))`. When `approval === "approved"`, show
    nothing extra.
- **PATTERN**: the existing `toggle` handler (lines 31-34) and the watchGlobs cell (121-130).
- **GOTCHA**: the `connectors` event re-emits after approve (serve `emitConnectors()`), so the panel
  refreshes via the existing `onControlEvent` listener — no manual refetch needed.
- **VALIDATE**: `npm run typecheck:desktop` (exit 0).

---

## TESTING STRATEGY

### Unit Tests

- `connector-approvals.test.ts` (new) — default-on, seed/idempotent-seed, change-detection, approve,
  filter, round-trip, corrupt-file tolerance (mirrors `connector-config.test.ts`).
- `serve.test.ts` (updated) — `mapConnectorInfo` includes `requiredPermissions` + `approval`;
  `connectors.approve` persists + re-emits; a drifted connector is `needs-approval` AND withheld from the
  engine's filtered registry.
- `custom-connector.test.ts` (existing) — still green after `requiredPermissions` is added to the
  factory.
- `control-protocol.test.ts` (updated) — version stamp + new fields/command.

### Edge Cases

- Absent approvals file ⇒ everything approved + captures (default-on).
- Brand-new connector appears (unknown id) ⇒ auto-seeded approved on next boot (no freeze).
- A custom connector's globs edited ⇒ fingerprint drifts ⇒ `needs-approval` ⇒ withheld until approve.
- `connectors.approve` for an unknown id ⇒ clean `error` event, no throw, capture unaffected.
- Corrupt `connector-approvals.json` ⇒ safe default (never crashes capture).
- Re-approve is idempotent (same fingerprint persisted).

---

## VALIDATION COMMANDS

Run from the repo root. Each is a GATE.

### Level 1 — Syntax / types / style
- `npm run typecheck` → **exit 0** (root `tsc -b`: shared + collector). The repo-root build is the gate;
  per-workspace build is NOT a substitute.
- `npm run typecheck:desktop` → **exit 0** (the desktop webview is out of the root graph — this is its
  enforced lane; mirrors the dashboard's lane).
- `npm run lint` → **exit 0**.

### Level 2 — Unit tests
- `npm test` → all pass (new + updated suites included; integration self-skips with no DB — expected).

### Level 3 — Integration / full gate
- `npm run repo-health` → **PASS** (root typecheck + full vitest + NUL/stray scans + `typecheck:dashboard`).
- **No `--require-db` needed for this slice** — it touches **no** `@420ai/db` / `apps/ingest` code and
  adds no `*.int.test.ts`. State this explicitly in the execution report (don't claim a DB layer ran
  that wasn't touched).

### Level 4 — Manual validation (headless, no Tauri build)
Drive the sidecar protocol over stdin (the desktop relay just forwards these lines):
```bash
# From repo root. Each line is one control command; observe the `connectors` event JSON.
printf '%s\n' '{"cmd":"connectors.list"}' '{"cmd":"stop"}' | npx tsx apps/collector/src/serve.ts serve
```
- Expect a `connectors` event whose entries carry `requiredPermissions: [...]` and
  `approval: "approved"` (fresh machine — auto-seeded).
- To exercise the gate: hand-edit `~/.420ai/connector-approvals.json` to a bogus `surfaceFingerprint`
  for one id, re-run `connectors.list` → that connector reports `approval:"needs-approval"`; send
  `{"cmd":"connectors.approve","id":"<that-id>"}` then `connectors.list` again → back to `"approved"`.

### Level 5 — Optional (full desktop build)
- `npm run build:desktop` (heavy: SEA + Vite + `cargo tauri build`) only if you changed Rust — **you
  did not**, so this is optional smoke. `npm run typecheck:desktop` is the required webview gate.

---

## ACCEPTANCE CRITERIA

- [ ] `ConnectorFidelity.requiredPermissions` exists; all four connectors (3 built-in + custom factory)
      declare honest scope statements.
- [ ] `ConnectorInfo` carries `requiredPermissions` + `approval`; `mapConnectorInfo` populates both;
      `CONTROL_PROTOCOL_VERSION === "m12-control-v3"`.
- [ ] `connector-approvals.ts` persists to `~/.420ai/connector-approvals.json` (`0o600`, tolerant,
      version-stamped); fingerprint = sorted globs + perms (sha256).
- [ ] Default-on preserved: a fresh machine captures every connector with no approval file (seeded
      approved at boot).
- [ ] A drifted capture surface ⇒ `needs-approval` ⇒ **withheld from capture** until
      `connectors.approve`; approve restores capture.
- [ ] Desktop Connectors panel shows `requiredPermissions` and an Approve affordance only when
      `needs-approval`.
- [ ] `npm run typecheck`, `npm run typecheck:desktop`, `npm run lint`, `npm test`, `npm run repo-health`
      all pass; **no** Rust/cargo change, **no** migration, **no** ingest/DB change.

---

## COMPLETION CHECKLIST

- [ ] All tasks completed in order; each task's VALIDATE ran green.
- [ ] Full gate (`npm run repo-health`) passes; `typecheck:desktop` passes.
- [ ] Manual Level-4 walkthrough confirms seed → drift → needs-approval → approve.
- [ ] No regression: existing connector enable/disable + capture still work (default-on intact).

---

## NOTES

**Spikes actually run during planning (evidence backing the confidence score):**
- **Read `control-protocol.ts`** — confirmed `ConnectorInfo` (no `requiredPermissions`/`approval` today;
  already carries `watchGlobs`) and `ControlCommand` union shapes + `CONTROL_PROTOCOL_VERSION =
  "m11-control-v2"`.
- **Read `serve.ts`** — verified `mapConnectorInfo(c, enabled, home)` signature (the single conversion
  point, lines 79-93), `emitConnectors` (162-169), the `startEngine` filter via
  `filterConnectors(connectorRegistry, loadConnectorCfg())` (line 187), and the `connectors.set`/`.list`
  handlers (270-295) + the `ServeDeps` seam pattern (63-71) — the exact shapes the new approval wiring
  mirrors.
- **Read `connector-config.ts` + `connector-config.test.ts`** — confirmed the persistence + filter +
  test-harness pattern (`mkdtempSync` seam, `fakeConnector`, default-on) the new module/test mirror 1:1.
- **Read `apps/desktop/src-tauri/src/sidecar.rs` + `proxy.rs`** — **verified the Rust relay is opaque**
  (`send_command(cmd: Value)`, `parse_event_line` passes any JSON object through; *"Rust does not
  duplicate the command union"*). ⇒ **No Rust/cargo change** for a new command or `ConnectorInfo` field.
  This is the single biggest blast-radius reducer.
- **Read `apps/desktop/src/components/Connectors.tsx` + `bridge.ts`** — confirmed the panel already
  renders a "Reads (permission scope)" column from `watchGlobs` and the `setConnector` bridge shape the
  new `approveConnector` mirrors.
- **Read root `package.json`** — confirmed exact gate script names: `typecheck` (`tsc -b`),
  `typecheck:desktop`, `lint`, `test`, `repo-health`.

**Design decisions / trade-offs:**
- **Fingerprint over storing raw scope:** a sha256 of sorted (globs + perms) keeps the approvals file
  tiny and comparison O(1); the user-facing scope text still lives on the connector/`ConnectorInfo`.
- **Seed-on-first-sight = the default-on mechanism.** Without it, a never-seeded connector could never
  have a "previous" scope to diff against, so §10.4 change-detection would be inert. Seeding at boot is
  what makes "approval for *changes*" work without gating initial capture.
- **Withhold (not just flag) on `needs-approval`:** §10.4 requires approval for a capture-surface change
  to *take effect* — flag-only would let the widened scope capture anyway. Withholding via
  `filterByApproval` (mirroring `filterConnectors`) is the faithful reading, and it composes cleanly
  with enable/disable.

**Coupling with 12.7c (connector-catalog-as-data) — recommended order: 12.7b FIRST.**
12.7c makes connector *definitions/locations* catalog-driven (a signed data catalog, reusing the M10
ed25519 primitive). This slice (12.7b) adds the **permission/approval dimension to the existing in-code
connector contract** and does **not** need the catalog table — so it ships smaller and independently.
The two meet at exactly one point, which 12.7c must honor:
- `requiredPermissions` becomes a **field carried in each catalog connector row** (12.7c), populated into
  the same `ConnectorFidelity.requiredPermissions` this slice defines — so 12.7b sets the field's shape
  and 12.7c sources it from data.
- `captureSurfaceFingerprint` must include any **catalog-sourced** globs/scope, so that **a signed
  catalog update widening a connector's scope flips it to `needs-approval`** — which is precisely §10.4
  "user approval for capture surface changes." 12.7c should reuse `captureSurfaceFingerprint` /
  `approvalStatus` unchanged and just feed catalog-derived connectors through them.
Do **not** redesign the connector-as-data model here. If 12.7c is executed first instead, this slice
still applies — `requiredPermissions` simply lands on whatever the catalog produces; the approval module
is independent of the connector's source (in-code vs catalog).

**Out of scope (deferred):** RBAC/multi-user permissions (V2); a structured machine-enforced permission
engine (V1 is declarative review + a surface-fingerprint gate); per-path OS-level sandboxing; surfacing
approvals in the web dashboard (this slice surfaces them in the desktop panel, where connector mgmt
already lives).
