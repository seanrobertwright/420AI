import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, createPairingCode } from "@420ai/db";
import { users } from "@420ai/db";
import { buildApp } from "../../ingest/src/app.js";
import { runPair, runPush } from "./cli.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const FIXTURE = fileURLToPath(new URL("./fixtures/sample-session.jsonl", import.meta.url));

/**
 * The single test that uses a REAL socket (to exercise the fetch-based client
 * end-to-end): in-process ingest app on an ephemeral port, driven through the
 * collector's own runPair/runPush against the real M1 fixture + parser.
 */
describe.skipIf(!TEST_URL)("collector push (real-socket e2e)", () => {
  let dbh: ReturnType<typeof createDb>;
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    dbh = createDb(TEST_URL!);
    app = buildApp({ db: dbh.db, adminToken: "test-admin", logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
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

  it("pairs then pushes the fixture, and a re-push is idempotent", async () => {
    const [u] = await dbh.db
      .insert(users)
      .values({ email: "test@example.com" })
      .returning({ id: users.id });
    const { code } = await createPairingCode(dbh.db, u!.id);

    const { token } = await runPair({ url: baseUrl, code, name: "win-test", persist: false });
    expect(typeof token).toBe("string");

    const first = await runPush({ file: FIXTURE, url: baseUrl, token });
    expect(first.recordsInserted).toBeGreaterThan(0);
    expect(first.eventsUpserted).toBeGreaterThan(0);

    const second = await runPush({ file: FIXTURE, url: baseUrl, token });
    expect(second.recordsInserted).toBe(0);
  });
});
