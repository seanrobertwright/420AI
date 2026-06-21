import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONNECTOR_APPROVALS_VERSION,
  captureSurfaceFingerprint,
  loadConnectorApprovals,
  saveConnectorApprovals,
  approvalStatus,
  seedMissingApprovals,
  approveConnector,
  filterByApproval,
  type ConnectorApprovals,
} from "./connector-approvals.js";
import type { Connector } from "./connector.js";

/**
 * Pure approvals module — exercised with a temp-path seam (never the real ~/.420ai)
 * and an injected `home`. The load-bearing property is DEFAULT-ON: an absent file, an
 * unknown id, and an unrecorded connector all stay approved (a fresh install and any
 * future new connector keep capturing). The §10.4 gate fires only when a recorded
 * connector's surface DRIFTS from its seeded baseline.
 */

const HOME = "/fake/home";

/** A minimal fake carrying just the surface inputs the fingerprint reads. */
function fakeConnector(id: string, globs: string[], perms: string[] = []): Connector {
  return {
    id,
    watchGlobs: () => globs,
    fidelity: { requiredPermissions: perms },
  } as unknown as Connector;
}

const REGISTRY = [
  fakeConnector("claude-code", ["/fake/home/.claude/projects/*/*.jsonl"], ["Read transcripts"]),
  fakeConnector("codex-cli", ["/fake/home/.codex/sessions/*/rollout-*.jsonl"], ["Read rollouts"]),
];

function tempApprovalsPath(): string {
  return join(mkdtempSync(join(tmpdir(), "connappr-")), "connector-approvals.json");
}

describe("connector-approvals", () => {
  it("absent file ⇒ default; everything approved; filterByApproval keeps the FULL registry (default-on)", () => {
    const appr = loadConnectorApprovals(tempApprovalsPath());
    expect(appr).toEqual({ version: CONNECTOR_APPROVALS_VERSION, approved: {} });
    for (const c of REGISTRY) {
      expect(approvalStatus(c, appr, HOME)).toBe("approved");
    }
    expect(filterByApproval(REGISTRY, appr, HOME).map((c) => c.id)).toEqual([
      "claude-code",
      "codex-cli",
    ]);
  });

  it("captureSurfaceFingerprint is stable + order-independent, and changes with scope", () => {
    const a = fakeConnector("x", ["b", "a"], ["p2", "p1"]);
    const reordered = fakeConnector("x", ["a", "b"], ["p1", "p2"]);
    expect(captureSurfaceFingerprint(a, HOME)).toBe(captureSurfaceFingerprint(reordered, HOME));
    const widened = fakeConnector("x", ["a", "b", "c"], ["p1", "p2"]);
    expect(captureSurfaceFingerprint(widened, HOME)).not.toBe(captureSurfaceFingerprint(a, HOME));
  });

  it("seedMissingApprovals records every connector's fingerprint; a re-seed is idempotent", () => {
    const first = seedMissingApprovals(REGISTRY, loadConnectorApprovals(tempApprovalsPath()), HOME);
    expect(first.changed).toBe(true);
    expect(Object.keys(first.approvals.approved).sort()).toEqual(["claude-code", "codex-cli"]);
    for (const c of REGISTRY) {
      expect(first.approvals.approved[c.id]?.surfaceFingerprint).toBe(
        captureSurfaceFingerprint(c, HOME),
      );
    }
    const second = seedMissingApprovals(REGISTRY, first.approvals, HOME);
    expect(second.changed).toBe(false);
    expect(second.approvals.approved).toEqual(first.approvals.approved);
  });

  it("after seeding, a changed glob ⇒ needs-approval ⇒ dropped from filterByApproval", () => {
    const seeded = seedMissingApprovals(REGISTRY, defaultBlob(), HOME).approvals;
    // Same id, WIDENED scope — its current fingerprint now drifts from the seeded one.
    const drifted = fakeConnector(
      "codex-cli",
      ["/fake/home/.codex/sessions/*/rollout-*.jsonl", "/fake/home/.codex/extra/*.log"],
      ["Read rollouts"],
    );
    const registry = [REGISTRY[0]!, drifted];
    expect(approvalStatus(drifted, seeded, HOME)).toBe("needs-approval");
    expect(approvalStatus(REGISTRY[0]!, seeded, HOME)).toBe("approved");
    expect(filterByApproval(registry, seeded, HOME).map((c) => c.id)).toEqual(["claude-code"]);
  });

  it("approveConnector over a drifted connector restores approved + re-includes it", () => {
    const seeded = seedMissingApprovals(REGISTRY, defaultBlob(), HOME).approvals;
    const drifted = fakeConnector(
      "codex-cli",
      ["/fake/home/.codex/sessions/*/rollout-*.jsonl", "/fake/home/.codex/extra/*.log"],
      ["Read rollouts"],
    );
    expect(approvalStatus(drifted, seeded, HOME)).toBe("needs-approval");
    const after = approveConnector(drifted, seeded, HOME);
    expect(approvalStatus(drifted, after, HOME)).toBe("approved");
    expect(filterByApproval([drifted], after, HOME).map((c) => c.id)).toEqual(["codex-cli"]);
    // approveConnector is pure: the prior blob is untouched.
    expect(approvalStatus(drifted, seeded, HOME)).toBe("needs-approval");
  });

  it("an unknown (unrecorded) id stays approved even when other ids are recorded", () => {
    const seeded = seedMissingApprovals([REGISTRY[0]!], defaultBlob(), HOME).approvals;
    // codex-cli was never seeded ⇒ default-on.
    expect(approvalStatus(REGISTRY[1]!, seeded, HOME)).toBe("approved");
  });

  it("save → load round-trips", () => {
    const path = tempApprovalsPath();
    const cfg: ConnectorApprovals = {
      version: CONNECTOR_APPROVALS_VERSION,
      approved: { "codex-cli": { surfaceFingerprint: "deadbeef" } },
    };
    saveConnectorApprovals(cfg, path);
    expect(loadConnectorApprovals(path)).toEqual(cfg);
  });

  it("corrupt file ⇒ safe default (never throws)", () => {
    const path = tempApprovalsPath();
    writeFileSync(path, "{ this is not valid json");
    expect(loadConnectorApprovals(path)).toEqual({
      version: CONNECTOR_APPROVALS_VERSION,
      approved: {},
    });
  });
});

/** A fresh default approvals blob (mirrors loadConnectorApprovals on an absent file). */
function defaultBlob(): ConnectorApprovals {
  return { version: CONNECTOR_APPROVALS_VERSION, approved: {} };
}
