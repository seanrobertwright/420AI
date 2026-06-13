import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migrate.js";

// Load the repo-root .env (this CLI runs from packages/db/ via npm -w).
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
}

await runMigrations(url);
