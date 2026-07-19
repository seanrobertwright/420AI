import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb } from "@420ai/db";
import type { IngestBatch, SearchResults } from "@420ai/shared";
import { buildApp } from "./app.js";
import { AnalysisProviderError, type AnalysisProvider } from "./analysis/provider.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const ADMIN = "test-admin";

// Never reached — no interpretation endpoint is exercised here.
const stubProvider: AnalysisProvider = {
  async interpret() {
    throw new AnalysisProviderError("not used in this suite", "unavailable");
  },
};

// A distinctive phrase + a secret-looking token inside the ENCRYPTED session payload.
// 13.4's incremental indexing must surface the phrase and redact the secret — with
// NO /v1/search/reindex call anywhere in this suite. Index maintenance is awaited
// (best-effort) inside the mutating routes, so hits are visible as soon as the
// mutation response returns.
const PHRASE = "xylophone cascade protocol";
const SECRET = "sk-ant-api03-INCREMENTALSECRET42";

function makeBatch(sessionId: string, text: string): IngestBatch {
  return {
    records: [
      {
        sourceConnector: "claude-code",
        sessionId,
        sourceRecordId: `${sessionId}:r1`,
        payload: JSON.stringify({ role: "user", text }),
      },
    ],
    events: [
      {
        fingerprint: `${sessionId}-e0`,
        sourceConnector: "claude-code",
        parserVersion: "1.0.0",
        rawRecordId: `${sessionId}:r1`,
        eventIndex: 0,
        eventType: "message.user",
        sessionId,
        ts: "2026-07-01T00:00:00.000Z",
      },
    ],
  };
}

