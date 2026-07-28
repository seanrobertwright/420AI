import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { IngestBatch } from "@420ai/shared";
import {
  createDb,
  ensurePersonalOrg,
  indexSessions,
  ingestBatch,
  insertReportArtifact,
  machines,
  projects,
  setUserPassword,
  users,
  workspaceKeys,
  workspaces,
} from "@420ai/db";
import { buildApp } from "./app.js";
import { hashPassword } from "./password.js";
import { signSession } from "./session.js";
import {
  AnalysisProviderError,
  type AnalysisProvider,
  type AnalysisRequest,
} from "./analysis/provider.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const SERVICE_TOKEN = "svc-token";
const ADMIN_EMAIL = "admin@test.local";
const SESSION_SECRET = "test-secret";
const PASSWORD = "correct-horse";
const SHARED_SESSION = "COLLIDING-SESSION";
const SHARED_PATH = "C:\\dev\\app";

const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used in principal tests", "unavailable");
  },
};

/**
 * M15 15.2 — the HTTP-LAYER proof that a request resolves to a concrete user + org and
 * that every read is scoped to it.
 *
 * The repository suite (`packages/db/.../principal.int.test.ts`) pins the leaks at the
 * query level. This one pins them THROUGH THE ROUTES, because the defect being fixed is
 * as much about routing as querying: ingest authenticated a caller and then re-resolved
 * the actor as the env admin, so a second user's valid session token acted AS THE ADMIN.
 * A repository test cannot see that; only a two-token HTTP test can.
 */
function batch(tag: string, count: number, sessionId: string, projectPath: string): IngestBatch {
  return {
    records: [
      {
        sourceConnector: "claude-code",
        sessionId,
        sourceRecordId: `raw-${tag}`,
        payload: JSON.stringify({ secret: `SECRET-OF-${tag}` }),
      },
    ],
    events: Array.from({ length: count }, (_, i) => ({
      fingerprint: `${tag}-fp-${i}`,
      sourceConnector: "claude-code",
      parserVersion: "1.0.0",
      rawRecordId: `raw-${tag}`,
      eventIndex: i,
      eventType: "usage.reported" as const,
      sessionId,
      projectPath,
      model: "claude-sonnet-5",
      tokens: {
        input: 100,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        reasoning: 0,
        tool: 0,
        total: 100,
      },
      ts: `2026-07-01T00:00:0${i}.000Z`,
    })),
  };
}

