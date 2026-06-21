# Feature: M12 Slice 12.7d — Resolve the Cursor + Antigravity connector research gates

> **This is a GATE-RESOLUTION REPORT, not an implementation plan.** PRD §25 M12.7 scopes Cursor +
> Antigravity as _"ship if feasible, **never block GA**."_ Per that mandate, this slice's deliverable is
> a **feasibility verdict backed by a live capture-surface spike** — and the verdict is **DEFER BOTH to a
> dedicated post-GA slice (V2)**. The research gate is now **closed**: we know exactly what is on disk,
> where, and what it would take. The two connectors do **not** block M12 GA sign-off.
>
> Conventions: see [`CLAUDE.md`](../../CLAUDE.md) (process boundaries, connector framework, capture core)
> and [`SUMMARY.md`](../../SUMMARY.md) §3–4. New connectors merge through
> `apps/collector/src/connectors/registry.ts` and reuse the unchanged capture core — **no fingerprint
> change, no server code, no migration** (a connector is client-side `parse` only).

## TL;DR Verdict

| Connector       | Local data exists? | Token/cost fidelity            | Blocker                                                              | Recommendation                                              |
| --------------- | ------------------ | ------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Cursor**      | **YES** (rich)     | **Partial** (sparse + aggregate) | `Connector.parse(fileText)` is text/file-based; Cursor is **SQLite (WAL)** → needs a new **poll/query capture mode** (framework extension) | **DEFER to a dedicated "SQLite poll connector" slice (V2).** Now de-risked — data located & schema mapped. |
| **Antigravity** | YES (binary)       | **None** (PRD-confirmed)       | Conversations are **schema-less binary protobuf** (`.pb`); actions-only, no token/cost | **DEFER / drop to research-gated V2.** Lowest value for a cost-intelligence platform; highest decode effort. |

Neither is a thin "bolt-on during hardening" item. **Cursor is genuinely valuable but needs a capture-
framework extension** (it should be its own slice). **Antigravity is low-value + high-effort** (binary
protobuf, no cost data) and should stay gated or be dropped from V1/V2 scope.

---

## Spike evidence (run live on this Windows machine, 2026-06-20)

All findings below come from read-only `node:sqlite` (`DatabaseSync(..., { readOnly: true })`) and
filesystem inspection. Throwaway scripts were run inline and not committed.

### Cursor — chat history IS locally recoverable

**Primary chat store:** `%APPDATA%\Cursor\User\globalStorage\state.vscdb` (a VS Code-style SQLite DB;
**WAL mode** — `state.vscdb-wal`/`DIPS-wal` present alongside). Two tables:

- `ItemTable` (453 rows, `key`/`value`) — app/global settings. **Contains SECRETS**:
  `cursorAuth/accessToken`, `cursorAuth/refreshToken`, `secret://{...}mcp_tokens`. A connector MUST
  **never** read these keys.
- `cursorDiskKV` (49,648 rows, `key`/`value`) — the conversation store:
  - **`bubbleId:<composerId>:<bubbleId>`** = **22,368 rows** (22,342 are JSON objects; 26 are JSON
    `null`). Each bubble is one message. `type`: **1 = user (900)**, **2 = assistant (21,442)**.
    Top-level keys include: `text` (non-empty in **7,486** bubbles — much content lives in
    `codeBlocks`/`toolFormerData`/`toolResults` instead), `tokenCount` (`{inputTokens, outputTokens}`),
    `requestId`, `usageUuid`, `capabilities`, `attachedFileCodeChunks*`, `gitDiffs`, `commits`. **No
    `model` field on bubbles** (0 of 22,342).
  - **`composerData:<composerId>`** = **383 rows** = conversation/session metadata. Keys include
    `createdAt`, `name`, `modelConfig` (← the model lives here), `usageData`, `contextTokensUsed`,
    `contextTokenLimit`, `promptTokenBreakdown`, `workspaceIdentifier`, `trackedGitRepos`,
    `subComposerIds`, and **secrets** `blobEncryptionKey`, `speculativeSummarizationEncryptionKey`.

**Token fidelity = PARTIAL (not zero, not exact):** non-zero bubble `tokenCount` in only **606 of
22,368** bubbles, but the aggregate is real — **sumInput = 55,092,856**, **sumOutput = 4,239,158**,
maxBubble = 372,136. Richer aggregate token fields exist at the **composer** level
(`contextTokensUsed`, `promptTokenBreakdown`, `usageData`). So a Cursor connector would map **partial,
locally-present token data**, label `tokens: "estimated"` / `cost: "computed"` with honest `knownGaps`,
and carry the model from `composerData.modelConfig`.

