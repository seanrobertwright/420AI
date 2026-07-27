import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createDb } from "./client.js";
import { getActiveCatalog } from "./repositories/pricing-catalogs.js";
import { listOrganizations } from "./repositories/organizations.js";
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
    // M15 15.3 — one pass PER ORG, mirroring POST /v1/replay/reparse (D-15.3-5). Owner
    // connection ⇒ RLS is bypassed, so `reparseAll`'s explicit org predicate is what scopes
    // each pass. Counts sum across orgs; the reported totals match the pre-15.3 behaviour.
    reparse: async (repricing) => {
      const orgs = await listOrganizations(db);
      const totals = {
        sessions: 0,
        eventsUpserted: 0,
        orphansDeleted: 0,
        skipped: { gemini: 0, other: 0 },
      };
      for (const org of orgs) {
        const c = await reparseAll(db, org.id, { repricing });
        totals.sessions += c.sessions;
        totals.eventsUpserted += c.eventsUpserted;
        totals.orphansDeleted += c.orphansDeleted;
        totals.skipped.gemini += c.skipped.gemini;
        totals.skipped.other += c.skipped.other;
      }
      return totals;
    },
  });
} finally {
  await pool.end();
}
(outcome.exitCode === 0 ? process.stdout : process.stderr).write(outcome.message + "\n");
process.exitCode = outcome.exitCode;
