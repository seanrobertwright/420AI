import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseClaudeCodeSession } from "./connectors/claude-code.js";
import { SqliteStore } from "./store/sqlite-store.js";
import { renderSessionReport } from "./report/session-report.js";

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

// --- CLI plumbing (the ONLY place allowed to log / exit / write files) ---

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(dbPath: string): string {
  const lines = [
    "collector — AI session intelligence (Milestone 1)",
    "",
    "Usage:",
    "  collector ingest <file> [--db <path>]",
    "  collector report <sessionId> [--db <path>] [--out <file>]",
    "",
    `Default DB: ${dbPath}`,
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

function main(argv: string[]): void {
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
  try {
    main(process.argv);
  } catch (error) {
    process.stderr.write(`Error: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
