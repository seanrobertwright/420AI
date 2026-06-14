import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createDb } from "@420ai/db";
import { buildApp } from "./app.js";
import { createAnalysisProvider, type AnalysisProviderConfig } from "./analysis/provider.js";

// Load the repo-root .env (this runs from apps/ingest/ via npm -w).
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const databaseUrl = process.env.DATABASE_URL;
const adminToken = process.env.ADMIN_TOKEN;
if (!databaseUrl) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
if (!adminToken) throw new Error("ADMIN_TOKEN is not set (copy .env.example to .env)");

// Build the real analysis provider from env. If ANALYSIS_PROVIDER/ANALYSIS_API_KEY
// are unset, pass null → a notConfigured provider: the server still boots and all
// M1–M7 endpoints work; only POST …/interpretations returns 503 (D9).
const analysisProviderName = process.env.ANALYSIS_PROVIDER;
const analysisApiKey = process.env.ANALYSIS_API_KEY;
const analysisMaxOutputTokens = Number(process.env.ANALYSIS_MAX_OUTPUT_TOKENS ?? 4096);
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
    maxOutputTokens: analysisMaxOutputTokens,
    timeoutMs: Number(process.env.ANALYSIS_TIMEOUT_MS ?? 60000),
  };
}

const { db } = createDb(databaseUrl);
const app = buildApp({
  db,
  adminToken,
  analysisProvider: createAnalysisProvider(analysisConfig),
  analysisMaxOutputTokens,
});

await app.listen({ port: Number(process.env.INGEST_PORT ?? 8420), host: "0.0.0.0" });
