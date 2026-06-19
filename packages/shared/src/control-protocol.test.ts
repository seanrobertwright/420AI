import { describe, it, expect, expectTypeOf } from "vitest";
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlCommand,
  type ControlEvent,
  type ConnectorInfo,
} from "./control-protocol.js";

/**
 * The control protocol is the shared wire contract between Node (serve.ts), Rust
 * (the relay parser), and the webview. There is no runtime logic to test, so these
 * are guard tests: a version snapshot (a bump must be deliberate — the Rust serde
 * mirror has to move with it) and type-level assertions that the discriminated
 * unions still carry the fields all three consumers depend on.
 */
describe("control-protocol", () => {
  it("pins CONTROL_PROTOCOL_VERSION (bump deliberately + move the Rust mirror)", () => {
    expect(CONTROL_PROTOCOL_VERSION).toBe("m11-control-v2");
  });

  it("ControlCommand discriminates on `cmd` and carries configure/pair fields", () => {
    const configure: ControlCommand = { cmd: "configure", url: "u", token: "t" };
    const pair: ControlCommand = { cmd: "pair", url: "u", code: "c" };
    const start: ControlCommand = { cmd: "start" };
    expect(configure.cmd).toBe("configure");
    expect(pair.cmd).toBe("pair");
    expect(start.cmd).toBe("start");
    expectTypeOf<ControlCommand>().toHaveProperty("cmd");
  });

  it("ControlEvent discriminates on `type` and status carries queue counts", () => {
    const ready: ControlEvent = {
      type: "ready",
      pid: 1,
      collectorVersion: "0.0.0",
      paired: false,
    };
    const status: ControlEvent = {
      type: "status",
      state: "running",
      pending: 0,
      inflight: 0,
    };
    expect(ready.type).toBe("ready");
    expect(status.type).toBe("status");
    if (status.type === "status") {
      expect(status.pending).toBe(0);
      expect(status.inflight).toBe(0);
    }
  });

  it("carries the Slice-2 connectors command + event (enable/disable + fidelity)", () => {
    const set: ControlCommand = { cmd: "connectors.set", id: "codex-cli", enabled: false };
    const list: ControlCommand = { cmd: "connectors.list" };
    expect(set.cmd).toBe("connectors.set");
    expect(list.cmd).toBe("connectors.list");
    if (set.cmd === "connectors.set") {
      expect(set.id).toBe("codex-cli");
      expect(set.enabled).toBe(false);
    }

    const info: ConnectorInfo = {
      id: "claude-code",
      enabled: true,
      status: "stable",
      captureMethod: "tail-jsonl",
      liveness: "streaming",
      tokens: "exact",
      cost: "reported",
      knownGaps: [],
      watchGlobs: ["/home/u/.claude/**/*.jsonl"],
    };
    // M10-S2: a user-defined connector carries the additive optional `custom` flag.
    const customInfo: ConnectorInfo = {
      id: "custom-mytool",
      enabled: true,
      status: "experimental",
      captureMethod: "custom-tail-regex",
      liveness: "streaming",
      tokens: "none",
      cost: "none",
      knownGaps: ["user-defined mapping"],
      watchGlobs: ["/tmp/mytool/*.log"],
      custom: true,
    };
    const event: ControlEvent = { type: "connectors", connectors: [info, customInfo] };
    expect(event.type).toBe("connectors");
    if (event.type === "connectors") {
      expect(event.connectors[0]?.id).toBe("claude-code");
      expect(event.connectors[0]?.enabled).toBe(true);
      // A built-in omits `custom` (additive-optional ⇒ undefined); a custom connector sets it true.
      expect(event.connectors[0]?.custom).toBeUndefined();
      expect(event.connectors[1]?.custom).toBe(true);
    }
  });
});
