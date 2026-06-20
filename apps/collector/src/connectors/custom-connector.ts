import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  eventFingerprint,
  computeTotal,
  zeroTokens,
  type EventType,
  type NormalizedEvent,
  type NormalizedTokens,
  type RawSourceRecord,
} from "@420ai/shared";
import { COLLECTOR_HOME } from "../identity.js";
import type { Connector, ParseResult } from "./connector.js";

/**
 * Config-only custom connectors (M10 Slice 2, PRD §10 "config-only custom connectors").
 *
 * A self-hosting user points the collector at ANY append-only file/log a built-in
 * connector doesn't cover and maps its fields onto the normalized event model — as
 * DATA in `~/.420ai/custom-connectors.json`, never code (PRD §39/§217: a
 * script/plugin runtime is a NON-GOAL). A fixed factory compiles each declaration
 * into the existing `Connector` shape; the unchanged M3/M4 capture core picks it up.
 *
 * Library file (CLAUDE.md process boundaries): it NEVER writes stdout/stderr or
 * exits. The loader is tolerant exactly like `connector-config.ts`/`identity.ts`
 * (absent/corrupt ⇒ a safe default, never a throw) so a misconfiguration can never
 * take down capture of the built-in connectors (default-on safety is load-bearing).
 */

/**
 * Stamps the custom-connector config shape AND is stamped as each custom event's
 * `parserVersion` (a custom connector has no per-connector semantic version; D10).
 * Bumping it re-derives on replay; fingerprints are independent of it (PRD §23).
 */
export const CUSTOM_CONNECTOR_CONFIG_VERSION = "m10-custom-v1" as const;

/** Where custom-connector declarations live (testability seam: the optional `path`). */
export const CUSTOM_CONNECTOR_CONFIG_PATH = join(COLLECTOR_HOME, "custom-connectors.json");

/**
 * The ONLY event types a custom declaration may map onto — the existing closed
 * `EventType` union (no new event type, no fingerprint change, no server change;
 * D3). `as const satisfies readonly EventType[]` makes the compiler fail if this
 * drifts from `events.ts`; a test also pins the parity.
 */
export const MAPPABLE_EVENT_TYPES = [
  "session.started",
  "session.ended",
  "message.user",
  "message.assistant",
  "tool.call.started",
  "tool.call.completed",
  "tool.call.failed",
  "file.read",
  "file.modified",
  "file.referenced",
  "context.loaded",
  "usage.reported",
  "cost.estimated",
] as const satisfies readonly EventType[];

/**
 * A declared custom connector. Field sources are a DOT-PATH for `format:"jsonl"`
 * (e.g. "meta.session") and a named-capture GROUP NAME for `format:"regex"`
 * (e.g. "sessionId"). The shape is frozen (M10-S2 spike-proven).
 */
export interface CustomConnectorDef {
  /** Non-empty; must not collide with a built-in id (enforced in `loadRegistry`). */
  id: string;
  displayName?: string;
  /** Absolute patterns; `home` is intentionally ignored (a user-pointed watcher). */
  watchGlobs: string[];
  format: "jsonl" | "regex";
  /** REQUIRED iff `format==="regex"`; compiled ONCE at construct time, never per line. */
  pattern?: string;
  tsField?: string;
  sessionIdField?: string;
  projectPathField?: string;
  modelField?: string;
  /** Per-line event type; falls back to the `eventType` constant. */
  eventTypeField?: string;
  /** Constant fallback when `eventTypeField` is absent/empty. */
  eventType?: EventType;
  /** Optional token sub-field sources (dot-paths / group names); numeric. */
  tokenMap?: { input?: string; output?: string; cache_read?: string; cache_write?: string };
}

/** On-disk file shape: a version stamp + the declared connectors. */
interface CustomConnectorsFile {
  version: string;
  connectors: CustomConnectorDef[];
}

/**
 * Load the custom-connector declarations, returning `[]` when the file is absent
 * (a fresh install behaves exactly as today) or corrupt (never crash capture).
 * Declarations are returned UNVALIDATED — `loadRegistry`/`validateCustomDef` screen
 * each one and drop the invalid with a surfaced reason.
 */
