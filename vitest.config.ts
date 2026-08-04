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
      // ── SUBPATH ALIASES FIRST. Vite matches aliases IN ORDER and takes the first hit, so these
      // must precede the bare `@420ai/shared` key or that key swallows them: `@420ai/shared/roles`
      // would be rewritten to `packages/shared/src/index.ts/roles`, which does not exist.
      //
      // They exist for the reason the block below states — resolve to SOURCE, so the suite runs
      // from a clean checkout with no prior `tsc -b`. The package's own `exports` map points at
      // `dist/`, so without these a subpath import only works after a build. Browser bundles
      // (`typecheck:dashboard` / `next build`) resolve through `exports` and are unaffected.
      //
      // The `/roles` entry has no importing test today (`team-view.tsx` is a component, and the
      // dashboard has no component-test lane) — it is here so the next `src/lib/*.test.ts` that
      // reaches for it does not have to rediscover this.
      "@420ai/shared/outcome-labels": fileURLToPath(
        new URL("./packages/shared/src/outcome-labels.ts", import.meta.url),
      ),
      "@420ai/shared/roles": fileURLToPath(
        new URL("./packages/shared/src/roles.ts", import.meta.url),
      ),
      "@420ai/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      "@420ai/db": fileURLToPath(new URL("./packages/db/src/index.ts", import.meta.url)),
      // The dashboard uses the `@/*` → `apps/dashboard/src/*` path alias (its tsconfig
      // `paths`); vitest resolves via Vite aliases, not tsconfig paths, so mirror it here so
      // dashboard `*.test.ts` that pull in `@/`-importing source (e.g. lib/proxy.ts → @/lib/ingest)
      // resolve. Safe beside `@420ai/*`: @rollup/plugin-alias requires a `/` right after the key,
      // and `@420ai/...` has `4` there, so `@` only matches `@/...`.
      "@": fileURLToPath(new URL("./apps/dashboard/src", import.meta.url)),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
    globalSetup: "./vitest.global-setup.ts",
    // Integration suites share one test DB and TRUNCATE in beforeEach — run files
    // sequentially to avoid cross-file races.
    fileParallelism: false,
  },
});
