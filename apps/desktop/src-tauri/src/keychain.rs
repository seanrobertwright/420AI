//! OS-keychain storage for the ingest credentials (M11 Slice 3).
//!
//! The GUI pairing path stores the `{url, token, machineId}` blob in the Windows
//! Credential Manager via the `keyring` crate — NEVER in a plaintext file (the CLI
//! path's `~/.420ai/credentials.json` is untouched) and NEVER reachable from the
//! webview. The token is born in `pairing::pair` (Rust `reqwest`), stored here, and
//! read back when (re)configuring the sidecar; the keychain is the single source of
//! truth, so we never hold the token in a long-lived variable.
//!
//! All keychain ops funnel through this module: Windows CredMan does not serialize
//! concurrent writes, so single-module access from the `#[command]` handlers is the
//! safe pattern. The whole blob is one small JSON entry under one `(service, user)`
//! key, well under the ~2560-byte CredMan limit.

use keyring::Entry;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// Credential-Manager service name (matches the app identifier).
const SERVICE: &str = "ai.420.desktop";
/// Non-empty user/account name. Keep it non-empty: an empty user is a wildcard on
/// macOS, so a non-empty value keeps the entry portable.
const USER: &str = "ingest-credentials";
/// Second Credential-Manager entry under the same service: the supervised server's
/// config/secrets. A DISTINCT user from the pairing creds so the two never collide /
/// overwrite each other.
const SERVER_USER: &str = "server-config";

/// The ingest credentials blob — byte-compatible field names with the collector's
/// `Credentials` (`identity.ts`) and the `configure` control command. `machineId`
/// is camelCase on the wire, so it is renamed explicitly.
#[derive(Serialize, Deserialize, Clone)]
pub struct Stored {
    pub url: String,
    pub token: String,
    #[serde(rename = "machineId")]
    pub machine_id: String,
}

/// The supervised server's config/secrets blob (M11 Slice 4). Held ONLY in the OS
/// keychain (a second entry, separate from the pairing token), NEVER in a plaintext
/// file. Rust reads it to inject the secrets as the spawned ingest's env (which wins
/// over the repo `.env`) and to source the monitor-proxy admin token. The secret
/// fields are NEVER returned to the webview — `server.rs` maps this to a masked view.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    /// Repo/server root (non-secret) — derives the compose file + ingest dist paths.
    pub server_dir: String,
    /// Ingest base URL for the monitor proxy + health poll (non-secret).
    pub ingest_url: String,
    /// SECRET — admin bearer for `/v1/monitor`, injected as `ADMIN_TOKEN`.
    pub admin_token: String,
    /// SECRET — Postgres DSN, injected as `DATABASE_URL`.
    pub database_url: String,
    /// SECRET — field-encryption key, injected as `ARCHIVE_ENCRYPTION_KEY`.
    pub archive_encryption_key: String,
    #[serde(default)]
    pub ingest_port: Option<u16>,
    #[serde(default)]
    pub analysis_provider: Option<String>,
    /// SECRET — injected as `ANALYSIS_API_KEY` when set.
    #[serde(default)]
    pub analysis_api_key: Option<String>,
    #[serde(default)]
    pub analysis_model: Option<String>,
    #[serde(default)]
    pub analysis_base_url: Option<String>,
}

/// Persist the credentials blob to the OS keychain (overwrites any prior entry).
pub fn store(c: &Stored) -> Result<(), String> {
    store_in(SERVICE, c)
}

/// Load the credentials blob, or `None` when unpaired (`Err(NoEntry)`) or corrupt.
pub fn load() -> Option<Stored> {
    load_from(SERVICE)
}

/// Remove the stored credentials (unpair). Powers the Settings "Unpair" button (Slice
/// 4) — clears the PAIRING entry only, never the server-config entry.
pub fn clear() -> Result<(), String> {
    clear_in(SERVICE)
}

/// Persist the server-config blob (M11 Slice 4) to the second keychain entry.
pub fn store_server(c: &ServerConfig) -> Result<(), String> {
    store_in_user(SERVICE, SERVER_USER, c)
}

/// Load the server-config blob, or `None` when unconfigured / corrupt.
pub fn load_server() -> Option<ServerConfig> {
    load_from_user(SERVICE, SERVER_USER)
}