**Provenance DB (confirms PRD "code-provenance only"):**
`~/.cursor/ai-tracking/ai-code-tracking.db` (6.6 MB SQLite) — tables: `ai_code_hashes` (1,746 rows:
`hash, source, fileExtension, fileName, requestId, conversationId, timestamp, createdAt, model`; model =
`composer-2.5`), `scored_commits` (98 rows: per-commit AI-vs-human line attribution — _interesting for
future Git-outcome attribution, out of scope here_), `tracking_state` (1), `conversation_summaries` (0,
**empty**), `tracked_file_content` (0), `ai_deleted_files` (0). **No message bodies, no token/cost.** As
the PRD said: provenance, not conversation.

**Why Cursor cannot be a drop-in connector (the real blocker):** the `Connector` contract is
**text/file-based** — `parse(fileText: string)` plus the byte-offset `tail` / whole-file `snapshot`
capture modes (`apps/collector/src/connectors/connector.ts`). A WAL-mode SQLite DB **cannot be handed to
`parse` as text**, and "last event" liveness here is **snapshot/poll** (§10.1.1: re-query newer rows on
an interval), which **no existing capture mode implements**. So Cursor requires a **new capture path** —
open the DB by path (read-only), query bubbles/composers newer than a stored cursor (rowid or
`createdAt`), serialize to the normalized event model — i.e. a **framework extension**, not an additive
connector object. That is exactly why it belongs in its own slice, not in "hardening."

### Antigravity — binary protobuf, no token/cost

Multiple installs on disk: `~/.gemini/antigravity{,-backup,-cli,-ide}`, `%LOCALAPPDATA%\antigravity`,
`%APPDATA%\Antigravity`, `%APPDATA%\Antigravity IDE`. Conversations:
`~/.gemini/antigravity/conversations/*.pb` = **20 files**, **binary protobuf** (`file` →
`data`; first 200 bytes are non-printable). Only `*.pbtxt` (8 files: `annotations/`,
`antigravity_state.pbtxt`) are text protobuf — state/annotations, **not** the conversations. No `.proto`
schema is shipped. PRD §10.1: _"rich tool-action trace but **no token/cost**; some protobuf state …
Experimental — actions-only possible."_ Confirmed.

> Note: `%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb` also exists (Antigravity is itself a
> VS Code fork), so _some_ chat may sit in a Cursor-like SQLite store — but the canonical conversation
> records are the binary `.pb` files, and even fully decoded they yield **actions-only, no cost/token**.
> Decoding schema-less binary protobuf for the platform's _least_ valuable connector is a poor trade.

---

## Recommendation (per connector)

### Cursor → DEFER to a dedicated **"Cursor SQLite poll connector"** slice (post-GA / V2)

The research gate is **closed** and the work is **de-risked** (we know the DB, tables, keys, token
coverage, and secret-key hazards). It is deferred only because it needs a **capture-framework
extension**, which is too much to absorb under GA hardening without risking the frozen capture core.

**Proven design sketch for that future slice (high-confidence starting point):**

