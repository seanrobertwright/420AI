# Feature: Custom File/Log Connector (V1 close-out Slice 2 — PRD §10 "config-only custom connectors")

The following plan should be complete, but it is important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to the naming of existing
utils, types, and models — import from the right files (`.js` specifiers, `import type`).

> **Conventions are NOT re-pasted here.** [`CLAUDE.md`](../../CLAUDE.md) (repo root) is the source of
> truth for module/TS/naming rules, the library-no-logging boundary, the testing layers, the validation
> GATE, and the Drizzle/DB gotchas. Read it first. This plan links to it rather than duplicating it — do
> not let a snippet here drift from `CLAUDE.md`.

> **Scope note — this is the SECOND of the V1 close-out slices.** Slice 1 was
> [git outcomes & attribution](./m10-slice1-git-outcomes-attribution.md). The other M10 "MVP hardening"
> bundle items (exports §22, catalog signing §10.4/§18, replay metadata §23, persisted alert engine)
> are **out of scope here** and get their own plans. This slice ships **one** thing: a user-defined,
> **config-only** connector that captures a generic file/log source and maps it into the existing
> normalized event model.

---

## Feature Description

Let a self-hosting user point the collector at **any** append-only file or log that a built-in connector
(`claude-code`/`codex-cli`/`gemini-cli`) does not already cover — another AI CLI's JSONL transcript, a
wrapper script's structured log, an MCP server's audit log — and **map its fields onto the app's
normalized events** without writing or running any code. The user declares the connector as **data** in
`~/.420ai/custom-connectors.json`; a fixed factory compiles each declaration into the existing
`Connector` shape and the existing M3/M4 capture core (watcher → queue → sync) picks it up unchanged.

This is the **"Generic file/log watcher | user-configured | any | per config | custom mapping"** row of
the PRD connector table (PRD §10, line 199) and the **"config-only custom connectors"** in-scope item
(PRD §68, §98, §264). The domain term is **Custom Connector** (`docs/CONTEXT.md` §327): *"A user-defined
Connector that captures data from configured files, folders, logs, or structured sources and maps that
data into the app's normalized event model."*

## User Story

```
As a self-hosting developer using an AI tool the app has no built-in connector for
I want to declare a connector in a JSON config that maps that tool's log/JSONL fields onto normalized events
So that its sessions, tokens, and tool calls show up in my archive and reports — without waiting for a built-in
```

## Problem Statement

The connector registry is a **hard-coded array** of three built-ins (`connectors` in
`apps/collector/src/connectors/connector.ts`). Any source not on that list is invisible to the archive.
The PRD promises a **config-only custom connector** for exactly this gap, and the M11 desktop UI already
renders the registry (`connectors.list` over the control protocol) — but there is **no path to add a
source by configuration**. The connector contract, the watcher, the durable queue, the sync worker, and
the enable/disable seam (`filterConnectors`) are all already source-agnostic; the only missing piece is
**a factory that turns a declared mapping into a `Connector`** and a place to load those declarations
from.

## Solution Statement

Add a **config-driven connector factory** that mirrors three proven precedents rather than inventing
machinery:

1. **Tolerant config loader** (`loadCustomConnectors`) at `~/.420ai/custom-connectors.json` — modeled
   **exactly** on `connector-config.ts` / `identity.ts`: absent or corrupt file ⇒ a safe default
   (no custom connectors, never a throw), a `path` testability seam, a `mode:0o600` write, no logging,
   no `process.exit`. An **invalid or id-colliding declaration is skipped**, not fatal (default-on
   capture for the rest of the registry is load-bearing — a fresh install with no file behaves exactly
   as today).
2. **A pure factory** (`makeCustomConnector(def)`) that returns the **same `Connector` shape** every
   built-in implements (`apps/collector/src/connectors/connector.ts:45-70`). It owns a `parse(text)`
   that splits the grown prefix into lines and maps each line onto a `NormalizedEvent` via either a
   **JSONL dot-path** mapping or a **named-capture regex** mapping. Tolerant parsing (`skippedLines`)
   exactly like `parseClaudeCodeSession`. Capture is **`captureMode:"tail"`** (append-only logs) reusing
   the unchanged byte-offset tailer.
3. **Closed `EventType`, zero server change.** A declaration maps onto the **existing** `EventType`
   union (`packages/shared/src/events.ts:26-39`) and the existing `NormalizedTokens` shape — so there is
   **no new event type, no fingerprint change, no new table, no migration, and no `apps/ingest` change**.
   Events flow through the existing `/v1/ingest` path. This deliberately mirrors **M11 Slice 2**
   (`connector-config.ts`), which added a whole connector-management feature with **zero** server/schema
   change by living entirely in the registry-injection seam.

The custom connectors are **merged into the registry at the entrypoints** (`runWatch`, `runDiscover`,
`runServe`) via a single `loadRegistry(home)` helper — so `filterConnectors`, `connectors.list` /
`connectors.set` (enable/disable), the watcher, and sync all work **for free** with no change to the
M3/M4 capture core.

## Feature Metadata

