import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, ensurePersonalOrg, ingestBatch, setUserPassword } from "@420ai/db";
import { memberships } from "@420ai/db";
import type { IngestBatch } from "@420ai/shared";
import { buildApp } from "../app.js";
import { hashPassword } from "../password.js";
import {
  AnalysisProviderError,
  type AnalysisProvider,
  type AnalysisRequest,
} from "../analysis/provider.js";
import { seedBootstrapKey } from "../test-support/bootstrap-key.js";
import { machines } from "@420ai/db";

/**
 * M16 16.4 — the data-quality audit end-to-end through `buildApp` (research plan §7 P0.3).
 *
 * THE MOST IMPORTANT TEST IN THIS FILE is the empty-org honesty assertion: on an org with zero
 * events, every ratio must render `unknown` and the string `100%` must appear NOWHERE. That is the
 * healthy-looking zero 16.3 shipped a fix for, one layer up — `0 parse failures ÷ 0 raw records`
 * and `0 ÷ 4000` are opposite facts, and a report that badges both identically converts an outage
 * into evidence of success.
 *
 * The `viewer → 403` test asserts the STATUS CODE specifically, because spike F measured the
 * distinction: `report_artifacts_role_write_ins` rejects a viewer's insert at the database, so a
 * route gated at `viewer` would return 500 rather than a clean 403.
 */

const TEST_URL = process.env.DATABASE_URL_TEST;
const ADMIN_EMAIL = "seanrobertwright@gmail.com";
const PASSWORD = "correct-horse-battery-staple";
let ADMIN: string;

const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used", "unavailable");
  },
};

const TS = "2026-08-02T09:00:00.000Z";

function batch(session: string, rawId: string): IngestBatch {
  return {
    records: [
      {
        sourceConnector: "claude-code",
        sessionId: session,
        sourceRecordId: rawId,
        payload: JSON.stringify({ from: rawId }),
      },
    ],
    events: [
      {
        fingerprint: `audit-${rawId}-0`,
        sourceConnector: "claude-code",
        parserVersion: "claude-code@1",
        rawRecordId: rawId,
        eventIndex: 0,
        eventType: "message.user",
        sessionId: session,
        projectPath: "/repo",
        model: "claude-sonnet-5",
        ts: TS,
        tokens: {
          input: 10,
          output: 5,
          cache_read: 0,
          cache_write: 0,
          reasoning: 0,
          tool: 0,
          total: 15,
        },
      },
    ],
  };
}

