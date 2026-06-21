# Connector Capture Spike — Findings

**Date:** 2026-06-13
**Type:** Read-only reconnaissance of AI coding-tool data stores on the dev machine (Windows).
**Goal:** For each MVP connector, determine: location, format, extractable fields, **whether
tokens/cost/model are recorded**, append/liveness behavior, and project-attribution signals.
This validates feasibility before any product code and seeds the connector catalog (PRD §10.3).

> **Method:** Inspected real session files under `~/.claude`, `~/.codex`, `~/.gemini`,
> `~/.cursor`. Extracted record structure and usage/model field shapes only — not sensitive
> message content.

---

## Headline findings

1. **All three required connectors (Claude Code, Codex CLI, Gemini CLI) record exact token
   usage + model + tool calls.** Fidelity is high. Capture is very feasible.
2. **None of them record cost** — only tokens. So cost is _always computed_ by us from
   tokens × catalog pricing. This strongly validates the Q6 pricing ladder: "reported cost"
   will be rare; "estimated from known model pricing" is the normal path, and because tokens
   are _exact_, those estimates are high quality.
3. **Claude Code & Codex & Gemini CLI = append/per-session files → tailable (near-real-time).**
4. **Antigravity** records rich tool actions but **no tokens/cost** → keep research-gated.
5. **Cursor's `~/.cursor` DB is NOT a conversation store** — it only tracks AI-authored code
   provenance (file hashes). Real Cursor chat history lives in VS Code-style storage
   (`%APPDATA%\Cursor\...`), not yet inspected → research-gated, needs follow-up.

---

## Per-connector findings

### ✅ Claude Code — REQUIRED — fidelity: HIGH

- **Location:** `~/.claude/projects/<cwd-slug>/<uuid>.jsonl` (one file per session; slug is the
  encoded working directory, e.g. `C--Users-seanr-OneDrive-Documents-420AI`).
- **Format:** append-only **JSONL**. Record types: `user`, `assistant`, `system`,
  `attachment`, `last-prompt`, `queue-operation`, `file-history-snapshot`, `ai-title`.
- **Per-record metadata:** `sessionId`, `timestamp`, `uuid`, `parentUuid`, `cwd`, `gitBranch`,
  `version`, `entrypoint`, `isSidechain`, `userType`.
- **Tokens (exact, every assistant record):**
  ```
  usage: { input_tokens, output_tokens,
           cache_creation_input_tokens, cache_read_input_tokens,
           server_tool_use: { web_search_requests, web_fetch_requests },
           service_tier, iterations[...] }
  ```
- **Model:** present on every assistant record. **Cost:** not recorded → compute.
- **Bonus:** `cwd` + `gitBranch` on every record → project attribution and Git-outcome linking
  are essentially free. This is the best connector — build it first (walking skeleton).

### ✅ Codex CLI — REQUIRED — fidelity: HIGH

