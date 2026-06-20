import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createDb } from "./client.js";
import { reencryptAll } from "./repositories/key-rotation.js";

// M12 12.4e — re-encrypt every encrypted row under the ACTIVE keyring key. Entrypoint
// MIRROR of migrate-cli.ts: load the repo-root .env, read DATABASE_URL, run, report counts.
// REQUIRES keyring mode (ARCHIVE_ENCRYPTION_KEYS + ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID); back up
// first and keep the OLD key in the ring until this completes (see docs/guide/operations.md).
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
}

const { db, pool } = createDb(url);
try {
  const counts = await reencryptAll(db);
  console.log(
    `re-encrypted under the active key: raw_source_records=${counts.rawSourceRecords}, ` +
      `events=${counts.events}, git_commits=${counts.gitCommits}`,
  );
} finally {
  await pool.end();
}
