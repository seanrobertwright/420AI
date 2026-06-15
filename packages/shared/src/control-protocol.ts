/**
 * M11 Control Protocol — the JSON-lines command/event contract spoken over the
 * desktop sidecar's stdio (PRD §25 item 11, glossary "control protocol" in
 * docs/CONTEXT.md).
 *
 * The Tauri/Rust shell writes one `ControlCommand` JSON object per line to the
 * collector sidecar's stdin; the sidecar (`apps/collector/src/serve.ts`) writes
 * one `ControlEvent` JSON object per line to stdout. Rust relays events to the
 * webview via `app.emit`, and the webview sends commands back through a Rust
 * `#[command]`. Three consumers share THIS module as the single schema source:
 * Node (serde-on-the-wire is hand-rolled JSON), Rust (serde derives the mirror),
 * and the webview (imports these types directly).
 *
 * Pure types + a version stamp — NO runtime logic, exactly like the type modules
 * it sits beside. `CONTROL_PROTOCOL_VERSION` is the sibling of `MONITOR_VERSION`
 * (monitor.ts) and `ALERT_VERSION` (alerts.ts): bump it when the wire shape
 * changes so Rust and Node can detect a schema drift (D11-style stamp, PRD §23).
 *
 * stdout is PROTOCOL-ONLY (the load-bearing rule the control-protocol spike
 * proved): every log/warning travels as a `{type:"log"}` event or goes to stderr,
 * never as raw stdout text — otherwise it corrupts the JSON-lines stream.
 */

/**
 * Commands: webview → Rust `#[command]` → sidecar stdin (one JSON object per line).
 *
 * `configure` (Slice 3) injects credentials in-memory so the GUI path never writes
 * a plaintext `credentials.json`; `start`/`resume` (re)spawn the capture engine,
 * `pause`/`stop` abort it via its AbortSignal (stop also drains + exits).
 */
export type ControlCommand =
  | { cmd: "configure"; url: string; token: string; machineId?: string } // Slice 3: inject creds (no disk)
  | { cmd: "start" } //                begin capture (requires configured creds)
  | { cmd: "pause" }
  | { cmd: "resume" }
  | { cmd: "status" } //               request an immediate status event
  | { cmd: "pair"; url: string; code: string; name?: string } // Slice 3: GUI pairing
  | { cmd: "discover" } //             optional: trigger M5 discovery
  | { cmd: "stop" }; //                graceful drain + exit

/**
 * Events: sidecar stdout → Rust → `app.emit` → webview `listen`.
 *
 * `status` is emitted on boot, on demand (`status` command), and on a periodic
 * timer; `state` mirrors the capture lifecycle. The `pending`/`inflight` counts
 * come straight from `QueueStore.stats()`.
 */
export type ControlEvent =
  | { type: "ready"; pid: number; collectorVersion: string; paired: boolean }
  | {
      type: "status";
      state: "running" | "paused" | "idle" | "error";
      pending: number;
      inflight: number;
      lastSyncAt?: string | null;
    }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "paired"; machineId: string }
  | { type: "ack"; cmd: string }
  | { type: "stopped" }
  | { type: "error"; message: string; cmd?: string };

/** Stamps the control-protocol wire shape (sibling of MONITOR_VERSION / ALERT_VERSION). */
export const CONTROL_PROTOCOL_VERSION = "m11-control-v1" as const;