- **Location:** `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (date-partitioned) +
  `~/.codex/history.jsonl`.
- **Format:** append-only **JSONL**; each line is `{ timestamp, type, payload }`. Payload types:
  `session_meta`, `turn_context`, `user_message`, `agent_message`, `reasoning`, `token_count`,
  `function_call(_output)`, `custom_tool_call(_output)`, `patch_apply_end`, `web_search_call/end`,
  `task_started/complete`, `compacted`/`context_compacted`, `turn_aborted`, `tool_search_call`.
- **Tokens (exact, in `token_count` records — 1031 in one session):**
  ```
  total_token_usage / last_token_usage:
    { input_tokens, cached_input_tokens, output_tokens,
      reasoning_output_tokens, total_tokens }
  model_context_window: <n>
  ```
- **Model:** in `turn_context` (e.g. `gpt-5.4`). **Cost:** not recorded → compute.
- **Bonus:** `patch_apply_end` (diffs applied), `function_call`/`custom_tool_call` with outputs,
  `turn_aborted` → excellent for tool-failure classification and Git-outcome signals.

### ✅ Gemini CLI — REQUIRED — fidelity: HIGH

- **Location:** `~/.gemini/tmp/<projectHash>/chats/session-<ts>-<id>.json` (one JSON per session)
  - `~/.gemini/tmp/<projectHash>/logs.json`.
    _(Note: `~/.gemini/antigravity-cli/...` is a separate product — see Antigravity below.)_
- **Format:** single **JSON** object per session: `{ sessionId, projectHash, startTime,
lastUpdated, messages[] }`. Messages are `user` / `gemini` typed.
- **Tokens (per assistant message):**
  ```
  tokens: { input, output, cached, thoughts, tool, total }
  ```
- **Model:** per message (e.g. `gemini-3-flash-preview`). **Cost:** not recorded → compute.
- **Bonus:** `thoughts[]` (reasoning), `toolCalls[]` with `args`, `result`, `status`
  (success/error), `displayName` → strong tool-call + failure capture. `projectHash` maps to
  project (hash of the project path).
- **Liveness caveat:** it's one JSON object rewritten as the session grows (not append-only
  lines), so tailing means re-reading + diffing the file, or capturing on session
  update/close — slightly less clean than JSONL but still near-real-time via file-watch.

### ⚠️ Antigravity — STRETCH (research-gated) — fidelity: MEDIUM (actions) / LOW (cost)

- **Location:** `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl`
  & `transcript_full.jsonl`; IDE variant under `~/.gemini/antigravity-ide/...`. Also protobuf
  state (`.pb`, `.pbtxt`).
- **Format:** **JSONL** action trace. Record types: `USER_INPUT`, `PLANNER_RESPONSE`,
  `VIEW_FILE`, `LIST_DIRECTORY`, `GREP_SEARCH`, `RUN_COMMAND`, `CODE_ACTION`, `ERROR_MESSAGE`,
  with `step_index`, `source`, `status`, `created_at`, `content`, `tool_calls`, `thinking`.
- **Gap:** **no token/usage/model/cost** in records inspected. Rich for _what the agent did_,
  poor for _what it cost_. Some state is protobuf (needs the tool's schema to decode → brittle).
- **Verdict:** confirms the research gate. Could ship as an "actions only, no cost" connector
  later; do not block MVP on it.

### ⚠️ Cursor — STRETCH (research-gated) — fidelity: LOW (from `~/.cursor`)

- **Location inspected:** `~/.cursor/ai-tracking/ai-code-tracking.db` (SQLite).
- **Schema:** single table `ai_code_hashes(hash, source, fileExtension, fileName, requestId,
conversationId, timestamp, createdAt, model)` — **0 rows** on this machine.
- **Finding:** this is a **code-provenance tracker** (which files/lines came from AI), _not_ a
  conversation store. No prompts, outputs, or tokens. Full Cursor chat history is in VS
  Code-style storage (`%APPDATA%\Cursor\User\...\state.vscdb` / workspaceStorage), **not yet
  inspected.**
- **Verdict:** research-gated. **Follow-up:** locate and inspect `%APPDATA%\Cursor` before
  committing to a Cursor connector.

---

## Feasibility matrix (PRD §10.3 fidelity fields)

| Field               | Claude Code       | Codex CLI            | Gemini CLI         | Antigravity          | Cursor            |
| ------------------- | ----------------- | -------------------- | ------------------ | -------------------- | ----------------- |
| **Status**          | Stable (required) | Stable (required)    | Stable (required)  | Experimental (gated) | Planned (gated)   |
| **Capture method**  | Tail JSONL        | Tail JSONL           | Watch+diff JSON    | Tail JSONL           | SQLite poll (TBD) |
| **Tokens**          | ✅ exact          | ✅ exact             | ✅ exact           | ❌                   | ❌ (in this DB)   |
| **Model**           | ✅                | ✅                   | ✅                 | ❌                   | partial           |
| **Cost**            | compute           | compute              | compute            | ❌                   | ❌                |
| **Tool calls**      | ✅                | ✅ (+patches)        | ✅ (+status)       | ✅ rich              | ❌                |
| **Failures**        | stop_reason       | turn_aborted/outputs | toolCall.status    | ERROR_MESSAGE        | ❌                |
| **Project attrib.** | cwd + gitBranch   | session_meta (cwd)   | projectHash        | path                 | fileName          |
| **Real-time level** | Streaming         | Streaming            | Near-real-time     | Batch/partial        | Snapshot          |
| **Known gaps**      | none material     | none material        | rewrite-not-append | no cost; protobuf    | not a chat store  |

---

## Cross-connector normalization note

Each tool uses its **own token schema**. The normalizer must map all to one shape, e.g.:

| Common field    | Claude                        | Codex                     | Gemini     |
| --------------- | ----------------------------- | ------------------------- | ---------- |
| `input_tokens`  | `input_tokens`                | `input_tokens`            | `input`    |
| `output_tokens` | `output_tokens`               | `output_tokens`           | `output`   |
| `cache_read`    | `cache_read_input_tokens`     | `cached_input_tokens`     | `cached`   |
| `cache_write`   | `cache_creation_input_tokens` | —                         | —          |
| `reasoning`     | (in iterations)               | `reasoning_output_tokens` | `thoughts` |
| `tool_tokens`   | `server_tool_use.*`           | —                         | `tool`     |
| `total`         | (sum)                         | `total_tokens`            | `total`    |

> Define this mapping once in the shared types package; every connector parser targets it.

---

## What this confirms / changes

- **Q1 (capture):** Confirmed feasible. Build order: **Claude Code first** (richest + free Git
  context), then Codex, then Gemini.
- **Q2 (liveness):** JSONL tail for Claude/Codex = streaming; Gemini = watch+diff
  (near-real-time, slightly more work). Labels in matrix above.
- **Q3 (MVP criteria):** All three required connectors verified high-fidelity → criteria are
  achievable as reworded.
- **Q6 (pricing):** **Reinforced.** No tool reports cost; all report exact tokens. Cost = tokens
  × catalog pricing, confidence "estimated-model-known." Pricing table must cover at least:
  Claude (Opus/Sonnet/Haiku + cache tiers), `gpt-5.4` (+ reasoning + cached), `gemini-3-flash`
  (+ thoughts/cached). **Cache and reasoning tokens are priced differently — the pricing model
  must handle token _sub-types_, not just input/output.**
- **New:** Add a **token sub-type** dimension (input / output / cache-read / cache-write /
  reasoning / tool) to the cost model — a flat input/output split would under/over-count.

## Open follow-ups

- [ ] Inspect `%APPDATA%\Cursor\User\...\state.vscdb` to assess a real Cursor connector.
- [ ] Confirm Codex `session_meta` payload contains `cwd`/git info for attribution.
- [ ] Verify Gemini `projectHash` is a stable hash of the project path (for project mapping).
- [ ] Confirm live append/rewrite behavior by watching a file during an active session.
