import { and, desc, eq, sql } from "drizzle-orm";
import type { ModelPricing } from "@420ai/shared";
import type { Db, DbClient } from "../client.js";
import { pricingCatalogs } from "../schema.js";

/**
 * M10 3d signed pricing-catalog repository (PRD §10.4/§18/§20/§23). The catalog
 * lifecycle: insert `pending` (idempotent by version, D6) → admin `approve` (demote
 * the current active → `superseded`, promote the target → `active`, atomically in a
 * txn, D7) or `reject`. `getActiveCatalog` feeds the ingest re-pricing path;
 * `countPendingCatalogs` feeds the §20 alert.
 *
 * GLOBAL (no user scope, D6) — pricing applies to everyone. Silent library
 * (CLAUDE.md): throws, never logs. Plain timestamptz columns come back as JS Date —
 * normalized to ISO on read (mirror alert-firings.ts toFiring).
 */

export interface PricingCatalogRow {
  id: string;
  version: string;
  payload: Record<string, ModelPricing>;
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
  payload: Record<string, ModelPricing>;
  signature: string;
  status: string;
  uploadedAt: Date;
  approvedAt: Date | null;
  approvedBy: string | null;
}): PricingCatalogRow {
  return {
    id: r.id,
    version: r.version,
    payload: r.payload,
    signature: r.signature,
    status: r.status as PricingCatalogRow["status"],
    // Plain timestamptz columns come back as JS Date via the driver — normalize to ISO.
    uploadedAt: r.uploadedAt.toISOString(),
    approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
    approvedBy: r.approvedBy,
  };
}

/**
 * Store a verified catalog upload as `pending`. Idempotent by `version` (D6): a
 * re-upload of an existing version is a no-op that returns the EXISTING row (never a
 * duplicate). Signature verification happens in the route BEFORE this is called.
 */
export async function insertPendingCatalog(
  db: DbClient,
  input: { version: string; payload: Record<string, ModelPricing>; signature: string },
): Promise<PricingCatalogRow> {
  const [inserted] = await db
    .insert(pricingCatalogs)
    .values({
      version: input.version,
      payload: input.payload,
      signature: input.signature,
      status: "pending",
    })
    .onConflictDoNothing({ target: pricingCatalogs.version })
    .returning();
  if (inserted) return toRow(inserted);
  // Duplicate version → return the existing row (idempotent, D6).
  const [existing] = await db
    .select()
    .from(pricingCatalogs)
    .where(eq(pricingCatalogs.version, input.version))
    .limit(1);
  return toRow(existing!);
}

/**
 * The active uploaded catalog (≤1, enforced by the partial unique index), shaped for
 * the ingest re-pricing path: `{ version, rates }`. `undefined` when none is active →
 * ingest is byte-identical to today (the bundled PRICING_CATALOG baseline applies).
 */
export async function getActiveCatalog(
  db: DbClient,
): Promise<{ version: string; rates: Record<string, ModelPricing> } | undefined> {
  const [row] = await db
    .select({ version: pricingCatalogs.version, payload: pricingCatalogs.payload })
    .from(pricingCatalogs)
    .where(eq(pricingCatalogs.status, "active"))
    .limit(1);
  return row ? { version: row.version, rates: row.payload } : undefined;
}

/** All catalog rows, newest upload first (admin listing). */
export async function listCatalogs(db: DbClient): Promise<PricingCatalogRow[]> {
  const rows = await db.select().from(pricingCatalogs).orderBy(desc(pricingCatalogs.uploadedAt));
  return rows.map(toRow);
}

/**
 * Approve a pending catalog → `active`, atomically superseding the prior active (D7).
 * In a transaction: (1) demote the current active row to `superseded`; (2) promote the
 * target (which MUST be `pending`) to `active` + stamp approved_at/approved_by.
 * Demote-before-promote satisfies the partial unique (no two active rows). Returns the
 * activated row, or `undefined` if `id` is unknown or not `pending` (→ route 404).
 */
export async function approveCatalog(
  db: Db,
  id: string,
  approvedBy: string,
  now: Date,
): Promise<PricingCatalogRow | undefined> {
  return db.transaction(async (tx) => {
    // (1) Demote the current active (if any) — must precede the promote (partial unique).
    await tx
      .update(pricingCatalogs)
      .set({ status: "superseded" })
      .where(eq(pricingCatalogs.status, "active"));
    // (2) Promote the target ONLY if it is still pending.
    const [promoted] = await tx
      .update(pricingCatalogs)
      .set({ status: "active", approvedAt: now, approvedBy })
      .where(and(eq(pricingCatalogs.id, id), eq(pricingCatalogs.status, "pending")))
      .returning();
    return promoted ? toRow(promoted) : undefined;
  });
}

/**
 * Reject a pending catalog → `rejected`, stamping `approved_at` as the decision time
 * (approved_by stays null, so a rejection is distinguishable from an approval).
 * Returns the row, or `undefined` if unknown/not pending.
 */
export async function rejectCatalog(
  db: DbClient,
  id: string,
  now: Date,
): Promise<PricingCatalogRow | undefined> {
  const [rejected] = await db
    .update(pricingCatalogs)
    .set({ status: "rejected", approvedAt: now })
    .where(and(eq(pricingCatalogs.id, id), eq(pricingCatalogs.status, "pending")))
    .returning();
  return rejected ? toRow(rejected) : undefined;
}

/** Count catalogs awaiting approval — feeds the §20 catalog.update_requires_approval alert. */
export async function countPendingCatalogs(db: DbClient): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pricingCatalogs)
    .where(eq(pricingCatalogs.status, "pending"));
  return rows[0]?.n ?? 0;
}
