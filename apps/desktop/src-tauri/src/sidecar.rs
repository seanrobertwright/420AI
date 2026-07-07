use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Tauri sidecar name — the BARE basename, NOT the `binaries/…` build path. The shell plugin's
/// `relative_command_path` joins this verbatim onto the executable's dir (`<exe_dir>/collector.exe`)
/// with no prefix/triple stripping at runtime. The bundler reads `binaries/collector-<TARGET_TRIPLE>.exe`
/// (built by `build-sea.mjs`, matching `bundle.externalBin`) and copies it NEXT TO the main exe as
/// `collector.exe`. So `"binaries/collector"` here resolved to a nonexistent
/// `<exe_dir>/binaries/collector.exe` → spawn failed → "sidecar not running" (UAT G.4/G.5).
const SIDECAR_NAME: &str = "collector";
const EVENT_NAME: &str = "control-event";

// Restart-with-backoff (mirrors queue-store.ts: 1 s base, 30 s cap). A run that
// stays up past HEALTHY_UPTIME_SECS resets the failure counter; a fast failure
// (never spawned, or crashed immediately) escalates the delay. After
// MAX_CONSECUTIVE_FAILURES fast failures we stop respawning and surface a terminal
// error, so a missing/broken binary can't spam an error event every second forever.
const RESTART_BACKOFF_BASE_MS: u64 = 1000;
const RESTART_BACKOFF_CAP_MS: u64 = 30_000;
const HEALTHY_UPTIME_SECS: u64 = 5;
const MAX_CONSECUTIVE_FAILURES: u32 = 6;

/// Supervision state: the live sidecar's stdin handle + a shutdown latch so the
/// restart-with-backoff loop stops cleanly when the app is exiting.
#[derive(Default)]
pub struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    shutting_down: AtomicBool,
}

/// Spawn the supervised sidecar relay on the async runtime. The relay reads the
/// sidecar's stdout JSON-lines and emits each as a `control-event` to the webview;
/// it restarts the child with backoff on unexpected exit (crash recovery).
pub fn spawn_sidecar(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        run_sidecar_loop(app).await;
    });
}

async fn run_sidecar_loop<R: Runtime>(app: AppHandle<R>) {
    let mut failures: u32 = 0;
    loop {
        let started = std::time::Instant::now();
        spawn_and_relay(&app).await;

        if app.state::<SidecarState>().shutting_down.load(Ordering::Relaxed) {
            break;
        }

        // Healthy run (stayed up) → reset; fast failure → escalate the backoff.
        if started.elapsed() >= Duration::from_secs(HEALTHY_UPTIME_SECS) {
            failures = 0;
        } else {
            failures += 1;
        }

        if failures >= MAX_CONSECUTIVE_FAILURES {
            let _ = app.emit(
                EVENT_NAME,
                json!({
                    "type": "error",
                    "message": format!(
                        "sidecar failed to stay up after {failures} attempts — giving up; restart the app to retry"
                    )
                }),
            );
            break;
        }

        // 1 s, 2 s, 4 s … capped at 30 s (shift by failures-1 so the first retry is base).
        let delay = (RESTART_BACKOFF_BASE_MS << failures.saturating_sub(1).min(5))
            .min(RESTART_BACKOFF_CAP_MS);
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
}

/// Spawn the sidecar once and relay its stdout JSON-lines to the webview until it
/// exits. Returns when the child terminates or fails to spawn (the caller owns the
/// restart/backoff decision).
async fn spawn_and_relay<R: Runtime>(app: &AppHandle<R>) {
    match app.shell().sidecar(SIDECAR_NAME) {
        // The explicit `serve` arg makes the SEA entry run deterministically
        // (neither isSea() nor import.meta.url is load-bearing — see serve.ts).
        Ok(command) => match command.args(["serve"]).spawn() {
            Ok((mut rx, child)) => {
                store_child(app, child);
                let mut stdout_buf: Vec<u8> = Vec::new();
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            stdout_buf.extend_from_slice(&bytes);
                            while let Some(pos) = stdout_buf.iter().position(|&b| b == b'\n') {
                                let line_bytes: Vec<u8> = stdout_buf.drain(..=pos).collect();
                                let line = String::from_utf8_lossy(&line_bytes);
                                let trimmed = line.trim();
                                if !trimmed.is_empty() {
                                    let event = parse_event_line(trimmed);
                                    let _ = app.emit(EVENT_NAME, &event);
                                    auto_configure_on_ready(app, &event);
                                }
                            }
                        }
                        CommandEvent::Stderr(bytes) => {
                            let msg = String::from_utf8_lossy(&bytes).trim().to_string();
                            if !msg.is_empty() {
                                let _ = app.emit(
                                    EVENT_NAME,
                                    json!({ "type": "log", "level": "warn", "message": msg }),
                                );
                            }
                        }
                        CommandEvent::Terminated(payload) => {
                            let shutting_down = app
                                .state::<SidecarState>()
                                .shutting_down
                                .load(Ordering::Relaxed);
                            if !shutting_down {
                                let level = if payload.code == Some(0) { "info" } else { "error" };
                                let _ = app.emit(
                                    EVENT_NAME,
                                    json!({
                                        "type": "log",
                                        "level": level,
                                        "message": format!("sidecar exited (code {:?})", payload.code)
                                    }),
                                );
                            }
                            break;
                        }
                        CommandEvent::Error(err) => {
                            let _ = app.emit(
                                EVENT_NAME,
                                json!({ "type": "error", "message": format!("sidecar io error: {err}") }),
                            );
                        }
                        _ => {}
                    }
                }
                clear_child(app);
            }
            Err(err) => {
                let _ = app.emit(
                    EVENT_NAME,
                    json!({ "type": "error", "message": format!("failed to spawn sidecar: {err}") }),
                );
            }
        },
        Err(err) => {
            let _ = app.emit(
                EVENT_NAME,
                json!({ "type": "error", "message": format!("sidecar not found: {err}") }),
            );
        }
    }
}

