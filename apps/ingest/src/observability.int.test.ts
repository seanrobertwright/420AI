import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb } from "@420ai/db";
import { buildApp } from "./app.js";
import {
  AnalysisProviderError,
  type AnalysisProvider,
  type AnalysisRequest,
} from "./analysis/provider.js";
import { seedBootstrapKey } from "./test-support/bootstrap-key.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
/**
 * M15 15.9 (D-M15-7) — the admin bearer is now a real API KEY, minted per test in `beforeEach`.
 * `let`, not `const`: `api_keys` carries an FK to `users`, so this suite's TRUNCATE deletes the key
 * with its owner and it must be re-minted after every reset. It replaces the shared `ADMIN_TOKEN`
 * string that used to be passed to `buildApp`, which authenticates nothing as of 15.9.
 */
let ADMIN: string;

// Minimal stub provider — these tests never trigger an interpretation, but buildApp requires one.
const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used in observability tests", "unavailable");
  },
};

// M12 12.4b + 12.4c: admin-gated /v1/metrics that counts responses, and a strict login rate limit.
// This is the one buildApp caller that opts into rateLimit (login max:2) — deliberate; it does NOT
// change the other callers (their int tests stay unthrottled by omitting the opt).
describe.skipIf(!TEST_URL)("observability + rate limiting (HTTP e2e via inject)", () => {
  let dbh: ReturnType<typeof createDb>;
  let app: FastifyInstance;

  beforeAll(async () => {
    dbh = createDb(TEST_URL!);
    // M15 15.9 (D-M15-7): the admin bearer is a real API KEY. `seedBootstrapKey` also runs
    // `ensureUserByEmail` (hence `ensurePersonalOrg`), so `adminEmail`'s user + org exist and the
    // key resolves to an `owner` principal. This suite has no TRUNCATE, so unlike its siblings a
    // one-time mint in `beforeAll` survives the whole file.
    ADMIN = await seedBootstrapKey(dbh.db, "seanrobertwright@gmail.com");
    app = buildApp({
      db: dbh.db,
      // M15 15.4: reconcile on EVERY tick, i.e. exactly pre-15.4 behaviour — tests that assert
      // a firing appears on the first GET must not race the 30 s production throttle.
      reconcileThrottleMs: 0,
      analysisProvider: stubProvider,
      logger: false,
      rateLimit: { login: { max: 2, timeWindow: "1 minute" } },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await dbh.pool.end();
  });

  it("GET /v1/metrics is admin-gated (401 without a bearer)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/metrics" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/admin authorization required/);
  });

  it("GET /v1/metrics returns counters for an admin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/metrics",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      requests: number;
      byStatusClass: Record<string, number>;
      uptimeSeconds: number;
    };
    expect(body.requests).toBeGreaterThanOrEqual(1);
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(body.byStatusClass).toBeTypeOf("object");
  });

  it("counts a 2xx response in byStatusClass", async () => {
    // Read the current 2xx count, make a 200 (health), then confirm it rose.
    const before = (
      await app.inject({
        method: "GET",
        url: "/v1/metrics",
        headers: { authorization: `Bearer ${ADMIN}` },
      })
    ).json().byStatusClass["2xx"] as number;
    await app.inject({ method: "GET", url: "/v1/health" });
    const after = (
      await app.inject({
        method: "GET",
        url: "/v1/metrics",
        headers: { authorization: `Bearer ${ADMIN}` },
      })
    ).json().byStatusClass["2xx"] as number;
    // +2 at least: the /v1/health 200 AND the first /v1/metrics 200 both land before the read.
    expect(after).toBeGreaterThan(before);
  });

  it("rate-limits POST /v1/auth/login past its limit (429 on the 3rd call)", async () => {
    const login = () =>
      app.inject({
        method: "POST",
        url: "/v1/auth/login",
        headers: { "content-type": "application/json" },
        payload: { email: "nobody@test.local", password: "wrong" },
      });
    // max:2 → calls 1 & 2 reach the handler (401 bad creds), call 3 is blocked (429).
    const r1 = await login();
    const r2 = await login();
    const r3 = await login();
    expect(r1.statusCode).toBe(401);
    expect(r2.statusCode).toBe(401);
    expect(r3.statusCode).toBe(429);
  });

  /**
   * M15 15.9 (PR-review finding T2) — POST /v1/auth/api-keys carries the SAME limit, and until this
   * test nothing covered it.
   *
   * This is the only suite that passes `rateLimit` to `buildApp`; every other one leaves
   * `rateLimitLogin === false`, so `config: { rateLimit: app.rateLimitLogin }` could be deleted from
   * the mint route and the entire suite would stay green while the vector its comment describes
   * reopened — an attacker holding a stolen session grinding the password at one scrypt per request.
   *
   * Driven UNAUTHENTICATED on purpose: the limiter runs ahead of the handler, so it fires without
   * needing a session, which keeps the test independent of the login limit it shares a window with.
   * A valid body is sent because Fastify validates the body BEFORE the handler — an empty payload
   * would 400 and prove nothing.
   */
  it("rate-limits POST /v1/auth/api-keys past its limit (429 on the 3rd call)", async () => {
    const mint = () =>
      app.inject({
        method: "POST",
        url: "/v1/auth/api-keys",
        headers: { "content-type": "application/json" },
        payload: { name: "grind", currentPassword: "wrong" },
      });
    const r1 = await mint();
    const r2 = await mint();
    const r3 = await mint();
    // No bearer ⇒ 401 from the gate on the first two; the third never reaches the handler.
    expect(r1.statusCode).toBe(401);
    expect(r2.statusCode).toBe(401);
    expect(r3.statusCode, "the mint route MUST carry the login rate limit").toBe(429);
  });
});
