// The refresh scheduler: a one-second tick loop that mirrors the per-request
// setTimeout chains from the Electron version. With at most ten requests the
// tick is cheap and it makes backoff, pause, edits and wake-from-sleep easy to
// keep correct.

use std::time::{Duration, Instant};

use chrono::Local;
use tauri::{AppHandle, Manager};
use tokio::task::JoinSet;

use crate::state::{AppState, ReqStatus};

const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;

/// Owns one request generation's in-flight slot. Cancellation, stale replies
/// and ordinary completion all run `Drop`, so no path can strand the slot.
struct InFlightReservation<'a> {
    state: &'a AppState,
    id: String,
    generation: u64,
}

fn reserve_in_flight<'a>(
    state: &'a AppState,
    id: &str,
    generation: u64,
) -> Option<InFlightReservation<'a>> {
    let mut in_flight = state.in_flight.lock().unwrap();
    if in_flight.get(id) == Some(&generation) {
        return None;
    }
    in_flight.insert(id.to_string(), generation);
    Some(InFlightReservation {
        state,
        id: id.to_string(),
        generation,
    })
}

impl Drop for InFlightReservation<'_> {
    fn drop(&mut self) {
        let mut in_flight = self.state.in_flight.lock().unwrap();
        if in_flight.get(&self.id) == Some(&self.generation) {
            in_flight.remove(&self.id);
        }
    }
}

pub fn log_line(app: &AppHandle, line: &str) {
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("http-widgets.log");
    let stamped = format!("{} - {line}\n", Local::now().format("%Y-%m-%d %H:%M:%S"));
    use std::io::Write;
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > MAX_LOG_BYTES) {
        // Truncate before appending so the event that noticed the limit is not
        // immediately erased along with the old log.
        let _ = std::fs::write(&path, b"");
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(stamped.as_bytes());
    }
}

pub fn log_file_path(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_default()
        .join("http-widgets.log")
}

pub fn name_for(requests: &[crate::engine::model::Request], id: &str) -> String {
    match requests.iter().position(|r| r.id == id) {
        Some(i) => crate::engine::model::display_name(&requests[i], i),
        None => "Request".into(),
    }
}

fn next_refresh_seconds(state: &AppState, request: &crate::engine::model::Request) -> i64 {
    let base = crate::engine::format::parse_refresh_seconds_with_limits(
        &request.timer,
        request.min_refresh_seconds(),
        request.default_refresh_seconds(),
    );
    let status = state.status.lock().unwrap();
    let current = status.get(&request.id);
    if let Some(c) = current {
        // Apple may reject the first LAN connection immediately while its
        // privacy prompt is on screen. Two short retries make granting access
        // self-healing without permanently hammering an unavailable service.
        if !request.crypto()
            && crate::engine::sources::is_local_url(&request.url)
            && c.failures <= 2
            && c.failures > 0
        {
            return crate::engine::constants::LOCAL_FIRST_RETRY_SECONDS;
        }
        let failures = if crate::engine::sources::is_local_url(&request.url) {
            c.failures.saturating_sub(2)
        } else {
            c.failures
        };
        let multiplier = (2f64)
            .powi(failures as i32)
            .min(crate::engine::constants::MAX_BACKOFF_MULTIPLIER);
        ((base as f64 * multiplier) as i64).min(crate::engine::constants::MAX_BACKOFF_SECONDS)
    } else {
        base
    }
}

/// The whole engine tick. Returns whether anything changed on screen.
pub async fn run_tick(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    // Wake detection: wall clock jumped forward while we were not ticking.
    let now_wall = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    {
        let mut last = state.last_tick_wall.lock().unwrap();
        if now_wall.saturating_sub(*last as u64) > 90 && !state.is_paused() {
            log_line(app, "Woke from sleep or stall — refreshing");
            let mut due = state.due.lock().unwrap();
            for at in due.values_mut() {
                *at = Instant::now();
            }
        }
        *last = now_wall as i64;
    }

    // Durable state failures are recoverable. Retry them independently of
    // network updates (and even while paused) so a transient disk error cannot
    // become a duplicate alert or lost graph history after a restart.
    persist_pending_history(app, &state, false).await;
    persist_pending_rule_states(app, &state, false).await;

    if state.is_paused() {
        return false;
    }

    // Snapshot ids that are ready and due.
    let due_now: Vec<String> = {
        // A completed old generation must not block the replacement request,
        // but a currently running generation should not be queued again by
        // every heartbeat while its network request is outstanding.
        let in_flight = state.in_flight.lock().unwrap().clone();
        let generations = state.generations.lock().unwrap().clone();
        let requests = state.requests.lock().unwrap();
        let due = state.due.lock().unwrap();
        let mut out = Vec::new();
        for r in requests.iter() {
            if !r.configured() {
                continue;
            }
            let generation = generations.get(&r.id).copied().unwrap_or(0);
            if in_flight.get(&r.id) == Some(&generation) {
                continue;
            }
            let ready_at = due.get(&r.id).copied();
            if ready_at.is_none() || ready_at.is_some_and(|t| Instant::now() >= t) {
                out.push(r.id.clone());
            }
        }
        out
    };

    refresh_many(app, due_now).await
}

