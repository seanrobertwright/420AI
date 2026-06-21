import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ControlCommand, ControlEvent, LiveMonitorSnapshot } from "@420ai/shared";

/**
 * The webview↔Rust bridge (M11). The webview NEVER spawns or talks to the sidecar
 * directly: it sends a `ControlCommand` to the Rust `send_command` `#[command]`,
 * which writes it to the sidecar's stdin; the sidecar's stdout events come back as
 * a Tauri `"control-event"` payload that Rust relays via `app.emit`. This mirrors
 * the dashboard's "browser never holds the token / only the server hop adds it"
 * invariant — here Rust is the privileged hop. The control-protocol TYPES are the
 * single shared schema (`@420ai/shared`); Rust derives the serde mirror from them.
 */

/** Send one control command to the sidecar (via the Rust relay). */
export function sendCommand(cmd: ControlCommand): Promise<void> {
  return invoke("send_command", { cmd });
}

/**
 * Subscribe to sidecar control events. Returns the Tauri unlisten function — the
 * caller MUST call it on teardown (e.g. a React effect cleanup). Attach this before
 * the first `await` in an effect so an early event is not missed (CLAUDE.md
 * leak-window discipline, the M11 analog of the dashboard SSE listener).
 */
export function onControlEvent(cb: (ev: ControlEvent) => void): Promise<UnlistenFn> {
  return listen<ControlEvent>("control-event", (event) => cb(event.payload));
}

/**
 * Fetch the server `LiveMonitorSnapshot` via the Rust `get_monitor_snapshot` proxy
 * (Slice 2). Rust holds the admin token + makes the request, returning opaque JSON;
 * we cast it to the shared type. Rejects ("admin token not configured" / "ingest
 * unreachable: …") so the panel can degrade gracefully (mirrors the dashboard proxy).
 */
export function getMonitorSnapshot(): Promise<LiveMonitorSnapshot> {
  return invoke<LiveMonitorSnapshot>("get_monitor_snapshot");
}

/** Ask the sidecar to emit a `connectors` event (registry + persisted enablement). */
export function listConnectors(): Promise<void> {
  return sendCommand({ cmd: "connectors.list" });
}

/** Persist a per-connector enable/disable; the sidecar re-emits the `connectors` event. */
export function setConnector(id: string, enabled: boolean): Promise<void> {
  return sendCommand({ cmd: "connectors.set", id, enabled });
}

/** Approve a connector's CURRENT capture surface (records its scope fingerprint as approved). */
export function approveConnector(id: string): Promise<void> {
  return sendCommand({ cmd: "connectors.approve", id });
}

/**
 * GUI pairing (Slice 3). Rust does the HTTP handshake against `/v1/pair`, stores the
 * issued token in the OS keychain, and `configure`s the sidecar — the token is born in
 * Rust and NEVER returned here. NB: `PairResult` has NO `token` field by design.
 */
export interface PairResult {
  machineId: string;
}

/** Keychain pairing state (token never included). */
export interface PairingStatus {
  paired: boolean;
  machineId: string | null;
}

/** Pair with an archive: URL + pairing code + machine name → `{ machineId }`. */
export function pair(url: string, code: string, name: string): Promise<PairResult> {
  return invoke<PairResult>("pair", { url, code, name });
}

/** Read the current keychain pairing state (paired? + machineId). */
export function getPairingStatus(): Promise<PairingStatus> {
  return invoke<PairingStatus>("get_pairing_status");
}

/** Whether run-on-login is enabled (reads the HKCU\…\Run registry entry). */
export function getAutostart(): Promise<boolean> {
  return invoke<boolean>("get_autostart");
}

/** Enable/disable run-on-login. */
export function setAutostart(enabled: boolean): Promise<void> {
  return invoke("set_autostart", { enabled });
}

/**
 * Server config + full-stack supervision (Slice 4). Rust is the privileged
 * orchestrator: it holds the secrets in a SECOND keychain entry, injects them as the
 * supervised ingest's env (never written to disk), and runs `docker compose` for the
 * archive. The webview NEVER receives a secret value — `ServerConfigView` carries only
 * presence booleans + the non-secret fields (token-isolation, like `PairResult` having
 * no `token`).
 */
export interface ServerConfigView {
  serverDir: string;
  ingestUrl: string;
  hasAdminToken: boolean;
  hasDatabaseUrl: boolean;
  hasArchiveEncryptionKey: boolean;
  hasAnalysisApiKey: boolean;
  ingestPort: number | null;
  analysisProvider: string | null;
  analysisModel: string | null;
  analysisBaseUrl: string | null;
}

/**
 * What the Settings form SENDS. Secrets are optional: a blank/omitted secret means
 * "leave unchanged" (Rust merges against the stored blob) so re-saving non-secret prefs
 * never wipes a secret the webview can't see.
 */
export interface ServerConfigInput {
  serverDir: string;
  ingestUrl: string;
  adminToken?: string;
  databaseUrl?: string;
  archiveEncryptionKey?: string;
  ingestPort?: number;
  analysisProvider?: string;
  analysisApiKey?: string;
  analysisModel?: string;
  analysisBaseUrl?: string;
}

/** Stack health: archive compose state + ingest `/v1/health` reachability. */
export interface ServerHealth {
  archive: string;
  ingest: boolean;
}

/** Read the masked server config (presence booleans for secrets), or `null` if unset. */
export function getServerConfig(): Promise<ServerConfigView | null> {
  return invoke<ServerConfigView | null>("get_server_config");
}

/** Persist the server config (blank secret fields are merged, not wiped). */
export function setServerConfig(cfg: ServerConfigInput): Promise<void> {
  return invoke("set_server_config", { cfg });
}

/** Start the Docker Postgres archive (`docker compose up -d archive`). */
export function startArchive(): Promise<void> {
  return invoke("start_archive");
}

/** Stop the Docker archive (`docker compose down`; the data volume persists). */
export function stopArchive(): Promise<void> {
  return invoke("stop_archive");
}

/** Start the supervised ingest process (keychain secrets injected as env). */
export function startIngest(): Promise<void> {
  return invoke("start_ingest");
}

/** Stop the supervised ingest process (kill + reap — no zombie). */
export function stopIngest(): Promise<void> {
  return invoke("stop_ingest");
}

/** Poll archive + ingest health (best-effort — a failed probe is `stopped`/`false`). */
export function getServerHealth(): Promise<ServerHealth> {
  return invoke<ServerHealth>("get_server_health");
}

/** Unpair: clear the pairing keychain entry (the server-config entry is untouched). */
export function unpair(): Promise<void> {
  return invoke("unpair");
}
