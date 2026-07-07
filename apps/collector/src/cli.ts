import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hostname as osHostname, homedir } from "node:os";
import { parseClaudeCodeSession } from "./connectors/claude-code.js";
import { connectors as defaultConnectors } from "./connectors/connector.js";
import { loadRegistry } from "./connectors/registry.js";
import {
  fetchActiveConnectorCatalog,
  loadCachedConnectorCatalog,
  saveCachedConnectorCatalog,
} from "./connectors/connector-catalog-cache.js";
import { CUSTOM_CONNECTOR_CONFIG_PATH } from "./connectors/custom-connector.js";
import { discoverWorkspaces } from "./discovery/discover-engine.js";
import { SqliteStore } from "./store/sqlite-store.js";
import { renderSessionReport } from "./report/session-report.js";
import {
  postPair,
  postIngest,
  postDiscover,
  postGit,
  getProjects,
  isUnauthorized,
  type ProjectListItem,
} from "./ingest-client.js";
import {
  captureGitCommits,
  chunkCommitsBySize,
  GIT_POST_MAX_BYTES,
} from "./discovery/git-capture.js";
import {
  CREDENTIALS_PATH,
  QUEUE_PATH,
  credentialsPathFor,
  queuePathFor,
  loadCredentials,
  saveCredentials,
  requireCredentials,
  NotPairedError,
  type Credentials,
} from "./identity.js";
import { QueueStore, type QueueStats, type SyncOutcome } from "./queue/queue-store.js";
import { runCaptureEngine } from "./capture-engine.js";
import { syncOnce } from "./sync/sync-worker.js";
import {
  toEventPayload,
  toRawRecordPayload,
  type IngestBatch,
  type PairResponse,
  type IngestResponse,
  type DiscoverResponse,
  type GitCaptureResponse,
} from "@420ai/shared";

const DEFAULT_DB = "./420ai.sqlite";

export interface IngestSummary {
  records: number;
  events: number;
  skippedLines: number;
  sessionId?: string;
}

/**
 * Ingest one Claude Code session file into the store. Returns a summary.
 * Pure of process concerns (no exit/log) so it is testable.
 */
export function runIngest(file: string, dbPath = DEFAULT_DB): IngestSummary {
  if (!existsSync(file)) {
    throw new Error(`File not found: ${file}`);
  }
  const text = readFileSync(file, "utf8");
  const parsed = parseClaudeCodeSession(text);
  const store = new SqliteStore(dbPath);
  try {
    store.insertRawRecords(parsed.rawRecords);
    store.upsertEvents(parsed.events);
  } finally {
    store.close();
  }
  return {
    records: parsed.rawRecords.length,
    events: parsed.events.length,
    skippedLines: parsed.skippedLines,
    sessionId: parsed.sessionId,
  };
}

/** Render a stored session to Markdown. Throws if the session has no events. */
export function runReport(sessionId: string, dbPath = DEFAULT_DB): string {
  const store = new SqliteStore(dbPath);
  try {
    const events = store.getSessionEvents(sessionId);
    if (events.length === 0) {
      throw new Error(`No events for session ${sessionId}`);
    }
    return renderSessionReport(events);
  } finally {
    store.close();
  }
}

/**
 * Pair this machine with the archive: redeem a code, register the machine, and
 * receive a revocable ingest token. Persists credentials unless persist:false.
 */
export async function runPair(opts: {
  url: string;
  code: string;
  name: string;
  os?: string;
  hostname?: string;
  persist?: boolean;
  /** Persist under this home's `.420ai` instead of the OS home (mirrors `watch --home`). */
  home?: string;
}): Promise<PairResponse> {
  const res = await postPair(opts.url, {
    code: opts.code,
    machine: { name: opts.name, os: opts.os, hostname: opts.hostname },
  });
  if (opts.persist !== false) {
    saveCredentials(
      { url: opts.url, token: res.token, machineId: res.machineId },
      credentialsPathFor(opts.home ?? homedir()),
    );
  }
  return res;
}

