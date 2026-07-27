import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { APP_ROLE_NAME } from "./org-context.js";
import { provisionAppRole } from "./provision-app-role.js";

// M15 15.3 — grant LOGIN + a password to the app role migration 0015 creates NOLOGIN.
// Entrypoint MIRROR of migrate-cli.ts / rollback-cli.ts: load the repo-root .env, read env,
// throw if missing, run the engine, report + exit. Re-running is the password ROTATION path.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
}

const password = process.env.APP_DB_PASSWORD;
if (!password) {
  throw new Error(
    "APP_DB_PASSWORD is not set — choose a password for the app role and add it to .env, " +
      `then point DATABASE_URL_APP at postgres://${APP_ROLE_NAME}:<password>@<host>/<db>`,
  );
}

await provisionAppRole(url, password);
// Secret-free by design: never print the password or a URL containing it.
console.log(`provisioned app role: ${APP_ROLE_NAME} (LOGIN enabled)`);
