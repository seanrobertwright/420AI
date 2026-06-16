//! Full local server-stack supervision (M11 Slice 4).
//!
//! Rust is the privileged orchestrator (mirroring Slices 2-3 where Rust holds the
//! token): it edits the server-config keychain entry, and starts/stops/health-checks
//! BOTH the Docker Postgres archive (`docker compose`) and the ingest Node process
//! (`node <serverDir>/apps/ingest/dist/server.js`). The ingest's secrets are injected
//! as that process's ENVIRONMENT — which wins over the repo `.env` (dotenv
//! `override:false`), so NO plaintext secret is ever written to disk (spike-proven
//! 2026-06-16). `docker`/`node` are spawned directly via `std::process::Command`
//! (Resolution #1) — NOT the shell plugin and NOT a sidecar — so no capability entry
//! is needed.
//!
//! Secret discipline: secrets live only in the keychain; `get_server_config` returns a
//! MASKED view (presence booleans, never the secret strings — same as `PairResult`
//! carrying no token). The injected env is NEVER logged or `Debug`-printed.

use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::keychain::{self, ServerConfig};

const DEFAULT_INGEST_URL: &str = "http://localhost:8420";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(5);

/// Supervision state: the live ingest child (a one-shot managed `std::process::Child`,
/// killed on app exit — simpler than the sidecar's restart loop and sufficient for a
/// local server) + a shutdown latch (set on `RunEvent::Exit`).
#[derive(Default)]
pub struct ServerState {
    ingest: Mutex<Option<Child>>,
    shutting_down: AtomicBool,
}

/// The webview-facing server config — NO secret values, only presence booleans + the
/// non-secret fields (token-isolation invariant, same discipline as `PairResult`).
/// `Debug` is safe to derive precisely because it holds no secret (asserted by a test).
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfigView {
    pub server_dir: String,
    pub ingest_url: String,
    pub has_admin_token: bool,
    pub has_database_url: bool,
    pub has_archive_encryption_key: bool,
    pub has_analysis_api_key: bool,
    pub ingest_port: Option<u16>,
    pub analysis_provider: Option<String>,
    pub analysis_model: Option<String>,
    pub analysis_base_url: Option<String>,
}

/// What the Settings form SENDS. Secrets are optional: a blank/absent secret means
/// "leave unchanged" (merge against the loaded blob) so re-saving non-secret prefs
/// never wipes a secret the webview can't see.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfigInput {
    pub server_dir: String,
    pub ingest_url: String,
    #[serde(default)]
    pub admin_token: Option<String>,
    #[serde(default)]
    pub database_url: Option<String>,
    #[serde(default)]
    pub archive_encryption_key: Option<String>,
    #[serde(default)]
    pub ingest_port: Option<u16>,
    #[serde(default)]
    pub analysis_provider: Option<String>,
    #[serde(default)]
    pub analysis_api_key: Option<String>,
    #[serde(default)]
    pub analysis_model: Option<String>,
    #[serde(default)]
    pub analysis_base_url: Option<String>,
}

/// Health of both halves of the stack: the archive's compose state/health string and
/// whether the ingest `/v1/health` probe succeeded.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerHealth {
    /// `healthy` | `running` | `stopped` | `unknown` (from `docker compose ps`).
    pub archive: String,
    /// `true` when `GET <ingestUrl>/v1/health` returned 2xx.
    pub ingest: bool,
}

// --- Pure helpers (unit-tested; no env, no I/O) ---

/// Build the `docker compose -f <serverDir>/docker-compose.yml <tail…>` argv.
fn compose_args(server_dir: &str, tail: &[&str]) -> Vec<String> {
    let mut v = vec![
        "compose".to_string(),
        "-f".to_string(),
        format!("{server_dir}/docker-compose.yml"),
    ];
    v.extend(tail.iter().map(|s| s.to_string()));
    v
}

/// Build the ingest health URL from a base (mirrors `proxy::monitor_url`'s trailing
/// slash trim so the path is never doubled).
fn health_url(base: &str) -> String {
    format!("{}/v1/health", base.trim_end_matches('/'))
}

