import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { rollbackLast } from "./rollback.js";

// M12 12.4f — roll back the latest-applied migration. Entrypoint MIRROR of migrate-cli.ts:
// load the repo-root .env, read DATABASE_URL, run the engine, report + exit. DESTRUCTIVE —
// the runbook (docs/guide/operations.md) makes "back up first" the precondition.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
}

const downDir = fileURLToPath(new URL("../drizzle/down", import.meta.url));
const journalPath = fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url));
const result = await rollbackLast(url, { downDir, journalPath });
if (result.rolledBack !== null) {
  console.log(`rolled back: ${result.rolledBack}`);
} else {
  console.error(`nothing rolled back: ${result.reason}`);
  process.exit(1);
}
