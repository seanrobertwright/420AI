import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, ingestBatch, decryptField, users, machines } from "@420ai/db";
import {
  eventFingerprint,
  parseClaudeCodeSession,
  toRawRecordPayload,
  toEventPayload,
  CLAUDE_CODE_CONNECTOR,
  CODEX_CLI_CONNECTOR,
  GEMINI_CLI_CONNECTOR,
  type IngestBatch,
} from "@420ai/shared";
import { buildApp } from "./app.js";
import {
  AnalysisProviderError,
  type AnalysisProvider,
  type AnalysisRequest,
} from "./analysis/provider.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const ADMIN = "test-admin";

// Deterministic stub provider (buildApp requires one; the replay route never calls it).
const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("provider is down", "unavailable");
  },
};

const CODEX_SESSION = "rx-codex-1";

/**
 * The Codex rollout as it sat ON DISK at original capture time. Line 2 was
 * malformed (skipped at capture, never stored) — the reassembly must leave a
 * gap at its index so every stored line keeps its ORIGINAL line index, and with
 * it the rawRecordId and fingerprint. The tool output at line 4 carries a
 * structured failure (exit_code 1) that parser 1.0.0 did not classify — the
 * headline of this test. Its JSON-envelope value embeds braces and colons
 * INSIDE a string, so the reassembly/parse must not trip on structurally
 * significant characters inside values.
 */
const CODEX_LINES: Record<number, string> = {
  0: JSON.stringify({
    timestamp: "2026-07-01T00:00:00.000Z",
    type: "session_meta",
    payload: { id: CODEX_SESSION, cwd: "/home/dev/proj", git: { branch: "main" } },
  }),
  1: JSON.stringify({
    timestamp: "2026-07-01T00:00:01.000Z",
    type: "turn_context",
    payload: { model: "gpt-5.5" },
  }),
  // index 2: malformed at capture — skipped, not stored, but it CONSUMED the index.
  3: JSON.stringify({
    timestamp: "2026-07-01T00:00:02.000Z",
    type: "response_item",
    payload: { type: "function_call", name: "shell", call_id: "c1" },
  }),
  4: JSON.stringify({
    timestamp: "2026-07-01T00:00:03.000Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "c1",
      output: '{"output":"Cannot find path: {weird:value}","metadata":{"exit_code":1}}',
    },
  }),
};

const fpCodex = (rawId: string, idx: number, type: string): string =>
  eventFingerprint(CODEX_CLI_CONNECTOR, rawId, idx, type);

const STALE_COMPLETED_FP = fpCodex(`${CODEX_SESSION}:4`, 0, "tool.call.completed");
const FRESH_FAILED_FP = fpCodex(`${CODEX_SESSION}:4`, 0, "tool.call.failed");

/**
 * The batch parser 1.0.0 produced at capture time: identical raw records, but
 * the failing tool output was typed `tool.call.completed` (1.0.0 had no output
 * classification). Everything except that event's TYPE matches the current
 * parser byte-for-byte, so a re-parse upserts 3 events in place, inserts the
 * `failed` fingerprint, and orphans the stale `completed` one.
 */
function simulatedV1Batch(): IngestBatch {
  const base = {
    sourceConnector: CODEX_CLI_CONNECTOR,
    parserVersion: "1.0.0",
    sessionId: CODEX_SESSION,
    projectPath: "/home/dev/proj",
    gitBranch: "main",
  };
  return {
    records: Object.entries(CODEX_LINES).map(([idx, line]) => ({
      sourceConnector: CODEX_CLI_CONNECTOR,
      sessionId: CODEX_SESSION,
      sourceRecordId: `${CODEX_SESSION}:${idx}`,
      payload: line,
      ingestedAt: "2026-07-01T00:01:00.000Z",
    })),
    events: [
      {
        ...base,
        fingerprint: fpCodex(`${CODEX_SESSION}:session`, 0, "session.started"),
        rawRecordId: `${CODEX_SESSION}:session`,
        eventIndex: 0,
        eventType: "session.started",
        ts: "2026-07-01T00:00:00.000Z",
      },
      {
        ...base,
        fingerprint: fpCodex(`${CODEX_SESSION}:3`, 0, "tool.call.started"),
        rawRecordId: `${CODEX_SESSION}:3`,
        eventIndex: 0,
        eventType: "tool.call.started",
        model: "gpt-5.5",
        ts: "2026-07-01T00:00:02.000Z",
        payload: { name: "shell", call_id: "c1" },
      },
      {
        // THE STALE EVENT: 1.0.0 typed this completed; 2.0.0 classifies it failed.
        ...base,
        fingerprint: STALE_COMPLETED_FP,
        rawRecordId: `${CODEX_SESSION}:4`,
        eventIndex: 0,
        eventType: "tool.call.completed",
        model: "gpt-5.5",
        ts: "2026-07-01T00:00:03.000Z",
        payload: { call_id: "c1" },
      },
      {
        ...base,
        fingerprint: fpCodex(`${CODEX_SESSION}:session`, 0, "session.ended"),
        rawRecordId: `${CODEX_SESSION}:session`,
        eventIndex: 0,
        eventType: "session.ended",
        ts: "2026-07-01T00:00:03.000Z",
      },
    ],
  };
}

