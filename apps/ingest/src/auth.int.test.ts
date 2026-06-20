import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, setUserPassword } from "@420ai/db";
import { buildApp } from "./app.js";
import { hashPassword } from "./password.js";
import { AnalysisProviderError, type AnalysisProvider, type AnalysisRequest } from "./analysis/provider.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const SERVICE_TOKEN = "svc-token";
const ADMIN_EMAIL = "admin@test.local";
const SESSION_SECRET = "test-secret";
const PASSWORD = "correct-horse";

// Minimal stub provider — auth tests never trigger an interpretation, but buildApp requires one.
const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used in auth tests", "unavailable");
  },
};

describe.skipIf(!TEST_URL)("auth API (login → session bearer, HTTP e2e via inject)", () => {
  let dbh: ReturnType<typeof createDb>;
  let app: FastifyInstance;

  beforeAll(async () => {
    dbh = createDb(TEST_URL!);
    // A fixed sessionSecret so we can reason about the issued tokens deterministically.
    app = buildApp({
      db: dbh.db,
      adminToken: SERVICE_TOKEN,
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

  beforeEach(async () => {
    await dbh.db.execute(
      sql`TRUNCATE report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
    );
    await setUserPassword(dbh.db, ADMIN_EMAIL, hashPassword(PASSWORD));
  });

  async function login(email: string, password: string) {
    return app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email, password },
    });
  }

  it("issues a session token for the seeded admin (200 + token + ISO expiresAt)", async () => {
    const res = await login(ADMIN_EMAIL, PASSWORD);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; expiresAt: string };
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
    // expiresAt is a valid ISO timestamp in the future.
    expect(new Date(body.expiresAt).toISOString()).toBe(body.expiresAt);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("returns a generic 401 for a wrong password AND an unknown email (no enumeration)", async () => {
    const wrongPw = await login(ADMIN_EMAIL, "nope");
    const unknown = await login("ghost@test.local", PASSWORD);
    expect(wrongPw.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect((wrongPw.json() as { error: string }).error).toBe((unknown.json() as { error: string }).error);
  });

  it("400s a malformed login body (missing password)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email: ADMIN_EMAIL },
    });
    expect(res.statusCode).toBe(400);
  });

  it("authorizes an admin route with the issued SESSION token (the human path)", async () => {
    const { token } = (await login(ADMIN_EMAIL, PASSWORD)).json() as { token: string };
    const res = await app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ projects: [] });
  });

  it("authorizes an admin route with the SERVICE token (the machine path — desktop/CLI)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ projects: [] });
  });

  it("401s an admin route with no Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/projects" });
    expect(res.statusCode).toBe(401);
  });

  it("401s an admin route with a forged token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { authorization: "Bearer a.b" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /v1/auth/me returns the admin email with a session token, 401 without", async () => {
    const { token } = (await login(ADMIN_EMAIL, PASSWORD)).json() as { token: string };
    const ok = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ email: ADMIN_EMAIL });

    const no = await app.inject({ method: "GET", url: "/v1/auth/me" });
    expect(no.statusCode).toBe(401);
  });
});
