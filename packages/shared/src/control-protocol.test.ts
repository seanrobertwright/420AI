import { describe, it, expect, expectTypeOf } from "vitest";
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlCommand,
  type ControlEvent,
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
    expect(CONTROL_PROTOCOL_VERSION).toBe("m11-control-v1");
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
});
