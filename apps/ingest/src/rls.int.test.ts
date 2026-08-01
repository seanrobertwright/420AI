import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { IngestBatch } from "@420ai/shared";
import {
  createDb,
  ensurePersonalOrg,
  ingestBatch,
  machines,
  projects,
  reportArtifacts,
  schema,
  setUserPassword,
  workspaceKeys,
  workspaces,
} from "@420ai/db";
import { buildApp } from "./app.js";
import { hashPassword } from "./password.js";
import {
  AnalysisProviderError,
  type AnalysisProvider,
  type AnalysisRequest,
} from "./analysis/provider.js";
import { seedBootstrapKey } from "./test-support/bootstrap-key.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;
/**
 * M15 15.9 (D-M15-7) — the MACHINE-tier bearer is now a real API KEY, minted per test in the
 * fixture below. `let`, not `const`: `api_keys` carries an FK to `users`, so this suite's TRUNCATE
 * deletes the key with its owner and it must be re-minted after every reset.
 *
 * The NAME is kept so the tests that assert "the machine tier still works here" keep reading as
 * tests of that tier. What changed is the credential behind it: `ADMIN_TOKEN` was one shared,
 * un-attributable, un-revocable string; this is a per-user key, capped at its owner's rung.
 */
let SERVICE_TOKEN: string;
const ADMIN_EMAIL = "admin@test.local";
const SESSION_SECRET = "test-secret";
const PASSWORD = "correct-horse";
/** A connector session id BOTH orgs happen to use — globally scoped, so it can collide. */
const SHARED_SESSION = "COLLIDING-SESSION";
const SHARED_PATH = "C:\\dev\\app";

const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used in RLS tests", "unavailable");
  },
};

