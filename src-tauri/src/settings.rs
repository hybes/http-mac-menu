// Settings persistence plus the one-time import from the Electron app's
// electron-settings file, so nobody loses their requests when they upgrade.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

use crate::engine::model::{self, normalize_requests, settings_document, Request};
use crate::engine::series::SeriesHistory;
use crate::state::{ReqStatus, RuleStates};

const TRANSACTION_PENDING_FILE: &str = "state-transaction.pending.json";
const TRANSACTION_COMMITTED_FILE: &str = "state-transaction.committed.json";

#[derive(Clone)]
struct DurablePaths {
    settings: std::path::PathBuf,
    history: std::path::PathBuf,
    rules: std::path::PathBuf,
    pending: std::path::PathBuf,
    committed: std::path::PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateTransactionJournal {
    schema_version: u8,
    transaction_id: String,
    settings: Value,
    history: Value,
    alert_state: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateTransactionCommit {
    schema_version: u8,
    transaction_id: String,
}

pub(crate) struct StateTransaction {
    paths: DurablePaths,
    transaction_id: String,
}

fn data_path(app: &tauri::AppHandle, filename: &str) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(filename))
        .map_err(|error| format!("Could not locate the app data directory: {error}"))
}

pub fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    data_path(app, "settings.json")
}

pub fn history_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    data_path(app, "history.json")
}

pub fn alert_state_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    data_path(app, "alert-state.json")
}

pub fn widget_snapshot_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    data_path(app, "widget-snapshot.json")
}

fn durable_paths(app: &tauri::AppHandle) -> Result<DurablePaths, String> {
    let settings = settings_path(app)?;
    let Some(directory) = settings.parent() else {
        return Err("Could not locate the durable settings directory.".into());
    };
    Ok(durable_paths_in(directory))
}

fn durable_paths_in(directory: &std::path::Path) -> DurablePaths {
    DurablePaths {
        settings: directory.join("settings.json"),
        history: directory.join("history.json"),
        rules: directory.join("alert-state.json"),
        pending: directory.join(TRANSACTION_PENDING_FILE),
        committed: directory.join(TRANSACTION_COMMITTED_FILE),
    }
}

fn backup_path(path: &std::path::Path) -> std::path::PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("http-widgets.json");
    path.with_file_name(format!("{name}.bak"))
}

fn parse_json_file(path: &std::path::Path) -> Option<Value> {
    let raw = std::fs::read(path).ok()?;
    serde_json::from_slice(&raw).ok()
}

fn read_json(path: &std::path::Path) -> Option<Value> {
    parse_json_file(path).or_else(|| parse_json_file(&backup_path(path)))
}

/// Where the Electron build kept its settings. Both spellings are checked
/// because Electron derived the folder from productName in some versions.
fn legacy_settings_candidates() -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = dirs_home() {
        for name in ["HTTP Mac Menu", "cnnct-http-mac-menu", "http-mac-menu"] {
            let mut p = home.clone();
            p.extend(["Library", "Application Support", name, "settings.json"]);
            out.push(p);
        }
        // Windows/Linux equivalents, harmless to check on any platform.
        for name in ["HTTP Mac Menu", "cnnct-http-mac-menu"] {
            if cfg!(target_os = "windows") {
                let mut p = home.clone();
                p.extend(["AppData", "Roaming", name, "settings.json"]);
                out.push(p);
            } else {
                let mut p = home.clone();
                p.extend([".config", name, "settings.json"]);
                out.push(p);
            }
        }
    }
    out
}

fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
}

pub struct Loaded {
    pub requests: Vec<Request>,
    pub indicator: String,
    /// Whether the app also shows up in the Dock and the app switcher, rather
    /// than living only in the menu bar. Off is the menu-bar-extra default.
    pub show_in_dock: bool,
    pub imported: bool,
    /// A damaged current document is preserved for recovery rather than being
    /// mistaken for a clean first launch or silently replaced by legacy data.
    pub warning: Option<String>,
}

