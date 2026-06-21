import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  createDb,
  ingestBatch,
  findOrCreateProjectByRemote,
  rebuildSearchIndex,
  searchDocuments,
} from "../index.js";
import {
  users,
  machines,
  reportArtifacts,
  searchDocuments as searchDocumentsTbl,
} from "../schema.js";
import type { IngestBatch } from "@420ai/shared";

const TEST_URL = process.env.DATABASE_URL_TEST;

// A known secret embedded in a session message. rebuildSearchIndex DECRYPTS then
// REDACTS before storing — so the secret MUST be absent from every stored row + hit.
const SECRET = "sk-ant-api03-TESTSECRET0123456789";
// A distinctive phrase per source so each `type` filter has an unambiguous match.
const SESSION_PHRASE = "the anthropic spend rose dramatically";
const REPORT_PHRASE = "quarterly burndown summary";
const PROJECT_NAME = "zephyrwidget";
const REMOTE = "https://github.com/seanrobertwright/420AI.git";

const USER_TEXT = JSON.stringify({ role: "user", text: `${SESSION_PHRASE} please use ${SECRET}` });

function makeBatch(): IngestBatch {
  return {
    records: [
      { sourceConnector: "claude-code", sessionId: "s1", sourceRecordId: "r1", payload: USER_TEXT },
    ],
    events: [
      {
        fingerprint: "se-user",
        sourceConnector: "claude-code",
        parserVersion: "1.0.0",
        rawRecordId: "r1",
        eventIndex: 0,
        eventType: "message.user",
        sessionId: "s1",
        ts: "2026-06-14T00:00:00.000Z",
      },
    ],
  };
}

describe.skipIf(!TEST_URL)("search repository (integration)", () => {
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
      sql`TRUNCATE search_documents, workspace_keys, workspaces, projects, report_artifacts, raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
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

    // Seed: an encrypted session (phrase + secret), a project, and a report.
    await ingestBatch(dbh.db, machineId, makeBatch());
    const proj = await findOrCreateProjectByRemote(dbh.db, userId, REMOTE, PROJECT_NAME);
    projectId = proj.id;
    await dbh.db.insert(reportArtifacts).values({
      userId,
      projectId,
      reportType: "project.cost_over_time",
      scopeKind: "project",
      scopeId: projectId,
      version: 1,
      reportVersion: "m7-report-v1",
      metrics: {},
      markdown: `# ${REPORT_PHRASE}\n\nThe team shipped many features.`,
    });
  });

  it("rebuilds with per-entity counts across sessions, reports, and projects", async () => {
    const counts = await rebuildSearchIndex(dbh.db);
    expect(counts.sessions).toBeGreaterThanOrEqual(1);
    expect(counts.reports).toBeGreaterThanOrEqual(1);
    expect(counts.projects).toBeGreaterThanOrEqual(1);
    expect(counts.total).toBe(counts.sessions + counts.reports + counts.projects);
  });

  it("returns a ranked session hit for a phrase that was encrypted at rest", async () => {
    await rebuildSearchIndex(dbh.db);
    const { query, hits } = await searchDocuments(dbh.db, { q: "anthropic spend" });
    expect(query).toBe("anthropic spend");
    const session = hits.find((h) => h.entityType === "session");
    expect(session).toBeDefined();
    expect(session!.entityId).toBe("s1");
    expect(session!.rank).toBeGreaterThan(0);
    expect(typeof session!.snippet).toBe("string");
  });

  it("never leaks the secret into a hit OR the stored row (decrypt→redact→index)", async () => {
    await rebuildSearchIndex(dbh.db);
    const { hits } = await searchDocuments(dbh.db, { q: "anthropic spend" });
    // Not in any returned hit (title/snippet leave the archive).
    expect(JSON.stringify(hits)).not.toContain(SECRET);
    // Not in the stored body — and the redaction placeholder is present instead.
    const [row] = await dbh.db
      .select({ body: searchDocumentsTbl.body, rv: searchDocumentsTbl.redactionVersion })
      .from(searchDocumentsTbl)
      .where(eq(searchDocumentsTbl.entityType, "session"));
    expect(row!.body).not.toContain(SECRET);
    expect(row!.body).toContain("[REDACTED:");
    expect(row!.rv).toBe("m8-redact-v1");
  });

  it("filters by entity type and returns no hits for an unmatched query", async () => {
    await rebuildSearchIndex(dbh.db);
    const reportOnly = await searchDocuments(dbh.db, { q: "burndown", type: "report" });
    expect(reportOnly.hits.length).toBeGreaterThanOrEqual(1);
    expect(reportOnly.hits.every((h) => h.entityType === "report")).toBe(true);

    const none = await searchDocuments(dbh.db, { q: "zzznonexistentqqq" });
    expect(none.hits).toEqual([]);
  });

  it("is idempotent — re-running yields stable counts and no duplicate-key error", async () => {
    const first = await rebuildSearchIndex(dbh.db);
    const second = await rebuildSearchIndex(dbh.db);
    expect(second).toEqual(first);
    // The (entity_type, entity_id) unique index holds: exactly one row per entity.
    const [{ n }] = await dbh.db.select({ n: sql<number>`count(*)::int` }).from(searchDocumentsTbl);
    expect(n).toBe(first.total);
  });
});
