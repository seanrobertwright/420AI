import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createDb } from "./client.js";
import { getActiveCatalog } from "./repositories/pricing-catalogs.js";
import { reparseAll } from "./repositories/reparse.js";
import { runReparse, type ReparseOutcome } from "./reparse-run.js";

// M13 13.3 — re-parse the archive's raw records under the CURRENT parsers (12.5b).
// Entrypoint MIRROR of reprice-cli.ts. Back up first (docs/guide/operations.md).
// An active pricing catalog is optional (present → the upsert re-prices under it).
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
}

const { db, pool } = createDb(url);
let outcome: ReparseOutcome;
try {
  outcome = await runReparse({
    getActive: () => getActiveCatalog(db),
    reparse: (repricing) => reparseAll(db, { repricing }),
  });
} finally {
  await pool.end();
}
(outcome.exitCode === 0 ? process.stdout : process.stderr).write(outcome.message + "\n");
process.exitCode = outcome.exitCode;
