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
//! secret every other client shares.
//!
//! M16 16.2 (D-16.2-4) — THE REQUIRED RUNG ROSE FROM `viewer` TO `member`, and this paragraph
//! replaces the line that said "a `viewer` key is sufficient for this panel". That was true while
//! this file only ever READ `/v1/monitor`. It now also WRITES: `post_session_label` records the
//! §4.3 outcome label, and writes are `member`-gated (D-16.1-4).
//!
//! A stale comment asserting a WEAKER requirement is the M15 15.5 defect class — the next reader
//! trusts it instead of re-deriving it — so it is corrected here rather than left to rot, and
//! `docs/guide/operations.md` is corrected with it.
//!
//! The failure mode is HANDLED, not hidden: a `viewer` key still loads the queue (a read) and 403s
//! the submit, so the panel renders the mint-a-`member`-key remedy rather than a bare status code.

use std::time::Duration;

const DEFAULT_INGEST_URL: &str = "http://localhost:8420";
const MONITOR_TIMEOUT: Duration = Duration::from_secs(10);

/// Build the monitor URL from a base (pure + unit-testable; no env, no I/O).
fn monitor_url(base: &str) -> String {
    format!("{}/v1/monitor", base.trim_end_matches('/'))
}

/// Join a base and an already-encoded path suffix (pure + unit-testable; no env, no I/O).
///
/// `suffix` MUST start with `/` and MUST already be percent-encoded where needed — see
/// `session_label_path`, which is the only caller that has anything to encode.
fn ingest_path(base: &str, suffix: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), suffix)
}

/// Percent-encode one path SEGMENT: everything outside the RFC 3986 unreserved set.
///
/// WHY THIS EXISTS AT ALL, given `monitor_url` never needed it: `session_id` is a
/// CONNECTOR-SUPPLIED string, not a uuid (the ingest route makes the same note — its existence
/// guard is `sessionDetail`, deliberately not `isUuid`). It can legally carry `/`, `?`, `#` or a
/// space, any of which would silently retarget the request — a `/` would address a different route
/// entirely and a `?` would turn the rest of the id into a querystring that
/// `additionalProperties: false` then strips. Encoding is the difference between a 404 and a
/// request against the wrong endpoint.
///
/// Hand-rolled rather than pulling in `urlencoding`: this is one closed rule over ASCII, and the
/// slice's no-new-dependency constraint is worth more than the crate. `char::is_ascii_alphanumeric`
/// plus the four unreserved marks is the whole set; every other byte goes out as `%XX`, which is
/// correct for multi-byte UTF-8 because it encodes the BYTES.
fn encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.as_bytes() {
        let c = *byte as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            out.push(c);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Build `/v1/sessions/{encoded}/label` (pure + unit-testable).
fn session_label_path(base: &str, session_id: &str) -> String {
    ingest_path(base, &format!("/v1/sessions/{}/label", encode_segment(session_id)))
}

/// Build `/v1/labels/queue` (pure + unit-testable).
fn label_queue_path(base: &str) -> String {
    ingest_path(base, "/v1/labels/queue")
}

/// Resolve the API-key bearer + ingest base for ANY ingest hop this file makes.
///
/// Renamed from `monitor_credentials` in M16 16.2: it is no longer monitor-only — the label queue
/// and the label write use the same credential and the same resolution order.
///
/// Preferring the server-config keychain
/// (Slice 4) and falling back to process env (headless/dev). An empty keychain string
/// is treated as unset (so we never send an empty bearer / a blank base) — the Rust
/// equivalent of the `||`-not-`??` rule the JS side follows for the same reason.
/// Returns `Err` only when NEITHER source supplies a key.
///
/// M15 15.9 (D-M15-7) — this reads `api_key` / `API_KEY`, and there is deliberately NO fallback to
/// `admin_token` / `ADMIN_TOKEN`. That fallback was correct while both credentials worked; the
/// server now accepts no `ADMIN_TOKEN` at all, so falling back to one would replace this
/// actionable message with an opaque 401 in the Sync & Health panel.
fn ingest_credentials() -> Result<(String, String), String> {
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
    let (token, base) = ingest_credentials()?;
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

/// Shared client builder — same timeout and no-redirect policy for every hop in this file.
///
/// `redirect::Policy::none()` matters more for the WRITE than it did for the read: a followed
/// redirect re-sends the `Authorization` header to whatever host the response names, which is how
/// a bearer leaves the machine it was minted for.
fn ingest_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(MONITOR_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("http client init failed: {e}"))
}

/// Map a non-success response to a message the panel can act on.
///
/// A 403 IS NOT A GENERIC ERROR HERE — it is D-16.2-4's one predictable failure: the configured
/// API key is a `viewer`, which can read the queue but cannot write a label. Naming the remedy is
/// the whole point, because "ingest error: 403" tells the operator nothing they can do.
fn label_write_error(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        403 => "This API key is read-only. Mint a `member` key at Settings → API keys on the \
                dashboard, then paste it into Settings here."
            .to_string(),
        409 => "That session already has a label. Edit it from the dashboard’s Labels page."
            .to_string(),
        404 => "That session is not in the archive.".to_string(),
        _ => format!("ingest error: {status}"),
    }
}

