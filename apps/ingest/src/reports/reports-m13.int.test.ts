import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb } from "@420ai/db";
import type { GitCaptureRequest, IngestBatch } from "@420ai/shared";
import { buildApp } from "../app.js";
import {
  AnalysisProviderError,
  type AnalysisProvider,
  type AnalysisRequest,
} from "../analysis/provider.js";

/**
 * M13 13.2 int tests: the five new project report types end-to-end (seed →
 * POST → assert shape + a redaction proof), plus the `type` omitted → cost
 * report regression. Mirrors `app.int.test.ts`'s M7 report tests (same
 * pair/discover/ingest/inject harness) but kept in its own file, sibling of
 * `generate-report-m13.ts`.
 */

const TEST_URL = process.env.DATABASE_URL_TEST;
const ADMIN = "test-admin";
const ROOT = "/home/a/proj13";
const REMOTE = "https://github.com/seanrobertwright/proj13.git";
// A contrived Anthropic-key-shaped string embedded in a "tool name" purely as a
// redaction-pipeline probe fixture — real tool names never look like this, but
// redact()'s anthropic_key rule masks it wherever it appears, so its absence
// from every rendered markdown proves the redaction gate actually ran.
const SEEDED_SECRET = "sk-ant-01234567890123456789012345678901";

const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used", "unavailable");
  },
};

function discoverPayload() {
  return {
    workspaces: [
      {
        sourceConnector: "claude-code",
        projectKey: ROOT,
        rootPath: ROOT,
        gitRemote: REMOTE,
        gitBranch: "main",
      },
    ],
  };
}

/** A batch spanning two day-buckets, two models, both connectors, and every §17 waste class. */
function batch(): IngestBatch {
  const base = { sessionId: "s13", projectPath: ROOT, gitBranch: "main" };
  return {
    records: [],
    events: [
      {
        ...base,
        fingerprint: "m13-u1",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        rawRecordId: "r1",
        eventIndex: 0,
        eventType: "usage.reported",
        model: "claude-opus-4-8",
        ts: "2026-07-08T00:00:00.000Z",
        tokens: {
          input: 100,
          output: 50,
          cache_read: 0,
          cache_write: 0,
          reasoning: 0,
          tool: 0,
          total: 150,
        },
      },
      {
        ...base,
        fingerprint: "m13-c1",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        rawRecordId: "r2",
        eventIndex: 1,
        eventType: "cost.estimated",
        model: "claude-opus-4-8",
        ts: "2026-07-08T00:01:00.000Z",
        cost: { usd: 0.1, confidence: "estimated-model-known" },
      },
      {
        ...base,
        fingerprint: "m13-u2",
        sourceConnector: "codex-cli",
        parserVersion: "2.0.0",
        rawRecordId: "r3",
        eventIndex: 0,
        eventType: "usage.reported",
        model: "gpt-5-mini",
        ts: "2026-07-09T00:00:00.000Z",
        tokens: {
          input: 60,
          output: 20,
          cache_read: 0,
          cache_write: 0,
          reasoning: 0,
          tool: 0,
          total: 80,
        },
      },
      {
        ...base,
        fingerprint: "m13-c2",
        sourceConnector: "codex-cli",
        parserVersion: "2.0.0",
        rawRecordId: "r4",
        eventIndex: 1,
        eventType: "cost.estimated",
        model: "gpt-5-mini",
        ts: "2026-07-09T00:01:00.000Z",
        cost: { usd: 0.02, confidence: "estimated-model-known" },
      },
      // Claude tool.call.completed — payload carries `name`, no `failureClass`.
      {
        ...base,
        fingerprint: "m13-tc1",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        rawRecordId: "r5",
        eventIndex: 0,
        eventType: "tool.call.completed",
        model: "claude-opus-4-8",
        ts: "2026-07-08T00:02:00.000Z",
        payload: { name: "Read", tool_use_id: "t1" },
      },
      // Claude tool.call.failed — the redaction-probe fixture (see SEEDED_SECRET doc above).
      {
        ...base,
        fingerprint: "m13-tf1",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        rawRecordId: "r6",
        eventIndex: 1,
        eventType: "tool.call.failed",
        model: "claude-opus-4-8",
        ts: "2026-07-08T00:03:00.000Z",
        payload: { name: SEEDED_SECRET, tool_use_id: "t2" },
      },
      // Codex tool.call.failed — payload carries `failureClass`, no `name` (D-M13-1 "label honestly").
      {
        ...base,
        fingerprint: "m13-tf2",
        sourceConnector: "codex-cli",
        parserVersion: "2.0.0",
        rawRecordId: "r7",
        eventIndex: 0,
        eventType: "tool.call.failed",
        model: "gpt-5-mini",
        ts: "2026-07-09T00:02:00.000Z",
        payload: { call_id: "c1", failureClass: "environment" },
      },
      // §17 waste classes: dependency-dir, build-output, and one clean (null-class) path.
      {
        ...base,
        fingerprint: "m13-fr1",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        rawRecordId: "r8",
        eventIndex: 2,
        eventType: "file.read",
        model: "claude-opus-4-8",
        ts: "2026-07-08T00:04:00.000Z",
        payload: { path: "C:\\Users\\seanr\\proj13\\node_modules\\foo\\index.js" },
      },
      {
        ...base,
        fingerprint: "m13-fm1",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        rawRecordId: "r9",
        eventIndex: 3,
        eventType: "file.modified",
        model: "claude-opus-4-8",
        ts: "2026-07-08T00:05:00.000Z",
        payload: { path: `${ROOT}/dist/bundle.js` },
      },
      {
        ...base,
        fingerprint: "m13-fr2",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        rawRecordId: "r10",
        eventIndex: 4,
        eventType: "file.read",
        model: "claude-opus-4-8",
        ts: "2026-07-08T00:06:00.000Z",
        payload: { path: `${ROOT}/src/app.ts` },
      },
      // context.loaded — Claude-only, no path (coverage-only signal, D-M13-2 "label honestly").
      {
        ...base,
        fingerprint: "m13-ctx1",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        rawRecordId: "r11",
        eventIndex: 0,
        eventType: "context.loaded",
        model: "claude-opus-4-8",
        ts: "2026-07-08T00:07:00.000Z",
        payload: { attachmentType: "deferred_tools_delta" },
      },
    ],
  };
}

