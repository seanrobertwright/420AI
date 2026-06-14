import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb } from "../index.js";
import { users, machines, events } from "../schema.js";
import {
  findOrCreateProjectByRemote,
  createProject,
  listProjects,
} from "./projects.js";
import {
  upsertWorkspace,
  addWorkspaceKey,
  remapWorkspace,
  listWorkspaces,
  resolveWorkspaceId,
  projectEventSummary,
} from "./workspaces.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const REMOTE = "https://github.com/seanrobertwright/420AI.git";

describe.skipIf(!TEST_URL)("workspaces + projects repositories (integration)", () => {
  let dbh: ReturnType<typeof createDb>;
  let userId: string;
  let machineId: string;

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
  });

  it("upsertWorkspace inserts then updates in place on the same (userId, rootPath)", async () => {
    const root = "C:\\Users\\seanr\\420AI";
    const first = await upsertWorkspace(dbh.db, { userId, machineId, rootPath: root, gitBranch: "main" });
    const second = await upsertWorkspace(dbh.db, {
      userId,
      machineId,
      rootPath: root,
      gitBranch: "m5-project-mapping",
    });
    expect(second.id).toBe(first.id); // same row
    expect(second.gitBranch).toBe("m5-project-mapping"); // updated in place

    const all = await listWorkspaces(dbh.db, userId);
    expect(all).toHaveLength(1);
  });

  it("addWorkspaceKey is idempotent; resolveWorkspaceId returns the workspace+project, or undefined", async () => {
    const ws = await upsertWorkspace(dbh.db, { userId, machineId, rootPath: "/repo", gitRemote: REMOTE });
    const { id: projectId } = await findOrCreateProjectByRemote(dbh.db, userId, REMOTE, "420AI");
    await remapWorkspace(dbh.db, userId, ws.id, projectId);

    await addWorkspaceKey(dbh.db, {
      userId,
      workspaceId: ws.id,
      sourceConnector: "claude-code",
      projectKey: "/repo",
    });
    // re-adding the same key is a no-op (no duplicate row)
    await addWorkspaceKey(dbh.db, {
      userId,
      workspaceId: ws.id,
      sourceConnector: "claude-code",
      projectKey: "/repo",
    });
    const [{ n }] = (
      await dbh.db.execute(sql`SELECT count(*)::int AS n FROM workspace_keys`)
    ).rows as { n: number }[];
    expect(n).toBe(1);

    const resolved = await resolveWorkspaceId(dbh.db, userId, "/repo");
    expect(resolved).toEqual({ workspaceId: ws.id, projectId });

    const miss = await resolveWorkspaceId(dbh.db, userId, "/unknown");
    expect(miss).toBeUndefined();
  });

  it("find-or-create-by-remote unifies two cross-machine workspaces into ONE project (D4)", async () => {
    // Two machines: same remote, DIFFERENT absolute paths.
    const a = await findOrCreateProjectByRemote(dbh.db, userId, REMOTE, "420AI");
    expect(a.created).toBe(true);
    const b = await findOrCreateProjectByRemote(dbh.db, userId, REMOTE, "renamed-should-not-clobber");
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);

    const projs = await listProjects(dbh.db, userId);
    expect(projs).toHaveLength(1);
    // name preserved from the first create (rename not clobbered)
    expect(projs[0]!.name).toBe("420AI");
  });

  it("remapWorkspace repoints project_id", async () => {
    const ws = await upsertWorkspace(dbh.db, { userId, machineId, rootPath: "/r2" });
    const p1 = await createProject(dbh.db, userId, "proj-one");
    const p2 = await createProject(dbh.db, userId, "proj-two");
    await remapWorkspace(dbh.db, userId, ws.id, p1.id);
    const after1 = await listWorkspaces(dbh.db, userId);
    expect(after1[0]!.projectId).toBe(p1.id);
    await remapWorkspace(dbh.db, userId, ws.id, p2.id);
    const after2 = await listWorkspaces(dbh.db, userId);
    expect(after2[0]!.projectId).toBe(p2.id);
  });

  it("Gemini hash key resolves and projectEventSummary counts events joined by project_path", async () => {
    const hash = "2025fdb554a6deadbeef";
    const realPath = "c:\\users\\seanr\\onedrive\\documents\\420ai";
    const ws = await upsertWorkspace(dbh.db, { userId, machineId, rootPath: realPath, gitRemote: REMOTE });
    const { id: projectId } = await findOrCreateProjectByRemote(dbh.db, userId, REMOTE, "420AI");
    await remapWorkspace(dbh.db, userId, ws.id, projectId);
    // Gemini's project_key is the HASH (== events.project_path), NOT the real path.
    await addWorkspaceKey(dbh.db, {
      userId,
      workspaceId: ws.id,
      sourceConnector: "gemini-cli",
      projectKey: hash,
    });

    // Two events whose project_path is the Gemini hash.
    await dbh.db.insert(events).values([
      {
        fingerprint: "g1",
        sourceConnector: "gemini-cli",
        parserVersion: "1.0.0",
        rawRecordId: "r1",
        eventIndex: 0,
        eventType: "message.user",
        sessionId: "s1",
        projectPath: hash,
        ts: "2026-06-14T00:00:00.000Z",
      },
      {
        fingerprint: "g2",
        sourceConnector: "gemini-cli",
        parserVersion: "1.0.0",
        rawRecordId: "r2",
        eventIndex: 0,
        eventType: "message.assistant",
        sessionId: "s1",
        projectPath: hash,
        ts: "2026-06-14T00:01:00.000Z",
      },
    ]);

    const resolved = await resolveWorkspaceId(dbh.db, userId, hash);
    expect(resolved).toEqual({ workspaceId: ws.id, projectId });

    const summary = await projectEventSummary(dbh.db, projectId);
    expect(summary.eventCount).toBe(2);
    expect(summary.lastActivity?.toISOString()).toContain("2026-06-14");
  });

  it("a remote-less workspace's project is NOT unified with another folder", async () => {
    const p1 = await createProject(dbh.db, userId, "folder-a");
    const p2 = await createProject(dbh.db, userId, "folder-b");
    expect(p1.id).not.toBe(p2.id);
    const projs = await listProjects(dbh.db, userId);
    expect(projs).toHaveLength(2);
  });

  it("an event with an unknown project_path is not counted (stays unattributed)", async () => {
    const { id: projectId } = await createProject(dbh.db, userId, "lonely");
    await dbh.db.insert(events).values({
      fingerprint: "x1",
      sourceConnector: "claude-code",
      parserVersion: "2.0.0",
      rawRecordId: "r1",
      eventIndex: 0,
      eventType: "message.user",
      sessionId: "s1",
      projectPath: "/never-mapped",
      ts: "2026-06-14T00:00:00.000Z",
    });
    const summary = await projectEventSummary(dbh.db, projectId);
    expect(summary.eventCount).toBe(0);
    expect(summary.lastActivity).toBeNull();
  });
});