/// Parse `docker compose ps --format json` (NDJSON — one object per line) for the
/// archive's health. Prefers the `Health` field (`healthy`), falls back to `State`
/// (`running`); no archive line ⇒ `stopped` (not up).
fn parse_archive_health(ps_json_lines: &str) -> String {
    for line in ps_json_lines.lines().filter(|l| !l.trim().is_empty()) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if v.get("Service").and_then(|s| s.as_str()) == Some("archive") {
                return v
                    .get("Health")
                    .and_then(|h| h.as_str())
                    .filter(|h| !h.is_empty())
                    .or_else(|| v.get("State").and_then(|s| s.as_str()))
                    .unwrap_or("unknown")
                    .to_string();
            }
        }
    }
    "stopped".into()
}

/// Build the env the supervised ingest needs. The required trio MUST be present
/// (`set_server_config` + the keychain guarantee it once configured). Optionals are
/// added only when set. NEVER log the result — it carries the live secrets.
fn ingest_env(cfg: &ServerConfig) -> Result<Vec<(String, String)>, String> {
    if cfg.database_url.trim().is_empty() {
        return Err("DATABASE_URL not configured".into());
    }
    if cfg.admin_token.trim().is_empty() {
        return Err("ADMIN_TOKEN not configured".into());
    }
    if cfg.archive_encryption_key.trim().is_empty() {
        return Err("ARCHIVE_ENCRYPTION_KEY not configured".into());
    }
    let mut env = vec![
        ("DATABASE_URL".to_string(), cfg.database_url.clone()),
        ("ADMIN_TOKEN".to_string(), cfg.admin_token.clone()),
        (
            "ARCHIVE_ENCRYPTION_KEY".to_string(),
            cfg.archive_encryption_key.clone(),
        ),
    ];
    if let Some(port) = cfg.ingest_port {
        env.push(("INGEST_PORT".to_string(), port.to_string()));
    }
    let opt = |key: &str, val: &Option<String>, env: &mut Vec<(String, String)>| {
        if let Some(v) = val.as_deref().filter(|s| !s.is_empty()) {
            env.push((key.to_string(), v.to_string()));
        }
    };
    opt("ANALYSIS_PROVIDER", &cfg.analysis_provider, &mut env);
    opt("ANALYSIS_API_KEY", &cfg.analysis_api_key, &mut env);
    opt("ANALYSIS_MODEL", &cfg.analysis_model, &mut env);
    opt("ANALYSIS_BASE_URL", &cfg.analysis_base_url, &mut env);
    Ok(env)
}

/// Map the stored config to the masked, secret-free view.
fn to_view(c: ServerConfig) -> ServerConfigView {
    let present = |s: &str| !s.trim().is_empty();
    ServerConfigView {
        has_admin_token: present(&c.admin_token),
        has_database_url: present(&c.database_url),
        has_archive_encryption_key: present(&c.archive_encryption_key),
        has_analysis_api_key: c.analysis_api_key.as_deref().is_some_and(present),
        server_dir: c.server_dir,
        ingest_url: c.ingest_url,
        ingest_port: c.ingest_port,
        analysis_provider: c.analysis_provider,
        analysis_model: c.analysis_model,
        analysis_base_url: c.analysis_base_url,
    }
}

/// A blank/absent SECRET field means "leave unchanged" (the webview can't see it, so a
/// re-save of non-secret prefs must not wipe it). A non-blank value replaces (trimmed
/// to drop copy-paste whitespace that would corrupt an injected env var).
fn merge_secret(input: Option<String>, existing: String) -> String {
    match input {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => existing,
    }
}

fn merge_secret_opt(input: Option<String>, existing: Option<String>) -> Option<String> {
    match input {
        Some(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => existing,
    }
}

/// A NON-secret optional the webview CAN see (it round-trips in the view): an explicit
/// empty string clears it; an absent field keeps the existing value.
fn merge_optional(input: Option<String>, existing: Option<String>) -> Option<String> {
    match input {
        Some(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        None => existing,
    }
}

// --- Process orchestration (sync one-shots — short `docker` calls; the ingest spawn
//     returns immediately) ---

/// Run a `docker …` one-shot, mapping a missing binary or a non-zero exit to a clean,
/// panel-renderable `Err`. NEVER silent.
fn run_docker(args: &[String]) -> Result<(), String> {
    let output = Command::new("docker").args(args).output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "Docker not installed/not running (docker not found on PATH)".to_string()
        } else {
            format!("failed to run docker: {e}")
        }
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!("docker exited with status {}", output.status)
        } else {
            stderr
        };
        return Err(format!("Docker error: {msg}"));
    }
    Ok(())
}

