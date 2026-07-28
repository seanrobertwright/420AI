import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createDb, ensureUserByEmail, setUserPassword } from "@420ai/db";
import { buildApp } from "./app.js";
import { hashPassword } from "./password.js";
import { createAnalysisProvider, type AnalysisProviderConfig } from "./analysis/provider.js";
import { createWebhookDeliverer } from "./delivery/alert-deliverer.js";
import { createSmtpDeliverer, createFanoutDeliverer } from "./delivery/smtp-deliverer.js";
import { createMailer } from "./delivery/mailer.js";

// Load the repo-root .env (this runs from apps/ingest/ via npm -w).
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

// DATABASE_URL is the OWNER role. It is still read and still required — every db:* CLI
// (migrate, rollback, reprice, reparse, rotate-key) and the break-glass path use it. It is
// NOT what the server connects as.
const databaseUrl = process.env.DATABASE_URL;
const adminToken = process.env.ADMIN_TOKEN;
if (!databaseUrl) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
if (!adminToken) throw new Error("ADMIN_TOKEN is not set (copy .env.example to .env)");

// M15 15.3 (D-15.3-2) — HARD-FAIL without the app-role URL. RLS is inert against the owner
// role (`rolbypassrls`), so booting on DATABASE_URL would leave all 15 policies decorative
// while every health check stayed green. The failure mode of getting this wrong is SILENT
// cross-tenant over-disclosure — the repo's "skipped ≠ passed" shape — so it must be a
// startup throw, not a warning. Mirrors the DATABASE_URL / SESSION_SECRET throws above.
const appDatabaseUrl = process.env.DATABASE_URL_APP;
if (!appDatabaseUrl) {
  throw new Error(
    "DATABASE_URL_APP is not set — run `npm run db:provision-app-role` and set it. " +
      "Booting on the owner role leaves RLS inert (M15 15.3).",
  );
}

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
const analysisMaxOutputTokens = parsePositiveInt(
  process.env.ANALYSIS_MAX_OUTPUT_TOKENS,
  "ANALYSIS_MAX_OUTPUT_TOKENS",
  4096,
);
let analysisConfig: AnalysisProviderConfig | null = null;
if (analysisProviderName && analysisApiKey) {
  if (analysisProviderName !== "anthropic" && analysisProviderName !== "openai") {
    throw new Error(
      `ANALYSIS_PROVIDER must be "anthropic" or "openai" (got "${analysisProviderName}")`,
    );
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
// The login limit is the brute-force guard deferred from 12.3 and shipped here; the global
// limit is generous so the ingest hot path isn't throttled in normal single-user use.
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

// M12 12.6 / M13 13.5 alert delivery. Each channel is independently opt-in (mirrors
// ANALYSIS_PROVIDER): the firing row in the dashboard is the durable record; webhook + SMTP
// are convenience pushes. Both are composed into the single `alertDeliverer` slot via the
// fan-out (a child failing does not skip the other). Unset both → null → delivery disabled.
const alertWebhookUrl = process.env.ALERT_WEBHOOK_URL;
const webhookDeliverer = createWebhookDeliverer(
  alertWebhookUrl
    ? {
        url: alertWebhookUrl,
        timeoutMs: parsePositiveInt(
          process.env.ALERT_WEBHOOK_TIMEOUT_MS,
          "ALERT_WEBHOOK_TIMEOUT_MS",
          5000,
        ),
      }
    : null,
);
// SMTP is enabled only when the URL + from + to are ALL set (an incomplete config would send
// nowhere or fail per-delivery). ALERT_SMTP_URL is a nodemailer smtps://user:pass@host:port URL.
const alertSmtpUrl = process.env.ALERT_SMTP_URL;
const alertEmailFrom = process.env.ALERT_EMAIL_FROM;
const alertEmailTo = process.env.ALERT_EMAIL_TO;
const smtpDeliverer = createSmtpDeliverer(
  alertSmtpUrl && alertEmailFrom && alertEmailTo
    ? { url: alertSmtpUrl, from: alertEmailFrom, to: alertEmailTo }
    : null,
);
const alertDeliverer = createFanoutDeliverer([webhookDeliverer, smtpDeliverer]);

// M15 15.5 transactional mail (invites, password resets). Reuses 13.5's SMTP config when a
// dedicated one is not given, so an existing deployment gets invites with zero new env. Note this
// needs only URL + FROM — unlike the alert deliverer there is no fixed recipient; each message goes
// to the invitee or the account holder.
const smtpUrl = process.env.SMTP_URL ?? process.env.ALERT_SMTP_URL;
const mailFrom = process.env.MAIL_FROM ?? process.env.ALERT_EMAIL_FROM;
const mailer = createMailer(
  smtpUrl && mailFrom
    ? {
        url: smtpUrl,
        from: mailFrom,
        // `next dev`'s default port — apps/dashboard's script is a bare `next dev` with no -p.
        appBaseUrl: process.env.APP_BASE_URL ?? "http://localhost:3000",
      }
    : null,
);

// D-M15-6: invite-only is the default posture for EVERY deployment, self-hosted and hosted.
// STRICT equality — any value other than the literal "true" leaves signup closed, so a typo
// (`SELF_SIGNUP_ENABLED=yes`) fails safe rather than opening the box.
const selfSignupEnabled = process.env.SELF_SIGNUP_ENABLED === "true";
if (selfSignupEnabled) {
  // The warn belongs HERE and nowhere else: server.ts is an entrypoint (CLAUDE.md's logging
  // boundary — libraries throw, entrypoints log).
  console.warn(
    "SELF_SIGNUP_ENABLED=true — anyone who can reach this server can create an account.",
  );
}

// The server's ONLY connection is the non-owner app role — there is no privileged handle
// anywhere in the request path (D-15.3-5: "the ingest server can never see across orgs").
const { db } = createDb(appDatabaseUrl);

// M15 15.2: seed the bootstrap admin IDENTITY unconditionally, BEFORE (and independently
// of) the password seed. `resolvePrincipal` maps the ADMIN_TOKEN service token onto
// `adminEmail`'s user + org, so that row must exist for the service token to authorize at
// all — and D-15.2-3 promises the token behaves exactly as it did before this slice.
// Seeding this only alongside ADMIN_PASSWORD (as the password seed below does) would break
// every token-only deployment — desktop app, scripts/generate-reports.mjs — with a blanket
// 401. `ensureUserByEmail` is idempotent and also runs `ensurePersonalOrg`, so an admin
// without a membership (which would also fail closed) is impossible by construction.
await ensureUserByEmail(db, adminEmail);

// Seed the single admin's password (scrypt) from env. Idempotent: re-running on every boot
// re-hashes ADMIN_PASSWORD, so rotating it + restart re-seeds. If unset, login is disabled
// (admin has no hash → 401 for everyone) but the rest of the API still works via the service token.
if (adminPassword) {
  await setUserPassword(db, adminEmail, hashPassword(adminPassword));
} else {
  console.warn(
    "ADMIN_PASSWORD is not set — dashboard login disabled until it is (set it + restart).",
  );
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
  alertDeliverer,
  mailer,
  selfSignupEnabled,
});

await app.listen({ port: Number(process.env.INGEST_PORT ?? 8420), host: "0.0.0.0" });