**Feature Type**: New Capability
**Estimated Complexity**: **Medium** (one new pure factory + one tolerant loader + a registry-merge
helper + entrypoint wiring + one additive optional wire field; no DB, no migration, no server route)
**Primary Systems Affected**: `apps/collector` (new `custom-connector.ts` factory/loader + `registry.ts`
merge + `cli.ts`/`serve.ts` wiring), `packages/shared` (one **additive optional** `custom?` field on the
existing `ConnectorInfo` wire type — control protocol only)
**Dependencies**: **None new.** `node:fs`/`node:fs/promises` (glob, already used by the watcher),
`node:path` — all built-in. Do NOT add a JSON-schema/validation library; hand-validate tolerantly like
`loadConnectorConfig`.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**The connector contract + registry (the shape you must produce, and where it plugs in)**
- `apps/collector/src/connectors/connector.ts` (whole, 78 lines) — **THE contract**. `Connector`,
  `ParseResult`, `ConnectorFidelity`, `Liveness`, and the hard-coded `connectors[]` registry. Your
  factory returns this exact `Connector` shape; `captureMode:"tail"` is the default. **Do not change the
  interface** — custom connectors satisfy it as-is.
- `apps/collector/src/connectors/claude-code.ts` (whole, 379 lines) — **the canonical parser to mirror**:
  tolerant line-by-line JSON parse (`try/catch` → `skippedLines`, never throw, lines 110-131), the
  `makeEvent` fingerprint helper (lines 152-172) using `eventFingerprint(connector, rawId, index, type)`,
  the raw-record-per-line pattern (lines 122-129), and `mapTokens` onto `NormalizedTokens` (lines 76-88,
  with `zeroTokens()`/`computeTotal()`). Your JSONL format follows this almost verbatim, but reads field
  *paths from config* instead of hard-coded keys.
- `apps/collector/src/connectors/connector-config.ts` (whole, 73 lines) — **THE precedent for tolerant
  config + registry injection** (M11 Slice 2). Copy its discipline beat-for-beat: `CONFIG_VERSION` stamp,
  `CONFIG_PATH = join(COLLECTOR_HOME, ...)`, `load*(path = DEFAULT)` returns a safe default on
  absent/corrupt, `save*` does `mkdirSync` + `writeFileSync(..., { mode: 0o600 })`, and a pure filter/merge
  helper. `filterConnectors` (lines 70-72) already enable/disables **by id** — custom connectors get
  enable/disable for free once they're in the registry.
- `apps/collector/src/connectors/connector-config.test.ts` (whole, 86 lines) — **the test style to
  mirror**: a `mkdtempSync` path seam (never touch real `~/.420ai`), and the "default-on / tolerant /
  unknown-id" property assertions. Your `custom-connector.test.ts` mirrors this exactly.
- `apps/collector/src/connectors/gemini-cli.ts:248-272` — the second `Connector` literal example; note
  `captureMode:"snapshot"` and honest `fidelity.knownGaps`. You will write honest `knownGaps` too
  (no tokens unless mapped; discoverRoots deferred).

**Capture core (DO NOT CHANGE — you only inject into its existing seams)**
- `apps/collector/src/capture-engine.ts` (whole, 98 lines) — `runCaptureEngine` already accepts an
  optional `connectors` array (line 24, 36) and feeds it to the watcher. Your merged registry rides this
  **existing** seam. `onChange` (lines 41-49) calls `connector.parse(text)` then enqueues raw + events —
  unchanged.
- `apps/collector/src/watcher/file-watcher.ts` (whole, 113 lines) — the poll watcher. `discover()`
  (lines 37-54) globs `connector.watchGlobs(home)` and the tail path (lines 78-87) reads the byte-offset
  grown prefix → `onChange`. **A custom connector's `watchGlobs` returns its configured absolute paths
  (it ignores `home`)** — confirm in the spike that an absolute glob OUTSIDE `home` matches here.
- `apps/collector/src/discovery/discover-engine.ts` (whole, 56 lines) — `discoverWorkspaces` skips any
  connector without `discoverRoots` (line 29). Custom connectors omit `discoverRoots` in V1 (deferred —
  see D7), so they are safely skipped by discovery with no special-casing.

**Shared types (events + tokens + control protocol)**
- `packages/shared/src/events.ts` (whole, 73 lines) — **the closed `EventType` union (lines 26-39)** your
  mapping validates against, plus `NormalizedEvent` (57-72) and `RawSourceRecord` (45-51). **Do NOT add a
  new event type** (the header comment explains why the git taxonomy was kept out — same reasoning: no
  `NormalizedEvent` consumer, no server change). Custom defs map onto existing values.
- `packages/shared/src/tokens.ts` (whole, 48 lines) — `NormalizedTokens`, `zeroTokens()`, `computeTotal()`.
  A custom JSONL def may map token sub-fields; reuse these helpers, never hand-roll the total.
- `packages/shared/src/fingerprint.ts` (whole) — DO NOT touch. Read only to confirm
  `eventFingerprint(sourceConnector, rawRecordId, eventIndex, eventType)` is deterministic and
  connector-id-agnostic (a custom `sourceConnector` string feeds it cleanly; idempotent ingest still
  holds).
- `packages/shared/src/control-protocol.ts:44-90` — `ConnectorInfo` (50-72) + the `ControlEvent`
  `connectors` variant (82). You add **one additive optional** field `custom?: boolean` to `ConnectorInfo`
  so the desktop UI can distinguish user-defined connectors. Optional ⇒ backward-compatible; the protocol
  version `CONTROL_PROTOCOL_VERSION` ("m11-control-v2") does **not** bump (additive-optional, per the M11
  "unchanged through slices" discipline). Update the mapping test that pins `ConnectorInfo` (below).
- `apps/collector/src/serve.ts:75-87` (`mapConnectorInfo`) — **the single `Connector → ConnectorInfo`
  conversion point**. Set `custom: <is this a custom connector?>` here. Lines 116, 150-157, 175-182 show
  the registry being mapped and filtered — switch the default `connectorRegistry` from `defaultConnectors`
  to `loadRegistry(home)` (D5).