/// Best-effort `docker compose ps --format json` stdout (empty string on any failure —
/// the caller treats "no archive line" as `stopped`).
fn docker_ps_json(server_dir: &str) -> String {
    let args = compose_args(server_dir, &["ps", "--format", "json"]);
    match Command::new("docker").args(&args).output() {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).to_string(),
        _ => String::new(),
    }
}

/// Best-effort ingest liveness probe (`GET /v1/health`, unauthenticated). Any failure
/// ⇒ `false`, never an `Err` (health is a status display, not a fallible command).
async fn probe_ingest(base: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(HEALTH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client.get(health_url(base)).send().await {
        Ok(res) => res.status().is_success(),
        Err(_) => false,
    }
}

// --- Commands ---

/// Return the MASKED server config (presence booleans for secrets; never the secret
/// strings), or `None` when unconfigured.
#[tauri::command]
pub fn get_server_config() -> Option<ServerConfigView> {
    keychain::load_server().map(to_view)
}

/// Persist the server config, merging blank secret fields against the existing blob
/// (so the webview, which can't see a secret, never wipes it by re-saving).
#[tauri::command]
pub fn set_server_config(cfg: ServerConfigInput) -> Result<(), String> {
    let server_dir = cfg.server_dir.trim().to_string();
    if server_dir.is_empty() {
        return Err("serverDir is required".into());
    }
    let ingest_url = cfg.ingest_url.trim().to_string();
    if ingest_url.is_empty() {
        return Err("ingestUrl is required".into());
    }
    reqwest::Url::parse(&ingest_url).map_err(|e| format!("ingestUrl is not a valid URL: {e}"))?;

    let existing = keychain::load_server().unwrap_or_default();
    let merged = ServerConfig {
        server_dir,
        ingest_url,
        admin_token: merge_secret(cfg.admin_token, existing.admin_token),
        database_url: merge_secret(cfg.database_url, existing.database_url),
        archive_encryption_key: merge_secret(
            cfg.archive_encryption_key,
            existing.archive_encryption_key,
        ),
        ingest_port: cfg.ingest_port.or(existing.ingest_port),
        analysis_provider: merge_optional(cfg.analysis_provider, existing.analysis_provider),
        analysis_api_key: merge_secret_opt(cfg.analysis_api_key, existing.analysis_api_key),
        analysis_model: merge_optional(cfg.analysis_model, existing.analysis_model),
        analysis_base_url: merge_optional(cfg.analysis_base_url, existing.analysis_base_url),
    };
    keychain::store_server(&merged)
}

/// Start the Docker Postgres archive (`docker compose up -d archive`).
#[tauri::command]
pub async fn start_archive() -> Result<(), String> {
    let cfg = keychain::load_server().ok_or("server not configured")?;
    run_docker(&compose_args(&cfg.server_dir, &["up", "-d", "archive"]))
}

/// Stop the Docker archive (`docker compose down`). The `archive-data` volume persists,
/// so the data is safe across a down/up.
#[tauri::command]
pub async fn stop_archive() -> Result<(), String> {
    let cfg = keychain::load_server().ok_or("server not configured")?;
    run_docker(&compose_args(&cfg.server_dir, &["down"]))
}

/// Start the ingest Node process with the keychain secrets injected as env (which win
/// over the repo `.env` — nothing written to disk). Errors clearly if the dist isn't
/// built or `node` is not on PATH.
#[tauri::command]
pub async fn start_ingest(app: tauri::AppHandle) -> Result<(), String> {
    let cfg = keychain::load_server().ok_or("server not configured")?;
    let dist = format!("{}/apps/ingest/dist/server.js", cfg.server_dir);
    if !std::path::Path::new(&dist).exists() {
        return Err(format!(
            "ingest not built — run `npm run build` in {} (missing {dist})",
            cfg.server_dir
        ));
    }
    let env = ingest_env(&cfg)?;
    let child = Command::new("node")
        .arg(&dist)
        .current_dir(&cfg.server_dir) // so node_modules (@420ai/db, fastify, …) resolve
        .envs(env) // SECRETS injected as env — win over .env, never on disk. NEVER logged.
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "failed to start ingest: node not found on PATH".to_string()
            } else {
                format!("failed to start ingest: {e}")
            }
        })?;

    let state = app.state::<ServerState>();
    let mut guard = state.ingest.lock().map_err(|e| e.to_string())?;
    // Defensive: replace (and reap) any stale child so we never leak a process.
    if let Some(mut old) = guard.take() {
        let _ = old.kill();
        let _ = old.wait();
    }
    *guard = Some(child);
    Ok(())
}

