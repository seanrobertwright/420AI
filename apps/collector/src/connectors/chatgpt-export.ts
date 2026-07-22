import { join } from "node:path";
import { parseChatgptExport, CHATGPT_EXPORT_CONNECTOR } from "@420ai/shared";
import type { Connector } from "./connector.js";

/**
 * The ChatGPT chat-export connector (M14 slice 14.6): discovery/watch wiring
 * around the PURE parser in `@420ai/shared`. Re-exported here so importers/tests
 * are unchanged, mirroring the Claude export connector shape.
 */
export { parseChatgptExport, CHATGPT_EXPORT_CONNECTOR } from "@420ai/shared";

/**
 * The ChatGPT chat-export connector. The user drops their official OpenAI data
 * export (`conversations.json`, from ChatGPT Settings → Data controls → Export
 * data) into `~/.420ai/chat-imports/chatgpt/`; the file is a single whole-file
 * JSON blob, so it is read in `snapshot` capture mode (whole-file re-read on
 * size/mtime change, idempotent via content-hash dedup + server fingerprint
 * upsert) — the shipped `claude-export`/Gemini precedent, no framework change.
 *
 * Fidelity is deliberately honest: `experimental` status, `batch` liveness (days
 * stale between manual exports), and UNCOSTED (`tokens`/`cost` "none") — the export
 * carries NO token counts. UNLIKE Claude/Gemini, it DOES carry a model
 * (`metadata.model_slug`), so chat events are model-attributed. A new capture
 * surface, so its `requiredPermissions` are declared for the §10.4 approval gate.
 */
export const chatgptExportConnector: Connector = {
  id: CHATGPT_EXPORT_CONNECTOR,
  captureMode: "snapshot",
  fidelity: {
    status: "experimental",
    captureMethod: "import-export-json",
    liveness: "batch",
    tokens: "none",
    cost: "none",
    knownGaps: [
      "no token counts in the ChatGPT export → chat events are uncosted (no usage/cost emitted), even though the model IS known",
      "batch liveness — data is days-stale between manual exports (Settings → Data controls → Export data)",
      "thoughts/reasoning_recap reasoning nodes and multimodal_text attachments are stored as raw records but NOT emitted as normalized events (deferred, not guessed)",
      "attribution is a synthetic per-conversation topic key (chat:chatgpt:<conversationId>), not a repo/git path — alias to a workspace via workspace_keys",
    ],
    requiredPermissions: [
      "Read ChatGPT chat export files under ~/.420ai/chat-imports/chatgpt/*.json",
    ],
    testedVersions: [],
  },
  watchGlobs: (home) => [join(home, ".420ai", "chat-imports", "chatgpt", "*.json")],
  parse: (text) => parseChatgptExport(text),
  // No discoverRoots: chat exports have no on-disk project roots.
};
