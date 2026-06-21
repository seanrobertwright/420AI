import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { GitCaptureRequest } from "@420ai/shared";
import { createDb } from "../index.js";
import { users, machines } from "../schema.js";
import { findOrCreateProjectByRemote } from "./projects.js";
import { upsertWorkspace, addWorkspaceKey, remapWorkspace } from "./workspaces.js";
import { recordGitCommits, gitCommitsByProject, gitCommitDetail } from "./git.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const REMOTE = "https://github.com/seanrobertwright/420AI.git";
const ROOT = "/repo";

function sampleReq(sha = "sha1"): GitCaptureRequest {
  return {
    commits: [
      {
        commitSha: sha,
        repoRootPath: ROOT,
        gitBranch: "main",
        authorName: "Dev Bot",
        authorEmail: "dev@example.com",
        authoredAt: "2026-06-14T00:05:00.000Z",
        committedAt: "2026-06-14T00:05:00.000Z",
        message: "feat: a change",
        parents: ["p0"],
        isRevert: false,
        filesChanged: 2,
        insertions: 6,
        deletions: 1,
        files: [
          { path: "src/a.ts", status: "modified", insertions: 5, deletions: 1 },
          { path: "src/b.ts", status: "added", insertions: 1, deletions: 0 },
        ],
      },
    ],
  };
}

describe.skipIf(!TEST_URL)("git repository (integration)", () => {
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
      sql`TRUNCATE session_git_links, git_commit_files, git_commits, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
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

  it("inserts commits + files, and re-running is a no-op (idempotent by SHA, D3)", async () => {
    const first = await recordGitCommits(dbh.db, machineId, sampleReq());
    expect(first.commitsInserted).toBe(1);

    const second = await recordGitCommits(dbh.db, machineId, sampleReq());
    expect(second.commitsInserted).toBe(0); // SHA dedup

    // no duplicate file rows from the re-capture
    const [{ n }] = (await dbh.db.execute(sql`SELECT count(*)::int AS n FROM git_commit_files`))
      .rows as { n: number }[];
    expect(n).toBe(2);
  });

  it("gitCommitsByProject returns commits via the D5 repo-root join (plaintext, no message)", async () => {
    const ws = await upsertWorkspace(dbh.db, {
      userId,
      machineId,
      rootPath: ROOT,
      gitRemote: REMOTE,
    });
    const { id: projectId } = await findOrCreateProjectByRemote(dbh.db, userId, REMOTE, "420AI");
    await remapWorkspace(dbh.db, userId, ws.id, projectId);
    await addWorkspaceKey(dbh.db, {
      userId,
      workspaceId: ws.id,
      sourceConnector: "claude-code",
      projectKey: ROOT,
    });

    await recordGitCommits(dbh.db, machineId, sampleReq());

    const commits = await gitCommitsByProject(dbh.db, projectId);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.commitSha).toBe("sha1");
    expect(commits[0]!.authorEmail).toBe("dev@example.com"); // plaintext metadata
    expect(commits[0]!.filesChanged).toBe(2);
    expect(commits[0]!.authoredAt).toContain("2026-06-14"); // ISO string, verbatim
    // the encrypted commit message is NOT in the read projection
    expect((commits[0] as unknown as { message?: unknown }).message).toBeUndefined();
  });

  it("gitCommitDetail resolves by SHA (scoped to the user) and returns its files", async () => {
    await recordGitCommits(dbh.db, machineId, sampleReq("detailsha"));
    const detail = await gitCommitDetail(dbh.db, userId, "detailsha");
    expect(detail).toBeDefined();
    expect(detail!.commit.commitSha).toBe("detailsha");
    expect(detail!.files).toHaveLength(2);
    // a different user cannot see it
    const [other] = await dbh.db
      .insert(users)
      .values({ email: "other@example.com" })
      .returning({ id: users.id });
    const miss = await gitCommitDetail(dbh.db, other!.id, "detailsha");
    expect(miss).toBeUndefined();
  });

  it("a commit whose repo root maps to no workspace is captured but unattributed", async () => {
    const { id: projectId } = await findOrCreateProjectByRemote(dbh.db, userId, REMOTE, "420AI");
    await recordGitCommits(dbh.db, machineId, sampleReq("orphan"));
    // no workspace_keys row for ROOT → not joined to the project
    const commits = await gitCommitsByProject(dbh.db, projectId);
    expect(commits).toEqual([]);
    // but it IS stored (count > 0)
    const [{ n }] = (await dbh.db.execute(sql`SELECT count(*)::int AS n FROM git_commits`))
      .rows as { n: number }[];
    expect(n).toBe(1);
  });
});
