import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectors } from "./connector.js";
import { CLAUDE_CODE_CONNECTOR } from "./claude-code.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));

describe("connector registry", () => {
  const claude = connectors.find((c) => c.id === CLAUDE_CODE_CONNECTOR);

  it("contains the claude-code connector", () => {
    expect(claude).toBeDefined();
  });

  it("declares streaming liveness + stable fidelity fields (PRD §10.3)", () => {
    expect(claude!.fidelity.status).toBe("stable");
    expect(claude!.fidelity.liveness).toBe("streaming");
    expect(claude!.fidelity.captureMethod).toBe("tail-jsonl");
    expect(claude!.fidelity.tokens).toBe("exact");
    expect(Array.isArray(claude!.fidelity.knownGaps)).toBe(true);
  });

  it("expands watchGlobs against the given home", () => {
    const globs = claude!.watchGlobs("/home/u").map((g) => g.replace(/\\/g, "/"));
    expect(globs.some((g) => g.endsWith(".claude/projects/*/*.jsonl"))).toBe(true);
    expect(globs.some((g) => g.includes("/home/u"))).toBe(true);
  });

  it("parse() reuses the M1 parser and yields events from the fixture", () => {
    const text = readFileSync(FIXTURE, "utf8");
    const result = claude!.parse(text);
    expect(result.sessionId).toBe("sess-fixture-1");
    expect(result.rawRecords.length).toBeGreaterThan(0);
    expect(result.events.length).toBeGreaterThan(0);
  });
});