pub fn load(app: &tauri::AppHandle) -> Result<Loaded, String> {
    let recovery_warning = recover_state_transaction(&durable_paths(app)?)?;
    let path = settings_path(app)?;
    let has_current_document = path.exists() || backup_path(&path).exists();

    let stored = read_json(&path).or_else(|| {
        (!has_current_document)
            .then(|| {
                // First run of the Tauri build: try the legacy file.
                legacy_settings_candidates()
                    .iter()
                    .find_map(|p| read_json(p))
            })
            .flatten()
    });

    let Some(stored) = stored else {
        let damaged_warning = has_current_document.then(|| {
            preserve_corrupt_document(&path);
            format!(
                "Current settings were unreadable; the damaged file was preserved beside {}",
                path.display()
            )
        });
        return Ok(Loaded {
            requests: vec![],
            indicator: default_indicator(),
            show_in_dock: false,
            imported: false,
            warning: combine_warnings(recovery_warning, damaged_warning),
        });
    };
    let imported_from_legacy = !path.exists();
    let mut loaded = load_from(stored, imported_from_legacy);
    loaded.warning = recovery_warning;
    Ok(loaded)
}

fn combine_warnings(first: Option<String>, second: Option<String>) -> Option<String> {
    match (first, second) {
        (Some(first), Some(second)) => Some(format!("{first}. {second}")),
        (Some(warning), None) | (None, Some(warning)) => Some(warning),
        (None, None) => None,
    }
}

fn preserve_corrupt_document(path: &std::path::Path) {
    let timestamp = now_ms().max(0);
    for candidate in [path.to_path_buf(), backup_path(path)] {
        if !candidate.exists() || parse_json_file(&candidate).is_some() {
            continue;
        }
        let name = candidate
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("settings.json");
        let preserved = candidate.with_file_name(format!("{name}.corrupt-{timestamp}"));
        let _ = std::fs::copy(&candidate, preserved);
    }
}

fn default_indicator() -> String {
    crate::engine::indicators::DEFAULT_STYLE.into()
}

fn normalize_indicator(id: &str) -> String {
    crate::engine::indicators::normalize_style(id)
}

fn load_from(stored: Value, imported: bool) -> Loaded {
    let obj = stored.as_object().cloned().unwrap_or_default();
    let indicator = obj
        .get("indicator")
        .and_then(|v| v.as_str())
        .map(normalize_indicator)
        .unwrap_or_else(default_indicator);

    // Decided by shape, not by `schemaVersion`: 2 already stored a `requests`
    // array and only 0 and 1 used the flat `${field}${n}` slots, so keying off
    // the number dropped every request when upgrading from 1.8.x.
    let requests = match obj.get("requests") {
        Some(array @ Value::Array(_)) => normalize_requests(array),
        _ => model::migrate_numbered_settings(&obj),
    };

    let show_in_dock = obj
        .get("showInDock")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    Loaded {
        requests,
        indicator,
        show_in_dock,
        imported,
        warning: None,
    }
}

pub fn save(
    app: &tauri::AppHandle,
    indicator: &str,
    show_in_dock: bool,
    requests: &[Request],
) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let doc = settings_document(indicator, show_in_dock, requests);
    let body = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    write_recoverable(&path, body.as_bytes())
}

fn history_document(history: &SeriesHistory) -> Value {
    serde_json::json!({
        "schemaVersion": 1,
        "history": history,
    })
}

fn rule_state_document(states: &RuleStates) -> Value {
    serde_json::json!({
        "schemaVersion": 1,
        "requests": states,
    })
}

/// Starts a small write-ahead transaction for configuration changes that also
/// reset graph or alert state. If the process exits before commit, startup
/// restores these complete previous documents before loading any of them.
pub(crate) fn begin_state_transaction(
    app: &tauri::AppHandle,
    indicator: &str,
    show_in_dock: bool,
    requests: &[Request],
    history: &SeriesHistory,
    rules: &RuleStates,
) -> Result<StateTransaction, String> {
    let paths = durable_paths(app)?;
    let transaction_id = next_transaction_id();
    let journal = StateTransactionJournal {
        schema_version: 1,
        transaction_id,
        settings: settings_document(indicator, show_in_dock, requests),
        history: history_document(history),
        alert_state: rule_state_document(rules),
    };
    begin_state_transaction_at(paths, &journal)
}

