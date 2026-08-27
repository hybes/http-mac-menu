// The invoke surface — mirrors the old preload API one-for-one so the config
// UI needed almost no changes, plus the new alert/cURL/preset commands.

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use crate::engine::curl;
use crate::engine::indicators::to_text;
use crate::engine::model::{self, Request};
use crate::scheduler;
use crate::state::AppState;

const NEW_REQUEST_ID: &str = "new";

#[derive(Serialize)]
// The renderer reads `isNew`; without this it only ever sees `undefined` and
// offers Remove on a request that has never been saved.
#[serde(rename_all = "camelCase")]
pub struct LoadResult {
    pub id: String,
    pub values: serde_json::Value,
    pub position: usize,
    pub is_new: bool,
}

fn request_to_values(request: &Request) -> serde_json::Value {
    let mut obj = json!({
        "type": request.kind,
        "label": request.label,
        "url": request.url,
        "headers": request.headers,
        "json": request.json,
        "multiplier": request.multiplier,
        "provider": request.crypto_provider(),
        "coin": request.coin,
        "holdings": request.holdings,
        "currency": request.currency,
        "template": request.template,
        "length": request.length,
        "prefix": request.prefix,
        "suffix": request.suffix,
        "timer": request.timer,
    });
    if let Some(map) = obj.as_object_mut() {
        map.insert(
            "alerts".into(),
            serde_json::to_value(&request.alerts).unwrap_or_default(),
        );
    }
    obj
}

#[tauri::command]
pub fn load_config(app: AppHandle, id: String) -> LoadResult {
    let state = app.state::<AppState>();
    let requests = state.requests.lock().unwrap();
    match requests.iter().find(|r| r.id == id) {
        Some(request) => LoadResult {
            id: request.id.clone(),
            values: request_to_values(request),
            position: requests.iter().position(|r| r.id == id).unwrap_or(0) + 1,
            is_new: false,
        },
        // Either "Add Request…" or a request removed from another window.
        None => LoadResult {
            id: NEW_REQUEST_ID.into(),
            values: {
                let mut blank = model::blank_request();
                blank.insert("type".into(), serde_json::json!("http"));
                serde_json::Value::Object(blank)
            },
            position: requests.len() + 1,
            is_new: true,
        },
    }
}

#[tauri::command]
pub async fn save_config(
    app: AppHandle,
    id: String,
    values: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let clean = model::sanitize_values(&values);
    // Alerts ride along with the form payload.
    let alerts = values
        .get("alerts")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let parsed_alerts = parse_alerts(&alerts)?;
    let commit = state.commit_lock.lock().await;

    let current_requests = state.requests.lock().unwrap().clone();
    let mut next_requests = current_requests.clone();
    let (saved_id, reset_series, reset_rules) = {
        let index = next_requests.iter().position(|r| r.id == id);
        match index {
            Some(i) => {
                let mut updated = model::make_request_with_id(id.clone(), &clean);
                updated.alerts = parsed_alerts;
                updated.validate_for_save()?;
                let reset_series = !next_requests[i].same_series_as(&updated);
                let reset_rules = reset_series || next_requests[i].alerts != updated.alerts;
                next_requests[i] = updated;
                (id.clone(), reset_series, reset_rules)
            }
            None => {
                if next_requests.len() >= model::MAX_REQUESTS {
                    return Ok(serde_json::json!({
                        "ok": false,
                        "error": format!("You can have at most {}.", model::MAX_REQUESTS)
                    }));
                }
                let mut request =
                    model::make_request(&serde_json::Value::Object(clean), &next_requests);
                request.alerts = parsed_alerts;
                request.validate_for_save()?;
                let saved = request.id.clone();
                next_requests.push(request);
                (saved, false, false)
            }
        }
    };

    let current_history = state.series_history.lock().unwrap().clone();
    let mut next_history = current_history.clone();
    let history_changed = reset_series && next_history.remove(&saved_id);

    let current_rule_states = state.rule_states.lock().unwrap().clone();
    let mut next_rule_states = current_rule_states.clone();
    reconcile_rule_state_snapshot(
        &mut next_rule_states,
        next_requests.iter().find(|request| request.id == saved_id),
        reset_rules,
    );
    let rules_changed = next_rule_states != current_rule_states;

    persist_staged_documents(
        &app,
        &state,
        &current_requests,
        &next_requests,
        (&current_history, &next_history, history_changed),
        (&current_rule_states, &next_rule_states, rules_changed),
    )
    .await?;

    *state.requests.lock().unwrap() = next_requests;
    state.invalidate(&saved_id);
    if reset_series {
        *state.series_history.lock().unwrap() = next_history;
        if history_changed {
            state.mark_history_synced();
        }
    }
    if rules_changed {
        *state.rule_states.lock().unwrap() = next_rule_states;
        state.mark_rule_states_synced();
    }
    let name = scheduler::name_for(&state.requests.lock().unwrap(), &saved_id);
    drop(commit);
    scheduler::log_line(&app, &format!("Saved {name}"));
    crate::close_config_window(&app, true);
    crate::render_tray(&app);
    tauri::async_runtime::spawn({
        let app = app.clone();
        async move {
            scheduler::refresh_request(&app, &saved_id).await;
            crate::render_tray(&app);
        }
    });
    Ok(serde_json::json!({ "ok": true }))
}