export function loadCustomConnectors(path = CUSTOM_CONNECTOR_CONFIG_PATH): CustomConnectorDef[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { connectors?: unknown };
    return Array.isArray(parsed.connectors) ? (parsed.connectors as CustomConnectorDef[]) : [];
  } catch {
    return [];
  }
}

/** Persist custom-connector declarations (mkdir + owner-only write, like `saveCredentials`). */
export function saveCustomConnectors(
  defs: CustomConnectorDef[],
  path = CUSTOM_CONNECTOR_CONFIG_PATH,
): void {
  const file: CustomConnectorsFile = { version: CUSTOM_CONNECTOR_CONFIG_VERSION, connectors: defs };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Tolerantly validate a raw declaration into a typed `CustomConnectorDef`, returning
 * a human-readable reason on the first failure (never throws). A bad `RegExp` is
 * caught HERE (at validate time), never at capture time. Id collision with a
 * built-in / another custom def is enforced by the caller (`loadRegistry`).
 */
export function validateCustomDef(raw: unknown): { ok: CustomConnectorDef } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "declaration must be an object" };
  const def = raw as Partial<CustomConnectorDef>;

  if (typeof def.id !== "string" || def.id.trim() === "") {
    return { error: "id must be a non-empty string" };
  }
  if (
    !Array.isArray(def.watchGlobs) ||
    def.watchGlobs.length === 0 ||
    !def.watchGlobs.every((g) => typeof g === "string" && g.trim() !== "")
  ) {
    return { error: `connector "${def.id}": watchGlobs must be a non-empty string[]` };
  }
  if (def.format !== "jsonl" && def.format !== "regex") {
    return { error: `connector "${def.id}": format must be "jsonl" or "regex"` };
  }
  if (def.format === "regex") {
    if (typeof def.pattern !== "string" || def.pattern === "") {
      return { error: `connector "${def.id}": regex format requires a non-empty pattern` };
    }
    try {
      new RegExp(def.pattern);
    } catch (err) {
      return { error: `connector "${def.id}": invalid regex — ${(err as Error).message}` };
    }
    // If a tsField is mapped, the pattern MUST name that group (catches the typo where
    // tsField="ts" but the pattern wrote `(?<timestamp>…)`). When no tsField is set the
    // timestamp falls back to capture time, so a ts group is not required — same tolerance
    // as every other unmapped field.
    if (def.tsField && !def.pattern.includes(`(?<${def.tsField}>`)) {
      return {
        error: `connector "${def.id}": tsField "${def.tsField}" names no (?<${def.tsField}>…) group in the pattern`,
      };
    }
  }

  const hasConstant = typeof def.eventType === "string";
  const hasField = typeof def.eventTypeField === "string" && def.eventTypeField !== "";
  if (!hasConstant && !hasField) {
    return { error: `connector "${def.id}": eventType or eventTypeField is required` };
  }
  if (
    hasConstant &&
    !(MAPPABLE_EVENT_TYPES as readonly string[]).includes(def.eventType as string)
  ) {
    return { error: `connector "${def.id}": unknown eventType "${def.eventType as string}"` };
  }

  return { ok: def as CustomConnectorDef };
}

/** Read a value at a dot-path from a parsed JSON object, coercing number→string. */
function getByPath(obj: unknown, path: string): string | undefined {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur === "string") return cur;
  if (typeof cur === "number") return String(cur);
  return undefined;
}

/** Per-line event type WINS over the constant; junk/non-mappable ⇒ undefined ⇒ skip. */
function resolveEventType(raw: string | undefined, def: CustomConnectorDef): EventType | undefined {
  const t = raw ?? def.eventType;
  return t !== undefined && (MAPPABLE_EVENT_TYPES as readonly string[]).includes(t)
    ? (t as EventType)
    : undefined;
}

/** Build normalized tokens from the configured numeric sources, or undefined if none. */
function extractTokens(
  def: CustomConnectorDef,
  read: (src: string) => string | undefined,
): NormalizedTokens | undefined {
  if (!def.tokenMap) return undefined;
  const num = (src?: string): number => {
    if (!src) return 0;
    const n = Number(read(src));
    return Number.isFinite(n) ? n : 0;
  };
  const tokens = zeroTokens();
  tokens.input = num(def.tokenMap.input);
  tokens.output = num(def.tokenMap.output);
  tokens.cache_read = num(def.tokenMap.cache_read);
  tokens.cache_write = num(def.tokenMap.cache_write);
  tokens.total = computeTotal(tokens);
  return tokens;
}

