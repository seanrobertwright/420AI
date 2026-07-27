import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { IngestBatch } from "@420ai/shared";
import {
  createDb,
  exportEvents,
  getReportArtifact,
  indexSessions,
  ingestBatch,
  insertReportArtifact,
  searchDocuments,
  sessionDetail,
  usageTotals,
} from "../index.js";
import { machines, projects, users, workspaceKeys, workspaces } from "../schema.js";
import { ensurePersonalOrg } from "./organizations.js";
import { findPrincipalByEmail } from "./principal.js";

const TEST_URL = process.env.DATABASE_URL_TEST;

/**
 * M15 15.2 request principal — the slice's REPOSITORY-LAYER negative tests.
 *
 * 15.1 gave every row an `org_id` but deliberately left every READ unscoped. These
 * tests pin the four cross-tenant leaks that state of affairs left behind, each of
 * which was reproduced against this database during planning:
 *
 *   1. `sessionDetail` merged two orgs sharing a connector `session_id`  (returned 8, not 3/5)
 *   2. the `project_path` join merged two orgs' usage into one rollup    (returned 5, not 2)
 *   3. `searchDocuments` searched every tenant's redacted bodies
 *   4. `getReportArtifact` fetched any report by uuid, with no owner check
 *
 * …plus the `report_artifacts_scope_version` race (audit B.3), which under concurrency
 * failed all but 2–3 of N generations with a 23505 surfacing as a 500.
 */