fn begin_state_transaction_at(
    paths: DurablePaths,
    journal: &StateTransactionJournal,
) -> Result<StateTransaction, String> {
    if let Some(parent) = paths.settings.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    // A marker should only survive a process interruption. Resolve it before
    // beginning another transaction so two generations can never overlap.
    let _ = recover_state_transaction(&paths)?;
    let body = serde_json::to_vec(journal).map_err(|error| error.to_string())?;
    write_atomic(&paths.pending, &body)?;
    Ok(StateTransaction {
        paths,
        transaction_id: journal.transaction_id.clone(),
    })
}

fn next_transaction_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    format!(
        "{}-{}-{}",
        now_ms().max(0),
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

/// Marks all replacement documents authoritative. Both marker files remain:
/// matching transaction IDs mean keep the new set, while a mismatch means the
/// pending journal must be rolled back. Avoiding deletion makes the decision
/// deterministic even on filesystems without a flushable directory handle.
pub(crate) fn commit_state_transaction(transaction: &StateTransaction) -> Result<(), String> {
    write_transaction_commit(&transaction.paths, &transaction.transaction_id)?;
    let _ = write_resolved_journal(&transaction.paths, &transaction.transaction_id);
    Ok(())
}

pub(crate) fn rollback_state_transaction(transaction: &StateTransaction) -> Result<(), String> {
    restore_pending_transaction(&transaction.paths)
}

fn recover_state_transaction(paths: &DurablePaths) -> Result<Option<String>, String> {
    if !paths.pending.exists() {
        return Ok(None);
    }
    let journal = match read_transaction_journal(paths) {
        Ok(journal) => journal,
        Err(error) => {
            // The before-image cannot be trusted. Preserve it for diagnosis,
            // keep the authoritative settings document, and reset only the
            // derived graph/cooldown files so the app can start coherently.
            write_json_atomic(&paths.history, &history_document(&SeriesHistory::default()))?;
            write_json_atomic(&paths.rules, &rule_state_document(&RuleStates::default()))?;
            let preserved = quarantine_corrupt_file(&paths.pending)?;
            return Ok(Some(format!(
                "{error} The damaged journal was preserved at {}; graph and alert state were reset",
                preserved.display()
            )));
        }
    };
    if read_transaction_commit(paths).is_some_and(|commit| {
        commit.schema_version == 1 && commit.transaction_id == journal.transaction_id
    }) {
        return Ok(None);
    }
    restore_transaction(paths, &journal)?;
    write_transaction_commit(paths, &journal.transaction_id)?;
    let _ = write_resolved_journal(paths, &journal.transaction_id);
    Ok(Some(
        "Recovered the previous settings after an interrupted update".into(),
    ))
}

fn quarantine_corrupt_file(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("state-transaction.pending.json");
    let preserved = path.with_file_name(format!("{name}.corrupt-{}", now_ms().max(0)));
    replace_file_atomically(path, &preserved)?;
    sync_parent(&preserved)?;
    Ok(preserved)
}

fn restore_pending_transaction(paths: &DurablePaths) -> Result<(), String> {
    let journal = read_transaction_journal(paths)?;
    restore_transaction(paths, &journal)?;
    write_transaction_commit(paths, &journal.transaction_id)?;
    let _ = write_resolved_journal(paths, &journal.transaction_id);
    Ok(())
}

fn read_transaction_journal(paths: &DurablePaths) -> Result<StateTransactionJournal, String> {
    let raw = std::fs::read(&paths.pending)
        .map_err(|error| format!("Could not read the settings recovery journal: {error}"))?;
    let journal: StateTransactionJournal = serde_json::from_slice(&raw)
        .map_err(|error| format!("The settings recovery journal is invalid: {error}"))?;
    if journal.schema_version != 1 {
        return Err(format!(
            "The settings recovery journal has unsupported schema {}.",
            journal.schema_version
        ));
    }
    if journal.transaction_id.trim().is_empty() {
        return Err("The settings recovery journal has no transaction ID.".into());
    }
    Ok(journal)
}

fn read_transaction_commit(paths: &DurablePaths) -> Option<StateTransactionCommit> {
    let raw = std::fs::read(&paths.committed).ok()?;
    serde_json::from_slice(&raw).ok()
}

fn restore_transaction(
    paths: &DurablePaths,
    journal: &StateTransactionJournal,
) -> Result<(), String> {
    write_json_atomic(&paths.settings, &journal.settings)?;
    write_json_atomic(&paths.history, &journal.history)?;
    write_json_atomic(&paths.rules, &journal.alert_state)?;
    Ok(())
}

fn write_transaction_commit(paths: &DurablePaths, transaction_id: &str) -> Result<(), String> {
    let marker = StateTransactionCommit {
        schema_version: 1,
        transaction_id: transaction_id.to_string(),
    };
    let body = serde_json::to_vec(&marker).map_err(|error| error.to_string())?;
    write_atomic(&paths.committed, &body)
}

fn write_resolved_journal(paths: &DurablePaths, transaction_id: &str) -> Result<(), String> {
    let journal = StateTransactionJournal {
        schema_version: 1,
        transaction_id: transaction_id.to_string(),
        settings: Value::Null,
        history: Value::Null,
        alert_state: Value::Null,
    };
    let body = serde_json::to_vec(&journal).map_err(|error| error.to_string())?;
    write_atomic(&paths.pending, &body)
}

fn write_json_atomic(path: &std::path::Path, value: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    write_atomic(path, &body)
}

pub fn load_history(app: &tauri::AppHandle) -> SeriesHistory {
    let Ok(path) = history_path(app) else {
        return SeriesHistory::default();
    };
    let Some(stored) = read_json(&path) else {
        return SeriesHistory::default();
    };
    let payload = stored.get("history").cloned().unwrap_or(stored);
    let mut history = serde_json::from_value::<SeriesHistory>(payload).unwrap_or_default();
    history.prune(now_ms());
    history
}

/// Restore the last values shown by the native widgets before the first
/// network refresh. The snapshot is a cache rather than authoritative state:
/// only currently configured request IDs are accepted, and malformed entries
/// are ignored independently so one bad item cannot discard the others.
pub fn load_widget_statuses<'a>(
    app: &tauri::AppHandle,
    configured_ids: impl IntoIterator<Item = &'a str>,
) -> HashMap<String, ReqStatus> {
    let Ok(path) = widget_snapshot_path(app) else {
        return HashMap::new();
    };
    let Ok(raw) = std::fs::read(path) else {
        return HashMap::new();
    };
    widget_statuses_from_bytes(&raw, configured_ids)
}

