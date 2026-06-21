import { and, desc, eq, sql } from "drizzle-orm";
import type { ConnectorCatalogPayload } from "@420ai/shared";
import type { Db, DbClient } from "../client.js";
import { connectorCatalogs } from "../schema.js";

/**
 * M12 12.7c signed connector-catalog repository (PRD §10.4) — the structural twin of
 * `pricing-catalogs.ts`. The catalog lifecycle: insert `pending` (idempotent by version)
 * → admin `approve` (demote the current active → `superseded`, promote pending → `active`,
 * atomically in a txn) or `reject`. `getActiveConnectorCatalog` feeds the collector's
 * `GET /v1/connector-catalog/active` pull; `countPendingConnectorCatalogs` feeds the §20
 * approval alert (parity with pricing's `countPendingCatalogs`).
 *
 * GLOBAL (no user scope) — connector definitions apply to every machine. Silent library
 * (CLAUDE.md): throws, never logs. Plain timestamptz columns come back as JS Date —
 * normalized to ISO on read (mirror pricing-catalogs.ts toRow).
 */

export interface ConnectorCatalogRow {
  id: string;
  version: string;
  payload: ConnectorCatalogPayload;
  signature: string;
  status: "pending" | "active" | "superseded" | "rejected";
  uploadedAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
}

/** Map a raw catalog row (text status, Date timestamps) onto the typed wire shape. */
function toRow(r: {
  id: string;
  version: string;
  payload: ConnectorCatalogPayload;
  signature: string;
  status: string;
  uploadedAt: Date;
  approvedAt: Date | null;
  approvedBy: string | null;
}): ConnectorCatalogRow {
  return {
    id: r.id,
    version: r.version,
    payload: r.payload,
    signature: r.signature,
    status: r.status as ConnectorCatalogRow["status"],
    // Plain timestamptz columns come back as JS Date via the driver — normalize to ISO.
    uploadedAt: r.uploadedAt.toISOString(),
    approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
    approvedBy: r.approvedBy,
  };
}

/**
 * Store a verified catalog upload as `pending`. Idempotent by `version`: a re-upload of
 * an existing version is a no-op that returns the EXISTING row (never a duplicate).
 * Signature verification happens in the route BEFORE this is called.
 */
export async function insertPendingConnectorCatalog(
  db: DbClient,
  input: { version: string; payload: ConnectorCatalogPayload; signature: string },
): Promise<ConnectorCatalogRow> {
  const [inserted] = await db
    .insert(connectorCatalogs)
    .values({
      version: input.version,
      payload: input.payload,
      signature: input.signature,
      status: "pending",
    })
    .onConflictDoNothing({ target: connectorCatalogs.version })
    .returning();
  if (inserted) return toRow(inserted);
  // Duplicate version → return the existing row (idempotent).
  const [existing] = await db
    .select()
    .from(connectorCatalogs)
    .where(eq(connectorCatalogs.version, input.version))
    .limit(1);
  return toRow(existing!);
}

/**
 * The active uploaded catalog (≤1, enforced by the partial unique index), shaped for the
 * collector pull: `{ version, payload, signature }`. The `signature` is included (unlike
 * pricing's `getActiveCatalog`) because the collector RE-VERIFIES it against the bundled
 * key before caching/applying (defense-in-depth — a tampered local cache is ignored).
 * `undefined` when none is active → the collector falls back to the bundled
 * CONNECTOR_CATALOG_BASELINE (the default-on contract).
 */
export async function getActiveConnectorCatalog(
  db: DbClient,
): Promise<{ version: string; payload: ConnectorCatalogPayload; signature: string } | undefined> {
  const [row] = await db
    .select({
      version: connectorCatalogs.version,
      payload: connectorCatalogs.payload,
      signature: connectorCatalogs.signature,
    })
    .from(connectorCatalogs)
    .where(eq(connectorCatalogs.status, "active"))
    .limit(1);
  return row ? { version: row.version, payload: row.payload, signature: row.signature } : undefined;
}

/** All catalog rows, newest upload first (admin listing). */
export async function listConnectorCatalogs(db: DbClient): Promise<ConnectorCatalogRow[]> {
  const rows = await db
    .select()
    .from(connectorCatalogs)
    .orderBy(desc(connectorCatalogs.uploadedAt));
  return rows.map(toRow);
}

/**
 * Approve a pending catalog → `active`, atomically superseding the prior active. In a
 * transaction: (1) demote the current active row to `superseded`; (2) promote the target
 * (which MUST be `pending`) to `active` + stamp approved_at/approved_by. Demote-before-
 * promote satisfies the partial unique (no two active rows). Returns the activated row,
 * or `undefined` if `id` is unknown or not `pending` (→ route 404).
 */
export async function approveConnectorCatalog(
  db: Db,
  id: string,
  approvedBy: string,
  now: Date,
): Promise<ConnectorCatalogRow | undefined> {
  return db.transaction(async (tx) => {
    // (1) Demote the current active (if any) — must precede the promote (partial unique).
    await tx
      .update(connectorCatalogs)
      .set({ status: "superseded" })
      .where(eq(connectorCatalogs.status, "active"));
    // (2) Promote the target ONLY if it is still pending.
    const [promoted] = await tx
      .update(connectorCatalogs)
      .set({ status: "active", approvedAt: now, approvedBy })
      .where(and(eq(connectorCatalogs.id, id), eq(connectorCatalogs.status, "pending")))
      .returning();
    return promoted ? toRow(promoted) : undefined;
  });
}

/**
 * Reject a pending catalog → `rejected`, stamping `approved_at` as the decision time
 * (approved_by stays null, so a rejection is distinguishable from an approval). Returns
 * the row, or `undefined` if unknown/not pending.
 */
export async function rejectConnectorCatalog(
  db: DbClient,
  id: string,
  now: Date,
): Promise<ConnectorCatalogRow | undefined> {
  const [rejected] = await db
    .update(connectorCatalogs)
    .set({ status: "rejected", approvedAt: now })
    .where(and(eq(connectorCatalogs.id, id), eq(connectorCatalogs.status, "pending")))
    .returning();
  return rejected ? toRow(rejected) : undefined;
}

/** Count catalogs awaiting approval — feeds the §20 connector-catalog approval alert. */
export async function countPendingConnectorCatalogs(db: DbClient): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(connectorCatalogs)
    .where(eq(connectorCatalogs.status, "pending"));
  return rows[0]?.n ?? 0;
}