describe.skipIf(!TEST_URL)("POST /v1/replay/reparse (integration) — M13 13.3 / 12.5b", () => {
  let dbh: ReturnType<typeof createDb>;
  let app: FastifyInstance;
  let machineId: string;

  beforeAll(async () => {
    dbh = createDb(TEST_URL!);
    app = buildApp({
      db: dbh.db,
      adminToken: ADMIN,
      analysisProvider: stubProvider,
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await dbh.pool.end();
  });

  beforeEach(async () => {
    await dbh.db.execute(
      sql`TRUNCATE pricing_catalogs, raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
    );
    const [u] = await dbh.db
      .insert(users)
      .values({ email: "test@example.com" })
      .returning({ id: users.id });
    const [m] = await dbh.db
      .insert(machines)
      .values({ userId: u!.id, name: "test-machine" })
      .returning({ id: machines.id });
    machineId = m!.id;
  });

  const reparse = (body?: { sessionId?: string }) =>
    app.inject({
      method: "POST",
      url: "/v1/replay/reparse",
      headers: { authorization: `Bearer ${ADMIN}` },
      ...(body ? { payload: body } : {}),
    });

  it("requires admin authorization → 401 without a bearer", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/replay/reparse" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a present-but-invalid sessionId with 400 (manual validation — no body schema)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/replay/reparse",
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { sessionId: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("sessionId must be a non-empty string");
  });

  it("reclassifies a stale-typed Codex event, GCs the orphan, keeps the count stable, and is idempotent", async () => {
    await ingestBatch(dbh.db, machineId, simulatedV1Batch());
    // Precondition: the stale `completed` row exists under parser 1.0.0.
    const before = (
      await dbh.db.execute(
        sql`SELECT count(*)::int AS n FROM events WHERE session_id = ${CODEX_SESSION}`,
      )
    ).rows as unknown as { n: number }[];
    expect(before[0]!.n).toBe(4);

    const res = await reparse();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sessions: 1,
      eventsUpserted: 4,
      orphansDeleted: 1,
      skipped: { gemini: 0, other: 0 },
    });

    // The stale `completed` fingerprint is DELETED (orphan GC)...
    const stale = (
      await dbh.db.execute(
        sql`SELECT count(*)::int AS n FROM events WHERE fingerprint = ${STALE_COMPLETED_FP}`,
      )
    ).rows as unknown as { n: number }[];
    expect(stale[0]!.n).toBe(0);

    // ...replaced by the `failed` event under parser 2.0.0, with the §14 class in
    // its (encrypted) payload — and the model proves turn_context carry-forward
    // survived the line-index reassembly (incl. the gap at the malformed line 2).
    const fresh = (
      await dbh.db.execute(
        sql`SELECT parser_version, model, payload_ciphertext, payload_iv, payload_tag
            FROM events WHERE fingerprint = ${FRESH_FAILED_FP}`,
      )
    ).rows as unknown as {
      parser_version: string;
      model: string;
      payload_ciphertext: string;
      payload_iv: string;
      payload_tag: string;
    }[];
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.parser_version).toBe("2.0.0");
    expect(fresh[0]!.model).toBe("gpt-5.5");
    const payload = JSON.parse(
      decryptField({
        ciphertext: fresh[0]!.payload_ciphertext,
        iv: fresh[0]!.payload_iv,
        tag: fresh[0]!.payload_tag,
      }),
    ) as { failureClass?: string; exitCode?: number };
    expect(payload.failureClass).toBe("tool-runtime");
    expect(payload.exitCode).toBe(1);

    // Total event count is stable (completed swapped for failed, nothing leaked).
    const after = (
      await dbh.db.execute(
        sql`SELECT count(*)::int AS n FROM events WHERE session_id = ${CODEX_SESSION}`,
      )
    ).rows as unknown as { n: number }[];
    expect(after[0]!.n).toBe(4);

    // Raw records stayed sacred — same 4 rows, untouched.
    const raws = (
      await dbh.db.execute(
        sql`SELECT count(*)::int AS n FROM raw_source_records WHERE session_id = ${CODEX_SESSION}`,
      )
    ).rows as unknown as { n: number }[];
    expect(raws[0]!.n).toBe(4);

    // Second run is a no-op: nothing left to GC, state unchanged.
    const res2 = await reparse();
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toEqual({
      sessions: 1,
      eventsUpserted: 4,
      orphansDeleted: 0,
      skipped: { gemini: 0, other: 0 },
    });
    const after2 = (
      await dbh.db.execute(
        sql`SELECT count(*)::int AS n FROM events WHERE session_id = ${CODEX_SESSION}`,
      )
    ).rows as unknown as { n: number }[];
    expect(after2[0]!.n).toBe(4);
  });

  it("skips Gemini sessions and reports them (D-M13-2 — label honestly)", async () => {
    const gemini: IngestBatch = {
      records: [
        {
          sourceConnector: GEMINI_CLI_CONNECTOR,
          sessionId: "gm-1",
          sourceRecordId: "gm-msg-1",
          payload: JSON.stringify({ id: "gm-msg-1", type: "user", content: "hi" }),
        },
      ],
      events: [
        {
          fingerprint: eventFingerprint(GEMINI_CLI_CONNECTOR, "gm-msg-1", 0, "message.user"),
          sourceConnector: GEMINI_CLI_CONNECTOR,
          parserVersion: "1.0.0",
          rawRecordId: "gm-msg-1",
          eventIndex: 0,
          eventType: "message.user",
          sessionId: "gm-1",
          ts: "2026-07-01T00:00:00.000Z",
        },
      ],
    };
    await ingestBatch(dbh.db, machineId, gemini);

    const res = await reparse();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sessions: 0,
      eventsUpserted: 0,
      orphansDeleted: 0,
      skipped: { gemini: 1, other: 0 },
    });

    // The Gemini session's events are untouched.
    const n = (
      await dbh.db.execute(sql`SELECT count(*)::int AS n FROM events WHERE session_id = 'gm-1'`)
    ).rows as unknown as { n: number }[];
    expect(n[0]!.n).toBe(1);
  });

  it("re-parses an already-current Claude session as a pure no-op (0 orphans)", async () => {
    // Build the CURRENT-parser truth for a tiny Claude session, ingest it, then
    // reparse — every fingerprint matches, so nothing is orphaned.
    const claudeText = [
      JSON.stringify({
        type: "user",
        uuid: "u-1",
        sessionId: "rx-claude-1",
        cwd: "/p",
        timestamp: "2026-07-01T01:00:00.000Z",
        message: { role: "user", content: "hi" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a-1",
        sessionId: "rx-claude-1",
        cwd: "/p",
        timestamp: "2026-07-01T01:00:05.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ].join("\n");
    const parsed = parseClaudeCodeSession(claudeText, {
      ingestedAt: "2026-07-01T01:01:00.000Z",
    });
    await ingestBatch(dbh.db, machineId, {
      records: parsed.rawRecords.map(toRawRecordPayload),
      events: parsed.events.map(toEventPayload),
    });
    expect(parsed.rawRecords[0]!.sourceConnector).toBe(CLAUDE_CODE_CONNECTOR);

    const res = await reparse({ sessionId: "rx-claude-1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sessions: 1,
      eventsUpserted: parsed.events.length,
      orphansDeleted: 0,
      skipped: { gemini: 0, other: 0 },
    });
  });

  it("scopes to one session via body.sessionId", async () => {
    await ingestBatch(dbh.db, machineId, simulatedV1Batch());
    const other: IngestBatch = {
      records: [
        {
          sourceConnector: CODEX_CLI_CONNECTOR,
          sessionId: "rx-codex-2",
          sourceRecordId: "rx-codex-2:0",
          payload: JSON.stringify({
            timestamp: "2026-07-02T00:00:00.000Z",
            type: "session_meta",
            payload: { id: "rx-codex-2", cwd: "/x" },
          }),
        },
      ],
      events: [],
    };
    await ingestBatch(dbh.db, machineId, other);

    const res = await reparse({ sessionId: CODEX_SESSION });
    expect(res.statusCode).toBe(200);
    // Only the scoped session was re-parsed (the other codex session untouched).
    expect(res.json().sessions).toBe(1);
    expect(res.json().orphansDeleted).toBe(1);
  });
});
