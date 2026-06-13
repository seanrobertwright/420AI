import type { ParseResult } from "./claude-code.js";
import { claudeCodeConnector } from "./claude-code.js";

/**
 * The connector contract — the plugin shape every capture source implements.
 *
 * M3 ships ONLY the Claude Code connector plus this framework; M4 adds Codex and
 * Gemini by appending objects to `connectors` (no framework change). The fidelity
 * fields encode PRD §10.3 so the Live Monitor (M9) can label each source's
 * trustworthiness honestly.
 */

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
  fidelity: ConnectorFidelity;
  /** Glob patterns (absolute, `~` pre-expanded to `home`) for session files. */
  watchGlobs(home: string): string[];
  /** Parse a complete-line file prefix into raw records + normalized events. */
  parse(fileText: string): ParseResult;
}

/** The active connector registry. M3: Claude only; M4 appends Codex/Gemini. */
export const connectors: Connector[] = [claudeCodeConnector];