/// Refreshes independent endpoints concurrently, but with a small bound so a
/// batch cannot exhaust sockets or a mobile background execution budget.
pub async fn refresh_many(app: &AppHandle, ids: Vec<String>) -> bool {
    let jupiter_batch: std::sync::Arc<Vec<String>> = {
        let state = app.state::<AppState>();
        // Never wait behind a live crypto request merely to optimise the next
        // batch. Known mints still coalesce without this cache snapshot.
        let cache = state.coin_cache.try_lock().ok();
        let requests = state.requests.lock().unwrap();
        let mut mints = Vec::new();
        for request in requests.iter().filter(|request| ids.contains(&request.id)) {
            let mint = cache
                .as_ref()
                .and_then(|cache| {
                    crate::engine::sources::jupiter_batch_mint_from_cache(request, cache)
                })
                .or_else(|| crate::engine::sources::jupiter_batch_mint(request));
            if let Some(mint) = mint {
                if !mints.contains(&mint) {
                    mints.push(mint);
                }
            }
        }
        std::sync::Arc::new(mints)
    };
    let mut tasks = JoinSet::new();
    for id in ids {
        let app = app.clone();
        let jupiter_batch = jupiter_batch.clone();
        tasks.spawn(async move { refresh_request_with_batch(&app, &id, &jupiter_batch).await });
    }

    let mut changed = false;
    while let Some(task) = tasks.join_next().await {
        if matches!(task, Ok(true)) {
            changed = true;
        }
    }
    changed
}

/// Fetch one request. Returns true when its displayed value may have changed.
pub async fn refresh_request(app: &AppHandle, id: &str) -> bool {
    refresh_request_with_batch(app, id, &[]).await
}