/// Remove the stored server config. Unused today (the panel never deletes the whole
/// blob — it merges), but kept symmetric with the pairing entry's `clear`.
#[allow(dead_code)]
pub fn clear_server() -> Result<(), String> {
    clear_in_user(SERVICE, SERVER_USER)
}

// --- Service+user-parameterized generic cores, so the tests can use a throwaway
//     service name and never clobber a real credential, and both the pairing `Stored`
//     blob and the `ServerConfig` blob funnel through one code path. ---

fn store_in_user<T: Serialize>(service: &str, user: &str, c: &T) -> Result<(), String> {
    let json = serde_json::to_string(c).map_err(|e| e.to_string())?;
    Entry::new(service, user)
        .map_err(|e| e.to_string())?
        .set_password(&json)
        .map_err(|e| e.to_string())
}

fn load_from_user<T: DeserializeOwned>(service: &str, user: &str) -> Option<T> {
    let entry = Entry::new(service, user).ok()?;
    let json = entry.get_password().ok()?; // Err(NoEntry) when absent → None
    serde_json::from_str(&json).ok()
}

fn clear_in_user(service: &str, user: &str) -> Result<(), String> {
    let entry = Entry::new(service, user).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // Idempotent: clearing an already-absent entry is a no-op, not an error, so
        // Unpair stays clean when invoked twice (delete_credential is v3's name).
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// The pairing-entry cores delegate to the generic ones with the pairing USER, so the
// existing call sites (and the `Stored` round-trip test) keep working unchanged.
fn store_in(service: &str, c: &Stored) -> Result<(), String> {
    store_in_user(service, USER, c)
}

fn load_from(service: &str) -> Option<Stored> {
    load_from_user(service, USER)
}

fn clear_in(service: &str) -> Result<(), String> {
    clear_in_user(service, USER)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A distinct service name so the round-trip never touches a real credential.
    const TEST_SERVICE: &str = "ai.420.desktop.test";

    #[test]
    fn server_config_set_get_delete_roundtrips() {
        let cfg = ServerConfig {
            server_dir: "C:/repo/420AI".to_string(),
            ingest_url: "http://localhost:8420".to_string(),
            admin_token: "admin_secret".to_string(),
            database_url: "postgres://420ai:420ai@localhost:5433/420ai".to_string(),
            archive_encryption_key: "base64key==".to_string(),
            ingest_port: Some(8420),
            analysis_provider: Some("anthropic".to_string()),
            analysis_api_key: Some("analysis_secret".to_string()),
            analysis_model: Some("claude-sonnet-4-6".to_string()),
            analysis_base_url: None,
        };

        store_in_user(TEST_SERVICE, SERVER_USER, &cfg).expect("store server config");

        let loaded: ServerConfig =
            load_from_user(TEST_SERVICE, SERVER_USER).expect("load after store");
        assert_eq!(loaded.server_dir, cfg.server_dir);
        assert_eq!(loaded.ingest_url, cfg.ingest_url);
        assert_eq!(loaded.admin_token, cfg.admin_token);
        assert_eq!(loaded.database_url, cfg.database_url);
        assert_eq!(loaded.archive_encryption_key, cfg.archive_encryption_key);
        assert_eq!(loaded.ingest_port, Some(8420));
        assert_eq!(loaded.analysis_provider.as_deref(), Some("anthropic"));
        assert_eq!(loaded.analysis_api_key.as_deref(), Some("analysis_secret"));
        assert_eq!(loaded.analysis_base_url, None);

        clear_in_user(TEST_SERVICE, SERVER_USER).expect("clear");
        let gone: Option<ServerConfig> = load_from_user(TEST_SERVICE, SERVER_USER);
        assert!(gone.is_none(), "load after clear is None");
    }

    #[test]
    fn keychain_set_get_delete_roundtrips() {
        let creds = Stored {
            url: "http://localhost:8420".to_string(),
            token: "tok_test_value".to_string(),
            machine_id: "machine-123".to_string(),
        };

        store_in(TEST_SERVICE, &creds).expect("store");

        let loaded = load_from(TEST_SERVICE).expect("load after store");
        assert_eq!(loaded.url, creds.url);
        assert_eq!(loaded.token, creds.token);
        assert_eq!(loaded.machine_id, creds.machine_id);

        clear_in(TEST_SERVICE).expect("clear");
        assert!(load_from(TEST_SERVICE).is_none(), "load after clear is None");
    }
}