**Entrypoints (where the merge happens — these own argv/stdio, they may log/exit)**
- `apps/collector/src/cli.ts:146-170` (`runWatch`) + `:220-232` (`runDiscover`) — `runWatch` currently
  calls `runCaptureEngine` with **no** `connectors` (so it uses the builtins-only default); `runDiscover`
  passes the raw `connectors` import to `discoverWorkspaces`. Both must instead pass `loadRegistry(home)`.
  Read `:1-40` for the import block and `:275-352` for the command-dispatch + how `discover`/`usage`
  one-shot commands are wired — **mirror that exactly** to add a `custom` inspection command (D9).
- `apps/collector/src/identity.ts` — `COLLECTOR_HOME` + `loadCredentials`/`saveCredentials` (the tolerant
  read + `mode:0o600` write pattern `connector-config.ts` already copies). Your loader imports
  `COLLECTOR_HOME` from here.

### New Files to Create

- `apps/collector/src/connectors/custom-connector.ts` — the `CustomConnectorDef` type, the tolerant
  `loadCustomConnectors(path?)` + `saveCustomConnectors(defs, path?)`, the `makeCustomConnector(def)`
  factory (with its tail `parse`), and `validateCustomDef(raw)` returning `{ ok: def } | { error: string }`.
- `apps/collector/src/connectors/custom-connector.test.ts` — unit tests (parse JSONL-by-path, parse
  line-regex, tolerant skip, validation rejects bad regex / empty globs / unknown eventType / colliding id,
  loader returns `[]` on absent/corrupt file, save→load round-trip).
- `apps/collector/src/connectors/registry.ts` — `loadRegistry(home, opts?)`: returns
  `[...defaultConnectors, ...validatedCustomConnectors]`, dropping any custom def whose id collides with a
  built-in or another custom def, and returning the dropped-def reasons (for the CLI/`log` to surface).
- `apps/collector/src/connectors/registry.test.ts` — merge keeps builtins, appends valid custom, drops
  colliding ids, and surfaces drop reasons.
- `docs/guide/custom-connectors.md` — user-facing reference: the `custom-connectors.json` schema, the two
  formats (`jsonl` dot-path, `regex` named-capture), the closed list of mappable `eventType`s, a worked
  example, and the honest-fidelity / no-token-by-default note. Link it from `docs/guide` index if one exists.

### Relevant Documentation — READ BEFORE IMPLEMENTING

- [`docs/PRD.md`](../../docs/PRD.md) — §10 (connector catalog + the §199 generic-watcher table row),
  §10.1.1 (liveness vocabulary), §10.3 (fidelity labels / honest token+cost confidence), §68/§98/§264
  (config-only custom connectors **in scope**), and **§39 + §217** (script/plugin-based custom connector
  runtime is a **NON-GOAL** — your factory executes **no user code**, it interprets declarative data only).
- [`docs/CONTEXT.md`](../../docs/CONTEXT.md) — §327 "Custom Connector", §323 "Experimental Connector"
  (custom connectors are `status:"experimental"` — name and label them as that term), §203 "Connector
  Fidelity", §149 "Raw Source Record".
- Node 24 [`fs.promises.glob`](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisesglobpattern-options)
  — Why: custom `watchGlobs` return arbitrary absolute patterns; confirm absolute-outside-home matching in
  the spike. (Already used by `file-watcher.ts` + `claude-code.ts`.)
