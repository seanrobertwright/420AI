import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { IngestBatch, MachineConnectorReport } from "@420ai/shared";
import { createDb, ingestBatch, withOrg } from "../index.js";
import { machines, users } from "../schema.js";
import { ensurePersonalOrg } from "./organizations.js";
import {
  declaredConnectorHealth,
  observedConnectorAggregates,
  replaceMachineConnectors,
} from "./capture-health.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;

/**
 * M16 16.3 — THE SLICE'S REPOSITORY-LAYER PROOF. A TWO-ROLE suite.
 *
 * CLAUDE.md's rule applies verbatim because this slice adds a tenant table: `bypassed ≠ enforced`.
 * `DATABASE_URL_TEST` owns the tables and therefore carries `rolbypassrls`, against which RLS is
 * INERT — an owner-only suite reports green while enforcing nothing, the same shape as a skipped
 * layer one level deeper. So:
 *
 *   - `owner` (DATABASE_URL_TEST)      — setup only: TRUNCATE (needs ownership) and seeding, plus
 *                                        the deliberately POLICY-BLIND assertions (the cross-org
 *                                        control below measures the QUERY's predicate, and would be
 *                                        meaningless if RLS could account for the result).
 *   - `appRole` (DATABASE_URL_TEST_APP) — every isolation assertion. Non-owner, no bypass.
 *
 * Test 1 (role identity) is why the rest mean anything: point the "app" handle at the owner URL by
 * mistake and every isolation test below still passes, while proving nothing.
 */

const NOW = new Date("2026-08-04T12:00:00.000Z");
const agoIso = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

/** A batch seeding `count` events for one connector at a chosen timestamp. */
function batch(tag: string, connector: string, ts: string, count = 1): IngestBatch {
  return {
    records: [
      {
        sourceConnector: connector,
        sessionId: `session-${tag}`,
        sourceRecordId: `raw-${tag}`,
        payload: JSON.stringify({ from: tag }),
      },
    ],
    events: Array.from({ length: count }, (_, i) => ({
      fingerprint: `${tag}-fp-${i}`,
      sourceConnector: connector,
      parserVersion: `${connector}@1`,
      rawRecordId: `raw-${tag}`,
      eventIndex: i,
      eventType: "message.user",
      sessionId: `session-${tag}`,
      ts,
    })),
  };
}

/** Flatten an error and its `cause` chain — Drizzle hangs the real Postgres error off `.cause`. */
function errorChain(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur instanceof Error && depth < 10; depth++) {
    parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

/** Assert a promise rejects with a Postgres row-level-security violation, at any cause depth. */
async function expectRlsRejection(p: Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await p;
  } catch (e) {
    thrown = e;
  }
  expect(thrown, "expected an RLS rejection, but the statement SUCCEEDED").toBeDefined();
  expect(errorChain(thrown)).toMatch(/row-level security policy/i);
}

/** The role these `withOrg` calls run under. Tenancy assertions must not trip the 0016 policies. */
const WRITE_ROLE = "member";

function report(over: Partial<MachineConnectorReport> = {}): MachineConnectorReport {
  return {
    id: "claude-code",
    enabled: true,
    approval: "approved",
    status: "stable",
    captureMethod: "jsonl tail",
    liveness: "streaming",
    tokens: "exact",
    cost: "computed",
    knownGaps: [],
    requiredPermissions: ["Read ~/.claude/projects"],
    custom: false,
    lastErrorMessage: null,
    lastErrorAt: null,
    errorCount: 0,
    ...over,
  };
}

