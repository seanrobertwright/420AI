#!/usr/bin/env node
/**
 * setup-env — non-interactive `.env` generator (M13 13.6, PRD §19 step 1 "guided setup").
 *
 *   node scripts/setup-env.mjs        # or: npm run setup
 *
 * Copies `.env.example` → `.env`, filling the secrets a fresh clone must generate itself:
 *   - ARCHIVE_ENCRYPTION_KEY  (32 raw bytes, base64 — the AES-256-GCM field key, crypto.ts)
 *   - SESSION_SECRET          (32 bytes, base64url — the login-cookie HMAC key, 12.3)
 *   - APP_DB_PASSWORD         (24 bytes, base64url — the M15 15.3 RLS app-role password)
 * DATABASE_URL keeps the .env.example dev default; ADMIN_PASSWORD stays blank (login opt-in).
 *
 * M15 15.3: APP_DB_PASSWORD is also substituted into the `<password>` placeholder inside
 * DATABASE_URL_APP and DATABASE_URL_TEST_APP, so `npm run setup` yields an env the server can
 * actually boot on (it HARD-FAILS without DATABASE_URL_APP, D-15.3-2). The URLs keep their
 * host/port from `.env.example` — that file stays the single source for those. The generated
 * password still has to be applied to the database once: `npm run db:provision-app-role`.
 * base64url on purpose — the value is embedded in a URL, so `+` and `/` would need escaping.
 *
 * It ALSO writes `apps/dashboard/.env.local` with the SAME SESSION_SECRET when that file is
 * absent — the dashboard loads env from its own cwd, and a mismatched secret fails every login
 * cookie verification (the D.3 UAT bug). It REFUSES to overwrite an existing `.env` (the A.1 UAT
 * footgun) — delete it first to regenerate.
 *
 * Library note: this file is import-safe. The functions below are pure/testable; only the
 * `import.meta.url === argv[1]` guard at the bottom performs I/O + prints (the entrypoint).
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

/** The server-boot-required keys (mirrors ingest server.ts) — assertBootValid checks these. */
// M15 15.9 (D-M15-7) dropped ADMIN_TOKEN: the server no longer reads it, so requiring it here
// would fail a perfectly valid `.env` — and generating one would hand an operator a credential
// that authenticates nothing. Machine clients now use API keys minted at runtime.
export const REQUIRED_KEYS = ["DATABASE_URL", "DATABASE_URL_APP", "SESSION_SECRET"];

/** Generate the secrets the server + dashboard need to boot (the only non-default values). */
export function generateSecrets() {
  return {
    // AES-256-GCM field key: 32 raw bytes, base64 (crypto.ts decodes base64, not base64url).
    archiveKey: randomBytes(32).toString("base64"),
    // HMAC secret: url-safe so it pastes into shells/URLs without escaping.
    sessionSecret: randomBytes(32).toString("base64url"),
    // M15 15.3 app-role password. base64url because it is embedded in a postgres:// URL.
    appDbPassword: randomBytes(24).toString("base64url"),
  };
}

/**
 * Replace the first `KEY=<anything-or-empty>` whole line with `KEY=value`. Anchored to `^KEY=`
 * so a longer sibling (`ARCHIVE_ENCRYPTION_KEYS=`) is never matched. Throws if the key is absent
 * so a drift in `.env.example` is caught loudly, never silently no-op'd. The replacement is a
 * FUNCTION so a `$` in the value is inserted literally (String.replace treats `$&`/`$1` specially).
 */
export function fillKey(content, key, value) {
  const re = new RegExp(`^${key}=.*$`, "m");
  if (!re.test(content)) throw new Error(`.env.example is missing the ${key}= line`);
  return content.replace(re, () => `${key}=${value}`);
}

/**
 * Substitute the literal `<password>` placeholder (M15 15.3 — it appears in DATABASE_URL_APP
 * and DATABASE_URL_TEST_APP) with the generated app-role password. Throws when absent so a
 * drift in `.env.example` is caught loudly, matching `fillKey`'s contract. A plain global
 * `split`/`join` rather than `replace` with a regex: the password is base64url and could
 * otherwise be misread as a `$`-replacement pattern.
 */
export function fillPasswordPlaceholder(content, value) {
  if (!content.includes("<password>")) {
    throw new Error(".env.example is missing the <password> placeholder");
  }
  return content.split("<password>").join(value);
}