describe.skipIf(!TEST_URL)("incremental search + list pagination (M13 13.4, HTTP e2e)", () => {
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
      sql`TRUNCATE search_documents, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
    );
  });

  async function pairMachine(): Promise<string> {
    const code = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(code.statusCode).toBe(200);
    const paired = await app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: code.json().code, machine: { name: "test-machine" } },
    });
    expect(paired.statusCode).toBe(200);
    return paired.json().token as string;
  }

  async function ingest(token: string, batch: IngestBatch): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: batch,
    });
    expect(res.statusCode).toBe(200);
  }

  async function search(qs: string): Promise<SearchResults> {
    const res = await app.inject({
      method: "GET",
      url: `/v1/search?${qs}`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as SearchResults;
  }

  async function createProject(name: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: { name },
    });
    expect(res.statusCode).toBe(200);
    return res.json().id as string;
  }

  it("makes an ingested session searchable WITHOUT a reindex, redacted", async () => {
    const token = await pairMachine();
    await ingest(token, makeBatch("s-inc-1", `${PHRASE} please use ${SECRET}`));

    // No POST /v1/search/reindex anywhere — the ingest hop alone indexed it.
    const results = await search("q=xylophone");
    const hit = results.hits.find((h) => h.entityType === "session");
    expect(hit).toBeDefined();
    expect(hit!.entityId).toBe("s-inc-1");
    // §18 gate holds on the incremental path too: the secret never leaves the archive.
    expect(JSON.stringify(results.hits)).not.toContain(SECRET);
  });

  it("filters GET /v1/search by type=event and rejects an unknown type (M14 14.4)", async () => {
    const token = await pairMachine();
    await ingest(token, makeBatch("s-inc-event", `${PHRASE} please use ${SECRET}`));

    const eventResults = await search("q=xylophone&type=event");
    const hit = eventResults.hits.find((h) => h.sessionId === "s-inc-event");
    expect(hit).toBeDefined();
    expect(hit!.entityType).toBe("event");
    expect(JSON.stringify(eventResults.hits)).not.toContain(SECRET);

    const bad = await app.inject({
      method: "GET",
      url: "/v1/search?q=xylophone&type=bogus",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("re-ingesting a session refreshes its existing doc (upsert, not duplicate)", async () => {
    const token = await pairMachine();
    await ingest(token, makeBatch("s-inc-2", `${PHRASE} original`));
    expect((await search("q=xylophone")).hits.some((h) => h.entityId === "s-inc-2")).toBe(true);

    // Second record in the SAME session carrying a new phrase.
    await ingest(token, {
      records: [
        {
          sourceConnector: "claude-code",
          sessionId: "s-inc-2",
          sourceRecordId: "s-inc-2:r2",
          payload: JSON.stringify({ role: "user", text: "quixotic followup detail" }),
        },
      ],
      events: [
        {
          fingerprint: "s-inc-2-e1",
          sourceConnector: "claude-code",
          parserVersion: "1.0.0",
          rawRecordId: "s-inc-2:r2",
          eventIndex: 0,
          eventType: "message.user",
          sessionId: "s-inc-2",
          ts: "2026-07-01T00:01:00.000Z",
        },
      ],
    });

    const results = await search("q=quixotic");
    expect(results.hits.filter((h) => h.entityId === "s-inc-2")).toHaveLength(1);
  });

  it("indexes project docs on create and refreshes on rename", async () => {
    const id = await createProject("zenithalphaproject");
    const created = await search("q=zenithalphaproject&type=project");
    expect(created.hits.some((h) => h.entityId === id)).toBe(true);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${id}`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: { name: "quasarbetaproject" },
    });
    expect(renamed.statusCode).toBe(200);

    // The doc upserts on (entity_type, entity_id): the new name hits, the old stops hitting.
    expect(
      (await search("q=quasarbetaproject&type=project")).hits.some((h) => h.entityId === id),
    ).toBe(true);
    expect((await search("q=zenithalphaproject&type=project")).hits).toEqual([]);
  });

  it("indexes a generated report artifact incrementally", async () => {
    const id = await createProject("reportsourceproject");
    const gen = await app.inject({
      method: "POST",
      url: `/v1/projects/${id}/reports`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(gen.statusCode).toBe(201);
    const artifactId = gen.json().id as string;

    const results = await search("q=cost&type=report");
    expect(results.hits.some((h) => h.entityId === artifactId)).toBe(true);
  });

  it("paginates GET /v1/projects with limit/offset and rejects out-of-range values", async () => {
    const ids = [
      await createProject("pageproj-a"),
      await createProject("pageproj-b"),
      await createProject("pageproj-c"),
    ];

    const page1 = await app.inject({
      method: "GET",
      url: "/v1/projects?limit=2",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(page1.statusCode).toBe(200);
    const rows1 = page1.json().projects as { id: string }[];
    expect(rows1).toHaveLength(2);

    const page2 = await app.inject({
      method: "GET",
      url: "/v1/projects?limit=2&offset=2",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(page2.statusCode).toBe(200);
    const rows2 = page2.json().projects as { id: string }[];
    expect(rows2).toHaveLength(1);

    // No overlap; the two pages cover all three projects.
    const seen = new Set([...rows1, ...rows2].map((r) => r.id));
    expect(seen.size).toBe(3);
    for (const id of ids) expect(seen.has(id)).toBe(true);

    // An OMITTED limit returns the FULL list — the project detail page's
    // existence authority, the remap picker, and collector mapping rely on it.
    const all = await app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().projects).toHaveLength(3);

    const zero = await app.inject({
      method: "GET",
      url: "/v1/projects?limit=0",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(zero.statusCode).toBe(400);
    const over = await app.inject({
      method: "GET",
      url: "/v1/projects?limit=201",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(over.statusCode).toBe(400);
  });

  it("paginates GET /v1/reports with limit/offset", async () => {
    const id = await createProject("reportpagingproject");
    for (let i = 0; i < 2; i++) {
      const gen = await app.inject({
        method: "POST",
        url: `/v1/projects/${id}/reports`,
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        payload: {},
      });
      expect(gen.statusCode).toBe(201);
    }

    const page1 = await app.inject({
      method: "GET",
      url: "/v1/reports?limit=1",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(page1.statusCode).toBe(200);
    const rows1 = page1.json() as { id: string }[];
    expect(rows1).toHaveLength(1);

    const page2 = await app.inject({
      method: "GET",
      url: "/v1/reports?limit=1&offset=1",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(page2.statusCode).toBe(200);
    const rows2 = page2.json() as { id: string }[];
    expect(rows2).toHaveLength(1);
    expect(rows2[0]!.id).not.toBe(rows1[0]!.id);
  });

  it("paginates GET /v1/search with offset (stable order, no overlap)", async () => {
    const token = await pairMachine();
    for (const s of ["s-page-1", "s-page-2"]) {
      await ingest(token, makeBatch(s, "papayawhirl shared marker"));
    }

    // type=session scopes out the M14 14.4 hybrid event docs (same phrase also
    // indexes as a message.user event row) so this exercises session pagination
    // specifically; event-type filtering has its own dedicated test above.
    const first = await search("q=papayawhirl&type=session&limit=1");
    const second = await search("q=papayawhirl&type=session&limit=1&offset=1");
    expect(first.hits).toHaveLength(1);
    expect(second.hits).toHaveLength(1);
    expect(first.hits[0]!.entityId).not.toBe(second.hits[0]!.entityId);
    expect(new Set([first.hits[0]!.entityId, second.hits[0]!.entityId])).toEqual(
      new Set(["s-page-1", "s-page-2"]),
    );
  });
});
