use serde_json::json;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Runtime,
};

use crate::sidecar;

/// Build the system tray ONCE (call from `setup` — tauri#8982 spawns duplicate icons
/// if rebuilt on dev hot-reload). The menu drives the same sidecar relay as the
/// webview: Start/Pause/Resume write a control command to the sidecar's stdin; Quit
/// exits the app (the `RunEvent::Exit` handler tears the sidecar down).
pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let start = MenuItem::with_id(app, "start", "Start", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
    let resume = MenuItem::with_id(app, "resume", "Resume", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&start, &pause, &resume, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().expect("a default window icon").clone())
        .tooltip("420AI Collector")
        .menu(&menu)
        .on_menu_event(|app, event| {
            let cmd = match event.id.as_ref() {
                "start" => Some(json!({ "cmd": "start" })),
                "pause" => Some(json!({ "cmd": "pause" })),
                "resume" => Some(json!({ "cmd": "resume" })),
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