/** Build the `.env` and dashboard `.env.local` contents from the example + secrets (pure). */
export function buildEnvFiles(exampleContent, secrets) {
  let env = exampleContent;
  env = fillKey(env, "ARCHIVE_ENCRYPTION_KEY", secrets.archiveKey);
  env = fillKey(env, "SESSION_SECRET", secrets.sessionSecret);
  env = fillKey(env, "APP_DB_PASSWORD", secrets.appDbPassword);
  // Must run AFTER the APP_DB_PASSWORD fill: it rewrites the `<password>` placeholders in
  // DATABASE_URL_APP / DATABASE_URL_TEST_APP to the SAME value, so the URLs and the password
  // the provisioning CLI applies can never disagree.
  env = fillPasswordPlaceholder(env, secrets.appDbPassword);
  // The dashboard loads env from ITS OWN cwd (apps/dashboard), so it needs its own file.
  // SESSION_SECRET MUST equal the ingest value or every login cookie fails verification (D.3).
  const dashboardEnv =
    "# Generated by `npm run setup` (scripts/setup-env.mjs). The dashboard's server-side proxy\n" +
    "# config — the browser never holds a credential. SESSION_SECRET MUST equal the repo-root\n" +
    "# .env value (the middleware verifies the login cookie with it). Never expose it via NEXT_PUBLIC_*.\n" +
    "INGEST_URL=http://localhost:8420\n" +
    `SESSION_SECRET=${secrets.sessionSecret}\n`;
  return { env, dashboardEnv };
}

/** Assert every server-boot-required key has a non-empty value in the produced `.env`. */
export function assertBootValid(envContent) {
  const missing = REQUIRED_KEYS.filter((k) => !new RegExp(`^${k}=\\S`, "m").test(envContent));
  if (missing.length) {
    throw new Error(`generated .env is missing a value for: ${missing.join(", ")}`);
  }
}

/**
 * Generate `.env` (+ dashboard `.env.local`) from `.env.example` under `cwd`. Refuses to
 * overwrite an existing `.env`; leaves an existing dashboard `.env.local` untouched (warns to
 * verify its SESSION_SECRET). Returns which files were written. Throws (never exits) — the
 * entrypoint guard catches and prints, per the library/process boundary.
 */
export function setupEnv({ cwd, log = () => {} }) {
  const examplePath = join(cwd, ".env.example");
  const envPath = join(cwd, ".env");
  const dashboardEnvPath = join(cwd, "apps", "dashboard", ".env.local");

  if (!existsSync(examplePath)) {
    throw new Error(`.env.example not found at ${examplePath} (run from the repo root)`);
  }
  if (existsSync(envPath)) {
    throw new Error(
      `.env already exists at ${envPath} — refusing to overwrite. Delete it first to regenerate.`,
    );
  }

  const secrets = generateSecrets();
  const { env, dashboardEnv } = buildEnvFiles(readFileSync(examplePath, "utf8"), secrets);
  assertBootValid(env);

  writeFileSync(envPath, env, { mode: 0o600 });
  log(`wrote ${envPath} (filled ARCHIVE_ENCRYPTION_KEY, SESSION_SECRET, APP_DB_PASSWORD)`);

  const written = [envPath];
  if (existsSync(dashboardEnvPath)) {
    log(
      `skipped ${dashboardEnvPath} (already exists) — ensure its SESSION_SECRET matches the new .env`,
    );
  } else {
    mkdirSync(dirname(dashboardEnvPath), { recursive: true });
    writeFileSync(dashboardEnvPath, dashboardEnv, { mode: 0o600 });
    log(`wrote ${dashboardEnvPath} (matching SESSION_SECRET)`);
    written.push(dashboardEnvPath);
  }
  return { written, envPath, dashboardEnvPath };
}

// --- Entrypoint (the only I/O + stdout site; libraries above stay pure) ------------------
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { written } = setupEnv({ cwd: process.cwd(), log: (m) => console.log(m) });
    console.log("\nsetup complete. Next steps:");
    console.log("  1. npm run db:up && npm run db:migrate");
    console.log("  2. npm run db:provision-app-role   (M15 15.3 — the RLS app role)");
    console.log("  3. npm run ingest:dev       (in one terminal)");
    console.log("  4. npm run dashboard:dev    (in another) → http://localhost:3000");
    console.log("  Full walkthrough: docs/guide/quickstart.md");
    if (written.length === 1) {
      console.log(
        "\nNote: apps/dashboard/.env.local already existed — confirm its SESSION_SECRET matches .env.",
      );
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
