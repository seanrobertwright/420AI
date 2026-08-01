import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, setUserPassword } from "@420ai/db";
import { buildApp } from "./app.js";
import { hashPassword } from "./password.js";
import {
  AnalysisProviderError,
  type AnalysisProvider,
  type AnalysisRequest,
} from "./analysis/provider.js";
import { seedBootstrapKey } from "./test-support/bootstrap-key.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
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

  beforeEach(async () => {
    await dbh.db.execute(
      sql`TRUNCATE report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    await setUserPassword(dbh.db, ADMIN_EMAIL, hashPassword(PASSWORD));
    // M15 15.9 — mint the machine-tier bearer AFTER the truncate + identity seed, because
    // `api_keys` cascades away with `users`.
    SERVICE_TOKEN = await seedBootstrapKey(dbh.db, ADMIN_EMAIL);
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
    expect((wrongPw.json() as { error: string }).error).toBe(
      (unknown.json() as { error: string }).error,
    );
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

  it("authorizes an admin route with an API KEY (the machine path — desktop/CLI)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ projects: [] });
  });

  /**
   * M15 15.9 (D-M15-7) — THE RETIREMENT ASSERTION. `ADMIN_TOKEN` is not merely unused; it
   * authenticates NOTHING. Asserted rather than assumed, because "we deleted the branch" is exactly
   * the kind of claim that stays true in the comments and stops being true in the code — and the
   * failure would be silent in the worst direction: a shared, un-attributable, un-revocable god
   * token quietly still working after the release notes say it was removed.
   *
   * The literal below is the value `scripts/setup-env.mjs` used to generate into `.env`, in the
   * shape an upgrading operator would still have sitting in theirs.
   */
  it("401s the RETIRED ADMIN_TOKEN tier — it authenticates nothing (D-M15-7)", async () => {
    for (const retired of ["svc-token", "test-admin", "any-old-shared-secret"]) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/projects",
        headers: { authorization: `Bearer ${retired}` },
      });
      expect(res.statusCode, `the retired token "${retired}" must not authorize`).toBe(401);
    }
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