fn parse_alerts(value: &serde_json::Value) -> Result<Vec<crate::engine::model::AlertRule>, String> {
    let entries = value
        .as_array()
        .ok_or_else(|| "Alert rules must be a list.".to_string())?;
    let mut rules = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let rule = serde_json::from_value::<crate::engine::model::AlertRule>(entry.clone())
            .map_err(|_| format!("Alert {} is malformed.", index + 1))?;
        rules.push(rule);
    }
    Ok(model::normalize_alert_rules(rules))
}

#[cfg(desktop)]
pub(crate) async fn set_indicator_preference(app: &AppHandle, style: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _commit = state.commit_lock.lock().await;
    if state.persistence_is_degraded() {
        return Err(
            "Settings recovery is pending; restart the app before changing preferences.".into(),
        );
    }
    let previous = {
        let mut indicator = state.indicator.lock().unwrap();
        std::mem::replace(&mut *indicator, style)
    };
    let indicator = state.indicator.lock().unwrap().clone();
    let show_in_dock = state.show_in_dock.load(std::sync::atomic::Ordering::SeqCst);
    let requests = state.requests.lock().unwrap().clone();
    if let Err(error) = crate::settings::save(app, &indicator, show_in_dock, &requests) {
        *state.indicator.lock().unwrap() = previous;
        return Err(error);
    }
    Ok(())
}

#[cfg(desktop)]
pub(crate) async fn toggle_dock_preference(app: &AppHandle) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let _commit = state.commit_lock.lock().await;
    if state.persistence_is_degraded() {
        return Err(
            "Settings recovery is pending; restart the app before changing preferences.".into(),
        );
    }
    let previous = state.show_in_dock.load(std::sync::atomic::Ordering::SeqCst);
    let next = !previous;
    state
        .show_in_dock
        .store(next, std::sync::atomic::Ordering::SeqCst);
    let indicator = state.indicator.lock().unwrap().clone();
    let requests = state.requests.lock().unwrap().clone();
    if let Err(error) = crate::settings::save(app, &indicator, next, &requests) {
        state
            .show_in_dock
            .store(previous, std::sync::atomic::Ordering::SeqCst);
        return Err(error);
    }
    Ok(next)
}

