#!/usr/bin/env node
/**
 * generate-reports — OS-cron scheduled report generation (M13 13.6, PRD §15/§19 step 13).
 *
 *   node scripts/generate-reports.mjs [--types <csv|all>] [--project <uuid|all>]
 *   # or: npm run reports:generate -- --types project.efficiency --project <uuid>
 *
 * There is NO in-server scheduler (docs/guide/operations.md is explicit — the server owns no
 * background dispatch). This is the script the OS scheduler runs: it walks every project
 * (`GET /v1/projects`) and POSTs one report of each requested type (`POST /v1/projects/:id/reports`)
 * using an API KEY — the machine/service credential as of M15 15.9 (D-M15-7), which is exactly the
 * machine-to-machine path it exists for. Generation is NON-idempotent by design: each run appends
 * a new versioned artifact, so history is preserved.
 *
 * M15 15.9 RETIRED `ADMIN_TOKEN` (D-M15-7). It was shared, un-attributable, un-revocable and
 * always `owner` — so this script, which only needs to POST reports, held full ownership of the
 * deployment. Mint a key instead (`POST /v1/auth/api-keys`, or Settings → API keys) at the LOWEST
 * rung that works, put it in `API_KEY`, and revoke it on its own if the cron host is ever
 * compromised. A key minted at `member` is enough for this script.
 *
 * Reads INGEST_URL + API_KEY from the environment. Every request is timeout-bounded
 * (AbortSignal.timeout, 30 s) so a stalled ingest can never hang the scheduled job. Prints one
 * line per artifact and exits non-zero if ANY call fails (so a cron wrapper can alert).
 *
 * Library note: import-safe — the pure helpers are exported/testable; only the entrypoint guard
 * at the bottom performs network I/O + prints.
 */
import { pathToFileURL } from "node:url";

/** The six project-scoped report types (session.autopsy is session-scoped — out of this sweep). */
export const PROJECT_REPORT_TYPES = [
  "project.cost_over_time",
  "project.tool_model_comparison",
  "project.failed_tool_calls",
  "project.context_waste",
  "project.efficiency",
  "project.trend_anomalies",
];

const TIMEOUT_MS = 30_000;

/** Parse `--types <csv|all>` and `--project <uuid|all>` (no deps). Throws on an unknown flag. */
export function parseArgs(args) {
  let types = "all";
  let project = "all";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--types") {
      types = args[++i];
      if (types === undefined)
        throw new Error("--types requires a value (csv of report types, or 'all')");
    } else if (a === "--project") {
      project = args[++i];
      if (project === undefined)
        throw new Error("--project requires a value (a project uuid, or 'all')");
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return { types, project };
}

/** Resolve `--types` to a concrete, validated list of known project report types. */
export function resolveReportTypes(typesArg) {
  if (typesArg === "all") return [...PROJECT_REPORT_TYPES];
  const requested = typesArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (requested.length === 0)
    throw new Error("--types is empty (want a csv of report types, or 'all')");
  const unknown = requested.filter((t) => !PROJECT_REPORT_TYPES.includes(t));
  if (unknown.length) {
    throw new Error(
      `unknown report type(s): ${unknown.join(", ")}\nknown: ${PROJECT_REPORT_TYPES.join(", ")}`,
    );
  }
  return requested;
}

/** First 200 chars of a response body for an error line (best-effort; never throws). */
async function safeText(res) {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

async function fetchProjectIds(baseUrl, headers) {
  const res = await fetch(`${baseUrl}/v1/projects?limit=200`, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET /v1/projects → HTTP ${res.status} ${await safeText(res)}`);
  const body = await res.json();
  return (body.projects ?? []).map((p) => p.id);
}

async function main(args, env) {
  const baseUrl = (env.INGEST_URL ?? "").replace(/\/+$/, "");
  // `||`, NEVER `??` (CLAUDE.md, a shipped 15.5 bug). `.env.example` ships keys with EMPTY values,
  // so `env.API_KEY ?? ...` evaluates to `""` for exactly the operator who pasted the new block and
  // has not filled it in — which would then fail as an opaque 401 at the first request instead of
  // as the actionable message below.
  const apiKey = env.API_KEY || "";
  if (!baseUrl) throw new Error("INGEST_URL is not set");
  if (!apiKey) {
    // NAME THE MIGRATION rather than falling back to `ADMIN_TOKEN`. A fallback would have been
    // right during 15.9's Phase B, while both credentials worked; after Phase C the server accepts
    // no `ADMIN_TOKEN` at all, so falling back to one would turn a fixable configuration problem
    // into an unexplained 401 on a scheduled job nobody is watching.
    throw new Error(
      env.ADMIN_TOKEN
        ? "API_KEY is not set. ADMIN_TOKEN was RETIRED in M15 15.9 and authenticates nothing — " +
            "mint an API key (Settings → API keys, or POST /v1/auth/api-keys) and set API_KEY."
        : "API_KEY is not set",
    );
  }

  const { types, project } = parseArgs(args);
  const reportTypes = resolveReportTypes(types);
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

  const projectIds = project === "all" ? await fetchProjectIds(baseUrl, headers) : [project];
  if (projectIds.length === 0) {
    console.log("no projects to report on");
    return 0;
  }

  let generated = 0;
  let failures = 0;
  for (const projectId of projectIds) {
    for (const type of reportTypes) {
      try {
        const res = await fetch(`${baseUrl}/v1/projects/${projectId}/reports`, {
          method: "POST",
          headers,
          body: JSON.stringify({ type }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
          failures++;
          console.error(
            `FAIL ${type} project=${projectId} → HTTP ${res.status} ${await safeText(res)}`,
          );
          continue;
        }
        const row = await res.json();
        generated++;
        console.log(
          `ok   ${type} project=${projectId} → artifact ${row.id} (${row.reportVersion ?? "?"})`,
        );
      } catch (err) {
        failures++;
        console.error(
          `FAIL ${type} project=${projectId} → ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  console.log(
    `\n${generated} report(s) generated, ${failures} failure(s) across ${projectIds.length} project(s)`,
  );
  return failures > 0 ? 1 : 0;
}

// --- Entrypoint (the only network I/O + stdout site) --------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
