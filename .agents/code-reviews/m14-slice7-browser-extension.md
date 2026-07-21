# Code Review — M14 Slice 14.7 (Browser Extension + collector `push` capture mode)

**Reviewed:** commit `5bbbcbc` on `m14-slice7-browser-extension` · **Date:** 2026-07-20

**Stats:**

- Files Modified: 13
- Files Added: 17
- Files Deleted: 0
- New lines: ~2560
- Deleted lines: 16

## Scope reviewed

The net-new inbound network surface (`push/push-server.ts`, `push/push-token.ts`), the pure
`parseClaudeWire` normalizer, the `claude-live` connector, the engine/approval/CLI wiring, the
MV3 extension (`apps/extension`), and the two integration fixes (ESLint override, repo-health
artifact-scan exclusion). Emphasis on the receiver: it is the only genuinely new behavior (auth,
body-bound, leak-window, crash-safety) — the rest is additive over proven seams.

## Issues found & resolved

```
severity: medium
file: apps/collector/src/push/push-server.ts
line: 87 (handleRequest)
issue: A client disconnect mid-response — or the RST after the 413 `req.destroy()` — could
       surface an unhandled 'error' on the response/request socket and crash the whole receiver.
detail: The 'end' callback runs OUTSIDE handleRequest's synchronous try/catch; its inner
       try/catch wraps JSON.parse + enqueue, but the final `json(res, 200, …)` write can still
       throw/emit 'error' if the peer already closed. An unhandled ServerResponse 'error' event
       crashes the process — violating the "receiver never crashes on a bad request" invariant
       and, worse, killing capture for the rest of the session.
fix: Arm `res.on("error", () => {})` (and a top-level `req.on("error", () => {})` covering the
     OPTIONS/404/401 paths that have no body listener) BEFORE any write. The record is already
     enqueued locally by the time the response is written, so a dropped response is harmless.
status: FIXED + the existing abort/teardown tests still pass (14/14).
```

```
severity: low
file: apps/collector/src/push/push-server.ts
line: 62 (authOk)
issue: `authOk` returns true when the CONFIGURED token is empty and the client sends `Bearer `
       (empty) — `timingSafeEqual` over two zero-length buffers reports equal.
detail: Not reachable in production (the engine always passes a `randomBytes(24)` token), but a
       future misconfiguration passing `token: ""` would leave the receiver open on localhost.
fix: `if (token.length === 0) return false` at the top of authOk (defense-in-depth).
status: FIXED + locked with a new test ("never authenticates against an empty configured token").
```

## Reviewed and found sound (no change needed)

- **Leak-window (`runPushServer`)** — the abort listener is armed synchronously before
  `server.listen`; both `close` and `error` remove the listener and resolve; `signal.aborted`
  early-returns without creating a server. Slots into the engine's `Promise.allSettled` unwind
  exactly like `pollLoop` (not in the race — infinite/best-effort). Verified by the abort +
  already-aborted tests.
- **Body bound** — 16 MiB mirror of the ingest `bodyLimit`, enforced mid-stream before
  `Buffer.concat`, with a `done` flag preventing a double response across data/end/error.
- **Auth** — constant-time `timingSafeEqual` with an explicit length-mismatch short-circuit.
- **`parseClaudeWire`** — tolerant (malformed → `skippedLines:1`, never throws); model stamped on
  `message.assistant` only; uncosted; `chat:claude:<uuid>` shared with the export parser on
  purpose (documented two-session known gap). Fingerprint-stable across re-pushes (ingestedAt is
  not a fingerprint input). Fixture covers empty/no-uuid/thinking-block/null-model cases.
- **Idempotency** — comes free from `QueueStore.enqueue`'s content-hash dedup; the re-POST test
  proves pending is unchanged.
- **Approval fold** — `push.origins` folded into `captureSurfaceFingerprint` exactly as
  `poll.sources`; omitted for push-less connectors (no re-approval churn); drift → needs-approval
  test added.
- **Additivity** — no migration, no fingerprint/`events`-column change, no control-protocol bump,
  no new backend dependency; chat events stay uncosted (invariants held).
- **Extension** — consent-gated (captures nothing until enabled + token); best-effort alarm
  handler (never throws); plain JS out of the root tsc graph; `credentials:"include"` reaches
  claude.ai cookies via `host_permissions`. The token is logged once on creation by design (the
  handshake) — a localhost-only, low-sensitivity secret; acceptable and documented.
- **Integration fixes** — ESLint browser/webextension override scoped to `apps/extension/**/*.js`;
  repo-health artifact scan excludes the one plain-JS workspace with a documented rationale (same
  "out of the TS graph" precedent as the dashboard/desktop). Both are minimal and correct.

## Verdict

Two issues found (1 medium crash-safety, 1 low defense-in-depth), both FIXED and covered by
tests. Everything else is sound. Full gate green post-fix (see execution report).