fn reconcile_rule_state_snapshot(
    states: &mut crate::state::RuleStates,
    request: Option<&Request>,
    reset: bool,
) {
    let request_id = request
        .map(|request| request.id.as_str())
        .unwrap_or_default();
    let valid: std::collections::HashSet<String> = request
        .map(|request| request.alerts.iter().map(|rule| rule.id.clone()).collect())
        .unwrap_or_default();
    if reset || valid.is_empty() {
        states.remove(request_id);
    } else if let Some(rules) = states.get_mut(request_id) {
        rules.retain(|rule_id, _| valid.contains(rule_id));
        if rules.is_empty() {
            states.remove(request_id);
        }
    }
}

/// Write every staged document before publishing any live state. Settings are
/// authoritative and are committed last; if that final write fails, restore
/// any derived history/rule document already written and leave memory intact.
async fn persist_staged_documents(
    app: &AppHandle,
    state: &AppState,
    current_requests: &[Request],
    requests: &[Request],
    history: (
        &crate::engine::series::SeriesHistory,
        &crate::engine::series::SeriesHistory,
        bool,
    ),
    rules: (&crate::state::RuleStates, &crate::state::RuleStates, bool),
) -> Result<(), String> {
    let (current_history, next_history, history_changed) = history;
    let (current_rules, next_rules, rules_changed) = rules;
    let _history_save = if history_changed {
        Some(state.history_save_lock.lock().await)
    } else {
        None
    };
    let _rule_save = if rules_changed {
        Some(state.rule_save_lock.lock().await)
    } else {
        None
    };

    let indicator = state.indicator.lock().unwrap().clone();
    let show_in_dock = state.show_in_dock.load(std::sync::atomic::Ordering::SeqCst);
    let transaction = crate::settings::begin_state_transaction(
        app,
        &indicator,
        show_in_dock,
        current_requests,
        current_history,
        current_rules,
    )?;
    let write_result = (|| -> Result<(), String> {
        if history_changed {
            crate::settings::save_history(app, next_history)?;
        }
        if rules_changed {
            crate::settings::save_rule_states(app, next_rules)?;
        }
        crate::settings::save(app, &indicator, show_in_dock, requests)
    })();
    if let Err(error) = write_result {
        return match crate::settings::rollback_state_transaction(&transaction) {
            Ok(()) => Err(error),
            Err(rollback) => {
                state.mark_persistence_degraded();
                Err(format!(
                    "{error} The previous settings are queued for recovery after restart: {rollback}"
                ))
            }
        };
    }
    if let Err(error) = crate::settings::commit_state_transaction(&transaction) {
        return match crate::settings::rollback_state_transaction(&transaction) {
            Ok(()) => Err(error),
            Err(rollback) => {
                state.mark_persistence_degraded();
                Err(format!(
                    "{error} The previous settings are queued for recovery after restart: {rollback}"
                ))
            }
        };
    }
    state.clear_persistence_degraded();
    Ok(())
}

