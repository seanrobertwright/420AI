import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectors } from "./connector.js";
import { CLAUDE_CODE_CONNECTOR } from "./claude-code.js";
import { CLAUDE_LIVE_CONNECTOR } from "./claude-live.js";

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

  it("registers the M14 14.7 claude-live push connector (empty globs, push capability)", () => {
    const live = connectors.find((c) => c.id === CLAUDE_LIVE_CONNECTOR);
    expect(live).toBeDefined();
    expect(live!.captureMode).toBe("push");
    expect(live!.watchGlobs("/home/u")).toEqual([]); // push-mode: nothing to tail
    expect(live!.push?.origins).toEqual(["https://claude.ai"]);
    // Honest fidelity: experimental, near-real-time, uncosted.
    expect(live!.fidelity.status).toBe("experimental");
    expect(live!.fidelity.liveness).toBe("near-real-time");
    expect(live!.fidelity.tokens).toBe("none");
    expect(live!.fidelity.cost).toBe("none");
  });
});
