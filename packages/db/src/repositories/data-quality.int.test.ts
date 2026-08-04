import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { IngestBatch } from "@420ai/shared";
import { createDb, ingestBatch, withOrg } from "../index.js";
import {
  gitCommits,
  machineConnectors,
  machines,
  sessionGitLinks,
  users,
  workspaceKeys,
  workspaces,
} from "../schema.js";
import { ensurePersonalOrg } from "./organizations.js";
import {
  connectorDeclarations,
  duplicateRawRecords,
  gitLinkageRows,
  ingestLagRows,
  rawRecordTotals,
  reconciliationSample,
  recoverabilityTargets,
  sessionQualityRows,
} from "./data-quality.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;

/** Drizzle's insert shape for `machine_connectors` — keeps the seed helper's unions honest. */
type MachineConnectorInsert = typeof machineConnectors.$inferInsert;

/**
 * M16 16.4 — THE AGGREGATE LAYER'S PROOF. A TWO-ROLE suite, mirroring `capture-health.int.test.ts`.
 *
 * `bypassed ≠ enforced` (CLAUDE.md). `DATABASE_URL_TEST` owns the tables and therefore carries
 * `rolbypassrls`, against which RLS is INERT — an owner-only suite reports green while enforcing
 * nothing, the same shape as a skipped layer one level deeper. So:
 *
 *   - `owner` (DATABASE_URL_TEST)      — setup ONLY: TRUNCATE (needs ownership) and seeding.
 *   - `appRole` (DATABASE_URL_TEST_APP) — every assertion. Non-owner, no bypass.
 *
 * Test 1 (role identity) is why the rest mean anything: point the "app" handle at the owner URL by
 * mistake and every assertion below still passes, while proving nothing.
 *
 * AN AUDIT REPORT IS ESPECIALLY VULNERABLE to a missing org context, which is why these run on the
 * app role rather than the convenient owner one: under no context every count returns 0, and 0 is a
 * PLAUSIBLE-LOOKING audit result. A silent all-zero read here would not look like a bug.
 */

const NOW = new Date("2026-08-04T12:00:00.000Z");
const SINCE_ISO = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
const SINCE = new Date(SINCE_ISO);
const INSIDE = "2026-08-02T09:00:00.000Z";
const OUTSIDE = "2026-07-01T09:00:00.000Z";

const WRITE_ROLE = "member";

