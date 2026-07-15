# Spike: General AI Chat capture surfaces (M14 slice 14.0)

**Date:** 2026-07-14 · **Machine:** the primary Windows 11 dev machine (same recon host as
`connector-capture-spike.md`) · **Method:** read-only filesystem recon of app-data and browser
profile stores. Items marked **[verified]** were observed on this machine; items marked
**[documented]** are product behavior known as of early 2026 and MUST be live-verified during
14.5 slice planning (export flows change without notice).

## Headline verdict

**None of the three chat surfaces persist conversations in a local store.** Claude web/desktop,
ChatGPT web, and Gemini web are all server-side apps with thin local caches — there is no
`~/.claude/projects`-equivalent to tail and no `state.vscdb`-equivalent to poll. Capture must
therefore come from one (or both) of:

1. **Official data exports** — batch, user-triggered, email-delivered archives. Feasible NOW on
   the existing connector framework (snapshot-parse, like the Gemini connector). Liveness label:
   **Batch** (the honest label per Q2 — days-stale between exports).
2. **A browser extension** — the only path to near-real-time capture, and the common denominator
   across all three surfaces. A NEW capture/delivery mechanism (see below).

This confirms the PRD §25 anticipation that M14 "likely delivers the deferred browser-extension
capture mechanism" — but exports give a working end-to-end pipe first (thinnest-pipe principle).

## Per-surface findings

### Claude — web (claude.ai) + desktop app

- **[verified]** Desktop app installed at `%APPDATA%\Claude` (Electron). Its claude.ai IndexedDB
  is ~0 KB and Local Storage is ~1.3 MB (settings/identity scale, not conversation scale, on a
  heavy-usage account). Chrome's claude.ai/claude.com IndexedDB: ≤0.3 MB. **No local
  conversation store on either surface.**
- **[documented]** Official export: Settings → Privacy → "Export data" → email link → archive
  containing `conversations.json` + `projects.json` (full message bodies + timestamps;
  **no token counts, no per-message model**).
- **[verified — side-finding, existing-product capture gap]** Claude Code sessions launched
  _from the desktop app_ are written under
  `%APPDATA%\Claude\claude-code-sessions\<uuid>\<uuid>\local_*.json` — OUTSIDE the existing
  connector's `~/.claude/projects` glob. A real session
  file (47 KB) was observed. **Filed for 14.5 planning:** likely a cheap `watchGlobs` extension
  to the existing Claude Code connector, not a chat-capture item (format inspection needed —
  it is JSON, not JSONL).
