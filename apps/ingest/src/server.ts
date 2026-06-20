import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createDb, setUserPassword } from "@420ai/db";
import { buildApp } from "./app.js";
import { hashPassword } from "./password.js";
import { createAnalysisProvider, type AnalysisProviderConfig } from "./analysis/provider.js";

// Load the repo-root .env (this runs from apps/ingest/ via npm -w).
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const databaseUrl = process.env.DATABASE_URL;
const adminToken = process.env.ADMIN_TOKEN;
if (!databaseUrl) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
if (!adminToken) throw new Error("ADMIN_TOKEN is not set (copy .env.example to .env)");

// M12 12.3 admin login config. ADMIN_EMAIL defaults to the legacy single-user address
// (back-compat with every legacy-default-seeded row). SESSION_SECRET is required — it signs
// session tokens AND must be shared with the dashboard middleware (which verifies them).
const adminEmail = process.env.ADMIN_EMAIL ?? "seanrobertwright@gmail.com";
const sessionSecret = process.env.SESSION_SECRET;
const adminPassword = process.env.ADMIN_PASSWORD;
if (!sessionSecret) throw new Error("SESSION_SECRET is not set (copy .env.example to .env)");

function parsePositiveInt(raw: string | undefined, name: string, defaultValue: number): number {
  if (raw === undefined) return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  }
  return n;
}

// Build the real analysis provider from env. If ANALYSIS_PROVIDER/ANALYSIS_API_KEY
// are unset, pass null → a notConfigured provider: the server still boots and all
// M1–M7 endpoints work; only POST …/interpretations returns 503 (D9).
const analysisProviderName = process.env.ANALYSIS_PROVIDER;
const analysisApiKey = process.env.ANALYSIS_API_KEY;
const analysisMaxOutputTokens = parsePositiveInt(process.env.ANALYSIS_MAX_OUTPUT_TOKENS, "ANALYSIS_MAX_OUTPUT_TOKENS", 4096);
let analysisConfig: AnalysisProviderConfig | null = null;
if (analysisProviderName && analysisApiKey) {
  if (analysisProviderName !== "anthropic" && analysisProviderName !== "openai") {
    throw new Error(`ANALYSIS_PROVIDER must be "anthropic" or "openai" (got "${analysisProviderName}")`);
  }
  analysisConfig = {
    provider: analysisProviderName,
    apiKey: analysisApiKey,
    model: process.env.ANALYSIS_MODEL ?? "claude-sonnet-4-6",
    baseUrl: process.env.ANALYSIS_BASE_URL || undefined,
    timeoutMs: parsePositiveInt(process.env.ANALYSIS_TIMEOUT_MS, "ANALYSIS_TIMEOUT_MS", 60000),
  };
}

// M9 SSE push cadence for GET /v1/monitor/stream (default 3000 in buildApp).
const monitorStreamIntervalMs = parsePositiveInt(
  process.env.MONITOR_STREAM_INTERVAL_MS,
  "MONITOR_STREAM_INTERVAL_MS",
  3000,
);

// M12 12.4b structured-logging level (pino: trace|debug|info|warn|error|fatal).
const logLevel = process.env.LOG_LEVEL ?? "info";

// M12 12.4c rate limiting. ON by default (RATE_LIMIT_ENABLED=false is the escape hatch).
// The login limit is the brute-force guard 12.3 deferred; the global limit is generous so
// the ingest hot path isn't throttled in normal single-user use.
const rateLimitEnabled = process.env.RATE_LIMIT_ENABLED !== "false";
const rateLimit = rateLimitEnabled
  ? {
      global: {
        max: parsePositiveInt(process.env.RATE_LIMIT_GLOBAL_MAX, "RATE_LIMIT_GLOBAL_MAX", 1000),
        // `||` (not `??`) so an empty-string env falls back to the default, like ANALYSIS_BASE_URL.
        timeWindow: process.env.RATE_LIMIT_WINDOW || "1 minute",
      },
      login: {
        max: parsePositiveInt(process.env.RATE_LIMIT_LOGIN_MAX, "RATE_LIMIT_LOGIN_MAX", 10),
        timeWindow: process.env.RATE_LIMIT_LOGIN_WINDOW || "15 minutes",
      },
    }
  : undefined;

const { db } = createDb(databaseUrl);

// Seed the single admin's password (scrypt) from env. Idempotent: re-running on every boot
// re-hashes ADMIN_PASSWORD, so rotating it + restart re-seeds. If unset, login is disabled
// (admin has no hash → 401 for everyone) but the rest of the API still works via the service token.
if (adminPassword) {
  await setUserPassword(db, adminEmail, hashPassword(adminPassword));
} else {
  console.warn("ADMIN_PASSWORD is not set — dashboard login disabled until it is (set it + restart).");
}

const app = buildApp({
  db,
  adminToken,
  adminEmail,
  sessionSecret,
  analysisProvider: createAnalysisProvider(analysisConfig),
  analysisMaxOutputTokens,
  monitorStreamIntervalMs,
  logLevel,
  rateLimit,
});

await app.listen({ port: Number(process.env.INGEST_PORT ?? 8420), host: "0.0.0.0" });
