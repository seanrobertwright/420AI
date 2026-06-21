import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb } from "@420ai/db";
import type { IngestBatch } from "@420ai/shared";
import { buildApp } from "./app.js";
import {
  AnalysisProviderError,
  type AnalysisProvider,
  type AnalysisRequest,
} from "./analysis/provider.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const ADMIN = "test-admin";

// Deterministic stub provider (never used by the export routes, but buildApp requires it).
const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used in export tests", "unavailable");
  },
};

describe.skipIf(!TEST_URL)("export API (HTTP e2e via inject) — PRD §22", () => {
  let dbh: ReturnType<typeof createDb>;
  let app: FastifyInstance;

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
      sql`TRUNCATE report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
    );
  });

  // --- harness (copied from app.int.test.ts; int test files are self-contained) ---

  async function createCode(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    return res.json().code as string;
  }

  async function pair(code: string): Promise<{ token: string; machineId: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code, machine: { name: "test-machine" } },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  const REMOTE = "https://github.com/seanrobertwright/420AI.git";
  const GEMINI_HASH = "2025fdb554a6deadbeef";
  const CLAUDE_KEY = "/home/a/420ai";

  function discoverPayload() {
    return {
      workspaces: [
        {
          sourceConnector: "claude-code",
          projectKey: CLAUDE_KEY,
          rootPath: CLAUDE_KEY,
          gitRemote: REMOTE,
          gitBranch: "main",
        },
        {
          sourceConnector: "claude-code",
          projectKey: "C:\\Users\\seanr\\420AI",
          rootPath: "C:\\Users\\seanr\\420AI",
          gitRemote: REMOTE,
          gitBranch: "m5-project-mapping",
        },
        {
          sourceConnector: "gemini-cli",
          projectKey: GEMINI_HASH,
          rootPath: "/home/a/420ai-gem",
          gitRemote: REMOTE,
        },
      ],
    };
  }

  /** Four attributable events (usage/cost/message/tool) for CLAUDE_KEY, session ms1. */
  function projectionBatch(): IngestBatch {
    const base = {
      sourceConnector: "claude-code",
      parserVersion: "2.0.0",
      sessionId: "ms1",
      projectPath: CLAUDE_KEY,
      gitBranch: "main",
    };
    return {
      records: [],
      events: [
        {
          ...base,
          fingerprint: "m6-u1",
          rawRecordId: "r1",
          eventIndex: 0,
          eventType: "usage.reported",
          model: "claude-opus-4-8",
          ts: "2026-06-14T00:00:00.000Z",
          tokens: {
            input: 100,
            output: 50,
            cache_read: 30,
            cache_write: 20,
            reasoning: 0,
            tool: 0,
            total: 200,
          },
        },
        {
          ...base,
          fingerprint: "m6-c1",
          rawRecordId: "r2",
          eventIndex: 1,
          eventType: "cost.estimated",
          model: "claude-opus-4-8",
          ts: "2026-06-14T00:01:00.000Z",
          cost: { usd: 0.5, confidence: "estimated-model-known" },
        },
        {
          ...base,
          fingerprint: "m6-msg",
          rawRecordId: "r3",
          eventIndex: 2,
          eventType: "message.user",
          ts: "2026-06-14T00:02:00.000Z",
        },
        {
          ...base,
          fingerprint: "m6-tf",
          rawRecordId: "r4",
          eventIndex: 3,
          eventType: "tool.call.failed",
          ts: "2026-06-14T00:03:00.000Z",
        },
      ],
    };
  }

  async function discoverIngestAndGetProject(): Promise<{ token: string; projectId: string }> {
    const { token } = await pair(await createCode());
    await app.inject({
      method: "POST",
      url: "/v1/workspaces/discover",
      headers: { authorization: `Bearer ${token}` },
      payload: discoverPayload(),
    });
    const ing = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${token}` },
      payload: projectionBatch(),
    });
    expect(ing.statusCode).toBe(200);
    const list = await app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const projectId = (list.json().projects as { id: string }[])[0]!.id;
    return { token, projectId };
  }

  const AI_SESSION = "ai-s1";
  const AI_SECRET = "sk-ant-api03-INTEGRATIONTESTKEY0123456789";

  function aiBatch(): IngestBatch {
    return {
      records: [
        {
          sourceConnector: "claude-code",
          sessionId: AI_SESSION,
          sourceRecordId: "ar1",
          payload: JSON.stringify({
            role: "user",
            text: `please use ${AI_SECRET} to call the API`,
          }),
        },
        {
          sourceConnector: "claude-code",
          sessionId: AI_SESSION,
          sourceRecordId: "ar2",
          payload: JSON.stringify({ role: "assistant", text: "sure, here is a plan" }),
        },
      ],
      events: [
        {
          fingerprint: "ai-u",
          sourceConnector: "claude-code",
          parserVersion: "1.0.0",
          rawRecordId: "ar1",
          eventIndex: 0,
          eventType: "message.user",
          sessionId: AI_SESSION,
          ts: "2026-06-14T00:00:00.000Z",
        },
        {
          fingerprint: "ai-a",
          sourceConnector: "claude-code",
          parserVersion: "1.0.0",
          rawRecordId: "ar2",
          eventIndex: 1,
          eventType: "message.assistant",
          sessionId: AI_SESSION,
          ts: "2026-06-14T00:01:00.000Z",
        },
      ],
    };
  }

  async function ingestAiSession(): Promise<void> {
    const { token } = await pair(await createCode());
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${token}` },
      payload: aiBatch(),
    });
    expect(res.statusCode).toBe(200);
  }

  function adminGet(url: string) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${ADMIN}` } });
  }

  // --- events export ---

  it("events export (jsonl): redacts the home path, never leaks ciphertext, sets headers", async () => {
    const { projectId } = await discoverIngestAndGetProject();
    const res = await adminGet(`/v1/exports/events?format=jsonl&projectId=${projectId}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    expect(String(res.headers["content-disposition"])).toMatch(/^attachment;/);
    expect(res.headers["x-export-row-count"]).toBe("4");
    expect(res.headers["x-export-truncated"]).toBe("false");
    expect(res.headers["x-export-redaction-version"]).toBe("m8-redact-v1");

    const rows = res.body
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.projectPath).toBe("/home/[REDACTED:home_user_path]/420ai");
      // ts is canonical ISO 8601, NOT the pg text form ("2026-06-14 00:00:00+00").
      expect(r.ts).toBe(new Date(r.ts).toISOString());
    }
    expect(rows.map((r) => r.ts)).toContain("2026-06-14T00:00:00.000Z");
    // The decrypt path is the transcript route's alone — no ciphertext columns here.
    for (const key of ["ciphertext", "payloadCiphertext", "payloadIv", "payloadTag"]) {
      expect(res.body).not.toContain(key);
    }
  });

  it("events export (csv): header + 4 data rows, text/csv", async () => {
    const { projectId } = await discoverIngestAndGetProject();
    const res = await adminGet(`/v1/exports/events?format=csv&projectId=${projectId}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.body.split("\r\n").filter((l) => l.length > 0);
    expect(lines[0]).toContain("fingerprint,ts,sourceConnector,sessionId,projectPath");
    expect(lines[0]).toContain("tokens_total,cost_usd,cost_confidence");
    expect(lines).toHaveLength(5); // header + 4 data rows
    // the redacted home path rode through CSV intact
    expect(res.body).toContain("/home/[REDACTED:home_user_path]/420ai");
  });

  it("events export (json): carries a stamped manifest", async () => {
    const { projectId } = await discoverIngestAndGetProject();
    const res = await adminGet(`/v1/exports/events?format=json&projectId=${projectId}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = res.json() as {
      manifest: { redactionVersion: string; rowCount: number; truncated: boolean };
      rows: unknown[];
    };
    expect(body.manifest.redactionVersion).toBe("m8-redact-v1");
    expect(body.manifest.rowCount).toBe(4);
    expect(body.manifest.truncated).toBe(false);
    expect(body.rows).toHaveLength(4);
  });

  it("events export honors connector / session / time filters", async () => {
    const { projectId } = await discoverIngestAndGetProject();
    const q = `format=json&projectId=${projectId}`;

    const byConnector = await adminGet(`/v1/exports/events?${q}&connector=claude-code`);
    expect((byConnector.json() as { rows: unknown[] }).rows).toHaveLength(4);
    const noConnector = await adminGet(`/v1/exports/events?${q}&connector=nope`);
    expect((noConnector.json() as { rows: unknown[] }).rows).toHaveLength(0);

    const bySession = await adminGet(`/v1/exports/events?${q}&sessionId=ms1`);
    expect((bySession.json() as { rows: unknown[] }).rows).toHaveLength(4);
    const noSession = await adminGet(`/v1/exports/events?${q}&sessionId=nope`);
    expect((noSession.json() as { rows: unknown[] }).rows).toHaveLength(0);

    // start at 00:00:30 drops the 00:00:00 usage event → 3 remain
    const byStart = await adminGet(`/v1/exports/events?${q}&start=2026-06-14T00:00:30.000Z`);
    expect((byStart.json() as { rows: unknown[] }).rows).toHaveLength(3);

    // an unparseable start → 400
    const badStart = await adminGet(`/v1/exports/events?${q}&start=not-a-date`);
    expect(badStart.statusCode).toBe(400);
    expect(badStart.json().error).toBe("invalid time range");
  });

  // --- report export ---

  it("report export returns md and json with a manifest", async () => {
    const { projectId } = await discoverIngestAndGetProject();
    const gen = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/reports`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: { bucket: "day" },
    });
    expect(gen.statusCode).toBe(201);
    const id = (gen.json() as { id: string }).id;

    const md = await adminGet(`/v1/reports/${id}/export?format=md`);
    expect(md.statusCode).toBe(200);
    expect(md.headers["content-type"]).toContain("text/markdown");
    expect(md.body).toContain("# Project Cost Report — 420AI");

    const json = await adminGet(`/v1/reports/${id}/export?format=json`);
    expect(json.statusCode).toBe(200);
    const body = json.json() as {
      manifest: { redactionVersion: string };
      report: { markdown: string };
    };
    expect(body.manifest.redactionVersion).toBe("m8-redact-v1");
    expect(body.report.markdown).toContain("# Project Cost Report — 420AI");
  });

  // --- transcript export (decrypt-for-render, then redact) ---

  it("transcript export decrypts then redacts: the secret never leaves the archive", async () => {
    await ingestAiSession();

    const json = await adminGet(`/v1/sessions/${AI_SESSION}/transcript/export?format=json`);
    expect(json.statusCode).toBe(200);
    const body = json.json() as {
      manifest: { redactionFindings: { kind: string }[] };
      entries: { role: string; text: string; ts: string }[];
    };
    expect(body.entries.length).toBeGreaterThan(0);
    // transcript entry ts is normalized to canonical ISO (not the pg text form).
    for (const e of body.entries) {
      expect(e.ts).toBe(new Date(e.ts).toISOString());
    }
    const userEntry = body.entries.find((e) => e.role === "user")!;
    // decrypt happened (the prose is there) but the secret is masked.
    expect(userEntry.text).toContain("[REDACTED:anthropic_key]");
    expect(userEntry.text).not.toContain(AI_SECRET);
    expect(body.manifest.redactionFindings.some((f) => f.kind === "anthropic_key")).toBe(true);
    expect(JSON.stringify(body)).not.toContain(AI_SECRET);

    const jsonl = await adminGet(`/v1/sessions/${AI_SESSION}/transcript/export?format=jsonl`);
    expect(jsonl.statusCode).toBe(200);
    expect(jsonl.headers["content-type"]).toContain("application/x-ndjson");
    const lines = jsonl.body.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(body.entries.length);
    expect(jsonl.body).not.toContain(AI_SECRET);

    const md = await adminGet(`/v1/sessions/${AI_SESSION}/transcript/export?format=md`);
    expect(md.statusCode).toBe(200);
    expect(md.headers["content-type"]).toContain("text/markdown");
    expect(md.body).toContain("[REDACTED:");
    expect(md.body).not.toContain(AI_SECRET);
  });

  // --- route contract: auth / validation / 404 ---

  it("enforces auth, format validation, and id guards", async () => {
    const { projectId } = await discoverIngestAndGetProject();

    // no admin bearer → 401
    const noAuth = await app.inject({ method: "GET", url: "/v1/exports/events?format=json" });
    expect(noAuth.statusCode).toBe(401);

    // bad / missing format enum → 400
    expect((await adminGet("/v1/exports/events?format=parquet")).statusCode).toBe(400);
    expect((await adminGet("/v1/exports/events")).statusCode).toBe(400);

    // report id guards
    expect((await adminGet("/v1/reports/not-a-uuid/export?format=md")).statusCode).toBe(404);
    expect(
      (await adminGet("/v1/reports/00000000-0000-4000-8000-000000000000/export?format=md"))
        .statusCode,
    ).toBe(404);

    // well-formed unknown project id → 200 empty (M6 read semantics)
    const unknownProject = await adminGet(
      "/v1/exports/events?format=json&projectId=00000000-0000-4000-8000-000000000000",
    );
    expect(unknownProject.statusCode).toBe(200);
    expect((unknownProject.json() as { manifest: { rowCount: number } }).manifest.rowCount).toBe(0);

    // malformed project id → 404
    expect((await adminGet("/v1/exports/events?format=json&projectId=not-a-uuid")).statusCode).toBe(
      404,
    );

    // a valid known project still works (sanity)
    expect(
      (await adminGet(`/v1/exports/events?format=json&projectId=${projectId}`)).statusCode,
    ).toBe(200);
  });
});
