import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb } from "@420ai/db";
import type { IngestBatch } from "@420ai/shared";
import { buildApp } from "./app.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const ADMIN = "test-admin";

const BATCH: IngestBatch = {
  records: [
    { sourceConnector: "claude-code", sessionId: "s1", sourceRecordId: "r1", payload: "line one" },
    { sourceConnector: "claude-code", sessionId: "s1", sourceRecordId: "r2", payload: "line two" },
  ],
  events: [
    {
      fingerprint: "evt-1",
      sourceConnector: "claude-code",
      parserVersion: "1.0.0",
      rawRecordId: "r1",
      eventIndex: 0,
      eventType: "message.user",
      sessionId: "s1",
      ts: "2026-06-13T00:00:00.000Z",
    },
  ],
};

describe.skipIf(!TEST_URL)("ingest API (HTTP e2e via inject)", () => {
  let dbh: ReturnType<typeof createDb>;
  let app: FastifyInstance;

  beforeAll(async () => {
    dbh = createDb(TEST_URL!);
    app = buildApp({ db: dbh.db, adminToken: ADMIN, logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await dbh.pool.end();
  });

  beforeEach(async () => {
    await dbh.db.execute(
      sql`TRUNCATE raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
    );
  });

  async function createCode(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    return res.json().code as string;
  }

  async function pair(code: string): Promise<{ token: string; machineId: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code, machine: { name: "test-machine" } },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it("GET /v1/health is open and returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });

  it("POST /v1/pairing-codes requires the admin token", async () => {
    const ok = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    expect(typeof ok.json().code).toBe("string");

    const noAuth = await app.inject({ method: "POST", url: "/v1/pairing-codes", payload: {} });
    expect(noAuth.statusCode).toBe(401);

    const wrong = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: { authorization: "Bearer wrong-admin" },
      payload: {},
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("pairs once and rejects re-redeeming a consumed code with 410", async () => {
    const code = await createCode();
    const { token, machineId } = await pair(code);
    expect(typeof token).toBe("string");
    expect(typeof machineId).toBe("string");

    const again = await app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code, machine: { name: "test-machine" } },
    });
    expect(again.statusCode).toBe(410);
  });

  it("ingests an authed batch and is idempotent through HTTP (PRD §23)", async () => {
    const { token } = await pair(await createCode());

    const first = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${token}` },
      payload: BATCH,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ recordsInserted: 2, eventsUpserted: 1 });

    const second = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${token}` },
      payload: BATCH,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().recordsInserted).toBe(0);
  });

  it("rejects ingest with no token or a garbage token (401)", async () => {
    const noToken = await app.inject({ method: "POST", url: "/v1/ingest", payload: BATCH });
    expect(noToken.statusCode).toBe(401);

    const garbage = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: "Bearer not-a-real-token" },
      payload: BATCH,
    });
    expect(garbage.statusCode).toBe(401);
  });

  it("rejects a malformed ingest body with 400 (schema validation)", async () => {
    const { token } = await pair(await createCode());
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${token}` },
      payload: { records: [] }, // missing required "events"
    });
    expect(res.statusCode).toBe(400);
  });
});
