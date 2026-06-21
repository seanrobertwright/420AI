# Feature: M12 Slice 12.7a — Codex CLI tool-call failure classification

The following plan should be complete, but it's important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to naming of existing
utils/types/models. Import from the right files, end relative imports in `.js`, use `import type`.

> Conventions are the repo's, not re-pasted here: see [`CLAUDE.md`](../../CLAUDE.md) (module/TS/naming,
> logging boundaries, the `repo-health` gate) and [`SUMMARY.md`](../../SUMMARY.md) §3/§6 (M12 slice list).
> This is sub-slice **12.7a** of the four-part 12.7 "connector hardening" bundle; 12.7b/c/d are planned
> separately (see `.agents/plans/m12-slice7b/c/d-*.md`).

## Feature Description

The OpenAI Codex CLI connector currently emits `tool.call.completed` for **every** tool output and never
`tool.call.failed`. Its `fidelity.knownGaps` claims *"tool-call failure classification deferred — outputs
carry no structured is_error"*. A spike over **112 real rollouts on this machine proved that claim
stale**: Codex tool outputs DO carry structured and textual failure signals. This slice classifies Codex
tool-call outcomes into `tool.call.completed` vs `tool.call.failed`, tagging each failure with a PRD §14
class, so Codex failures finally surface in the connector-health projection, the `connector.failing`
alert, and reports — at parity with the Claude Code connector.

## User Story

As a self-hosted operator watching my AI coding tools
I want Codex CLI tool-call failures to be detected and classified (not silently counted as successes)
So that the Live Monitor, connector-health metrics, and the `connector.failing` alert reflect Codex's
real failure rate, the same way they already do for Claude Code.

## Problem Statement

`parseCodexSession` maps `function_call_output` / `custom_tool_call_output` → `tool.call.completed`
unconditionally (`apps/collector/src/connectors/codex-cli.ts:232-240`). The deterministic-metrics
projection counts `toolsFailed = count(... = 'tool.call.failed')` and a failure ratio that drives the M10
`connector.failing` alert (`packages/db/src/repositories/projections.ts:175,273-274`). Because Codex never
emits `tool.call.failed`, **Codex's failure rate always reads 0%** — wrong, and a real observability gap
for a "stable" required connector.

## Solution Statement

Add a pure classifier (`classifyCodexOutput`) over the tool-output payload and branch the existing
output-record handling to emit `tool.call.failed` (with a §14 `failureClass` + `exitCode` in the event
payload) when a failure signal is present, else `tool.call.completed` (unchanged). This **mirrors the
blessed Claude Code pattern** (`claude-code.ts:205-207`: pick `failed`/`completed` by `is_error`, emit on
the result record). Two spike-verified signals are detected:

1. **Structured** — the output string is a JSON envelope `{"output":"…","metadata":{"exit_code":N,…}}`;
   `N !== 0` ⇒ failed (`124`/`127` → `environment`, other nonzero → `tool-runtime`).
2. **Plain-text** — bare-string outputs like `apply_patch verification failed: …` (→ `state-mismatch`)
   or `command timed out after …` (→ `environment`).

Bump `PARSER_VERSION` `1.0.0 → 2.0.0` (re-derives on replay). No schema, no server, no `@420ai/shared`,
no fingerprint-delimiter change. Blast radius = **one source file + its fixture + its test**.

## Feature Metadata

**Feature Type**: Enhancement (connector fidelity)
**Estimated Complexity**: Low–Medium (single-file parser change + fixture/test reshape)
**Primary Systems Affected**: `apps/collector` (Codex connector only)
**Dependencies**: none new (pure `JSON.parse` + string checks; no library)

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

- `apps/collector/src/connectors/codex-cli.ts` (whole file) — the file you edit. Key spots:
  - lines 45-67 `CodexPayload` interface — **add `output?: string` and `success?: boolean`** (real
    `function_call_output` records carry `payload.output`; `patch_apply_end` carries `payload.success`).
  - lines 225-246 the `response_item` branch — the `function_call_output`/`custom_tool_call_output`
    handling you replace with the classify-and-branch logic.
  - lines 215-221 the `patch_apply_end` branch (inside `event_msg`) — currently always `file.modified`;
    add the `success === false → tool.call.failed` sub-branch.
  - lines 318-333 the `codexCliConnector` object — update `fidelity.knownGaps` (remove the stale
    "no structured is_error" line; add the new honest coverage line).
  - line 22 `PARSER_VERSION = "1.0.0"` — bump to `"2.0.0"`.
