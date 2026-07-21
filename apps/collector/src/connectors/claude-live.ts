import { parseClaudeWire, CLAUDE_LIVE_CONNECTOR } from "@420ai/shared";
import type { Connector } from "./connector.js";

/**
 * The Claude LIVE connector (M14 slice 14.7): the `push`-mode counterpart to the 14.5
 * `claude-export` connector. Where the export connector snapshot-parses a days-stale
 * data-export file, this one receives conversation JSON pushed near-real-time by the
 * browser extension (which reads claude.ai's own authenticated conversation API). It
 * carries NO `watchGlobs` (nothing on disk to tail) — capture is driven entirely by the
 * inbound `push` receiver (`push-server.ts`), which routes pushed payloads through the
 * pure `parseClaudeWire` normalizer in `@420ai/shared`.
 *
 * Re-exports the pure parser + id (mirrors `claude-export.ts`) so importers/tests are
 * unchanged.
 */
export { parseClaudeWire, CLAUDE_LIVE_CONNECTOR } from "@420ai/shared";

/**
 * Fidelity is deliberately honest: `experimental` status; `near-real-time` liveness (a
 * polling extension on a 1-min `chrome.alarms` floor — NOT `streaming`, per Q2); UNCOSTED
 * (`tokens`/`cost` "none") — the wire carries neither token counts nor per-message model.
 * A new capture surface, so its `push.origins` fold into the §10.4 approval fingerprint.
 */
export const claudeLiveConnector: Connector = {
  id: CLAUDE_LIVE_CONNECTOR,
  captureMode: "push",
  fidelity: {
    status: "experimental",
    captureMethod: "browser-extension-push",
    liveness: "near-real-time",
    tokens: "none",
    cost: "none",
    knownGaps: [
      "no token counts on the Claude wire → chat events are uncosted (no usage/cost emitted)",
      "only the conversation-level model is captured (stamped on assistant events); there is no per-message model on the wire",
      "tool_use/tool_result/thinking content blocks are not yet mapped — only session + message events are emitted (deferred, not guessed)",
      "a conversation captured live (claude-live) AND via the 14.5 export (claude-export) yields TWO sessions (different sourceConnector → different fingerprints, same sessionId) — cross-connector dedup is deferred; the shared chat:claude:<uuid> key keeps them grouped in the UI",
      "the claude.ai conversation API is undocumented and can drift — the tolerant parser degrades safely; re-verify + bump testedVersions on drift",
    ],
    requiredPermissions: [
      "Receive claude.ai conversation data pushed by the 420AI browser extension over localhost",
    ],
    testedVersions: [],
  },
  // Push-mode: no files to watch. The receiver drives capture via `push` + `parse`.
  watchGlobs: () => [],
  parse: (text) => parseClaudeWire(text),
  push: {
    // The human-readable origin this connector accepts pushed data from — the approval
    // surface folded into captureSurfaceFingerprint (the poll.sources precedent).
    origins: ["https://claude.ai"],
  },
};