/**
 * Push an already-parsed Claude Code session to the ingest API. Reuses the M1
 * parser verbatim and maps its ParseResult onto the ingest wire batch.
 */
export async function runPush(opts: {
  file: string;
  url: string;
  token: string;
}): Promise<IngestResponse> {
  if (!existsSync(opts.file)) {
    throw new Error(`File not found: ${opts.file}`);
  }
  const text = readFileSync(opts.file, "utf8");
  const parsed = parseClaudeCodeSession(text);
  const batch: IngestBatch = {
    records: parsed.rawRecords.map(toRawRecordPayload),
    events: parsed.events.map(toEventPayload),
  };
  return postIngest(opts.url, opts.token, batch);
}

/**
 * Resolve credentials from explicit overrides or the saved pairing under `home` (default: the OS
 * home). `home` lets a Windows service read the paired user's `credentials.json` even when its own
 * account's `homedir()` points elsewhere.
 */
function resolveCreds(opts: { url?: string; token?: string; home?: string }): Credentials {
  const credsPath = credentialsPathFor(opts.home ?? homedir());
  const saved = loadCredentials(credsPath);
  const url = opts.url ?? saved?.url;
  const token = opts.token ?? saved?.token;
  if (!url || !token) {
    // Surface the canonical not-paired guidance.
    return requireCredentials(credsPath);
  }
  return { url, token, machineId: saved?.machineId ?? "unknown" };
}

/**
 * Run the background capture agent: discover + tail Claude sessions, buffer to
 * the durable queue, sync to the archive. Resolves when `signal` aborts (SIGINT)
 * after a graceful final drain. Pure of process concerns except via callbacks.
 */
export async function runWatch(opts: {
  url?: string;
  token?: string;
  intervalMs?: number;
  queuePath?: string;
  home?: string;
  signal: AbortSignal;
  logger?: (msg: string) => void;
  /** M9: collector version (read from package.json at the entrypoint) — enables heartbeats. */
  collectorVersion?: string;
  /** M9: heartbeat cadence override (ms). */
  heartbeatIntervalMs?: number;
}): Promise<void> {
  const creds = resolveCreds(opts);
  const home = opts.home ?? homedir();
  // M12 12.7c: best-effort pull of the active signed connector catalog → cache it.
  // Offline-first: a failed pull (offline / 204 / bad signature) falls back to the
  // cached catalog, then the bundled baseline (loadRegistry with no catalog ⇒
  // byte-identical to today). Never blocks capture; the helper never throws.
  const fetched = await fetchActiveConnectorCatalog({ baseUrl: creds.url, token: creds.token });
  if (fetched) {
    saveCachedConnectorCatalog(fetched);
    opts.logger?.(`connector catalog ${fetched.version} pulled and cached`);
  }
  const cachedCatalog = loadCachedConnectorCatalog();
  // Merge built-ins + valid custom connectors (M10-S2), then overlay the signed catalog.
  // The plain CLI must merge too, else `collector watch` would capture only the built-ins
  // while `serve` did both. Surface any dropped (invalid/colliding) defs through the logger.
  const { connectors, dropped } = loadRegistry(home, { catalog: cachedCatalog?.payload });
  for (const d of dropped) opts.logger?.(`custom connector "${d.id}" dropped: ${d.reason}`);
  await runCaptureEngine({
    creds,
    signal: opts.signal,
    intervalMs: opts.intervalMs,
    // Keep the queue beside the credentials under the SAME home (else a --home run would read creds
    // from the user profile but queue under the service account — a split-brain backlog).
    queuePath: opts.queuePath ?? queuePathFor(home),
    home,
    logger: opts.logger,
    collectorVersion: opts.collectorVersion,
    heartbeatIntervalMs: opts.heartbeatIntervalMs,
    connectors,
  });
}

export interface SyncRunResult {
  stats: QueueStats;
  /**
   * Final drain outcome: "ok" = fully delivered (queue empty); "retry" = archive unreachable / 5xx;
   * "stop" = token revoked (re-pair needed). Anything other than "ok" with items still pending means
   * the sync did NOT succeed — the caller must NOT report "complete" (C.11: a network failure used to
   * print "Sync complete." with exit 0 while the whole backlog sat undelivered).
   */
  outcome: SyncOutcome;
}