1. **Extend the capture framework with a `poll`/`query` capture mode** (additive third value beside
   `tail`/`snapshot` in `connector.ts`), OR give the Cursor connector a self-contained reader that opens
   the SQLite DB read-only and emits normalized events — keeping the byte-offset tailer untouched
   (mirror how Gemini's `snapshot` mode was added additively in M4 without disturbing `tail`).
2. **Read-only `node:sqlite`** (`DatabaseSync(path, { readOnly: true })`, already a Node 24 built-in used
   across this repo) against `%APPDATA%\Cursor\User\globalStorage\state.vscdb`. Handle **WAL** (open
   read-only; do not checkpoint). Cursor by `composerData.createdAt` / max bubble rowid so restarts
   resume (the durable-queue + per-file-cursor discipline, adapted to a row cursor).
3. **Map** `composerData:<id>` → `session.started`/`session.ended` (+ `name`, `modelConfig` model,
   `workspaceIdentifier` for attribution); `bubbleId:<id>:<b>` `type:1/2` →
   `message.user`/`message.assistant`; `toolFormerData`/`toolResults` → `tool.call.*`; `tokenCount` +
   composer aggregates → `usage.estimated`/`cost.estimated` with **partial** confidence.
4. **Fidelity label:** `status: "experimental"`, `liveness: "snapshot"`, `tokens: "estimated"`,
   `cost: "computed"`, `knownGaps: ["token counts present on only ~3% of message bubbles; rely on
   composer-level aggregates", "model from composerData.modelConfig, absent on bubbles", "snapshot/poll
   liveness — not streaming"]`.
5. **Secret safety (load-bearing):** read **only** `cursorDiskKV` `bubbleId:`/`composerData:` rows.
   **Never** read `ItemTable` `cursorAuth/*` or `secret://*`, and drop `blobEncryptionKey` /
   `speculativeSummarizationEncryptionKey` from composer payloads before they reach the queue. The M8
   redaction engine is a backstop, not the primary guard — scope the query to exclude secrets.
6. Merge through `registry.ts`; **no fingerprint/server/migration change** (client-side `parse` only).

**Exact unblock decision for the future slice:** _"Add a `poll` capture mode to the connector framework,
or let a connector own a non-text reader?"_ — that single architecture call is all that stands between
this report and a ≥9.3 implementation plan.

### Antigravity → DEFER / keep research-gated (recommend dropping from near-term scope)

Binary protobuf conversations with **no shipped schema** and **no token/cost data** make this the
highest-effort, lowest-value connector for a cost/token-intelligence product. **Recommendation: do not
build for V1/V2 GA.** Revisit only if (a) Antigravity adds token/cost telemetry, or (b) its
`%APPDATA%\Antigravity IDE\...\state.vscdb` is later confirmed to hold recoverable chat — in which case
it folds into the same "SQLite poll connector" framework as Cursor.

**Exact unblock spike (if ever revisited):** inspect `%APPDATA%\Antigravity IDE\User\globalStorage\
state.vscdb` with the same `node:sqlite` schema probe used here; if it mirrors Cursor's `cursorDiskKV`
shape, Antigravity-IDE becomes a near-free addition to the Cursor connector. The binary `.pb` path stays
out of scope (schema-less).

---

## Impact on M12 GA sign-off

**None — this is the point of the gate.** PRD §25 M12.7: Cursor + Antigravity _"ship if feasible, never
block GA."_ This report **resolves the research gate** (feasibility known, both deferred with documented
rationale), so M12.7 can sign off on the other three sub-slices (12.7a failure classification, 12.7b
permission scopes, 12.7c connector-catalog-as-data) without these two. Update `SUMMARY.md` §6 / PRD §25
to mark 12.7d **resolved → deferred (Cursor to a dedicated V2 slice; Antigravity dropped/gated)**.

---

## NOTES — spikes actually run (evidence)

- **Filesystem sweep** — confirmed on disk: `%APPDATA%\Cursor\` (full VS Code profile),
  `%APPDATA%\Cursor\User\globalStorage\state.vscdb` + **89** `workspaceStorage/*/state.vscdb`,
  `~/.cursor/{chats,projects,ai-tracking}\`, `~/.gemini/antigravity{,-backup,-cli,-ide}\`,
  `%LOCALAPPDATA%\antigravity\`, `%APPDATA%\Antigravity{, IDE}\`.
- **`node:sqlite` schema probe (read-only)** of `Cursor/User/globalStorage/state.vscdb` →
  `ItemTable` (453) + `cursorDiskKV` (49,648); 24,825 chat-ish keys; 22,368 `bubbleId:` rows
  (type 1=900 / 2=21,442); 383 `composerData:` rows. Secret keys (`cursorAuth/*`, `secret://*`,
  `blobEncryptionKey`) observed and flagged.
- **Token-fidelity scan** — non-zero bubble `tokenCount` in **606/22,368**; aggregate sumInput
  55,092,856 / sumOutput 4,239,158; **model absent on all bubbles** (lives in `composerData.modelConfig`;
  `ai_code_hashes.model = composer-2.5`).
- **`ai-code-tracking.db` probe** — 6 tables; only `ai_code_hashes` (1,746) + `scored_commits` (98)
  populated; `conversation_summaries`/`tracked_file_content`/`ai_deleted_files` **empty**. No bodies, no
  token/cost → provenance-only, as PRD predicted.
- **Antigravity format check** — `conversations/*.pb` = 20 binary protobuf files (`file` → `data`,
  non-printable header); `*.pbtxt` (8) are state/annotations only; no `.proto` schema present.
- **Confidence:** the **defer recommendation** is high-confidence (direct disk evidence). A future Cursor
  _implementation_ plan is not yet written because it hinges on one architecture decision (poll capture
  mode) — named above as the single unblock.