describe.skipIf(!TEST_URL || !APP_URL)("M16 16.3 capture health (two-role integration)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let orgA: string;
  let orgB: string;
  let machineA: string;
  let machineA2: string;
  let machineB: string;

  beforeAll(() => {
    owner = createDb(TEST_URL!);
    appRole = createDb(APP_URL!);
  });

  afterAll(async () => {
    // BOTH pools, or vitest hangs on an open handle.
    await owner.pool.end();
    await appRole.pool.end();
  });

  beforeEach(async () => {
    // `machine_connectors` BEFORE `machines` — it carries the FK.
    await owner.db.execute(
      sql`TRUNCATE machine_connectors, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    const seeded = await owner.db
      .insert(users)
      .values([{ email: "a@example.com" }, { email: "b@example.com" }])
      .returning({ id: users.id, email: users.email });
    const userA = seeded.find((u) => u.email === "a@example.com")!.id;
    const userB = seeded.find((u) => u.email === "b@example.com")!.id;
    orgA = await ensurePersonalOrg(owner.db, userA, "a@example.com");
    orgB = await ensurePersonalOrg(owner.db, userB, "b@example.com");
    expect(orgA).not.toBe(orgB);

    const inserted = await owner.db
      .insert(machines)
      .values([
        { orgId: orgA, userId: userA, name: "machine-a" },
        { orgId: orgA, userId: userA, name: "machine-a2" },
        { orgId: orgB, userId: userB, name: "machine-b" },
      ])
      .returning({ id: machines.id, name: machines.name });
    machineA = inserted.find((m) => m.name === "machine-a")!.id;
    machineA2 = inserted.find((m) => m.name === "machine-a2")!.id;
    machineB = inserted.find((m) => m.name === "machine-b")!.id;
  });

  const replaceA = (reports: MachineConnectorReport[], machineId = machineA) =>
    withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      replaceMachineConnectors(tx, orgA, machineId, reports, NOW),
    );

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

  // 2 ── FAILS CLOSED. An unset context is 0 rows — not an error, not data.
  it("with NO org context machine_connectors reads 0 rows (and does not error)", async () => {
    await replaceA([report()]);

    const rows = await appRole.db.execute<{ n: number }>(
      sql`select count(*)::int as n from machine_connectors`,
    );
    expect(rows.rows[0]!.n).toBe(0);

    // …and the owner can see it, so the zero above is the POLICY and not an empty table.
    const truth = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from machine_connectors`,
    );
    expect(truth.rows[0]!.n).toBe(1);
  });

  // 3 ── A cross-org INSERT is rejected LOUDLY (the org policy's implicit WITH CHECK).
  it("writing another org's row under org A's context is rejected by the policy", async () => {
    await expectRlsRejection(
      withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
        // orgB stamped on the row while the context says orgA — the exact cross-tenant write the
        // policy exists to stop. Machine A is org A's, so the FK is satisfied and only RLS can fail.
        replaceMachineConnectors(tx, orgB, machineA, [report()], NOW),
      ),
    );
  });

  // 4 ── UPSERT. The conflict target is the unique index, not the `id` primary key.
  it("reporting the same connector twice leaves ONE row carrying the second report", async () => {
    await replaceA([report({ errorCount: 0 })]);
    await replaceA([
      report({
        enabled: false,
        approval: "needs-approval",
        knownGaps: ["no cost data"],
        lastErrorMessage: "EACCES",
        lastErrorAt: agoIso(60_000),
        errorCount: 7,
      }),
    ]);

    const rows = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      declaredConnectorHealth(tx, orgA),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectorId: "claude-code",
      enabled: false,
      approval: "needs-approval",
      knownGaps: ["no cost data"],
      lastErrorMessage: "EACCES",
      errorCount: 7,
    });
    // Collector-owned error fields are OVERWRITTEN, never accumulated server-side (D-16.3-7).
    expect(rows[0]!.lastErrorAt).toBe(agoIso(60_000));
  });

  // 5 ── PRUNE. A connector the collector stopped reporting must disappear; an EMPTY report clears.
  it("prunes a dropped connector, and an empty report prunes every row for the machine", async () => {
    await replaceA([report({ id: "claude-code" }), report({ id: "codex-cli" })]);
    expect(
      await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) => declaredConnectorHealth(tx, orgA)),
    ).toHaveLength(2);

    await replaceA([report({ id: "claude-code" })]);
    const afterDrop = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      declaredConnectorHealth(tx, orgA),
    );
    expect(afterDrop.map((r) => r.connectorId)).toEqual(["claude-code"]);

    await replaceA([]);
    expect(
      await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) => declaredConnectorHealth(tx, orgA)),
    ).toHaveLength(0);
  });

  // 6 ── The prune is MACHINE-scoped. Two machines in one org are two independent inventories.
  it("machine B's rows survive machine A's replace", async () => {
    await replaceA([report({ id: "claude-code" })], machineA);
    await replaceA([report({ id: "codex-cli" })], machineA2);

    await replaceA([], machineA);

    const rows = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      declaredConnectorHealth(tx, orgA),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ machineId: machineA2, connectorId: "codex-cli" });
  });

  // 7 ── THE ROW THAT DOES NOT EXIST TODAY (spikes S3/S4). `connectorHealth` returns nothing at all
  //      for a declared-but-silent connector, which is why "broken" and "idle" are currently
  //      indistinguishable. The LEFT JOIN is what surfaces it.
  it("returns a declared-but-silent connector with eventCount 0 and lastEventAt null", async () => {
    await ingestBatch(owner.db, machineA, batch("A", "claude-code", agoIso(60_000)));
    await replaceA([report({ id: "claude-code" }), report({ id: "codex-cli" })]);

    const rows = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      declaredConnectorHealth(tx, orgA),
    );
    const silent = rows.find((r) => r.connectorId === "codex-cli");
    expect(silent, "the declared-but-silent connector must be present").toBeDefined();
    expect(silent!.eventCount).toBe(0);
    expect(typeof silent!.eventCount).toBe("number"); // the `::int` cast, not a numeric string
    expect(silent!.lastEventAt).toBeNull();
    expect(silent!.parserVersions).toEqual([]);

    const seen = rows.find((r) => r.connectorId === "claude-code");
    expect(seen!.eventCount).toBe(1);
  });

  // 8 ── THE S2 REGRESSION PIN. `max(ts)` bypasses the `mode:"string"` parser and returns Postgres
  //      TEXT (`2026-08-04 11:59:00+00`). Without `toIso` this reaches the wire unnormalized.
  it("lastEventAt round-trips as strict ISO on BOTH reads", async () => {
    await ingestBatch(owner.db, machineA, batch("A", "claude-code", agoIso(60_000)));
    await replaceA([report({ id: "claude-code" })]);

    const [declared] = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      declaredConnectorHealth(tx, orgA),
    );
    expect(declared!.lastEventAt).toBe(new Date(declared!.lastEventAt!).toISOString());
    expect(declared!.lastEventAt).toBe(agoIso(60_000));
    // Plain timestamptz columns take the OTHER mechanism (`Date.toISOString()`) — assert both here
    // so a future edit that conflates them fails on one of the two.
    expect(declared!.reportedAt).toBe(NOW.toISOString());

    const [observed] = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      observedConnectorAggregates(tx, orgA),
    );
    expect(observed!.lastEventAt).toBe(new Date(observed!.lastEventAt!).toISOString());
  });

  // 9 ── THE CROSS-ORG CONTROL, on the OWNER handle deliberately: it measures the QUERY's join
  //      predicate, not RLS. Spike S5 reproduced the failure with a `connector_id`-only join — org
  //      A's silent row inherited org B's count.
  it("org A's silent connector does not inherit org B's events (measured past RLS)", async () => {
    await ingestBatch(owner.db, machineB, batch("B", "cursor", agoIso(60_000), 3));
    await withOrg(owner.db, orgA, WRITE_ROLE, (tx) =>
      replaceMachineConnectors(tx, orgA, machineA, [report({ id: "cursor" })], NOW),
    );
    await withOrg(owner.db, orgB, WRITE_ROLE, (tx) =>
      replaceMachineConnectors(tx, orgB, machineB, [report({ id: "cursor" })], NOW),
    );

    const a = await declaredConnectorHealth(owner.db, orgA);
    expect(a).toHaveLength(1);
    expect(a[0]!.eventCount).toBe(0);
    expect(a[0]!.lastEventAt).toBeNull();

    const b = await declaredConnectorHealth(owner.db, orgB);
    expect(b[0]!.eventCount).toBe(3);
  });

  // 10 ── NO LEFT-JOIN FAN-OUT. N events for one connector is ONE row with eventCount N.
  it("a machine with many events for one connector yields one row", async () => {
    await ingestBatch(owner.db, machineA, batch("A", "claude-code", agoIso(60_000), 5));
    await replaceA([report({ id: "claude-code" })]);

    const rows = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      declaredConnectorHealth(tx, orgA),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventCount).toBe(5);
    expect(rows[0]!.parserVersions).toEqual(["claude-code@1"]);
  });

  // 11 ── The app role sees exactly what the owner does for its OWN org, and nothing of org B's.
  it("under the app role inside withOrg the result matches the owner's, org-scoped", async () => {
    await ingestBatch(owner.db, machineA, batch("A", "claude-code", agoIso(60_000)));
    await ingestBatch(owner.db, machineB, batch("B", "claude-code", agoIso(60_000)));
    await withOrg(owner.db, orgA, WRITE_ROLE, (tx) =>
      replaceMachineConnectors(tx, orgA, machineA, [report()], NOW),
    );
    await withOrg(owner.db, orgB, WRITE_ROLE, (tx) =>
      replaceMachineConnectors(tx, orgB, machineB, [report()], NOW),
    );

    const asOwner = await declaredConnectorHealth(owner.db, orgA);
    const asApp = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      declaredConnectorHealth(tx, orgA),
    );
    expect(asApp).toEqual(asOwner);
    expect(asApp).toHaveLength(1);
    expect(asApp[0]!.machineId).toBe(machineA);

    const observed = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      observedConnectorAggregates(tx, orgA),
    );
    expect(observed.map((o) => o.machineId)).toEqual([machineA]);
  });
});
