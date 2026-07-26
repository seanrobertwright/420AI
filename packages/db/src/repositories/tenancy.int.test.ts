import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { IngestBatch } from "@420ai/shared";
import {
  createDb,
  indexSessions,
  ingestBatch,
  recordGitCommits,
  recordHeartbeat,
} from "../index.js";
import {
  events,
  gitCommitFiles,
  gitCommits,
  ingestTokens,
  machineHeartbeats,
  machines,
  rawSourceRecords,
  searchDocuments,
  users,
} from "../schema.js";
import { ensurePersonalOrg } from "./organizations.js";
import { issueIngestToken } from "./tokens.js";

const TEST_URL = process.env.DATABASE_URL_TEST;

/**
 * M15 15.1 tenancy — the slice's HEADLINE NEGATIVE TESTS.
 *
 * Every other int suite proves org coverage implicitly (a missed write path fails on the
 * `NOT NULL` constraint). These three pin the things a `NOT NULL` column cannot:
 *   1. a converging cross-org re-ingest must NOT flip an existing event's owner (D-M15-2)
 *   2. two orgs must be able to hold the same (entity_type, entity_id) search doc (audit B.1)
 *   3. the tenant/global table split is exactly the 15/4 the milestone decided (D-M15-9)
 */

/** The SAME two fingerprints regardless of which machine uploads them (PRD §12). */
function convergingBatch(machineTag: string): IngestBatch {
  return {
    records: [
      {
        sourceConnector: "claude-code",
        sessionId: "tenancy-s1",
        // Raw is per-machine (its idempotency key includes machine_id), so vary it.
        sourceRecordId: `raw-${machineTag}`,
        payload: JSON.stringify({ from: machineTag }),
      },
    ],
    events: [
      {
        fingerprint: "tenancy-fp-1",
        sourceConnector: "claude-code",
        parserVersion: "1.0.0",
        rawRecordId: `raw-${machineTag}`,
        eventIndex: 0,
        eventType: "message.user",
        sessionId: "tenancy-s1",
        ts: "2026-07-01T00:00:00.000Z",
      },
      {
        fingerprint: "tenancy-fp-2",
        sourceConnector: "claude-code",
        parserVersion: "1.0.0",
        rawRecordId: `raw-${machineTag}`,
        eventIndex: 1,
        eventType: "usage.reported",
        sessionId: "tenancy-s1",
        ts: "2026-07-01T00:00:01.000Z",
      },
    ],
  };
}

/** The 15 tables that MUST carry a NOT NULL org_id (plan Task 2). */
const TENANT_TABLES = [
  "machines",
  "pairing_codes",
  "ingest_tokens",
  "raw_source_records",
  "events",
  "projects",
  "workspaces",
  "workspace_keys",
  "report_artifacts",
  "git_commits",
  "git_commit_files",
  "session_git_links",
  "machine_heartbeats",
  "alert_firings",
  "search_documents",
] as const;

/** Tables that must NOT gain org_id — identities and deployment-global data (D-M15-9). */
const GLOBAL_TABLES = [
  "users",
  "pricing_catalogs",
  "connector_catalogs",
  "ingest_auth_failures",
] as const;