/**
 * One-shot drain of the durable queue to the archive (testable / ops). Recovers any inflight items,
 * then drains until empty or a non-"ok" outcome. Returns final stats AND the final outcome so the
 * caller can distinguish a real completion from a network/auth failure (C.11).
 */
export async function runSync(opts: {
  url?: string;
  token?: string;
  queuePath?: string;
  /** Collector home override (mirrors `watch --home`) — resolves creds + queue under one profile. */
  home?: string;
  /** Injectable ingest client for tests; defaults to the real fetch-based postIngest. */
  post?: typeof postIngest;
}): Promise<SyncRunResult> {
  const creds = resolveCreds(opts);
  const queue = new QueueStore(opts.queuePath ?? queuePathFor(opts.home ?? homedir()));
  try {
    queue.recoverInflight();
    let outcome = await syncOnce({ queue, url: creds.url, token: creds.token, post: opts.post });
    while (outcome === "ok" && queue.stats().pending > 0) {
      outcome = await syncOnce({ queue, url: creds.url, token: creds.token, post: opts.post });
    }
    return { stats: queue.stats(), outcome };
  } finally {
    queue.close();
  }
}

/** Print queue backlog/stats. */
export function runQueueStatus(queuePath = QUEUE_PATH): QueueStats {
  const queue = new QueueStore(queuePath);
  try {
    return queue.stats();
  } finally {
    queue.close();
  }
}

export interface DiscoverSummary {
  response: DiscoverResponse;
  /** Roots found but not resolvable to a real path (e.g. Gemini hash-only). */
  unresolved: number;
}

/**
 * One-shot discovery (M5): enumerate every connector's project roots, enrich with
 * git metadata + the Gemini reverse-map, and POST them to the archive. Uses the
 * MACHINE token (discovery is machine-scoped, like ingest). Pure of process
 * concerns — `main()` prints the summary.
 */
export async function runDiscover(opts: {
  url?: string;
  token?: string;
  home?: string;
}): Promise<DiscoverSummary> {
  const creds = resolveCreds(opts);
  const home = opts.home ?? homedir();
  // Custom connectors omit `discoverRoots` (D7), so the discovery sweep skips them
  // cleanly; merging keeps the built-ins identical and is future-proof.
  const { connectors } = loadRegistry(home);
  const { workspaces, unresolved } = await discoverWorkspaces({ connectors, home });
  const response = await postDiscover(creds.url, creds.token, { workspaces });
  return { response, unresolved };
}

export interface CustomConnectorSummary {
  id: string;
  /** "jsonl" | "regex" — derived from the connector's captureMethod. */
  format: string;
  status: string;
  watchGlobs: string[];
}

export interface CustomInspectResult {
  connectors: CustomConnectorSummary[];
  dropped: { id: string; reason: string }[];
}

/**
 * Read-only inspection (D9): load + validate `~/.420ai/custom-connectors.json` and
 * summarize each user-defined connector plus any dropped (invalid/colliding) defs.
 * Authoring the JSON is done by hand / the desktop UI — the CLI does not write it.
 * Pure of process concerns — `main()` prints the summary.
 */
export function runCustom(opts: { home?: string; customPath?: string } = {}): CustomInspectResult {
  const home = opts.home ?? homedir();
  const { connectors, dropped } = loadRegistry(
    home,
    opts.customPath ? { customPath: opts.customPath } : undefined,
  );
  const builtinIds = new Set(defaultConnectors.map((c) => c.id));
  const summaries = connectors
    .filter((c) => !builtinIds.has(c.id))
    .map((c) => ({
      id: c.id,
      format: c.fidelity.captureMethod.replace("custom-tail-", ""),
      status: c.fidelity.status,
      watchGlobs: c.watchGlobs(home),
    }));
  return { connectors: summaries, dropped };
}

export interface GitSummary {
  response: GitCaptureResponse;
  /** Distinct repo roots scanned this sweep. */
  reposScanned: number;
  /** Repos whose history exceeded the read cap (more commits exist — re-run / raise cap). */
  capped: number;
}

