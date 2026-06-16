mod autostart;
mod keychain;
mod pairing;
mod proxy;
mod server;
mod sidecar;
mod tray;

/// Build + run the desktop app. Registers the shell plugin (for the sidecar) and the
/// autostart plugin (run-on-login), manages the sidecar + server supervision state,
/// exposes the webview `#[command]`s (capture control, monitor proxy, GUI pairing,
/// autostart, and Slice-4 server config + full stack supervision), builds the tray ONCE
/// in `setup` (tauri#8982 duplicate-icon gotcha), and spawns the supervised sidecar
/// relay. On exit it tears down the sidecar AND the ingest child (no zombies).
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // MacosLauncher is a required positional arg even on Windows (a no-op there);
        // None = no extra launch args. Register BEFORE setup so autolaunch() is live.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(sidecar::SidecarState::default())
        .manage(server::ServerState::default())
        .invoke_handler(tauri::generate_handler![
            sidecar::send_command,
            proxy::get_monitor_snapshot,
            pairing::pair,
            pairing::get_pairing_status,
            autostart::get_autostart,
            autostart::set_autostart,
            server::get_server_config,
            server::set_server_config,
            server::start_archive,
            server::stop_archive,
            server::start_ingest,
            server::stop_ingest,
            server::get_server_health,
            server::unpair
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
                server::shutdown(app_handle); // kill the supervised ingest child — no zombie
            }
        });
}
