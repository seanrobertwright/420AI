import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "../index.js";
import { users } from "../schema.js";
import { insertReportArtifact, getReportArtifact, listReportArtifacts } from "./reports.js";

const TEST_URL = process.env.DATABASE_URL_TEST;

describe.skipIf(!TEST_URL)("report-artifacts repository (integration)", () => {
  let dbh: ReturnType<typeof createDb>;
  let userId: string;

  beforeAll(() => {
    dbh = createDb(TEST_URL!);
  });

  afterAll(async () => {
    await dbh.pool.end();
  });

  beforeEach(async () => {
    await dbh.db.execute(
      sql`TRUNCATE report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
    );
    const [u] = await dbh.db
      .insert(users)
      .values({ email: "test@example.com" })
      .returning({ id: users.id });
    userId = u!.id;
  });

  function artifact(scopeId: string, markdown: string) {
    return {
      userId,
      projectId: null,
      reportType: "session.autopsy",
      scopeKind: "session" as const,
      scopeId,
      reportVersion: "m7-report-v1",
      catalogVersion: "m10-catalog-v1", // deterministic report stamps the catalog version
      analysisVersion: null, // no AI pipeline for a deterministic report (D3)
      params: { bucket: "day" },
      metrics: { eventCount: 1, costUsd: 0.5 },
      markdown,
    };
  }

  it("bumps version per (user, reportType, scopeId) and retains history", async () => {
    const first = await insertReportArtifact(dbh.db, artifact("sess-1", "# first"));
    const second = await insertReportArtifact(dbh.db, artifact("sess-1", "# second"));
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(first.id).not.toBe(second.id); // both retained, not overwritten

    const [{ n }] = (await dbh.db.execute(sql`SELECT count(*)::int AS n FROM report_artifacts`))
      .rows as { n: number }[];
    expect(n).toBe(2);
  });

  it("a distinct scopeId restarts the version at 1", async () => {
    await insertReportArtifact(dbh.db, artifact("sess-1", "# a"));
    const other = await insertReportArtifact(dbh.db, artifact("sess-2", "# b"));
    expect(other.version).toBe(1);
  });

  it("getReportArtifact returns the exact stored markdown + metrics", async () => {
    const row = await insertReportArtifact(dbh.db, artifact("sess-1", "# exact markdown"));
    const fetched = await getReportArtifact(dbh.db, row.id);
    expect(fetched).toBeDefined();
    expect(fetched!.markdown).toBe("# exact markdown");
    expect(fetched!.metrics).toEqual({ eventCount: 1, costUsd: 0.5 });
    expect(fetched!.params).toEqual({ bucket: "day" });
    expect(fetched!.version).toBe(1);
  });

  it("getReportArtifact returns undefined for an unknown id", async () => {
    const miss = await getReportArtifact(dbh.db, "00000000-0000-4000-8000-000000000000");
    expect(miss).toBeUndefined();
  });

  it("round-trips catalog_version + analysis_version per artifact kind (PRD §23)", async () => {
    // A deterministic report: catalog stamped, analysis NULL.
    const det = await insertReportArtifact(dbh.db, artifact("sess-det", "# deterministic"));
    const detFetched = await getReportArtifact(dbh.db, det.id);
    expect(detFetched!.catalogVersion).toBe("m10-catalog-v1");
    expect(detFetched!.analysisVersion).toBeNull();

    // An AI interpretation: BOTH catalog + analysis stamped (D3/D4).
    const ai = await insertReportArtifact(dbh.db, {
      userId,
      projectId: null,
      reportType: "session.ai_interpretation",
      scopeKind: "session" as const,
      scopeId: "sess-ai",
      reportVersion: "m8-ai-v1",
      catalogVersion: "m10-catalog-v1",
      analysisVersion: "m8-ai-v1",
      params: { model: "claude-opus-4-8" },
      metrics: { kind: "session" },
      markdown: "# ai",
    });
    const aiFetched = await getReportArtifact(dbh.db, ai.id);
    expect(aiFetched!.catalogVersion).toBe("m10-catalog-v1");
    expect(aiFetched!.analysisVersion).toBe("m8-ai-v1");
  });

  it("listReportArtifacts returns a scope's history newest-first and filters", async () => {
    await insertReportArtifact(dbh.db, artifact("sess-1", "# v1"));
    await insertReportArtifact(dbh.db, artifact("sess-1", "# v2"));
    await insertReportArtifact(dbh.db, artifact("sess-2", "# other"));

    const scoped = await listReportArtifacts(dbh.db, userId, { scopeId: "sess-1" });
    expect(scoped).toHaveLength(2);
    expect(scoped[0]!.version).toBe(2); // newest first
    expect(scoped[1]!.version).toBe(1);

    const byType = await listReportArtifacts(dbh.db, userId, { reportType: "session.autopsy" });
    expect(byType).toHaveLength(3); // all three share the type

    const wrongType = await listReportArtifacts(dbh.db, userId, {
      reportType: "project.cost_over_time",
    });
    expect(wrongType).toHaveLength(0);

    const all = await listReportArtifacts(dbh.db, userId);
    expect(all).toHaveLength(3);
  });
});