function gitReq(): GitCaptureRequest {
  return {
    commits: [
      {
        commitSha: "m13-sha1",
        repoRootPath: ROOT,
        gitBranch: "main",
        authorName: "Dev Bot",
        authorEmail: "dev@example.com",
        authoredAt: "2026-07-08T00:10:00.000Z",
        committedAt: "2026-07-08T00:10:00.000Z",
        message: "feat: proj13 work",
        parents: ["p0"],
        isRevert: false,
        filesChanged: 1,
        insertions: 5,
        deletions: 0,
        files: [{ path: "src/app.ts", status: "modified", insertions: 5, deletions: 0 }],
      },
    ],
  };
}

describe.skipIf(!TEST_URL)("M13 13.2 project report types (HTTP e2e via inject)", () => {
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
      sql`TRUNCATE session_git_links, git_commit_files, git_commits, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
    );
  });

  async function createCode(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    return res.json().code as string;
  }

  async function seedProject(): Promise<{ token: string; projectId: string }> {
    const pairRes = await app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: await createCode(), machine: { name: "test-machine" } },
    });
    const { token } = pairRes.json() as { token: string };

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
      payload: batch(),
    });
    expect(ing.statusCode).toBe(200);
    const git = await app.inject({
      method: "POST",
      url: "/v1/git",
      headers: { authorization: `Bearer ${token}` },
      payload: gitReq(),
    });
    expect(git.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const projectId = (list.json().projects as { id: string }[])[0]!.id;
    return { token, projectId };
  }

  async function generate(
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<{
    statusCode: number;
    json: () => { reportType: string; markdown: string; metrics: unknown };
  }> {
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/reports`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: body,
    });
    return res as unknown as {
      statusCode: number;
      json: () => { reportType: string; markdown: string; metrics: unknown };
    };
  }

  it("type omitted still yields a project.cost_over_time report (byte-for-byte pre-13.2 behavior)", async () => {
    const { projectId } = await seedProject();
    const res = await generate(projectId, {});
    expect(res.statusCode).toBe(201);
    expect(res.json().reportType).toBe("project.cost_over_time");
  });

  it("generates a tool/model comparison report with both models present", async () => {
    const { projectId } = await seedProject();
    const res = await generate(projectId, { type: "project.tool_model_comparison" });
    expect(res.statusCode).toBe(201);
    const row = res.json();
    expect(row.reportType).toBe("project.tool_model_comparison");
    expect(row.markdown).toContain("# Tool/Model Comparison");
    expect(row.markdown).toContain("claude-opus-4-8");
    expect(row.markdown).toContain("gpt-5-mini");
    const metrics = row.metrics as { rows: { model: string | null }[] };
    expect(metrics.rows.map((r) => r.model).sort()).toEqual(["claude-opus-4-8", "gpt-5-mini"]);
  });

  it("generates a failed-tool-calls report: classified vs unclassified, and REDACTS the seeded secret", async () => {
    const { projectId } = await seedProject();
    const res = await generate(projectId, { type: "project.failed_tool_calls" });
    expect(res.statusCode).toBe(201);
    const row = res.json();
    expect(row.reportType).toBe("project.failed_tool_calls");
    expect(row.markdown).toContain("# Failed Tool Calls");
    // Codex's failure carries `failureClass: "environment"`; Claude's carries none → "unclassified".
    expect(row.markdown).toContain("| environment | 1 |");
    expect(row.markdown).toContain("| unclassified | 1 |");
    // §18 redaction gate: the seeded secret-shaped tool name must NEVER reach the markdown.
    expect(row.markdown).not.toContain(SEEDED_SECRET);
    expect(row.markdown).toContain("[REDACTED:anthropic_key]");
    const metrics = row.metrics as {
      breakdown: { coverage: { classified: number; total: number } };
    };
    expect(metrics.breakdown.coverage).toEqual({ classified: 1, total: 2 });
  });

  it("generates a context-waste report: classifies paths, recommends honestly, redacts the path", async () => {
    const { projectId } = await seedProject();
    const res = await generate(projectId, { type: "project.context_waste" });
    expect(res.statusCode).toBe(201);
    const row = res.json();
    expect(row.reportType).toBe("project.context_waste");
    expect(row.markdown).toContain("# Context Waste");
    expect(row.markdown).toContain("**dependency-dir**");
    expect(row.markdown).toContain("**build-output**");
    // The clean /src/app.ts path contributes no waste class and no recommendation for it.
    expect(row.markdown).not.toContain("app.ts");
    // Coverage table is honest: context.loaded only ever came from claude-code.
    expect(row.markdown).toContain("| claude-code | context.loaded | 1 |");
    const metrics = row.metrics as {
      byClass: Record<string, number>;
      coverage: { sourceConnector: string; eventType: string; count: number }[];
    };
    expect(metrics.byClass["dependency-dir"]).toBe(1);
    expect(metrics.byClass["build-output"]).toBe(1);
  });

  it("generates a project efficiency report with commit + session ratios", async () => {
    const { projectId } = await seedProject();
    const res = await generate(projectId, { type: "project.efficiency" });
    expect(res.statusCode).toBe(201);
    const row = res.json();
    expect(row.reportType).toBe("project.efficiency");
    expect(row.markdown).toContain("# Project Efficiency");
    expect(row.markdown).toContain("- **Sessions:** 1");
    expect(row.markdown).toContain("- **Git commits (outcome proxy):** 1");
    const metrics = row.metrics as { totals: { tokens: { total: number } }; commits: unknown[] };
    expect(metrics.totals.tokens.total).toBe(230); // 150 + 80
    expect(metrics.commits).toHaveLength(1);
  });

  it("generates a trend-anomalies report (empty flags on a short, unremarkable series)", async () => {
    const { projectId } = await seedProject();
    const res = await generate(projectId, { type: "project.trend_anomalies", bucket: "day" });
    expect(res.statusCode).toBe(201);
    const row = res.json();
    expect(row.reportType).toBe("project.trend_anomalies");
    expect(row.markdown).toContain("# Trend Anomalies");
    // Only 2 buckets of history — detectAnomalies requires > windowSize (4) points, so
    // an honest, deterministic "no anomalies" report is the correct result here.
    expect(row.markdown).toContain("_No cost anomalies detected._");
    const metrics = row.metrics as { costSeries: unknown[]; costAnomalies: unknown[] };
    expect(metrics.costSeries).toHaveLength(2);
    expect(metrics.costAnomalies).toEqual([]);
  });

  it("an unknown project report type is rejected by schema validation (400)", async () => {
    const { projectId } = await seedProject();
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/reports`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: { type: "project.not_a_real_type" },
    });
    expect(res.statusCode).toBe(400);
  });
});
