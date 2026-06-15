//! Server-side monitor proxy (M11 Slice 2).
//!
//! The webview never holds the admin token — it calls this `#[command]`, and Rust
//! (the privileged hop) fetches the admin-gated ingest `/v1/monitor` endpoint with
//! the bearer added here. This mirrors the dashboard's `app/api/monitor/route.ts`
//! proxy, with Rust as the token-holder instead of the Next server.
//!
//! Token + base come from PROCESS ENV (`ADMIN_TOKEN` / `INGEST_URL`), exactly like
//! the dashboard (`apps/dashboard/src/lib/ingest.ts`). `/v1/monitor` is admin-gated,
//! so the saved per-machine ingest credentials would 401 — the admin token is the
//! only correct source (Slice 3/4 migrates it into the Credential Manager + Settings).
//! If `ADMIN_TOKEN` is unset the command returns `Err`, and the panel degrades to
//! local-status-only. The token is NEVER logged and NEVER returned to the webview.

use std::time::Duration;

const DEFAULT_INGEST_URL: &str = "http://localhost:8420";
const MONITOR_TIMEOUT: Duration = Duration::from_secs(10);

/// Build the monitor URL from a base (pure + unit-testable; no env, no I/O).
fn monitor_url(base: &str) -> String {
    format!("{}/v1/monitor", base.trim_end_matches('/'))
}

/// Fetch the server `LiveMonitorSnapshot` as opaque JSON. Rust does NOT model the
/// snapshot — the webview casts it to the `@420ai/shared` type. A refused/!ok upstream
/// maps to a clean `Err(String)` the panel renders (the dashboard's 502 analog).
#[tauri::command]
pub async fn get_monitor_snapshot() -> Result<serde_json::Value, String> {
    let token = std::env::var("ADMIN_TOKEN").map_err(|_| "admin token not configured".to_string())?;
    let base = std::env::var("INGEST_URL").unwrap_or_else(|_| DEFAULT_INGEST_URL.to_string());
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
