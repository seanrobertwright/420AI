import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir, hostname as osHostname } from "node:os";
import { join, dirname } from "node:path";
import { parseClaudeCodeSession } from "./connectors/claude-code.js";
import { SqliteStore } from "./store/sqlite-store.js";
import { renderSessionReport } from "./report/session-report.js";
import { postPair, postIngest } from "./ingest-client.js";
import {
  toEventPayload,
  type IngestBatch,
  type PairResponse,
  type IngestResponse,
} from "@420ai/shared";

const DEFAULT_DB = "./420ai.sqlite";

/** Where `pair` persists the issued ingest credentials for later `push`. */
const CREDENTIALS_PATH = join(homedir(), ".420ai", "credentials.json");

interface Credentials {
  url: string;
  token: string;
  machineId: string;
}

function saveCredentials(creds: Credentials): void {
  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true });
  // mode 0o600 (owner-only) where the platform honors it.
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
}

function loadCredentials(): Credentials | undefined {
  if (!existsSync(CREDENTIALS_PATH)) return undefined;
  try {
    return JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8")) as Credentials;
  } catch {
    return undefined;
  }
}

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
}): Promise<PairResponse> {
  const res = await postPair(opts.url, {
    code: opts.code,
    machine: { name: opts.name, os: opts.os, hostname: opts.hostname },
  });
  if (opts.persist !== false) {
    saveCredentials({ url: opts.url, token: res.token, machineId: res.machineId });
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
    records: parsed.rawRecords.map((r) => ({
      sourceConnector: r.sourceConnector,
      sessionId: r.sessionId,
      sourceRecordId: r.id,
      payload: r.payload,
      ingestedAt: r.ingestedAt,
    })),
    events: parsed.events.map(toEventPayload),
  };
  return postIngest(opts.url, opts.token, batch);
}

// --- CLI plumbing (the ONLY place allowed to log / exit / write files) ---

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(dbPath: string): string {
  const lines = [
    "collector — AI session intelligence (Milestone 2)",
    "",
    "Usage:",
    "  collector ingest <file> [--db <path>]",
    "  collector report <sessionId> [--db <path>] [--out <file>]",
    "  collector pair <code> --url <baseUrl> [--name <n>] [--os <os>] [--hostname <h>]",
    "  collector push <file> [--url <baseUrl>] [--token <token>]",
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

  process.stdout.write(usage(dbPath) + "\n");
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
    process.stderr.write(`Error: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
