# Spike: Browser-extension intercept feasibility (M14 slice 14.7)

**Date:** 2026-07-20 · **Machine:** the primary Windows 11 dev machine (same recon host as
`chat-capture-spike.md`) · **Method:** read-only Chrome automation against the maintainer's own
logged-in sessions — structural shape only (message ids/keys), content redacted, **no messages
sent, no mutations**. Items marked **[verified]** were observed live during planning; the recon
retired the one gating unknown (per-origin intercept feasibility) **before** the plan was written.

This is the per-origin **go/no-go gate** the 14.0 chat-capture spike deferred to 14.7
(`chat-capture-spike.md` §"Recommended slicing", item 3). The 14.0 spike established that **no**
chat surface persists a local conversation store, so near-real-time capture requires a browser
extension reading each app's own authenticated API.

## Headline verdict

**Intercept is feasible on 2 of 3 surfaces via the app's own conversation API — no fragile
SSE/DOM interception needed.** The 14.0 spike's rule ("ship export-only if wire-interception is
brittle on ≥2 of 3 origins") **PASSES**: only Gemini is brittle. **Build proceeds Claude-first.**

| Surface     | Intercept verdict            | Mechanism                                     | Model                      | Tokens |
| ----------- | ---------------------------- | --------------------------------------------- | -------------------------- | ------ |
| Claude web  | **GO** [verified]            | authenticated REST conversation API           | conversation-level         | ✗      |
| ChatGPT web | **GO** [verified] — deferred | `/backend-api` REST + `mapping` tree          | conversation + per-message | ✗      |
| Gemini web  | **NO-GO for intercept** [v]  | obfuscated `batchexecute` RPC, no stable JSON | ✗                          | ✗      |

This slice ships **Claude only**. ChatGPT is a verified GO documented here for a later slice;
Gemini's path stays the Takeout export (14.6).

## Per-surface findings

### Claude web (claude.ai) — GO [verified]

- `GET /api/organizations` → 2 orgs; first `uuid` present.
- `GET /api/organizations/{org}/chat_conversations` → array of **70** conversations. Item keys:
  `uuid, name, summary, model, created_at, updated_at, settings, is_starred, project_uuid,
session_id, platform, current_leaf_message_uuid, user_uuid, project`.
- `GET /api/organizations/{org}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true`
  → full conversation. Top keys include `uuid, name, model, created_at, updated_at, chat_messages`.
  Message keys: `uuid, text, content, sender, index, created_at, updated_at, truncated,
stop_reason, attachments, files, sync_sources, parent_message_uuid`. `content[]` block `type`s
  observed: `thinking, tool_use, tool_result, text`.
- **Per-message `model`: ABSENT. Conversation-level `model`: PRESENT. Tokens/usage: ABSENT anywhere.**
- Conversations are fully recoverable via a same-origin authenticated GET; the shape is
  near-identical to the 14.5 export, so `parseClaudeExport` is a faithful template for
  `parseClaudeWire`. The robust capture path is **polling this API** (no SSE/DOM interception).

### ChatGPT web (chatgpt.com) — GO [verified], deferred to a later slice

- `GET /api/auth/session` → `accessToken`.
- `GET /backend-api/conversations?offset=0&limit=3&order=updated` → items with `id, title,
create_time, update_time, mapping, current_node, …`.
- `GET /backend-api/conversation/{id}` → full `mapping` tree (23 nodes) with conversation
  `default_model_slug` and **per-message `metadata.model_slug`** (richest of the three).
- Deferred: this slice ships Claude only; the ChatGPT extension origin + a `chatgpt-live`
  connector are a later slice (the `mapping`-tree parser is a distinct, larger normalizer).

### Gemini web (gemini.google.com) — NO-GO for intercept [verified]

- App loads, but there is no clean REST/JSON conversation API. Gemini uses Google's obfuscated
  `batchexecute` RPC with no stable per-message schema. Interception is brittle by construction.
