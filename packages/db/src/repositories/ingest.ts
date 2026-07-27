import type { IngestBatch, IngestResponse, ModelPricing } from "@420ai/shared";
import { computeCost } from "@420ai/shared";
import type { DbClient } from "../client.js";
import { encryptField } from "../crypto.js";
import { events, rawSourceRecords } from "../schema.js";
import { getMachineOrgId } from "./machines.js";

/**
 * Persist a batch idempotently, encrypting sensitive payloads at the write
 * boundary (PRD §18.1 + §23). Encryption happens HERE so no caller can bypass it.
 *
 * - raw_source_records: INSERT ... ON CONFLICT DO NOTHING on
 *   (machine_id, source_connector, source_record_id) — raw is sacred + per-machine.
 * - events: INSERT ... ON CONFLICT (fingerprint) DO UPDATE — the machine-independent
 *   fingerprint dedups the same logical event across machines.
 *
 * Wrapped in one transaction so a partial batch never lands.
 *
 * M15 15.1 tenancy: the org is DERIVED from `machines.org_id` inside the transaction
 * (D-M15-1), never passed in — the signature is unchanged for all 25 call sites and
 * an incorrect org is unrepresentable. See the D-M15-2 note on the conflict block.
 *
 * M15 15.3: the first parameter widened `Db` → `DbClient` so the route can call this INSIDE
 * `withOrg`. The `db.transaction()` below then nests as a SAVEPOINT and inherits the outer
 * transaction's `app.current_org`. The internal org derivation stays exactly as it is — it is
 * the D-M15-2 seam that makes a caller-supplied wrong org unrepresentable, and RLS is a
 * backstop for it, not a replacement.
 *
 * BEHAVIOUR CHANGE under RLS worth knowing: a CROSS-ORG converging ingest (org A ingesting a
 * fingerprint already owned by org B) now raises `new row violates row-level security policy`
 * instead of silently overwriting org B's `parser_version` / `tokens` / `cost` / `machine_id`
 * (spike 6 measured exactly that today). That is the slice working as intended; it is pinned
 * by a negative test in `rls.int.test.ts`, not caught-and-ignored.
 */
export async function ingestBatch(
  db: DbClient,
  machineId: string,
  batch: IngestBatch,
  /**
   * M10 3d: when an uploaded catalog is ACTIVE, the route passes it here and each
   * cost-bearing event is re-priced under it (going forward, D1/D2). Omitted (no
   * active catalog) → the wire cost/catalogVersion are stored verbatim (today's exact
   * behavior — zero ripple for every existing caller).
   */
  repricing?: { version: string; rates: Record<string, ModelPricing> },
): Promise<IngestResponse> {
  return db.transaction(async (tx) => {
    // M15 15.1: `machines.org_id` is the authority for every row this batch writes.
    const orgId = await getMachineOrgId(tx, machineId);
    if (!orgId) throw new Error(`unknown machine ${machineId}`);

    let recordsInserted = 0;
    for (const r of batch.records) {
      const enc = encryptField(r.payload);
      const inserted = await tx
        .insert(rawSourceRecords)
        .values({
          orgId,
          machineId,
          sourceConnector: r.sourceConnector,
          sessionId: r.sessionId,
          sourceRecordId: r.sourceRecordId,
          payloadCiphertext: enc.ciphertext,
          payloadIv: enc.iv,
          payloadTag: enc.tag,
        })
        .onConflictDoNothing({
          target: [
            rawSourceRecords.machineId,
            rawSourceRecords.sourceConnector,
            rawSourceRecords.sourceRecordId,
          ],
        })
        .returning({ id: rawSourceRecords.id });
      recordsInserted += inserted.length;
    }

    let eventsUpserted = 0;
    for (const e of batch.events) {
      // Event tool-call payload is arbitrary JSON → stringify then encrypt.
      const enc = e.payload !== undefined ? encryptField(JSON.stringify(e.payload)) : null;
      // M10 3d re-pricing (D2): re-price ONLY an event that already carries a cost AND
      // tokens AND model — shape-preserving (never ADDS a cost; usage.reported/message.*
      // pass through). Recompute cost under the active catalog + stamp its version.
      let cost = e.cost;
      let catalogVersion = e.catalogVersion;
      if (repricing && e.cost !== undefined && e.tokens && e.model) {
        cost = computeCost(e.model, e.tokens, repricing.rates);
        catalogVersion = repricing.version;
      }
      const upserted = await tx
        .insert(events)
        .values({
          fingerprint: e.fingerprint,
          orgId,
          sourceConnector: e.sourceConnector,
          parserVersion: e.parserVersion,
          catalogVersion,
          rawRecordId: e.rawRecordId,
          eventIndex: e.eventIndex,
          eventType: e.eventType,
          sessionId: e.sessionId,
          machineId,
          projectPath: e.projectPath,
          gitBranch: e.gitBranch,
          model: e.model,
          ts: e.ts,
          tokens: e.tokens,
          cost,
          payloadCiphertext: enc?.ciphertext ?? null,
          payloadIv: enc?.iv ?? null,
          payloadTag: enc?.tag ?? null,
        })
        .onConflictDoUpdate({
          target: events.fingerprint,
          set: {
            // M15 15.1 / D-M15-2: `orgId` is DELIBERATELY ABSENT from this set block.
            // The fingerprint is machine-independent, so the same logical event
            // ingested from two machines converges to ONE row — and if those machines
            // belonged to different orgs, including orgId here would silently flip an
            // existing row's owner, i.e. a cross-tenant write. Omitting it means the
            // FIRST writer's org wins and later ingests update only payload/parser/cost.
            // Pinned by `tenancy.int.test.ts`.
            parserVersion: e.parserVersion,
            // §23 replay re-stamp: a re-ingest updates catalog_version alongside
            // parser_version (omit this and a replay silently leaves it stale). The
            // re-priced cost/catalogVersion (D2) must land in BOTH paths or a replay
            // under the active catalog leaves a stale cost.
            catalogVersion: catalogVersion ?? null,
            machineId,
            tokens: e.tokens ?? null,
            cost: cost ?? null,
            payloadCiphertext: enc?.ciphertext ?? null,
            payloadIv: enc?.iv ?? null,
            payloadTag: enc?.tag ?? null,
          },
        })
        .returning({ fingerprint: events.fingerprint });
      eventsUpserted += upserted.length;
    }

    return { recordsInserted, eventsUpserted };
  });
}