- `apps/collector/src/connectors/claude-code.ts` (lines 22-25, 45-46, 198-213) — **the pattern to
  mirror**: `is_error ? "tool.call.failed" : "tool.call.completed"`, emitted on the result record for a
  stable fingerprint; `PARSER_VERSION = "2.0.0"` with the "fingerprints independent of parser version"
  doc-comment. Copy the spirit (branch on a detected signal), not the Claude-specific field names.
- `apps/collector/src/connectors/codex-cli.test.ts` (whole file) — the test harness you extend. It reads
  `../fixtures/sample-codex-rollout.jsonl`, calls `parseCodexSession(fixture, opts)`, and asserts on
  filtered event arrays. **Existing count assertions at lines 68-81 change** (see tasks).
- `apps/collector/src/fixtures/sample-codex-rollout.jsonl` (whole file) — the fixture you extend with
  real-shaped failure records. **Note line 6 uses an OLD synthetic plain-text `"Exit code: 0\n…"` output
  that is NOT a JSON envelope** → the classifier yields no `exit_code`, no failure pattern → it stays
  `completed` (existing behavior preserved; do not "fix" it).
- `packages/shared/src/events.ts` (lines 26-39, 57-75) — `EventType` already includes `tool.call.failed`
  (line 33). `NormalizedEvent.payload?: unknown` (line 74) — the classification rides here; **no shared
  change, no migration** (server stores `event_type` as free text and `payload` encrypted).
- `packages/db/src/repositories/projections.ts` (lines 175, 270-274) — the downstream consumer:
  `toolsFailed` + `toolCalls` (terminal = completed+failed). **Read-only context** — confirms emitting
  `tool.call.failed` is the correct signal and needs no projection change.

### New Files to Create

None. (Additive edits to three existing files only.)

### Relevant Documentation — READ BEFORE IMPLEMENTING

- [`docs/PRD.md`](../../docs/PRD.md) §14 (lines ~450-458) — the tool-call failure taxonomy this slice maps
  onto: *model error · environment error · permission/policy block · state mismatch · tool/runtime
  failure · user interruption/cancel · expected negative result*. Only `environment`, `tool-runtime`,
  and `state-mismatch` are detectable from Codex output (document the rest as not-distinguishable).
- [`docs/PRD.md`](../../docs/PRD.md) §10.1/§10.3 — Codex is a "stable" required connector; §23 — replay
  re-derivation / `parser_version`.

### Patterns to Follow

**Failure-branch on the terminal record (from `claude-code.ts:205-213`):**

```ts
const eventType: EventType = block.is_error ? "tool.call.failed" : "tool.call.completed";
events.push(makeEvent(rawId, 1 + resultIdx, eventType, record, { payload: { /* … */ } }));
```

