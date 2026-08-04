use serde_json::json;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, Runtime,
};

use crate::sidecar;

/// Build the system tray ONCE (call from `setup` — tauri#8982 spawns duplicate icons
/// if rebuilt on dev hot-reload). The menu drives the same sidecar relay as the
/// webview: Start/Pause/Resume write a control command to the sidecar's stdin; Quit
/// exits the app (the `RunEvent::Exit` handler tears the sidecar down).
///
/// A non-interactive (`enabled = false`) server-status line surfaces the server stack
/// in the tray (Slice 4 acceptance "+ tray"); the live archive/ingest health renders in
/// the Settings panel. A live tray label would need a stored `MenuItem` handle + a poll
/// task — deliberately out of this slice (the static line satisfies the criterion).
pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let start = MenuItem::with_id(app, "start", "Start", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
    let resume = MenuItem::with_id(app, "resume", "Resume", true, None::<&str>)?;
    // Display-only: a `false`-enabled item needs no `on_menu_event` branch.
    let server_status = MenuItem::with_id(
        app,
        "server_status",
        "Server: manage in Settings",
        false,
        None::<&str>,
    )?;
    /*
     * M16 16.2 — the ONLY attention-getting affordance for labelling, and it is one the human
     * presses (D-16.2-3).
     *
     * STATIC, WITH NO COUNT. A live "Label 3 sessions" caption needs a stored `MenuItem` handle
     * plus a poll task, which the comment above records as deliberately excluded in Slice 4 and
     * which stays excluded. The count belongs in the panel, where looking at it is a choice.
     *
     * The deeper reason is the anti-nag contract: §4.3 requires "do not nag repeatedly", and this
     * app never raises a window, fires a notification or steals focus. A tray label that changed
     * on its own would be a notification with extra steps — an interruption during exactly the
     * deep work the research period is measuring, and a measurement that changes what it measures
     * is worse than a lower completion rate.
     *
     * Unlike `server_status` this item IS enabled, so it needs an `on_menu_event` branch below.
     */
    let label_sessions =
        MenuItem::with_id(app, "label_sessions", "Label sessions…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&start, &pause, &resume, &server_status, &label_sessions, &quit],
    )?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().expect("a default window icon").clone())
        .tooltip("420AI Collector")
        .menu(&menu)
        .on_menu_event(|app, event| {
            let cmd = match event.id.as_ref() {
                "start" => Some(json!({ "cmd": "start" })),
                "pause" => Some(json!({ "cmd": "pause" })),
                "resume" => Some(json!({ "cmd": "resume" })),
                // M16 16.2 — show and focus the main window; the panel is already mounted there.
                // This is a RESPONSE to a press, never something the app does on its own
                // (D-16.2-3). No sidecar command: labelling talks to ingest, not the collector.
                "label_sessions" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                    None
                }
                "quit" => {
                    app.exit(0);
                    None
                }
                _ => None,
            };
            if let Some(cmd) = cmd {
                if let Err(e) = sidecar::write_command(app, cmd) {
                    let _ = app.emit(
                        "control-event",
                        json!({ "type": "error", "message": format!("tray command failed: {e}") }),
                    );
                }
            }
        })
        .build(app)?;

    Ok(())
}
