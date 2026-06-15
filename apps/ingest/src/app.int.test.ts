import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, recordHeartbeat } from "@420ai/db";
import type { IngestBatch, LiveMonitorSnapshot } from "@420ai/shared";
import { buildApp } from "./app.js";
import { AnalysisProviderError, type AnalysisProvider, type AnalysisRequest } from "./analysis/provider.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const ADMIN = "test-admin";

// --- M8 deterministic stub analysis provider (the live call never touches tests) ---
const STUB_MARKDOWN = "## Summary\nstub findings\n```mermaid\ngraph TD; A-->B;\n```";
let providerMode: "ok" | "throw" = "ok";
let lastReq: AnalysisRequest | null = null;
let interpretCalls = 0;
const stubProvider: AnalysisProvider = {
  async interpret(req: AnalysisRequest) {
    interpretCalls++;
    lastReq = req;
    if (providerMode === "throw") {
      throw new AnalysisProviderError("provider is down", "unavailable");
    }
    return { markdown: STUB_MARKDOWN, model: "stub-model", usage: { inputTokens: 5, outputTokens: 7 } };
  },
};

const BATCH: IngestBatch = {
  records: [
    { sourceConnector: "claude-code", sessionId: "s1", sourceRecordId: "r1", payload: "line one" },
    { sourceConnector: "claude-code", sessionId: "s1", sourceRecordId: "r2", payload: "line two" },
  ],
  events: [
    {
      fingerprint: "evt-1",
      sourceConnector: "claude-code",
      parserVersion: "1.0.0",
      rawRecordId: "r1",
      eventIndex: 0,
      eventType: "message.user",
      sessionId: "s1",
      ts: "2026-06-13T00:00:00.000Z",
    },
  ],
};

