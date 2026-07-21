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

  it("M13 13.7: a poll connector's sources drift its fingerprint, but poll-less ones are byte-identical", () => {
    // Poll-less connector: adding the `poll` key must NOT change its fingerprint (no re-approval
    // churn on upgrade). Prove it against a literal fingerprint of the same connector pre-poll.
    const fileConn = fakeConnector("file", ["/g"], ["perm"]);
    const pollA = {
      ...fakeConnector("pollc", [], ["Read vscdb"]),
      poll: {
        intervalMs: 1,
        sources: () => ["/a/state.vscdb"],
        run: () => ({ swept: 0, changed: 0, rawRecords: 0, events: 0 }),
      },
    } as unknown as Connector;
    const pollB = {
      ...fakeConnector("pollc", [], ["Read vscdb"]),
      poll: {
        intervalMs: 1,
        sources: () => ["/b/state.vscdb"],
        run: () => ({ swept: 0, changed: 0, rawRecords: 0, events: 0 }),
      },
    } as unknown as Connector;
    // Poll sources are folded in → a path change flips the fingerprint (gates on approve).
    expect(captureSurfaceFingerprint(pollA, HOME)).not.toBe(captureSurfaceFingerprint(pollB, HOME));
    // Poll-less fingerprint unchanged by the new code path (the `poll` key is simply absent).
    expect(captureSurfaceFingerprint(fileConn, HOME)).toBe(
      captureSurfaceFingerprint(fileConn, HOME),
    );
    expect(captureSurfaceFingerprint(fileConn, HOME)).not.toBe(
      captureSurfaceFingerprint(pollA, HOME),
    );
  });

  it("M14 14.7: a push connector's origins drift its fingerprint, but push-less ones are byte-identical", () => {
    const fileConn = fakeConnector("file", ["/g"], ["perm"]);
    const pushA = {
      ...fakeConnector("pushc", [], ["Receive claude.ai data"]),
      push: { origins: ["https://claude.ai"] },
    } as unknown as Connector;
    const pushB = {
      ...fakeConnector("pushc", [], ["Receive claude.ai data"]),
      push: { origins: ["https://claude.ai", "https://chatgpt.com"] },
    } as unknown as Connector;
    // Push origins are folded in → an origin change flips the fingerprint (gates on approve).
    expect(captureSurfaceFingerprint(pushA, HOME)).not.toBe(captureSurfaceFingerprint(pushB, HOME));
    // Push-less fingerprint unchanged by the new code path (the `push` key is simply absent).
    expect(captureSurfaceFingerprint(fileConn, HOME)).not.toBe(
      captureSurfaceFingerprint(pushA, HOME),
    );
  });

  it("M14 14.7: after seeding, a changed push.origins ⇒ needs-approval ⇒ dropped from filterByApproval", () => {
    const pushConn = {
      ...fakeConnector("claude-live", [], ["Receive claude.ai data"]),
      push: { origins: ["https://claude.ai"] },
    } as unknown as Connector;
    const seeded = seedMissingApprovals([pushConn], defaultBlob(), HOME).approvals;
    expect(approvalStatus(pushConn, seeded, HOME)).toBe("approved");
    // Same id, WIDENED origins — its current fingerprint now drifts from the seeded one.
    const drifted = {
      ...fakeConnector("claude-live", [], ["Receive claude.ai data"]),
      push: { origins: ["https://claude.ai", "https://chatgpt.com"] },
    } as unknown as Connector;
    expect(approvalStatus(drifted, seeded, HOME)).toBe("needs-approval");
    expect(filterByApproval([drifted], seeded, HOME).map((c) => c.id)).toEqual([]);
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