/** A batch whose events all carry `sessionId`/`projectPath`, so both leak shapes are reachable. */
function batch(tag: string, count: number, sessionId: string, projectPath: string): IngestBatch {
  return {
    records: [
      {
        sourceConnector: "claude-code",
        sessionId,
        sourceRecordId: `raw-${tag}`,
        payload: JSON.stringify({ from: tag }),
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

describe.skipIf(!TEST_URL)("M15 15.2 request principal + org-scoped reads (integration)", () => {
  let dbh: ReturnType<typeof createDb>;
  let orgA: string;
  let orgB: string;
  let userA: string;
  let userB: string;
  let machineA: string;
  let machineB: string;

  beforeAll(() => {
    dbh = createDb(TEST_URL!);
  });

  afterAll(async () => {
    await dbh.pool.end();
  });

  beforeEach(async () => {
    await dbh.db.execute(
      sql`TRUNCATE search_documents, session_git_links, git_commit_files, git_commits, alert_firings, machine_heartbeats, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    const seeded = await dbh.db
      .insert(users)
      .values([{ email: "a@example.com" }, { email: "b@example.com" }])
      .returning({ id: users.id, email: users.email });
    userA = seeded.find((u) => u.email === "a@example.com")!.id;
    userB = seeded.find((u) => u.email === "b@example.com")!.id;
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
    machineA = mA!.id;
    machineB = mB!.id;
  });

  // 1 ── the resolver itself
  describe("findPrincipalByEmail", () => {
    it("resolves {userId, email, orgId, role} in one query", async () => {
      const p = await findPrincipalByEmail(dbh.db, "a@example.com");
      expect(p).toEqual({ userId: userA, email: "a@example.com", orgId: orgA, role: "owner" });
    });

    it("returns undefined for an unknown email (no throw)", async () => {
      await expect(findPrincipalByEmail(dbh.db, "nobody@example.com")).resolves.toBeUndefined();
    });

    it("returns undefined for a user with NO membership — an ownerless identity fails closed", async () => {
      const [orphan] = await dbh.db
        .insert(users)
        .values({ email: "orphan@example.com" })
        .returning({ id: users.id });
      expect(orphan).toBeDefined();
      // The user row exists; there is simply no membership. The inner join must drop it,
      // because `adminAuthorized` used to authorize this caller AS THE ADMIN.
      await expect(findPrincipalByEmail(dbh.db, "orphan@example.com")).resolves.toBeUndefined();
    });

    it("resolves a two-membership user DETERMINISTICALLY (oldest membership wins)", async () => {
      // 15.10 needs multi-org users, so nothing constrains "one membership per user".
      // The ORDER BY must mirror findOrgIdByUserId so the two never disagree.
      await dbh.db.execute(
        sql`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgB}, ${userA}, 'member')`,
      );
      const first = await findPrincipalByEmail(dbh.db, "a@example.com");
      const second = await findPrincipalByEmail(dbh.db, "a@example.com");
      expect(first!.orgId).toBe(orgA); // the personal org, created first
      expect(second!.orgId).toBe(first!.orgId); // stable, not flapping
    });
  });

  // 2 ── Spike 1: sessionDetail merged tenants sharing a connector session id.
  it("sessionDetail no longer merges two orgs that share a session id", async () => {
    const SHARED = "COLLIDING-SESSION";
    await ingestBatch(dbh.db, machineA, batch("A", 3, SHARED, "C:\\dev\\app"));
    await ingestBatch(dbh.db, machineB, batch("B", 5, SHARED, "C:\\dev\\app"));

    // Unpatched, BOTH of these returned 8.
    expect((await sessionDetail(dbh.db, orgA, SHARED)).eventCount).toBe(3);
    expect((await sessionDetail(dbh.db, orgB, SHARED)).eventCount).toBe(5);

    // A third org sees nothing at all rather than someone else's session.
    const [u3] = await dbh.db
      .insert(users)
      .values({ email: "c@example.com" })
      .returning({ id: users.id });
    const orgC = await ensurePersonalOrg(dbh.db, u3!.id, "c@example.com");
    expect((await sessionDetail(dbh.db, orgC, SHARED)).eventCount).toBe(0);
  });

  // 3 ── Spike 4: the project_path join merged tenants sharing a path.
  it("usageTotals no longer merges another org's events through the project_path join", async () => {
    const SHARED_PATH = "C:\\dev\\app";
    const [proj] = await dbh.db
      .insert(projects)
      .values({ orgId: orgA, userId: userA, name: "shared-path-project" })
      .returning({ id: projects.id });
    const projectId = proj!.id;
    const [ws] = await dbh.db
      .insert(workspaces)
      .values({
        orgId: orgA,
        userId: userA,
        projectId,
        machineId: machineA,
        rootPath: SHARED_PATH,
      })
      .returning({ id: workspaces.id });
    // workspace_keys needs userId AND sourceConnector beyond the obvious columns.
    await dbh.db.insert(workspaceKeys).values({
      orgId: orgA,
      userId: userA,
      workspaceId: ws!.id,
      sourceConnector: "claude-code",
      projectKey: SHARED_PATH,
    });

    // Both orgs' machines ingest events carrying the SAME project path.
    await ingestBatch(dbh.db, machineA, batch("A", 2, "sess-a", SHARED_PATH));
    await ingestBatch(dbh.db, machineB, batch("B", 3, "sess-b", SHARED_PATH));

    // Unpatched this returned eventCount 5 / input 500 — org B's usage and cost merged
    // into org A's project rollup, even though the project genuinely belongs to org A.
    const totals = await usageTotals(dbh.db, orgA, projectId);
    expect(totals.eventCount).toBe(2);
    expect(totals.tokens.input).toBe(200);

    // And org B cannot read org A's project by passing its own org.
    expect((await usageTotals(dbh.db, orgB, projectId)).eventCount).toBe(0);
  });

  // 3b ── the same path-collision defect on the BULK EXPORT endpoint (found in code review).
  it("exportEvents does not export another org's event ROWS through the project_path join", async () => {
    const SHARED_PATH = "C:\\dev\\app";
    const [proj] = await dbh.db
      .insert(projects)
      .values({ orgId: orgA, userId: userA, name: "shared-path-project" })
      .returning({ id: projects.id });
    const projectId = proj!.id;
    const [ws] = await dbh.db
      .insert(workspaces)
      .values({ orgId: orgA, userId: userA, projectId, machineId: machineA, rootPath: SHARED_PATH })
      .returning({ id: workspaces.id });
    await dbh.db.insert(workspaceKeys).values({
      orgId: orgA,
      userId: userA,
      workspaceId: ws!.id,
      sourceConnector: "claude-code",
      projectKey: SHARED_PATH,
    });

    await ingestBatch(dbh.db, machineA, batch("A", 2, "sess-a", SHARED_PATH));
    await ingestBatch(dbh.db, machineB, batch("B", 3, "sess-b", SHARED_PATH));

    // Unpatched this returned all 5 ROWS — not merged counts, but org B's actual event
    // records serialised out as json/jsonl/csv/parquet. Redaction does not mitigate that.
    const own = await exportEvents(dbh.db, orgA, userA, { projectId });
    expect(own.rows).toHaveLength(2);
    expect(own.rows.every((r) => r.fingerprint.startsWith("A-"))).toBe(true);

    // Org B cannot export through org A's project mapping at all.
    const cross = await exportEvents(dbh.db, orgB, userB, { projectId });
    expect(cross.rows).toHaveLength(0);

    // The owner-scoped (no projectId) branch is org-scoped too.
    const ownerScoped = await exportEvents(dbh.db, orgA, userA, {});
    expect(ownerScoped.rows.every((r) => r.fingerprint.startsWith("A-"))).toBe(true);
  });

  // 4 ── searchDocuments ran over every tenant's redacted bodies.
  it("searchDocuments returns only the caller's org's hits", async () => {
    const SHARED = "COLLIDING-SESSION";
    await ingestBatch(dbh.db, machineA, batch("A", 1, SHARED, "C:\\dev\\app"));
    await ingestBatch(dbh.db, machineB, batch("B", 1, SHARED, "C:\\dev\\app"));
    // One pass per org (M15 15.3 made `orgId` required) — both orgs must be indexed for the
    // "each caller sees only its own hits" assertion below to mean anything.
    await indexSessions(dbh.db, [SHARED], orgA);
    await indexSessions(dbh.db, [SHARED], orgB);

    const hitsA = await searchDocuments(dbh.db, { orgId: orgA, q: "claude-code" });
    const hitsB = await searchDocuments(dbh.db, { orgId: orgB, q: "claude-code" });
    expect(hitsA.hits.length).toBeGreaterThan(0);
    expect(hitsB.hits.length).toBeGreaterThan(0);
    // Neither result set may contain a document owned by the other org.
    const idsA = new Set(hitsA.hits.map((h) => h.entityId));
    const idsB = new Set(hitsB.hits.map((h) => h.entityId));
    expect([...idsA].some((id) => id === "B-fp-0")).toBe(false);
    expect([...idsB].some((id) => id === "A-fp-0")).toBe(false);
  });

  // 5 ── getReportArtifact fetched any report by uuid with no owner check.
  it("getReportArtifact returns undefined for ANOTHER org's report id (404, never 403)", async () => {
    const row = await insertReportArtifact(dbh.db, {
      orgId: orgA,
      userId: userA,
      projectId: null,
      reportType: "session.autopsy",
      scopeKind: "session",
      scopeId: "sess-1",
      reportVersion: "m7-report-v1",
      catalogVersion: "m10-catalog-v1",
      analysisVersion: null,
      params: null,
      metrics: {},
      markdown: "# secret",
    });

    expect((await getReportArtifact(dbh.db, orgA, row.id))!.markdown).toBe("# secret");
    // Indistinguishable from "no such id" — the route turns both into 404, so the
    // existence of another tenant's report never leaks.
    await expect(getReportArtifact(dbh.db, orgB, row.id)).resolves.toBeUndefined();
  });

  // 6 ── audit B.3: the version bump raced and 500ed under concurrency.
  it("8 concurrent generations for one scope all succeed with contiguous versions", async () => {
    const make = (i: number) =>
      insertReportArtifact(dbh.db, {
        orgId: orgA,
        userId: userA,
        projectId: null,
        reportType: "session.autopsy",
        scopeKind: "session",
        scopeId: "raced-scope",
        reportVersion: "m7-report-v1",
        catalogVersion: "m10-catalog-v1",
        analysisVersion: null,
        params: null,
        metrics: {},
        markdown: `# gen ${i}`,
      });

    const settled = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => make(i)));
    const rejected = settled.filter((r) => r.status === "rejected");
    // Unpatched: 2 fulfilled, 6 rejected with 23505 on report_artifacts_scope_version,
    // each surfacing to the client as an opaque 500.
    expect(rejected).toHaveLength(0);

    const versions = settled
      .filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof make>>> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value.version)
      .sort((a, b) => a - b);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
