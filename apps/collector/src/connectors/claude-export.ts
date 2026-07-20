import { join } from "node:path";
import { parseClaudeExport, CLAUDE_EXPORT_CONNECTOR } from "@420ai/shared";
import type { Connector } from "./connector.js";

/**
 * The Claude chat-export connector (M14 slice 14.5): discovery/watch wiring
 * around the PURE parser in `@420ai/shared`. Re-exported here so importers/tests
 * are unchanged, mirroring the Gemini connector shape.
 */
export { parseClaudeExport, CLAUDE_EXPORT_CONNECTOR } from "@420ai/shared";

/**
 * The Claude chat-export connector. The user drops their official data export
 * (`conversations.json`, from claude.ai Settings → Privacy → Export data) into
 * `~/.420ai/chat-imports/claude/`; the file is a single whole-file JSON blob, so
 * it is read in `snapshot` capture mode (whole-file re-read on size/mtime change,
 * idempotent via content-hash dedup + server fingerprint upsert) — the Gemini
 * precedent, no framework change.
 *
 * Fidelity is deliberately honest: `experimental` status, `batch` liveness (days
 * stale between manual exports), and UNCOSTED (`tokens`/`cost` "none") — the
 * export carries neither token counts nor a model. A new capture surface, so its
 * `requiredPermissions` are declared for the §10.4 approval gate.
 */
export const claudeExportConnector: Connector = {
  id: CLAUDE_EXPORT_CONNECTOR,
  captureMode: "snapshot",
  fidelity: {
    status: "experimental",
    captureMethod: "import-export-json",
    liveness: "batch",
    tokens: "none",
    cost: "none",
    knownGaps: [
      "no token counts in the Claude export → chat events are uncosted (no usage/cost emitted)",
      "batch liveness — data is days-stale between manual exports (Settings → Privacy → Export data)",
      "no model field in the Claude export → chat events carry no model attribution",
      "attribution is a synthetic per-conversation topic key (chat:claude:<uuid>), not a repo/git path — alias to a workspace via workspace_keys",
      "export carries tool_use/tool_result/thinking content blocks and attachments/files, but those block shapes are unverified — tool-lifecycle + file-interaction events are deferred, not guessed",
    ],
    requiredPermissions: [
      "Read Claude chat export files under ~/.420ai/chat-imports/claude/*.json",
    ],
    testedVersions: [],
  },
  watchGlobs: (home) => [join(home, ".420ai", "chat-imports", "claude", "*.json")],
  parse: (text) => parseClaudeExport(text),
  // No discoverRoots: chat exports have no on-disk project roots.
};