describe.skipIf(!TEST_URL)("ingest API (HTTP e2e via inject)", () => {
  let dbh: ReturnType<typeof createDb>;
  let app: FastifyInstance;

  beforeAll(async () => {
    dbh = createDb(TEST_URL!);
    app = buildApp({
      db: dbh.db,
      adminToken: ADMIN,
      analysisProvider: stubProvider,
      // M9: a fast SSE cadence so the stream test sees ≥2 snapshots quickly + deterministically.
      monitorStreamIntervalMs: 50,
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

  it("GET /v1/health is open and returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });

  it("POST /v1/pairing-codes requires the admin token", async () => {
    const ok = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    expect(typeof ok.json().code).toBe("string");

    const noAuth = await app.inject({ method: "POST", url: "/v1/pairing-codes", payload: {} });
    expect(noAuth.statusCode).toBe(401);

    const wrong = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: { authorization: "Bearer wrong-admin" },
      payload: {},
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("pairs once and rejects re-redeeming a consumed code with 410", async () => {
    const code = await createCode();
    const { token, machineId } = await pair(code);
    expect(typeof token).toBe("string");
    expect(typeof machineId).toBe("string");

    const again = await app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code, machine: { name: "test-machine" } },
    });
    expect(again.statusCode).toBe(410);
  });

  it("ingests an authed batch and is idempotent through HTTP (PRD §23)", async () => {
    const { token } = await pair(await createCode());

    const first = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${token}` },
      payload: BATCH,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ recordsInserted: 2, eventsUpserted: 1 });

    const second = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${token}` },
      payload: BATCH,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().recordsInserted).toBe(0);
  });

  it("rejects ingest with no token or a garbage token (401)", async () => {
    const noToken = await app.inject({ method: "POST", url: "/v1/ingest", payload: BATCH });
    expect(noToken.statusCode).toBe(401);

    const garbage = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: "Bearer not-a-real-token" },
      payload: BATCH,
    });
    expect(garbage.statusCode).toBe(401);
  });

  it("rejects a malformed ingest body with 400 (schema validation)", async () => {
    const { token } = await pair(await createCode());
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${token}` },
      payload: { records: [] }, // missing required "events"
    });
    expect(res.statusCode).toBe(400);
  });

  // --- M5 discovery → project mapping → attribution round-trip ---

  const REMOTE = "https://github.com/seanrobertwright/420AI.git";
  const GEMINI_HASH = "2025fdb554a6deadbeef";

  function discoverPayload() {
    return {
      workspaces: [
        // two machines, SAME remote, different cwds → must unify to ONE project
        {
          sourceConnector: "claude-code",
          projectKey: "/home/a/420ai",
          rootPath: "/home/a/420ai",
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
        // Gemini: projectKey is the HASH, rootPath is the real path, same remote
        {
          sourceConnector: "gemini-cli",
          projectKey: GEMINI_HASH,
          rootPath: "/home/a/420ai-gem",
          gitRemote: REMOTE,
        },
      ],
    };
  }

  it("discovers workspaces, auto-creates ONE project per remote, and is idempotent", async () => {
    const { token } = await pair(await createCode());

    const first = await app.inject({
      method: "POST",
      url: "/v1/workspaces/discover",
      headers: { authorization: `Bearer ${token}` },
      payload: discoverPayload(),
    });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.workspacesUpserted).toBe(3);
    expect(body.projectsCreated).toBe(1); // all three unify by remote
    expect(body.mappings).toHaveLength(3);
    // every mapping points at the same project
    const projectIds = new Set(body.mappings.map((m: { projectId: string }) => m.projectId));
    expect(projectIds.size).toBe(1);
    // project named from the git remote repo name
    expect(body.mappings[0].projectName).toBe("420AI");

    // idempotent re-POST: upserts, no new projects
    const second = await app.inject({
      method: "POST",
      url: "/v1/workspaces/discover",
      headers: { authorization: `Bearer ${token}` },
      payload: discoverPayload(),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().workspacesUpserted).toBe(3);
    expect(second.json().projectsCreated).toBe(0);
  });

  it("requires machine auth for discover (401 without a token)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/workspaces/discover",
      payload: discoverPayload(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("attributes events (path AND gemini hash) to the project via the summary join", async () => {
    const { token } = await pair(await createCode());
    await app.inject({
      method: "POST",
      url: "/v1/workspaces/discover",
      headers: { authorization: `Bearer ${token}` },
      payload: discoverPayload(),
    });

    // ingest events: one Claude (real path), one Gemini (the hash) — both attribute
    const batch: IngestBatch = {
      records: [],
      events: [
        {
          fingerprint: "m5-evt-claude",
          sourceConnector: "claude-code",
          parserVersion: "2.0.0",
          rawRecordId: "r1",
          eventIndex: 0,
          eventType: "message.user",
          sessionId: "s1",
          projectPath: "/home/a/420ai",
          ts: "2026-06-14T00:00:00.000Z",
        },
        {
          fingerprint: "m5-evt-gemini",
          sourceConnector: "gemini-cli",
          parserVersion: "1.0.0",
          rawRecordId: "r2",
          eventIndex: 0,
          eventType: "message.assistant",
          sessionId: "s2",
          projectPath: GEMINI_HASH,
          ts: "2026-06-14T00:05:00.000Z",
        },
      ],
    };
    const ing = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${token}` },
      payload: batch,
    });
    expect(ing.statusCode).toBe(200);

    // find the project via the admin list, then assert its summary counts both
    const list = await app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(list.statusCode).toBe(200);
    const projects = list.json().projects as { id: string }[];
    expect(projects).toHaveLength(1);

    const summary = await app.inject({
      method: "GET",
      url: `/v1/projects/${projects[0]!.id}/summary`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().eventCount).toBe(2);
    expect(summary.json().lastActivity).toContain("2026-06-14");
  });

  it("remap guards: bad projectId 400, unknown project 404, non-uuid path id 404 (not 500)", async () => {
    const { token } = await pair(await createCode());
    await app.inject({
      method: "POST",
      url: "/v1/workspaces/discover",
      headers: { authorization: `Bearer ${token}` },
      payload: discoverPayload(),
    });
    const wsList = await app.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const wsId = (wsList.json().workspaces as { id: string }[])[0]!.id;

    // non-uuid projectId → 400 (not a Postgres cast 500)
    const badProject = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${wsId}`,
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { projectId: "not-a-uuid" },
    });
    expect(badProject.statusCode).toBe(400);

    // well-formed but unknown projectId → 404 (not a FK 500)
    const unknownProject = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${wsId}`,
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { projectId: "00000000-0000-4000-8000-000000000000" },
    });
    expect(unknownProject.statusCode).toBe(404);

    // non-uuid project path id on rename → 404 (not a cast 500)
    const badRenameId = await app.inject({
      method: "PATCH",
      url: "/v1/projects/not-a-uuid",
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { name: "x" },
    });
    expect(badRenameId.statusCode).toBe(404);

    // non-uuid summary id → 404 (not a cast 500)
    const badSummaryId = await app.inject({
      method: "GET",
      url: "/v1/projects/not-a-uuid/summary",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(badSummaryId.statusCode).toBe(404);
  });

  it("admin project/workspace endpoints 401 without the admin token", async () => {
    const noProjects = await app.inject({ method: "GET", url: "/v1/projects" });
    expect(noProjects.statusCode).toBe(401);
    const noWorkspaces = await app.inject({ method: "GET", url: "/v1/workspaces" });
    expect(noWorkspaces.statusCode).toBe(401);
    const badRename = await app.inject({
      method: "PATCH",
      url: "/v1/projects/some-id",
      headers: { authorization: "Bearer wrong" },
      payload: { name: "x" },
    });
    expect(badRename.statusCode).toBe(401);
  });

  it("remaps a workspace to a different project (the editable mapping)", async () => {
    const { token } = await pair(await createCode());
    await app.inject({
      method: "POST",
      url: "/v1/workspaces/discover",
      headers: { authorization: `Bearer ${token}` },
      payload: discoverPayload(),
    });

    // a fresh manually-created project to remap onto
    const created = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { name: "manual-project" },
    });
    expect(created.statusCode).toBe(200);
    const newProjectId = created.json().id as string;

    const wsList = await app.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const workspaces = wsList.json().workspaces as { id: string }[];
    expect(workspaces.length).toBeGreaterThan(0);

    const remap = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaces[0]!.id}`,
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { projectId: newProjectId },
    });
    expect(remap.statusCode).toBe(200);
    expect(remap.json().projectId).toBe(newProjectId);

    // re-discovery must NOT clobber the manual remap (project_id preserved)
    await app.inject({
      method: "POST",
      url: "/v1/workspaces/discover",
      headers: { authorization: `Bearer ${token}` },
      payload: discoverPayload(),
    });
    const after = await app.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const remapped = (after.json().workspaces as { id: string; projectId: string }[]).find(
      (w) => w.id === workspaces[0]!.id,
    );
    expect(remapped!.projectId).toBe(newProjectId);
  });

  // --- M6 deterministic projection endpoints ---

  const CLAUDE_KEY = "/home/a/420ai";

  /** A batch of attributable events (tokens/cost/varied types) for CLAUDE_KEY. */
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
          tokens: { input: 100, output: 50, cache_read: 30, cache_write: 20, reasoning: 0, tool: 0, total: 200 },
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

  it("projects usage, sessions, session detail, and connector health", async () => {
    const { projectId } = await discoverIngestAndGetProject();

    const usage = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/usage`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().tokens.total).toBe(200);
    expect(usage.json().costUsd).toBeCloseTo(0.5, 10);
    expect(usage.json().costConfidence).toBe("estimated-model-known");

    const sessions = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/sessions`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(sessions.statusCode).toBe(200);
    const sessionRows = sessions.json() as { sessionId: string; userMessages: number; toolsFailed: number }[];
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]!.sessionId).toBe("ms1");
    expect(sessionRows[0]!.userMessages).toBe(1);
    expect(sessionRows[0]!.toolsFailed).toBe(1);

    const detail = await app.inject({
      method: "GET",
      url: "/v1/sessions/ms1",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().eventCount).toBe(4);
    expect(detail.json().tokens.total).toBe(200);

    const health = await app.inject({
      method: "GET",
      url: "/v1/connectors/health",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(health.statusCode).toBe(200);
    const conns = health.json() as { sourceConnector: string; lastEventAt: string }[];
    const claude = conns.find((c) => c.sourceConnector === "claude-code");
    expect(claude!.lastEventAt).toContain("2026-06-14");

    const git = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/git`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(git.statusCode).toBe(200);
    expect(git.json().branches).toEqual(["main"]);
  });

  it("an unknown :sessionId returns a zeroed projection (200, not 404)", async () => {
    await discoverIngestAndGetProject();
    const res = await app.inject({
      method: "GET",
      url: "/v1/sessions/no-such-session",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().eventCount).toBe(0);
    expect(res.json().costConfidence).toBe("unknown");
  });

  it("re-ingesting the same batch does NOT double the projected totals (PRD §23)", async () => {
    const { token, projectId } = await discoverIngestAndGetProject();
    // second identical ingest → fingerprint upsert, no new rows
    await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${token}` },
      payload: projectionBatch(),
    });
    const usage = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/usage`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(usage.json().tokens.total).toBe(200); // not 400
    expect(usage.json().eventCount).toBe(4); // not 8
  });

  it("projection endpoints 401 without the admin token; non-uuid project id → 404", async () => {
    const endpoints = [
      "/v1/projects/00000000-0000-4000-8000-000000000000/usage",
      "/v1/projects/00000000-0000-4000-8000-000000000000/sessions",
      "/v1/projects/00000000-0000-4000-8000-000000000000/usage/by-model",
      "/v1/projects/00000000-0000-4000-8000-000000000000/git",
      "/v1/connectors/health",
    ];
    for (const url of endpoints) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
    }
    // non-uuid project id → 404 (not a Postgres cast 500), with admin auth
    const notUuid = await app.inject({
      method: "GET",
      url: "/v1/projects/not-a-uuid/usage",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(notUuid.statusCode).toBe(404);
  });

  it("rejects an invalid ?bucket on usage/over-time with 400", async () => {
    const { projectId } = await discoverIngestAndGetProject();
    const ok = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/usage/over-time?bucket=day`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/usage/over-time?bucket=month`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(bad.statusCode).toBe(400);
  });

  // --- M7 report generation / fetch / version round-trip ---

  it("generates a project cost report, bumps version on regenerate, fetches + lists", async () => {
    const { projectId } = await discoverIngestAndGetProject();

    const first = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/reports`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: { bucket: "day" },
    });
    expect(first.statusCode).toBe(201);
    const firstRow = first.json() as {
      id: string;
      version: number;
      reportType: string;
      scopeId: string;
      markdown: string;
    };
    expect(firstRow.version).toBe(1);
    expect(firstRow.reportType).toBe("project.cost_over_time");
    expect(firstRow.scopeId).toBe(projectId);
    expect(firstRow.markdown).toContain("# Project Cost Report — 420AI");
    expect(firstRow.markdown).toContain("- **Total tokens:** 200");
    expect(firstRow.markdown).toContain("```mermaid");

    // regenerate the same (type, scope) → version 2, prior retained
    const second = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/reports`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(second.statusCode).toBe(201);
    expect((second.json() as { version: number }).version).toBe(2);

    // fetch the first by id → the stored row
    const fetched = await app.inject({
      method: "GET",
      url: `/v1/reports/${firstRow.id}`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(fetched.statusCode).toBe(200);
    expect((fetched.json() as { id: string }).id).toBe(firstRow.id);

    // history lists both, newest first
    const list = await app.inject({
      method: "GET",
      url: `/v1/reports?scopeId=${projectId}`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as { version: number }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.version).toBe(2); // newest first
  });

  it("generates a session autopsy report with the session counts", async () => {
    await discoverIngestAndGetProject();
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions/ms1/reports",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const row = res.json() as { version: number; scopeId: string; markdown: string };
    expect(row.version).toBe(1);
    expect(row.scopeId).toBe("ms1");
    expect(row.markdown).toContain("# Session Autopsy — ms1");
    expect(row.markdown).toContain("- **Events:** 4 (user: 1, assistant: 0, tool calls: 1)");
    expect(row.markdown).toContain("- **Tool outcomes:** 0 completed, 1 failed");
    expect(row.markdown).toContain("| 100 | 50 | 30 | 20 | 200 |");
  });

  it("report endpoints 401 without the admin token", async () => {
    const { projectId } = await discoverIngestAndGetProject();
    const postProject = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/reports`,
      payload: {},
    });
    expect(postProject.statusCode).toBe(401);
    const postSession = await app.inject({
      method: "POST",
      url: "/v1/sessions/ms1/reports",
      payload: {},
    });
    expect(postSession.statusCode).toBe(401);
    const getOne = await app.inject({ method: "GET", url: "/v1/reports/some-id" });
    expect(getOne.statusCode).toBe(401);
    const listAll = await app.inject({ method: "GET", url: "/v1/reports" });
    expect(listAll.statusCode).toBe(401);
  });

  it("report guards: non-uuid project id → 404, unknown report id → 404, bad type → 400", async () => {
    await discoverIngestAndGetProject();

    // non-uuid project id on generate → 404 (not a Postgres cast 500)
    const badProject = await app.inject({
      method: "POST",
      url: "/v1/projects/not-a-uuid/reports",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(badProject.statusCode).toBe(404);

    // well-formed but NON-EXISTENT project uuid → 404 (not an FK-violation 500)
    const missingProject = await app.inject({
      method: "POST",
      url: "/v1/projects/00000000-0000-4000-8000-000000000000/reports",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(missingProject.statusCode).toBe(404);

    // unknown (well-formed) report id → 404
    const unknownReport = await app.inject({
      method: "GET",
      url: "/v1/reports/00000000-0000-4000-8000-000000000000",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(unknownReport.statusCode).toBe(404);

    // non-uuid report id → 404 (not a cast 500)
    const badReportId = await app.inject({
      method: "GET",
      url: "/v1/reports/not-a-uuid",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(badReportId.statusCode).toBe(404);

    // unknown report type in the body → 400 (schema enum), no row written
    const badType = await app.inject({
      method: "POST",
      url: "/v1/sessions/ms1/reports",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: { type: "not.a.report" },
    });
    expect(badType.statusCode).toBe(400);
  });

  // --- M8 AI interpretation generation (with an injected stub provider) ---

  const AI_SESSION = "ai-s1";
  const AI_SECRET = "sk-ant-api03-INTEGRATIONTESTKEY0123456789";

  /** A session with user/assistant message events + raw records (one carries a secret). */
  function aiBatch(): IngestBatch {
    return {
      records: [
        {
          sourceConnector: "claude-code",
          sessionId: AI_SESSION,
          sourceRecordId: "ar1",
          payload: JSON.stringify({ role: "user", text: `please use ${AI_SECRET} to call the API` }),
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

  it("generates a session interpretation: redacts before send, stores findings, bumps version", async () => {
    providerMode = "ok";
    lastReq = null;
    await ingestAiSession();

    const first = await app.inject({
      method: "POST",
      url: `/v1/sessions/${AI_SESSION}/interpretations`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(first.statusCode).toBe(201);
    const row = first.json() as {
      id: string;
      version: number;
      reportType: string;
      scopeId: string;
      markdown: string;
      metrics: { redactionFindings: { kind: string }[]; model: string };
    };
    expect(row.version).toBe(1);
    expect(row.reportType).toBe("session.ai_interpretation");
    expect(row.scopeId).toBe(AI_SESSION);
    expect(row.markdown).toBe(STUB_MARKDOWN);
    expect(row.metrics.model).toBe("stub-model");
    // The secret was masked BEFORE the provider call (§18) and recorded as metadata.
    expect(row.metrics.redactionFindings.map((f) => f.kind)).toContain("anthropic_key");
    expect(lastReq!.user).toContain("[REDACTED:anthropic_key]");
    expect(lastReq!.user).not.toContain(AI_SECRET);

    // Regenerate → version 2, prior retained.
    const second = await app.inject({
      method: "POST",
      url: `/v1/sessions/${AI_SESSION}/interpretations`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect((second.json() as { version: number }).version).toBe(2);

    // Fetch + list reuse the M7 endpoints.
    const fetched = await app.inject({
      method: "GET",
      url: `/v1/reports/${row.id}`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(fetched.statusCode).toBe(200);
    const list = await app.inject({
      method: "GET",
      url: `/v1/reports?type=session.ai_interpretation&scopeId=${AI_SESSION}`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect((list.json() as unknown[]).length).toBe(2);
  });

  it("generates a project interpretation (metrics-only, no transcript)", async () => {
    providerMode = "ok";
    const { projectId } = await discoverIngestAndGetProject();
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/interpretations`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const row = res.json() as { reportType: string; scopeId: string };
    expect(row.reportType).toBe("project.ai_interpretation");
    expect(row.scopeId).toBe(projectId);
  });

  it("empty/unknown scope → 404 and the provider is NOT called (D8)", async () => {
    providerMode = "ok";
    const before = interpretCalls;

    // Unknown session (no events) → 404, no provider call.
    const noSession = await app.inject({
      method: "POST",
      url: "/v1/sessions/no-such-session/interpretations",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(noSession.statusCode).toBe(404);

    // Non-uuid project id → 404.
    const badProject = await app.inject({
      method: "POST",
      url: "/v1/projects/not-a-uuid/interpretations",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(badProject.statusCode).toBe(404);

    // Well-formed but non-existent project uuid → 404 (existence guard, no FK 500).
    const missingProject = await app.inject({
      method: "POST",
      url: "/v1/projects/00000000-0000-4000-8000-000000000000/interpretations",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(missingProject.statusCode).toBe(404);

    expect(interpretCalls).toBe(before); // no billable provider call escaped
  });

  it("a provider failure maps to a clean 502 (not a leaked 500)", async () => {
    await ingestAiSession();
    providerMode = "throw";
    const res = await app.inject({
      method: "POST",
      url: `/v1/sessions/${AI_SESSION}/interpretations`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("provider is down");
    providerMode = "ok";
  });

  it("interpretation endpoints 401 without the admin token", async () => {
    const postSession = await app.inject({
      method: "POST",
      url: `/v1/sessions/${AI_SESSION}/interpretations`,
      payload: {},
    });
    expect(postSession.statusCode).toBe(401);
    const postProject = await app.inject({
      method: "POST",
      url: "/v1/projects/00000000-0000-4000-8000-000000000000/interpretations",
      payload: {},
    });
    expect(postProject.statusCode).toBe(401);
  });

  // --- M9 Live Monitor: heartbeat round-trip + snapshot + SSE stream ---

  it("POST /v1/heartbeat persists backlog+version; GET /v1/monitor shows an online machine + active session", async () => {
    const { token, machineId } = await pair(await createCode());

    const hb = await app.inject({
      method: "POST",
      url: "/v1/heartbeat",
      headers: { authorization: `Bearer ${token}` },
      payload: { queuePending: 7, queueInflight: 2, collectorVersion: "0.9.1" },
    });
    expect(hb.statusCode).toBe(200);
    expect(hb.json()).toEqual({ ok: true });

    // Timestamp the event ~now so it lands inside the route's 15-min active window
    // (GET /v1/monitor reads the REAL wall clock, D6 — fixed past dates would be excluded).
    const nowIso = new Date().toISOString();
    const ing = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        records: [],
        events: [
          {
            fingerprint: "m9-active",
            sourceConnector: "claude-code",
            parserVersion: "2.0.0",
            rawRecordId: "r1",
            eventIndex: 0,
            eventType: "message.user",
            sessionId: "m9-sess",
            projectPath: "/home/a/420ai",
            gitBranch: "main",
            ts: nowIso,
          },
        ],
      } satisfies IngestBatch,
    });
    expect(ing.statusCode).toBe(200);

    const snap = await app.inject({
      method: "GET",
      url: "/v1/monitor",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(snap.statusCode).toBe(200);
    const body = snap.json() as LiveMonitorSnapshot;
    expect(body.monitorVersion).toBe("m10-monitor-v1");
    expect(body.machines).toHaveLength(1);
    const m = body.machines[0]!;
    expect(m.id).toBe(machineId);
    expect(m.status).toBe("online"); // fresh heartbeat
    expect(m.queuePending).toBe(7);
    expect(m.queueInflight).toBe(2);
    expect(m.collectorVersion).toBe("0.9.1");
    expect(m.backlogHigh).toBe(false); // 7 < 100 threshold
    // the just-ingested session is active; connectors reuse connectorHealth
    expect(body.activeSessions.map((s) => s.sessionId)).toContain("m9-sess");
    expect(body.connectors.map((c) => c.sourceConnector)).toContain("claude-code");
    // M10: alerts ride the snapshot — a fresh-heartbeat machine raises no liveness alert.
    expect(Array.isArray(body.alerts)).toBe(true);
    expect(body.alerts.some((a) => a.code === "collector.offline" && a.machineId === machineId)).toBe(false);
  });

  it("GET /v1/monitor: a machine with an old heartbeat raises a critical collector.offline alert (M10)", async () => {
    const { machineId } = await pair(await createCode());
    // Seed a heartbeat comfortably older than MONITOR_THRESHOLDS.offlineMs (5 min) via the injectable
    // clock — deterministic, no sleeping. The route reads the real wall clock (D6), so this is offline.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await recordHeartbeat(dbh.db, machineId, {
      queuePending: 0,
      queueInflight: 0,
      collectorVersion: "0.9.1",
      now: old,
    });

    const snap = await app.inject({
      method: "GET",
      url: "/v1/monitor",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(snap.statusCode).toBe(200);
    const body = snap.json() as LiveMonitorSnapshot;
    expect(body.machines[0]!.status).toBe("offline");
    const offline = body.alerts.find((a) => a.code === "collector.offline" && a.machineId === machineId);
    expect(offline).toBeDefined();
    expect(offline!.severity).toBe("critical");
  });

  it("GET /v1/monitor and POST /v1/heartbeat enforce their auth (401)", async () => {
    const noAdmin = await app.inject({ method: "GET", url: "/v1/monitor" });
    expect(noAdmin.statusCode).toBe(401);
    const wrongAdmin = await app.inject({
      method: "GET",
      url: "/v1/monitor",
      headers: { authorization: "Bearer wrong-admin" },
    });
    expect(wrongAdmin.statusCode).toBe(401);
    // SSE guard runs BEFORE hijack, so a missing admin token is a clean 401 (D7).
    const noAdminStream = await app.inject({ method: "GET", url: "/v1/monitor/stream" });
    expect(noAdminStream.statusCode).toBe(401);
    // heartbeat is machine-authed — no machine token → 401.
    const noMachine = await app.inject({
      method: "POST",
      url: "/v1/heartbeat",
      payload: { queuePending: 0, queueInflight: 0, collectorVersion: "x" },
    });
    expect(noMachine.statusCode).toBe(401);
  });

  it("GET /v1/monitor/stream pushes ≥2 SSE snapshots over a real socket (recipe B); cancel cleans up", async () => {
    await pair(await createCode()); // ensure the default user/machine exist

    // Recipe B (spike §6): a real port + fetch ReadableStream — inject() cannot test an
    // infinite stream. The 50 ms injected interval makes ≥2 frames arrive quickly.
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`${address}/v1/monitor/stream`, {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let frames = 0;
    // Read until we've seen at least two `data:` frames (then stop — the stream is infinite).
    while (frames < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      frames = buf.split("\n\n").filter((b) => b.startsWith("data: ")).length;
    }
    expect(frames).toBeGreaterThanOrEqual(2);

    // each frame is a real LiveMonitorSnapshot
    const firstFrame = buf.split("\n\n").find((b) => b.startsWith("data: "))!;
    const parsed = JSON.parse(firstFrame.slice("data: ".length)) as LiveMonitorSnapshot;
    expect(parsed.monitorVersion).toBe("m10-monitor-v1");

    // disconnect → the server's `request.raw.on("close")` clears the interval (no leak).
    await reader.cancel();
  });
});
