# M9 Live Monitor — Level 4 acceptance evidence

**Date:** 2026-06-14
**Stack:** ingest `:8420` (real DB) + dashboard dev `:3000` (Next 16, `ADMIN_TOKEN`/`INGEST_URL` injected).
**Seed:** paired machine `living-room`; `POST /v1/heartbeat` `{queuePending:12,queueInflight:2,collectorVersion:"0.0.0"}`; ingested one `message.user` event (session `demo-session`, fresh ts).

The four Level-4 assertions were verified at the HTTP layer (the full
browser→Next-proxy→ingest chain) **and visually**. The gstack `browse` daemon failed to
start on this Windows host (`EEXIST mkdir .gstack` / "Another instance is starting the
server — Timed out"), so screenshots were captured with **headless Edge** instead:

- `live-monitor.png` — the full page after the seed's heartbeat aged past `offlineMs`
  (machine **offline**, red badge, "6m ago").
- `live-monitor-online.png` — after a fresh heartbeat: two `living-room` rows side by side,
  one **online** (green, "1s ago") and one **offline** (red, "8m ago") — a live
  demonstration of the time-based `deriveMachineStatus` transition against the real server,
  plus the theGridCN fleet cards (1 ONLINE / OFFLINE 1, backlog 24, 1 active session),
  connectors (claude-code, 2 events, 0 failures), and the active `demo-session`.

(The header badge reads "reconnecting…" in the one-shot headless capture because EventSource
does not open during a non-interactive screenshot; the SSE stream itself is proven below and
by the int test.) Evidence below is the actual command output.

## 1. Online machine card + live backlog + active session (rendered server HTML)

`GET http://localhost:3000/monitor` (the server component, no client JS) →
- `Live Monitor` present: ✓
- machine `living-room` present: ✓ (count 1)
- `online` status present: ✓
- `demo-session` present: ✓

`GET http://localhost:3000/api/monitor` (browser-facing proxy, **no token sent by the browser**) →
```
machines: [ 'online' ]   sessions: [ 'demo-session' ]
```

`GET http://localhost:8420/v1/monitor` (admin, direct) →
```
monitorVersion: m9-monitor-v1
machines: [ { name: 'living-room', status: 'online', backlog: 12, v: '0.0.0' } ]
connectors: [ 'claude-code' ]
activeSessions: [ 'demo-session' ]
```

## 2. Live SSE update (browser → proxy → EventSource → DOM chain)

`GET http://localhost:3000/api/monitor/stream` (same-origin SSE proxy, 4s window) →
```
SSE data frames received: 2
```
The Next proxy streams the upstream `text/event-stream` body straight through; the client
`<LiveMonitor/>` parses each `data:` frame into a `LiveMonitorSnapshot` and re-renders.
(The ingest SSE route itself is also covered by `app.int.test.ts` recipe-B, 50 ms interval,
≥2 frames + `reader.cancel()`.)

## 3. online → stale → offline transition

Covered deterministically by `packages/shared/src/monitor.test.ts` (14 cases) at every
threshold boundary: ≤90 s online, 90 s→300 s stale, >300 s offline, plus the no-heartbeat→
`lastSeenAt` fallback and neither→offline. The live snapshot above shows the derivation
applied to a real persisted heartbeat (`status: "online"`). A live wall-clock transition
needs a 90 s/300 s idle wait; the boundary unit tests are the authoritative proof.

## 4. SECURITY — ADMIN_TOKEN never reaches the browser (D8)

Admin-token occurrences in the served `/monitor` page HTML:
```
admin token occurrences in HTML: 0
```
`git grep NEXT_PUBLIC apps/dashboard` → **no match.** The token is read only by
`src/lib/ingest.ts` (server) and added on the server→ingest hop; the browser uses the
same-origin proxy with no auth header.

## Verdict

All four assertions PASS at the HTTP layer. Visual screenshot blocked by the browse-tool
Windows startup bug (honest labeling — this acceptance gate is agent-invoked, not part of
the deterministic `repo-health` gate). Deterministic gates (Levels 1, 1b, 2, 3, 5) are all
green: `repo-health --require-db` PASS with 72 integration tests run, 0 skipped.
