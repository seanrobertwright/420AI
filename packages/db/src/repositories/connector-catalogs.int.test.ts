import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDb,
  insertPendingConnectorCatalog,
  getActiveConnectorCatalog,
  listConnectorCatalogs,
  approveConnectorCatalog,
  rejectConnectorCatalog,
  countPendingConnectorCatalogs,
} from "../index.js";
import type { ConnectorCatalogPayload } from "@420ai/shared";

const TEST_URL = process.env.DATABASE_URL_TEST;

const PAYLOAD: ConnectorCatalogPayload = {
  connectors: [
    {
      id: "claude-code",
      watchGlobs: ["/home/.claude/projects/*/*.jsonl"],
      fidelity: { requiredPermissions: ["Read Claude Code transcripts"] },
    },
  ],
};

const PAYLOAD_2: ConnectorCatalogPayload = {
  connectors: [{ id: "codex-cli", enabled: false }],
};

describe.skipIf(!TEST_URL)("connector-catalogs repository (integration) — M12 12.7c", () => {
  let dbh: ReturnType<typeof createDb>;

  beforeAll(() => {
    dbh = createDb(TEST_URL!);
  });

  afterAll(async () => {
    await dbh.pool.end();
  });

  beforeEach(async () => {
    await dbh.db.execute(sql`TRUNCATE connector_catalogs RESTART IDENTITY CASCADE`);
  });

  it("insert pending → not active yet, pending count 1", async () => {
    const row = await insertPendingConnectorCatalog(dbh.db, {
      version: "m12-connector-catalog-v2",
      payload: PAYLOAD,
      signature: "sig",
    });
    expect(row.status).toBe("pending");
    expect(row.uploadedAt).toBe(new Date(row.uploadedAt).toISOString()); // ISO-normalized
    expect(row.approvedAt).toBeNull();
    expect(await getActiveConnectorCatalog(dbh.db)).toBeUndefined();
    expect(await countPendingConnectorCatalogs(dbh.db)).toBe(1);
  });

  it("approve → active, getActiveConnectorCatalog returns the payload, pending count 0", async () => {
    const pending = await insertPendingConnectorCatalog(dbh.db, {
      version: "m12-connector-catalog-v2",
      payload: PAYLOAD,
      signature: "sig",
    });
    const approved = await approveConnectorCatalog(dbh.db, pending.id, "admin", new Date());
    expect(approved?.status).toBe("active");
    expect(approved?.approvedBy).toBe("admin");
    expect(approved?.approvedAt).not.toBeNull();
    const active = await getActiveConnectorCatalog(dbh.db);
    expect(active?.version).toBe("m12-connector-catalog-v2");
    expect(active?.signature).toBe("sig"); // signature ships for collector re-verify
    expect(active?.payload.connectors[0]?.id).toBe("claude-code");
    expect(active?.payload.connectors[0]?.watchGlobs).toEqual(["/home/.claude/projects/*/*.jsonl"]);
    expect(await countPendingConnectorCatalogs(dbh.db)).toBe(0);
  });

  it("approving a 2nd catalog supersedes the 1st atomically — only ONE active (partial unique held)", async () => {
    const first = await insertPendingConnectorCatalog(dbh.db, {
      version: "v-a",
      payload: PAYLOAD,
      signature: "s1",
    });
    await approveConnectorCatalog(dbh.db, first.id, "admin", new Date());
    const second = await insertPendingConnectorCatalog(dbh.db, {
      version: "v-b",
      payload: PAYLOAD_2,
      signature: "s2",
    });
    const promoted = await approveConnectorCatalog(dbh.db, second.id, "admin", new Date());
    expect(promoted?.status).toBe("active");

    const rows = await listConnectorCatalogs(dbh.db);
    const active = rows.filter((r) => r.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]!.version).toBe("v-b");
    expect(rows.find((r) => r.version === "v-a")!.status).toBe("superseded");
    expect((await getActiveConnectorCatalog(dbh.db))?.version).toBe("v-b");
  });

  it("approve is guarded: unknown id or already-active id → undefined", async () => {
    expect(
      await approveConnectorCatalog(
        dbh.db,
        "00000000-0000-4000-8000-000000000000",
        "admin",
        new Date(),
      ),
    ).toBeUndefined();
    const p = await insertPendingConnectorCatalog(dbh.db, {
      version: "v1",
      payload: PAYLOAD,
      signature: "s",
    });
    await approveConnectorCatalog(dbh.db, p.id, "admin", new Date());
    // re-approving an already-active row → undefined (not pending)
    expect(await approveConnectorCatalog(dbh.db, p.id, "admin", new Date())).toBeUndefined();
  });

  it("reject a pending → rejected; rejecting a non-pending → undefined", async () => {
    const p = await insertPendingConnectorCatalog(dbh.db, {
      version: "v1",
      payload: PAYLOAD,
      signature: "s",
    });
    const rejected = await rejectConnectorCatalog(dbh.db, p.id, new Date());
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.approvedBy).toBeNull(); // a rejection is distinguishable from an approval
    expect(await rejectConnectorCatalog(dbh.db, p.id, new Date())).toBeUndefined();
    expect(await countPendingConnectorCatalogs(dbh.db)).toBe(0);
  });

  it("re-uploading the same version is idempotent (same row, no duplicate)", async () => {
    const a = await insertPendingConnectorCatalog(dbh.db, {
      version: "dup",
      payload: PAYLOAD,
      signature: "s",
    });
    const b = await insertPendingConnectorCatalog(dbh.db, {
      version: "dup",
      payload: PAYLOAD,
      signature: "s",
    });
    expect(b.id).toBe(a.id);
    expect(await listConnectorCatalogs(dbh.db)).toHaveLength(1);
  });
});