/**
 * Compile a declaration into the SAME `Connector` shape every built-in implements.
 * Tail capture (append-only logs) reusing the unchanged byte-offset tailer; one
 * normalized event per non-blank, mappable line (`eventIndex: 0` — a generic log
 * line is one observation). Tolerant: a blank / unparseable / non-mappable line is
 * counted in `skippedLines`, never thrown.
 */
export function makeCustomConnector(def: CustomConnectorDef): Connector {
  // Compile ONCE (validateCustomDef already proved it compiles), never per line.
  const re = def.format === "regex" ? new RegExp(def.pattern as string) : undefined;

  const parse = (fileText: string): ParseResult => {
    const ingestedAt = new Date().toISOString();
    const rawRecords: RawSourceRecord[] = [];
    const events: NormalizedEvent[] = [];
    let skippedLines = 0;

    fileText.split(/\r?\n/).forEach((line, i) => {
      if (line.trim() === "") return;

      let read: (src: string) => string | undefined;
      if (def.format === "jsonl") {
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          skippedLines += 1;
          return;
        }
        read = (src) => getByPath(obj, src);
      } else {
        const m = (re as RegExp).exec(line);
        if (!m) {
          skippedLines += 1;
          return;
        }
        const g = m.groups ?? {};
        read = (src) => g[src];
      }

      const f = {
        ts: def.tsField ? read(def.tsField) : undefined,
        sessionId: def.sessionIdField ? read(def.sessionIdField) : undefined,
        projectPath: def.projectPathField ? read(def.projectPathField) : undefined,
        model: def.modelField ? read(def.modelField) : undefined,
        eventType: def.eventTypeField ? read(def.eventTypeField) : undefined,
      };

      const eventType = resolveEventType(f.eventType, def);
      if (!eventType) {
        skippedLines += 1;
        return;
      }
      const sessionId = f.sessionId ?? "unknown-session";
      // `${sessionId}:${i}` is STABLE across ticks: the tailer hands `parse` the
      // WHOLE-FILE prefix every tick (readGrownPrefix reads from byte 0), so the
      // line index `i` is fixed ⇒ stable rawId ⇒ stable fingerprint ⇒ correct
      // content-hash dedup. The exact discipline the Claude parser uses. NOT a counter.
      const rawId = `${sessionId}:${i}`;
      rawRecords.push({ id: rawId, sourceConnector: def.id, sessionId, ingestedAt, payload: line });
      const tokens = extractTokens(def, read);
      events.push({
        fingerprint: eventFingerprint(def.id, rawId, 0, eventType),
        sourceConnector: def.id,
        parserVersion: CUSTOM_CONNECTOR_CONFIG_VERSION,
        rawRecordId: rawId,
        eventIndex: 0,
        eventType,
        sessionId,
        projectPath: f.projectPath,
        model: f.model,
        ts: f.ts ?? ingestedAt,
        ...(tokens ? { tokens } : {}),
      });
    });

    return { rawRecords, events, skippedLines };
  };

  return {
    id: def.id,
    captureMode: "tail",
    fidelity: {
      status: "experimental",
      captureMethod: `custom-tail-${def.format}`,
      liveness: "streaming",
      tokens: def.tokenMap ? "estimated" : "none",
      cost: "none",
      knownGaps: [
        "user-defined mapping — fidelity is only as good as the configured field paths",
        "discoverRoots not implemented; project attribution relies on a mapped projectPath field only",
        "events are keyed by `${sessionId}:lineIndex`; map a sessionIdField unique per session " +
          "(ideally one session per file) or lines sharing a line index across files dedup-collide",
        ...(def.tokenMap ? [] : ["no token/cost capture — this source maps no usage fields"]),
      ],
    },
    // Absolute paths; `home` is intentionally ignored (a user-pointed watcher).
    watchGlobs: () => def.watchGlobs,
    parse,
  };
}