- MDN [named capture groups](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions/Groups_and_backreferences#groups_and_ranges)
  — Why: the `regex` format extracts fields from `match.groups`. Confirm `new RegExp(pattern).exec(line).groups`
  in Node 24 (spike).

### Patterns to Follow

> **Spike-snippet fidelity:** the `parse`/loader snippets below encode behavior the PRE-FLIGHT spike
> proves. Keep them in sync with the spike's assertions; the assertions are stated next to each.

**Tolerant config loader (mirror `connector-config.ts` exactly):**
```ts
// custom-connector.ts — DEFAULT = no custom connectors; absent/corrupt ⇒ safe default, never throws.
export const CUSTOM_CONNECTOR_CONFIG_VERSION = "m10-custom-v1" as const;
export const CUSTOM_CONNECTOR_CONFIG_PATH = join(COLLECTOR_HOME, "custom-connectors.json");

export function loadCustomConnectors(path = CUSTOM_CONNECTOR_CONFIG_PATH): CustomConnectorDef[] {
  if (!existsSync(path)) return [];                       // fresh install behaves exactly as today
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { connectors?: unknown[] };
    return Array.isArray(parsed.connectors) ? (parsed.connectors as CustomConnectorDef[]) : [];
  } catch {
    return [];                                            // corrupt ⇒ ignore, do NOT crash capture
  }
}
// Spike assertion: an absent path and a `"{ not json"` path both return [] (no throw).
```

**Closed-set validation (hand-rolled, no schema lib) — mirror the `EventType` union as a runtime set:**
```ts
// The ONLY mappable event types — keep this array byte-identical to events.ts EventType (a test pins it).
export const MAPPABLE_EVENT_TYPES = [
  "session.started","session.ended","message.user","message.assistant",
  "tool.call.started","tool.call.completed","tool.call.failed",
  "file.read","file.modified","file.referenced","context.loaded",
  "usage.reported","cost.estimated",
] as const satisfies readonly EventType[];

function validateCustomDef(raw: unknown): { ok: CustomConnectorDef } | { error: string } {
  // checks (return a human reason on the first failure):
  //  - id is a non-empty string, not colliding with a built-in id (caller also cross-checks duplicates)
  //  - watchGlobs is a non-empty string[]
  //  - format is "jsonl" | "regex"
  //  - format==="regex": `new RegExp(def.pattern)` compiles (try/catch) AND names a `ts` group
  //  - eventType (constant) OR eventTypeField maps into MAPPABLE_EVENT_TYPES
}
// Spike assertion: a bad regex ("(", unterminated) is REJECTED with an error, never thrown at capture time.
```

**The factory's tail `parse` (mirror `parseClaudeCodeSession`'s tolerance + `makeEvent`/fingerprint):**
```ts
export function makeCustomConnector(def: CustomConnectorDef): Connector {
  const parse = (fileText: string): ParseResult => {
    const ingestedAt = new Date().toISOString();
    const rawRecords: RawSourceRecord[] = [];
    const events: NormalizedEvent[] = [];
    let skippedLines = 0;
    fileText.split(/\r?\n/).forEach((line, i) => {
      if (line.trim() === "") return;
      const fields = def.format === "jsonl" ? extractByPath(line, def) : extractByRegex(line, def);
      if (!fields) { skippedLines += 1; return; }           // tolerant: unmatched/unparseable line
      const rawId = fields.rawId ?? `${fields.sessionId}:${i}`;
      rawRecords.push({ id: rawId, sourceConnector: def.id, sessionId: fields.sessionId,
                        ingestedAt, payload: line });
      events.push({
        fingerprint: eventFingerprint(def.id, rawId, 0, fields.eventType),
        sourceConnector: def.id, parserVersion: CUSTOM_CONNECTOR_CONFIG_VERSION,
        rawRecordId: rawId, eventIndex: 0, eventType: fields.eventType,
        sessionId: fields.sessionId, projectPath: fields.projectPath, model: fields.model,
        ts: fields.ts ?? ingestedAt, tokens: fields.tokens, // tokens only if mapped (else undefined)
      });
    });
    return { rawRecords, events, skippedLines };
  };
  return {
    id: def.id, captureMode: "tail",
    fidelity: {
      status: "experimental", captureMethod: `custom-tail-${def.format}`,
      liveness: "streaming",
      tokens: def.tokenMap ? "estimated" : "none", cost: "none",
      knownGaps: [
        "user-defined mapping — fidelity is only as good as the configured field paths",
        "discoverRoots not implemented; project attribution relies on a mapped projectPath field only",
        ...(def.tokenMap ? [] : ["no token/cost capture — this source maps no usage fields"]),
      ],
    },
    watchGlobs: () => def.watchGlobs,                       // absolute paths; `home` is intentionally ignored
    parse,
  };
}
// Spike assertion: a custom connector appended to the registry captures a temp log end-to-end
// (watcher → queue: ≥1 raw + ≥1 event), proving the absolute-glob + tail path works outside `home`.
```

> **No DB / no SQL in this slice.** This feature touches **neither `@420ai/db` nor `apps/ingest`** — it
> produces `NormalizedEvent`s that flow through the *existing* ingest client/API. Therefore the
> Drizzle/aggregate gotchas in `CLAUDE.md` (ISO-normalize `max/min(ts)`, `Number()` a `numeric`,
> `sql.raw` for closed-set keywords) **do not apply** and **no `--require-db` int layer is added**. State
> this explicitly so a reviewer doesn't expect a migration.

---

## DESIGN DECISIONS

- **D1 — Config-only, no scripting (PRD §39/§217 non-goal).** A custom connector is **declarative data**
  compiled by a **fixed** factory. The factory executes none of the user's code — it interprets dot-paths
  and a `RegExp`. This is the line between the in-scope "config-only custom connector" and the out-of-scope
  "script/plugin-based custom connector runtime."
- **D2 — Tail mode, two formats: `jsonl` (dot-path) and `regex` (named-capture).** Generic logs are
  append-only ⇒ reuse the proven byte-offset tailer (`captureMode:"tail"`). `jsonl` = `JSON.parse(line)`
  then read configured dot-paths; `regex` = `new RegExp(pattern).exec(line).groups`. **Whole-file JSON
  (`snapshot`) is DEFERRED** (a known gap) — every built-in generic case is line-oriented.
- **D3 — Closed `EventType`, zero server change.** Defs map onto the existing union; **no new event type,
  no fingerprint change, no migration, no `apps/ingest` change.** Directly mirrors M11-S2
  (`connector-config.ts`), which shipped connector management with zero server/schema change by living in
  the registry seam. The `events.ts` header comment already established this discipline for git outcomes.
- **D4 — Tolerant everything (default-on safety).** Absent/corrupt file ⇒ `[]`. An invalid or
  id-colliding def ⇒ **dropped with a surfaced reason**, the rest of the registry still captures. A bad
  line ⇒ `skippedLines`, never a throw. This preserves the load-bearing property from `connector-config`:
  a misconfiguration never takes down capture of the built-in connectors.
- **D5 — Single merge point: `loadRegistry(home)`.** Returns builtins + validated custom. Used by
  `runWatch`, `runDiscover`, and `runServe` (the default `connectorRegistry`). Everything downstream
  (`filterConnectors`, `connectors.list`/`connectors.set`, the watcher, sync) is **unchanged** — custom
  connectors inherit enable/disable and UI surfacing for free.
- **D6 — Honest fidelity.** `status:"experimental"` (CONTEXT §323/§327), `captureMethod:"custom-tail-<fmt>"`,
  `tokens:"none"` unless a `tokenMap` is configured (then `"estimated"`), `cost:"none"`. The Live Monitor
  (M9) and the desktop UI label trustworthiness from these fields — never inflate them.
