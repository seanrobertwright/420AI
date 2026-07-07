import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createDb } from "./client.js";
import { getActiveCatalog } from "./repositories/pricing-catalogs.js";
import { repriceAll } from "./repositories/reprice.js";
import { runReprice, type RepriceOutcome } from "./reprice-run.js";

// M12 12.5a — retroactively re-price the archive under the ACTIVE catalog. Entrypoint MIRROR
// of rotate-key-cli.ts. Back up first (docs/guide/operations.md). Requires an active catalog.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
}

const { db, pool } = createDb(url);
let outcome: RepriceOutcome;
try {
  // No active catalog is a CLEAN refusal (F.5), not a crash — runReprice returns a friendly message
  // + non-zero exit instead of throwing an uncaught stack trace.
  outcome = await runReprice({
    getActive: () => getActiveCatalog(db),
    reprice: (active) => repriceAll(db, active),
  });
} finally {
  await pool.end();
}
(outcome.exitCode === 0 ? process.stdout : process.stderr).write(outcome.message + "\n");
process.exitCode = outcome.exitCode;