describe.skipIf(!TEST_URL)("M15 15.2 request principal (HTTP e2e via inject)", () => {
  let dbh: ReturnType<typeof createDb>;
  let app: FastifyInstance;
  let orgA: string;
  let orgB: string;
  let userA: string;
  let userB: string;
  let tokenA: string;
  let tokenB: string;
  let projectA: string;

  beforeAll(async () => {
    dbh = createDb(TEST_URL!);
    app = buildApp({
      db: dbh.db,
      adminToken: SERVICE_TOKEN,
      // M15 15.4: reconcile on EVERY tick, i.e. exactly pre-15.4 behaviour — tests that assert
      // a firing appears on the first GET must not race the 30 s production throttle.
      reconcileThrottleMs: 0,
      adminEmail: ADMIN_EMAIL,
      sessionSecret: SESSION_SECRET,
      analysisProvider: stubProvider,
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await dbh.pool.end();
  });

  async function login(email: string, password: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { token: string }).token;
  }

  const asUser = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    await dbh.db.execute(
      sql`TRUNCATE search_documents, session_git_links, git_commit_files, git_commits, alert_firings, machine_heartbeats, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    // The bootstrap admin (what ADMIN_TOKEN resolves to) plus two ordinary users.
    await setUserPassword(dbh.db, ADMIN_EMAIL, hashPassword(PASSWORD));
    userA = await setUserPassword(dbh.db, "a@example.com", hashPassword(PASSWORD));
    userB = await setUserPassword(dbh.db, "b@example.com", hashPassword(PASSWORD));
    orgA = await ensurePersonalOrg(dbh.db, userA, "a@example.com");
    orgB = await ensurePersonalOrg(dbh.db, userB, "b@example.com");
    expect(orgA).not.toBe(orgB);

    const [mA] = await dbh.db
      .insert(machines)
      .values({ orgId: orgA, userId: userA, name: "machine-a" })
      .returning({ id: machines.id });
    const [mB] = await dbh.db
      .insert(machines)
      .values({ orgId: orgB, userId: userB, name: "machine-b" })
      .returning({ id: machines.id });

    // Org A owns a project mapped to a path BOTH orgs' machines happen to use.
    const [proj] = await dbh.db
      .insert(projects)
      .values({ orgId: orgA, userId: userA, name: "org-a-project" })
      .returning({ id: projects.id });
    projectA = proj!.id;
    const [ws] = await dbh.db
      .insert(workspaces)
      .values({
        orgId: orgA,
        userId: userA,
        projectId: projectA,
        machineId: mA!.id,
        rootPath: SHARED_PATH,
      })
      .returning({ id: workspaces.id });
    await dbh.db.insert(workspaceKeys).values({
      orgId: orgA,
      userId: userA,
      workspaceId: ws!.id,
      sourceConnector: "claude-code",
      projectKey: SHARED_PATH,
    });

    await ingestBatch(dbh.db, mA!.id, batch("A", 2, SHARED_SESSION, SHARED_PATH));
    await ingestBatch(dbh.db, mB!.id, batch("B", 3, SHARED_SESSION, SHARED_PATH));

    tokenA = await login("a@example.com", PASSWORD);
    tokenB = await login("b@example.com", PASSWORD);
  });

  // 1 ── the headline identity bug.
  it("GET /v1/auth/me returns the CALLER's email, not the env admin's", async () => {
    const a = await app.inject({ method: "GET", url: "/v1/auth/me", headers: asUser(tokenA) });
    const b = await app.inject({ method: "GET", url: "/v1/auth/me", headers: asUser(tokenB) });
    expect(a.json()).toEqual({ email: "a@example.com" });
    // Before 15.2 this returned `admin@test.local` for BOTH callers.
    expect(b.json()).toEqual({ email: "b@example.com" });
  });

  it("GET /v1/projects lists only the caller's own projects", async () => {
    const a = await app.inject({ method: "GET", url: "/v1/projects", headers: asUser(tokenA) });
    const b = await app.inject({ method: "GET", url: "/v1/projects", headers: asUser(tokenB) });
    expect((a.json() as { projects: { id: string }[] }).projects.map((p) => p.id)).toEqual([
      projectA,
    ]);
    expect((b.json() as { projects: unknown[] }).projects).toEqual([]);
  });

  it("GET /v1/sessions/:sessionId returns each org's OWN counts for a shared session id", async () => {
    const a = await app.inject({
      method: "GET",
      url: `/v1/sessions/${SHARED_SESSION}`,
      headers: asUser(tokenA),
    });
    const b = await app.inject({
      method: "GET",
      url: `/v1/sessions/${SHARED_SESSION}`,
      headers: asUser(tokenB),
    });
    // Before 15.2 both returned 5 — the merged projection of both tenants.
    expect((a.json() as { eventCount: number }).eventCount).toBe(2);
    expect((b.json() as { eventCount: number }).eventCount).toBe(3);
  });

  it("GET /v1/projects/:id/usage does not merge another org's events via the shared path", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectA}/usage`,
      headers: asUser(tokenA),
    });
    // Before 15.2 this returned 5 events / 500 input tokens — org B's usage folded in.
    expect((res.json() as { eventCount: number }).eventCount).toBe(2);
  });

  it("org B cannot read org A's project rollup (its own org yields nothing)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectA}/usage`,
      headers: asUser(tokenB),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { eventCount: number }).eventCount).toBe(0);
  });

  it("GET /v1/exports/events never serialises another org's event rows", async () => {
    // The highest-blast-radius instance of the shared-path defect: this endpoint returns
    // whole event ROWS, not aggregates, and `redactJson` strips PII patterns — not other
    // tenants' records. Found in code review, after the repository sweep.
    const own = await app.inject({
      method: "GET",
      url: `/v1/exports/events?format=json&projectId=${projectA}`,
      headers: asUser(tokenA),
    });
    expect(own.statusCode).toBe(200);
    const ownBody = own.json() as { rows: { fingerprint: string }[] };
    expect(ownBody.rows).toHaveLength(2);
    expect(ownBody.rows.every((r) => r.fingerprint.startsWith("A-"))).toBe(true);
    expect(own.body).not.toContain("B-fp-");

    // Org B exporting through org A's project mapping gets nothing.
    const cross = await app.inject({
      method: "GET",
      url: `/v1/exports/events?format=json&projectId=${projectA}`,
      headers: asUser(tokenB),
    });
    expect(cross.statusCode).toBe(200);
    expect((cross.json() as { rows: unknown[] }).rows).toHaveLength(0);

    // …and the owner-scoped (no projectId) export stays within the caller's org.
    const ownerScoped = await app.inject({
      method: "GET",
      url: "/v1/exports/events?format=json",
      headers: asUser(tokenB),
    });
    expect(ownerScoped.body).not.toContain("A-fp-");
  });

  it("GET /v1/search returns only the caller's org's hits", async () => {
    // One pass per org (M15 15.3 made `orgId` required) — the point of the test is that BOTH
    // orgs have a document for the same connector session id, and each caller sees only its own.
    await indexSessions(dbh.db, [SHARED_SESSION], orgA);
    await indexSessions(dbh.db, [SHARED_SESSION], orgB);
    const a = await app.inject({
      method: "GET",
      url: "/v1/search?q=claude-code",
      headers: asUser(tokenA),
    });
    const b = await app.inject({
      method: "GET",
      url: "/v1/search?q=claude-code",
      headers: asUser(tokenB),
    });
    const idsA = (a.json() as { hits: { entityId: string }[] }).hits.map((h) => h.entityId);
    const idsB = (b.json() as { hits: { entityId: string }[] }).hits.map((h) => h.entityId);
    expect(idsA.length).toBeGreaterThan(0);
    expect(idsB.length).toBeGreaterThan(0);
    expect(idsA).not.toContain("B-fp-0");
    expect(idsB).not.toContain("A-fp-0");
  });

  it("GET /v1/reports/:id for ANOTHER org's report is 404 (never 403 — no existence leak)", async () => {
    const row = await insertReportArtifact(dbh.db, "member", {
      orgId: orgA,
      userId: userA,
      projectId: null,
      reportType: "session.autopsy",
      scopeKind: "session",
      scopeId: SHARED_SESSION,
      reportVersion: "m7-report-v1",
      catalogVersion: "m10-catalog-v1",
      analysisVersion: null,
      params: null,
      metrics: {},
      markdown: "# org A only",
    });

    const own = await app.inject({
      method: "GET",
      url: `/v1/reports/${row.id}`,
      headers: asUser(tokenA),
    });
    expect(own.statusCode).toBe(200);

    const other = await app.inject({
      method: "GET",
      url: `/v1/reports/${row.id}`,
      headers: asUser(tokenB),
    });
    expect(other.statusCode).toBe(404);
    expect(other.body).not.toContain("org A only");
  });

  // 2 ── the credential tiers that must NOT regress.
  it("the ADMIN_TOKEN service token still authorizes, as the bootstrap admin principal", async () => {
    // The desktop app and scripts/generate-reports.mjs still carry it until 15.9 (D-M15-7).
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: asUser(SERVICE_TOKEN),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: ADMIN_EMAIL });
  });

  it("a session token whose sub has NO user row is 401 (the intended fail-closed change)", async () => {
    // `adminAuthorized` returned true here — a validly-signed token for a since-deleted
    // user acted as the admin. resolvePrincipal fails closed instead.
    const { token } = signSession("ghost@example.com", SESSION_SECRET, 3600);
    const res = await app.inject({ method: "GET", url: "/v1/auth/me", headers: asUser(token) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "admin authorization required" });
  });

  it("a user with a valid token but NO membership is 401 (ownerless identity fails closed)", async () => {
    const [orphan] = await dbh.db
      .insert(users)
      .values({ email: "orphan@example.com" })
      .returning({ id: users.id });
    expect(orphan).toBeDefined();
    const { token } = signSession("orphan@example.com", SESSION_SECRET, 3600);
    const res = await app.inject({ method: "GET", url: "/v1/auth/me", headers: asUser(token) });
    expect(res.statusCode).toBe(401);
  });

  it("no bearer at all is still 401 with the UNCHANGED error body", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/projects" });
    expect(res.statusCode).toBe(401);
    // The 401 body is asserted across the existing int suites and rendered by the
    // dashboard — 15.2 changes WHO a request is, never what a rejection looks like.
    expect(res.json()).toEqual({ error: "admin authorization required" });
  });
});