- **D7 — `discoverRoots` deferred.** Custom connectors omit it (a declared known gap), so the M5 discovery
  sweep skips them cleanly (`discover-engine.ts:29`). Events still stamp a **mapped `projectPath`**, so
  reporting/cost attribute them by path; full workspace discovery for custom sources is a follow-up.
- **D8 — Id namespace + collision.** A custom id must be a non-empty string, must NOT equal a built-in id
  (`claude-code`/`codex-cli`/`gemini-cli`), and must be unique among custom defs. `loadRegistry` enforces
  this (first-wins, later dup dropped with a reason). The user-facing doc recommends a `custom-` prefix.
- **D9 — CLI surface is read-only inspection.** Add a `collector custom` one-shot that **loads + validates**
  the config and prints each connector's id/format/globs/status and any drop reasons (mirror `runDiscover`
  → `main()` print). Authoring the JSON is done by hand / the desktop UI; the CLI does not write it in V1.
- **D10 — `parserVersion` = `CUSTOM_CONNECTOR_CONFIG_VERSION`.** Custom events stamp the config version as
  their parser version (a custom connector has no per-connector semantic version). Bumping the config
  version re-derives on replay, consistent with PRD §23 — and the fingerprint is independent of it.

### Resolved conflicting guidance (do not reconcile by guesswork at implement time)
- **"Mirror `claude-code.ts` parse" vs. "one event per line":** the built-in Claude parser emits *several*
  events per record with incrementing `eventIndex`. The custom factory deliberately emits **one event per
  line at `eventIndex: 0`** (a generic log line is one observation). Follow the custom snippet above, not
  Claude's multi-event-per-record shape — the *tolerance pattern* is what you mirror from Claude, not its
  per-record fan-out.
- **"`watchGlobs(home)` takes home" vs. "custom paths are absolute":** the contract passes `home`, but a
  custom connector **ignores it** and returns its configured absolute globs. This is allowed by the
  contract (the param is available, not mandatory) and is the whole point of a user-pointed watcher. The
  spike must prove the watcher matches an absolute glob outside `home`.

---

## IMPLEMENTATION PLAN

### Phase 0: PRE-FLIGHT SPIKE (gates the plan — ~20 min, throwaway)
Prove the three load-bearing assumptions before writing real code. Delete the spike after.
1. **Absolute-glob-outside-home + tail capture.** Write a temp log file at an absolute path NOT under a
   fake `home`. Build a custom connector via `makeCustomConnector` (a stub is fine), append it to a
   registry, run **one** `FileWatcher.tickOnce()` against a real `QueueStore`, and assert ≥1 raw + ≥1
   event landed. (Reuses the `file-watcher.test.ts` / `capture-engine.int.test.ts` harness.)
2. **Named-capture regex in Node 24.** `new RegExp("(?<ts>\\S+)\\s+(?<sessionId>\\S+)").exec(line).groups`
   returns `{ ts, sessionId }`; a malformed pattern `"("` throws from the `RegExp` ctor (caught by
   `validateCustomDef`).
3. **No new dependency.** Confirm `glob` (from `node:fs/promises`) + `JSON.parse` + `RegExp` cover both
   formats — nothing to add to `apps/collector/package.json`.

### Phase 1: Foundation (shared + types)
- ADD the additive optional `custom?: boolean` to `ConnectorInfo` (`packages/shared/src/control-protocol.ts`).
- Confirm `EventType` union ↔ `MAPPABLE_EVENT_TYPES` parity (a test pins it; no code change to `events.ts`).

### Phase 2: Core Implementation (the factory + loader)
- CREATE `custom-connector.ts`: `CustomConnectorDef`, `MAPPABLE_EVENT_TYPES`, `validateCustomDef`,
  `loadCustomConnectors`/`saveCustomConnectors`, `makeCustomConnector`, and the two extractors
  (`extractByPath`, `extractByRegex`).

### Phase 3: Integration (registry merge + entrypoints)
- CREATE `registry.ts` (`loadRegistry`) and wire it into `runWatch`, `runDiscover`, and `runServe`'s
  default `connectorRegistry`; set `custom` in `mapConnectorInfo`; add the `collector custom` CLI command.

### Phase 4: Testing & Validation + docs
- Unit + watcher-level tests; serve test for custom surfacing/disable; the user-facing doc; full
  `repo-health`.

---

## STEP-BY-STEP TASKS

IMPORTANT: Execute every task in order, top to bottom. Each task is atomic and independently testable.

### 0. SPIKE `apps/collector/src/connectors/_spike-custom.test.ts` (throwaway)
- **IMPLEMENT**: The three Phase-0 proofs as a temporary vitest file. Confirm green, then **delete it**.
- **PATTERN**: `apps/collector/src/watcher/file-watcher.test.ts` (temp dirs + `tickOnce`),
  `connector-config.test.ts` (mkdtemp path seam).
