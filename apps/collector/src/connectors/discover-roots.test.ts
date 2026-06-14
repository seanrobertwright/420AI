import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverClaudeRoots, parseClaudeCodeSession } from "./claude-code.js";
import { discoverCodexRoots, parseCodexSession } from "./codex-cli.js";
import { discoverGeminiRoots, parseGeminiSession } from "./gemini-cli.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "discover-roots-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const p = join(home, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}

describe("connector discoverRoots ⇄ parse projectPath invariant (D2)", () => {
  it("Claude: discoverRoots projectKey === parse's projectPath (raw cwd, byte-for-byte)", async () => {
    const CWD = "C:\\Users\\seanr\\OneDrive\\Documents\\420AI";
    const line = JSON.stringify({
      type: "user",
      sessionId: "sess-1",
      cwd: CWD,
      gitBranch: "m5-project-mapping",
      timestamp: "2026-06-14T10:00:00.000Z",
      message: { role: "user", content: "hi" },
    });
    write(join(".claude", "projects", "slug", "sess.jsonl"), line + "\n");

    const roots = await discoverClaudeRoots(home);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.projectKey).toBe(CWD);
    expect(roots[0]!.gitBranch).toBe("m5-project-mapping");

    // the SAME string the parser stamps on event.projectPath
    const parsed = parseClaudeCodeSession(line);
    const evt = parsed.events.find((e) => e.projectPath !== undefined);
    expect(evt!.projectPath).toBe(roots[0]!.projectKey);
  });

  it("Codex: discoverRoots projectKey === parse's projectPath (session_meta cwd)", async () => {
    const CWD = "/home/seanr/work/420ai";
    const meta = JSON.stringify({
      type: "session_meta",
      timestamp: "2026-06-14T10:00:00.000Z",
      payload: { type: "session_meta", id: "sess-c", cwd: CWD, git: { branch: "main" } },
    });
    const msg = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-06-14T10:00:01.000Z",
      payload: { type: "user_message", message: "hi" },
    });
    write(join(".codex", "sessions", "2026", "06", "14", "rollout-1.jsonl"), meta + "\n" + msg + "\n");

    const roots = await discoverCodexRoots(home);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.projectKey).toBe(CWD);
    expect(roots[0]!.gitBranch).toBe("main");

    const parsed = parseCodexSession(meta + "\n" + msg);
    const evt = parsed.events.find((e) => e.projectPath !== undefined);
    expect(evt!.projectPath).toBe(roots[0]!.projectKey);
  });

  it("Gemini: discoverRoots projectKey === parse's projectPath (projectHash = dir name)", async () => {
    const HASH = "2025fdb554a6deadbeef";
    const REAL = "c:\\users\\seanr\\onedrive\\documents\\420ai";
    const session = JSON.stringify({
      sessionId: "sess-g",
      projectHash: HASH,
      startTime: "2026-06-14T10:00:00.000Z",
      lastUpdated: "2026-06-14T10:00:05.000Z",
      messages: [{ id: "m1", type: "user", content: "hi" }],
    });
    write(join(".gemini", "tmp", HASH, "chats", "session-1.json"), session);
    write(join(".gemini", "tmp", HASH, ".project_root"), REAL);

    const roots = await discoverGeminiRoots(home);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.projectKey).toBe(HASH); // the join key is the hash
    expect(roots[0]!.rootPath).toBe(REAL); // resolved via sidecar

    const parsed = parseGeminiSession(session);
    const evt = parsed.events.find((e) => e.projectPath !== undefined);
    expect(evt!.projectPath).toBe(roots[0]!.projectKey);
  });

  it("Gemini: a session dir with no .project_root sidecar is unresolved (rootPath absent)", async () => {
    const HASH = "legacy-hash-only";
    const session = JSON.stringify({
      sessionId: "sess-g2",
      projectHash: HASH,
      messages: [{ id: "m1", type: "user", content: "hi" }],
    });
    write(join(".gemini", "tmp", HASH, "chats", "session-1.json"), session);
    // NO .project_root sidecar

    const roots = await discoverGeminiRoots(home);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.projectKey).toBe(HASH);
    expect(roots[0]!.rootPath).toBeUndefined();
  });
});
