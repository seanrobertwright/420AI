//! Server-side monitor proxy (M11 Slice 2).
//!
//! The webview never holds the admin token — it calls this `#[command]`, and Rust
//! (the privileged hop) fetches the admin-gated ingest `/v1/monitor` endpoint with
//! the bearer added here. This mirrors the dashboard's `app/api/monitor/route.ts`
//! proxy, with Rust as the token-holder instead of the Next server.
//!
//! Token + base come from the SERVER-CONFIG KEYCHAIN (Slice 4) — `adminToken` /
//! `ingestUrl` — falling back to PROCESS ENV (`ADMIN_TOKEN` / `INGEST_URL`) when the
//! keychain holds no server config, so a headless/dev run behaves exactly as before
//! (mirrors the dashboard's `apps/dashboard/src/lib/ingest.ts` env path). `/v1/monitor`
//! is admin-gated, so the saved per-machine ingest credentials would 401 — the admin
//! token is the only correct source. If neither the keychain nor the env supplies a
//! token the command returns `Err`, and the panel degrades to local-status-only. The
//! token is NEVER logged and NEVER returned to the webview.

use std::time::Duration;

const DEFAULT_INGEST_URL: &str = "http://localhost:8420";
const MONITOR_TIMEOUT: Duration = Duration::from_secs(10);

/// Build the monitor URL from a base (pure + unit-testable; no env, no I/O).
fn monitor_url(base: &str) -> String {
    format!("{}/v1/monitor", base.trim_end_matches('/'))
}

/// Resolve the admin token + ingest base, preferring the server-config keychain
/// (Slice 4) and falling back to process env (headless/dev). An empty keychain string
/// is treated as unset (so we never send an empty bearer / a blank base). Returns
/// `Err` only when NEITHER source supplies a token.
fn monitor_credentials() -> Result<(String, String), String> {
    let cfg = crate::keychain::load_server();
    let token = cfg
        .as_ref()
        .map(|c| c.admin_token.trim().to_string())
        .filter(|t| !t.is_empty())
        .or_else(|| std::env::var("ADMIN_TOKEN").ok().filter(|t| !t.trim().is_empty()))
        .ok_or_else(|| "admin token not configured".to_string())?;
    let base = cfg
        .as_ref()
        .map(|c| c.ingest_url.trim().to_string())
        .filter(|b| !b.is_empty())
        .or_else(|| std::env::var("INGEST_URL").ok().filter(|b| !b.trim().is_empty()))
        .unwrap_or_else(|| DEFAULT_INGEST_URL.to_string());
    Ok((token, base))
}

/// Fetch the server `LiveMonitorSnapshot` as opaque JSON. Rust does NOT model the
/// snapshot — the webview casts it to the `@420ai/shared` type. A refused/!ok upstream
/// maps to a clean `Err(String)` the panel renders (the dashboard's 502 analog).
#[tauri::command]
pub async fn get_monitor_snapshot() -> Result<serde_json::Value, String> {
    let (token, base) = monitor_credentials()?;
    let client = reqwest::Client::builder()
        .timeout(MONITOR_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;
    let res = client
        .get(monitor_url(&base))
        .bearer_auth(token) // token never crosses to the webview
        .send()
        .await
        .map_err(|e| format!("ingest unreachable: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("ingest error: {}", res.status()));
    }
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("bad snapshot: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_monitor_url_from_base() {
        assert_eq!(monitor_url("http://localhost:8420"), "http://localhost:8420/v1/monitor");
    }

    #[test]
    fn trims_a_trailing_slash_so_the_path_is_not_doubled() {
        assert_eq!(monitor_url("http://localhost:8420/"), "http://localhost:8420/v1/monitor");
    }
}
