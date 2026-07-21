# Feature: M14 Slice 14.7 — Browser Extension (live Claude capture) + collector `push` capture mode

The following plan should be complete, but it's important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to naming of existing
utils, types, and models. Import from the right files (`@420ai/shared`, relative `.js` suffixes, `import type`).

> **Conventions are NOT re-pasted here** — they live in [`CLAUDE.md`](../../CLAUDE.md) (ESM/NodeNext,
> `.js` import suffixes, kebab-case files, strict TS, library-files-never-log, the leak-window rule,
> the validation GATE). Read it first. Build-loop context: [`SUMMARY.md`](../../SUMMARY.md) §2.

## Feature Description

Slice 14.7 is the **research-gated browser-extension build** promised by the 14.0 chat-capture spike
([`docs/research/chat-capture-spike.md`](../../docs/research/chat-capture-spike.md)). The 14.5 slice
shipped the `claude-export` connector (batch, days-stale, uncosted). 14.7 delivers **near-real-time**
capture of Claude web conversations via a browser extension that reads the app's own conversation API
(the auth cookies the collector cannot hold) and **pushes** the raw conversation JSON to a new
**local HTTP receiver** in the collector — a new capture mode (`push`) beside `tail`/`snapshot`/`poll`.

Per the chosen scope ("Spike + push foundation"), 14.7 has **three deliverables**:

1. **The Phase-0 recon written up** as `docs/research/extension-spike.md` (a per-origin go/no-go gate).
   The recon was **already run live during planning** (evidence in NOTES) — this is documentation of
   proven facts, not new investigation.
2. **The reusable collector `push` capture mode** — a `127.0.0.1`-bound, token-authed `node:http`
   receiver that normalizes pushed payloads through the existing `connector.parse` contract and
   enqueues onto the durable queue (the sync loop drains them exactly like `tail`/`poll` output).
3. **A minimal MV3 extension skeleton for Claude only** — a background service worker that polls the
   Claude conversation API and forwards raw conversation JSON to the receiver; an options page for the
   push token + enable toggle. Proves the end-to-end pipe: `browser → collector → archive → Monitor`.

**Out of scope (deferred, documented in the gate):** ChatGPT/Gemini extension origins (ChatGPT is a
verified GO for a later slice; Gemini is a NO-GO for intercept → Takeout export = 14.6); SSE/streaming
interception (the robust path is polling the conversation API — see recon); cross-connector dedup of
`claude-live` vs `claude-export` (same conversation captured both ways → two sessions — a documented
known gap); a bundled/signed extension distribution (Chrome Web Store, code signing — parked, per the
M12/M14 non-goals).

## User Story

As a **420AI self-hoster who uses Claude on the web (not just the CLI)**,
I want to **capture my web conversations near-real-time without manually exporting**,
So that **my chat activity appears in the archive/Monitor alongside my coding-tool sessions, honestly
labeled, without me holding an export ritual**.

## Problem Statement

Claude web/desktop persists **no local conversation store** (14.0 spike, `[verified]`), so the only
capture paths are (a) manual official exports — batch, days-stale (shipped in 14.5) — or (b) a browser
extension that reads the app's own authenticated API. The collector today has **no way to receive
data from a browser**: `serve.ts` is a **stdio** control-protocol server for the Tauri sidecar, and
there is **no HTTP listener anywhere in the collector**. (The 14.0 spike's line "POST to the
collector's existing local HTTP server (`serve.ts`)" is **inaccurate** — that server is stdio-only;
this slice builds the HTTP receiver it presumed existed.)

## Solution Statement

Add a new **`push` capture mode**: an inbound `node:http` receiver (no new dependency — the collector
depends only on `@420ai/shared`) bound to `127.0.0.1`, gated by a shared bearer token stored in
`~/.420ai/push-token.json`. It runs **inside `runCaptureEngine`** beside `pollLoop`/`gitSweepLoop`
(same abort-signal lifecycle + leak-window discipline), starting only when ≥1 **push-capable connector**
is enabled+approved. A pushed payload `{connector, conversations}` is routed to that connector's
existing **`parse(fileText)`** contract (reusing the exact seam `tail`/`snapshot` use) and enqueued via
the same `queue.enqueue("raw"/"event", …)` calls `pollLoop` uses — so the durable queue, sync worker,
ingest API, `events` table, and the **fingerprint are all untouched** (invariant).

A new **`claude-live` connector** (`captureMode: "push"`, `watchGlobs: () => []`, `push` capability)
carries a pure `parseClaudeWire` normalizer in `@420ai/shared` — a near-clone of `parseClaudeExport`
that additionally stamps the conversation-level `model` the wire carries but the export lacks. Its
capture surface (the `push.origins`) folds into the §10.4 approval fingerprint (the `poll.sources`
precedent). A thin MV3 extension (plain JS, `apps/extension/`, out of the root `tsc` graph — like the
dashboard/desktop) polls the Claude API and forwards raw conversations to the receiver.

## Feature Metadata

**Feature Type**: New Capability
**Estimated Complexity**: High (a new inbound network surface + a new greenfield extension workspace;
mitigated by reusing every capture-core seam additively — zero change to queue/sync/ingest/fingerprint)
**Primary Systems Affected**: `apps/collector` (capture engine, connectors, a new `push/` module),
`packages/shared` (a new `parsers/claude-wire.ts` + barrel), a new `apps/extension` workspace.
**Dependencies**: none new for the backend (`node:http`, `node:crypto` are built-in). The extension is
plain JS (no bundler, no npm deps) loaded unpacked.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

- `apps/collector/src/capture-engine.ts` (lines 128–176 `pollLoop`; 101–126 `gitSweepLoop`; 178–282
  `runCaptureEngine`) — **the exact pattern to MIRROR** for the push server: a best-effort long-lived
  loop/resource added to the `Promise.allSettled` unwind, wound down by `internal.abort()`, with the
  abort listener armed synchronously (leak-window rule). The `onChange`/`pollLoop` enqueue lines
  (188–195, 149–157) are the enqueue contract to copy verbatim.
- `apps/collector/src/connectors/connector.ts` (lines 58–137) — the `Connector` contract,
  `PollCapability` (the shape to mirror for `PushCapability`), the `captureMode` union (add `"push"`),
  and the `connectors[]` registry (append `claudeLiveConnector`).
