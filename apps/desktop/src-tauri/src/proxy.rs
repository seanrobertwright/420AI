//! Server-side monitor proxy (M11 Slice 2).
//!
//! The webview never holds the API key — it calls this `#[command]`, and Rust
//! (the privileged hop) fetches the admin-gated ingest `/v1/monitor` endpoint with
//! the bearer added here. This mirrors the dashboard's `app/api/monitor/route.ts`
//! proxy, with Rust as the token-holder instead of the Next server.
//!
//! Token + base come from the SERVER-CONFIG KEYCHAIN (Slice 4) — `apiKey` /
//! `ingestUrl` — falling back to PROCESS ENV (`API_KEY` / `INGEST_URL`) when the
//! keychain holds no server config, so a headless/dev run behaves exactly as before
//! (mirrors the dashboard's `apps/dashboard/src/lib/ingest.ts` env path). `/v1/monitor`
//! is principal-gated at `viewer`, so the saved per-machine INGEST credentials would 401 —
//! they authenticate a machine, not a person. If neither the keychain nor the env supplies a
//! key the command returns `Err`, and the panel degrades to local-status-only. The
//! key is NEVER logged and NEVER returned to the webview.
//!
//! M15 15.9 (D-M15-7) replaced `ADMIN_TOKEN` here with a per-user API KEY. The practical
//! difference for this app: the credential it holds is now attributable to a person, capped at
//! that person's rung, and revocable ON ITS OWN — so a stolen laptop no longer means rotating a
//! secret every other client shares. A `viewer` key is sufficient for this panel.

use std::time::Duration;

const DEFAULT_INGEST_URL: &str = "http://localhost:8420";
const MONITOR_TIMEOUT: Duration = Duration::from_secs(10);

/// Build the monitor URL from a base (pure + unit-testable; no env, no I/O).
fn monitor_url(base: &str) -> String {
    format!("{}/v1/monitor", base.trim_end_matches('/'))
}

/// Resolve the API-key bearer + ingest base, preferring the server-config keychain
/// (Slice 4) and falling back to process env (headless/dev). An empty keychain string
/// is treated as unset (so we never send an empty bearer / a blank base) — the Rust
/// equivalent of the `||`-not-`??` rule the JS side follows for the same reason.
/// Returns `Err` only when NEITHER source supplies a key.
///
/// M15 15.9 (D-M15-7) — this reads `api_key` / `API_KEY`, and there is deliberately NO fallback to
/// `admin_token` / `ADMIN_TOKEN`. That fallback was correct while both credentials worked; the
/// server now accepts no `ADMIN_TOKEN` at all, so falling back to one would replace this
/// actionable message with an opaque 401 in the Sync & Health panel.
fn monitor_credentials() -> Result<(String, String), String> {
    let cfg = crate::keychain::load_server();
    let token = cfg
        .as_ref()
        .map(|c| c.api_key.trim().to_string())
        .filter(|t| !t.is_empty())
        .or_else(|| std::env::var("API_KEY").ok().filter(|t| !t.trim().is_empty()))
        .ok_or_else(|| {
            // NAME A REMEDY THAT EXISTS. An earlier draft pointed at a dashboard "Settings →
            // API keys" page that did not exist, so the one message an operator sees when this
            // degrades named a screen that was not there. M15 15.10 SHIPPED that page, so the
            // remedy is now the real one — keep it pointing at the page rather than at the raw
            // endpoint, which is what a user has to be told to curl when there is no UI.
            "API key not configured. Mint one at Settings → API keys on the dashboard, then \
             paste it into Settings here. See docs/guide/operations.md §15.9. ADMIN_TOKEN was \
             retired in M15 15.9."
                .to_string()
        })?;
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
