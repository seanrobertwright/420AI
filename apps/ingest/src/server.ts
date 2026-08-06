import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createDb, ensureUserByEmail, setUserPassword } from "@420ai/db";
import { buildApp } from "./app.js";
import { hashPassword } from "./password.js";
import { createAnalysisProvider, type AnalysisProviderConfig } from "./analysis/provider.js";
import { createWebhookDeliverer } from "./delivery/alert-deliverer.js";
import { createSmtpDeliverer, createFanoutDeliverer } from "./delivery/smtp-deliverer.js";
import { createMailer } from "./delivery/mailer.js";
import { createSsoProviders, type SsoConfig } from "./sso/provider.js";

// Load the repo-root .env (this runs from apps/ingest/ via npm -w).
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

// DATABASE_URL is the OWNER role. It is still read and still required — every db:* CLI
// (migrate, rollback, reprice, reparse, rotate-key) and the break-glass path use it. It is
// NOT what the server connects as.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");

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

// M16 16.6 background alert-evaluator cadence (INC-2026-07). This is the ONE caller that turns the
// evaluator on — `buildApp` defaults it to 0/disabled so no test starts a timer.
//
// SHIPPED WITH A REAL VALUE IN `.env.example`, never empty, and that is a trap worth naming: an
// empty `ALERT_EVALUATOR_INTERVAL_MS=` reaches `parsePositiveInt` as `""`, `Number("")` is `0`,
// and the guard below THROWS AT BOOT. It is the numeric sibling of the CLAUDE.md `??`-vs-`||` env
// rule — same class (a shipped-empty key defeating a fallback), different operator. The two
// existing interval keys (`MONITOR_STREAM_INTERVAL_MS=3000`, `HEARTBEAT_INTERVAL_MS=30000`) both
// ship populated for exactly this reason; copy them, not the empty-valued secrets.
const alertEvaluatorIntervalMs = parsePositiveInt(
  process.env.ALERT_EVALUATOR_INTERVAL_MS,
  "ALERT_EVALUATOR_INTERVAL_MS",
  60000,
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
// `||`, NEVER `??`, at all three sites below — same rule as RATE_LIMIT_WINDOW above and
// ANALYSIS_BASE_URL. `??` only falls through on null/undefined, and `.env.example` ships `SMTP_URL=`
// and `MAIL_FROM=` EMPTY. So under `??` the exact operator this fallback exists for — one who
// already sends alert email and pastes the new .env.example block — gets `"" ?? ALERT_SMTP_URL` ===
// `""`, a null mailer, and invites that silently stop being emailed while looking like a deliberate
// no-SMTP install. Found by the 15.5 review; do not "modernise" these back to `??`.
const smtpUrl = process.env.SMTP_URL || process.env.ALERT_SMTP_URL;
const mailFrom = process.env.MAIL_FROM || process.env.ALERT_EMAIL_FROM;
const mailer = createMailer(
  smtpUrl && mailFrom
    ? {
        url: smtpUrl,
        from: mailFrom,
        // `next dev`'s default port — apps/dashboard's script is a bare `next dev` with no -p.
        // `||` so an EMPTY APP_BASE_URL falls back rather than making every emailed link a bare path.
        appBaseUrl: process.env.APP_BASE_URL || "http://localhost:3000",
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

// M15 15.7 SSO (D-M15-5). A provider is configured only when BOTH halves are present; a client id
// with no secret is a half-configuration that would fail at the token exchange with an opaque 502,
// so it is treated as absent and reported once at boot.
//
// `||` NOT `??` on every one of these, per the SMTP_URL comment above: `.env.example` ships these
// keys with EMPTY values, and `""` is not null — `??` would hand an empty client id straight to
// Google, exactly the silent misconfiguration the mailer fallback was written to avoid.
const ssoTimeoutMs = parsePositiveInt(process.env.SSO_TIMEOUT_MS, "SSO_TIMEOUT_MS", 10000);
const ssoConfig: SsoConfig = {};
const googleClientId = process.env.SSO_GOOGLE_CLIENT_ID || "";
const googleClientSecret = process.env.SSO_GOOGLE_CLIENT_SECRET || "";
if (googleClientId && googleClientSecret) {
  ssoConfig.google = {
    clientId: googleClientId,
    clientSecret: googleClientSecret,
    timeoutMs: ssoTimeoutMs,
  };
} else if (googleClientId || googleClientSecret) {
  // THE REPORT THE COMMENT ABOVE PROMISES. It did not exist until review caught it, and its
  // absence was the whole harm: a half-configured provider is silently dropped, so the operator
  // sees no button, no error and a 404 from /start — the exact symptom of nothing being configured
  // at all, sending them to look everywhere except the one variable they missed.
  console.warn(
    "SSO_GOOGLE_CLIENT_ID / SSO_GOOGLE_CLIENT_SECRET: only one half is set — Google SSO is DISABLED.",
  );
}
const githubClientId = process.env.SSO_GITHUB_CLIENT_ID || "";
const githubClientSecret = process.env.SSO_GITHUB_CLIENT_SECRET || "";
if (githubClientId && githubClientSecret) {
  ssoConfig.github = {
    clientId: githubClientId,
    clientSecret: githubClientSecret,
    timeoutMs: ssoTimeoutMs,
  };
} else if (githubClientId || githubClientSecret) {
  console.warn(
    "SSO_GITHUB_CLIENT_ID / SSO_GITHUB_CLIENT_SECRET: only one half is set — GitHub SSO is DISABLED.",
  );
}
const ssoProviders = createSsoProviders(ssoConfig);

// D-15.7-7: SSO-driven account creation is its OWN flag, and off by default. STRICT equality for
// the same reason SELF_SIGNUP_ENABLED uses it — a typo (`SSO_SIGNUP_ENABLED=yes`) fails safe.
const ssoSignupEnabled = process.env.SSO_SIGNUP_ENABLED === "true";
if (ssoSignupEnabled) {
  // Entrypoint, so logging is in bounds (CLAUDE.md's boundary). Name the LIVE providers: "SSO
  // signup is on" is only actionable if the operator can see which identity sources it trusts.
  const live = Object.keys(ssoProviders);
  console.warn(
    live.length > 0
      ? `SSO_SIGNUP_ENABLED=true — anyone with a verified ${live.join("/")} account can create an account here.`
      : "SSO_SIGNUP_ENABLED=true but no SSO provider is configured — the flag has no effect.",
  );
}

// The `redirect_uri` handed to each provider is DERIVED from this (D-15.7-6), never from a
// request. It reuses the SAME APP_BASE_URL the mailer reads above rather than introducing a
// second base-URL variable — the two must agree or a login link and a reset link point at
// different hosts.
const appBaseUrl = process.env.APP_BASE_URL || "http://localhost:3000";

// The server's ONLY connection is the non-owner app role — there is no privileged handle
// anywhere in the request path (D-15.3-5: "the ingest server can never see across orgs").
const { db } = createDb(appDatabaseUrl);

// M15 15.2: seed the bootstrap admin IDENTITY unconditionally, BEFORE (and independently
// of) the password seed.
//
// M15 15.9 (D-M15-7) — THIS IS NOW THE WHOLE FIRST-RUN BOOTSTRAP, and it always was the part
// that mattered. `ADMIN_TOKEN` is retired: it seeded nothing, it only AUTHENTICATED as this
// user. What makes a fresh deployment reachable is this row plus `ADMIN_PASSWORD` below —
// log in as `ADMIN_EMAIL`, then mint an API key for each machine client from
// `POST /v1/auth/api-keys`.
//
// It stays unconditional rather than being folded into the password seed: `ensureUserByEmail`
// is idempotent and also runs `ensurePersonalOrg`, so an admin with no membership (which
// would fail closed at `resolvePrincipal`) is impossible by construction — and an operator
// who has not set `ADMIN_PASSWORD` yet must still get a coherent identity to attach one to.
await ensureUserByEmail(db, adminEmail);

// Seed the single admin's password (scrypt) from env. Idempotent: re-running on every boot
// re-hashes ADMIN_PASSWORD, so rotating it + restart re-seeds. If unset, login is disabled and
// M15 15.9 makes that total: NOTHING can authenticate, because the only remaining credentials are a
// session (which needs this password) and an API key (which can only be minted from a session).
// There is no service token any more. This is the whole first-run bootstrap — set it.
//
// M15 15.6 — THIS IS A CREDENTIAL CHANGE THAT DELIBERATELY DOES NOT REVOKE, and it is the one
// exception to the rule the other three follow (reset-confirm, password-change, member-removal all
// call `revokeAllSessions`). It cannot revoke here, because it cannot tell a ROTATION from a
// RESTART: scrypt re-salts on every call, so the freshly computed hash never equals the stored one
// and there is nothing to compare. An unconditional revoke would therefore sign the admin out of
// every device on every single boot — including a crash-loop restart.
//
// The consequence is real and is stated in `docs/guide/operations.md`: an operator rotating
// ADMIN_PASSWORD *because it leaked* must also call `POST /v1/auth/sessions/revoke-all`, or a
// stolen session token stays valid for the rest of its 7 days. Do not "fix" this by revoking here
// without first solving the rotation-vs-restart distinction.
if (adminPassword) {
  await setUserPassword(db, adminEmail, hashPassword(adminPassword));
} else {
  console.warn(
    "ADMIN_PASSWORD is not set — dashboard login disabled until it is (set it + restart).",
  );
}

const app = buildApp({
  db,
  adminEmail,
  sessionSecret,
  analysisProvider: createAnalysisProvider(analysisConfig),
  analysisMaxOutputTokens,
  monitorStreamIntervalMs,
  alertEvaluatorIntervalMs,
  logLevel,
  rateLimit,
  alertDeliverer,
  mailer,
  selfSignupEnabled,
  ssoProviders,
  ssoSignupEnabled,
  appBaseUrl,
});

await app.listen({ port: Number(process.env.INGEST_PORT ?? 8420), host: "0.0.0.0" });
