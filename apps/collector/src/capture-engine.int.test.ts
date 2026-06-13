import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import {
  rmSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, createPairingCode, users, rawSourceRecords } from "@420ai/db";
import { toRawRecordPayload, toEventPayload, type Credentials } from "@420ai/shared";
import { buildApp } from "../../ingest/src/app.js";
import { runPair } from "./cli.js";
import { QueueStore } from "./queue/queue-store.js";
import { FileWatcher } from "./watcher/file-watcher.js";
import { connectors } from "./connectors/connector.js";
import type { Connector } from "./connectors/connector.js";
import { syncOnce } from "./sync/sync-worker.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const FIXTURE = fileURLToPath(new URL("./fixtures/sample-session.jsonl", import.meta.url));

/** The engine's enqueue mapping (parse -> dedup-keyed raw + event enqueue). */
function makeOnChange(queue: QueueStore) {
  return (connector: Connector, text: string): void => {
    const parsed = connector.parse(text);
    for (const r of parsed.rawRecords) {
      queue.enqueue("raw", `${r.sourceConnector}:${r.id}`, toRawRecordPayload(r));
    }
    for (const e of parsed.events) queue.enqueue("event", e.fingerprint, toEventPayload(e));
  };
}

async function rawCount(dbh: ReturnType<typeof createDb>): Promise<number> {
  const rows = await dbh.db.select({ id: rawSourceRecords.id }).from(rawSourceRecords);
  return rows.length;
}

describe.skipIf(!TEST_URL)("capture-engine end-to-end (watcher -> queue -> M2 ingest -> Postgres)", () => {
  let dbh: ReturnType<typeof createDb>;
  let app: FastifyInstance;
  let baseUrl: string;
  let creds: Credentials;
  let dir: string;
  let home: string;
  let sessionFile: string;
  let queuePath: string;

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
    const [u] = await dbh.db
      .insert(users)
      .values({ email: "test@example.com" })
      .returning({ id: users.id });
    const { code } = await createPairingCode(dbh.db, u!.id);
    const paired = await runPair({ url: baseUrl, code, name: "win-test", persist: false });
    creds = { url: baseUrl, token: paired.token, machineId: paired.machineId };

    dir = mkdtempSync(join(tmpdir(), "m3-engine-int-"));
    home = join(dir, "home");
    const projectsDir = join(home, ".claude", "projects", "slug");
    mkdirSync(projectsDir, { recursive: true });
    sessionFile = join(projectsDir, "11111111-1111-1111-1111-111111111111.jsonl");
    queuePath = join(dir, "queue.sqlite");

    let fixture = readFileSync(FIXTURE, "utf8");
    if (!fixture.endsWith("\n")) fixture += "\n";
    writeFileSync(sessionFile, fixture, "utf8");
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("captures a tmp Claude session into Postgres with encryption-at-rest intact", async () => {
    const queue = new QueueStore(queuePath);
    try {
      const watcher = new FileWatcher({ connectors, home, queue, onChange: makeOnChange(queue) });
      await watcher.tickOnce();
      const outcome = await syncOnce({ queue, url: creds.url, token: creds.token });
      expect(outcome).toBe("ok");

      const rows = await dbh.db
        .select({
          id: rawSourceRecords.id,
          ciphertext: rawSourceRecords.payloadCiphertext,
        })
        .from(rawSourceRecords);
      expect(rows.length).toBeGreaterThan(0);
      // Encryption-at-rest still holds (the server encrypts; M3 didn't change it).
      for (const r of rows) {
        expect(r.ciphertext).not.toBeNull();
        expect(r.ciphertext).not.toContain("/home/dev/project"); // plaintext must not leak
      }
    } finally {
      queue.close();
    }
  });

  it("inserts only the NEW records on append (incremental, idempotent capture)", async () => {
    const queue = new QueueStore(queuePath);
    try {
      const watcher = new FileWatcher({ connectors, home, queue, onChange: makeOnChange(queue) });
      await watcher.tickOnce();
      await syncOnce({ queue, url: creds.url, token: creds.token });
      const afterFirst = await rawCount(dbh);
      expect(afterFirst).toBeGreaterThan(0);

      // Append one brand-new valid record line.
      const newLine =
        '{"type":"user","uuid":"u-9999","sessionId":"sess-fixture-1","cwd":"/home/dev/project","gitBranch":"main","timestamp":"2026-06-13T10:05:00.000Z","message":{"role":"user","content":"one more"}}';
      appendFileSync(sessionFile, newLine + "\n", "utf8");

      await watcher.tickOnce();
      await syncOnce({ queue, url: creds.url, token: creds.token });
      const afterAppend = await rawCount(dbh);
      expect(afterAppend).toBe(afterFirst + 1); // exactly one new raw record landed
    } finally {
      queue.close();
    }
  });

  it("resumes (re-sends nothing) when restarted on the same queue with no file growth", async () => {
    const queue1 = new QueueStore(queuePath);
    try {
      const watcher1 = new FileWatcher({ connectors, home, queue: queue1, onChange: makeOnChange(queue1) });
      await watcher1.tickOnce();
      await syncOnce({ queue: queue1, url: creds.url, token: creds.token });
    } finally {
      queue1.close();
    }
    const afterFirst = await rawCount(dbh);

    // Simulate a collector restart: fresh QueueStore + FileWatcher, SAME queue
    // path (so the cursor persists). No file growth -> nothing enqueued/sent.
    const queue2 = new QueueStore(queuePath);
    try {
      queue2.recoverInflight();
      const watcher2 = new FileWatcher({ connectors, home, queue: queue2, onChange: makeOnChange(queue2) });
      await watcher2.tickOnce();
      expect(queue2.stats().pending).toBe(0); // cursor at EOF -> nothing new
      const outcome = await syncOnce({ queue: queue2, url: creds.url, token: creds.token });
      expect(outcome).toBe("ok");
    } finally {
      queue2.close();
    }
    expect(await rawCount(dbh)).toBe(afterFirst); // zero re-sent
  });
});
