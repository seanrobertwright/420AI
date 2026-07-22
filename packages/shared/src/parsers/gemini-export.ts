import { createHash } from "node:crypto";
import type { EventType, NormalizedEvent, RawSourceRecord } from "../events.js";
import { eventFingerprint } from "../fingerprint.js";
import type { ParseResult } from "./parse-result.js";

/**
 * The PURE Gemini chat-export parser (string → ParseResult) for M14 slice 14.6.
 *
 * Parses the Google Takeout "My Activity → Gemini Apps" export (`MyActivity.json`,
 * JSON format). UNLIKE the coding-tool connectors AND the other chat exports, this
 * is a FLAT ACTIVITY LOG with NO conversation threading and NO native record id —
 * so each "Prompted" activity record becomes its own SINGLE-TURN session, keyed by
 * a deterministic hash of `time|title` (the honest representation MyActivity
 * supports; topic grouping is a user-side `workspace_keys` concern, not a parser
 * guess). Events are UNCOSTED and MODEL-LESS (the export carries neither a model
 * nor token counts).
 *
 * VERIFIED shape (real 1452-record export, structure-only inspection 2026-07-21):
 *   - Top-level: a FLAT ARRAY of activity records (NOT threaded conversations).
 *   - Record keys (union): `header` (always "Gemini Apps"), `title`, `time`,
 *     `products`, `activityControls`, `safeHtmlItem`, `subtitles`, `attachedFiles`,
 *     `imageFile`.
 *   - `title` = "Prompted <the user's prompt>" for prompt records, or
 *     "Created…"/"Selected…"/etc. for non-conversation activity (skipped).
 *   - Response = `safeHtmlItem[0].html` (an HTML string), present on most (not all)
 *     "Prompted" records.
 *   - `time` = ISO-8601 string, 100% UNIQUE across all records (0 dupes) → the
 *     stable basis for the derived record key.
 *   - NO id/uuid/titleUrl field anywhere → derive a deterministic key.
 *   - NO model, NO tokens.
 *
 * SCOPE: emits `session.started`/`message.user`/`message.assistant`/`session.ended`
 * for "Prompted" records only. Non-"Prompted" activity (image generation, canvas
 * creation, feedback) carries no conversational content — skipped WITHOUT inflating
 * `skippedLines` (an intentional skip, not a parse failure; mirrors the gemini-cli
 * parser's "info type carries no event"). Attachments (`attachedFiles`/`imageFile`)
 * are a declared knownGap. See the connector's `knownGaps`.
 */

/** Connector source id — used in fingerprints and stamped on every record/event. */
export const GEMINI_EXPORT_CONNECTOR = "gemini-export";

/** Parser version (new connector starts at 1.0.0). */
export const GEMINI_EXPORT_PARSER_VERSION = "1.0.0";

/** The `"Prompted "` prefix a conversational activity `title` carries. */
const PROMPTED_PREFIX = "Prompted ";

/** Bound the derived title so a runaway prompt can't bloat the session payload. */
const MAX_TITLE_LEN = 200;

/** A single Google Takeout activity record. */
interface GeminiActivityRecord {
  header?: string;
  title?: string;
  time?: string;
  safeHtmlItem?: Array<{ html?: string }>;
}

/**
 * Normalize an activity `time` to canonical ISO. Gemini `time` is already ISO but
 * re-emit through `Date` for a canonical millisecond string, falling back to
 * `ingestedAt` on an unparseable/missing value (never emits a non-ISO `ts`, never
 * throws). Copied from the claude-export normalizer.
 */
function normalizeTs(raw: string | undefined, fallback: string): string {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return fallback;
  return new Date(t).toISOString();
}

/**
 * Parse a Gemini Takeout export — a SINGLE JSON file containing a flat array of
 * activity records. Read in `snapshot` capture mode (whole-file re-read).
 *
 * Tolerant: a malformed / mid-copy whole-file blob returns an empty ParseResult
 * with `skippedLines: 1` (never throws), so the watcher does NOT advance and
 * retries next tick. A "Prompted" record missing `time` (can't derive a stable key)
 * is counted in `skippedLines` and dropped.
 */
