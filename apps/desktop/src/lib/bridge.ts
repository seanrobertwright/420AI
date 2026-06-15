import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ControlCommand, ControlEvent } from "@420ai/shared";

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
