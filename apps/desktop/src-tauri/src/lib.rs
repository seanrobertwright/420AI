mod proxy;
mod sidecar;
mod tray;

/// Build + run the desktop app. Registers the shell plugin (for the sidecar),
/// manages the sidecar supervision state, exposes `send_command` to the webview,
/// builds the tray ONCE in `setup` (tauri#8982 duplicate-icon gotcha), and spawns
/// the supervised sidecar relay. On exit it tears the sidecar down (no zombie).
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(sidecar::SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            sidecar::send_command,
            proxy::get_monitor_snapshot
        ])
        .setup(|app| {
            tray::build_tray(app.handle())?;
            sidecar::spawn_sidecar(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                sidecar::shutdown(app_handle);
            }
        });
}