/// Stop the supervised ingest child (kill + reap — no zombie).
#[tauri::command]
pub async fn stop_ingest(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<ServerState>();
    let mut guard = state.ingest.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        child.kill().map_err(|e| format!("failed to stop ingest: {e}"))?;
        let _ = child.wait(); // reap so no zombie lingers
    }
    Ok(())
}

/// Poll both halves of the stack. Both probes are best-effort — a failed probe maps to
/// `stopped`/`false`, never an `Err` (this is a status display).
#[tauri::command]
pub async fn get_server_health() -> ServerHealth {
    let cfg = keychain::load_server();
    let archive = match &cfg {
        Some(c) => parse_archive_health(&docker_ps_json(&c.server_dir)),
        None => "stopped".to_string(),
    };
    let base = cfg
        .as_ref()
        .map(|c| c.ingest_url.clone())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_INGEST_URL.to_string());
    let ingest = probe_ingest(&base).await;
    ServerHealth { archive, ingest }
}

/// Unpair: clear the PAIRING keychain entry (Slice-3 deferred a GUI unpair). The
/// server-config entry is untouched; the CLI `~/.420ai/credentials.json` path is
/// unaffected.
#[tauri::command]
pub fn unpair() -> Result<(), String> {
    keychain::clear()
}

/// On app exit: latch `shutting_down` and kill+reap the ingest child (no zombie). The
/// `docker` containers are intentionally left running (data persists) unless the user
/// pressed Stop Archive.
pub fn shutdown<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<ServerState>();
    state.shutting_down.store(true, Ordering::Relaxed);
    // Bind the guard directly (don't hold the `lock()` Result temporary across the
    // block — that outlives `state` and trips E0597).
    let mut guard = match state.ingest.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_args_builds_the_up_invocation() {
        let args = compose_args("C:/repo", &["up", "-d", "archive"]);
        assert_eq!(
            args,
            vec![
                "compose".to_string(),
                "-f".to_string(),
                "C:/repo/docker-compose.yml".to_string(),
                "up".to_string(),
                "-d".to_string(),
                "archive".to_string(),
            ]
        );
    }

    #[test]
    fn compose_args_builds_the_down_invocation() {
        let args = compose_args("/srv/420ai", &["down"]);
        assert_eq!(args.last().unwrap(), "down");
        assert_eq!(args[2], "/srv/420ai/docker-compose.yml");
    }

    #[test]
    fn health_url_appends_the_path() {
        assert_eq!(health_url("http://localhost:8420"), "http://localhost:8420/v1/health");
    }

    #[test]
    fn health_url_trims_a_trailing_slash() {
        assert_eq!(health_url("http://localhost:8420/"), "http://localhost:8420/v1/health");
    }

    #[test]
    fn parse_health_prefers_health_field() {
        let line = r#"{"Service":"archive","State":"running","Health":"healthy","Name":"420ai-archive"}"#;
        assert_eq!(parse_archive_health(line), "healthy");
    }

    #[test]
    fn parse_health_falls_back_to_state_when_health_empty() {
        let line = r#"{"Service":"archive","State":"running","Health":""}"#;
        assert_eq!(parse_archive_health(line), "running");
    }

    #[test]
    fn parse_health_falls_back_to_state_when_no_health_key() {
        let line = r#"{"Service":"archive","State":"running"}"#;
        assert_eq!(parse_archive_health(line), "running");
    }

    #[test]
    fn parse_health_ignores_other_services_and_reports_stopped() {
        // NDJSON with only a non-archive service ⇒ the archive is not up.
        let lines = "{\"Service\":\"other\",\"State\":\"running\",\"Health\":\"healthy\"}\n";
        assert_eq!(parse_archive_health(lines), "stopped");
    }

    #[test]
    fn parse_health_empty_input_is_stopped() {
        assert_eq!(parse_archive_health(""), "stopped");
        assert_eq!(parse_archive_health("   \n  \n"), "stopped");
    }

    #[test]
    fn parse_health_finds_archive_among_multiple_lines() {
        let lines = concat!(
            "{\"Service\":\"other\",\"State\":\"exited\"}\n",
            "{\"Service\":\"archive\",\"State\":\"running\",\"Health\":\"healthy\"}\n"
        );
        assert_eq!(parse_archive_health(lines), "healthy");
    }

    fn sample_config() -> ServerConfig {
        ServerConfig {
            server_dir: "C:/repo".to_string(),
            ingest_url: "http://localhost:8420".to_string(),
            admin_token: "ADMIN_SECRET_VALUE".to_string(),
            database_url: "postgres://420ai:420ai@localhost:5433/420ai".to_string(),
            archive_encryption_key: "ENC_SECRET_VALUE".to_string(),
            ingest_port: Some(8420),
            analysis_provider: Some("anthropic".to_string()),
            analysis_api_key: Some("ANALYSIS_SECRET_VALUE".to_string()),
            analysis_model: Some("claude-sonnet-4-6".to_string()),
            analysis_base_url: None,
        }
    }

    #[test]
    fn ingest_env_includes_required_trio_and_set_optionals() {
        let env = ingest_env(&sample_config()).expect("required trio present");
        let get = |k: &str| env.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(get("DATABASE_URL"), Some("postgres://420ai:420ai@localhost:5433/420ai"));
        assert_eq!(get("ADMIN_TOKEN"), Some("ADMIN_SECRET_VALUE"));
        assert_eq!(get("ARCHIVE_ENCRYPTION_KEY"), Some("ENC_SECRET_VALUE"));
        assert_eq!(get("INGEST_PORT"), Some("8420"));
        assert_eq!(get("ANALYSIS_PROVIDER"), Some("anthropic"));
        assert_eq!(get("ANALYSIS_API_KEY"), Some("ANALYSIS_SECRET_VALUE"));
        assert_eq!(get("ANALYSIS_MODEL"), Some("claude-sonnet-4-6"));
        // analysis_base_url is None ⇒ the var is omitted entirely.
        assert_eq!(get("ANALYSIS_BASE_URL"), None);
    }

    #[test]
    fn ingest_env_omits_unset_optionals() {
        let cfg = ServerConfig {
            ingest_port: None,
            analysis_provider: None,
            analysis_api_key: None,
            analysis_model: None,
            analysis_base_url: None,
            ..sample_config()
        };
        let env = ingest_env(&cfg).expect("required trio present");
        let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["DATABASE_URL", "ADMIN_TOKEN", "ARCHIVE_ENCRYPTION_KEY"]);
    }

    #[test]
    fn ingest_env_errors_when_a_required_secret_is_missing() {
        let cfg = ServerConfig {
            admin_token: "".to_string(),
            ..sample_config()
        };
        assert!(ingest_env(&cfg).is_err());
    }

    #[test]
    fn masked_view_hides_secrets_even_from_debug() {
        let cfg = sample_config();
        let view = to_view(cfg);
        // Presence booleans are correct…
        assert!(view.has_admin_token);
        assert!(view.has_database_url);
        assert!(view.has_archive_encryption_key);
        assert!(view.has_analysis_api_key);
        // …and NO secret string is reachable, even via a Debug/log path.
        let debug = format!("{view:?}");
        assert!(!debug.contains("ADMIN_SECRET_VALUE"));
        assert!(!debug.contains("ENC_SECRET_VALUE"));
        assert!(!debug.contains("ANALYSIS_SECRET_VALUE"));
        assert!(!debug.contains("420ai@localhost"));
        // Non-secret fields ARE present.
        assert!(debug.contains("http://localhost:8420"));
    }

    #[test]
    fn masked_view_reports_absent_secrets_as_false() {
        let view = to_view(ServerConfig::default());
        assert!(!view.has_admin_token);
        assert!(!view.has_database_url);
        assert!(!view.has_archive_encryption_key);
        assert!(!view.has_analysis_api_key);
    }

    #[test]
    fn merge_secret_keeps_existing_when_blank_and_replaces_when_set() {
        assert_eq!(merge_secret(None, "old".to_string()), "old");
        assert_eq!(merge_secret(Some("".to_string()), "old".to_string()), "old");
        assert_eq!(merge_secret(Some("   ".to_string()), "old".to_string()), "old");
        assert_eq!(merge_secret(Some("  new  ".to_string()), "old".to_string()), "new");
    }

    #[test]
    fn merge_optional_clears_on_empty_and_keeps_on_absent() {
        assert_eq!(merge_optional(None, Some("keep".to_string())), Some("keep".to_string()));
        assert_eq!(merge_optional(Some("".to_string()), Some("keep".to_string())), None);
        assert_eq!(
            merge_optional(Some(" set ".to_string()), None),
            Some("set".to_string())
        );
    }
}
