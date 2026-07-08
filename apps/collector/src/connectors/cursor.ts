import {
  eventFingerprint,
  computeCost,
  computeTotal,
  zeroTokens,
  PRICING_CATALOG_VERSION,
  type EventType,
  type NormalizedEvent,
  type NormalizedTokens,
  type RawSourceRecord,
  type ParseResult,
} from "@420ai/shared";
import type { Connector, PollContext, PollOutcome } from "./connector.js";
import { openCursorStore, defaultCursorStorePath, type CursorBubbleRow } from "./cursor-store.js";

/**
 * The Cursor connector (M13 13.7) — a POLL-mode capture source over Cursor's SQLite
 * store (`cursor-store.ts`). Cursor rewrites conversation state in place (no append-only
 * log), so it is captured like Gemini's snapshot parser: a whole "composer" blob plus its
 * message "bubbles" → per-bubble raw records + normalized events.
 *
 * Fidelity is deliberately modest and labelled honestly (PRD §10.3, spike-proven):
 *   - `status: "experimental"` — a reverse-engineered store; schema may drift across
 *     Cursor versions, so the connector is fail-soft by design.
 *   - liveness `snapshot` / capture `poll` — polled every 5 min, not streamed.
 *   - tokens PARTIAL — `tokenCount = {inputTokens, outputTokens}` exists per bubble but
 *     is frequently `{0,0}`; those bubbles get no `usage.reported`.
 *   - model USUALLY UNKNOWN — `modelConfig.modelName` is `"default"` in most composers,
 *     which we treat as no real model → no `cost.estimated` (cost ladder: unknown).
 *   - NO per-bubble timestamps — every event stamps the composer's created/updated time.
 *
 * REASSEMBLABILITY (the Gemini lesson, D-M13-2): alongside the per-bubble raw records we
 * store ONE composer-envelope raw record (the whole `composerData` value). Unlike Gemini,
 * this makes a future server-side re-parse of Cursor sessions possible from day one.
 */

/** Connector source id — used in fingerprints and stamped on every record/event. */
export const CURSOR_CONNECTOR = "cursor";

/** Parser version (new connector starts at 1.0.0). */
export const CURSOR_PARSER_VERSION = "1.0.0";

/** Poll cadence: a slow snapshot sweep (Cursor state changes far less often than we poll). */
export const CURSOR_POLL_INTERVAL_MS = 5 * 60_000;

/** Bubble `type` discriminator (spike-proven: present on 100% of bubbles). */
const BUBBLE_TYPE_USER = 1;
const BUBBLE_TYPE_ASSISTANT = 2;

/**
 * Tool `status` tokens we classify as a FAILURE. Cursor's `toolFormerData.status` is not
 * fully enumerated by the spike, so this is best-effort (a knownGap): anything not clearly
 * a failure is counted as completed, mirroring the Gemini parser's `status === "error"` rule.
 */
const FAILED_TOOL_STATUS = new Set([
  "error",
  "failed",
  "cancelled",
  "canceled",
  "aborted",
  "rejected",
]);

interface CursorTokenCount {
  inputTokens?: number;
  outputTokens?: number;
}

interface CursorToolFormerData {
  name?: string;
  status?: unknown;
}

interface CursorBubble {
  type?: number;
  tokenCount?: CursorTokenCount;
  toolFormerData?: CursorToolFormerData;
}

interface CursorModelConfig {
  modelName?: string;
}

interface CursorComposer {
  composerId?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  modelConfig?: CursorModelConfig;
}

/** Map Cursor's `{inputTokens, outputTokens}` onto the normalized token shape (no cache tiers). */
function mapTokens(tc: CursorTokenCount): NormalizedTokens {
  const tokens = zeroTokens();
  tokens.input = tc.inputTokens ?? 0;
  tokens.output = tc.outputTokens ?? 0;
  tokens.total = computeTotal(tokens);
  return tokens;
}

/** Epoch-ms → ISO, guarding NaN/non-finite so a bad timestamp never yields `Invalid Date`. */
function epochMsToIso(ms: unknown): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

/** `modelConfig.modelName` → a REAL model name, or undefined for `"default"`/missing (no cost basis). */
function realModelName(name: string | undefined): string | undefined {
  return name && name !== "default" ? name : undefined;
}

/** Extract `<bubbleId>` from a `bubbleId:<composerId>:<bubbleId>` key (third `:`-segment). */
function bubbleIdFromKey(key: string): string | undefined {
  const parts = key.split(":");
  return parts.length >= 3 ? parts.slice(2).join(":") : undefined;
}

