//! Run-on-login toggle (M11 Slice 3).
//!
//! Thin Rust `#[command]` wrappers over `tauri-plugin-autostart`, which manages the
//! `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` entry on Windows. The plugin
//! MUST be registered in the builder (`lib.rs`) before `autolaunch()` is called, or
//! it panics at runtime. No capability entry is needed — these are app-defined
//! commands, and autostart is driven from Rust (the webview only flips the toggle).

use tauri_plugin_autostart::ManagerExt;

/// Whether run-on-login is currently enabled (reads the registry Run entry).
#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Enable or disable run-on-login (adds/removes the registry Run entry).
#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable()
    } else {
        manager.disable()
    }
    .map_err(|e| e.to_string())
}