#[tauri::command]
pub async fn remove_config(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let commit = state.commit_lock.lock().await;
    let current_requests = state.requests.lock().unwrap().clone();
    let Some(index) = current_requests.iter().position(|request| request.id == id) else {
        return Ok(serde_json::json!({ "ok": true }));
    };
    let removed_name = scheduler::name_for(&current_requests, &id);
    let mut next_requests = current_requests.clone();
    next_requests.remove(index);

    let current_history = state.series_history.lock().unwrap().clone();
    let mut next_history = current_history.clone();
    let history_changed = next_history.remove(&id);
    let current_rule_states = state.rule_states.lock().unwrap().clone();
    let mut next_rule_states = current_rule_states.clone();
    let rules_changed = next_rule_states.remove(&id).is_some();

    persist_staged_documents(
        &app,
        &state,
        &current_requests,
        &next_requests,
        (&current_history, &next_history, history_changed),
        (&current_rule_states, &next_rule_states, rules_changed),
    )
    .await?;

    *state.requests.lock().unwrap() = next_requests;
    state.invalidate(&id);
    if history_changed {
        *state.series_history.lock().unwrap() = next_history;
        state.mark_history_synced();
    }
    if rules_changed {
        *state.rule_states.lock().unwrap() = next_rule_states;
        state.mark_rule_states_synced();
    }
    drop(commit);
    scheduler::log_line(&app, &format!("Removed {removed_name}"));
    crate::close_config_window(&app, true);
    crate::render_tray(&app);
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub async fn test_config(values: serde_json::Value) -> serde_json::Value {
    let clean = model::sanitize_values(&values);
    let probe = model::request_from_clean("probe", &clean);
    if let Err(error) = probe.validate_for_save() {
        return serde_json::json!({ "ok": false, "error": error });
    }
    let client = crate::engine::sources::client();
    let result = if probe.crypto() {
        // No shared caches here: the Test button must not touch live state.
        let mut cache = std::collections::HashMap::new();
        let mut history = crate::engine::price_history::PriceHistory::default();
        crate::engine::sources::fetch_crypto_value(
            client,
            &probe,
            &mut cache,
            &mut history,
            &[],
            false,
        )
        .await
    } else {
        crate::engine::sources::fetch_http_value(client, &probe).await
    };
    match result {
        Ok(f) => serde_json::json!({ "ok": true, "value": to_text(&f.text) }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn import_curl(text: String) -> serde_json::Value {
    let parsed = curl::parse(&text);
    serde_json::json!({
        "url": parsed.url,
        "headers": parsed
            .headers
            .iter()
            .map(|(k, v)| format!("{k}: {v}"))
            .collect::<Vec<_>>()
            .join("\n"),
        "warnings": parsed.warnings,
    })
}

#[derive(Serialize)]
pub struct Preset {
    /// Stable across copy and wording changes so home-screen links do not
    /// depend on a translated or edited label.
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub kind: &'static str,
    pub values: serde_json::Value,
}

#[tauri::command]
pub fn list_presets() -> Vec<Preset> {
    vec![
        Preset {
            id: "weather-london",
            label: "Weather · London",
            description: "Current temperature in central London from Open-Meteo.",
            kind: "http",
            values: serde_json::json!({
                "type": "http",
                "url": "https://api.open-meteo.com/v1/forecast?latitude=51.51&longitude=-0.13&current=temperature_2m,weather_code",
                "json": "current.temperature_2m",
                "suffix": "°C",
                "timer": "900",
            }),
        },
        Preset {
            id: "github-stars",
            label: "GitHub stars · Tauri",
            description: "Star count for the public tauri-apps/tauri repository on GitHub.",
            kind: "http",
            values: serde_json::json!({
                "type": "http",
                "url": "https://api.github.com/repos/tauri-apps/tauri",
                "json": "stargazers_count",
                "timer": "600",
            }),
        },
        Preset {
            id: "hacker-news-points",
            label: "Hacker News · top story points",
            description: "Points on the first item in Algolia's Hacker News front-page feed.",
            kind: "http",
            values: serde_json::json!({
                "type": "http",
                "url": "https://hn.algolia.com/api/v1/search?tags=front_page",
                "json": "hits[0].points",
                "timer": "300",
            }),
        },
        Preset {
            id: "solana-live-usd",
            label: "Solana price · live USD",
            description: "Fresh SOL price from Jupiter with automatic no-key fallbacks.",
            kind: "crypto",
            values: serde_json::json!({
                "type": "crypto",
                "provider": "auto",
                "coin": "sol",
                "currency": "usd",
                "template": "{symbol} {price} {change24h}",
                "timer": "5",
            }),
        },
        Preset {
            id: "bitcoin-usd",
            label: "Bitcoin price · USD",
            description: "Current Bitcoin price in US dollars with its 24-hour change.",
            kind: "crypto",
            values: serde_json::json!({
                "type": "crypto",
                "provider": "coingecko",
                "coin": "btc",
                "currency": "usd",
                "template": "{symbol} {price} {change24h}",
                "timer": "60",
            }),
        },
        Preset {
            id: "ethereum-holdings-gbp",
            label: "Ethereum value · 1 ETH (GBP)",
            description:
                "Current GBP value of exactly 1 ETH; change Holdings to match your amount.",
            kind: "crypto",
            values: serde_json::json!({
                "type": "crypto",
                "provider": "coingecko",
                "coin": "eth",
                "holdings": "1",
                "currency": "gbp",
                "timer": "60",
            }),
        },
    ]
}

#[tauri::command]
pub fn set_dirty(app: AppHandle, dirty: bool) {
    app.state::<AppState>()
        .ui_dirty
        .store(dirty, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
pub fn close_config(app: AppHandle) {
    crate::close_config_window(&app, false);
}

/// Compatibility endpoint for older renderers that still measure their
/// content. The Workbench window is user-resizable and must not jump whenever
/// a disclosure, validation message or notification banner changes height.
#[tauri::command]
pub fn fit_window(_window: tauri::WebviewWindow, _height: f64) -> serde_json::Value {
    // `true` keeps scrolling enabled in the legacy renderer while doing no
    // native resize work.
    serde_json::json!({ "clamped": true })
}

#[tauri::command]
pub fn accent_color() -> Option<String> {
    crate::accent::accent_color()
}

/// Force-refresh everything and resolve only after the batch has finished.
/// Endpoint failures are represented on their request rows; `changed` says
/// whether this invocation committed any new success or error state.
#[tauri::command]
pub async fn refresh_all(app: AppHandle) -> serde_json::Value {
    let changed = crate::refresh_everything(&app, true).await;
    serde_json::json!({ "ok": true, "changed": changed })
}

/// A direct user action is allowed while scheduled updates are paused.
#[tauri::command]
pub async fn refresh_request_now(app: AppHandle, id: String) -> serde_json::Value {
    let ready = {
        let state = app.state::<AppState>();
        let requests = state.requests.lock().unwrap();
        requests
            .iter()
            .find(|request| request.id == id)
            .map(|request| request.configured())
    };
    match ready {
        None => return serde_json::json!({ "ok": false, "error": "Request not found." }),
        Some(false) => {
            return serde_json::json!({
                "ok": false,
                "error": "Finish setting up this request before refreshing it."
            });
        }
        Some(true) => {}
    }

    let changed = scheduler::refresh_request(&app, &id).await;
    crate::render_tray(&app);
    serde_json::json!({ "ok": true, "changed": changed })
}

/// Set, rather than toggle, so repeated taps and delayed frontend replies
/// always converge on the requested state.
#[tauri::command]
pub fn set_updates_paused(app: AppHandle, paused: bool) -> serde_json::Value {
    let state = app.state::<AppState>();
    let was_paused = state.is_paused();
    let changed = was_paused != paused;
    if changed {
        state.set_paused(paused);
        if !paused {
            // Everything becomes due now; the ordinary scheduler tick owns the
            // refresh and keeps its normal concurrency guarantees.
            let ids: Vec<String> = state
                .requests
                .lock()
                .unwrap()
                .iter()
                .map(|request| request.id.clone())
                .collect();
            let mut due = state.due.lock().unwrap();
            let now = std::time::Instant::now();
            for id in ids {
                due.insert(id, now);
            }
        }
        scheduler::log_line(
            &app,
            if paused {
                "Updates paused"
            } else {
                "Updates resumed"
            },
        );
        crate::render_tray(&app);
    }
    serde_json::json!({ "ok": true, "paused": paused, "changed": changed })
}

fn write_clipboard_text(app: &AppHandle, text: String, count: usize) -> serde_json::Value {
    match app.clipboard().write_text(text) {
        Ok(()) => serde_json::json!({ "ok": true, "count": count }),
        Err(error) => serde_json::json!({
            "ok": false,
            "error": format!("Could not copy to the clipboard: {error}")
        }),
    }
}

#[tauri::command]
pub fn copy_request_value(app: AppHandle, id: String) -> serde_json::Value {
    let state = app.state::<AppState>();
    if !state
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|request| request.id == id)
    {
        return serde_json::json!({ "ok": false, "error": "Request not found." });
    }
    let value = state
        .status
        .lock()
        .unwrap()
        .get(&id)
        .and_then(|status| status.value.as_deref())
        .map(to_text);
    match value {
        Some(value) if !value.is_empty() => write_clipboard_text(&app, value, 1),
        _ => serde_json::json!({
            "ok": false,
            "error": "This request does not have a value to copy yet."
        }),
    }
}

#[tauri::command]
pub fn copy_all_values(app: AppHandle) -> serde_json::Value {
    let state = app.state::<AppState>();
    let values: Vec<String> = {
        let requests = state.requests.lock().unwrap();
        let status = state.status.lock().unwrap();
        requests
            .iter()
            .filter(|request| request.configured())
            .filter_map(|request| status.get(&request.id)?.value.as_deref())
            .map(to_text)
            .filter(|value| !value.is_empty())
            .collect()
    };
    if values.is_empty() {
        return serde_json::json!({
            "ok": false,
            "error": "There are no current values to copy yet."
        });
    }
    let count = values.len();
    write_clipboard_text(
        &app,
        values.join(crate::engine::constants::TITLE_SEPARATOR),
        count,
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedRequest {
    pub id: String,
    pub name: String,
    /// False while a request is still missing the one field its type needs.
    pub ready: bool,
    pub value: Option<String>,
    pub error: Option<String>,
    pub attempted_at: i64,
    pub updated_at: i64,
    pub failures: u32,
    pub points: Vec<crate::engine::series::SeriesPoint>,
}

/// Everything the request list draws. It is the home screen on phones, so it
/// carries the live values as well as the names.
#[tauri::command]
pub fn list_requests(app: AppHandle) -> serde_json::Value {
    let state = app.state::<AppState>();
    let requests = state.requests.lock().unwrap();
    let status = state.status.lock().unwrap();
    let history = state.series_history.lock().unwrap();
    let now = current_time_ms();
    let items: Vec<ListedRequest> = requests
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let current = status.get(&r.id);
            ListedRequest {
                id: r.id.clone(),
                name: model::display_name(r, i),
                ready: r.configured(),
                value: current.and_then(|c| c.value.as_deref()).map(to_text),
                error: current.and_then(crate::problem_with),
                attempted_at: current.map(|status| status.attempted_at).unwrap_or(0),
                updated_at: current.map(|status| status.updated_at).unwrap_or(0),
                failures: current.map(|status| status.failures).unwrap_or(0),
                points: history.snapshot_points(&r.id, now),
            }
        })
        .collect();
    json!({
        "requests": items,
        "paused": state.is_paused(),
        "max": model::MAX_REQUESTS,
    })
}

#[tauri::command]
pub fn notification_status(app: AppHandle) -> crate::notifications::NotificationReport {
    crate::notifications::status(&app)
}

#[tauri::command]
pub async fn enable_notifications(app: AppHandle) -> crate::notifications::NotificationReport {
    crate::notifications::enable(&app)
}

#[tauri::command]
pub async fn send_test_notification(app: AppHandle) -> crate::notifications::NotificationReport {
    let report = crate::notifications::send_test(&app);
    scheduler::log_line(&app, &format!("Notification test: {}", report.message));
    report
}

#[tauri::command]
pub fn open_notification_settings(app: AppHandle) -> Result<(), String> {
    crate::notifications::open_settings(&app)
}

/// The About page's outbound links. A fixed table rather than a URL argument,
/// so the webview cannot ask the OS to open anything else.
#[tauri::command]
pub fn open_project_link(app: AppHandle, target: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let url = match target.as_str() {
        "repo" => "https://github.com/hybes/http-mac-menu",
        "releases" => "https://github.com/hybes/http-mac-menu/releases/latest",
        "support" => "mailto:help@cnnct.uk",
        _ => return Err(format!("Unknown link: {target}")),
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

fn current_time_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Native facts the shared renderer cannot determine reliably for itself.
#[tauri::command]
pub fn app_info(app: AppHandle) -> serde_json::Value {
    #[cfg(target_os = "ios")]
    let background_refresh = crate::ios_background::availability();
    #[cfg(not(target_os = "ios"))]
    let background_refresh = serde_json::Value::Null;

    json!({
        "mobile": cfg!(mobile),
        "platform": std::env::consts::OS,
        "version": app.package_info().version.to_string(),
        "backgroundRefresh": background_refresh,
    })
}

/// iOS never shows the webview's own `confirm()` — it just answers yes — so the
/// one destructive button in the app asks natively instead.
#[tauri::command]
pub async fn confirm_remove(app: AppHandle, name: String) -> bool {
    app.dialog()
        .message(format!("Remove {name}? This deletes its settings."))
        .title("HTTP Widgets")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Remove".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show()
}

/// The tail of the log. Desktop has "Open Log" in the tray menu; a phone has
/// no way to reach the file at all, which makes a background refresh — the one
/// thing that happens while nobody is looking — impossible to confirm.
#[tauri::command]
pub fn read_log(app: AppHandle) -> String {
    const LINES: usize = 60;
    let path = scheduler::log_file_path(&app);
    let Ok(body) = std::fs::read_to_string(&path) else {
        return String::new();
    };
    let lines: Vec<&str> = body.lines().collect();
    lines[lines.len().saturating_sub(LINES)..].join("\n")
}

/// Lets the UI write to the same log the engine uses. `console.log` is
/// unreachable on a phone and invisible in a release desktop build.
#[tauri::command]
pub fn ui_log(app: AppHandle, message: String) {
    scheduler::log_line(&app, &format!("UI: {message}"));
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{list_presets, ListedRequest};

    #[test]
    fn preset_ids_are_stable_unique_and_described() {
        let presets = list_presets();
        assert_eq!(
            presets.iter().map(|preset| preset.id).collect::<Vec<_>>(),
            vec![
                "weather-london",
                "github-stars",
                "hacker-news-points",
                "solana-live-usd",
                "bitcoin-usd",
                "ethereum-holdings-gbp",
            ]
        );
        let unique: HashSet<&str> = presets.iter().map(|preset| preset.id).collect();
        assert_eq!(unique.len(), presets.len());
        assert!(presets
            .iter()
            .all(|preset| !preset.description.trim().is_empty()));
    }

    #[test]
    fn ethereum_holdings_preset_states_the_amount_it_values() {
        let preset = list_presets()
            .into_iter()
            .find(|preset| preset.id == "ethereum-holdings-gbp")
            .unwrap();
        assert_eq!(preset.values["holdings"], "1");
        assert!(preset.label.contains("1 ETH"));
        assert!(preset.description.contains("exactly 1 ETH"));
    }

    #[test]
    fn solana_preset_uses_the_batched_realtime_source() {
        let preset = list_presets()
            .into_iter()
            .find(|preset| preset.id == "solana-live-usd")
            .unwrap();
        assert_eq!(preset.values["provider"], "auto");
        assert_eq!(preset.values["coin"], "sol");
        assert_eq!(preset.values["currency"], "usd");
        assert_eq!(preset.values["timer"], "5");
    }

    #[test]
    fn listed_request_timestamps_use_the_workbench_contract() {
        let value = serde_json::to_value(ListedRequest {
            id: "r1".into(),
            name: "Example".into(),
            ready: true,
            value: Some("42".into()),
            error: None,
            attempted_at: 100,
            updated_at: 90,
            failures: 2,
            points: Vec::new(),
        })
        .unwrap();
        assert_eq!(value["attemptedAt"], 100);
        assert_eq!(value["updatedAt"], 90);
        assert_eq!(value["failures"], 2);
        assert!(value.get("attempted_at").is_none());
    }
}
