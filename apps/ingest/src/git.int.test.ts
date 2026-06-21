import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb } from "@420ai/db";
import type { IngestBatch, GitCaptureRequest, SessionGitLink } from "@420ai/shared";
import { buildApp } from "./app.js";
import {
  AnalysisProviderError,
  type AnalysisProvider,
  type AnalysisRequest,
} from "./analysis/provider.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const ADMIN = "test-admin";
const REMOTE = "https://github.com/seanrobertwright/420AI.git";
const ROOT = "/repo";
const SESSION = "gs1";

// M8 deterministic stub provider (never used here, but buildApp requires one).
const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used", "unavailable");
  },
};

/** One commit, authored 5 min after the session's only event → in the ±30 min window. */
function gitReq(sha = "gsha1"): GitCaptureRequest {
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
        message: "feat: edit a.ts",
        parents: ["p0"],
        isRevert: false,
        filesChanged: 1,
        insertions: 3,
        deletions: 0,
        files: [{ path: "src/a.ts", status: "modified", insertions: 3, deletions: 0 }],
      },
    ],
  };
}

/** A session whose file.modified event touched /repo/src/a.ts (absolute path, encrypted payload). */
function sessionBatch(): IngestBatch {
  return {
    records: [],
    events: [
      {
        fingerprint: "gs1-fm",
        sourceConnector: "claude-code",
        parserVersion: "2.0.0",
        rawRecordId: "r1",
        eventIndex: 0,
        eventType: "file.modified",
        sessionId: SESSION,
        projectPath: ROOT,
        ts: "2026-06-14T00:00:00.000Z",
        payload: { path: "/repo/src/a.ts" },
      },
    ],
  };
}

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

describe.skipIf(!TEST_URL)("git outcomes + attribution API (HTTP e2e via inject)", () => {
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

  async function pair(): Promise<{ token: string; machineId: string }> {
    const code = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: code.json().code, machine: { name: "test-machine" } },
    });
    return res.json();
  }

  /** Pair, discover the workspace mapping, ingest the session, and capture the commit. */
  async function setup(): Promise<{ token: string; projectId: string }> {
    const { token } = await pair();
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
      payload: sessionBatch(),
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

  it("POST /v1/git records commits idempotently and is machine-authed", async () => {
    const { token } = await pair();
    const first = await app.inject({
      method: "POST",
      url: "/v1/git",
      headers: { authorization: `Bearer ${token}` },
      payload: gitReq(),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ commitsInserted: 1 });

    const second = await app.inject({
      method: "POST",
      url: "/v1/git",
      headers: { authorization: `Bearer ${token}` },
      payload: gitReq(),
    });
    expect(second.json().commitsInserted).toBe(0); // SHA dedup

    const noAuth = await app.inject({ method: "POST", url: "/v1/git", payload: gitReq() });
    expect(noAuth.statusCode).toBe(401);
  });

  it("GET /v1/projects/:id/git/commits returns the captured commit (no message leaked)", async () => {
    const { projectId } = await setup();
    const res = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/git/commits`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.statusCode).toBe(200);
    const commits = res.json() as { commitSha: string; authorEmail: string }[];
    expect(commits).toHaveLength(1);
    expect(commits[0]!.commitSha).toBe("gsha1");
    expect(commits[0]!.authorEmail).toBe("dev@example.com");
    expect(JSON.stringify(commits[0])).not.toContain("edit a.ts"); // the message stays encrypted
  });

  it("suggest produces a MEDIUM link (decrypt-for-render overlap); manual link + re-suggest preserves it", async () => {
    const { projectId } = await setup();

    // The heuristic decrypts the session's file.modified payload, finds the /repo/src/a.ts
    // overlap with the commit's src/a.ts, and persists a medium suggestion.
    const suggest = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/git/suggest`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(suggest.statusCode).toBe(200);
    const links = suggest.json() as SessionGitLink[];
    const link = links.find((l) => l.sessionId === SESSION && l.commitSha === "gsha1");
    expect(link).toBeDefined();
    expect(link!.confidence).toBe("medium"); // ≥1 file overlap, in window
    expect(link!.status).toBe("suggested");
    expect(link!.fileOverlap).toBe(1);

    // Manually confirm the link.
    const manual = await app.inject({
      method: "POST",
      url: `/v1/sessions/${SESSION}/git-links`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: { commitSha: "gsha1" },
    });
    expect(manual.statusCode).toBe(200);
    expect(manual.json().confidence).toBe("manual");
    expect(manual.json().status).toBe("confirmed");

    // Re-running suggest must NOT clobber the human decision (D6).
    await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/git/suggest`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    const after = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/git/links`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const persisted = (after.json() as SessionGitLink[]).find((l) => l.commitSha === "gsha1");
    expect(persisted!.confidence).toBe("manual"); // preserved
    expect(persisted!.status).toBe("confirmed");
  });

  it("PATCH /v1/git-links/:id confirms a suggested link", async () => {
    const { projectId } = await setup();
    const suggest = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/git/suggest`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    const link = (suggest.json() as SessionGitLink[])[0]!;
    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/git-links/${link.id}`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: { status: "rejected" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().status).toBe("rejected");
  });

  it("guards: unknown ids → 404 (never a constraint/cast 500); admin gate enforced", async () => {
    await setup();
    const goodUuid = "00000000-0000-4000-8000-000000000000";

    // suggest on a well-formed but non-existent project → 404 (existence guard, not FK-500)
    const missing = await app.inject({
      method: "POST",
      url: `/v1/projects/${goodUuid}/git/suggest`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(missing.statusCode).toBe(404);

    // non-uuid project id → 404 (not a Postgres cast 500)
    const badId = await app.inject({
      method: "POST",
      url: "/v1/projects/not-a-uuid/git/suggest",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(badId.statusCode).toBe(404);

    // manual link to an unknown commit SHA → 404 (not an FK-500 on the link insert)
    const badCommit = await app.inject({
      method: "POST",
      url: `/v1/sessions/${SESSION}/git-links`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: { commitSha: "does-not-exist" },
    });
    expect(badCommit.statusCode).toBe(404);

    // PATCH an unknown link id → 404
    const badLink = await app.inject({
      method: "PATCH",
      url: `/v1/git-links/${goodUuid}`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: { status: "confirmed" },
    });
    expect(badLink.statusCode).toBe(404);

    // admin gate: no token → 401
    const noAdmin = await app.inject({ method: "GET", url: "/v1/projects/x/git/commits" });
    expect(noAdmin.statusCode).toBe(401);
  });
});