- Path stays the **Google Takeout export = slice 14.6** (thinnest fidelity; ship-if-feasible).

## Chosen capture mechanism — poll the API, not SSE

Two candidate intercept layers existed (14.0 spike): (a) read the app's conversation JSON via its
own authenticated API; (b) intercept the SSE/streaming response of an in-flight turn. **(a) wins**:
the conversation API returns the whole, settled conversation (stable ids + timestamps) on demand,
where SSE is a partial, mid-stream frame format that changes without notice and misses everything
sent while the extension wasn't listening. Polling on the `chrome.alarms` 1-minute floor is the
honest **`near-real-time`** liveness label (not `streaming` — a false claim under polling).

## Push delivery path — localhost `node:http` receiver + shared token

- The extension forwards **raw** conversation JSON (it never parses); the collector normalizes via
  the connector's existing `parse` seam. The raw conversation stays the **sacred, re-parseable**
  record (D-M13-2 applied day one), and the extension stays trivially thin + dependency-free.
- Delivery is a new **`push` capture mode**: a `127.0.0.1`-bound, token-authed `node:http` receiver
  (`apps/collector/src/push/push-server.ts`) running inside `runCaptureEngine` beside the
  poll/git loops (same abort-signal lifecycle, same leak-window discipline). It routes
  `{connector, conversations}` through `connector.parse` and enqueues onto the **unchanged**
  durable queue → sync worker → `/v1/ingest` → `events` table. **No fingerprint, migration,
  control-protocol, or dependency change.**
- Idempotency comes free from the queue's content-hash dedup: re-pushing an unchanged conversation
  is a no-op (exactly like poll-mode re-observation).

> **Note on the 14.0 spike's wording:** it said the extension would "POST to the collector's
> existing local HTTP server (`serve.ts`)." That is **inaccurate** — `serve.ts` is a **stdio**
> control-protocol server for the Tauri sidecar; there was no HTTP listener in the collector. This
> slice builds the receiver the 14.0 spike presumed existed.

## Consent surface

- The extension is **opt-in per install**: it captures nothing until `enabled` is checked and a
  push token is stored (the options page).
- The connector's capture surface (`push.origins = ["https://claude.ai"]`) folds into the §10.4
  approval fingerprint (`captureSurfaceFingerprint`), exactly as `poll.sources` does — so a future
  origin change gates on `connectors.approve`. This rides the 12.7b approval-gate discipline the
  14.0 spike required for "an extension reading chat pages is a Capture Surface Change."

## Drift risk (undocumented endpoints)

The claude.ai endpoints above are **undocumented** and can drift without notice. Mitigations:

- The pure `parseClaudeWire` normalizer is **tolerant**: a wrong-shape conversation is skipped
  (counted in `skippedLines`), never mis-parsed into bad events; a malformed body returns zero
  counts, never a 500.
- A per-origin **schema re-verification** ritual (re-run this recon, update
  `sample-claude-wire.json`, bump the connector's `testedVersions`/`knownGaps`) is the documented
  response to drift — recorded in the extension README. Do not guess new fields.

## Gate outcome & what's deferred

**Intercept feasible on 2/3 → the 14.0 spike's "ship export-only if brittle on ≥2/3" gate PASSES**
(only Gemini is brittle). Build proceeds Claude-first.

**Deferred (documented, not resolved here):**

- ChatGPT extension origin + `chatgpt-live` connector (verified GO; the `mapping`-tree parser is a
  later slice).
- Gemini extension origin (NO-GO for intercept → Takeout export = 14.6).
- SSE/streaming interception (the poll-the-API path is more robust).
- Cross-connector dedup of `claude-live` vs `claude-export` (one conversation captured both ways →
  two sessions, same `chat:claude:<uuid>` key → grouped in the UI; a known gap).
- A bundled/signed Web Store distribution + code signing (parked, per the M12/M14 non-goals) — the
  extension is loaded unpacked.
