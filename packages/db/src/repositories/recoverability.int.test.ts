import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  parseClaudeCodeSession,
  parseCodexSession,
  toRawRecordPayload,
  toEventPayload,
  type IngestBatch,
} from "@420ai/shared";
import { createDb, ingestBatch, withOrg } from "../index.js";
import { machines, users } from "../schema.js";
import { ensurePersonalOrg } from "./organizations.js";
import { reparseDryRun } from "./recoverability.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;

/**
 * M16 16.4 — the recoverability dry run, proved against real fixtures. A TWO-ROLE suite.
 *
 * Same split and same reason as `data-quality.int.test.ts`: the owner handle carries
 * `rolbypassrls`, so an owner-only suite would report green while enforcing nothing. Test 1 is the
 * role-identity assertion; every other assertion runs on the non-owner app role.
 *
 * The load-bearing test in this file is "IT WRITES NOTHING". `reparseAll` — the engine whose
 * decrypt/reassemble/parse sequence this shares — upserts events and GCs orphans, and the single
 * most likely future regression is somebody "simplifying" this into a call to it. Snapshotting
 * both table counts across a run is what would catch that, and nothing else would: the metric
 * would still report a perfect score, because the re-parse would have just written the very rows
 * it then compares against.
 */

const CLAUDE_FIXTURE = readFileSync(
  new URL("../../../shared/src/parsers/fixtures/sample-session.jsonl", import.meta.url),
  "utf8",
);
const CODEX_FIXTURE = readFileSync(
  new URL("../../../shared/src/parsers/fixtures/sample-codex-rollout.jsonl", import.meta.url),
  "utf8",
);

const INGESTED_AT = "2026-08-02T09:00:00.000Z";
const WRITE_ROLE = "member";

