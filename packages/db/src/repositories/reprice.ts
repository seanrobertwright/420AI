import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { computeCost, type ModelPricing } from "@420ai/shared";
import type { Db } from "../client.js";
import { events } from "../schema.js";

/** Batch size for the select→update sweep (mirrors key-rotation.ts BATCH). */
const BATCH = 500;

export interface RepriceResult {
  repriced: number;
  catalogVersion: string;
}

/**
 * M12 12.5a — retroactively re-price every cost-bearing event under `catalog`. The
 * going-forward path (ingestBatch D2) only reprices events as they (re-)ingest; this
 * applies an approved catalog to the EXISTING archive. Pure data pass over `events`:
 * no decrypt, no re-parse, fingerprint untouched, no schema change.
 *
 * Predicate MIRRORS ingestBatch's D2 guard exactly (cost+tokens+model present → recompute;
 * never ADDS a cost — usage.reported/message.* pass through). The `catalog_version IS
 * DISTINCT FROM` skip makes it idempotent AND advances the batched loop (an updated row
 * stamps the active version → no longer matches → not re-selected → loop terminates).
 * IS DISTINCT FROM (NOT `<>`) is REQUIRED so rows with NULL catalog_version — events
 * captured before replay-metadata existed — are INCLUDED. Spike-proven (see plan NOTES).
 */
export async function repriceAll(
  db: Db,
  catalog: { version: string; rates: Record<string, ModelPricing> },
): Promise<RepriceResult> {
  const repriced = await db.transaction(async (tx) => {
    let count = 0;
    for (;;) {
      const rows = await tx
        .select({ fingerprint: events.fingerprint, model: events.model, tokens: events.tokens })
        .from(events)
        .where(
          and(
            isNotNull(events.cost),
            isNotNull(events.tokens),
            isNotNull(events.model),
            sql`${events.catalogVersion} IS DISTINCT FROM ${catalog.version}`,
          ),
        )
        .orderBy(asc(events.fingerprint))
        .limit(BATCH);
      if (rows.length === 0) break;
      for (const r of rows) {
        // WHERE guards non-null tokens/model; `!` / `?? undefined` narrow for TS.
        const cost = computeCost(r.model ?? undefined, r.tokens!, catalog.rates);
        await tx
          .update(events)
          .set({ cost, catalogVersion: catalog.version })
          .where(eq(events.fingerprint, r.fingerprint));
        count += 1;
      }
    }
    return count;
  });
  return { repriced, catalogVersion: catalog.version };
}
