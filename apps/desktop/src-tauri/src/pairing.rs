//! GUI pairing in Rust (M11 Slice 3).
//!
//! The webview calls `pair(url, code, name)`; Rust does the HTTP handshake itself
//! (mirroring `proxy.rs`'s reqwest pattern) against the UNAUTHENTICATED `/v1/pair`
//! (`pair.ts` — "the code IS the credential, no bearer"), stores the issued token in
//! the OS keychain, and injects the credentials into the running sidecar via the
//! already-implemented `configure` control command. The token is born here and NEVER
//! crosses stdout, the webview, or disk — `pair`/`get_pairing_status` return only the
//! `machineId`. The sidecar's reserved `pair` command stays unsupported by design.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{keychain, sidecar};

/// `PairRequest` mirror (`packages/shared/src/ingest.ts`). Field names match the wire
/// exactly — a mismatch is a silent 400 from ingest's `pairBodySchema`.
#[derive(Serialize)]
struct PairRequest {
    code: String,
    machine: Machine,
}

#[derive(Serialize)]
struct Machine {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    os: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hostname: Option<String>,
}

/// `PairResponse` mirror — `camelCase` so `machine_id` ⇄ `machineId`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    token: String,
    machine_id: String,
}

/// The webview-facing pair result — `machineId` ONLY. The token is intentionally
/// absent (it lives in the keychain, never returned to the webview).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResult {
    machine_id: String,
}

/// Current keychain pairing state for the panel. Carries no token.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatus {
    paired: bool,
    machine_id: Option<String>,
}

/// Build the pair URL from a base (pure + unit-testable; mirrors `proxy.rs::monitor_url`
/// and the collector's `ingest-client.ts` `${base}/v1/pair`, trailing-slash trimmed).
fn pair_url(base: &str) -> String {
    format!("{}/v1/pair", base.trim_end_matches('/'))
}

/// Pair this machine: POST the code to `/v1/pair` (Rust holds the HTTP hop), store the
/// issued token in the keychain, and `configure` the running sidecar with the creds.
/// Returns only the `machineId`. A non-2xx (e.g. 410 for an expired code) → `Err`.
#[tauri::command]
pub async fn pair(
    app: tauri::AppHandle,
    url: String,
    code: String,
    name: String,
) -> Result<PairResult, String> {
    let base = url.trim().trim_end_matches('/').to_string();
    let computer_name = std::env::var("COMPUTERNAME").ok();
    // The ingest contract requires machine.name (minLength 1) — an empty name is a 400,
    // not a friendly error. Fall back to the computer name when the form is left blank
    // (mirrors the CLI's `--name ?? osHostname()`, cli.ts:349, and the form's placeholder).
    let name = if name.trim().is_empty() {
        computer_name.clone().unwrap_or_else(|| "desktop-collector".to_string())
    } else {
        name
    };
    let body = PairRequest {
        code,
        machine: Machine {
            name,
            os: Some(std::env::consts::OS.to_string()),
            hostname: computer_name,
        },
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;
    let res = client
        .post(pair_url(&base))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("ingest unreachable: {e}"))?;
    // reqwest does NOT error on 4xx/5xx — the explicit check is load-bearing: a 410
    // (expired/invalid code, pair.ts:35-37) would otherwise fall through to a JSON error.
    if !res.status().is_success() {
        return Err(format!("pairing failed: HTTP {}", res.status()));
    }
    let paired: PairResponse = res
        .json()
        .await
        .map_err(|e| format!("bad pair response: {e}"))?;

    // Store the secret in the OS keychain — NEVER on disk, NEVER returned to the webview.
    keychain::store(&keychain::Stored {
        url: base.clone(),
        token: paired.token,
        machine_id: paired.machine_id.clone(),
    })?;

    // Inject into the running sidecar via the existing `configure` command. Read the
    // token BACK from the keychain (the single source of truth) rather than holding it
    // in a long-lived variable. A failure here is non-fatal: the next sidecar `ready`
    // re-configures from the keychain (sidecar.rs auto-configure hook).
    if let Some(creds) = keychain::load() {
        let _ = sidecar::write_command(
            &app,
            json!({
                "cmd": "configure",
                "url": creds.url,
                "token": creds.token,
                "machineId": creds.machine_id,
            }),
        );
    }

    Ok(PairResult {
        machine_id: paired.machine_id,
    })
}

/// Report whether this machine is paired (keychain has creds) and its `machineId`.
/// The token is never included.
#[tauri::command]
pub fn get_pairing_status() -> PairingStatus {
    match keychain::load() {
        Some(c) => PairingStatus {
            paired: true,
            machine_id: Some(c.machine_id),
        },
        None => PairingStatus {
            paired: false,
            machine_id: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_pair_url_from_base() {
        assert_eq!(pair_url("http://localhost:8420"), "http://localhost:8420/v1/pair");
    }

    #[test]
    fn trims_a_trailing_slash_so_the_path_is_not_doubled() {
        assert_eq!(pair_url("http://localhost:8420/"), "http://localhost:8420/v1/pair");
    }
}
