import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>["db"];

/** A transaction handle (the arg drizzle passes to `db.transaction(cb)`). */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Either the pool-backed client or a transaction — repository query functions
 * accept this so they compose inside `db.transaction()` (atomic pairing) or run
 * standalone. Only the top-level `ingestBatch` needs `Db` (it opens the tx).
 */
export type DbClient = Db | Tx;

/**
 * Create a Drizzle client backed by a node-postgres Pool. Callers own the pool
 * and must `.end()` it when done (the migrate runner and tests do).
 */
export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  const db = drizzle({ client: pool, schema });
  return { db, pool };
}