- `apps/collector/src/connectors/claude-export.ts` (whole file) — the connector-object shape to mirror
  for `claude-live` (re-export the pure parser + connector metadata; `watchGlobs` empty; honest
  fidelity; `requiredPermissions`).
- `packages/shared/src/parsers/claude-export.ts` (whole file) — **the parser to clone** into
  `claude-wire.ts`. Same tolerant JSON handling, same `chat:claude:<uuid>` attribution, same
  `eventFingerprint(connector, rawRecordId, eventIndex, eventType)` calls, same `normalizeTs`.
- `packages/shared/src/parsers/claude-export.test.ts` (whole file) — the test convention to mirror for
  `claude-wire.test.ts` (fixture-driven, per-type counts, fingerprint-stability, tolerance cases).
- `packages/shared/src/events.ts` (lines 26–75) — `EventType` union, `RawSourceRecord`,
  `NormalizedEvent` (note `model?` is the field the wire parser stamps; `tokens`/`cost`/`catalogVersion`
  stay unset — uncosted).
- `apps/collector/src/queue/queue-store.ts` (lines 111–132 `enqueue`) — the durable-queue enqueue
  (dedups by content hash → re-POSTing an unchanged conversation is a no-op; the push mode's
  idempotency comes free from this, exactly like poll).
- `apps/collector/src/connectors/connector-approvals.ts` (lines 63–69 `captureSurfaceFingerprint`) —
  fold `push.origins` here exactly as `poll.sources` is folded (line 67).
- `apps/collector/src/identity.ts` (lines 17–23, 55–72) — `COLLECTOR_HOME`, the `save…/load…` +
  `mode:0o600` + tolerant-read pattern to mirror for the push token.
- `apps/collector/src/serve.ts` (lines 239–254, 220–278) — how the FILTERED (enabled+approved)
  connectors reach `runCaptureEngine`; the push server inherits that filtering automatically (the
  Tauri sidecar path gets push for free — no protocol change).
- `apps/collector/src/cli.ts` (lines 172–215 `runWatch`, 524–549 `watch` command) — where to thread
  an optional `--push-port` flag into `runCaptureEngine`.