describe.skipIf(!TEST_URL || !APP_URL)("M16 16.4 recoverability (two-role integration)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let orgA: string;
  let machineA: string;

  beforeAll(() => {
    owner = createDb(TEST_URL!);
    appRole = createDb(APP_URL!);
  });

  afterAll(async () => {
    await owner.pool.end();
    await appRole.pool.end();
  });

  beforeEach(async () => {
    await owner.db.execute(
      sql`TRUNCATE raw_source_records, events, ingest_tokens, pairing_codes, machines,
          memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    const [user] = await owner.db
      .insert(users)
      .values([{ email: "a@example.com" }])
      .returning({ id: users.id });
    orgA = await ensurePersonalOrg(owner.db, user!.id, "a@example.com");
    const [m] = await owner.db
      .insert(machines)
      .values({ orgId: orgA, userId: user!.id, name: "machine-a" })
      .returning({ id: machines.id });
    machineA = m!.id;
  });

  /** Ingest a fixture through the REAL parse + write path, so the stored state is production-shaped. */
  async function ingestFixture(kind: "claude" | "codex"): Promise<{
    sessionId: string;
    sourceConnector: string;
    storedEvents: number;
  }> {
    const parsed =
      kind === "claude"
        ? parseClaudeCodeSession(CLAUDE_FIXTURE, { ingestedAt: INGESTED_AT })
        : parseCodexSession(CODEX_FIXTURE, { ingestedAt: INGESTED_AT });
    const batch: IngestBatch = {
      records: parsed.rawRecords.map(toRawRecordPayload),
      events: parsed.events.map(toEventPayload),
    };
    await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) => ingestBatch(tx, machineA, batch));
    return {
      sessionId: parsed.events[0]!.sessionId,
      sourceConnector: parsed.events[0]!.sourceConnector,
      storedEvents: parsed.events.length,
    };
  }

  const counts = async (): Promise<{ events: number; raw: number }> => {
    const e = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from events`);
    const r = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from raw_source_records`,
    );
    return { events: e.rows[0]!.n, raw: r.rows[0]!.n };
  };

  // 1 ── ROLE IDENTITY. Without this the whole file is theatre.
  it("the app handle is a NON-SUPERUSER role with rolbypassrls = false", async () => {
    const su = await appRole.db.execute<{ v: string }>(
      sql`select current_setting('is_superuser') as v`,
    );
    expect(su.rows[0]!.v).toBe("off");
    const bypass = await appRole.db.execute<{ rolbypassrls: boolean }>(
      sql`select rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(bypass.rows[0]!.rolbypassrls).toBe(false);
    const who = await appRole.db.execute<{ u: string }>(sql`select current_user as u`);
    expect(who.rows[0]!.u).toBe("420ai_app");
  });

  it("re-derives a CLAUDE session's fingerprints exactly — missing 0, extra 0", async () => {
    const { sessionId, sourceConnector, storedEvents } = await ingestFixture("claude");
    const rows = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      reparseDryRun(tx, orgA, [{ sessionId, sourceConnector, machineId: machineA }]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      storedEvents,
      reparsedEvents: storedEvents,
      missing: 0,
      extra: 0,
      ok: true,
      skippedReason: null,
    });
  });

  it("re-derives a CODEX session's fingerprints exactly — missing 0, extra 0", async () => {
    const { sessionId, sourceConnector, storedEvents } = await ingestFixture("codex");
    const rows = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      reparseDryRun(tx, orgA, [{ sessionId, sourceConnector, machineId: machineA }]),
    );
    expect(rows[0]).toMatchObject({
      storedEvents,
      reparsedEvents: storedEvents,
      missing: 0,
      extra: 0,
      ok: true,
    });
  });

  /**
   * THE DISCRIMINATING PAIR. Every other assertion in this file expects `missing: 0, extra: 0,
   * ok: true` — so hardcoding both counters to `0` (or `ok` to `true`) would keep the whole suite
   * green while the metric silently always scored a perfect result. Recoverability is the ONE §5.1
   * metric whose target is "all sampled records", which makes a stuck-perfect bug precisely the one
   * a reader would never question. These two tests fail if the set comparison stops comparing.
   */
  it("reports MISSING when a stored fingerprint is not reproduced by the re-parse", async () => {
    const { sessionId, sourceConnector, storedEvents } = await ingestFixture("claude");
    // A stored event the re-parse cannot possibly produce: same session/connector and a raw id the
    // parse DOES emit, so it is inside the compared set, but a fingerprint of its own.
    await owner.db.execute(sql`
      insert into events (fingerprint, org_id, source_connector, parser_version, raw_record_id,
                          event_index, event_type, session_id, ts)
      select 'fp-phantom', ${orgA}, source_connector, parser_version, raw_record_id,
             999, 'message.user', session_id, ts
      from events where org_id = ${orgA} and session_id = ${sessionId} limit 1`);

    const rows = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      reparseDryRun(tx, orgA, [{ sessionId, sourceConnector, machineId: machineA }]),
    );
    expect(rows[0]).toMatchObject({
      storedEvents: storedEvents + 1,
      reparsedEvents: storedEvents,
      missing: 1,
      extra: 0,
      ok: false,
      skippedReason: null,
    });
  });

  it("reports EXTRA when a reproduced fingerprint is not stored — the parser-drift signal", async () => {
    const { sessionId, sourceConnector, storedEvents } = await ingestFixture("claude");
    // Delete one stored event. The re-parse still produces it, so it is `extra`: reproduced but
    // not stored. This is the direction that would flag a GC or an ingest that lost a row.
    await owner.db.execute(
      sql`delete from events where org_id = ${orgA} and session_id = ${sessionId}
          and fingerprint = (select fingerprint from events
                             where org_id = ${orgA} and session_id = ${sessionId} limit 1)`,
    );

    const rows = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      reparseDryRun(tx, orgA, [{ sessionId, sourceConnector, machineId: machineA }]),
    );
    expect(rows[0]).toMatchObject({
      storedEvents: storedEvents - 1,
      reparsedEvents: storedEvents,
      missing: 0,
      extra: 1,
      ok: false,
    });
  });

  it("IT WRITES NOTHING — `events` and `raw_source_records` counts are unchanged across a run", async () => {
    // The regression test for somebody "optimising" the dry run into a call to `reparseAll`. That
    // change would keep this metric reporting a perfect score while mutating the archive under
    // audit, so nothing else in the suite would notice.
    const { sessionId, sourceConnector } = await ingestFixture("claude");
    const before = await counts();
    expect(before.events).toBeGreaterThan(0);
    expect(before.raw).toBeGreaterThan(0);

    await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      reparseDryRun(tx, orgA, [{ sessionId, sourceConnector, machineId: machineA }]),
    );

    expect(await counts()).toEqual(before);
  });

  it("skips a GEMINI session with its reason, rather than counting it as a failure", async () => {
    const rows = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      reparseDryRun(tx, orgA, [
        { sessionId: "g1", sourceConnector: "gemini-cli", machineId: machineA },
      ]),
    );
    expect(rows[0]).toMatchObject({ skippedReason: "gemini", ok: false });
    // A skip is EXCLUDED from the ratio by the pure layer — never scored as a defect. The scope
    // boundary is D-M13-2's, inherited rather than re-decided here.
    expect(rows[0]!.storedEvents).toBe(0);
  });

  it("skips a connector with no shared parser", async () => {
    const rows = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      reparseDryRun(tx, orgA, [
        { sessionId: "c1", sourceConnector: "my-custom-connector", machineId: machineA },
      ]),
    );
    expect(rows[0]!.skippedReason).toBe("unsupported-connector");
  });

  it("records `decrypt-error` on the row and still returns, rather than throwing the audit down", async () => {
    // The ONE deliberate deviation from the silent-library rule in this slice: a bounded audit over
    // a sample is exactly where one corrupt row must not take down the instrument that would have
    // reported it. Corrupt the ciphertext of one session's raw records and assert the dry run
    // degrades to a labelled skip instead of a thrown request.
    const { sessionId, sourceConnector } = await ingestFixture("claude");
    await owner.db.execute(
      sql`update raw_source_records set payload_ciphertext = 'not-base64-ciphertext'`,
    );

    const rows = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      reparseDryRun(tx, orgA, [{ sessionId, sourceConnector, machineId: machineA }]),
    );
    expect(rows[0]).toMatchObject({ skippedReason: "decrypt-error", ok: false });
  });

  it("reports `no-raw-records` for a target whose raw records are gone — its OWN reason", async () => {
    const rows = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      reparseDryRun(tx, orgA, [
        { sessionId: "vanished", sourceConnector: "claude-code", machineId: machineA },
      ]),
    );
    // Deliberately NOT folded into `unsupported-connector`: a wrong explanation on a worksheet row
    // is the failure this whole module exists to prevent.
    expect(rows[0]!.skippedReason).toBe("no-raw-records");
  });

  it("returns an empty array for no targets", async () => {
    const rows = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) => reparseDryRun(tx, orgA, []));
    expect(rows).toEqual([]);
  });
});