async fn refresh_request_with_batch(app: &AppHandle, id: &str, jupiter_batch: &[String]) -> bool {
    let state = app.state::<AppState>();
    // Snapshot and reserve under the same boundary used by edit/remove. That
    // makes the generation belong to this exact request configuration, while
    // the reservation's atomic check+insert deduplicates overlapping triggers.
    let (request, generation, _reservation) = {
        let _commit = state.commit_lock.lock().await;
        let request = {
            let requests = state.requests.lock().unwrap();
            requests.iter().find(|request| request.id == id).cloned()
        };
        let Some(request) = request else { return false };
        if !request.configured() {
            return false;
        }
        let generation = state.generation_of(id);
        let Some(reservation) = reserve_in_flight(&state, id, generation) else {
            return false;
        };
        (request, generation, reservation)
    };

    // The configuration may have changed while this request waited for a
    // lane/permit. Do not send the superseded URL/headers merely to discard
    // its result later.
    let attempted_at = {
        let _commit = state.commit_lock.lock().await;
        if state.generation_of(id) != generation {
            return false;
        }
        let attempted_at = now_ms();
        state
            .status
            .lock()
            .unwrap()
            .entry(id.to_string())
            .or_default()
            .attempted_at = attempted_at;
        attempted_at
    };
    let client = crate::engine::sources::client();
    let mut pending_crypto = None;
    let validation_error = request.validate_for_save().err();
    let fetched = if let Some(error) = validation_error {
        Err(error)
    } else if request.crypto() {
        // Enter the serialized crypto lane before taking a global network
        // permit. Otherwise several crypto tasks can occupy every permit while
        // merely waiting for this mutex, starving independent HTTP widgets.
        // Fetch into staged copies. If an edit/remove invalidates this request
        // during the network await, its stale response must not update even
        // internal caches or price history.
        let cache = state.coin_cache.lock().await;
        let history = state.price_history.lock().await;
        let Ok(fetch_permit) = state.fetch_permits.clone().acquire_owned().await else {
            return false;
        };
        let mut next_cache = cache.clone();
        let mut next_history = history.clone();
        let result = crate::engine::sources::fetch_crypto_value(
            client,
            &request,
            &mut next_cache,
            &mut next_history,
            jupiter_batch,
            true,
        )
        .await;
        drop(fetch_permit);
        pending_crypto = Some((cache, history, next_cache, next_history));
        result
    } else {
        // The permit lives on AppState rather than the caller, so direct
        // post-save refreshes and overlapping tick/manual batches share one
        // ceiling. Reserve the id first so duplicates never queue permits.
        let Ok(fetch_permit) = state.fetch_permits.clone().acquire_owned().await else {
            return false;
        };
        let result = crate::engine::sources::fetch_http_value(client, &request).await;
        drop(fetch_permit);
        result
    };

    // Commit all response-derived state as one generation. Edits/removals use
    // this same lock, so a generation cannot become stale between this check
    // and status/history/alert mutation.
    let _commit = state.commit_lock.lock().await;
    if state.generation_of(id) != generation {
        return false;
    }
    if let Some((mut cache, mut history, next_cache, next_history)) = pending_crypto {
        *cache = next_cache;
        *history = next_history;
    }

    let name = name_for(&state.requests.lock().unwrap(), id);
    match fetched {
        Ok(f) => {
            let observed_at = now_ms();
            let (pct_24h, history_changed) = if let Some(numeric) = f.numeric {
                let mut history = state.series_history.lock().unwrap();
                let pct_24h = if request.crypto() {
                    f.pct_24h
                } else {
                    http_percent_change(&history, id, observed_at, numeric)
                };
                let changed = history.record(id, observed_at, numeric);
                (pct_24h, changed)
            } else {
                (f.pct_24h, false)
            };
            if history_changed {
                state.mark_history_changed();
            }
            let (fired_rules, mut alert_state_changed) =
                evaluate_alerts(&state, &request, &f, pct_24h);
            if alert_state_changed {
                state.mark_rule_states_changed();
            }
            {
                let mut status = state.status.lock().unwrap();
                status.insert(
                    id.to_string(),
                    ReqStatus {
                        value: Some(f.text.clone()),
                        numeric: f.numeric,
                        error: None,
                        attempted_at,
                        updated_at: observed_at,
                        failures: 0,
                    },
                );
            }
            if history_changed {
                persist_pending_history(app, &state, true).await;
            }
            log_line(
                app,
                &format!(
                    "Success ({name}): showing \"{}\" from {}",
                    crate::engine::indicators::to_text(&f.text),
                    f.raw_log
                ),
            );
            for rule_id in fired_rules {
                let delivered = fire_alert(app, &request, &rule_id, &f, &name).is_ok();
                let changed = {
                    let mut all_states = state.rule_states.lock().unwrap();
                    let states = all_states.entry(request.id.clone()).or_default();
                    crate::engine::rules::record_delivery_result(states, &rule_id, delivered)
                };
                alert_state_changed |= changed;
                if changed {
                    state.mark_rule_states_changed();
                }
            }
            if alert_state_changed {
                persist_pending_rule_states(app, &state, true).await;
            }
        }
        Err(message) => {
            {
                let mut status = state.status.lock().unwrap();
                let entry = status.entry(id.to_string()).or_default();
                entry.error = Some(message.clone());
                entry.attempted_at = attempted_at;
                entry.failures += 1;
            }
            log_line(app, &format!("Error ({name}): {message}"));
        }
    }

    let secs = next_refresh_seconds(&state, &request);
    state.due.lock().unwrap().insert(
        id.to_string(),
        Instant::now() + Duration::from_secs(secs.max(1) as u64),
    );

    true
}

async fn persist_pending_history(app: &AppHandle, state: &AppState, immediate: bool) {
    if state.persistence_is_degraded()
        || !state.history_needs_save()
        || (!immediate && !state.history_save_is_due())
    {
        return;
    }
    let _save = state.history_save_lock.lock().await;
    if state.persistence_is_degraded()
        || !state.history_needs_save()
        || (!immediate && !state.history_save_is_due())
    {
        return;
    }
    let revision = state.history_revision();
    let history = state.series_history.lock().unwrap().clone();
    match crate::settings::save_history(app, &history) {
        Ok(()) => state.mark_history_saved(revision),
        Err(error) => {
            state.defer_history_save();
            log_line(app, &format!("Could not save graph history: {error}"));
        }
    }
}

