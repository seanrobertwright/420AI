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
  | { cmd: "connectors.list" } //      Slice 2: request a `connectors` event (registry + persisted enablement)
  | { cmd: "connectors.set"; id: string; enabled: boolean; config?: Record<string, unknown> } // Slice 2: persist per-connector enable/disable (`config` reserved/forward-compat — ignored today)
  | { cmd: "connectors.approve"; id: string } // Slice 12.7b: record the connector's CURRENT capture-surface scope as approved (§10.4)
  | { cmd: "stop" }; //                graceful drain + exit

/**
 * A serializable connector descriptor for the webview (Slice 2). `@420ai/shared`
 * is a leaf — it can NOT import `Connector` from `apps/collector` (that would invert
 * the dependency graph), so the fidelity fields are mirrored 1:1 from
 * `ConnectorFidelity` (connector.ts) and the collector's `mapConnectorInfo` is the
 * single `Connector → ConnectorInfo` conversion point (a serve test asserts the map).
 */
export interface ConnectorInfo {
  id: string;
  enabled: boolean;
  status: "stable" | "experimental" | "planned";
  captureMethod: string;
  liveness: "streaming" | "near-real-time" | "snapshot" | "batch";
  tokens: "exact" | "estimated" | "none";
  cost: "reported" | "computed" | "none";
  knownGaps: string[];
  watchGlobs: string[]; // resolved against home — the raw read scope (which files it reads)
  /**
   * Slice 12.7b (§10.3): human-readable statements of what this connector reads —
   * the "Capture Permission" scope the user reviews/approves (distinct from the raw
   * `watchGlobs`). Mirrored 1:1 from `ConnectorFidelity.requiredPermissions`.
   */
  requiredPermissions: string[];
  /**
   * Slice 12.7b (§8.1/§10.4): the connector's capture-surface approval state.
   * `"needs-approval"` ⇒ its current scope drifted from what was last approved and
   * it is WITHHELD from capture until `connectors.approve`. Default-on: a fresh /
   * unrecorded connector is seeded `"approved"` at boot.
   */
  approval: "approved" | "needs-approval";
  /** True for user-defined config connectors (M10-S2 custom connectors); absent/false ⇒ a built-in. */
  custom?: boolean;
}

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
  | { type: "connectors"; connectors: ConnectorInfo[] } // Slice 2: registry + persisted enablement + watch globs
  | { type: "error"; message: string; cmd?: string };

/** Stamps the control-protocol wire shape (sibling of MONITOR_VERSION / ALERT_VERSION). */
export const CONTROL_PROTOCOL_VERSION = "m12-control-v3" as const;
