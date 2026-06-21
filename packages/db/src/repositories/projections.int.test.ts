import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { NormalizedTokens, CostResult } from "@420ai/shared";
import { createDb } from "../index.js";
import { users, machines, events } from "../schema.js";
import { findOrCreateProjectByRemote } from "./projects.js";
import { upsertWorkspace, addWorkspaceKey, remapWorkspace } from "./workspaces.js";
import {
  usageTotals,
  usageByModel,
  usageOverTime,
  sessionProjections,
  sessionDetail,
  connectorHealth,
  projectGitMetadata,
} from "./projections.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const REMOTE = "https://github.com/seanrobertwright/420AI.git";
const PROJECT_KEY = "/home/a/420ai";
const SESSION = "sess-proj-1";

function tokens(partial: Partial<NormalizedTokens>): NormalizedTokens {
  return {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    reasoning: 0,
    tool: 0,
    total: 0,
    ...partial,
  };
}
function cost(usd: number, confidence: CostResult["confidence"]): CostResult {
  return { usd, confidence };
}

describe.skipIf(!TEST_URL)("projections repository (integration)", () => {
  let dbh: ReturnType<typeof createDb>;
  let userId: string;
  let machineId: string;
  let projectId: string;

  beforeAll(() => {
    dbh = createDb(TEST_URL!);
  });

  afterAll(async () => {
    await dbh.pool.end();
  });

  beforeEach(async () => {
    await dbh.db.execute(
      sql`TRUNCATE workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
    );
    const [u] = await dbh.db
      .insert(users)
      .values({ email: "test@example.com" })
      .returning({ id: users.id });
    userId = u!.id;
    const [m] = await dbh.db
      .insert(machines)
      .values({ userId, name: "test-machine" })
      .returning({ id: machines.id });
    machineId = m!.id;

    // Map PROJECT_KEY → workspace → project (the M5 attribution join).
    const ws = await upsertWorkspace(dbh.db, {
      userId,
      machineId,
      rootPath: PROJECT_KEY,
      gitRemote: REMOTE,
    });
    const proj = await findOrCreateProjectByRemote(dbh.db, userId, REMOTE, "420AI");
    projectId = proj.id;
    await remapWorkspace(dbh.db, userId, ws.id, projectId);
    await addWorkspaceKey(dbh.db, {
      userId,
      workspaceId: ws.id,
      sourceConnector: "claude-code",
      projectKey: PROJECT_KEY,
    });
  });

  /** Seed one session with two usage events, two differing-confidence cost events,
   *  message/tool/file events, on a known model — all attributed to PROJECT_KEY. */
  async function seedSession(): Promise<void> {
    await dbh.db.insert(events).values([
      {
        fingerprint: "u1",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        rawRecordId: "r1",
        eventIndex: 0,
        eventType: "usage.reported",
        sessionId: SESSION,
        machineId,
        projectPath: PROJECT_KEY,
        gitBranch: "main",
        model: "claude-opus-4-8",
        ts: "2026-06-14T00:00:00.000Z",
        tokens: tokens({ input: 100, output: 50, cache_read: 30, cache_write: 20, total: 200 }),
      },
      {
        fingerprint: "u2",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        rawRecordId: "r2",
        eventIndex: 1,
        eventType: "usage.reported",
        sessionId: SESSION,
        machineId,
        projectPath: PROJECT_KEY,
        gitBranch: "main",
        model: "gpt-9-ultra",
        ts: "2026-06-15T00:00:00.000Z",
        tokens: tokens({ input: 10, output: 5, cache_read: 3, cache_write: 2, total: 20 }),
      },
      {
        fingerprint: "c1",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        rawRecordId: "r3",
        eventIndex: 2,
        eventType: "cost.estimated",
        sessionId: SESSION,
        machineId,
        projectPath: PROJECT_KEY,
        model: "claude-opus-4-8",
        ts: "2026-06-14T00:01:00.000Z",
        cost: cost(0.5, "estimated-model-known"),
      },
      {
        fingerprint: "c2",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        rawRecordId: "r4",
        eventIndex: 3,
        eventType: "cost.estimated",
        sessionId: SESSION,
        machineId,
        projectPath: PROJECT_KEY,
        model: "gpt-9-ultra",
        ts: "2026-06-15T00:01:00.000Z",
        cost: cost(0.25, "estimated-model-unknown"),
      },
      ...(
        [
          "message.user",
          "message.assistant",
          "tool.call.completed",
          "tool.call.failed",
          "file.read",
          "file.modified",
        ] as const
      ).map((eventType, i) => ({
        fingerprint: `m${i}`,
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        rawRecordId: `rm${i}`,
        eventIndex: 10 + i,
        eventType,
        sessionId: SESSION,
        machineId,
        projectPath: PROJECT_KEY,
        gitBranch: "main",
        ts: `2026-06-14T00:1${i}:00.000Z`,
      })),
    ]);
  }

  it("usageTotals sums the four sub-types, recomputes total, sums cost, lowest-confidence-wins", async () => {
    await seedSession();
    const t = await usageTotals(dbh.db, projectId);
    expect(t.tokens.input).toBe(110);
    expect(t.tokens.output).toBe(55);
    expect(t.tokens.cache_read).toBe(33);
    expect(t.tokens.cache_write).toBe(22);
    expect(t.tokens.total).toBe(220); // Σ subtypes
    expect(t.costUsd).toBeCloseTo(0.75, 10);
    // mixed: estimated-model-known + estimated-model-unknown → the lower wins
    expect(t.costConfidence).toBe("estimated-model-unknown");
    expect(t.eventCount).toBe(10);
  });

  it("empty project → all-zero tokens, costUsd 0, confidence unknown, no sessions", async () => {
    const t = await usageTotals(dbh.db, projectId);
    expect(t.tokens).toEqual(tokens({}));
    expect(t.costUsd).toBe(0);
    expect(t.costConfidence).toBe("unknown");
    expect(t.eventCount).toBe(0);
    expect(await sessionProjections(dbh.db, projectId)).toEqual([]);
  });

  it("usageByModel splits across two models", async () => {
    await seedSession();
    const rows = await usageByModel(dbh.db, projectId);
    // exactly the two real models — no phantom null-model row from message/tool/file events
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.model !== null)).toBe(true);
    const byModel = new Map(rows.map((r) => [r.model, r]));
    expect(byModel.get("claude-opus-4-8")!.tokens.input).toBe(100);
    expect(byModel.get("claude-opus-4-8")!.costUsd).toBeCloseTo(0.5, 10);
    expect(byModel.get("gpt-9-ultra")!.tokens.input).toBe(10);
    expect(byModel.get("gpt-9-ultra")!.costUsd).toBeCloseTo(0.25, 10);
  });

  it("usageOverTime buckets by day, ascending", async () => {
    await seedSession();
    const rows = await usageOverTime(dbh.db, projectId, "day");
    expect(rows).toHaveLength(2); // 06-14 and 06-15
    expect(rows[0]!.bucket).toContain("2026-06-14");
    expect(rows[1]!.bucket).toContain("2026-06-15");
    expect(rows[0]!.tokens.input).toBe(100);
    expect(rows[1]!.tokens.input).toBe(10);
  });

  it("sessionProjections returns exact message/tool/file counts + distinct models + min/max ts", async () => {
    await seedSession();
    const [s] = await sessionProjections(dbh.db, projectId);
    expect(s!.sessionId).toBe(SESSION);
    expect(s!.userMessages).toBe(1);
    expect(s!.assistantMessages).toBe(1);
    expect(s!.toolCalls).toBe(2); // completed + failed
    expect(s!.toolsCompleted).toBe(1);
    expect(s!.toolsFailed).toBe(1);
    expect(s!.filesRead).toBe(1);
    expect(s!.filesModified).toBe(1);
    expect(s!.models.sort()).toEqual(["claude-opus-4-8", "gpt-9-ultra"]);
    expect(s!.startedAt).toContain("2026-06-14");
    expect(s!.endedAt).toContain("2026-06-15");
    expect(s!.tokens.total).toBe(220);
    expect(s!.costConfidence).toBe("estimated-model-unknown");
  });

  it("sessionDetail matches the session; unknown id → zeroed projection (no throw)", async () => {
    await seedSession();
    const detail = await sessionDetail(dbh.db, SESSION);
    expect(detail.eventCount).toBe(10);
    expect(detail.toolsFailed).toBe(1);

    const missing = await sessionDetail(dbh.db, "no-such-session");
    expect(missing.sessionId).toBe("no-such-session");
    expect(missing.eventCount).toBe(0);
    expect(missing.tokens.total).toBe(0);
    expect(missing.costConfidence).toBe("unknown");
  });

  it("connectorHealth returns lastEventAt, failure count, distinct parser versions; counts unattributed", async () => {
    await seedSession();
    // an UNATTRIBUTED event (project_path never mapped) — must still appear in health
    await dbh.db.insert(events).values({
      fingerprint: "orphan",
      sourceConnector: "gemini-cli",
      parserVersion: "1.0.0",
      rawRecordId: "ro",
      eventIndex: 0,
      eventType: "message.user",
      sessionId: "gem-s1",
      machineId,
      projectPath: "unmapped-hash",
      ts: "2026-06-16T00:00:00.000Z",
    });
    // A real connector emits a `tool.call.started` for EVERY call alongside its terminal event.
    // toolCalls must EXCLUDE it (terminal-only denominator) so the failure ratio is honest — this
    // started event must NOT bump toolCalls past the 2 terminal calls seeded above.
    await dbh.db.insert(events).values({
      fingerprint: "cc-started",
      sourceConnector: "claude-code",
      parserVersion: "2.0.0",
      rawRecordId: "rstart",
      eventIndex: 99,
      eventType: "tool.call.started",
      sessionId: SESSION,
      machineId,
      projectPath: PROJECT_KEY,
      ts: "2026-06-14T00:09:00.000Z",
    });
    const health = await connectorHealth(dbh.db, userId);
    const byConn = new Map(health.map((h) => [h.sourceConnector, h]));
    expect(byConn.get("claude-code")!.lastEventAt).toContain("2026-06-15");
    // toolCalls is the count of TERMINAL tool calls (completed + failed) — the M10 failure-ratio
    // denominator. The seeded tool.call.started above is deliberately excluded; toolsFailed is the
    // failed subset (the numerator).
    expect(byConn.get("claude-code")!.toolCalls).toBe(2); // completed + failed, NOT the started
    expect(byConn.get("claude-code")!.toolsFailed).toBe(1);
    expect(byConn.get("claude-code")!.parserVersions).toEqual(["2.0.0"]);
    // unattributed gemini event is still counted in health
    expect(byConn.get("gemini-cli")!.eventCount).toBe(1);
    expect(byConn.get("gemini-cli")!.toolCalls).toBe(0); // a message.user event is not a tool call
    expect(byConn.get("gemini-cli")!.lastEventAt).toContain("2026-06-16");
  });

  it("projectGitMetadata returns distinct branches + project_path keys", async () => {
    await seedSession();
    const git = await projectGitMetadata(dbh.db, projectId);
    expect(git.branches).toEqual(["main"]);
    expect(git.projectPaths).toEqual([PROJECT_KEY]);
  });
});
