# 420AI Chat Capture — browser extension (Claude, MV3)

A minimal, unpacked Chrome/Edge extension (Manifest V3, plain JS — no bundler, no npm
dependencies) that captures your **claude.ai** web conversations near-real-time and pushes
them to your local 420AI collector's `push` receiver. It is the near-real-time counterpart
to the 14.5 `claude-export` connector (which batch-imports a days-stale official export).

## How it works

- A background service worker polls, once a minute (`chrome.alarms`' floor), claude.ai's own
  authenticated conversation API using your existing browser session cookies — a background
  fetch to an origin in `host_permissions` carries cookies and bypasses page CORS.
- It selects conversations updated since the last sync (the newest 10 on first run), fetches
  each one's full JSON, and POSTs the **raw** conversation objects to
  `http://127.0.0.1:42017/v1/push` with a bearer token.
- The collector normalizes them (`parseClaudeWire`) into the existing session/message
  taxonomy and enqueues them onto the same durable queue as every other connector — so they
  reach the archive/Monitor honestly labeled (`experimental`, `near-real-time`, **uncosted**).

**The extension is consent-gated.** It captures nothing until you check **Enable capture** in
the options page and paste the push token.

## Load unpacked

1. Start the collector: `collector watch` (after pairing). On its **first** start it logs a
   line like `push receiver token generated: <token> — paste it into the 420AI browser
extension`. Copy that token (it persists in `~/.420ai/push-token.json`).
2. Open `chrome://extensions` (or `edge://extensions`).
3. Toggle **Developer mode** on.
4. Click **Load unpacked** and select this `apps/extension` directory.
5. Open the extension's **options** (Details → Extension options), paste the **push token**,
   confirm the **collector URL** (`http://127.0.0.1:42017`), check **Enable capture**, and
   click **Save**. Use **Test connection** to confirm the collector accepts the token (a
   `200` means the handshake works; `401` means the token is wrong).
6. Open or continue a claude.ai conversation and wait one alarm cycle (≤ 1 minute). The
   collector logs `claude-live: N record(s), M event(s) pushed` and the conversation appears
   in the archive as a `claude-live` session.

## The token handshake

The push receiver is bound to `127.0.0.1` only and gated by a shared bearer token, so a
random localhost process cannot push without it. The token is generated once by the collector
and stored owner-only; you paste it into this extension's options. The receiver never listens
on the LAN.

## Drift warning (undocumented endpoints)

These claude.ai endpoints are **undocumented** and can change without notice:

- `GET /api/organizations`
- `GET /api/organizations/{org}/chat_conversations`
- `GET /api/organizations/{org}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true`

If claude.ai changes its wire shape, the collector's tolerant `parseClaudeWire` degrades
safely (unknown-shape conversations are skipped, never mis-parsed), but capture may silently
stop. The mitigation is a per-origin **schema re-verification**: re-run the recon (see
`docs/research/extension-spike.md`), update the fixture
(`packages/shared/src/parsers/fixtures/sample-claude-wire.json`), and bump the connector's
`testedVersions`/`knownGaps`. Do not guess new fields.

## Scope (this slice)

Claude only. ChatGPT is a verified GO for a later slice; Gemini is a NO-GO for interception
(use its Takeout export). SSE/streaming interception, a bundled/signed Web Store distribution,
and cross-connector dedup of `claude-live` vs `claude-export` are all deferred — see the spike
doc for the full gate.