export function parseGeminiExport(fileText: string, opts?: { ingestedAt?: string }): ParseResult {
  const ingestedAt = opts?.ingestedAt ?? new Date().toISOString();
  const rawRecords: RawSourceRecord[] = [];
  const events: NormalizedEvent[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    // Mid-copy / malformed read — treat the whole blob as one skipped record.
    return { rawRecords: [], events: [], skippedLines: 1 };
  }

  // The export is a flat array (VERIFIED). Anything else valid-but-wrong-shaped →
  // one skipped record.
  if (!Array.isArray(parsed)) {
    return { rawRecords: [], events: [], skippedLines: 1 };
  }
  const list = parsed as GeminiActivityRecord[];

  let skippedLines = 0;

  for (const record of list) {
    if (!record || typeof record !== "object") continue;
    // Process ONLY conversational "Prompted" activity from Gemini Apps. Non-
    // conversation activity (canvas creation, feedback, image generation) is an
    // INTENTIONAL skip — do NOT inflate skippedLines (mirrors gemini-cli's "info
    // type carries no event").
    if (record.header !== "Gemini Apps") continue;
    const rawTitle = typeof record.title === "string" ? record.title : "";
    if (!rawTitle.startsWith(PROMPTED_PREFIX)) continue;

    // There is NO native record id — derive a deterministic, stable key from the
    // 100%-unique `time` plus `title`. Stable across re-exports (Google's activity
    // `time` is stable), so the fingerprint holds across re-imports. A record with
    // no `time` can't be keyed → count it and skip.
    const time =
      typeof record.time === "string" && record.time.length > 0 ? record.time : undefined;
    if (!time) {
      skippedLines++;
      continue;
    }
    const key = createHash("sha256").update(`${time}|${rawTitle}`).digest("hex").slice(0, 32);

    const sessionId = `gemini-${key}`;
    const projectPath = `chat:gemini:${key}`;
    // The prompt is the title minus the "Prompted " prefix, bounded to a sane length.
    const prompt = rawTitle.slice(PROMPTED_PREFIX.length).trim().slice(0, MAX_TITLE_LEN);
    const html = record.safeHtmlItem?.[0]?.html;
    const hasResponse = typeof html === "string" && html.length > 0;
    const ts = normalizeTs(time, ingestedAt);

    // One raw record for the whole activity entry (SACRED — holds prompt + HTML
    // response verbatim; downstream redaction/render handles the markup).
    rawRecords.push({
      id: key,
      sourceConnector: GEMINI_EXPORT_CONNECTOR,
      sessionId,
      ingestedAt,
      payload: JSON.stringify(record),
    });

    const makeEvent = (
      eventType: EventType,
      extra: Partial<NormalizedEvent> = {},
    ): NormalizedEvent => ({
      fingerprint: eventFingerprint(GEMINI_EXPORT_CONNECTOR, key, 0, eventType),
      sourceConnector: GEMINI_EXPORT_CONNECTOR,
      parserVersion: GEMINI_EXPORT_PARSER_VERSION,
      // No catalogVersion / model / tokens / cost — uncosted and model-less.
      rawRecordId: key,
      eventIndex: 0,
      eventType,
      sessionId,
      projectPath,
      ts,
      ...extra,
    });

    // Each record is its own single-turn session (no threading exists). The four
    // event types hash to four distinct fingerprints (connector|key|0|eventType).
    events.push(
      makeEvent("session.started", prompt.length > 0 ? { payload: { title: prompt } } : {}),
    );
    events.push(makeEvent("message.user"));
    if (hasResponse) events.push(makeEvent("message.assistant"));
    events.push(makeEvent("session.ended"));
  }

  return { rawRecords, events, skippedLines };
}
