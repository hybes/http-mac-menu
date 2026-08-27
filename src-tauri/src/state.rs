// Shared application state: the request list, live status, scheduler
// bookkeeping and the alert rule states.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::engine::model::Request;
use crate::engine::price_history::PriceHistory;
use crate::engine::rules::RuleState;
use crate::engine::series::SeriesHistory;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ReqStatus {
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub numeric: Option<f64>,
    #[serde(default)]
    pub error: Option<String>,
    // Millisecond epochs of the latest attempt and latest successful value.
    #[serde(default)]
    pub attempted_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub failures: u32,
}

pub type RuleStates = HashMap<String, HashMap<String, RuleState>>;

pub struct AppState {
    pub requests: Mutex<Vec<Request>>,
    pub status: Mutex<HashMap<String, ReqStatus>>,
    /// Bumped on edit/remove; replies from older generations are discarded.
    pub generations: Mutex<HashMap<String, u64>>,
    /// Generation whose fetch is currently running per request.
    pub in_flight: Mutex<HashMap<String, u64>>,
    /// One limit across tick, manual and post-save refresh batches. A semaphore
    /// created inside each batch would allow overlapping batches to exceed the
    /// intended network concurrency.
    pub fetch_permits: Arc<tokio::sync::Semaphore>,
    /// Serializes configuration invalidation with response commits. Fetches do
    /// not hold this while awaiting the network; they reacquire it and verify
    /// their generation before changing any user-visible or durable state.
    pub commit_lock: tokio::sync::Mutex<()>,
    /// When the next refresh is due (scheduler instant).
    pub due: Mutex<HashMap<String, std::time::Instant>>,
    pub paused: AtomicBool,
    pub indicator: Mutex<String>,
    /// Dock and app-switcher presence; see settings::Loaded.
    pub show_in_dock: AtomicBool,
    // The crypto source owns these across its await. Async mutexes serialize
    // crypto refreshes without blocking unrelated HTTP requests or losing
    // cache/history updates when several requests are due together.
    pub price_history: tokio::sync::Mutex<PriceHistory>,
    pub coin_cache: tokio::sync::Mutex<HashMap<String, String>>,
    /// Numeric observations rendered by the web and native widgets.
    pub series_history: Mutex<SeriesHistory>,
    /// Serializes durable history snapshots so concurrent HTTP completions
    /// cannot let an older clone overwrite a newer one.
    pub history_save_lock: tokio::sync::Mutex<()>,
    history_revision: AtomicU64,
    history_saved_revision: AtomicU64,
    history_save_retry_at: Mutex<std::time::Instant>,
    /// Alert edge/cooldown state is independent of the latest request status
    /// and survives restarts, preventing an already-active rule re-firing on
    /// every launch.
    pub rule_states: Mutex<RuleStates>,
    pub rule_save_lock: tokio::sync::Mutex<()>,
    rule_state_revision: AtomicU64,
    rule_state_saved_revision: AtomicU64,
    rule_save_retry_at: Mutex<std::time::Instant>,
    /// A failed transaction rollback leaves a recovery journal authoritative.
    /// Suppress later durable writes until that journal is recovered so newer
    /// graph/alert snapshots cannot be overwritten by its older before-image.
    persistence_degraded: AtomicBool,
    /// Set by the renderer so closing the window knows whether to ask.
    pub ui_dirty: AtomicBool,
    /// Last time the scheduler ran; a big wall-clock jump means the machine slept.
    pub last_tick_wall: Mutex<i64>,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            requests: Mutex::new(vec![]),
            status: Mutex::new(HashMap::new()),
            generations: Mutex::new(HashMap::new()),
            in_flight: Mutex::new(HashMap::new()),
            fetch_permits: Arc::new(tokio::sync::Semaphore::new(
                crate::engine::constants::MAX_CONCURRENT_REQUESTS,
            )),
            commit_lock: tokio::sync::Mutex::new(()),
            due: Mutex::new(HashMap::new()),
            paused: AtomicBool::new(false),
            indicator: Mutex::new("chevron".into()),
            show_in_dock: AtomicBool::new(false),
            price_history: tokio::sync::Mutex::new(PriceHistory::default()),
            coin_cache: tokio::sync::Mutex::new(HashMap::new()),
            series_history: Mutex::new(SeriesHistory::default()),
            history_save_lock: tokio::sync::Mutex::new(()),
            history_revision: AtomicU64::new(0),
            history_saved_revision: AtomicU64::new(0),
            history_save_retry_at: Mutex::new(std::time::Instant::now()),
            rule_states: Mutex::new(HashMap::new()),
            rule_save_lock: tokio::sync::Mutex::new(()),
            rule_state_revision: AtomicU64::new(0),
            rule_state_saved_revision: AtomicU64::new(0),
            rule_save_retry_at: Mutex::new(std::time::Instant::now()),
            persistence_degraded: AtomicBool::new(false),
            ui_dirty: AtomicBool::new(false),
            last_tick_wall: Mutex::new(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0),
            ),
        }
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    pub fn set_paused(&self, v: bool) {
        self.paused.store(v, Ordering::SeqCst);
    }

    pub fn generation_of(&self, id: &str) -> u64 {
        self.generations
            .lock()
            .unwrap()
            .get(id)
            .copied()
            .unwrap_or(0)
    }

    /// Forget what a request was showing and disown any fetch still running.
    pub fn invalidate(&self, id: &str) {
        let mut gens = self.generations.lock().unwrap();
        let next = gens.get(id).copied().unwrap_or(0) + 1;
        gens.insert(id.to_string(), next);
        drop(gens);
        self.status.lock().unwrap().remove(id);
        self.due.lock().unwrap().remove(id);
    }

    pub fn mark_history_changed(&self) {
        self.history_revision.fetch_add(1, Ordering::SeqCst);
        *self.history_save_retry_at.lock().unwrap() = std::time::Instant::now();
    }

    pub fn history_needs_save(&self) -> bool {
        self.history_saved_revision.load(Ordering::SeqCst)
            < self.history_revision.load(Ordering::SeqCst)
    }

    pub fn history_save_is_due(&self) -> bool {
        self.history_needs_save()
            && std::time::Instant::now() >= *self.history_save_retry_at.lock().unwrap()
    }

    pub fn defer_history_save(&self) {
        *self.history_save_retry_at.lock().unwrap() =
            std::time::Instant::now() + std::time::Duration::from_secs(30);
    }

    pub fn mark_history_saved(&self, revision: u64) {
        self.history_saved_revision
            .fetch_max(revision, Ordering::SeqCst);
    }

    pub fn mark_history_synced(&self) {
        self.history_saved_revision.store(
            self.history_revision.load(Ordering::SeqCst),
            Ordering::SeqCst,
        );
    }

    pub fn history_revision(&self) -> u64 {
        self.history_revision.load(Ordering::SeqCst)
    }

    pub fn mark_rule_states_changed(&self) {
        self.rule_state_revision.fetch_add(1, Ordering::SeqCst);
        *self.rule_save_retry_at.lock().unwrap() = std::time::Instant::now();
    }

    pub fn rule_states_need_save(&self) -> bool {
        self.rule_state_saved_revision.load(Ordering::SeqCst)
            < self.rule_state_revision.load(Ordering::SeqCst)
    }

    pub fn rule_state_save_is_due(&self) -> bool {
        self.rule_states_need_save()
            && std::time::Instant::now() >= *self.rule_save_retry_at.lock().unwrap()
    }

    pub fn defer_rule_state_save(&self) {
        *self.rule_save_retry_at.lock().unwrap() =
            std::time::Instant::now() + std::time::Duration::from_secs(30);
    }

    pub fn mark_rule_states_saved(&self, revision: u64) {
        self.rule_state_saved_revision
            .fetch_max(revision, Ordering::SeqCst);
    }

    pub fn mark_rule_states_synced(&self) {
        self.rule_state_saved_revision.store(
            self.rule_state_revision.load(Ordering::SeqCst),
            Ordering::SeqCst,
        );
    }

    pub fn rule_state_revision(&self) -> u64 {
        self.rule_state_revision.load(Ordering::SeqCst)
    }

    pub fn persistence_is_degraded(&self) -> bool {
        self.persistence_degraded.load(Ordering::SeqCst)
    }

    pub fn mark_persistence_degraded(&self) {
        self.persistence_degraded.store(true, Ordering::SeqCst);
    }

    pub fn clear_persistence_degraded(&self) {
        self.persistence_degraded.store(false, Ordering::SeqCst);
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durable_revisions_stay_dirty_until_the_latest_snapshot_is_saved() {
        let state = AppState::new();
        state.mark_history_changed();
        let first_history = state.history_revision();
        state.mark_history_changed();
        state.mark_history_saved(first_history);
        assert!(state.history_needs_save());
        state.mark_history_saved(state.history_revision());
        assert!(!state.history_needs_save());

        state.mark_rule_states_changed();
        let first_rules = state.rule_state_revision();
        state.mark_rule_states_changed();
        state.mark_rule_states_saved(first_rules);
        assert!(state.rule_states_need_save());
        state.mark_rule_states_saved(state.rule_state_revision());
        assert!(!state.rule_states_need_save());
    }
}