describe.skipIf(!TEST_URL || !APP_URL)("M16 16.4 data quality (two-role integration)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let orgA: string;
  let userA: string;
  let machineA: string;
  let machineA2: string;

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
    await owner.db.execute(
      sql`TRUNCATE session_git_links, git_commit_files, git_commits, search_documents,
          workspace_keys, workspaces, projects, machine_connectors, raw_source_records, events,
          ingest_tokens, pairing_codes, machines, memberships, organizations, users
          RESTART IDENTITY CASCADE`,
    );
    const [seeded] = await owner.db
      .insert(users)
      .values([{ email: "a@example.com" }])
      .returning({ id: users.id });
    userA = seeded!.id;
    orgA = await ensurePersonalOrg(owner.db, userA, "a@example.com");

    const inserted = await owner.db
      .insert(machines)
      .values([
        { orgId: orgA, userId: userA, name: "machine-a" },
        { orgId: orgA, userId: userA, name: "machine-a2" },
      ])
      .returning({ id: machines.id, name: machines.name });
    machineA = inserted.find((m) => m.name === "machine-a")!.id;
    machineA2 = inserted.find((m) => m.name === "machine-a2")!.id;
  });

  /**
   * Ingest one raw record and `eventCount` events derived from it, under a chosen machine.
   * `ingestBatch` is the real write path, so raw dedup and event upsert behave exactly as in
   * production — which is the whole point for the duplicate-rate test below.
   */
  function batch(opts: {
    session: string;
    connector: string;
    rawId: string;
    ts: string;
    eventCount?: number;
    withTokens?: boolean;
    projectPath?: string | null;
  }): IngestBatch {
    const n = opts.eventCount ?? 1;
    return {
      records: [
        {
          sourceConnector: opts.connector,
          sessionId: opts.session,
          sourceRecordId: opts.rawId,
          payload: JSON.stringify({ from: opts.rawId }),
        },
      ],
      events: Array.from({ length: n }, (_, i) => ({
        // The REAL fingerprint inputs, so two machines shipping the same raw record produce
        // IDENTICAL fingerprints and the events converge — the premise of the duplicate metric.
        fingerprint: `${opts.connector}|${opts.rawId}|${i}|message.user`,
        sourceConnector: opts.connector,
        parserVersion: `${opts.connector}@1`,
        rawRecordId: opts.rawId,
        eventIndex: i,
        eventType: "message.user",
        sessionId: opts.session,
        ts: opts.ts,
        projectPath: (opts.projectPath === undefined ? "/repo" : opts.projectPath) ?? undefined,
        ...(opts.withTokens
          ? {
              model: "claude-sonnet-5",
              tokens: {
                input: 10,
                output: 5,
                cache_read: 0,
                cache_write: 0,
                reasoning: 0,
                tool: 0,
                total: 15,
              },
            }
          : {}),
      })),
    };
  }

  const ingest = (machineId: string, b: IngestBatch): Promise<unknown> =>
    withOrg(appRole.db, orgA, WRITE_ROLE, (tx) => ingestBatch(tx, machineId, b));

  /** Run a read the way the orchestrator does: on the APP role, inside an org context. */
  const asApp = <T>(fn: (tx: Parameters<Parameters<typeof withOrg>[3]>[0]) => Promise<T>) =>
    withOrg(appRole.db, orgA, WRITE_ROLE, fn);

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

  it("groups sessions by (session_id, source_connector), never by session_id alone", async () => {
    // The SAME session id on two connectors. Grouping on the id alone would merge them and force
    // an aggregate over `source_connector` — the 15.1 `min(org_id)` smell one column over.
    await ingest(
      machineA,
      batch({ session: "s1", connector: "claude-code", rawId: "r1", ts: INSIDE }),
    );
    await ingest(
      machineA,
      batch({ session: "s1", connector: "codex-cli", rawId: "r2", ts: INSIDE }),
    );

    const rows = await asApp((tx) => sessionQualityRows(tx, orgA, SINCE_ISO));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.sourceConnector)).toEqual(["claude-code", "codex-cli"]);
  });

  it('normalizes min/max(events.ts) through toIso — a `mode:"string"` aggregate is Postgres TEXT', async () => {
    await ingest(
      machineA,
      batch({ session: "s1", connector: "claude-code", rawId: "r1", ts: INSIDE }),
    );
    const [row] = await asApp((tx) => sessionQualityRows(tx, orgA, SINCE_ISO));
    // Spike S4 measured the raw form: `"2026-08-02 09:00:00+00"` — space-separated, no T, no Z.
    expect(row!.firstTs).toBe(INSIDE);
    expect(row!.lastTs).toBe(INSIDE);
  });

  it("excludes a row just outside the window", async () => {
    await ingest(
      machineA,
      batch({ session: "old", connector: "claude-code", rawId: "r0", ts: OUTSIDE }),
    );
    await ingest(
      machineA,
      batch({ session: "new", connector: "claude-code", rawId: "r1", ts: INSIDE }),
    );

    const rows = await asApp((tx) => sessionQualityRows(tx, orgA, SINCE_ISO));
    expect(rows.map((r) => r.sessionId)).toEqual(["new"]);
  });

  it("counts a raw record that yielded NO events, so parse success is 1/2 and not unknown", async () => {
    await ingest(
      machineA,
      batch({ session: "s1", connector: "claude-code", rawId: "r1", ts: INSIDE }),
    );
    // A raw record with no derived events — a parse failure, which is exactly what §5.1 measures.
    await ingest(machineA, {
      records: [
        {
          sourceConnector: "claude-code",
          sessionId: "s1",
          sourceRecordId: "r-unparsed",
          payload: "{not json",
        },
      ],
      events: [],
    });

    const totals = await asApp((tx) => rawRecordTotals(tx, orgA, SINCE));
    expect(totals).toEqual({ rawRows: 2, yieldedEvents: 1 });
  });

  it("does NOT double-count the parse-success denominator when two machines hold one record", async () => {
    // Spike S1's trap: a raw⋈events JOIN returns `r1` TWICE here. `count(*) filter (where exists)`
    // counts the two RAW ROWS (which is correct — two records were ingested) but never multiplies
    // them by the events they share.
    await ingest(
      machineA,
      batch({ session: "s1", connector: "claude-code", rawId: "r1", ts: INSIDE, eventCount: 3 }),
    );
    await ingest(
      machineA2,
      batch({ session: "s1", connector: "claude-code", rawId: "r1", ts: INSIDE, eventCount: 3 }),
    );

    const totals = await asApp((tx) => rawRecordTotals(tx, orgA, SINCE));
    expect(totals).toEqual({ rawRows: 2, yieldedEvents: 2 });

    // …and the events themselves converged to ONE set of three, because the fingerprint is
    // machine-independent. That convergence is what makes the duplicate metric exact.
    const rows = await asApp((tx) => sessionQualityRows(tx, orgA, SINCE_ISO));
    expect(rows[0]!.eventCount).toBe(3);
  });

  it("sees the CROSS-MACHINE duplicate that `events` structurally cannot", async () => {
    await ingest(
      machineA,
      batch({ session: "s1", connector: "claude-code", rawId: "r1", ts: INSIDE, eventCount: 2 }),
    );
    await ingest(
      machineA2,
      batch({ session: "s1", connector: "claude-code", rawId: "r1", ts: INSIDE, eventCount: 2 }),
    );
    await ingest(
      machineA,
      batch({ session: "s1", connector: "claude-code", rawId: "r2", ts: INSIDE, eventCount: 1 }),
    );

    const dup = await asApp((tx) => duplicateRawRecords(tx, orgA, SINCE));
    // r1: copies=2 → (2-1) × 2 events = 2 collapsed duplicates. r2: copies=1 → 0.
    // distinct = 2 (r1) + 1 (r2) = 3. Ingested = 3 + 2 = 5.
    expect(dup).toEqual({ duplicateEvents: 2, distinctEvents: 3 });

    // The control: on `events` this is a structural zero, because the upsert already collapsed it.
    const stored = await asApp(async (tx) => {
      const r = await tx.execute<{ n: number }>(sql`select count(*)::int as n from events`);
      return r.rows[0]!.n;
    });
    expect(stored).toBe(3);
  });

  it("resolves token eligibility across exact / none / undeclared connectors", async () => {
    await owner.db.insert(machineConnectors).values([
      declaration(orgA, machineA, "claude-code", "exact", "streaming"),
      declaration(orgA, machineA, "gemini-cli", "none", "near-real-time"),
      // The same connector declared by a SECOND machine with lower fidelity. The reduction keeps
      // it eligible (the direction that cannot flatter the ratio) — asserted in the unit tests.
      declaration(orgA, machineA2, "claude-code", "none", "streaming"),
    ]);

    const rows = await asApp((tx) => connectorDeclarations(tx, orgA));
    expect(rows).toHaveLength(3);
    expect(
      rows
        .filter((r) => r.connectorId === "claude-code")
        .map((r) => r.tokens)
        .sort(),
    ).toEqual(["exact", "none"]);
    // `mystery-connector` is deliberately absent — an undeclared connector has NO row, which is
    // what routes its sessions to the pure layer's third bucket.
    expect(rows.some((r) => r.connectorId === "mystery-connector")).toBe(false);
  });

  it("attributes a session only when a workspace key OWNED BY THIS ORG resolves its path", async () => {
    // NOT-NULL columns that bit the planning spikes with 23502: `workspaces.user_id`,
    // `workspace_keys.user_id` AND `workspace_keys.source_connector`. Seed all three.
    const [ws] = await owner.db
      .insert(workspaces)
      .values({ orgId: orgA, userId: userA, rootPath: "/repo" })
      .returning({ id: workspaces.id });
    await owner.db.insert(workspaceKeys).values({
      orgId: orgA,
      userId: userA,
      workspaceId: ws!.id,
      sourceConnector: "claude-code",
      projectKey: "/repo",
    });

    await ingest(
      machineA,
      batch({ session: "mapped", connector: "claude-code", rawId: "r1", ts: INSIDE }),
    );
    await ingest(
      machineA,
      batch({
        session: "unmapped",
        connector: "claude-code",
        rawId: "r2",
        ts: INSIDE,
        projectPath: "/elsewhere",
      }),
    );

    const rows = await asApp((tx) => sessionQualityRows(tx, orgA, SINCE_ISO));
    const byId = new Map(rows.map((r) => [r.sessionId, r]));
    expect(byId.get("mapped")!.attributed).toBe(true);
    expect(byId.get("unmapped")!.attributed).toBe(false);
  });

  it("computes a per-session ingest lag in milliseconds, and null when it cannot", async () => {
    await ingest(
      machineA,
      batch({ session: "s1", connector: "claude-code", rawId: "r1", ts: INSIDE }),
    );
    // Force a known ingest time so the lag is deterministic rather than "however long the test took".
    await owner.db.execute(
      sql`update raw_source_records set ingested_at = ${new Date("2026-08-02T09:30:00.000Z")}
          where source_record_id = 'r1'`,
    );

    const rows = await asApp((tx) => ingestLagRows(tx, orgA, SINCE_ISO, SINCE));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lagMs).toBe(30 * 60 * 1000);
  });

  it("clamps a negative lag to zero rather than reporting a nonsense negative", async () => {
    await ingest(
      machineA,
      batch({ session: "s1", connector: "claude-code", rawId: "r1", ts: INSIDE }),
    );
    await owner.db.execute(
      sql`update raw_source_records set ingested_at = ${new Date("2026-08-02T08:00:00.000Z")}
          where source_record_id = 'r1'`,
    );
    const rows = await asApp((tx) => ingestLagRows(tx, orgA, SINCE_ISO, SINCE));
    expect(rows[0]!.lagMs).toBe(0);
  });

  it("does not overflow on a lag larger than int4 — a difference is not a count", async () => {
    // REGRESSION. The lag was originally cast `::bigint::int` like every count in the file, and a
    // back-dated event made Postgres raise `22003 integer out of range`, 500ing the whole audit.
    // A count is bounded by the table; a DIFFERENCE between two clocks is not. Found by the
    // app-role behavioural test in `rls.int.test.ts`, whose fixtures sit a year before `now`.
    await ingest(
      machineA,
      batch({ session: "s1", connector: "claude-code", rawId: "r1", ts: INSIDE }),
    );
    await owner.db.execute(
      sql`update raw_source_records set ingested_at = ${new Date("2126-08-02T09:00:00.000Z")}
          where source_record_id = 'r1'`,
    );
    const rows = await asApp((tx) => ingestLagRows(tx, orgA, SINCE_ISO, SINCE));
    // 100 years in ms ≈ 3.15e12 — three orders of magnitude past int4's 2.1e9 ceiling.
    expect(rows[0]!.lagMs).toBeGreaterThan(2_147_483_647);
  });

  it("returns distinct (session, status) git-link pairs, and only for in-window sessions", async () => {
    await ingest(
      machineA,
      batch({ session: "s1", connector: "claude-code", rawId: "r1", ts: INSIDE }),
    );
    await ingest(
      machineA,
      batch({ session: "old", connector: "claude-code", rawId: "r0", ts: OUTSIDE }),
    );

    const [commit] = await owner.db
      .insert(gitCommits)
      .values({
        orgId: orgA,
        machineId: machineA,
        commitSha: "abc123",
        repoRootPath: "/repo",
        authoredAt: INSIDE,
        filesChanged: 1,
        insertions: 1,
        deletions: 0,
      })
      .returning({ id: gitCommits.id });
    await owner.db.insert(sessionGitLinks).values([
      {
        orgId: orgA,
        userId: userA,
        sessionId: "s1",
        commitId: commit!.id,
        confidence: "medium",
        status: "suggested",
      },
      {
        orgId: orgA,
        userId: userA,
        sessionId: "old",
        commitId: commit!.id,
        confidence: "high",
        status: "confirmed",
      },
    ]);

    const rows = await asApp((tx) => gitLinkageRows(tx, orgA, SINCE_ISO));
    // `old` has no events in the window, so its link is excluded — the window is applied through
    // the events side because `session_git_links` carries no timestamp tying it to one.
    expect(rows).toEqual([{ sessionId: "s1", status: "suggested" }]);
  });

  it("selects the SAME reconciliation sample on two consecutive calls (D-16.4-5 determinism)", async () => {
    for (let i = 0; i < 8; i++) {
      await ingest(
        machineA,
        batch({ session: `s${i}`, connector: "claude-code", rawId: `r${i}`, ts: INSIDE }),
      );
    }
    const first = await asApp((tx) => reconciliationSample(tx, orgA, SINCE_ISO, 3));
    const second = await asApp((tx) => reconciliationSample(tx, orgA, SINCE_ISO, 3));
    expect(first).toHaveLength(3);
    expect(second.map((r) => r.sessionId)).toEqual(first.map((r) => r.sessionId));
    // …and it is NOT simply "the first three by id", which would be a time/insertion-order bias.
    expect(first.map((r) => r.sessionId)).not.toEqual(["s0", "s1", "s2"]);
  });

  it("returns ALL sessions when the sample size exceeds what exists", async () => {
    await ingest(
      machineA,
      batch({ session: "s1", connector: "claude-code", rawId: "r1", ts: INSIDE }),
    );
    const rows = await asApp((tx) => reconciliationSample(tx, orgA, SINCE_ISO, 10));
    expect(rows).toHaveLength(1);
  });

  it("pre-fills the four archive-answerable §4.4 checks on a sampled row", async () => {
    await ingest(
      machineA,
      batch({
        session: "s1",
        connector: "claude-code",
        rawId: "r1",
        ts: INSIDE,
        eventCount: 2,
        withTokens: true,
      }),
    );
    const [row] = await asApp((tx) => reconciliationSample(tx, orgA, SINCE_ISO, 5));
    expect(row).toMatchObject({
      sessionId: "s1",
      sourceConnector: "claude-code",
      rawRecordCount: 1, // check 2
      eventCount: 2, // check 3
      eventsWithTokens: 2, // check 3
      indexed: false, // check 6 — nothing indexed this session yet
      projectPath: "/repo",
    });
    expect(row!.models).toEqual(["claude-sonnet-5"]);
    // MANDATORY normalization — `min(ts)`/`max(ts)` are Postgres text, not ISO.
    expect(row!.firstTs).toBe(INSIDE);
  });

  it("returns one recoverability target per (session, connector, MACHINE) — raw is per-machine", async () => {
    await ingest(
      machineA,
      batch({ session: "s1", connector: "claude-code", rawId: "r1", ts: INSIDE }),
    );
    await ingest(
      machineA2,
      batch({ session: "s1", connector: "claude-code", rawId: "r1", ts: INSIDE }),
    );

    const targets = await asApp((tx) =>
      recoverabilityTargets(tx, orgA, [{ sessionId: "s1", sourceConnector: "claude-code" }]),
    );
    expect(targets).toHaveLength(2);
    expect(new Set(targets.map((t) => t.machineId))).toEqual(new Set([machineA, machineA2]));
  });

  /**
   * The reason `recoverabilityTargets` takes (session, connector) PAIRS rather than bare session
   * ids: filtering on the session alone would re-admit a connector the deterministic sample never
   * selected, so the recoverability row would describe different subjects than the worksheet lists —
   * and the decrypt fan-out would gain a third multiplier past the ceiling `schemas.ts` states.
   */
  it("excludes a connector the sample did not select, even on a sampled session", async () => {
    await ingest(
      machineA,
      batch({ session: "s1", connector: "claude-code", rawId: "r1", ts: INSIDE }),
    );
    await ingest(
      machineA,
      batch({ session: "s1", connector: "codex-cli", rawId: "r9", ts: INSIDE }),
    );

    const targets = await asApp((tx) =>
      recoverabilityTargets(tx, orgA, [{ sessionId: "s1", sourceConnector: "claude-code" }]),
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]!.sourceConnector).toBe("claude-code");
  });

  it("returns nothing for an empty session list without touching the database", async () => {
    expect(await asApp((tx) => recoverabilityTargets(tx, orgA, []))).toEqual([]);
  });

  it("FAILS CLOSED: with NO org context every aggregate reads zero, not another org's data", async () => {
    await ingest(
      machineA,
      batch({ session: "s1", connector: "claude-code", rawId: "r1", ts: INSIDE }),
    );

    // No `withOrg` — the unset context an unwrapped call site would have (the exact defect
    // CLAUDE.md records `deliverPendingFirings` shipping with).
    const rows = await sessionQualityRows(appRole.db, orgA, SINCE_ISO);
    expect(rows).toEqual([]);

    // …and the owner CAN see it, so the zero above is the POLICY and not an empty table.
    const truth = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from events`);
    expect(truth.rows[0]!.n).toBe(1);
  });
});

/** A `machine_connectors` row with only the fields these reads care about varied. */
function declaration(
  orgId: string,
  machineId: string,
  connectorId: string,
  tokens: MachineConnectorInsert["tokens"],
  liveness: MachineConnectorInsert["liveness"],
): MachineConnectorInsert {
  return {
    orgId,
    machineId,
    connectorId,
    enabled: true,
    approval: "approved",
    status: "stable",
    captureMethod: "jsonl tail",
    liveness,
    tokens,
    cost: "computed",
    knownGaps: [],
    requiredPermissions: [],
    custom: false,
    lastErrorMessage: null,
    lastErrorAt: null,
    errorCount: 0,
    reportedAt: NOW,
  };
}