/**
 * One-shot git capture (M10): enumerate every connector's repo roots, read each
 * repo's `git log`, and POST the commits to the archive. Uses the MACHINE token
 * (git capture is machine-scoped, like ingest). Pure of process concerns —
 * `main()` prints the summary. Idempotent server-side (SHA dedup).
 */
export async function runGit(opts: {
  url?: string;
  token?: string;
  home?: string;
}): Promise<GitSummary> {
  const creds = resolveCreds(opts);
  const { commits, reposScanned, capped } = await captureGitCommits({
    connectors: defaultConnectors,
    home: opts.home ?? homedir(),
  });
  // C.6: POST in size-bounded chunks. One mega-body for a large history exceeded the server's body
  // limit and the connection was reset (ECONNRESET). `/v1/git` is idempotent by SHA, so summing
  // commitsInserted across chunks is exact.
  let commitsInserted = 0;
  for (const batch of chunkCommitsBySize(commits, GIT_POST_MAX_BYTES)) {
    const res = await postGit(creds.url, creds.token, { commits: batch });
    commitsInserted += res.commitsInserted;
  }
  return { response: { commitsInserted }, reposScanned, capped };
}

/**
 * List the archive's projects (M5). ADMIN-authed — pass `--token <adminToken>`
 * (discovery uses the machine token; this CRUD surface is admin-gated).
 */
export async function runProjects(opts: {
  url?: string;
  token?: string;
}): Promise<ProjectListItem[]> {
  const creds = resolveCreds(opts);
  const { projects } = await getProjects(creds.url, creds.token);
  return projects;
}

// --- CLI plumbing (the ONLY place allowed to log / exit / write files) ---

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * The collector home for this invocation: an explicit `--home` wins, else the OS home. Centralized so
 * every command agrees. The footgun it removes: a Windows SERVICE under LocalSystem has a `homedir()`
 * of `…\config\systemprofile` — passing `--home C:\Users\<you>` points credentials, the queue, and the
 * connector session globs at the real paired profile instead. Exported for unit testing.
 */
export function resolveHome(args: string[]): string {
  return getFlag(args, "--home") ?? homedir();
}

export function parseHeartbeatIntervalMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The collector's own version, read from its package.json at the entrypoint (M9 heartbeat).
 * Libraries stay silent/pure — the version is resolved HERE and passed into runWatch.
 */
function readCollectorVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function usage(dbPath: string): string {
  const lines = [
    "collector — AI session intelligence (Milestone 3)",
    "",
    "Usage:",
    "  collector ingest <file> [--db <path>]",
    "  collector report <sessionId> [--db <path>] [--out <file>]",
    "  collector pair <code> --url <baseUrl> [--name <n>] [--os <os>] [--hostname <h>]",
    "  collector push <file> [--url <baseUrl>] [--token <token>]",
    "  collector watch [--url <baseUrl>] [--token <token>] [--interval <ms>] [--home <dir>]",
    "  collector sync [--url <baseUrl>] [--token <token>] [--home <dir>]",
    "  collector queue [--home <dir>]",
    "  collector discover [--url <baseUrl>] [--token <token>] [--home <dir>]",
    "  collector git [--url <baseUrl>] [--token <token>] [--home <dir>]",
    "  collector projects [--url <baseUrl>] [--token <adminToken>]",
    "  collector custom",
    "",
    "  --home <dir>  Collector home root (default: your OS home). Repoints credentials, the durable",
    "                queue, and the session globs at <dir>/.420ai + <dir>/.claude|.codex|.gemini.",
    "                Use it when running as a Windows service whose account home isn't your profile.",
    "",
    `Default DB: ${dbPath}`,
    `Credentials: ${CREDENTIALS_PATH} (written by 'pair', read by 'push')`,
  ];
  if (existsSync(dbPath)) {
    try {
      const store = new SqliteStore(dbPath);
      const sessions = store.listSessions();
      store.close();
      if (sessions.length) {
        lines.push("", "Stored sessions:");
        for (const s of sessions) {
          lines.push(`  ${s.sessionId}  (${s.model ?? "?"}, ${s.eventCount} events)`);
        }
      }
    } catch {
      /* ignore db read issues in help */
    }
  }
  return lines.join("\n");
}

