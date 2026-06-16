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
use serde::{Deserialize, Serialize};

/// Credential-Manager service name (matches the app identifier).
const SERVICE: &str = "ai.420.desktop";
/// Non-empty user/account name. Keep it non-empty: an empty user is a wildcard on
/// macOS, so a non-empty value keeps the entry portable.
const USER: &str = "ingest-credentials";

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

/// Persist the credentials blob to the OS keychain (overwrites any prior entry).
pub fn store(c: &Stored) -> Result<(), String> {
    store_in(SERVICE, c)
}

/// Load the credentials blob, or `None` when unpaired (`Err(NoEntry)`) or corrupt.
pub fn load() -> Option<Stored> {
    load_from(SERVICE)
}

/// Remove the stored credentials (unpair). Returns `Ok` even semantics aside; the
/// caller maps any keychain error to a string.
#[allow(dead_code)]
pub fn clear() -> Result<(), String> {
    clear_in(SERVICE)
}

// --- Service-parameterized cores, so the test can use a throwaway service name and
//     never clobber the real credential. ---

fn store_in(service: &str, c: &Stored) -> Result<(), String> {
    let json = serde_json::to_string(c).map_err(|e| e.to_string())?;
    Entry::new(service, USER)
        .map_err(|e| e.to_string())?
        .set_password(&json)
        .map_err(|e| e.to_string())
}

fn load_from(service: &str) -> Option<Stored> {
    let entry = Entry::new(service, USER).ok()?;
    let json = entry.get_password().ok()?; // Err(NoEntry) when unpaired → None
    serde_json::from_str(&json).ok()
}

fn clear_in(service: &str) -> Result<(), String> {
    Entry::new(service, USER)
        .map_err(|e| e.to_string())?
        .delete_credential() // v3 name (NOT v2's delete_password)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // A distinct service name so the round-trip never touches a real credential.
    const TEST_SERVICE: &str = "ai.420.desktop.test";

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