/** Derive the composerId from a bubble key when the composer JSON omits it (defensive fallback). */
function composerIdFromBubbles(bubbles: CursorBubbleRow[]): string | undefined {
  for (const b of bubbles) {
    const parts = b.key.split(":");
    if (parts.length >= 2 && parts[1]) return parts[1];
  }
  return undefined;
}

/**
 * Parse ONE Cursor composer (the whole `composerData` value) plus its bubbles into a
 * `ParseResult`. PURE (string + rows → records/events); tolerant — a malformed composer
 * blob returns an empty result with `skippedLines: 1` (never throws), and a malformed
 * bubble is counted into `skippedLines` while the rest parse.
 */
export function parseCursorComposer(
  composerJson: string,
  bubbles: CursorBubbleRow[],
  opts?: { ingestedAt?: string },
): ParseResult {
  const ingestedAt = opts?.ingestedAt ?? new Date().toISOString();
  const rawRecords: RawSourceRecord[] = [];
  const events: NormalizedEvent[] = [];

  let composer: CursorComposer;
  try {
    composer = JSON.parse(composerJson) as CursorComposer;
  } catch {
    return { rawRecords: [], events: [], skippedLines: 1 };
  }

  const composerId = composer.composerId ?? composerIdFromBubbles(bubbles) ?? "unknown-composer";
  const sessionId = composerId;
  const createdAt = epochMsToIso(composer.createdAt);
  const lastUpdatedAt = epochMsToIso(composer.lastUpdatedAt);
  const model = realModelName(composer.modelConfig?.modelName);
  // No per-bubble timestamps in the store (knownGap) — every event stamps the composer time.
  const eventTs = createdAt ?? ingestedAt;

  const makeEvent = (
    rawRecordId: string,
    eventIndex: number,
    eventType: EventType,
    ts: string,
    eventModel: string | undefined,
    extra: Partial<NormalizedEvent> = {},
  ): NormalizedEvent => ({
    fingerprint: eventFingerprint(CURSOR_CONNECTOR, rawRecordId, eventIndex, eventType),
    sourceConnector: CURSOR_CONNECTOR,
    parserVersion: CURSOR_PARSER_VERSION,
    catalogVersion: PRICING_CATALOG_VERSION,
    rawRecordId,
    eventIndex,
    eventType,
    sessionId,
    model: eventModel,
    ts,
    ...extra,
  });

  // --- composer-envelope raw record (makes Cursor sessions re-parseable; the Gemini lesson) ---
  // Storing the whole composer value as one raw record is what lets a FUTURE server-side re-parse
  // reconstruct a Cursor session (Gemini can't — D-M13-2). The poll's cheap change gate lives in
  // QueueStore (`pollChanged` on the composer value), so an unchanged composer never reaches here;
  // the (volatile) `ingestedAt` therefore only ever rides a genuinely-changed composer, exactly
  // like the Gemini snapshot parser.
  const envelopeId = `${composerId}:composer`;
  rawRecords.push({
    id: envelopeId,
    sourceConnector: CURSOR_CONNECTOR,
    sessionId,
    ingestedAt,
    payload: composerJson,
  });

  // --- session.started ---
  events.push(makeEvent(envelopeId, 0, "session.started", eventTs, undefined));

  // --- one raw record + events per bubble ---
  let skippedLines = 0;
  for (const row of bubbles) {
    const bubbleId = bubbleIdFromKey(row.key);
    if (!bubbleId) {
      skippedLines += 1;
      continue;
    }
    let bubble: CursorBubble;
    try {
      bubble = JSON.parse(row.value) as CursorBubble;
    } catch {
      skippedLines += 1;
      continue;
    }
    rawRecords.push({
      id: bubbleId,
      sourceConnector: CURSOR_CONNECTOR,
      sessionId,
      ingestedAt,
      payload: row.value,
    });

    if (bubble.type === BUBBLE_TYPE_USER) {
      events.push(makeEvent(bubbleId, 0, "message.user", eventTs, undefined));
    } else if (bubble.type === BUBBLE_TYPE_ASSISTANT) {
      events.push(makeEvent(bubbleId, 0, "message.assistant", eventTs, model));
      const tc = bubble.tokenCount;
      // Emit usage only for non-zero counts (zeros are common — partial-fidelity gap).
      if (tc && ((tc.inputTokens ?? 0) > 0 || (tc.outputTokens ?? 0) > 0)) {
        const tokens = mapTokens(tc);
        events.push(makeEvent(bubbleId, 1, "usage.reported", eventTs, model, { tokens }));
        // Cost only when a REAL model name exists (most composers are "default" → no basis).
        if (model) {
          const cost = computeCost(model, tokens);
          events.push(makeEvent(bubbleId, 2, "cost.estimated", eventTs, model, { tokens, cost }));
        }
      }
    }

    // Tool calls: `toolFormerData` presence → started + completion/failure by `status`. Both
    // completion events share index 3 with `started` — safe because eventType differs (the
    // fingerprint hashes connector|rawId|index|eventType), mirroring the Gemini parser.
    if (bubble.toolFormerData) {
      const name = bubble.toolFormerData.name;
      events.push(
        makeEvent(bubbleId, 3, "tool.call.started", eventTs, model, { payload: { name } }),
      );
      const status = bubble.toolFormerData.status;
      const eventType: EventType =
        typeof status === "string" && FAILED_TOOL_STATUS.has(status.toLowerCase())
          ? "tool.call.failed"
          : "tool.call.completed";
      events.push(makeEvent(bubbleId, 3, eventType, eventTs, model, { payload: { name } }));
    }
  }

  // --- session.ended (composer's last-updated time when present, else its created time) ---
  events.push(makeEvent(envelopeId, 0, "session.ended", lastUpdatedAt ?? eventTs, undefined));

  return { rawRecords, events, skippedLines, sessionId: composerId };
}