async fn persist_pending_rule_states(app: &AppHandle, state: &AppState, immediate: bool) {
    if state.persistence_is_degraded()
        || !state.rule_states_need_save()
        || (!immediate && !state.rule_state_save_is_due())
    {
        return;
    }
    let _save = state.rule_save_lock.lock().await;
    if state.persistence_is_degraded()
        || !state.rule_states_need_save()
        || (!immediate && !state.rule_state_save_is_due())
    {
        return;
    }
    let revision = state.rule_state_revision();
    let states = state.rule_states.lock().unwrap().clone();
    match crate::settings::save_rule_states(app, &states) {
        Ok(()) => state.mark_rule_states_saved(revision),
        Err(error) => {
            state.defer_rule_state_save();
            log_line(app, &format!("Could not save alert state: {error}"));
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn http_percent_change(
    history: &crate::engine::series::SeriesHistory,
    request_id: &str,
    observed_at: i64,
    current: f64,
) -> Option<f64> {
    if !current.is_finite() {
        return None;
    }
    let cutoff = observed_at.saturating_sub(crate::engine::constants::SERIES_GRAPH_WINDOW_MS);
    let baseline = history
        .snapshot_points(request_id, observed_at)
        .into_iter()
        .find(|point| point.timestamp >= cutoff)?
        .value;
    if !baseline.is_finite() || baseline.abs() <= f64::EPSILON {
        return None;
    }
    Some((current - baseline) / baseline.abs() * 100.0)
}

fn evaluate_alerts(
    state: &AppState,
    request: &crate::engine::model::Request,
    fetched: &crate::engine::sources::Fetched,
    pct_24h: Option<f64>,
) -> (Vec<String>, bool) {
    if request.alerts.is_empty() {
        return (vec![], false);
    }
    {
        let mut all_states = state.rule_states.lock().unwrap();
        let states = all_states.entry(request.id.clone()).or_default();
        let before = states.clone();
        let fired = crate::engine::rules::evaluate(
            &request.alerts,
            states,
            &crate::engine::rules::Evaluation {
                numeric: fetched.alert_numeric,
                text: fetched.text.clone(),
            },
            pct_24h,
        );
        (fired, *states != before)
    }
}

fn fire_alert(
    app: &AppHandle,
    request: &crate::engine::model::Request,
    rule_id: &str,
    fetched: &crate::engine::sources::Fetched,
    name: &str,
) -> Result<(), String> {
    let Some(rule) = request.alerts.iter().find(|r| r.id == rule_id) else {
        return Err("alert rule no longer exists".into());
    };
    let kind_label = match rule.kind.as_str() {
        "above" if request.crypto() => "price rose above",
        "below" if request.crypto() => "price fell below",
        "above" => "rose above",
        "below" => "fell below",
        "pct_up" => "gained",
        "pct_down" => "dropped",
        _ => "matched",
    };
    let target = if matches!(
        rule.kind.as_str(),
        "above" | "below" | "pct_up" | "pct_down"
    ) {
        format!(" {}", rule.value.trim())
    } else {
        String::new()
    };
    let value = if matches!(
        rule.kind.as_str(),
        "above" | "below" | "pct_up" | "pct_down"
    ) {
        &fetched.alert_text
    } else {
        &fetched.text
    };
    let title = format!("{name}: alert");
    let body = format!(
        "{} {}{} — now {}",
        name,
        kind_label,
        target,
        crate::engine::indicators::to_text(value)
    );
    match crate::notifications::send_alert(app, title, body.clone()) {
        Ok(()) => {
            log_line(
                app,
                &format!(
                    "Alert submitted ({name}, rule {rule_id} [{}, {}]): {body}",
                    rule.kind,
                    rule.value.trim()
                ),
            );
            Ok(())
        }
        Err(error) => {
            log_line(
                app,
                &format!("Alert delivery failed ({name}, rule {rule_id}): {error}"),
            );
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};

    use super::*;

    #[test]
    fn concurrent_reservations_deduplicate_one_generation() {
        const WORKERS: usize = 8;
        let state = Arc::new(AppState::new());
        let start = Arc::new(Barrier::new(WORKERS + 1));
        let attempted = Arc::new(Barrier::new(WORKERS + 1));
        let winners = Arc::new(AtomicUsize::new(0));
        let mut threads = Vec::new();

        for _ in 0..WORKERS {
            let state = state.clone();
            let start = start.clone();
            let attempted = attempted.clone();
            let winners = winners.clone();
            threads.push(std::thread::spawn(move || {
                start.wait();
                let reservation = reserve_in_flight(&state, "r1", 7);
                if reservation.is_some() {
                    winners.fetch_add(1, Ordering::SeqCst);
                }
                // Keep the winner alive until every thread has attempted the
                // atomic check+insert.
                attempted.wait();
                drop(reservation);
            }));
        }

        start.wait();
        attempted.wait();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(winners.load(Ordering::SeqCst), 1);
        assert!(state.in_flight.lock().unwrap().is_empty());
    }

    #[test]
    fn old_reservation_drop_does_not_remove_a_new_generation() {
        let state = AppState::new();
        let old = reserve_in_flight(&state, "r1", 1).unwrap();
        let new = reserve_in_flight(&state, "r1", 2).unwrap();

        drop(old);
        assert_eq!(state.in_flight.lock().unwrap().get("r1"), Some(&2));
        drop(new);
        assert!(state.in_flight.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn aborting_a_refresh_owner_releases_its_reservation() {
        let state = Arc::new(AppState::new());
        let task_state = state.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _reservation = reserve_in_flight(&task_state, "r1", 1).unwrap();
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        });

        started_rx.await.unwrap();
        assert_eq!(state.in_flight.lock().unwrap().get("r1"), Some(&1));
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(state.in_flight.lock().unwrap().is_empty());
    }

    #[test]
    fn crypto_below_alert_compares_unit_price_not_holdings_balance() {
        let values = serde_json::json!({
            "type": "crypto",
            "coin": "SOL",
            "holdings": "0",
            "currency": "usd",
            "template": "{price}",
            "alerts": [{
                "id": "price-below",
                "kind": "below",
                "value": "100",
                "cooldown_secs": 0
            }]
        });
        let request = crate::engine::model::request_from_clean("r1", values.as_object().unwrap());
        let state = AppState::new();
        let mut fetched = crate::engine::sources::Fetched {
            text: "$104.299".into(),
            raw_log: String::new(),
            numeric: Some(0.0),
            alert_numeric: Some(104.299),
            alert_text: "$104.299".into(),
            pct_24h: Some(1.0),
        };

        let (fired, _) = evaluate_alerts(&state, &request, &fetched, Some(1.0));
        assert!(fired.is_empty());

        fetched.alert_numeric = Some(99.0);
        fetched.alert_text = "$99.000".into();
        let (fired, _) = evaluate_alerts(&state, &request, &fetched, Some(-1.0));
        assert_eq!(fired, ["price-below"]);
    }

    #[test]
    fn http_percent_change_uses_the_oldest_graph_observation() {
        let now = 2_000_000_000_000;
        let mut history = crate::engine::series::SeriesHistory::default();
        history.record("r1", now - 23 * 60 * 60 * 1000, 100.0);
        history.record("r1", now - 60 * 60 * 1000, 110.0);

        assert_eq!(http_percent_change(&history, "r1", now, 125.0), Some(25.0));
        assert_eq!(http_percent_change(&history, "missing", now, 125.0), None);
    }

    #[test]
    fn http_percent_change_rejects_a_zero_baseline() {
        let now = 2_000_000_000_000;
        let mut history = crate::engine::series::SeriesHistory::default();
        history.record("r1", now - 60_000, 0.0);

        assert_eq!(http_percent_change(&history, "r1", now, 1.0), None);
    }

    #[test]
    fn http_percent_change_ignores_graph_context_older_than_24_hours() {
        let now = 2_000_000_000_000;
        let mut history = crate::engine::series::SeriesHistory::default();
        history.record("r1", now - 25 * 60 * 60 * 1000, 100.0);
        history.record("r1", now - 60 * 60 * 1000, 110.0);

        let change = http_percent_change(&history, "r1", now, 121.0).unwrap();
        assert!((change - 10.0).abs() < f64::EPSILON);
    }
}
