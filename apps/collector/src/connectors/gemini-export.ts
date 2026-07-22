import { join } from "node:path";
import { parseGeminiExport, GEMINI_EXPORT_CONNECTOR } from "@420ai/shared";
import type { Connector } from "./connector.js";

/**
 * The Gemini chat-export connector (M14 slice 14.6): discovery/watch wiring
 * around the PURE parser in `@420ai/shared`. Re-exported here so importers/tests
 * are unchanged, mirroring the Claude export connector shape.
 */
export { parseGeminiExport, GEMINI_EXPORT_CONNECTOR } from "@420ai/shared";

/**
 * The Gemini chat-export connector. The user drops their Google Takeout export
 * (`MyActivity.json`, from Takeout → "My Activity → Gemini Apps", JSON format)
 * into `~/.420ai/chat-imports/gemini/`; the file is a single whole-file JSON blob,
 * so it is read in `snapshot` capture mode (whole-file re-read on size/mtime
 * change, idempotent via content-hash dedup + server fingerprint upsert) — the
 * shipped `claude-export`/Gemini precedent, no framework change.
 *
 * Fidelity is deliberately honest: `experimental` status, `batch` liveness (days
 * stale between manual exports), UNCOSTED (`tokens`/`cost` "none") AND model-less —
 * the export carries neither a model nor token counts. A new capture surface, so
 * its `requiredPermissions` are declared for the §10.4 approval gate.
 */
export const geminiExportConnector: Connector = {
  id: GEMINI_EXPORT_CONNECTOR,
  captureMode: "snapshot",
  fidelity: {
    status: "experimental",
    captureMethod: "import-export-json",
    liveness: "batch",
    tokens: "none",
    cost: "none",
    knownGaps: [
      "Google Takeout 'My Activity' is a FLAT activity log with no conversation threading → each activity record is captured as its own single-turn session (topic grouping is a user-side workspace_keys concern)",
      "records have no native id → the fingerprint key is derived from time+prompt (stable while Google's activity time is stable)",
      "no token counts and no model in the export → chat events are uncosted and carry no model attribution",
      "batch liveness — data is days-stale between manual Takeout exports",
      "response body is HTML (safeHtmlItem) stored verbatim → search may include markup; non-'Prompted' activity (image generation, canvas creation, feedback) is skipped; attachments (attachedFiles/imageFile) are deferred",
      "attribution is a synthetic per-record topic key (chat:gemini:<key>), not a repo/git path — alias to a workspace via workspace_keys",
    ],
    requiredPermissions: [
      "Read Gemini Takeout activity files under ~/.420ai/chat-imports/gemini/*.json",
    ],
    testedVersions: [],
  },
  watchGlobs: (home) => [join(home, ".420ai", "chat-imports", "gemini", "*.json")],
  parse: (text) => parseGeminiExport(text),
  // No discoverRoots: chat exports have no on-disk project roots.
};