- **[verified]** `%APPDATA%\Claude\ChromeNativeHost\` ships `chrome-native-host.exe` +
  `com.anthropic.claude_browser_extension.json` — Anthropic's own extension↔desktop
  native-messaging bridge. Precedent that extension→local-process delivery is a first-class
  pattern on this surface.

### ChatGPT — web (chatgpt.com) + desktop app

- **[verified]** No desktop app on this machine (`%APPDATA%\ChatGPT` and
  `%LOCALAPPDATA%\Programs\ChatGPT` absent — `%LOCALAPPDATA%\OpenAI` holds only Codex CLI +
  extension artifacts, already captured by the Codex connector). Chrome's chatgpt.com IndexedDB: ~0 MB. **No local
  conversation store.**
- **[documented]** Official export: Settings → Data controls → "Export data" → emailed ZIP with
  `conversations.json` (message tree with `mapping` nodes, `create_time`, and per-message
  `metadata.model_slug` — **model IS present**, token counts are NOT) + `chat.html`. Richest
  export of the three.

### Gemini — web (gemini.google.com)

- **[verified]** No gemini.google.com IndexedDB in Chrome or Edge at all. **Nothing local.**
- **[documented]** Export is Google Takeout → "Gemini Apps" (MyActivity-shaped HTML/JSON:
  prompt + response text + timestamp; **no model, no tokens, no tool calls**). Thinnest surface;
  fidelity comparable to a transcript, mirrors the Antigravity "actions-only" problem but with
  even less structure.

## Fidelity matrix (chat surfaces vs. Q2/Q6 dimensions)

| Surface     | Local store | Export format                | Tokens | Model          | Liveness (honest label)      |
| ----------- | ----------- | ---------------------------- | ------ | -------------- | ---------------------------- |
| Claude web  | none [v]    | `conversations.json` [d]     | ✗      | ✗              | Batch (export) / Live (ext.) |
| ChatGPT web | none [v]    | ZIP `conversations.json` [d] | ✗      | ✓ `model_slug` | Batch (export) / Live (ext.) |
| Gemini web  | none [v]    | Takeout "Gemini Apps" [d]    | ✗      | ✗              | Batch (export) / Live (ext.) |

**Q6 consequence:** no chat surface reports tokens → chat events are **uncosted** under the
existing ladder, or costed under a NEW "estimated-token-count" confidence tier (tokenizer
estimation from text). That tier is a cost-model widening — a **14.5 planning scope decision**,
not assumed here. The Cursor precedent (`experimental`, partial tokens, uncosted) says honest
under-claiming is acceptable.

## Browser-extension mechanism (first-class question, per D-M14-2)

- **Capture:** a MV3 extension with host permissions for the three chat origins. Two candidate
  layers: (a) intercept conversation JSON/SSE from the page's own fetches (highest fidelity —
  the apps' wire format carries message ids/timestamps/model where the DOM does not);
  (b) DOM scrape (most brittle; last resort). Layer (a) is the recommendation.
- **Delivery:** POST to the collector's existing local HTTP server
  (`apps/collector/src/serve.ts`) — a new machine-local **push** capture mode beside
  `tail`/`poll` (the 13.7
  precedent: additive capture modes leave existing connectors untouched). Native messaging
  (the Anthropic `ChromeNativeHost` pattern) is the fallback if a localhost listener is
  undesirable. Raw captured payloads become raw records (sacred), parsed server- or
  collector-side into the existing taxonomy — re-parseable by 13.3's engine if we store a
  reassemblable envelope (the D-M13-2 lesson, applied from day one).
- **Consent surface:** an extension reading chat pages is a **Capture Surface Change**
  (CONTEXT.md) — it must ride the 12.7b approval-gate discipline (per-origin opt-in in the
  extension + the connector approval fingerprint).
- **Risk:** wire-format drift (the apps change their internals without notice); the extension
  needs a per-origin schema-version stamp so drift is detected, not silently mis-parsed.

## Recommended slicing for 14.5+ (input to `/lril:plan-feature`, not a commitment)

1. **14.5 — Export-file connectors (Claude + ChatGPT)** — batch snapshot-parse on the existing
   framework (the Gemini-connector shape: whole-file JSON parse; `watchGlobs` over a
   user-designated import drop-dir, e.g. `~/.420ai/chat-imports/`). Honest `Batch` liveness.
   ChatGPT first (model present → partially costable if the token-estimation tier is approved).
   Includes **non-repo attribution**: Work-Session/topic grouping (no cwd/git exists here) —
   the milestone's one taxonomy-level design task. Fingerprint untouched (invariant).
2. **14.6 — Gemini Takeout connector** — same mechanism, thinnest fidelity; cheap once 14.5
   lands. Ship-if-feasible, never blocks (12.7d discipline).
3. **14.7 — Browser extension (research-gated build)** — its OWN Phase-0: intercept feasibility
   per origin + the push capture mode + consent UX. Gate: if wire-interception proves brittle
   on ≥2 of 3 origins, ship export-only and re-gate the extension.
4. **Side-fix (any slice):** the `claude-code-sessions` desktop-app capture gap above.

## Open follow-ups

- [ ] Live-verify all three export flows end-to-end (request → email → archive shape) before
      14.5 planning locks the parser contracts. **[the [documented] items above]**
- [ ] Inspect the desktop-app `claude-code-sessions/local_*.json` format vs. the JSONL the
      existing parser expects.
- [ ] Decide the token-estimation confidence tier (Q6 widening) — 14.5 planning.
- [ ] Extension Phase-0: confirm conversation JSON/SSE is interceptable on each origin (MV3
      `webRequest` limits push this toward an injected fetch/XHR wrapper — verify per origin).