fn widget_statuses_from_bytes<'a>(
    raw: &[u8],
    configured_ids: impl IntoIterator<Item = &'a str>,
) -> HashMap<String, ReqStatus> {
    let Ok(stored) = serde_json::from_slice(raw) else {
        return HashMap::new();
    };
    widget_statuses_from_snapshot(&stored, configured_ids)
}

fn widget_statuses_from_snapshot<'a>(
    stored: &Value,
    configured_ids: impl IntoIterator<Item = &'a str>,
) -> HashMap<String, ReqStatus> {
    if stored.get("schemaVersion").and_then(Value::as_u64) != Some(2) {
        return HashMap::new();
    }
    let Some(items) = stored.get("items").and_then(Value::as_array) else {
        return HashMap::new();
    };
    let configured: HashSet<&str> = configured_ids.into_iter().collect();
    let mut statuses = HashMap::new();

    for item in items {
        let Some(item) = item.as_object() else {
            continue;
        };
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        if id.is_empty() || !configured.contains(id) {
            continue;
        }

        let value = item
            .get("value")
            .and_then(Value::as_str)
            .map(str::to_string);
        let numeric = item
            .get("numeric")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite());
        let error = item
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string);
        let attempted_at = item
            .get("lastAttemptAt")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);
        let updated_at = item
            .get("lastSuccessAt")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);

        // Do not turn a cached pending placeholder into a successful status.
        if value.is_none()
            && numeric.is_none()
            && error.is_none()
            && attempted_at == 0
            && updated_at == 0
        {
            continue;
        }

        statuses.insert(
            id.to_string(),
            ReqStatus {
                value,
                numeric,
                error,
                attempted_at,
                updated_at,
                // The snapshot does not persist retry policy. Start a new
                // launch at zero and let the next failed attempt re-establish
                // its backoff count while retaining the cached value.
                failures: 0,
            },
        );
    }

    statuses
}