describe.skipIf(!TEST_URL)("M16 16.4 data-quality audit (HTTP e2e via inject)", () => {
  let dbh: ReturnType<typeof createDb>;
  let app: FastifyInstance;
  let orgA: string;
  let userA: string;
  let machineA: string;
  let userViewer: string;

  beforeAll(async () => {
    dbh = createDb(TEST_URL!);
    app = buildApp({
      db: dbh.db,
      reconcileThrottleMs: 0,
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
      sql`TRUNCATE search_documents, session_git_links, git_commit_files, git_commits,
          report_artifacts, workspace_keys, workspaces, projects, machine_connectors,
          raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships,
          organizations, users RESTART IDENTITY CASCADE`,
    );
    userA = await setUserPassword(dbh.db, ADMIN_EMAIL, hashPassword(PASSWORD));
    // Re-minted after every TRUNCATE — `api_keys` FKs to `users` and cascades away with it.
    ADMIN = await seedBootstrapKey(dbh.db, ADMIN_EMAIL);
    // THE SEEDED MACHINE MUST BELONG TO THE BEARER'S OWN ORG. The audit is org-scoped and takes
    // its `scopeId` from `principal.orgId`, so events ingested under some other org's machine are
    // correctly invisible to it — which reads as "the derivation is broken" rather than "the
    // fixture is wrong". Resolving the admin's personal org here removes the trap.
    orgA = await ensurePersonalOrg(dbh.db, userA, ADMIN_EMAIL);

    userViewer = await setUserPassword(dbh.db, "viewer@example.com", hashPassword(PASSWORD));
    // MOVE the viewer's membership into the admin's org — never INSERT a second one.
    // `setUserPassword` auto-creates a personal `owner` membership via `ensurePersonalOrg`, and
    // `findPrincipalByEmail` resolves the FIRST membership by `(created_at, id)`, so an INSERTed
    // second membership is silently shadowed and every "viewer" assertion would test an owner
    // (the M15 15.4 seeding bug).
    await dbh.db
      .update(memberships)
      .set({ orgId: orgA, role: "viewer" })
      .where(eq(memberships.userId, userViewer));

    const [m] = await dbh.db
      .insert(machines)
      .values({ orgId: orgA, userId: userA, name: "machine-a" })
      .returning({ id: machines.id });
    machineA = m!.id;
  });

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { token: string }).token;
  }

  const generate = (token: string, payload: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/v1/audit/data-quality",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload,
    });

  async function seedEvents(): Promise<void> {
    await ingestBatch(dbh.db, machineA, batch("s1", "r1"));
    await ingestBatch(dbh.db, machineA, batch("s2", "r2"));
  }

  it("generates an ORG-scoped artifact with a null projectId, and bumps its version", async () => {
    await seedEvents();
    const first = await generate(ADMIN);
    expect(first.statusCode).toBe(201);
    const a = first.json() as Record<string, unknown>;
    expect(a).toMatchObject({
      reportType: "org.data_quality_audit",
      scopeKind: "org",
      projectId: null,
      version: 1,
      reportVersion: "m16-audit-v1",
      // No cost figures in this report, so no pricing catalog is stamped.
      catalogVersion: null,
      analysisVersion: null,
    });
    expect(a.params).toEqual({ windowDays: 7, sampleSize: 10 });
    // `org_id` must NOT reach the wire: no ingest route declares a Fastify response schema, so a
    // bare `returning()` would have put it there (the 15.1 rule).
    expect(a).not.toHaveProperty("orgId");
    expect(a).not.toHaveProperty("org_id");

    const second = await generate(ADMIN);
    expect(second.statusCode).toBe(201);
    expect((second.json() as { version: number }).version).toBe(2);
  });

  it("honours an explicit window and sample size, and stores both in params", async () => {
    await seedEvents();
    const res = await generate(ADMIN, { windowDays: 30, sampleSize: 2 });
    expect(res.statusCode).toBe(201);
    const row = res.json() as { params: unknown; metrics: { windowDays: number } };
    expect(row.params).toEqual({ windowDays: 30, sampleSize: 2 });
    expect(row.metrics.windowDays).toBe(30);
  });

  it("rejects an out-of-range sample size at the schema, before any decrypt work", async () => {
    const res = await generate(ADMIN, { sampleSize: 500 });
    expect(res.statusCode).toBe(400);
  });

  it("lists, fetches and EXPORTS through the existing M12 endpoints, unchanged", async () => {
    await seedEvents();
    const created = (await generate(ADMIN)).json() as { id: string };

    const list = await app.inject({
      method: "GET",
      url: "/v1/reports?type=org.data_quality_audit",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as { id: string }[];
    expect(rows.map((r) => r.id)).toContain(created.id);

    const one = await app.inject({
      method: "GET",
      url: `/v1/reports/${created.id}`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(one.statusCode).toBe(200);

    // The M12 export path is inherited for free — no endpoint changed for this report type.
    const md = await app.inject({
      method: "GET",
      url: `/v1/reports/${created.id}/export?format=md`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(md.statusCode).toBe(200);
    expect(md.body).toContain("# Data-Quality Audit");
    expect(md.body).toContain("## §5.1 Data quality");
  });

  it("a viewer gets 403 — specifically NOT the 500 a database-level rejection would give", async () => {
    const viewerToken = await login("viewer@example.com");
    const res = await generate(viewerToken);
    // Spike F measured the alternative: under a `viewer` gate the insert reaches Postgres and
    // `report_artifacts_role_write_ins` rejects it, surfacing as a 500. Assert the code, not just
    // "it failed".
    expect(res.statusCode).toBe(403);
    expect(res.statusCode).not.toBe(500);
  });

  it("requires authentication", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/audit/data-quality",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("THE HONESTY ASSERTION: an EMPTY org renders every metric unknown and no `100%`", async () => {
    // No seeding at all. Every denominator is zero, and a zero denominator must never wear the
    // badge a real perfect score would.
    const res = await generate(ADMIN);
    expect(res.statusCode).toBe(201);
    const row = res.json() as {
      markdown: string;
      metrics: { metrics: Record<string, { kind: string; reason?: string }> };
    };

    for (const [name, metric] of Object.entries(row.metrics.metrics)) {
      expect(metric.kind, `${name} must be unknown on an empty org`).toBe("unknown");
      expect(metric.reason, `${name} must carry a non-empty reason`).toBeTruthy();
    }
    expect(row.markdown).not.toContain("100%");
    expect(row.markdown).toContain("**unknown**");
  });

  it("keeps capture coverage and attribution CORRECTNESS unknown even with real data", async () => {
    await seedEvents();
    const row = (await generate(ADMIN)).json() as {
      metrics: { metrics: Record<string, { kind: string }> };
    };
    // These two need ground truth outside the product (§4.4), so no amount of captured data makes
    // them measurable — while coverage and parse success become real numbers alongside them.
    expect(row.metrics.metrics.captureCoverage!.kind).toBe("unknown");
    expect(row.metrics.metrics.attributionCorrectness!.kind).toBe("unknown");
    expect(row.metrics.metrics.attributionCoverage!.kind).toBe("measured");
    expect(row.metrics.metrics.parseSuccess!.kind).toBe("measured");
  });

  it("round-trips `metrics` through jsonb unchanged — the replay/compare seam", async () => {
    await seedEvents();
    const created = (await generate(ADMIN)).json() as { id: string; metrics: unknown };
    const fetched = await app.inject({
      method: "GET",
      url: `/v1/reports/${created.id}`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect((fetched.json() as { metrics: unknown }).metrics).toEqual(created.metrics);
  });

  it("stamps BOTH derivation versions so a reader can tell which logic produced the counts", async () => {
    await seedEvents();
    const row = (await generate(ADMIN)).json() as {
      metrics: { dataQualityVersion: string; captureHealthVersion: string };
      markdown: string;
    };
    expect(row.metrics.dataQualityVersion).toBe("m16-data-quality-v1");
    // D-16.4-2: the connector verdict is IMPORTED from 16.3, never re-derived, and the artifact
    // records which derivation produced it.
    expect(row.metrics.captureHealthVersion).toBe("m16-capture-health-v1");
    expect(row.markdown).toContain("m16-capture-health-v1");
  });

  it("writes NOTHING to events or raw_source_records while generating (the dry run is a dry run)", async () => {
    await seedEvents();
    const before = await dbh.db.execute<{ e: number; r: number }>(
      sql`select (select count(*)::int from events) as e,
                 (select count(*)::int from raw_source_records) as r`,
    );
    expect((await generate(ADMIN)).statusCode).toBe(201);
    const after = await dbh.db.execute<{ e: number; r: number }>(
      sql`select (select count(*)::int from events) as e,
                 (select count(*)::int from raw_source_records) as r`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