- `apps/dashboard/tsconfig.json` + root `tsconfig.json` — the precedent for a workspace **excluded
  from the root `tsc -b` graph** (the extension follows the same exclusion; see CLAUDE.md "Frontend
  workspace").

### New Files to Create

**`packages/shared`:**
- `packages/shared/src/parsers/claude-wire.ts` — pure `parseClaudeWire(text)` normalizer + constants
  `CLAUDE_LIVE_CONNECTOR = "claude-live"`, `CLAUDE_WIRE_PARSER_VERSION = "1.0.0"`.
- `packages/shared/src/parsers/claude-wire.test.ts` — unit tests (mirror `claude-export.test.ts`).
- `packages/shared/src/parsers/fixtures/sample-claude-wire.json` — a **redacted** fixture built from
  the verified wire shape (see Task 2 for the exact shape).

**`apps/collector`:**
- `apps/collector/src/push/push-token.ts` — `loadOrCreatePushToken(home)` (+ `pushTokenPathFor`).
- `apps/collector/src/push/push-token.test.ts` — generate-if-absent / persist / reload-idempotent.
- `apps/collector/src/push/push-server.ts` — `runPushServer(opts, signal)` + `DEFAULT_PUSH_PORT`.
- `apps/collector/src/push/push-server.test.ts` — receiver behavior (200/401/400/413, enqueue).
- `apps/collector/src/connectors/claude-live.ts` — the `claudeLiveConnector` object.

**`apps/extension`** (new workspace, plain JS, out of the root `tsc` graph):
- `apps/extension/package.json` (name `@420ai/extension`, private, `"build"`: a no-op/echo so the
  workspace is valid; NO `test` script — the root defines test).
- `apps/extension/manifest.json` (MV3).
- `apps/extension/src/background.js` (service worker: poll Claude API → forward).
- `apps/extension/src/options.html` + `apps/extension/src/options.js` (token + enable toggle).
- `apps/extension/README.md` (load-unpacked instructions + the token handshake + the drift warning).
- `apps/extension/.gitignore` (nothing built, but mirror the desktop/dashboard convention).

**`docs/research`:**
- `docs/research/extension-spike.md` — the per-origin go/no-go gate (write-up of the run recon).

### New Files NOT to create / things NOT to touch

- **Do NOT** add a migration, a new `events`-table column, or touch `packages/shared/src/fingerprint.ts`
  (invariant). Chat events are uncosted → no pricing/catalog change.
- **Do NOT** change `serve.ts`'s control protocol or bump `CONTROL_PROTOCOL_VERSION` — the push server
  is engine-internal; the sidecar path gets it via the unchanged `runCaptureEngine` call.
- **Do NOT** add the extension workspace to the root `tsconfig.json` `references` (it must stay out of
  the `tsc -b` graph, like `apps/dashboard`).

### Relevant Documentation — READ THESE BEFORE IMPLEMENTING

- [Chrome MV3 service worker + host_permissions](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers)
  — background worker lifecycle; the extension has no persistent page.
  - Why: the extension is a periodic poller driven by `chrome.alarms`, not a content script.
- [chrome.alarms API](https://developer.chrome.com/docs/extensions/reference/api/alarms) — minimum
  period is **1 minute**; use it for the poll cadence.
  - Why: the near-real-time cadence and why the honest liveness label is `near-real-time`, not `streaming`.
- [MV3 host_permissions & CORS](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
  — an extension background fetch to an origin in `host_permissions` bypasses page CORS.
  - Why: justifies why the extension can `fetch("http://127.0.0.1:42017/…")` without a CORS preflight,
    given `http://127.0.0.1:42017/*` is in `host_permissions`. The receiver still handles `OPTIONS`
    defensively.
- [node:http createServer](https://nodejs.org/api/http.html#httpcreateserveroptions-requestlistener)
  — the receiver primitive (built-in, no dependency).
  - Why: `server.listen(port, "127.0.0.1", cb)`, `server.close()`, request body streaming + bounding.

### Patterns to Follow

**Naming:** kebab-case files; `CLAUDE_LIVE_CONNECTOR` / `CLAUDE_WIRE_PARSER_VERSION` (mirror
`CLAUDE_EXPORT_CONNECTOR` / `CLAUDE_EXPORT_PARSER_VERSION`); `runPushServer` (mirrors `pollLoop`,
`gitSweepLoop` — a function returning a `Promise<void>` that resolves on abort/close).

**Best-effort long-lived resource (leak-window rule — CLAUDE.md):** arm the abort teardown
**synchronously before any await**. `runPushServer` mirrors `pollLoop`/`abortableDelay`:

```ts
// push-server.ts — resolves when the server CLOSES (on abort) so it slots into the engine's
// Promise.allSettled unwind exactly like pollLoop. NEVER throws (best-effort): a port-in-use or
// request error is logged + degrades, never stops capture.
export function runPushServer(opts: PushServerOptions, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const host = opts.host ?? "127.0.0.1";
    const byId = new Map(opts.connectors.map((c) => [c.id, c]));
    const server = createServer((req, res) => handleRequest(req, res, { ...opts, byId }));
    const onAbort = (): void => void server.close();
    signal.addEventListener("abort", onAbort, { once: true }); // armed BEFORE listen resolves
    server.on("close", () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
    server.on("error", (err) => {
      opts.log(`push server error: ${(err as Error).message}`); // e.g. EADDRINUSE — degrade
      resolve();
    });
    server.listen(opts.port ?? DEFAULT_PUSH_PORT, host, () => opts.onListen?.(addressPort(server)));
  });
}
```

**Enqueue contract (copy from `pollLoop`, capture-engine.ts:149–157):**

```ts
for (const r of result.rawRecords) {
  queue.enqueue("raw", `${r.sourceConnector}:${r.id}`, toRawRecordPayload(r));
}
for (const e of result.events) {
  queue.enqueue("event", e.fingerprint, toEventPayload(e));
}
```

**Tolerant pure parser (mirror `parseClaudeExport`):** never throw; malformed whole-file blob →
`{rawRecords:[], events:[], skippedLines:1}`; a conversation without a stable `uuid` is skipped, never
keyed on array position (fingerprint churn).

> **Spike-snippet fidelity:** the wire shapes in Task 2 are the **exact keys observed live** during
> planning (recon output pasted in NOTES). If the executor finds the live API has drifted, the parser's
> tolerance (skip-on-shape-mismatch) degrades safely — but update the fixture + the connector's
> `testedVersions`/`knownGaps` to record the drift rather than guessing new fields.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation (shared parser + constants)

Pure, dependency-free, fully unit-testable with no infra. Establishes the taxonomy mapping the
receiver and the connector both consume.

- `parseClaudeWire` + constants in `@420ai/shared`; barrel export; fixture + tests.

### Phase 2: Core Implementation (collector push mode)

- `push-token.ts` (shared secret), `push-server.ts` (the `node:http` receiver), `claude-live.ts`
  (the connector). All additive.

### Phase 3: Integration (engine wiring + approval fold)

- Wire `runPushServer` into `runCaptureEngine` beside `pollLoop`; fold `push.origins` into
  `captureSurfaceFingerprint`; thread an optional `--push-port`; register `claudeLiveConnector`.

### Phase 4: Extension skeleton + spike doc + validation

- The MV3 extension (`apps/extension`); `docs/research/extension-spike.md`; run the full gate.

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Each task is independently testable; run its VALIDATE before moving on.

### CREATE `packages/shared/src/parsers/claude-wire.ts`

- **IMPLEMENT**: A pure `parseClaudeWire(text: string, opts?: { ingestedAt?: string }): ParseResult`
  that clones `parseClaudeExport` with these differences:
  - Input `text` is a JSON **array of conversation objects** (the extension `JSON.stringify`s the
    `conversations` array). Also tolerate a single conversation object (wrap into `[obj]`) and a
    `{conversations:[…]}` wrapper (defensive), mirroring the export parser's shape tolerance.
  - Conversation keys (VERIFIED live): `uuid`, `name`, **`model`** (conversation-level string, may be
    absent/null), `created_at`, `updated_at`, `chat_messages: []`.
  - Message keys (VERIFIED live): `uuid`, `sender` (`"human"`|`"assistant"`), `text`, `created_at`,
    `content: []`. (`content` block shapes — `thinking`/`tool_use`/`tool_result`/`text` — are a
    declared `knownGap`; do NOT emit tool/file events. Emit only session + message events, same scope
    as the export parser.)
  - Attribution: `projectPath = chat:claude:${sessionId}` (**identical** to the export parser — same
    key on purpose so a live+export capture of one conversation groups under one session; the
    duplicate-across-connectors event set is a documented known gap, not resolved here).
  - **Difference vs export:** stamp the conversation-level `model` on **`message.assistant`** events
    only (`{ ...extra, model: convModel }` when `convModel` is a non-empty string). Leave
    `message.user`, `session.started`, `session.ended` without `model`. Still NO tokens/cost/
    catalogVersion (uncosted).
  - `sourceConnector`/`parserVersion` = `CLAUDE_LIVE_CONNECTOR` / `CLAUDE_WIRE_PARSER_VERSION`.
  - Export the constants `CLAUDE_LIVE_CONNECTOR = "claude-live"` and `CLAUDE_WIRE_PARSER_VERSION = "1.0.0"`.
- **PATTERN**: `packages/shared/src/parsers/claude-export.ts` (clone `normalizeTs`, the tolerant
  `JSON.parse`, the `makeEvent` closure, the per-message raw-record + event loop, the
  `session.started`/`session.ended` framing).
- **IMPORTS**: `import type { EventType, NormalizedEvent, RawSourceRecord } from "../events.js";`
  `import { eventFingerprint } from "../fingerprint.js";`
  `import type { ParseResult } from "./parse-result.js";`
- **GOTCHA**: `ts` is normalized through `normalizeTs` (micros→millis ISO) but is **not** a fingerprint
  input — do not let it perturb fingerprints. Key `rawRecordId` on the stable `message.uuid`
  (VERIFIED unique), positional fallback defensive only. The conversation `session.started`/`ended`
  raw id is `${sessionId}:session` (as in the export parser).
- **VALIDATE**: `npx tsc -b packages/shared` (exit 0).

### CREATE `packages/shared/src/parsers/fixtures/sample-claude-wire.json`

- **IMPLEMENT**: A **redacted** JSON array of ~3–4 conversation objects covering: [0] normal
  human+assistant with a conversation `model` and a title; [1] assistant turn with a `content[]`
  containing a `thinking`/`tool_use` block (to prove they're ignored, not crashed on); [2] an EMPTY
  conversation (`chat_messages: []`); [3] a conversation with an empty `name`. Use fake uuids/text.
  Match the VERIFIED shape in NOTES (conversation + message keys). Redact all real content.
- **PATTERN**: `packages/shared/src/parsers/fixtures/sample-claude-export.json` (same 4-case coverage).
- **GOTCHA**: give message objects a `content` array with realistic `type` values so the test proves
  the parser IGNORES non-text blocks and still emits exactly one message event per message.
- **VALIDATE**: `node -e "JSON.parse(require('fs').readFileSync('packages/shared/src/parsers/fixtures/sample-claude-wire.json','utf8'))"` (exit 0 — valid JSON).

### CREATE `packages/shared/src/parsers/claude-wire.test.ts`

- **IMPLEMENT**: Mirror `claude-export.test.ts`: per-type event counts for the fixture; a `model`
  stamped ONLY on `message.assistant` (and absent on user/session events); UNCOSTED assertions
  (`tokens`/`cost`/`catalogVersion` undefined); `chat:claude:<uuid>` attribution; fingerprint stability
  across two `ingestedAt` values; empty-conversation emits nothing; tolerance for malformed blob
  (`skippedLines: 1`) and valid-but-wrong-shape.
- **PATTERN**: `packages/shared/src/parsers/claude-export.test.ts:19–125`.
- **IMPORTS**: `import { parseClaudeWire, CLAUDE_LIVE_CONNECTOR, CLAUDE_WIRE_PARSER_VERSION } from "./claude-wire.js";`
- **VALIDATE**: `npx vitest run packages/shared/src/parsers/claude-wire.test.ts` (all pass).

### UPDATE `packages/shared/src/index.ts`

- **ADD**: `export * from "./parsers/claude-wire.js";` after the `claude-export.js` line (26).
- **PATTERN**: existing barrel lines 22–26.
- **VALIDATE**: `npx tsc -b packages/shared` (exit 0).

### CREATE `apps/collector/src/push/push-token.ts`

- **IMPLEMENT**: `pushTokenPathFor(home: string): string` → `join(collectorHomeFor(home), "push-token.json")`;
  `loadOrCreatePushToken(home: string): string` — read `{ token }` from the file; if absent/corrupt,
  generate `randomBytes(24).toString("hex")`, write `{ token }` with `mode: 0o600` (mkdir parent
  first), and return it. Tolerant read (never throw). Pure of process concerns (no log/exit) — the
  engine logs "push token: … (paste into the browser extension)" once on first creation via a returned
  `{ token, created: boolean }` OR a separate `created` signal; simplest: return `{ token, created }`.
- **PATTERN**: `apps/collector/src/identity.ts:55–72` (`saveCredentials`/`loadCredentials`, `0o600`,
  `mkdirSync(dirname(path), { recursive: true })`); `collectorHomeFor` from `identity.ts:32`.
- **IMPORTS**: `import { randomBytes } from "node:crypto";`
  `import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";`
  `import { dirname } from "node:path";` `import { collectorHomeFor } from "../identity.js";`
- **GOTCHA**: `~/.420ai/` may not exist on a fresh install — `mkdirSync` the parent (identity does).
- **VALIDATE**: `npx tsc -b apps/collector` (exit 0).

### CREATE `apps/collector/src/push/push-token.test.ts`

- **IMPLEMENT**: In a temp dir (`node:fs` `mkdtempSync` under `os.tmpdir()`): first call creates the
  file + returns `created:true`; second call returns the SAME token + `created:false`; a corrupt file
  is replaced. Assert `0o600` where the platform honors it (skip the mode assertion on win32 — mode is
  a no-op there; guard with `process.platform !== "win32"`).
- **PATTERN**: any collector `*.test.ts` using a temp dir (e.g. `queue-store.test.ts` conventions).
- **VALIDATE**: `npx vitest run apps/collector/src/push/push-token.test.ts` (pass).

### CREATE `apps/collector/src/push/push-server.ts`

- **IMPLEMENT**: `DEFAULT_PUSH_PORT = 42017`; `runPushServer(opts, signal): Promise<void>` per the
  Patterns snippet; `PushServerOptions { connectors: Connector[]; queue: QueueStore; token: string;
  port?: number; host?: string; log: (msg)=>void; onListen?: (port:number)=>void }`. The request
  handler:
  - `OPTIONS` → `204` with `Access-Control-Allow-Origin: *` + `Allow-Headers: authorization,content-type`
    + `Allow-Methods: POST,OPTIONS` (defensive; extension bg fetch doesn't need it but a MAIN-world
    content-script POST would).
  - Only `POST /v1/push`; anything else → `404`.
  - Auth: read `authorization: Bearer <t>`; compare to `opts.token` with `crypto.timingSafeEqual` over
    equal-length buffers (length-mismatch → reject). Missing/mismatch → `401`.
  - Body: stream chunks, **bound at 16 MiB** (mirror ingest's `bodyLimit`; over → destroy + `413`).
    `JSON.parse`; validate `{ connector: string, conversations: unknown[] }` (else `400`).
  - Look up `byId.get(body.connector)`; unknown/not-push → `400`.
  - `const result = connector.parse(JSON.stringify(body.conversations));` then enqueue raw+events
    (the copied contract). Respond `200 {"rawRecords":R,"events":E}`.
  - Wrap the whole handler in try/catch → `500` with a short message; the server NEVER crashes on a bad
    request.
- **PATTERN**: `capture-engine.ts:136–176` (`pollLoop` abort/enqueue); `apps/ingest/src/app.ts`
  `bodyLimit` (16 MiB) referenced in CLAUDE.md "Collector outbound HTTP".
- **IMPORTS**: `import { createServer } from "node:http";`
  `import { timingSafeEqual } from "node:crypto";`
  `import { toRawRecordPayload, toEventPayload } from "@420ai/shared";`
  `import type { Connector } from "../connectors/connector.js";`
  `import type { QueueStore } from "../queue/queue-store.js";`
- **GOTCHA**: bind `127.0.0.1` (NOT `0.0.0.0` — never expose the receiver on the LAN). Naming: this is
  the `captureMode:"push"` **receiver**; it is **unrelated** to the existing `collector push <file>`
  CLI subcommand (`runPush` in `cli.ts` — one-shot file→ingest). Do not conflate them.
- **VALIDATE**: `npx tsc -b apps/collector` (exit 0).

### CREATE `apps/collector/src/push/push-server.test.ts`

- **IMPLEMENT**: Start the server with `port: 0` (ephemeral) + an `onListen` that resolves the real
  port; use a real `QueueStore(":memory:")` and an injected `claude-live`-like connector (or the real
  `claudeLiveConnector`). Cases:
  - Valid POST with the fixture + correct token → `200`, and `queue.stats().pending > 0` (raw+events
    enqueued); a re-POST is a no-op (dedup) — pending count unchanged after the second POST.
  - Missing/wrong token → `401`, nothing enqueued.
  - Unknown `connector` id → `400`.
  - Body > 16 MiB → `413` (send a large synthetic body).
  - Abort the signal → the returned promise resolves and the port is free.
- **PATTERN**: use Node global `fetch` to hit `http://127.0.0.1:${port}/v1/push`; an
  `AbortController` for the server signal.
- **GOTCHA**: `port: 0` avoids collisions with a real collector or parallel test files (do NOT bind the
  fixed `42017` in tests). Await the `onListen` port before fetching.
- **VALIDATE**: `npx vitest run apps/collector/src/push/push-server.test.ts` (pass).

### CREATE `apps/collector/src/connectors/claude-live.ts`

- **IMPLEMENT**: `claudeLiveConnector: Connector` — `id: CLAUDE_LIVE_CONNECTOR`,
  `captureMode: "push"`, `watchGlobs: () => []`, `parse: (text) => parseClaudeWire(text)`,
  `push: { origins: ["https://claude.ai"] }`. Fidelity: `status:"experimental"`,
  `captureMethod:"browser-extension-push"`, `liveness:"near-real-time"`, `tokens:"none"`,
  `cost:"none"`, honest `knownGaps` (no tokens → uncosted; conversation-level model only, no
  per-message model; tool_use/thinking blocks not yet mapped; a conversation captured live AND via the
  14.5 export produces two sessions — cross-connector dedup deferred), `requiredPermissions:
  ["Receive claude.ai conversation data pushed by the 420AI browser extension over localhost"]`. Re-export
  `parseClaudeWire`, `CLAUDE_LIVE_CONNECTOR` from `@420ai/shared` (mirror `claude-export.ts`).
- **PATTERN**: `apps/collector/src/connectors/claude-export.ts` (whole file).
- **IMPORTS**: `import { parseClaudeWire, CLAUDE_LIVE_CONNECTOR } from "@420ai/shared";`
  `import type { Connector } from "./connector.js";`
- **VALIDATE**: `npx tsc -b apps/collector` (exit 0).

### UPDATE `apps/collector/src/connectors/connector.ts`

- **ADD**: (1) `"push"` to the `captureMode` union (line 116) with a doc line ("driven by the inbound
  push receiver, no FileWatcher; `watchGlobs` is `[]`"). (2) A `PushCapability` interface after
  `PollCapability` (~line 102): `{ origins: string[]; }` with a doc comment (the human-readable origins
  this connector accepts data from — the approval surface). (3) `push?: PushCapability;` on `Connector`
  (after `poll?`, ~line 136). (4) `import { claudeLiveConnector } from "./claude-live.js";` and append
  it to the `connectors[]` array (line 144–150).
- **PATTERN**: the existing `PollCapability`/`poll?` additions (lines 58–102, 136).
- **GOTCHA**: additive + optional only — every existing connector leaves `push` unset, so the watcher,
  registry, discovery, and engine are byte-identical for them. Update the registry doc comment
  (line 139–143) to mention the `claude-live` push connector.
- **VALIDATE**: `npx tsc -b apps/collector` (exit 0); `npx vitest run apps/collector/src/connectors/registry.test.ts apps/collector/src/connectors/connector.test.ts` (pass — update expected connector counts/ids if the tests assert them).

### UPDATE `apps/collector/src/connectors/connector-approvals.ts`

- **ADD**: fold `push.origins` into `captureSurfaceFingerprint` exactly as `poll.sources` is folded:
  after the `if (c.poll) surface.poll = …` line (67), add `if (c.push) surface.push = [...c.push.origins].sort();`
  and widen the `surface` type to include `push?: string[]`.
- **PATTERN**: line 63–69 (the `poll` fold).
- **GOTCHA**: omit the `push` key entirely for push-less connectors so their fingerprint is
  byte-identical (no re-approval churn for the file connectors) — the `if (c.push)` guard does this.
- **VALIDATE**: `npx vitest run apps/collector/src/connectors/connector-approvals.test.ts` (pass; add a
  case asserting a `push.origins` change flips a recorded connector to `needs-approval`).

### UPDATE `apps/collector/src/capture-engine.ts`

- **IMPLEMENT**: (1) Add `pushPort?: number;` to `CaptureEngineOptions`. (2) In `runCaptureEngine`,
  after the `pollLoops` block (~line 253): compute the enabled push connectors from the already-filtered
  `connectors`, and if non-empty start ONE push server:

  ```ts
  const pushConnectors = connectors.filter((c) => c.push);
  let pushServer: Promise<void> = Promise.resolve();
  if (pushConnectors.length > 0) {
    const { token, created } = loadOrCreatePushToken(home);
    if (created) log(`push receiver token generated: ${token} — paste it into the 420AI browser extension`);
    pushServer = runPushServer(
      { connectors: pushConnectors, queue, token, port: opts.pushPort, log },
      internal.signal,
    );
  }
  ```

  (3) Add `pushServer` to the `Promise.allSettled([...])` unwind (line 257).
- **PATTERN**: the `pollLoops` wiring (lines 247–257) — identical lifecycle (best-effort, not in the
  race, unwinds on `internal.abort()`).
- **IMPORTS**: `import { runPushServer } from "./push/push-server.js";`
  `import { loadOrCreatePushToken } from "./push/push-token.js";`
- **GOTCHA**: the push server binds a fixed default port (`42017`). Because it's best-effort
  (`runPushServer` resolves on `error`, never throws), a port collision degrades gracefully. The token
  is logged ONLY on first creation, and only via the `logger` callback (library files never touch
  stdout directly — the engine's `log`).
- **VALIDATE**: `npx tsc -b apps/collector` (exit 0);
  `npx vitest run apps/collector/src/capture-engine.test.ts` (pass).

### UPDATE `apps/collector/src/capture-engine.int.test.ts` (verify, adjust only if needed)

- **IMPLEMENT**: Read this test. If it runs `runCaptureEngine` with the **real default registry** (now
  containing `claude-live`), it will start the push receiver on `42017`. Either (a) pass `pushPort: 0`
  in the test's engine options (ephemeral, no collision), or (b) inject a connector set without a push
  connector. Prefer (a) if the test uses the default registry. Ensure no test leaves a listener bound
  (the abort at test teardown closes it — verify the test aborts the signal).
- **PATTERN**: the int-test's existing engine invocation + abort/teardown.
- **GOTCHA**: `*.int.test.ts` self-skip without `DATABASE_URL_TEST`; still fix the wiring so the
  `--require-db` run stays green (0 skipped).
- **VALIDATE**: `npm run repo-health -- --require-db` later (Level 3) confirms 0 skipped + green.

### UPDATE `apps/collector/src/cli.ts` (thread `--push-port`)

- **IMPLEMENT**: In `runWatch`'s options add `pushPort?: number;` and pass it into `runCaptureEngine`.
  In the `watch` command handler, read `getFlag(args, "--push-port")` (Number-parse, ignore invalid)
  and pass it; add `[--push-port <port>]` to the `watch` usage line.
- **PATTERN**: how `--interval`/`--heartbeat-interval` are read + threaded (lines 524–547, 172–215).
- **GOTCHA**: optional — absent flag ⇒ engine default `42017`. Keep it minimal; do not add a new
  subcommand.
- **VALIDATE**: `npx tsc -b apps/collector` (exit 0); `npx vitest run apps/collector/src/cli.test.ts apps/collector/src/cli-home.test.ts` (pass).

### CREATE `apps/extension/` (MV3 skeleton, plain JS, Claude-only)

- **IMPLEMENT**:
  - `package.json`: `{ "name": "@420ai/extension", "version": "0.0.0", "private": true, "type": "module",
    "scripts": { "build": "node -e \"process.stdout.write('extension: static assets, nothing to build\\n')\"" } }`
    (NO `test` script — the root owns `test`; a valid `build` keeps `npm run build --workspaces` sane).
  - `manifest.json` (MV3): `manifest_version: 3`, `name: "420AI Chat Capture"`, `version: "0.1.0"`,
    `permissions: ["storage", "alarms"]`,
    `host_permissions: ["https://claude.ai/*", "http://127.0.0.1:42017/*"]`,
    `background: { "service_worker": "src/background.js", "type": "module" }`,
    `options_page: "src/options.html"`.
  - `src/background.js`: on install + a `chrome.alarms` every 1 min, IF enabled + a token is stored:
    1. `GET https://claude.ai/api/organizations` (credentials: same-origin cookies) → first org `uuid`.
    2. `GET /api/organizations/{org}/chat_conversations` → list; select conversations whose
       `updated_at` > the stored `lastSyncIso` (default: the top 10 by `updated_at` on first run).
    3. For each selected conversation, `GET /api/organizations/{org}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true`.
    4. `POST http://127.0.0.1:42017/v1/push` with `Authorization: Bearer <token>` and body
       `{ connector: "claude-live", conversations: [<full conversation objects>] }`.
    5. On a `200`, advance `lastSyncIso` to the max `updated_at` seen; log the response counts.
    Wrap every step in try/catch → never throw out of the alarm handler (best-effort, like the
    collector loops). Store `enabled`, `token`, `collectorUrl` (default `http://127.0.0.1:42017`),
    `lastSyncIso` in `chrome.storage.local`.
  - `src/options.html` + `src/options.js`: a form to paste the push token, set the collector URL, and
    an enable checkbox; a "Test connection" button that POSTs an empty `{connector:"claude-live",
    conversations:[]}` and shows the status. Persist to `chrome.storage.local`.
  - `README.md`: load-unpacked steps (chrome://extensions → Developer mode → Load unpacked →
    `apps/extension`); the token handshake (copy the token the collector logs on first `watch` start
    into the options page); the **drift warning** (these are undocumented claude.ai endpoints; a
    per-origin schema stamp / re-verification is the mitigation).
- **PATTERN**: the verified endpoints are in NOTES (recon). The extension is out of the root `tsc`
  graph (no tsconfig reference); plain JS, no bundler, no npm deps.
- **GOTCHA**: do NOT add `apps/extension` to the root `tsconfig.json` `references`. Do NOT import
  `@420ai/shared` in the extension (it forwards RAW JSON; the collector normalizes) — keeping the
  extension dependency-free and unbundled. The extension must be **consent-gated**: it captures nothing
  until `enabled` is checked in options.
- **VALIDATE**: `node -e "JSON.parse(require('fs').readFileSync('apps/extension/manifest.json','utf8'))"`
  (valid JSON); Level-4 manual load-unpacked (below).

### CREATE `docs/research/extension-spike.md`

- **IMPLEMENT**: Write up the Phase-0 recon (evidence in this plan's NOTES) as a per-origin go/no-go
  gate mirroring `docs/research/chat-capture-spike.md`'s structure: headline verdict; per-surface
  intercept feasibility (Claude GO, ChatGPT GO, Gemini NO-GO-for-intercept → Takeout); the chosen
  capture mechanism (poll the conversation API, not SSE — more robust); the push delivery path
  (localhost `node:http` receiver + shared token); the consent surface (extension opt-in + the §10.4
  approval fold); the drift risk (undocumented endpoints, schema stamp). State the gate outcome:
  **intercept feasible on 2/3 → the spike's "ship export-only if brittle on ≥2/3" gate PASSES; build
  proceeds Claude-first.** Record what's deferred (ChatGPT/Gemini extension origins; SSE; cross-connector
  dedup).
- **PATTERN**: `docs/research/chat-capture-spike.md` (headers, `[verified]`/`[documented]` tags, fidelity
  matrix, recommended slicing).
- **VALIDATE**: `npx prettier --check docs/research/extension-spike.md` (CI lints markdown — see the
  `ci-prettier-checks-markdown` memory; run `prettier --write` if it fails).

### UPDATE `README.md` + `SUMMARY.md` (roadmap truth)

- **IMPLEMENT**: mark 14.7 as shipped in the SUMMARY §0/§3 M14 line and the README roadmap (mirror how
  14.5 was recorded); one line: "14.7 — browser extension (near-real-time Claude web capture) + collector
  `push` capture mode; ChatGPT/Gemini extension origins deferred." Update the M14 slice plan
  (`.agents/plans/m14-general-ai-chat-capture.md`) 14.5+ bullet to note 14.7 shipped.
- **PATTERN**: the 14.5 "shipped" note in `m14-general-ai-chat-capture.md:103–109`.
- **VALIDATE**: `npx prettier --check "**/*.md"` (or rely on the gate's format step).

---

## TESTING STRATEGY

### Unit Tests (no infra — always run under `npm test`)

- `claude-wire.test.ts` — the pure normalizer (fixture-driven; the load-bearing correctness test).
- `push-token.test.ts` — generate/persist/reload; `0o600` (non-win32).
- `push-server.test.ts` — the receiver: `200`+enqueue, dedup no-op, `401`, `400`, `413`, clean shutdown
  on abort (ephemeral `port: 0`).
- `connector-approvals.test.ts` — a `push.origins` drift flips to `needs-approval`; a push-less
  connector's fingerprint is unchanged.
- `registry.test.ts` / `connector.test.ts` — `claude-live` present with `captureMode:"push"`, empty
  globs, a `push` capability.
- `capture-engine.test.ts` — remains green (the push server only starts when a push connector is
  present + is best-effort).

### Integration Tests (`*.int.test.ts`, self-skip without `DATABASE_URL_TEST`)

- No NEW int test is strictly required — push events reach the archive through the **unchanged**
  `queue → syncOnce → /v1/ingest` path already covered by `push.int.test.ts` / ingest int tests. But
  **verify** `capture-engine.int.test.ts` doesn't spuriously bind `42017` (use `pushPort: 0` or a
  non-push injected registry). Optionally add a small int case: enqueue a `parseClaudeWire` result and
  drain it to a real archive, asserting the `claude-live` session appears (reuses existing seed helpers).

### Edge Cases (must be covered)

- Malformed / partial pushed JSON → `parseClaudeWire` returns `skippedLines:1`, receiver still `200`
  with zero counts (never `500` on bad content — tolerant parser).
- Re-POST of an unchanged conversation → queue dedups (no duplicate raw/events) — the idempotency proof.
- Wrong/absent bearer token → `401`, nothing enqueued.
- Conversation with `model: null`/absent → `message.assistant` events carry no `model` (still valid).
- Empty conversation (`chat_messages: []`) → nothing emitted.
- Abort mid-request / at shutdown → server closes, promise resolves, port frees (no leaked listener).

---

## VALIDATION COMMANDS

Every command runs from the **repo root**. Validation is a GATE (CLAUDE.md).

### Level 1: Syntax & Style
- `npm run typecheck` — root `tsc -b` (the FOUR backend workspaces), **exit 0**. (The extension is out
  of this graph by design — it has no TS to check.)
- `npm run lint` — ESLint, **0 errors** (CI runs it; not in repo-health — see the `ci-lint-not-in-repo-health` memory).
- `npx prettier --check "**/*.md"` — CI lints markdown (the `ci-prettier-checks-markdown` memory);
  `prettier --write` then re-check if it fails.

### Level 2: Unit Tests
- `npx vitest run packages/shared/src/parsers/claude-wire.test.ts apps/collector/src/push` — the new
  units pass.
- `npm test` — full `vitest run`; all unit tests pass, integration self-skips cleanly.

### Level 3: Integration Tests (DB-backed — skipped ≠ passed)
- `npm run db:up && npm run db:migrate` (and migrate `420ai_test` — see the
  `test-db-not-migrated-by-db-migrate` memory), then
  `npm run repo-health -- --require-db` — the full gate with the int layer **actually running**
  (asserts 0 skipped). **Must be green** before sign-off (CLAUDE.md "Validation is a GATE").

### Level 4: Manual Validation (the end-to-end proof — a pre-sign-off step)
1. `npm run db:up && npm run db:migrate`; start ingest (`npm run ingest:dev`).
2. Pair a collector home and run `collector watch` — note the **push token** it logs on first start.
3. Load `apps/extension` unpacked in Chrome; open options; paste the token + collector URL; enable.
4. Open/continue a claude.ai conversation; wait one alarm cycle (≤1 min).
5. Confirm: the collector logs `claude-live: N record(s)/event(s)`; the archive has a `claude-live`
   session (`collector` CLI / dashboard / Monitor shows it); token-in-served-HTML == 0 for the
   dashboard (unchanged); the receiver rejects a POST with a bad token (`curl` → `401`).
6. Re-run the alarm with no new messages → no duplicate events (dedup).

### Level 5: Additional Validation (optional)
- `curl.exe` (PowerShell — use `curl.exe` + a file body, per the `powershell-curl-json-gotcha` memory)
  against `http://127.0.0.1:42017/v1/push` to exercise `401`/`400`/`200` without the extension.

---

## ACCEPTANCE CRITERIA

- [ ] `parseClaudeWire` maps the verified wire shape onto the existing taxonomy (session/message events
      only), stamps the conversation `model` on `message.assistant`, stays uncosted, attributes via
      `chat:claude:<uuid>`, and is fingerprint-stable across re-parses.
- [ ] The `push` capture mode receives `{connector, conversations}` over `127.0.0.1`, token-authed,
      routes through `connector.parse`, and enqueues onto the durable queue (dedup idempotent).
- [ ] The push server runs inside `runCaptureEngine` with the poll/git lifecycle (best-effort, abort-wound,
      no leak window) and starts only when a push connector is enabled+approved.
- [ ] `claude-live` connector registered; its `push.origins` fold into the §10.4 approval fingerprint.
- [ ] The MV3 extension (Claude-only, consent-gated) polls the Claude API and forwards raw conversations;
      manual Level-4 pipe proven (`browser → collector → archive`).
- [ ] `docs/research/extension-spike.md` records the per-origin go/no-go gate (Claude GO, ChatGPT GO,
      Gemini NO-GO-for-intercept), with the gate PASS rationale.
- [ ] **No** migration, **no** fingerprint change, **no** control-protocol bump, **no** new backend
      dependency. Chat events stay uncosted.
- [ ] Level 1–3 all green, including `repo-health -- --require-db` with **0 skipped**.
- [ ] README/SUMMARY roadmap updated to mark 14.7 shipped + the deferred origins.

## COMPLETION CHECKLIST

- [ ] All tasks completed in order; each task's VALIDATE passed immediately.
- [ ] Full gate green (`npm run repo-health -- --require-db`, `npm run lint`, markdown prettier).
- [ ] Manual Level-4 end-to-end pipe verified + screenshotted into `.agents/qa/` (or noted as a
      maintainer pre-sign-off step if a live Chrome isn't available in the execution environment).
- [ ] No regressions; additive-only on the capture core.

---

## NOTES

### Spikes actually RUN during planning (the evidence behind the confidence score)

**All recon below was executed live during planning** via Chrome automation against the maintainer's
own logged-in sessions (read-only — no messages sent, no mutations; structural shape only, content
redacted). This retired the one gating unknown (intercept feasibility) BEFORE the plan was written.

1. **Claude web — GO (verified).** `GET /api/organizations` → 2 orgs, first `uuid` present.
   `GET /api/organizations/{org}/chat_conversations` → array of **70** conversations; item keys:
   `uuid, name, summary, model, created_at, updated_at, settings, is_starred, project_uuid, session_id,
   platform, current_leaf_message_uuid, user_uuid, project`.
   `GET /api/organizations/{org}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true`
   → full conversation; top keys include `uuid, name, model, created_at, updated_at, chat_messages`.
   **Message keys:** `uuid, text, content, sender, index, created_at, updated_at, truncated, stop_reason,
   attachments, files, sync_sources, parent_message_uuid`. `content[]` block `type`s observed:
   `thinking, tool_use, tool_result, text`. **Per-message `model`: ABSENT.** **Conversation-level
   `model`: PRESENT.** **Tokens/usage: ABSENT anywhere** (`/token|usage/i` over a message = false).
   → Conversations are fully recoverable via a same-origin authenticated GET; the shape is
   near-identical to the 14.5 export, so `parseClaudeExport` is a faithful template. The robust capture
   path is **polling this API** (no fragile SSE/DOM interception needed).
2. **ChatGPT web — GO (verified).** Logged in; `GET /api/auth/session` → `accessToken`.
   `GET /backend-api/conversations?offset=0&limit=3&order=updated` → items with `id, title, create_time,
   update_time, mapping, current_node, …`. `GET /backend-api/conversation/{id}` → full `mapping` tree
   (23 nodes) with conversation `default_model_slug` and per-message `metadata.model_slug`. Richest of
   the three; **deferred to a later slice** (this slice ships Claude only), documented in the gate.
3. **Gemini web — NO-GO for intercept (verified).** App loads; no clean REST/JSON conversation API;
   Gemini uses Google's obfuscated `batchexecute` RPC (no stable per-message schema). → intercept is
   brittle; the path stays **Takeout export = 14.6**.

**Gate math:** intercept feasible on **2 of 3** origins → the 14.0 spike's rule ("ship export-only if
wire-interception is brittle on ≥2 of 3") **PASSES** — only Gemini is brittle. Build proceeds
Claude-first.

### Symbols verified by reading source (no from-memory imports)

`Connector`/`PollCapability`/`captureMode` (connector.ts:58–137); `pollLoop` enqueue + engine unwind
(capture-engine.ts:136–176, 247–282); `QueueStore.enqueue` dedup-by-content-hash (queue-store.ts:111–132);
`captureSurfaceFingerprint` poll fold (connector-approvals.ts:63–69); `saveCredentials`/`0o600`/
`collectorHomeFor` (identity.ts:32, 55–72); `runWatch`/`watch` flag threading (cli.ts:172–215, 524–549);
`toRawRecordPayload`/`toEventPayload` + `eventFingerprint` usage (capture-engine.ts:2, claude-export.ts:2,140);
the barrel (index.ts:1–27); the export parser + its test harness (claude-export.ts, claude-export.test.ts).
`serve.ts` confirmed **stdio-only** (no HTTP) → the receiver is genuinely new.

### Key design decisions & trade-offs

- **Parse on the collector, not the extension.** The extension forwards RAW conversation JSON; the
  collector normalizes via `connector.parse`. Keeps the extension trivially thin + dependency-free, and
  makes the raw conversation the **sacred, re-parseable** record (the D-M13-2 lesson, applied day one).
- **Reuse `connector.parse(fileText)` for push** — no new parse seam. The receiver just `JSON.stringify`s
  the `conversations` array and calls the connector's existing `parse`. Idempotency comes free from the
  durable queue's content-hash dedup (same as poll).
- **`push` server lives in the engine, not `serve.ts`.** Both `runWatch` and the sidecar reach the
  engine, so both get push with **zero control-protocol change**. It starts only for enabled+approved
  push connectors (inherits `serve.ts`'s filtering).
- **`127.0.0.1` + shared token.** The receiver is never LAN-exposed; a random localhost process can't
  push without the `0o600` token. Honest, standard dev-tool posture.
- **`near-real-time` liveness (poll the API), not `streaming`.** The 1-min `chrome.alarms` floor + the
  poll design make `streaming` a false claim; `near-real-time` is the honest label (Q2 discipline).
- **Known gap (documented, not resolved):** the same conversation captured live (`claude-live`) AND via
  the 14.5 export (`claude-export`) yields **two** sessions (different `sourceConnector` → different
  fingerprints, same `sessionId`). Cross-connector dedup is deferred; the shared `chat:claude:<uuid>`
  attribution key keeps them grouped in the UI.

### Confidence

**9.4 / 10.** The single gating unknown (per-origin intercept feasibility) was **run live and retired**
during planning (2 of 3 GO, gate passes). Every referenced symbol was read, not remembered. The backend
work is **purely additive over proven seams** (parse contract, queue enqueue, poll-loop lifecycle,
approval fold) — no fingerprint/migration/protocol/dependency change — so the `repo-health` gate has a
clear path to green. Residual deductions (why not 10): (a) the extension is validated by **manual
load-unpacked only** — inherent to browser extensions, and honestly flagged as a Level-4/pre-sign-off
step; (b) the Claude API endpoints are **undocumented** and can drift — mitigated by the tolerant parser
+ the spike's schema-stamp/drift warning, and not on the `repo-health` path. Neither residual risk can
be retired by more reading/spiking, and neither blocks the automated gate.