pub fn save_history(app: &tauri::AppHandle, history: &SeriesHistory) -> Result<(), String> {
    let path = history_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let document = history_document(history);
    let body = serde_json::to_vec(&document).map_err(|e| e.to_string())?;
    write_recoverable(&path, &body)
}

pub fn load_rule_states(app: &tauri::AppHandle) -> RuleStates {
    let Ok(path) = alert_state_path(app) else {
        return RuleStates::default();
    };
    let Some(stored) = read_json(&path) else {
        return RuleStates::default();
    };
    let payload = stored.get("requests").cloned().unwrap_or(stored);
    serde_json::from_value::<RuleStates>(payload).unwrap_or_default()
}

pub fn save_rule_states(app: &tauri::AppHandle, states: &RuleStates) -> Result<(), String> {
    let path = alert_state_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let document = rule_state_document(states);
    let body = serde_json::to_vec(&document).map_err(|e| e.to_string())?;
    write_recoverable(&path, &body)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Keep the previous valid JSON document beside every durable state file. It
/// provides a recovery path for interrupted Windows replacement and for
/// external corruption without making the normal read path more complicated.
fn write_recoverable(path: &std::path::Path, body: &[u8]) -> Result<(), String> {
    if parse_json_file(path).is_some() {
        let backup = backup_path(path);
        std::fs::copy(path, &backup).map_err(|error| error.to_string())?;
        if let Ok(file) = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&backup)
        {
            file.sync_all().map_err(|error| error.to_string())?;
        }
    }
    write_atomic(path, body)
}