describe.skipIf(!TEST_URL)("M15 tenancy invariants (integration)", () => {
  let dbh: ReturnType<typeof createDb>;
  let orgA: string;
  let orgB: string;
  let userA: string;
  let userB: string;
  let machineA: string;
  let machineB: string;

  beforeAll(() => {
    dbh = createDb(TEST_URL!);
  });

  afterAll(async () => {
    await dbh.pool.end();
  });

  beforeEach(async () => {
    await dbh.db.execute(
      sql`TRUNCATE search_documents, session_git_links, git_commit_files, git_commits, alert_firings, machine_heartbeats, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    const seeded = await dbh.db
      .insert(users)
      .values([{ email: "a@example.com" }, { email: "b@example.com" }])
      .returning({ id: users.id, email: users.email });
    userA = seeded.find((u) => u.email === "a@example.com")!.id;
    userB = seeded.find((u) => u.email === "b@example.com")!.id;
    orgA = await ensurePersonalOrg(dbh.db, userA, "a@example.com");
    orgB = await ensurePersonalOrg(dbh.db, userB, "b@example.com");
    expect(orgA).not.toBe(orgB);

    const [mA] = await dbh.db
      .insert(machines)
      .values({ orgId: orgA, userId: userA, name: "machine-a" })
      .returning({ id: machines.id });
    const [mB] = await dbh.db
      .insert(machines)
      .values({ orgId: orgB, userId: userB, name: "machine-b" })
      .returning({ id: machines.id });
    machineA = mA!.id;
    machineB = mB!.id;
  });

  // 1 ── D-M15-2: org immutability across a converging cross-org re-ingest.
  it("a converging re-ingest from ANOTHER org does not flip an existing event's org_id", async () => {
    await ingestBatch(dbh.db, machineA, convergingBatch("a"));
    const after1 = await dbh.db.select().from(events);
    expect(after1).toHaveLength(2);
    expect(after1.every((e) => e.orgId === orgA)).toBe(true);

    // The SAME fingerprints, uploaded by a machine in a DIFFERENT org.
    const res = await ingestBatch(dbh.db, machineB, convergingBatch("b"));
    expect(res.eventsUpserted).toBe(2);

    const after2 = await dbh.db.select().from(events);
    // They converged — the fingerprint is machine-independent, so still 2 rows.
    expect(after2).toHaveLength(2);
    // machine_id DID move to B (today's documented "most recent ingesting machine").
    expect(after2.every((e) => e.machineId === machineB)).toBe(true);
    // …but the OWNER did not. First writer's org wins — omitting orgId from the
    // ON CONFLICT `set:` block is what makes a cross-tenant write unrepresentable.
    expect(after2.every((e) => e.orgId === orgA)).toBe(true);

    // Raw stays per-machine, so org B's own raw row lands in org B.
    const raw = await dbh.db.select().from(rawSourceRecords);
    expect(raw).toHaveLength(2);
    expect(raw.find((r) => r.machineId === machineA)!.orgId).toBe(orgA);
    expect(raw.find((r) => r.machineId === machineB)!.orgId).toBe(orgB);
  });

  // 2 ── audit B.1: the search index is org-scoped, so two orgs cannot collide.
  it("two orgs can hold the same (entity_type, entity_id) search document", async () => {
    const base = {
      entityType: "session" as const,
      entityId: "shared-session-id", // a connector-supplied, GLOBALLY-scoped string
      projectId: null,
      sessionId: "shared-session-id",
      title: "t",
      redactionVersion: "test",
    };
    await dbh.db
      .insert(searchDocuments)
      .values({ ...base, orgId: orgA, userId: userA, body: "org A body" });
    await dbh.db
      .insert(searchDocuments)
      .values({ ...base, orgId: orgB, userId: userB, body: "org B body" });

    const rows = await dbh.db.select().from(searchDocuments);
    // Under the OLD globally-unique (entity_type, entity_id) index this was impossible.
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.orgId === orgA)!.body).toBe("org A body");
    expect(rows.find((r) => r.orgId === orgB)!.body).toBe("org B body");

    // The index is still an idempotency key WITHIN an org: a re-insert for org A
    // conflicts (rather than duplicating), which is what `upsertDoc` relies on.
    // Drizzle wraps the driver error, so the PG code lives on `.cause` (23505 = unique).
    const dup = await dbh.db
      .insert(searchDocuments)
      .values({ ...base, orgId: orgA, userId: userA, body: "again" })
      .then(
        () => undefined,
        (e: unknown) => e as { cause?: { code?: string; constraint?: string } },
      );
    expect(dup?.cause?.code).toBe("23505");
    expect(dup?.cause?.constraint).toBe("search_documents_entity");
  });

  // 2b ── the same, through the REAL index builder rather than hand-inserted rows.
  it("indexSessions emits ONE doc PER ORG for a shared session id, with no content bleed", async () => {
    // A connector session id is a globally-scoped string, so two tenants can hold the
    // same one. Before the (org_id, session_id) group key, `indexSessions` grouped by
    // session id alone: it produced a SINGLE doc owned by min(org_id) whose body
    // concatenated both orgs' decrypted payloads — a cross-tenant content leak that the
    // hand-inserted B.1 test above could not catch, because it never ran the builder.
    const batch = (tag: string): IngestBatch => ({
      records: [
        {
          sourceConnector: "claude-code",
          sessionId: "COLLIDING-SESSION",
          sourceRecordId: `rec-${tag}`,
          payload: `SECRET-OF-ORG-${tag}`,
        },
      ],
      events: [
        {
          fingerprint: `bleed-${tag}`,
          sourceConnector: "claude-code",
          parserVersion: "1.0.0",
          rawRecordId: `rec-${tag}`,
          eventIndex: 0,
          eventType: "message.user",
          sessionId: "COLLIDING-SESSION",
          ts: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
    await ingestBatch(dbh.db, machineA, batch("A"));
    await ingestBatch(dbh.db, machineB, batch("B"));

    const counts = await indexSessions(dbh.db, ["COLLIDING-SESSION"]);
    expect(counts.sessions).toBe(2); // one per org, not one collapsed row

    const docs = await dbh.db
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.entityType, "session"));
    expect(docs).toHaveLength(2);

    const docA = docs.find((d) => d.orgId === orgA)!;
    const docB = docs.find((d) => d.orgId === orgB)!;
    expect(docA).toBeDefined();
    expect(docB).toBeDefined();
    // Each org's document contains ONLY its own content.
    expect(docA.body).toContain("SECRET-OF-ORG-A");
    expect(docA.body).not.toContain("SECRET-OF-ORG-B");
    expect(docB.body).toContain("SECRET-OF-ORG-B");
    expect(docB.body).not.toContain("SECRET-OF-ORG-A");

    // …and each event doc is stamped with the org that actually produced it.
    const eventDocs = await dbh.db
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.entityType, "event"));
    expect(eventDocs.find((d) => d.entityId === "bleed-A")!.orgId).toBe(orgA);
    expect(eventDocs.find((d) => d.entityId === "bleed-B")!.orgId).toBe(orgB);
  });

  // 3a ── every machine-keyed write path derives the org from machines.org_id.
  it("every machine-keyed write path stamps the machine's own org", async () => {
    await ingestBatch(dbh.db, machineA, convergingBatch("a"));
    await issueIngestToken(dbh.db, machineA);
    await recordHeartbeat(dbh.db, machineA, {
      queuePending: 1,
      queueInflight: 0,
      collectorVersion: "0.0.0-test",
    });
    await recordGitCommits(dbh.db, machineA, {
      commits: [
        {
          commitSha: "tenancysha",
          repoRootPath: "/repo",
          gitBranch: "main",
          authorName: "Dev",
          authorEmail: "dev@example.com",
          authoredAt: "2026-07-01T00:00:00.000Z",
          committedAt: "2026-07-01T00:00:00.000Z",
          message: "chore: tenancy",
          parents: [],
          isRevert: false,
          filesChanged: 1,
          insertions: 1,
          deletions: 0,
          files: [{ path: "src/a.ts", status: "added", insertions: 1, deletions: 0 }],
        },
      ],
    });

    const orgsOf = async (rows: { orgId: string }[]) => rows.map((r) => r.orgId);
    expect(await orgsOf(await dbh.db.select().from(events))).toEqual([orgA, orgA]);
    expect(await orgsOf(await dbh.db.select().from(rawSourceRecords))).toEqual([orgA]);
    expect(await orgsOf(await dbh.db.select().from(ingestTokens))).toEqual([orgA]);
    expect(await orgsOf(await dbh.db.select().from(machineHeartbeats))).toEqual([orgA]);
    expect(await orgsOf(await dbh.db.select().from(gitCommits))).toEqual([orgA]);
    // A file row's org is its parent commit's, by construction.
    expect(await orgsOf(await dbh.db.select().from(gitCommitFiles))).toEqual([orgA]);

    // Nothing leaked into org B.
    const [{ n }] = (
      await dbh.db.execute(
        sql`SELECT count(*)::int AS n FROM events WHERE org_id = ${orgB}
            UNION ALL SELECT count(*)::int FROM git_commits WHERE org_id = ${orgB}`,
      )
    ).rows as { n: number }[];
    expect(n).toBe(0);
  });

  it("a machine-keyed write for an unknown machine throws rather than inserting a null org", async () => {
    const ghost = "00000000-0000-0000-0000-000000000000";
    await expect(ingestBatch(dbh.db, ghost, convergingBatch("x"))).rejects.toThrow(
      `unknown machine ${ghost}`,
    );
    expect(await dbh.db.select().from(events)).toHaveLength(0);
  });

  // 3b ── the tenant/global split is exactly what the milestone decided.
  it("the 15 tenant tables carry NOT NULL org_id + an FK; the 4 global tables do not", async () => {
    const cols = (
      await dbh.db.execute(sql`
        SELECT table_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'org_id'
      `)
    ).rows as { table_name: string; is_nullable: string }[];
    // `memberships.org_id` is expected too — it is the join table, not a tenant table.
    const tenantCols = cols.filter((c) => c.table_name !== "memberships");
    expect(tenantCols.map((c) => c.table_name).sort()).toEqual([...TENANT_TABLES].sort());
    expect(tenantCols.every((c) => c.is_nullable === "NO")).toBe(true);
    for (const t of GLOBAL_TABLES) {
      expect(cols.map((c) => c.table_name)).not.toContain(t);
    }

    const fks = (
      await dbh.db.execute(sql`
        SELECT DISTINCT tc.table_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
        JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'org_id'
          AND ccu.table_name = 'organizations'
      `)
    ).rows as { table_name: string }[];
    for (const t of TENANT_TABLES) {
      expect(fks.map((f) => f.table_name)).toContain(t);
    }
  });

  it("the events primary key is STILL the fingerprint alone (the dedup key is untouched)", async () => {
    const pk = (
      await dbh.db.execute(sql`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = 'events'
      `)
    ).rows as { column_name: string }[];
    expect(pk.map((r) => r.column_name)).toEqual(["fingerprint"]);
  });

  it("an event with a NULL machine_id still requires an org (the migration's 3b fallback case)", async () => {
    // `events.machine_id` is nullable BY DESIGN, which is why the 0014 backfill needs a
    // fallback. Going forward the NOT NULL org_id makes an ownerless event impossible.
    await expect(
      dbh.db.insert(events).values({
        fingerprint: "no-machine",
        sourceConnector: "claude-code",
        parserVersion: "1.0.0",
        rawRecordId: "r",
        eventIndex: 0,
        eventType: "message.user",
        sessionId: "s",
        ts: "2026-07-01T00:00:00.000Z",
      } as never),
    ).rejects.toThrow(/org_id/);

    // With an org it is accepted, machine_id null and all.
    await dbh.db.insert(events).values({
      fingerprint: "no-machine",
      orgId: orgA,
      sourceConnector: "claude-code",
      parserVersion: "1.0.0",
      rawRecordId: "r",
      eventIndex: 0,
      eventType: "message.user",
      sessionId: "s",
      ts: "2026-07-01T00:00:00.000Z",
    });
    const [row] = await dbh.db.select().from(events).where(eq(events.fingerprint, "no-machine"));
    expect(row!.machineId).toBeNull();
    expect(row!.orgId).toBe(orgA);
  });
});
