import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { createDb } from "./client.js";

/**
 * Apply all generated migrations from packages/db/drizzle against the given
 * connection. Used by the migrate CLI and by the vitest global setup. Idempotent:
 * drizzle tracks applied migrations in __drizzle_migrations, so re-runs are safe.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const { db, pool } = createDb(connectionString);
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}
