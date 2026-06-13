import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

// Load the repo-root .env — drizzle-kit runs this from packages/db/ (npm -w),
// so the default cwd-relative dotenv lookup would miss it.
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

export default defineConfig({
  out: "./drizzle",
  schema: "./src/schema.ts",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