/**
 * One poll pass over a single Cursor store path. Sweeps composers (cheap), and for each
 * whose content CHANGED since the last pass (`ctx.changed`, persistent across syncs),
 * fetches its bubbles (expensive — only for changed composers) and enqueues the parse.
 * Best-effort: a missing/locked store is reported as `unavailable`, never thrown.
 */
function runCursorPoll(path: string, ctx: PollContext): PollOutcome {
  const outcome: PollOutcome = { swept: 0, changed: 0, rawRecords: 0, events: 0 };
  let store;
  try {
    store = openCursorStore(path);
  } catch {
    return { ...outcome, unavailable: true };
  }
  try {
    for (const composer of store.listComposers()) {
      outcome.swept += 1;
      const key = `composer:${composer.id}`;
      // Change gate keyed on the composer VALUE — an unchanged composer skips the bubble
      // fetch (196 MB corpus) on every tick, not just before its first sync.
      if (!ctx.changed(key, composer.value)) continue;
      const bubbles = store.bubblesFor(composer.id);
      const parsed = parseCursorComposer(composer.value, bubbles);
      ctx.enqueue(parsed);
      // Commit the observation ONLY after a successful enqueue (commit-point ordering,
      // mirroring the FileWatcher): a throw above leaves this composer un-committed so the
      // next tick retries it, rather than stranding it as "seen" with its data undelivered.
      ctx.commit(key, composer.value);
      outcome.changed += 1;
      outcome.rawRecords += parsed.rawRecords.length;
      outcome.events += parsed.events.length;
    }
  } finally {
    store.close();
  }
  return outcome;
}

/**
 * The Cursor connector. `captureMode: "poll"` + empty `watchGlobs` → the FileWatcher
 * ignores it entirely; capture is driven by the `poll` capability (engine `pollLoop`).
 * The vscdb path is declared in `requiredPermissions` AND flows into the capture-surface
 * approval fingerprint (via `poll.sources`), so a path change gates on `connectors.approve`.
 */
export const cursorConnector: Connector = {
  id: CURSOR_CONNECTOR,
  captureMode: "poll",
  fidelity: {
    status: "experimental",
    captureMethod: "poll-sqlite",
    liveness: "snapshot",
    tokens: "estimated",
    cost: "computed",
    knownGaps: [
      "Reverse-engineered store — schema may drift across Cursor versions (fail-soft, experimental)",
      "No per-bubble timestamps — every event stamps the composer's created/updated time",
      "Token counts partial — many bubbles report {0,0}; those get no usage.reported",
      "Model usually 'default' — most composers cannot be costed (cost confidence: unknown)",
    ],
    requiredPermissions: [
      "Read Cursor's SQLite store at %APPDATA%\\Cursor\\User\\globalStorage\\state.vscdb (cursorDiskKV table only; ItemTable is never read)",
    ],
    testedVersions: [],
  },
  // Poll-mode: nothing for the FileWatcher to tail/snapshot.
  watchGlobs: () => [],
  // `parse` is unreachable (no watchGlobs) — capture runs through `poll`. Kept coherent
  // (parses a composer blob with no bubbles) rather than a silent no-op, should it ever run.
  parse: (text) => parseCursorComposer(text, []),
  poll: {
    intervalMs: CURSOR_POLL_INTERVAL_MS,
    // Lazy by construction (arrow body) — `process.env.APPDATA` is read when the engine
    // calls `sources()`, not at module load, so a test can override it first.
    sources: () => [defaultCursorStorePath()],
    run: runCursorPoll,
  },
};