/// Readers in native widget extensions can observe the snapshot at any time,
/// so write and sync a complete temporary file before replacement. Unix can
/// replace in one rename; Windows first removes the destination, with durable
/// JSON callers protected by `write_recoverable`'s previous-good backup.
pub(crate) fn write_atomic(path: &std::path::Path, body: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);
    let suffix = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("http-widgets");
    let temporary = path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        suffix
    ));
    let result = (|| -> Result<(), String> {
        let mut file = std::fs::File::create(&temporary).map_err(|e| e.to_string())?;
        file.write_all(body).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);

        replace_file_atomically(&temporary, path)?;
        sync_parent(path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn replace_file_atomically(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    std::fs::rename(source, destination).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn replace_file_atomically(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: both paths are NUL-terminated UTF-16 buffers that remain alive
    // for the duration of the Win32 call.
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

fn sync_parent(path: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_directory(label: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "http-widgets-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn recoverable_json_write_keeps_and_reads_the_previous_good_document() {
        let directory = temporary_directory("recovery");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("settings.json");

        write_recoverable(&path, br#"{"version":1}"#).unwrap();
        write_recoverable(&path, br#"{"version":2}"#).unwrap();
        assert_eq!(parse_json_file(&backup_path(&path)).unwrap()["version"], 1);

        std::fs::write(&path, b"{truncated").unwrap();
        assert_eq!(read_json(&path).unwrap()["version"], 1);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn pending_state_transaction_restores_every_previous_document() {
        let directory = temporary_directory("state-transaction-rollback");
        std::fs::create_dir_all(&directory).unwrap();
        let paths = durable_paths_in(&directory);
        let previous = StateTransactionJournal {
            schema_version: 1,
            transaction_id: next_transaction_id(),
            settings: serde_json::json!({"schemaVersion": 3, "requests": [{"id": "old"}]}),
            history: serde_json::json!({"schemaVersion": 1, "history": {"series": {"old": []}}}),
            alert_state: serde_json::json!({"schemaVersion": 1, "requests": {"old": {}}}),
        };
        write_json_atomic(&paths.settings, &previous.settings).unwrap();
        write_json_atomic(&paths.history, &previous.history).unwrap();
        write_json_atomic(&paths.rules, &previous.alert_state).unwrap();

        let _transaction = begin_state_transaction_at(paths.clone(), &previous).unwrap();
        write_json_atomic(
            &paths.settings,
            &serde_json::json!({"schemaVersion": 3, "requests": [{"id": "new"}]}),
        )
        .unwrap();
        write_json_atomic(
            &paths.history,
            &serde_json::json!({"schemaVersion": 1, "history": {}}),
        )
        .unwrap();
        write_json_atomic(
            &paths.rules,
            &serde_json::json!({"schemaVersion": 1, "requests": {}}),
        )
        .unwrap();

        assert!(recover_state_transaction(&paths).unwrap().is_some());
        assert_eq!(parse_json_file(&paths.settings).unwrap(), previous.settings);
        assert_eq!(parse_json_file(&paths.history).unwrap(), previous.history);
        assert_eq!(parse_json_file(&paths.rules).unwrap(), previous.alert_state);
        assert!(paths.pending.exists());
        assert!(paths.committed.exists());
        assert!(recover_state_transaction(&paths).unwrap().is_none());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn committed_state_transaction_keeps_every_replacement_document() {
        let directory = temporary_directory("state-transaction-commit");
        std::fs::create_dir_all(&directory).unwrap();
        let paths = durable_paths_in(&directory);
        let previous = StateTransactionJournal {
            schema_version: 1,
            transaction_id: next_transaction_id(),
            settings: serde_json::json!({"schemaVersion": 3, "requests": []}),
            history: serde_json::json!({"schemaVersion": 1, "history": {}}),
            alert_state: serde_json::json!({"schemaVersion": 1, "requests": {}}),
        };
        let transaction = begin_state_transaction_at(paths.clone(), &previous).unwrap();
        let replacement = serde_json::json!({"replacement": true});
        write_json_atomic(&paths.settings, &replacement).unwrap();
        write_json_atomic(&paths.history, &replacement).unwrap();
        write_json_atomic(&paths.rules, &replacement).unwrap();
        commit_state_transaction(&transaction).unwrap();

        assert!(recover_state_transaction(&paths).unwrap().is_none());
        assert_eq!(parse_json_file(&paths.settings).unwrap(), replacement);
        assert_eq!(parse_json_file(&paths.history).unwrap(), replacement);
        assert_eq!(parse_json_file(&paths.rules).unwrap(), replacement);
        assert!(transaction.paths.pending.exists());
        assert!(transaction.paths.committed.exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn every_precommit_interruption_point_rolls_back_as_one_set() {
        for writes_completed in 0..=3 {
            let directory = temporary_directory(&format!("state-transaction-{writes_completed}"));
            std::fs::create_dir_all(&directory).unwrap();
            let paths = durable_paths_in(&directory);
            let previous = StateTransactionJournal {
                schema_version: 1,
                transaction_id: next_transaction_id(),
                settings: serde_json::json!({"document": "old-settings"}),
                history: serde_json::json!({"document": "old-history"}),
                alert_state: serde_json::json!({"document": "old-rules"}),
            };
            write_json_atomic(&paths.settings, &previous.settings).unwrap();
            write_json_atomic(&paths.history, &previous.history).unwrap();
            write_json_atomic(&paths.rules, &previous.alert_state).unwrap();
            let _transaction = begin_state_transaction_at(paths.clone(), &previous).unwrap();

            let replacements = [
                (
                    &paths.history,
                    serde_json::json!({"document": "new-history"}),
                ),
                (&paths.rules, serde_json::json!({"document": "new-rules"})),
                (
                    &paths.settings,
                    serde_json::json!({"document": "new-settings"}),
                ),
            ];
            for (path, replacement) in replacements.iter().take(writes_completed) {
                write_json_atomic(path, replacement).unwrap();
            }

            assert!(recover_state_transaction(&paths).unwrap().is_some());
            assert_eq!(parse_json_file(&paths.settings).unwrap(), previous.settings);
            assert_eq!(parse_json_file(&paths.history).unwrap(), previous.history);
            assert_eq!(parse_json_file(&paths.rules).unwrap(), previous.alert_state);
            assert!(recover_state_transaction(&paths).unwrap().is_none());
            std::fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn corrupt_transaction_journal_is_preserved_and_derived_state_is_reset() {
        let directory = temporary_directory("state-transaction-corrupt");
        std::fs::create_dir_all(&directory).unwrap();
        let paths = durable_paths_in(&directory);
        let settings = serde_json::json!({"document": "settings-stay"});
        write_json_atomic(&paths.settings, &settings).unwrap();
        write_json_atomic(
            &paths.history,
            &serde_json::json!({"document": "untrusted-history"}),
        )
        .unwrap();
        write_json_atomic(
            &paths.rules,
            &serde_json::json!({"document": "untrusted-rules"}),
        )
        .unwrap();
        std::fs::write(&paths.pending, b"{truncated").unwrap();

        let warning = recover_state_transaction(&paths).unwrap().unwrap();
        assert!(warning.contains("preserved"));
        assert_eq!(parse_json_file(&paths.settings).unwrap(), settings);
        assert_eq!(
            parse_json_file(&paths.history).unwrap(),
            history_document(&SeriesHistory::default())
        );
        assert_eq!(
            parse_json_file(&paths.rules).unwrap(),
            rule_state_document(&RuleStates::default())
        );
        assert!(!paths.pending.exists());
        assert!(std::fs::read_dir(&directory).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("state-transaction.pending.json.corrupt-")));
        std::fs::remove_dir_all(directory).unwrap();
    }

    /// 1.8.x wrote `schemaVersion: 2` with a `requests` array. Reading that as
    /// a numbered-slot file lost every request on upgrade.
    #[test]
    fn imports_a_schema_2_document() {
        let stored: Value = serde_json::from_str(
            r#"{"schemaVersion":2,"indicator":"arrow","requests":[
                 {"id":"r1","type":"crypto","coin":"SOL","holdings":"100.07",
                  "currency":"gbp","template":"{balance}","length":"2"}]}"#,
        )
        .unwrap();
        let loaded = load_from(stored, true);
        assert_eq!(loaded.indicator, "arrow");
        assert_eq!(loaded.requests.len(), 1);
        assert_eq!(loaded.requests[0].coin, "SOL");
        assert_eq!(loaded.requests[0].holdings, "100.07");
        assert!(loaded.requests[0].configured());
    }

    /// The shape the current build writes.
    #[test]
    fn reads_back_its_own_document() {
        let stored: Value = serde_json::from_str(
            r#"{"schemaVersion":4,"indicator":"chevron","requests":[
                 {"id":"r1","type":"http","provider":"auto","url":"https://example.com",
                  "alerts":[{"id":"a1","kind":"above","value":"5","cooldown_secs":60}]}]}"#,
        )
        .unwrap();
        let loaded = load_from(stored, false);
        assert_eq!(loaded.requests.len(), 1);
        assert_eq!(loaded.requests[0].alerts.len(), 1);
        assert_eq!(loaded.requests[0].alerts[0].kind, "above");
        assert_eq!(loaded.requests[0].crypto_provider(), "auto");
    }

    #[test]
    fn normalizes_schema_three_entries_without_losing_missing_ids() {
        let stored = serde_json::json!({
            "schemaVersion": 3,
            "requests": [
                {
                    "type": " crypto ",
                    "coin": " SOL ",
                    "currency": " USD ",
                    "timer": "1",
                    "alerts": [{"kind": "unknown", "value": " 4 ", "cooldown_secs": 90_000}]
                },
                {
                    "id": " custom ",
                    "type": "http",
                    "url": " https://example.com/value "
                }
            ]
        });

        let loaded = load_from(stored, false);
        assert_eq!(loaded.requests.len(), 2);
        assert_eq!(loaded.requests[0].id, "r1");
        assert_eq!(loaded.requests[0].kind, "crypto");
        assert_eq!(loaded.requests[0].coin, "SOL");
        assert_eq!(loaded.requests[0].currency, "USD");
        assert_eq!(loaded.requests[0].crypto_provider(), "auto");
        assert_eq!(loaded.requests[0].timer, "5");
        assert_eq!(loaded.requests[0].alerts[0].kind, "above");
        assert_eq!(loaded.requests[0].alerts[0].value, "4");
        assert_eq!(loaded.requests[0].alerts[0].cooldown_secs, 86_400);
        assert_eq!(loaded.requests[1].id, "custom");
        assert_eq!(loaded.requests[1].url, "https://example.com/value");
    }

    /// Schema 0 and 1 really did use flat `${field}${n}` keys.
    #[test]
    fn still_migrates_numbered_slots() {
        let stored: Value = serde_json::from_str(
            r#"{"schemaVersion":1,"url1":"https://example.com","json1":"a.b",
                "coin2":"BTC","type2":"crypto"}"#,
        )
        .unwrap();
        let loaded = load_from(stored, true);
        assert_eq!(loaded.requests.len(), 2);
        assert_eq!(loaded.requests[0].url, "https://example.com");
        assert_eq!(loaded.requests[1].coin, "BTC");
    }

    /// An unreadable or unknown indicator must not stop the requests loading.
    #[test]
    fn falls_back_to_the_default_indicator() {
        let stored: Value =
            serde_json::from_str(r#"{"schemaVersion":3,"indicator":"nope","requests":[]}"#)
                .unwrap();
        assert_eq!(load_from(stored, false).indicator, "chevron");
    }

    #[test]
    fn restores_cached_widget_status_for_configured_requests_only() {
        let stored: Value = serde_json::from_str(
            r#"{"schemaVersion":2,"generatedAt":3000,"items":[
                 {"id":"kept","value":"42.5","numeric":42.5,
                  "error":"offline","lastAttemptAt":3000,"lastSuccessAt":2000},
                 {"id":"removed","value":"99","lastAttemptAt":3000,
                  "lastSuccessAt":3000},
                 {"id":"unconfigured","value":"12","lastAttemptAt":3000,
                  "lastSuccessAt":3000}]}"#,
        )
        .unwrap();

        let statuses = widget_statuses_from_snapshot(&stored, ["kept"]);
        assert_eq!(statuses.len(), 1);
        let cached = statuses.get("kept").unwrap();
        assert_eq!(cached.value.as_deref(), Some("42.5"));
        assert_eq!(cached.numeric, Some(42.5));
        assert_eq!(cached.error.as_deref(), Some("offline"));
        assert_eq!(cached.attempted_at, 3000);
        assert_eq!(cached.updated_at, 2000);
        assert_eq!(cached.failures, 0);
    }

    #[test]
    fn widget_snapshot_parser_skips_bad_items_without_losing_good_ones() {
        let stored: Value = serde_json::from_str(
            r#"{"schemaVersion":2,"items":[
                 null,
                 {"id":12,"value":"wrong id type"},
                 {"id":"good","value":"cached","numeric":"not a number",
                  "lastAttemptAt":"bad timestamp","lastSuccessAt":-10},
                 {"id":"pending","value":null,"error":null,
                  "lastAttemptAt":0,"lastSuccessAt":0}]}"#,
        )
        .unwrap();

        let statuses = widget_statuses_from_snapshot(&stored, ["good", "pending"]);
        assert_eq!(statuses.len(), 1);
        let cached = statuses.get("good").unwrap();
        assert_eq!(cached.value.as_deref(), Some("cached"));
        assert_eq!(cached.numeric, None);
        assert_eq!(cached.attempted_at, 0);
        assert_eq!(cached.updated_at, 0);
    }

    #[test]
    fn widget_snapshot_parser_ignores_old_or_malformed_documents() {
        let old = serde_json::json!({
            "schemaVersion": 1,
            "items": [{"id": "r1", "value": "old"}],
        });
        let malformed = serde_json::json!({"schemaVersion": 2, "items": "nope"});

        assert!(widget_statuses_from_snapshot(&old, ["r1"]).is_empty());
        assert!(widget_statuses_from_snapshot(&malformed, ["r1"]).is_empty());
        assert!(widget_statuses_from_bytes(b"{not valid json", ["r1"]).is_empty());
    }
}