fn store_child<R: Runtime>(app: &AppHandle<R>, child: CommandChild) {
    if let Ok(mut guard) = app.state::<SidecarState>().child.lock() {
        *guard = Some(child);
    }
}

fn clear_child<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(mut guard) = app.state::<SidecarState>().child.lock() {
        *guard = None;
    }
}

/// Write one control command (JSON) to the sidecar's stdin as a single line. Shared
/// by the webview `send_command` and the tray menu — both routes funnel through here.
pub fn write_command<R: Runtime>(app: &AppHandle<R>, cmd: Value) -> Result<(), String> {
    let mut line = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    line.push('\n');
    let state = app.state::<SidecarState>();
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    match guard.as_mut() {
        Some(child) => child.write(line.as_bytes()).map_err(|e| e.to_string()),
        None => Err("sidecar not running".into()),
    }
}

/// On the sidecar's `ready` event, inject keychain credentials via `configure` so a
/// (re)spawned sidecar picks up the GUI-paired token without a re-pair — capture
/// resumes after an app restart. Triggers on `ready` ONLY (once per spawn), not
/// `status`. The keychain `load()` is a single fast CredMan read (sync I/O in the
/// async relay is acceptable here). The token rides sidecar STDIN (Rust→sidecar),
/// never stdout — so it never reaches the webview, and is never logged.
fn auto_configure_on_ready<R: Runtime>(app: &AppHandle<R>, event: &Value) {
    if event.get("type").and_then(Value::as_str) != Some("ready") {
        return;
    }
    if let Some(creds) = crate::keychain::load() {
        let _ = write_command(
            app,
            json!({
                "cmd": "configure",
                "url": creds.url,
                "token": creds.token,
                "machineId": creds.machine_id,
            }),
        );
    }
}

/// The webview's only door to the sidecar (mirrors the dashboard proxy invariant:
/// the privileged hop, not the UI, drives the engine). Forwards an opaque
/// `ControlCommand` JSON value — the TS types are the shared schema, so Rust does
/// not duplicate the command union.
#[tauri::command]
pub fn send_command(app: AppHandle, cmd: Value) -> Result<(), String> {
    write_command(&app, cmd)
}

/// On app exit: graceful stop (drain) then kill, so no zombie sidecar
/// survives. Sends the stop command, waits briefly for the sidecar to drain,
/// then kills if still alive. Latches `shutting_down` so the restart loop does
/// not respawn.
pub fn shutdown<R: Runtime>(app: &AppHandle<R>) {
    app.state::<SidecarState>()
        .shutting_down
        .store(true, Ordering::Relaxed);
    let _ = write_command(app, json!({ "cmd": "stop" }));
    // Give the sidecar a moment to read the stop command and drain before we kill it.
    std::thread::sleep(Duration::from_millis(200));
    if let Ok(mut guard) = app.state::<SidecarState>().child.lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }
}

/// Parse one sidecar stdout line into the JSON payload emitted to the webview. A
/// well-formed JSON object passes through unchanged; anything else becomes a
/// synthesized `error` event so the webview always receives a valid control event.
pub fn parse_event_line(line: &str) -> Value {
    let trimmed = line.trim();
    match serde_json::from_str::<Value>(trimmed) {
        Ok(value) if value.is_object() => value,
        _ => json!({
            "type": "error",
            "message": format!("unparseable sidecar line: {}", truncate(trimmed, 120))
        }),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let kept: String = s.chars().take(max).collect();
        format!("{kept}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_through_a_valid_status_object() {
        let line = r#"{"type":"status","state":"running","pending":3,"inflight":1}"#;
        let value = parse_event_line(line);
        assert_eq!(value["type"], "status");
        assert_eq!(value["state"], "running");
        assert_eq!(value["pending"], 3);
    }

    #[test]
    fn malformed_line_becomes_an_error_event() {
        let value = parse_event_line("this is not json");
        assert_eq!(value["type"], "error");
        assert!(value["message"]
            .as_str()
            .unwrap()
            .contains("unparseable"));
    }

    #[test]
    fn non_object_json_becomes_an_error_event() {
        // A bare JSON array/number is valid JSON but not a control event.
        let value = parse_event_line("[1,2,3]");
        assert_eq!(value["type"], "error");
    }
}