- **GOTCHA**: glob is minimatch-style — normalize `\` → `/` (see `file-watcher.ts:43`). On Windows an
  absolute pattern like `C:/tmp/.../app.log` matches; backslashes do not.
- **VALIDATE**: `npx vitest run apps/collector/src/connectors/_spike-custom.test.ts` (then delete the file).

### 1. ADD `custom?` to `ConnectorInfo` — `packages/shared/src/control-protocol.ts`
- **IMPLEMENT**: Add `/** True for user-defined config connectors (M10-S2). */ custom?: boolean;` to the
  `ConnectorInfo` interface (after `watchGlobs`). Optional ⇒ additive ⇒ **no `CONTROL_PROTOCOL_VERSION`
  bump**.
- **PATTERN**: the existing optional-field style in `ConnectorInfo` (`control-protocol.ts:50-72`).
- **GOTCHA**: Do NOT bump `CONTROL_PROTOCOL_VERSION` ("m11-control-v2") — CLAUDE.md "unchanged through
  slices" only forbids *breaking* changes; an optional field is additive. Adding a required field WOULD
  break the pinning test.
- **VALIDATE**: `npx vitest run packages/shared/src/control-protocol.test.ts`

### 2. UPDATE the `ConnectorInfo` pinning test — `packages/shared/src/control-protocol.test.ts`
- **IMPLEMENT**: Extend the `ConnectorInfo` fixture (lines ~62-73) with `custom: true` and assert it
  round-trips on the `connectors` event.
- **PATTERN**: the existing fixture in that test.
- **VALIDATE**: `npx vitest run packages/shared/src/control-protocol.test.ts`

### 3. CREATE `apps/collector/src/connectors/custom-connector.ts`
- **IMPLEMENT**: `CustomConnectorDef` (`id`, `displayName?`, `watchGlobs: string[]`,
  `format: "jsonl"|"regex"`, `pattern?` (regex), field maps: `tsField`/`sessionIdField`/`projectPathField`/
  `modelField`/`eventTypeField` (dot-paths for jsonl, group names for regex), `eventType?` (constant
  fallback), optional `tokenMap?: { input?; output?; cache_read?; cache_write? }`); `MAPPABLE_EVENT_TYPES`
  (`as const satisfies readonly EventType[]`); `validateCustomDef`; `loadCustomConnectors`/
  `saveCustomConnectors`; `makeCustomConnector` + `extractByPath`/`extractByRegex`.
- **PATTERN**: loader/save ← `connector-config.ts:46-63`; parse tolerance + `makeEvent`/fingerprint ←
  `claude-code.ts:97-172`; tokens ← `claude-code.ts:76-88` (`zeroTokens`/`computeTotal`).
- **IMPORTS**: `eventFingerprint, computeTotal, zeroTokens, type EventType, type NormalizedEvent,
  type NormalizedTokens, type RawSourceRecord from "@420ai/shared"`; `type Connector, type ParseResult
  from "./connector.js"`; `COLLECTOR_HOME from "../identity.js"`; `readFileSync, writeFileSync, mkdirSync,
  existsSync from "node:fs"`; `join, dirname from "node:path"`.
- **GOTCHA**: Library file — **no stdout/stderr, no `process.exit`** (CLAUDE.md process boundaries); return
  data/`{error}`, never log. A bad `RegExp` must be caught in `validateCustomDef` (compile once at
  validate time, store the compiled `RegExp` on the closure — never recompile per line). `eventType`
  resolved per-line from `eventTypeField` MUST be re-checked against `MAPPABLE_EVENT_TYPES` (a log line
  could carry a junk type) → unmatched line ⇒ `skippedLines`, not a bad event.
- **VALIDATE**: `npx vitest run apps/collector/src/connectors/custom-connector.test.ts` (Task 4)

### 4. CREATE `apps/collector/src/connectors/custom-connector.test.ts`
- **IMPLEMENT**: (a) jsonl dot-path parse → correct event fields + tokens; (b) regex named-capture parse;
  (c) tolerant: blank + unparseable + junk-eventType lines bump `skippedLines`, never throw; (d)
  `validateCustomDef` rejects: empty `watchGlobs`, bad regex, unknown `eventType`, missing `ts` source;
  (e) `loadCustomConnectors` → `[]` on absent + corrupt; (f) save→load round-trip; (g)
  `MAPPABLE_EVENT_TYPES` equals the `EventType` union (compile-time `satisfies` + a runtime length/spot
  check).
- **PATTERN**: `connector-config.test.ts` (mkdtemp seam, default-on/tolerant assertions),
  `claude-code.test.ts` (event-field assertions).
- **GOTCHA**: Use a `mkdtempSync` path — never the real `~/.420ai/custom-connectors.json`.
- **VALIDATE**: `npx vitest run apps/collector/src/connectors/custom-connector.test.ts`

### 5. CREATE `apps/collector/src/connectors/registry.ts`
- **IMPLEMENT**: `loadRegistry(home: string, opts?: { customPath?: string }): { connectors: Connector[];
  dropped: { id: string; reason: string }[] }` = builtins + each valid, non-colliding custom (via
  `makeCustomConnector`); collisions/invalid defs go to `dropped`. Built-in ids come from
  `defaultConnectors.map(c => c.id)`.
- **PATTERN**: `connector-config.ts:70-72` (`filterConnectors` pure-merge style); imports
  `connectors as defaultConnectors from "./connector.js"`.
- **GOTCHA**: First-wins on duplicate custom ids. Return the merged array AND drop reasons so the
  entrypoint can `log`/print them (the library itself does NOT log — D9/process boundaries).
- **VALIDATE**: `npx vitest run apps/collector/src/connectors/registry.test.ts` (Task 6)

### 6. CREATE `apps/collector/src/connectors/registry.test.ts`
- **IMPLEMENT**: absent file ⇒ exactly the builtins; one valid custom ⇒ appended (4 connectors); a
  custom id colliding with `claude-code` ⇒ dropped with a reason; two custom defs sharing an id ⇒ second
  dropped.
- **PATTERN**: `connector-config.test.ts`.
- **VALIDATE**: `npx vitest run apps/collector/src/connectors/registry.test.ts`

### 7. UPDATE `apps/collector/src/serve.ts` — surface + capture custom connectors
- **IMPLEMENT**: Change the default `connectorRegistry` (line 116) from `defaultConnectors` to
  `loadRegistry(home).connectors`. In `mapConnectorInfo` (75-87) add `custom: <id not in built-in ids>`
  (pass a `Set<string>` of built-in ids, or a per-connector flag threaded from `loadRegistry`). Optionally
  `log("warn", …)` dropped custom defs at boot (entrypoint may log).
- **PATTERN**: existing `connectorRegistry`/`filterConnectors` flow (`serve.ts:116,150-157,175-182`).
- **GOTCHA**: `mapConnectorInfo` is the **single** `Connector → ConnectorInfo` point — keep it the only
  place that sets `custom`. Compute the built-in id set once outside the `.map`. Do NOT change
  `filterConnectors`/`connectors.set` — custom enable/disable works as-is (keyed by id).
- **VALIDATE**: `npx vitest run apps/collector/src/serve.test.ts`

### 8. UPDATE `apps/collector/src/serve.test.ts` — custom connector surfacing + disable
- **IMPLEMENT**: Inject a `connectorRegistry` that includes a custom connector (or a temp `customPath`),
  assert `connectors.list` returns it with `custom: true`, and `connectors.set {id, enabled:false}` then
  list shows it disabled (and it is filtered out of capture).
- **PATTERN**: the existing `connectors.list`/`connectors.set` tests (`serve.test.ts:200-267`,
  `inMemoryConfig` seam at 184-198).
- **VALIDATE**: `npx vitest run apps/collector/src/serve.test.ts`

### 9. UPDATE `apps/collector/src/cli.ts` — merge registry in watch/discover + add `custom` command
- **IMPLEMENT**: In `runWatch`, build `loadRegistry(opts.home ?? homedir())` and pass `.connectors` to
  `runCaptureEngine({ ..., connectors })`; `log` any drop reasons. In `runDiscover`, pass
  `loadRegistry(...).connectors` to `discoverWorkspaces`. ADD `runCustom()` (one-shot: load+validate,
  return the connector summaries + drop reasons) and a `case "custom":` in the command dispatch that
  prints them.
- **PATTERN**: `runDiscover` (220-232) + its `main()` print + the `discover`/`usage` command blocks
  (275-352) — mirror exactly.
- **IMPORTS**: `loadRegistry from "./connectors/registry.js"` (replace/augment the raw `connectors` import
  where the merged registry is needed; keep `connectors` only where the *built-in* list is intended).
- **GOTCHA**: `runWatch`/`runDiscover` currently use the builtins-only default — without this change custom
  connectors are loaded by `serve` but NOT by the plain `collector watch`/`discover` CLI. Both paths must
  merge for parity. Entrypoint MAY log (it owns stdio); the libraries must not.
- **VALIDATE**: `npx vitest run apps/collector` then manual `collector custom` (Level 4).

### 10. CREATE `docs/guide/custom-connectors.md`
- **IMPLEMENT**: The `custom-connectors.json` schema, both formats with a worked example each, the closed
  `eventType` list, the `custom-` id-prefix recommendation, the honest-fidelity note (experimental;
  no tokens unless mapped; discoverRoots deferred), and the file location (`~/.420ai/custom-connectors.json`,
  `mode 0600`).
- **PATTERN**: existing `docs/guide/*` voice/structure.
- **VALIDATE**: `npm run typecheck` is unaffected by docs; ensure no broken relative links.

### 11. GATE — full `repo-health`
- **IMPLEMENT**: nothing new; run the gate.
- **GOTCHA**: This slice adds NO `@420ai/db`/`apps/ingest` change ⇒ `--require-db` is **not** required (no
  new `*.int.test.ts` against Postgres). Plain `repo-health` is the correct gate here. Still run it from
  the repo root.
- **VALIDATE**: `npm run repo-health`

---

## TESTING STRATEGY

### Unit Tests (co-located `*.test.ts`, always run — no infra)
- `custom-connector.test.ts` — the factory + loader + validation (Task 4). The core of the slice.
- `registry.test.ts` — merge + collision (Task 6).
- `control-protocol.test.ts` — the additive `custom?` field round-trips (Task 2).

### Integration / wiring (still infra-free — watcher + queue + serve seams)
- `serve.test.ts` — custom connector appears in `connectors.list` (`custom:true`) and disables (Task 8).
- The Phase-0 spike proves real watcher → real `QueueStore` end-to-end for an absolute-path log; fold its
  durable assertion into `file-watcher.test.ts` if you want it to live on (optional), then delete the
  throwaway spike file. **No Postgres** is involved at any layer of this slice.

### Edge Cases (must be covered)
- Absent `custom-connectors.json` ⇒ registry is exactly the builtins (fresh-install parity).
- Corrupt JSON ⇒ `[]`, capture of builtins unaffected.
- A def with a bad regex / empty globs / unknown eventType ⇒ dropped with a reason, builtins still capture.
- A custom id colliding with a built-in or another custom ⇒ dropped, first-wins.
- A log line that is blank / unparseable / carries a non-mappable eventType ⇒ `skippedLines`, never throws.
- A def with no `tokenMap` ⇒ `fidelity.tokens:"none"` and events carry no `tokens` (honest).
- `watchGlobs` returns an absolute path outside `home` ⇒ the watcher still matches it (the spike proof).

---

## VALIDATION COMMANDS

Run from the repo root. Each is a GATE.

### Level 1: Syntax & Style (repo-root build — catches cross-project/test-only imports)
- `npm run typecheck` — root `tsc -b`, must exit 0. (Per-workspace build is NOT a substitute.)

### Level 2: Unit Tests
- `npx vitest run apps/collector/src/connectors/custom-connector.test.ts apps/collector/src/connectors/registry.test.ts`
  — all pass.
- `npx vitest run packages/shared/src/control-protocol.test.ts apps/collector/src/serve.test.ts` — all pass.

### Level 3: Full suite (the single health gate)
- `npm run repo-health` — root `tsc -b` + full `vitest run` (units always; the Postgres int layer
  self-skips, which is correct here — **this slice adds no DB/ingest code**) + NUL + stray-artifact scans.
  Expected: PASS, exit 0. **`--require-db` is intentionally NOT needed** (no `@420ai/db`/`apps/ingest`
  change — state this in the PR so a reviewer doesn't expect a migration).

### Level 4: Manual Validation
1. Write `~/.420ai/custom-connectors.json` with a `regex` connector pointing at a temp log file, e.g.:
   ```json
   { "version": "m10-custom-v1", "connectors": [{
     "id": "custom-mytool", "format": "regex", "watchGlobs": ["C:/tmp/mytool/*.log"],
     "pattern": "^(?<ts>\\S+)\\s+session=(?<sessionId>\\S+)\\s+(?<msg>.*)$",
     "eventType": "message.assistant"
   }]}
   ```
2. `collector custom` → prints `custom-mytool` (format regex, status experimental, 1 glob), 0 drops.
3. Append a line to `C:/tmp/mytool/a.log`, run `collector watch` briefly (or `serve` + start), then
   `collector queue-status` / verify the archive received a raw record + `message.assistant` event for
   `sourceConnector: "custom-mytool"`.
4. Break the JSON (delete a brace) → `collector custom` still runs, reports 0 connectors (tolerant), and
   `collector watch` still captures the built-ins.

### Level 5: Additional Validation (optional)
- Headless-Edge screenshot of the desktop UI Connectors panel showing the custom connector with an
  experimental badge + a working disable toggle (if the desktop app is run for this slice; UI work itself
  is the desktop app's concern — the wire field `custom?` is what this slice guarantees).

---

## ACCEPTANCE CRITERIA

- [ ] A `custom-connectors.json` declaration (jsonl OR regex) captures its source end-to-end: raw records
      + normalized events reach the archive under the custom `sourceConnector` id.
- [ ] Absent/corrupt config and any invalid/colliding def **never** break capture of the built-ins
      (default-on safety preserved).
- [ ] Custom connectors appear in `connectors.list` with `custom:true` and honor `connectors.set`
      enable/disable (no change to `filterConnectors`).
- [ ] No new event type, no fingerprint change, no migration, no `apps/ingest`/`@420ai/db` change.
- [ ] Fidelity is honest: `status:"experimental"`, `tokens:"none"` unless a `tokenMap` is configured,
      `cost:"none"`; `discoverRoots` deferred is a stated `knownGap`.
- [ ] Library files add no stdout/stderr/`process.exit`; only the cli/serve entrypoints log.
- [ ] `npm run repo-health` passes (exit 0); the new unit tests run (not skipped).
- [ ] `docs/guide/custom-connectors.md` documents the schema, both formats, the closed eventType list, and
      the honest-fidelity caveats.

---

## COMPLETION CHECKLIST

- [ ] Phase-0 spike proved (absolute-glob tail capture, named-capture regex, no new dep) — then deleted.
- [ ] All tasks completed in order; each task's `VALIDATE` passed immediately.
- [ ] `npm run typecheck` (root `tsc -b`) exits 0.
- [ ] Full `vitest run` green; new units present and passing.
- [ ] `npm run repo-health` PASS.
- [ ] Manual Level-4 capture confirmed against a real custom log.
- [ ] Control protocol unchanged except the additive optional `custom?` field; version NOT bumped.

---

## NOTES

- **Why this is Medium, not High:** there is no new persistence, no migration, no server route, and no
  change to the capture core — the entire feature lives in one new pure factory/loader + a registry-merge
  helper + entrypoint wiring, exactly the shape M11-Slice-2 (`connector-config.ts`) proved was safe.
- **Deferred (own follow-ups, name them in the PR):** whole-file `snapshot` custom format; `discoverRoots`
  for custom sources (workspace mapping); a desktop UI authoring form (this slice only guarantees the
  `custom?` wire field + that custom connectors flow through `connectors.list`/`set`); per-line multi-event
  fan-out (V1 is one event per line).
- **Scope boundary restated:** PRD §39/§217 — a *script/plugin-based* custom connector runtime is a
  non-goal. If a future need can't be met by dot-path/regex declarations, that is a separate, post-V1
  decision — do **not** add code execution to satisfy it here.
- **Replay note (PRD §23):** custom events stamp `parserVersion = CUSTOM_CONNECTOR_CONFIG_VERSION`; their
  fingerprints are independent of it, so re-deriving on a version bump upserts in place — consistent with
  the built-ins.

---

## Confidence Score

**8.5 / 10** for one-pass success. High because the connector contract, the registry-injection seam, the
tolerant-config pattern, and the test harness all already exist and are directly mirrored (M11-S2 is a
near-exact precedent), and the slice touches no DB/server/migration surface. The −1.5 is the open design
*shape* the executor should sanity-check against the spike: the exact `CustomConnectorDef` field set
(dot-path vs. group-name ergonomics) and the `mapConnectorInfo` `custom` threading are the only spots with
real latitude — both are pinned by tests here, but worth a quick validation pass before coding.