/**
 * M15 15.3 — cross-tenant negatives THROUGH THE REAL ENDPOINTS, served by an app built on the
 * NON-OWNER role.
 *
 * The sibling `packages/db/.../rls.int.test.ts` proves the policies enforce at the query layer.
 * This file proves the ROUTES actually carry a context to them — a distinct failure mode, and
 * the one this slice is most likely to get wrong: a handler that forgot its `withOrg` compiles
 * cleanly and, under the OWNER role every other int suite uses, passes every existing test.
 * Only a suite whose app connects as `420ai_app` can tell the difference.
 *
 * WHAT THIS SUITE DOES AND DOES NOT PROVE — measured, not assumed. Both were run:
 *
 *   - Policies DROPPED (RLS still enabled ⇒ Postgres denies every row): 6 of 10 fail. So the
 *     suite is genuinely sensitive to the policies existing and being correct.
 *   - Policies replaced with `USING (true)` (i.e. isolation silently removed, the real leak
 *     scenario): 9 of 10 still PASS. That is not a defect in the tests — it is 15.2 working.
 *     The application-layer `orgId` predicates scope these reads on their own, which is
 *     precisely D-M15-3's design: RLS BACKSTOPS application scoping, it does not replace it.
 *
 * So do not read a green run here as "isolation is enforced by the database". THAT proof lives
 * in `packages/db/src/repositories/rls.int.test.ts`, where dropping a single policy fails 7 of
 * 9 tests. What THIS suite uniquely proves is the other half, which no other test covers:
 * that every route carries a working org context to the policy, and that the whole HTTP surface
 * actually functions under the non-owner role. A handler missing its `withOrg` would return an
 * empty/zeroed projection here (0 rows under a strict policy) while remaining invisible to
 * every owner-connected suite in the repo.
 *
 * The one test that DOES fail against a wide-open policy is the reindex case — because
 * `rebuildSearchIndex` opens with an unqualified DELETE, so without isolation each per-org pass
 * wipes the previous one's work. That is D-15.3-5's failure mode caught directly.
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

describe.skipIf(!TEST_URL || !APP_URL)("M15 15.3 RLS through the HTTP surface", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let app: FastifyInstance;
  let orgA: string;
  let orgB: string;
  let userA: string;
  let userB: string;
  let tokenA: string;
  let tokenB: string;
  let projectA: string;
  let reportB: string;

  beforeAll(async () => {
    owner = createDb(TEST_URL!); // setup + seeding only
    appRole = createDb(APP_URL!); // what the SERVER connects as — the point of this suite
    app = buildApp({
      db: appRole.db,
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
    await owner.pool.end();
    await appRole.pool.end();
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
    // TRUNCATE + seed on the OWNER handle (TRUNCATE requires table ownership).
    await owner.db.execute(
      sql`TRUNCATE search_documents, session_git_links, git_commit_files, git_commits, alert_firings, machine_heartbeats, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    await setUserPassword(owner.db, ADMIN_EMAIL, hashPassword(PASSWORD));
    // M15 15.9 — mint the machine-tier bearer AFTER the truncate + identity seed, because
    // `api_keys` cascades away with `users`.
    SERVICE_TOKEN = await seedBootstrapKey(owner.db, ADMIN_EMAIL);
    userA = await setUserPassword(owner.db, "a@example.com", hashPassword(PASSWORD));
    userB = await setUserPassword(owner.db, "b@example.com", hashPassword(PASSWORD));
    orgA = await ensurePersonalOrg(owner.db, userA, "a@example.com");
    orgB = await ensurePersonalOrg(owner.db, userB, "b@example.com");
    expect(orgA).not.toBe(orgB);

    const [mA] = await owner.db
      .insert(machines)
      .values({ orgId: orgA, userId: userA, name: "machine-a" })
      .returning({ id: machines.id });
    const [mB] = await owner.db
      .insert(machines)
      .values({ orgId: orgB, userId: userB, name: "machine-b" })
      .returning({ id: machines.id });

    // Org A owns a project mapped to a path BOTH orgs' machines happen to use — the shape that
    // merged two tenants' rollups before 15.2 (the `events.project_path = project_key` join).
    const [proj] = await owner.db
      .insert(projects)
      .values({ orgId: orgA, userId: userA, name: "org-a-project" })
      .returning({ id: projects.id });
    projectA = proj!.id;
    const [ws] = await owner.db
      .insert(workspaces)
      .values({
        orgId: orgA,
        userId: userA,
        projectId: projectA,
        machineId: mA!.id,
        rootPath: SHARED_PATH,
      })
      .returning({ id: workspaces.id });
    await owner.db.insert(workspaceKeys).values({
      orgId: orgA,
      userId: userA,
      workspaceId: ws!.id,
      sourceConnector: "claude-code",
      projectKey: SHARED_PATH,
    });

    // Both orgs' events land under the SAME session id and the SAME project path.
    await ingestBatch(owner.db, mA!.id, batch("A", 2, SHARED_SESSION, SHARED_PATH));
    await ingestBatch(owner.db, mB!.id, batch("B", 3, SHARED_SESSION, SHARED_PATH));

    const [rB] = await owner.db
      .insert(reportArtifacts)
      .values({
        orgId: orgB,
        userId: userB,
        reportType: "project.cost_over_time",
        scopeKind: "project",
        scopeId: "scope-b",
        version: 1,
        reportVersion: "1",
        markdown: "ORG-B-REPORT-BODY",
        metrics: {},
        params: {},
      })
      .returning({ id: reportArtifacts.id });
    reportB = rB!.id;

    // Two search documents sharing an (entity_type, entity_id) across orgs — legal since 15.1
    // re-scoped that unique index to (org_id, entity_type, entity_id).
    // NOTE `schema.searchDocuments` (the TABLE): the barrel's `searchDocuments` export is the
    // query FUNCTION — they share a name, and the table deliberately stays behind `schema`.
    await owner.db.insert(schema.searchDocuments).values([
      {
        orgId: orgA,
        userId: userA,
        entityType: "session",
        entityId: SHARED_SESSION,
        title: "A",
        body: "needle orgabody",
        redactionVersion: "1",
      },
      {
        orgId: orgB,
        userId: userB,
        entityType: "session",
        entityId: SHARED_SESSION,
        title: "B",
        body: "needle orgbbody",
        redactionVersion: "1",
      },
    ]);

    tokenA = await login("a@example.com", PASSWORD);
    tokenB = await login("b@example.com", PASSWORD);
  });

  // 0 ── the suite's own precondition. Without it every assertion below could be vacuous.
  it("the server's connection is the non-bypassing app role", async () => {
    const r = await appRole.db.execute<{ u: string; b: boolean }>(
      sql`select current_user as u, (select rolbypassrls from pg_roles where rolname = current_user) as b`,
    );
    expect(r.rows[0]!.u).toBe("420ai_app");
    expect(r.rows[0]!.b).toBe(false);
  });

  // 1 ── a shared connector session id must not merge two tenants' projections.
  it("GET /v1/sessions/:id returns only the caller's org's events for a SHARED session id", async () => {
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
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    // A ingested 2 events, B ingested 3, under the same session id. A merged projection would
    // report 5 to both callers.
    expect((a.json() as { eventCount: number }).eventCount).toBe(2);
    expect((b.json() as { eventCount: number }).eventCount).toBe(3);
    // Neither response may carry the other org's raw payload secret.
    expect(a.body).not.toContain("SECRET-OF-B");
    expect(b.body).not.toContain("SECRET-OF-A");
  });

  // 2 ── org B asking about org A's project gets an EMPTY rollup of its own events, not org A's.
  it("GET /v1/projects/:id/usage does not serve another org's project rollup", async () => {
    const a = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectA}/usage`,
      headers: asUser(tokenA),
    });
    const b = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectA}/usage`,
      headers: asUser(tokenB),
    });
    expect((a.json() as { eventCount: number }).eventCount).toBe(2);
    // The org predicate on the FACT table gives ISOLATION; the predicate on the JOIN gives
    // OWNERSHIP. Without the latter, org B would get a non-empty rollup of ITS OWN events
    // attributed to a project it does not own (the 15.2 corollary).
    expect((b.json() as { eventCount: number }).eventCount).toBe(0);
  });

  // 3 ── search must never surface another org's indexed body.
  it("GET /v1/search returns only the caller's org's documents", async () => {
    const a = await app.inject({
      method: "GET",
      url: "/v1/search?q=needle",
      headers: asUser(tokenA),
    });
    const b = await app.inject({
      method: "GET",
      url: "/v1/search?q=needle",
      headers: asUser(tokenB),
    });
    expect(a.statusCode).toBe(200);
    expect(a.body).toContain("orgabody");
    expect(a.body).not.toContain("orgbbody");
    expect(b.body).toContain("orgbbody");
    expect(b.body).not.toContain("orgabody");
  });

  // 4 ── an org-owned uuid from ANOTHER org is a 404, never that org's content.
  it("GET /v1/reports/:id 404s for another org's report instead of serving it", async () => {
    const b = await app.inject({
      method: "GET",
      url: `/v1/reports/${reportB}`,
      headers: asUser(tokenB),
    });
    expect(b.statusCode).toBe(200); // its owner can read it

    const a = await app.inject({
      method: "GET",
      url: `/v1/reports/${reportB}`,
      headers: asUser(tokenA),
    });
    expect(a.statusCode).toBe(404);
    expect(a.body).not.toContain("ORG-B-REPORT-BODY");
  });

  it("GET /v1/reports/:id/export 404s for another org's report", async () => {
    const a = await app.inject({
      method: "GET",
      url: `/v1/reports/${reportB}/export?format=md`,
      headers: asUser(tokenA),
    });
    expect(a.statusCode).toBe(404);
    expect(a.body).not.toContain("ORG-B-REPORT-BODY");
  });

  // 5 ── the bulk export path is the highest-volume disclosure risk in the app.
  it("GET /v1/exports/events never serialises another org's event rows", async () => {
    const a = await app.inject({
      method: "GET",
      url: "/v1/exports/events?format=jsonl",
      headers: asUser(tokenA),
    });
    expect(a.statusCode).toBe(200);
    const lines = a.body.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2); // org A's two events, not all five
    expect(a.body).not.toContain("B-fp-");

    const b = await app.inject({
      method: "GET",
      url: "/v1/exports/events?format=jsonl",
      headers: asUser(tokenB),
    });
    expect(b.body.trim().split("\n").filter(Boolean)).toHaveLength(3);
    expect(b.body).not.toContain("A-fp-");
  });

  // 6 ── the transcript route is the ONLY one that decrypts. A leak here is plaintext.
  it("GET /v1/sessions/:id/transcript/export does not decrypt another org's payloads", async () => {
    const a = await app.inject({
      method: "GET",
      url: `/v1/sessions/${SHARED_SESSION}/transcript/export?format=json`,
      headers: asUser(tokenA),
    });
    expect(a.statusCode).toBe(200);
    expect(a.body).not.toContain("SECRET-OF-B");
  });

  // 7 ── the monitor snapshot is a WRITE path too (it reconciles alert firings).
  it("GET /v1/monitor scopes its snapshot to the caller's org", async () => {
    const a = await app.inject({ method: "GET", url: "/v1/monitor", headers: asUser(tokenA) });
    expect(a.statusCode).toBe(200);
    const snap = a.json() as { machines: { name: string }[] };
    expect(snap.machines.map((m) => m.name)).toEqual(["machine-a"]);
  });

  // 8 ── a deployment-wide op must still cover EVERY org under the per-org loop (D-15.3-5).
  //      The failure this pins is the silent one: a `{total: 0}` success that did nothing.
  it("POST /v1/search/reindex covers all orgs via the per-org loop, not zero", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/search/reindex",
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const counts = res.json() as { sessions: number; total: number };
    // Both orgs' sessions were indexed — an unwrapped single pass under the app role would
    // have seen zero rows and reported `{total: 0}` with a 200.
    expect(counts.total).toBeGreaterThan(0);

    // And the rebuilt index still holds ONE document per org for the shared session id —
    // never one merged document owned by whichever org won an aggregate (the 15.1 bug).
    const docs = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from search_documents where entity_type = 'session' and entity_id = ${SHARED_SESSION}`,
    );
    expect(docs.rows[0]!.n).toBe(2);
  });

  // 9 ── the OUTBOUND side of the monitor path, which is a different failure mode from test 7.
  //      Test 7 checks what the caller SEES; this checks what the server SENDS. `alert_firings`
  //      carries a strict policy, so a delivery pass made on the unwrapped `app.db` handle reads
  //      zero rows as the app role — no error, no log, just silence. Every existing delivery
  //      test builds on the OWNER handle and therefore cannot see it: the "bypassed ≠ enforced"
  //      trap this slice added to CLAUDE.md, aimed at the slice itself. This test shipped
  //      because /lril:code-review found exactly that bug in this branch.
  it("delivers alert firings under the app role (org-scoped, not silently zero)", async () => {
    const delivered: { alertKey: string }[] = [];
    const deliveryApp = buildApp({
      db: appRole.db,
      // M15 15.4: reconcile on EVERY tick, i.e. exactly pre-15.4 behaviour — tests that assert
      // a firing appears on the first GET must not race the 30 s production throttle.
      reconcileThrottleMs: 0,
      adminEmail: ADMIN_EMAIL,
      sessionSecret: SESSION_SECRET,
      analysisProvider: stubProvider,
      alertDeliverer: { deliver: async (f) => void delivered.push({ alertKey: f.alertKey }) },
      logger: false,
    });
    await deliveryApp.ready();
    try {
      // No seeding: org A's machine has never heartbeat, so the snapshot DERIVES a firing and
      // reconciles it open in the same request. Deriving it rather than inserting one is what
      // makes this end-to-end — a hand-inserted key is not in the derived set, so reconcile
      // would resolve it before the delivery pass ever looked.
      const res = await deliveryApp.inject({
        method: "GET",
        url: "/v1/monitor",
        headers: asUser(await loginOn(deliveryApp, "a@example.com", PASSWORD)),
      });
      expect(res.statusCode).toBe(200);

      // THE assertion. Before the fix this was `[]`: the delivery pass ran on an unwrapped
      // handle, the strict policy filtered every row, and the loop iterated zero times.
      expect(delivered.length).toBeGreaterThan(0);

      // The at-most-once marker was actually written — the stamping UPDATE is policy-scoped
      // too, so an unscoped one would match zero rows and re-deliver on every SSE tick.
      const stamped = await owner.db.execute<{ orgId: string }>(
        sql`select org_id as "orgId" from alert_firings where delivery_attempted_at is not null`,
      );
      expect(stamped.rows.length).toBe(delivered.length);
      // …and only org A's firings were touched, never org B's.
      expect(stamped.rows.every((r) => r.orgId === orgA)).toBe(true);
    } finally {
      await deliveryApp.close();
    }
  });

  /** `login`, but against an arbitrary app instance (test 9 builds its own). */
  async function loginOn(
    target: FastifyInstance,
    email: string,
    password: string,
  ): Promise<string> {
    const res = await target.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { token: string }).token;
  }
});
