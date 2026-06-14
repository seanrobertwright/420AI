import type { NormalizedEvent, RawSourceRecord, RootHint } from "@420ai/shared";
import { claudeCodeConnector } from "./claude-code.js";
import { codexCliConnector } from "./codex-cli.js";
import { geminiCliConnector } from "./gemini-cli.js";

/**
 * The connector contract — the plugin shape every capture source implements.
 *
 * M3 ships ONLY the Claude Code connector plus this framework; M4 adds Codex and
 * Gemini by appending objects to `connectors` (no framework change). The fidelity
 * fields encode PRD §10.3 so the Live Monitor (M9) can label each source's
 * trustworthiness honestly.
 */

/**
 * The result of parsing a complete-line file prefix (tail) or a whole file
 * (snapshot): permanent raw records plus the disposable normalized events
 * re-derived from them. Lives in the contract module (not any one connector's
 * file) so every connector imports the type from a neutral place.
 */
export interface ParseResult {
  rawRecords: RawSourceRecord[];
  events: NormalizedEvent[];
  /** Count of JSONL lines / whole-file blobs that failed to parse (tolerant parsing). */
  skippedLines: number;
  sessionId?: string;
}

/** PRD §10.1.1 liveness vocabulary. */
export type Liveness = "streaming" | "near-real-time" | "snapshot" | "batch";

export interface ConnectorFidelity {
  status: "stable" | "experimental" | "planned";
  /** How the data is captured, e.g. "tail-jsonl". */
  captureMethod: string;
  liveness: Liveness;
  tokens: "exact" | "estimated" | "none";
  cost: "reported" | "computed" | "none";
  /** Honest list of what this connector does NOT yet capture/correlate. */
  knownGaps: string[];
  /** Tool versions this connector has been validated against. */
  testedVersions?: string[];
}

export interface Connector {
  /** Stable connector id, stamped on every record/event (e.g. "claude-code"). */
  id: string;
  /**
   * How the FileWatcher reads this source (M4):
   *   - "tail" (default when absent) — append-only file; read the byte-offset
   *     grown prefix (Claude, Codex).
   *   - "snapshot" — whole-file-rewrite source; re-read the whole file on a
   *     size/mtime change (Gemini). Absent = "tail" keeps the proven path intact.
   */
  captureMode?: "tail" | "snapshot";
  fidelity: ConnectorFidelity;
  /** Glob patterns (absolute, `~` pre-expanded to `home`) for session files. */
  watchGlobs(home: string): string[];
  /** Parse a complete-line file prefix (tail) or whole file (snapshot) into raw records + normalized events. */
  parse(fileText: string): ParseResult;
  /**
   * Enumerate the distinct project roots in this connector's on-disk store (M5
   * discovery, PRD §11.2). OPTIONAL + additive (absent is fine — mirrors
   * `captureMode`). Each connector owns its store layout, so it owns this sweep.
   * A hint's `projectKey` MUST equal what `parse` emits as `event.project_path`
   * byte-for-byte; `rootPath` is the resolved real path (absent ⇒ unresolved,
   * e.g. a Gemini hash-only dir → counted as a discovery gap, not emitted).
   */
  discoverRoots?(home: string): Promise<RootHint[]>;
}

/** The active connector registry. M3: Claude only; M4 appends Codex/Gemini. */
export const connectors: Connector[] = [
  claudeCodeConnector,
  codexCliConnector,
  geminiCliConnector,
];