Mirror this shape for Codex: classify the output, then `makeEvent(rawId, 0, eventType, ts, currentModel,
{ payload })`. Codex outputs are one-per-record (one `call_id`), so `eventIndex: 0` is correct (unlike
Claude's `1 + resultIdx` for multiple `tool_result` blocks in one user record).

**Tolerant parsing (repo-wide):** never throw on a malformed/unexpected payload — `JSON.parse` of the
inner envelope is wrapped in try/catch and falls through to text checks; a non-string output ⇒
`{ failed: false }` (treated as completed). The connector already counts malformed *lines* in
`skippedLines`; output-shape variance is NOT a skip — it's a completed call with no failure signal.

**Spike-snippet fidelity — assertions the classifier MUST satisfy (proven against 112 real rollouts):**

| Real output (verbatim, from spike) | Classified as | failureClass | exitCode |
|---|---|---|---|
| `{"output":"…","metadata":{"exit_code":0,"duration_seconds":0.7}}` | completed | — | (0) |
| `{"output":"Cannot find path …","metadata":{"exit_code":1,…}}` | **failed** | `tool-runtime` | 1 |
| `{"output":"command timed out after 10304 ms…","metadata":{"exit_code":124,…}}` | **failed** | `environment` | 124 |
| `{"output":"bash: x: command not found","metadata":{"exit_code":127,…}}` | **failed** | `environment` | 127 |
| `apply_patch verification failed: Failed to find expected lines in …` (bare string) | **failed** | `state-mismatch` | — |
| `Exit code: 0\nWall time: 0.5 seconds\nOutput:\nfile.ts` (old synthetic, not JSON) | completed | — | — |

> Spike evidence (run during planning, throwaway deleted): across the 112 rollouts, 355 outputs carried
> `metadata.exit_code` with distribution `{0:350, 1:3, 124:1, 127:1}`; `custom_tool_call_output` is the
> dominant carrier in newer Codex (329/406 had metadata); `apply_patch verification failed: …` appears as
> a **bare-string** `custom_tool_call_output` with NO `exit_code`. `patch_apply_end` did **not** occur in
> any real rollout — its `success` handling below is defensive/forward-compatible, not load-bearing.

---

## IMPLEMENTATION PLAN

### Phase 1: The classifier (pure, local)

Add a local `CodexFailureClass` union + `classifyCodexOutput()` to `codex-cli.ts`. Pure, no I/O,
unit-testable in isolation. Local (not `@420ai/shared`) to keep blast radius to one file — promote to
shared only when Claude/other connectors need the same enum (note in NOTES).

### Phase 2: Branch the parser

Replace the unconditional `tool.call.completed` emission for output records with classify-and-branch.
Add the defensive `patch_apply_end.success === false → tool.call.failed` sub-branch. Add `output` +
`success` to `CodexPayload`. Bump `PARSER_VERSION`.

### Phase 3: Fixture + tests

Append real-shaped failure records to the fixture; update the existing count assertions; add classifier
+ classification-payload assertions.

### Phase 4: Fidelity + gate

Update `knownGaps`; run the gate.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Each task is independently testable.

### UPDATE `apps/collector/src/connectors/codex-cli.ts` — extend `CodexPayload`

- **IMPLEMENT**: Add two optional fields to the `CodexPayload` interface (lines 45-67):
  `output?: string;` (the tool-output record's payload) and `success?: boolean;` (the
  `patch_apply_end` outcome). Add a short comment on each citing the real shape.
- **PATTERN**: the interface already documents per-record fields with inline comments (lines 56-67).
- **GOTCHA**: keep both **optional** — most payload types lack them; `verbatimModuleSyntax`/strict means
  no non-null assertions without a guard.
- **VALIDATE**: `npm run typecheck` (exit 0).

### ADD `classifyCodexOutput` + `CodexFailureClass` to `apps/collector/src/connectors/codex-cli.ts`

- **IMPLEMENT**: Above `parseCodexSession`, add:

  ```ts
  /** PRD §14 failure classes detectable from Codex tool output (subset — see knownGaps). */
  export type CodexFailureClass = "environment" | "state-mismatch" | "tool-runtime";

  /**
   * Classify a Codex tool-output payload (`function_call_output` / `custom_tool_call_output`).
   * Two spike-verified signals (112 real rollouts): a JSON envelope `{output, metadata:{exit_code}}`,
   * else bare-string failure phrases. No signal / non-string ⇒ not failed (completed). Never throws.
   */
  function classifyCodexOutput(
    output: unknown,
  ): { failed: boolean; failureClass?: CodexFailureClass; exitCode?: number } {
    if (typeof output !== "string") return { failed: false };
    // 1. Structured: the output string is itself a JSON envelope carrying metadata.exit_code.
    let exitCode: number | undefined;
    try {
      const parsed = JSON.parse(output) as { metadata?: { exit_code?: unknown } };
      if (parsed && typeof parsed === "object" && typeof parsed.metadata?.exit_code === "number") {
        exitCode = parsed.metadata.exit_code;
      }
    } catch {
      // not a JSON envelope — fall through to plain-text signals
    }
    if (exitCode !== undefined) {
      if (exitCode === 0) return { failed: false, exitCode };
      const failureClass: CodexFailureClass =
        exitCode === 124 || exitCode === 127 ? "environment" : "tool-runtime";
      return { failed: true, failureClass, exitCode };
    }
    // 2. Plain-text signals (no structured exit code).
    if (output.startsWith("apply_patch verification failed")) {
      return { failed: true, failureClass: "state-mismatch" };
    }
    if (/command timed out after/i.test(output)) {
      return { failed: true, failureClass: "environment" };
    }
    return { failed: false };
  }
  ```

- **PATTERN**: pure helper above the parser, like `mapTokens` (lines 85-97).
- **GOTCHA**: classify by `exit_code` **first**; the timeout text also appears inside the exit-124
  envelope, so structured wins and the text branch is only a fallback for un-enveloped outputs. Use
  `parsed.metadata?.exit_code` (optional chain) — `metadata` may be absent.
- **VALIDATE**: `npm run typecheck` (exit 0).

### UPDATE `apps/collector/src/connectors/codex-cli.ts` — branch the output handling

- **IMPLEMENT**: Replace the `function_call_output`/`custom_tool_call_output` branch (lines 232-240) with:

  ```ts
  } else if (subType === "function_call_output" || subType === "custom_tool_call_output") {
    const outcome = classifyCodexOutput(payload.output);
    if (outcome.failed) {
      events.push(
        makeEvent(rawId, 0, "tool.call.failed", ts, currentModel, {
          payload: {
            call_id: payload.call_id,
            failureClass: outcome.failureClass,
            ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
          },
        }),
      );
    } else {
      events.push(
        makeEvent(rawId, 0, "tool.call.completed", ts, currentModel, {
          payload: { call_id: payload.call_id },
        }),
      );
    }
  }
  ```

- **PATTERN**: `claude-code.ts:205-213` (branch on signal, emit on the terminal record).
- **GOTCHA**: keep `eventIndex: 0` (one output per record). Do NOT change the `tool.call.started` branch
  (lines 226-231) — `started` count stays correct; only the terminal record's type is now conditional.
- **VALIDATE**: `npx vitest run apps/collector/src/connectors/codex-cli.test.ts` (after fixture/test
  updates below).

### UPDATE `apps/collector/src/connectors/codex-cli.ts` — `patch_apply_end` failure sub-branch

- **IMPLEMENT**: In the `event_msg` branch, change the `patch_apply_end` handling (lines 215-221) to:

  ```ts
  } else if (subType === "patch_apply_end") {
    if (payload.success === false) {
      events.push(
        makeEvent(rawId, 0, "tool.call.failed", ts, currentModel, {
          payload: { failureClass: "state-mismatch" },
        }),
      );
    } else {
      events.push(
        makeEvent(rawId, 0, "file.modified", ts, currentModel, { payload: { path: payload.path } }),
      );
    }
  }
  ```

- **GOTCHA**: DEFENSIVE only — `patch_apply_end` does not occur in real rollouts (spike); apply_patch
  failures arrive via `custom_tool_call_output` text instead. `success === true` keeps the existing
  `file.modified` emission, so the existing "emits file.modified for patch_apply_end" test still passes.
- **VALIDATE**: `npx vitest run apps/collector/src/connectors/codex-cli.test.ts`.

### UPDATE `apps/collector/src/connectors/codex-cli.ts` — bump `PARSER_VERSION`

- **IMPLEMENT**: `export const PARSER_VERSION = "2.0.0";` (was `"1.0.0"`). Keep the doc-comment.
- **GOTCHA**: `eventType` IS a fingerprint input, so a tool call that was `completed` under v1 and is now
  `failed` produces a **different** fingerprint. This is the same accepted property the Claude connector
  already lives with (it branches `failed`/`completed` by `is_error`). Going-forward ingests are correct;
  the only interaction is a future re-parse (12.5b) that must GC stale-typed events — out of scope here,
  recorded in NOTES + ACCEPTANCE.
- **VALIDATE**: `npm run typecheck` (exit 0).

### UPDATE `apps/collector/src/fixtures/sample-codex-rollout.jsonl` — add real-shaped failure records

- **IMPLEMENT**: Insert these six lines **immediately after the existing `patch_apply_end` line** (the
  current line 9, `…"type":"patch_apply_end","success":true}}`). Timestamps stay within the existing
  `12:00:00 → 12:00:12` window so `session.started`/`session.ended` are unchanged:

  ```
  {"timestamp":"2026-06-13T12:00:09.100Z","type":"response_item","payload":{"type":"custom_tool_call","name":"shell","arguments":"{}","call_id":"call-3"}}
  {"timestamp":"2026-06-13T12:00:09.200Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call-3","output":"{\"output\":\"bash: frobnicate: command not found\",\"metadata\":{\"exit_code\":127,\"duration_seconds\":0.1}}"}}
  {"timestamp":"2026-06-13T12:00:09.300Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call-4","output":"{\"output\":\"E0001 type error\",\"metadata\":{\"exit_code\":1,\"duration_seconds\":0.4}}"}}
  {"timestamp":"2026-06-13T12:00:09.400Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call-5","output":"apply_patch verification failed: Failed to find expected lines in src/app.tsx"}}
  {"timestamp":"2026-06-13T12:00:09.500Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-6","output":"{\"output\":\"ok\",\"metadata\":{\"exit_code\":0,\"duration_seconds\":0.2}}"}}
  {"timestamp":"2026-06-13T12:00:09.600Z","type":"event_msg","payload":{"type":"patch_apply_end","success":false}}
  ```

- **GOTCHA**: the inner `output` is a JSON **string** — the `\"` escaping above is required and must be
  preserved exactly (it models real data). Do NOT add a trailing newline issue — keep one JSON object per
  line; the file already ends with the malformed line + final `token_count` line (leave those last two in
  place, after these inserts).
- **VALIDATE**: `npx vitest run apps/collector/src/connectors/codex-cli.test.ts` (with updated asserts).

### UPDATE `apps/collector/src/connectors/codex-cli.test.ts` — count assertions + new classification tests

- **IMPLEMENT**:
  - In *"emits tool.call.started + tool.call.completed for a function_call/output pair"* (lines 68-75):
    change `started` to **3** (`shell` call-1 + `apply_patch` call-2 + custom `shell` call-3) and
    `completed` to **2** (call-1 old synthetic + call-6 structured exit 0). Keep the
    `started[0]` `{ name: "shell", call_id: "call-1" }` assertion.
  - In *"emits file.modified for patch_apply_end"* (lines 77-81): `file.modified` stays length **1**
    (the `success:true` line; the new `success:false` line is a failure, not a modify).
  - ADD a test: `tool.call.failed` has length **4** (call-3 env/127, call-4 tool-runtime/1, call-5
    state-mismatch, patch_apply_end success:false state-mismatch).
  - ADD a test asserting classification payloads, e.g.:
    ```ts
    const failed = events.filter((e) => e.eventType === "tool.call.failed");
    expect(failed.find((e) => (e.payload as any)?.call_id === "call-3")?.payload).toMatchObject({
      failureClass: "environment", exitCode: 127,
    });
    expect(failed.find((e) => (e.payload as any)?.call_id === "call-4")?.payload).toMatchObject({
      failureClass: "tool-runtime", exitCode: 1,
    });
    expect(failed.find((e) => (e.payload as any)?.call_id === "call-5")?.payload).toMatchObject({
      failureClass: "state-mismatch",
    });
    ```
  - The existing *"produces identical fingerprints across two parses"* and *"skips the malformed line
    (skippedLines === 1)"* and the DELTA-sum (`21071`) tests are UNCHANGED and must still pass.
- **PATTERN**: existing `events.filter((e) => e.eventType === …)` assertions (lines 69-81).
- **GOTCHA**: `e.payload` is typed `unknown` — cast via `as any` / `as Record<string, unknown>` in the
  test (the codebase casts payloads in tests). Prefer `toMatchObject` so extra keys don't break it.
- **VALIDATE**: `npx vitest run apps/collector/src/connectors/codex-cli.test.ts` (all green).

### ADD a direct unit test for `classifyCodexOutput` (optional but recommended)

- **IMPLEMENT**: If you `export` `classifyCodexOutput` (recommended for direct testing), add focused
  cases in the test file covering each row of the spike table above, including the old-synthetic
  `"Exit code: 0\n…"` string ⇒ `{ failed: false }` and a non-string ⇒ `{ failed: false }`.
- **GOTCHA**: exporting a helper is fine (Claude/Codex files already export parser internals). Keep the
  type `CodexFailureClass` exported too.
- **VALIDATE**: `npx vitest run apps/collector/src/connectors/codex-cli.test.ts`.

### UPDATE `apps/collector/src/connectors/codex-cli.ts` — fidelity `knownGaps`

- **IMPLEMENT**: In `codexCliConnector.fidelity.knownGaps` (line 327), REMOVE
  `"tool-call failure classification deferred — outputs carry no structured is_error"` and ADD:
  `"failure classification covers environment (exit 124/127, timeouts), tool-runtime (other nonzero exits), and state-mismatch (apply_patch verification failed); model-error / permission-block / user-cancel / expected-negative are not distinguishable from Codex output (PRD §14)"`.
- **VALIDATE**: `npm run typecheck` (exit 0).

---

## TESTING STRATEGY

### Unit Tests

All in `apps/collector/src/connectors/codex-cli.test.ts` (vitest, fixture-driven — no infra). Cover:
classifier table (structured exit 0/1/124/127, plain-text apply_patch + timeout, old-synthetic string,
non-string); event-count deltas (started 3 / completed 2 / failed 4 / file.modified 1); classification
payload shape; and the **unchanged** invariants (skippedLines 1, identical fingerprints across parses,
DELTA-sum 21071).

### Integration Tests

None required — this is a client-side parser change with **no DB/ingest/server touch**, so no
`*.int.test.ts` is added or affected. (The existing `capture-engine.int.test.ts` continues to pass; it
exercises Claude, not Codex specifics.)

### Edge Cases

- Output is a JSON envelope **without** `metadata` (older format) → no `exit_code` → falls to text checks
  → completed (most of the 1510 metadata-less real outputs).
- Output is the old synthetic `"Exit code: 0\n…"` plain string → not JSON, no failure phrase → completed
  (line-6 regression guard).
- `exit_code: 0` present → completed (structured success).
- Non-string `payload.output` (absent/object) → `{ failed: false }` → completed (never throws).
- `patch_apply_end` with `success` absent → treated as success → `file.modified` (back-compat).

---

## VALIDATION COMMANDS

Run from the **repo root**. Each is a gate with the stated pass signal.

### Level 1: Syntax & Style
- `npm run typecheck` — root `tsc -b` across the four backend workspaces; **exit 0**. (Per-workspace
  build is NOT a substitute.)
- `npx prettier --check "apps/collector/src/connectors/codex-cli.ts" "apps/collector/src/connectors/codex-cli.test.ts"`
  — formatting clean (or run `eslint` per `eslint.config.js`).

### Level 2: Unit Tests
- `npx vitest run apps/collector/src/connectors/codex-cli.test.ts` — focused; **all tests pass**.

### Level 3: Full suite / gate
- `npm run repo-health` — typecheck + full `vitest run` + NUL scan + stray-artifact scan; **PASS**.
  `--require-db` is **NOT required** for sign-off: this slice touches neither `@420ai/db` nor
  `apps/ingest` (no int layer exercises Codex classification). State this explicitly in the execution
  report.

### Level 4: Manual Validation (optional, high-value)
- Re-parse a **real** rollout that contains a known failure and eyeball the output:
  ```bash
  npx tsx -e "import('./apps/collector/src/connectors/codex-cli.js').then(async m => {
    const { readFileSync } = await import('node:fs');
    const f = process.argv[1];
    const { events } = m.parseCodexSession(readFileSync(f,'utf8'));
    console.log(events.filter(e => e.eventType==='tool.call.failed').map(e => e.payload));
  })" "$(ls ~/.codex/sessions/2026/*/*/rollout-*.jsonl | head -1)"
  ```
  Expect non-empty `failed` payloads with `failureClass`/`exitCode` on a session that had failures.

---

## ACCEPTANCE CRITERIA

- [ ] `parseCodexSession` emits `tool.call.failed` for nonzero-`exit_code` envelopes and the
      `apply_patch verification failed` / timeout text signals; `tool.call.completed` otherwise.
- [ ] Each `tool.call.failed` carries `payload.failureClass` (∈ environment/state-mismatch/tool-runtime)
      and, when structured, `payload.exitCode`.
- [ ] `classifyCodexOutput` matches every row of the spike table (unit-tested).
- [ ] Fixture extended with real-shaped records; counts: started 3 / completed 2 / failed 4 /
      file.modified 1; `skippedLines` still 1; DELTA-sum still 21071; fingerprints still unique &
      stable across parses.
- [ ] `PARSER_VERSION === "2.0.0"`; `knownGaps` updated (stale is_error line removed).
- [ ] `npm run repo-health` PASS; `npm run typecheck` exit 0.
- [ ] No `@420ai/shared`, DB, ingest, migration, or fingerprint-delimiter change (blast radius = the
      Codex connector + its fixture/test).

## COMPLETION CHECKLIST

- [ ] All tasks completed in order; each task's VALIDATE passed immediately.
- [ ] Full `repo-health` green.
- [ ] Manual re-parse of a real failing rollout shows classified failures (Level 4).
- [ ] Execution report notes the `--require-db`-not-required rationale and the 12.5b stale-event interaction.

---

## NOTES

- **Why local, not `@420ai/shared`:** `CodexFailureClass` + the classifier stay in `codex-cli.ts` to keep
  the blast radius to one file. PRD §14 is cross-connector, so when Claude Code (or another connector)
  gains classification, promote the union to `@420ai/shared` and have both import it. Flagged, not done.
- **Replay / fingerprint interaction (the one real subtlety):** `eventType` is a fingerprint input, so a
  tool call reclassified `completed → failed` gets a NEW fingerprint. Upsert-by-fingerprint never deletes,
  so a *re-parse* of an already-ingested session would leave a stale `completed` row beside the new
  `failed` row (double-counting in `toolCalls`). This is identical to the property the Claude connector
  already lives with and there is **no automatic re-parse path today** (the queue's content-hash dedup
  skips unchanged files; the 12.5b re-parse engine is deferred). 12.5b must own stale-typed-event GC.
  Going-forward ingest is fully correct. No action here beyond this note.
- **Fixture realism:** the new lines model the verified real shape (JSON-string `output` envelope with
  `metadata.exit_code`; bare-string `apply_patch verification failed`). The pre-existing synthetic
  `"Exit code: 0"` line is intentionally left to guard the "non-envelope ⇒ completed" path.
- **Spikes actually run during planning (evidence for confidence):**
  1. Surveyed payload-type frequency across 40+ real rollouts (`function_call_output` 725,
     `custom_tool_call_output` 85 in that sample; **no `patch_apply_end`**).
  2. Parsed all 112 rollouts: 355 outputs carried `metadata.exit_code`, distribution
     `{0:350, 1:3, 124:1, 127:1}`; `custom_tool_call_output` is the dominant metadata carrier (329/406);
     `apply_patch verification failed: …` confirmed as a bare-string output with no exit code.
  3. Verified `EventType` already contains `tool.call.failed` (`events.ts:33`) and `NormalizedEvent.payload`
     is `unknown` (`events.ts:74`) — no shared/schema change.
  4. Verified the downstream consumer: `projections.ts:175,273-274` counts `tool.call.failed`
     (→ `connector.failing` alert) — emitting it is the correct, already-wired signal.
  5. Verified the mirror pattern: `claude-code.ts:205-207` branches `failed`/`completed` by `is_error` on
     the result record, and `PARSER_VERSION = "2.0.0"` with the replay doc-comment.
  All throwaway spike scripts were deleted; findings folded in above.

**One-pass confidence: 9.5/10.** Every cited symbol/line was read (not recalled); the failure format is
proven against real on-disk data (not the synthetic fixture); the emit pattern mirrors a blessed in-repo
precedent; the fixture/test deltas are fully specified with deterministic expected counts; blast radius is
one file + its fixture/test with no DB/server/shared/fingerprint change. Residual 0.5: exact final
event-count assertions should be re-confirmed by running the focused vitest once after editing (the plan
states them, but transcription order in the fixture is the only thing that could surprise).