async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  const command = args[0];
  const dbPath = getFlag(args, "--db") ?? DEFAULT_DB;

  if (command === "ingest") {
    const file = args[1];
    if (!file) throw new Error("ingest requires a <file> argument");
    const summary = runIngest(file, dbPath);
    process.stdout.write(
      `Ingested ${summary.records} records, ${summary.events} events ` +
        `(${summary.skippedLines} skipped) for session ${summary.sessionId ?? "(unknown)"}\n`,
    );
    return;
  }

  if (command === "report") {
    const sessionId = args[1];
    if (!sessionId) throw new Error("report requires a <sessionId> argument");
    const md = runReport(sessionId, dbPath);
    const out = getFlag(args, "--out");
    if (out) {
      writeFileSync(out, md, "utf8");
      process.stdout.write(`Wrote report to ${out}\n`);
    } else {
      process.stdout.write(md + "\n");
    }
    return;
  }

  if (command === "pair") {
    const code = args[1];
    if (!code) throw new Error("pair requires a <code> argument");
    const url = getFlag(args, "--url");
    if (!url) throw new Error("pair requires --url <baseUrl>");
    const res = await runPair({
      url,
      code,
      name: getFlag(args, "--name") ?? osHostname(),
      os: getFlag(args, "--os") ?? process.platform,
      hostname: getFlag(args, "--hostname") ?? osHostname(),
      home: resolveHome(args),
    });
    process.stdout.write(
      `Paired. machineId=${res.machineId}\n` +
        `Ingest token (store securely): ${res.token}\n` +
        `Saved credentials to ${CREDENTIALS_PATH}\n`,
    );
    return;
  }

  if (command === "push") {
    const file = args[1];
    if (!file) throw new Error("push requires a <file> argument");
    const creds = loadCredentials();
    const url = getFlag(args, "--url") ?? creds?.url;
    const token = getFlag(args, "--token") ?? creds?.token;
    if (!url) throw new Error("push requires --url <baseUrl> (or a saved pairing)");
    if (!token) throw new Error("push requires --token <token> (or a saved pairing)");
    const res = await runPush({ file, url, token });
    process.stdout.write(
      `Pushed ${res.recordsInserted} new records, ${res.eventsUpserted} events upserted\n`,
    );
    return;
  }

  if (command === "watch") {
    const intervalFlag = getFlag(args, "--interval");
    const intervalMs = intervalFlag ? Number(intervalFlag) : undefined;
    const controller = new AbortController();
    let stopping = false;
    process.on("SIGINT", () => {
      if (stopping) return;
      stopping = true;
      process.stdout.write("\nStopping… (graceful drain)\n");
      controller.abort();
    });
    process.stdout.write("watching… Ctrl-C to stop\n");
    const heartbeatFlag =
      getFlag(args, "--heartbeat-interval") ?? process.env.HEARTBEAT_INTERVAL_MS;
    await runWatch({
      url: getFlag(args, "--url"),
      token: getFlag(args, "--token"),
      intervalMs,
      home: resolveHome(args),
      signal: controller.signal,
      logger: (msg) => process.stdout.write(msg + "\n"),
      collectorVersion: readCollectorVersion(),
      heartbeatIntervalMs: parseHeartbeatIntervalMs(heartbeatFlag),
    });
    process.exit(0);
  }

  if (command === "sync") {
    const { stats, outcome } = await runSync({
      url: getFlag(args, "--url"),
      token: getFlag(args, "--token"),
      home: resolveHome(args),
    });
    if (outcome === "ok") {
      process.stdout.write(`Sync complete. pending=${stats.pending}, inflight=${stats.inflight}\n`);
    } else {
      // C.11: a non-"ok" outcome means nothing (or not everything) was delivered — say so, and exit
      // non-zero so scripts/users can tell. The durable queue keeps the items for the next run.
      const reason =
        outcome === "stop"
          ? "token revoked — re-pair with `collector pair <code> --url <baseUrl>`"
          : "archive unreachable";
      process.stderr.write(`Sync incomplete (${reason}). ${stats.pending} item(s) still queued.\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "queue") {
    const stats = runQueueStatus(queuePathFor(resolveHome(args)));
    process.stdout.write(`pending=${stats.pending}, inflight=${stats.inflight}\n`);
    return;
  }

  if (command === "discover") {
    const { response, unresolved } = await runDiscover({
      url: getFlag(args, "--url"),
      token: getFlag(args, "--token"),
      home: resolveHome(args),
    });
    process.stdout.write(
      `Discovered ${response.workspacesUpserted} workspaces, created ${response.projectsCreated} projects` +
        ` (${unresolved} unattributed — e.g. Gemini hash-only sessions)\n`,
    );
    for (const m of response.mappings) {
      process.stdout.write(`  ${m.projectName}  ← ${m.projectKey}\n`);
    }
    return;
  }

  if (command === "git") {
    const { response, reposScanned, capped } = await runGit({
      url: getFlag(args, "--url"),
      token: getFlag(args, "--token"),
      home: resolveHome(args),
    });
    process.stdout.write(
      `Captured ${response.commitsInserted} new commit(s) across ${reposScanned} repo(s)` +
        (capped > 0 ? ` (${capped} capped — run again or raise the cap)` : "") +
        "\n",
    );
    return;
  }

  if (command === "projects") {
    let projects: ProjectListItem[];
    try {
      projects = await runProjects({
        url: getFlag(args, "--url"),
        token: getFlag(args, "--token"),
      });
    } catch (err) {
      // `projects` is admin-gated (the saved pairing is a MACHINE token); make
      // the most common misuse actionable instead of a bare HTTP 401.
      if (isUnauthorized(err)) {
        throw new Error(
          "projects is admin-gated — pass --token <adminToken> (the saved pairing is a machine token)",
        );
      }
      throw err;
    }
    if (projects.length === 0) {
      process.stdout.write("No projects yet — run `collector discover` first.\n");
      return;
    }
    for (const p of projects) {
      process.stdout.write(`  ${p.id}  ${p.name}  ${p.gitRemote ?? "(no remote)"}\n`);
    }
    return;
  }

  if (command === "custom") {
    const { connectors, dropped } = runCustom();
    if (connectors.length === 0) {
      process.stdout.write("No custom connectors configured.\n");
    } else {
      process.stdout.write(`${connectors.length} custom connector(s):\n`);
      for (const c of connectors) {
        process.stdout.write(
          `  ${c.id}  (format ${c.format}, status ${c.status}, ${c.watchGlobs.length} glob(s))\n`,
        );
      }
    }
    for (const d of dropped) {
      process.stdout.write(`  dropped ${d.id}: ${d.reason}\n`);
    }
    process.stdout.write(`Config: ${CUSTOM_CONNECTOR_CONFIG_PATH}\n`);
    return;
  }

  process.stdout.write(usage(dbPath) + "\n");
}

/**
 * Map an error to a user-facing CLI message. Node's global `fetch` throws a bare `TypeError: fetch
 * failed` (with `cause.code` like ECONNREFUSED) when the archive is unreachable — opaque to a user.
 * Surface it as an actionable "archive unreachable" hint instead (C.6: a stopped ingest server printed
 * only "Error: fetch failed", giving no clue the server was down). Pure + exported for testing.
 */
export function formatCliError(error: unknown): string {
  if (error instanceof NotPairedError) return error.message;
  const err = error as { message?: string; cause?: { code?: string } };
  const code = err?.cause?.code;
  const NETWORK = new Set(["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]);
  if (err?.message === "fetch failed" || (code !== undefined && NETWORK.has(code))) {
    return `Could not reach the archive${code ? ` (${code})` : ""}. Is the ingest server running and the --url correct?`;
  }
  return `Error: ${err?.message ?? String(error)}`;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv).catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exit(1);
  });
}
