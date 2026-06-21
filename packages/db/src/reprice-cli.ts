import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createDb } from "./client.js";
import { getActiveCatalog } from "./repositories/pricing-catalogs.js";
import { repriceAll } from "./repositories/reprice.js";

// M12 12.5a — retroactively re-price the archive under the ACTIVE catalog. Entrypoint MIRROR
// of rotate-key-cli.ts. Back up first (docs/guide/operations.md). Requires an active catalog.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
}

const { db, pool } = createDb(url);
let message: string;
try {
  const active = await getActiveCatalog(db);
  if (!active) {
    throw new Error("no active catalog to re-price under (approve one first)");
  }
  const { repriced, catalogVersion } = await repriceAll(db, active);
  message = `re-priced ${repriced} events under catalog ${catalogVersion}`;
} finally {
  await pool.end();
}
console.log(message);
