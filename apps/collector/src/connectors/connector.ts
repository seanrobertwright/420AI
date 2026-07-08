import type { ParseResult, RootHint } from "@420ai/shared";
import { claudeCodeConnector } from "./claude-code.js";
import { codexCliConnector } from "./codex-cli.js";
import { geminiCliConnector } from "./gemini-cli.js";
import { cursorConnector } from "./cursor.js";

/**
 * The connector contract — the plugin shape every capture source implements.
 *
 * M3 ships ONLY the Claude Code connector plus this framework; M4 adds Codex and
 * Gemini by appending objects to `connectors` (no framework change). The fidelity
 * fields encode PRD §10.3 so the Live Monitor (M9) can label each source's
 * trustworthiness honestly.
 */

/**
 * `ParseResult` moved to `@420ai/shared` in 13.3 (the pure parsers relocated so
 * the server-side re-parse engine can run them). Re-exported from the contract
 * module so every existing importer is unchanged.
 */
export type { ParseResult } from "@420ai/shared";

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
  /**
   * §10.3 declared capture scope — human-readable statements of what this connector
   * reads (reviewed/approved by the user). Distinct from the raw `watchGlobs`: these
   * are the "Capture Permission" the user reviews (docs/CONTEXT.md). A change here (or
   * in `watchGlobs`) is a "Capture Surface Change" that requires fresh approval (§10.4).
   */
  requiredPermissions: string[];
  /** Tool versions this connector has been validated against. */
  testedVersions?: string[];
}

/**
 * M13 13.7: a POLL-mode capture source (the Cursor connector). Unlike `watchGlobs`
 * (append-only/whole-file sources the FileWatcher tails or snapshots), a poll source
 * is an opaque store swept on an interval: each tick re-observes the whole store, and
 * only the units whose content CHANGED incur the expensive detail fetch + parse.
 *
 * Additive + optional — every existing connector leaves `poll` unset, so the
 * FileWatcher, registry, discovery, and engine are byte-for-byte unchanged. A poll
 * connector's `watchGlobs` returns `[]` (nothing to tail); the engine drives its
 * capture through this capability instead (`capture-engine.ts` `pollLoop`).
 */
export interface PollCapability {
  /** Sweep cadence (ms). */
  intervalMs: number;
  /** Absolute store paths to poll (e.g. an APPDATA-derived vscdb); `home` for call-site symmetry. */
  sources(home: string): string[];
  /**
   * One best-effort poll pass over a SINGLE source path. MUST NOT throw — a missing
   * or locked store is reported as `unavailable`, never a crash (mirrors the git
   * sweep's best-effort discipline). Synchronous: the store engine (`node:sqlite`)
   * is synchronous, and the 5-min cadence makes a brief block a non-issue.
   */
  run(path: string, ctx: PollContext): PollOutcome;
}

/** The engine-provided seams a `PollCapability.run` uses (change memory + enqueue). */
export interface PollContext {
  /**
   * Persistent, READ-ONLY change check: true iff `content` differs from the last committed
   * observation for `key`. Survives queue `ack` (unlike the outbox), so an unchanged unit
   * skips the detail fetch on EVERY tick — not just before its first sync. Does NOT record;
   * call `commit` after a successful enqueue (commit-point ordering — see `QueueStore.pollChanged`).
   */
  changed(key: string, content: string): boolean;
  /** Enqueue a parsed snapshot's raw records + events onto the durable queue (which dedups). */
  enqueue(result: ParseResult): void;
  /**
   * Record `content` as the last-seen observation for `key`. Call ONLY AFTER `enqueue`
   * succeeds, so a transient failure leaves the unit un-committed and retried next tick.
   */
  commit(key: string, content: string): void;
}

/** A poll pass summary, surfaced to the engine's logger. */
export interface PollOutcome {
  /** Units swept by the cheap top-level scan. */
  swept: number;
  /** Units whose content changed → fetched, parsed, and enqueued this pass. */
  changed: number;
  /** Raw records enqueued across the changed units. */
  rawRecords: number;
  /** Events enqueued across the changed units. */
  events: number;
  /** True iff the store was absent/locked this pass (degraded, not fatal). */
  unavailable?: boolean;
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
   *   - "poll" — no FileWatcher involvement at all; capture is driven by the
   *     `poll` capability (M13 13.7, Cursor). `watchGlobs` is `[]` for these.
   */
  captureMode?: "tail" | "snapshot" | "poll";
  fidelity: ConnectorFidelity;
  /** Glob patterns (absolute, `~` pre-expanded to `home`) for session files. Empty for poll sources. */
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
  /**
   * M13 13.7: OPTIONAL poll-mode capture (Cursor). Absent ⇒ this connector captures
   * via `watchGlobs`/the FileWatcher (every existing connector). Present ⇒ the engine
   * runs a `pollLoop` for it instead.
   */
  poll?: PollCapability;
}

/**
 * The active connector registry. M3: Claude only; M4 appends Codex/Gemini; M13 13.7
 * appends the poll-mode Cursor connector.
 */
export const connectors: Connector[] = [
  claudeCodeConnector,
  codexCliConnector,
  geminiCliConnector,
  cursorConnector,
];