/// Fetch the settled/unlabeled session queue as opaque JSON (M16 16.2).
///
/// Rust does NOT model the row — the webview casts it to `LabelQueueRow` from `@420ai/shared`,
/// exactly as `get_monitor_snapshot` does for the snapshot. `viewer`-gated upstream, so this
/// succeeds with any key the panel can be configured with; only the WRITE below needs `member`.
#[tauri::command]
pub async fn get_label_queue() -> Result<serde_json::Value, String> {
    let (token, base) = ingest_credentials()?;
    let res = ingest_client()?
        .get(label_queue_path(&base))
        .bearer_auth(token) // token never crosses to the webview
        .send()
        .await
        .map_err(|e| format!("ingest unreachable: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("ingest error: {}", res.status()));
    }
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("bad queue: {e}"))
}

/// Record a §4.3 outcome label, or a SKIP, for one session (M16 16.2).
///
/// `body` is passed through opaquely — the webview builds it from the shared closed sets and the
/// ingest route's ajv enums are the enforcement, so re-modelling the six fields in Rust would add a
/// third place for the value sets to drift without adding a check the server does not already make.
///
/// `member`-gated upstream (D-16.1-4 / D-16.2-4); a `viewer` key gets the actionable 403 message.
#[tauri::command]
pub async fn post_session_label(
    session_id: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let (token, base) = ingest_credentials()?;
    let res = ingest_client()?
        .post(session_label_path(&base, &session_id))
        .bearer_auth(token) // token never crosses to the webview
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("ingest unreachable: {e}"))?;
    if !res.status().is_success() {
        return Err(label_write_error(res.status()));
    }
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("bad label response: {e}"))
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

    #[test]
    fn builds_the_label_queue_path_and_trims_a_trailing_slash() {
        assert_eq!(
            label_queue_path("http://localhost:8420"),
            "http://localhost:8420/v1/labels/queue"
        );
        assert_eq!(
            label_queue_path("http://localhost:8420/"),
            "http://localhost:8420/v1/labels/queue"
        );
    }

    #[test]
    fn builds_the_session_label_path_and_trims_a_trailing_slash() {
        assert_eq!(
            session_label_path("http://localhost:8420", "sess-abc"),
            "http://localhost:8420/v1/sessions/sess-abc/label"
        );
        assert_eq!(
            session_label_path("http://localhost:8420/", "sess-abc"),
            "http://localhost:8420/v1/sessions/sess-abc/label"
        );
    }

    /// `session_id` is CONNECTOR-SUPPLIED, not a uuid — see `encode_segment`'s doc comment. A `/`
    /// left raw would address a different route; a `?` would turn the rest into a querystring.
    #[test]
    fn percent_encodes_a_session_id_that_is_not_path_safe() {
        assert_eq!(
            session_label_path("http://localhost:8420", "a/b"),
            "http://localhost:8420/v1/sessions/a%2Fb/label"
        );
        assert_eq!(
            session_label_path("http://localhost:8420", "a?b#c"),
            "http://localhost:8420/v1/sessions/a%3Fb%23c/label"
        );
        assert_eq!(
            session_label_path("http://localhost:8420", "with space"),
            "http://localhost:8420/v1/sessions/with%20space/label"
        );
    }

    /// The unreserved set passes through unchanged, so ordinary ids stay readable in a log.
    #[test]
    fn leaves_the_rfc3986_unreserved_set_alone() {
        assert_eq!(encode_segment("aZ09-_.~"), "aZ09-_.~");
    }

    /// Multi-byte UTF-8 encodes per BYTE, which is what RFC 3986 requires.
    #[test]
    fn encodes_multibyte_utf8_per_byte() {
        assert_eq!(encode_segment("é"), "%C3%A9");
    }

    /// D-16.2-4 — a `viewer` key is the one predictable failure, so it names a remedy rather than
    /// echoing a status code.
    #[test]
    fn a_403_names_the_remedy_instead_of_the_status() {
        let msg = label_write_error(reqwest::StatusCode::FORBIDDEN);
        assert!(msg.contains("read-only"));
        assert!(msg.contains("member"));
        assert!(!msg.contains("403"));
    }

    #[test]
    fn other_statuses_fall_through_to_a_plain_message() {
        assert!(label_write_error(reqwest::StatusCode::CONFLICT).contains("already has a label"));
        assert!(label_write_error(reqwest::StatusCode::INTERNAL_SERVER_ERROR).contains("500"));
    }
}
