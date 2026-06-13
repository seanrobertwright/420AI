import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Single root config covering both workspaces.
//
// We alias @420ai/shared to its TypeScript SOURCE (not the built dist) so the
// suite runs straight from a clean checkout with no prior `tsc -b` — `npm
// install && npx vitest run` works without a build step. esbuild resolves the
// NodeNext-style ".js" import specifiers in source automatically.
export default defineConfig({
  resolve: {
    alias: {
      "@420ai/shared": fileURLToPath(
        new URL("./packages/shared/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
  },
});
