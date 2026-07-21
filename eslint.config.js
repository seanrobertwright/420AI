// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

/**
 * Flat ESLint config (ESLint 9). Lints the backend TypeScript sources only — the
 * dashboard (Next.js) carries its own `next lint`, and generated/build/vendored trees
 * are ignored. `eslint-config-prettier` is last so formatting rules defer to Prettier.
 * Non-type-checked recommended rules (fast, no tsconfig project graph needed in CI).
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "packages/db/drizzle/**",
      "apps/dashboard/**", // owns `next lint`
      "apps/desktop/src-tauri/target/**",
      "**/*.min.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // The codebase intentionally uses non-null assertions in tests + post-query rows
      // (documented invariants) and occasional `any` at wire boundaries — keep these as
      // warnings, not errors, so the gate stays green while still surfacing them.
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow `let x; closure-reads-x; x = …` — a const can't be read before its initializer
      // (the abortableDelay timer + setInterval-handle pattern legitimately needs `let`).
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      // `_`-prefixed args/vars are the repo's intentional-unused convention (e.g. `_req`).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The browser extension (apps/extension) is plain JS loaded unpacked, OUT of the root
    // tsc graph (like apps/dashboard/desktop). It runs in the MV3 service-worker + options
    // contexts, so it needs the browser + webextension (`chrome`) globals, not Node's.
    files: ["apps/extension/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  prettier,
);
