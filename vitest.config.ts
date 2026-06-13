import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";

// Load .env so integration tests see DATABASE_URL_TEST + ARCHIVE_ENCRYPTION_KEY.
// Unit tests don't need it; *.int.test.ts self-skip when DATABASE_URL_TEST is unset.
loadEnv({ path: fileURLToPath(new URL("./.env", import.meta.url)) });

// Alias the workspace packages to their TypeScript SOURCE (not built dist) so the
// suite runs straight from a clean checkout with no prior `tsc -b`. esbuild
// resolves the NodeNext-style ".js" import specifiers in source automatically.
export default defineConfig({
  resolve: {
    alias: {
      "@420ai/shared": fileURLToPath(
        new URL("./packages/shared/src/index.ts", import.meta.url),
      ),
      "@420ai/db": fileURLToPath(new URL("./packages/db/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
    globalSetup: "./vitest.global-setup.ts",
    // Integration suites share one test DB and TRUNCATE in beforeEach — run files
    // sequentially to avoid cross-file races.
    fileParallelism: false,
  },
});
