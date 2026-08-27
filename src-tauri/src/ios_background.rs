// iOS suspends the app the moment it leaves the screen, which stops the engine
// tick and with it every alert. BGTaskScheduler is the only way back in: iOS
// wakes the process every so often, hands it a short window, and expects to be
// told when the work is done.
//
// The Swift half (gen/apple/Sources/http-widgets/BackgroundRefresh.swift)
// registers the task and calls in here; this side does one full refresh pass,
// which is the same code the foreground tick runs, so alerts fire and the
// widget snapshot is rewritten exactly as they would with the app open.
//
// iOS decides when — typically no more often than every 15 minutes, and less
// on a phone that rarely opens the app. It is a best effort, not a schedule.

use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use tauri::AppHandle;

/// Whether iOS currently permits opportunistic background work. Low Power Mode
/// reports `denied` too, so the UI explains both causes instead of claiming the
/// user necessarily changed an app setting.
#[cfg(target_os = "ios")]
pub fn availability() -> &'static str {
    use objc2::MainThreadMarker;
    use objc2_ui_kit::{UIApplication, UIBackgroundRefreshStatus};

    let Some(main_thread) = MainThreadMarker::new() else {
        return "unknown";
    };
    match UIApplication::sharedApplication(main_thread).backgroundRefreshStatus() {
        UIBackgroundRefreshStatus::Available => "available",
        UIBackgroundRefreshStatus::Denied => "denied",
        UIBackgroundRefreshStatus::Restricted => "restricted",
        _ => "unknown",
    }
}

/// The window iOS gives a refresh task is around 30 seconds, and it kills the
/// app if `setTaskCompleted` has not been called by then. Stopping short of
/// that leaves room to report the result and queue the next one.
const BUDGET: Duration = Duration::from_secs(25);
/// A cancellation request crosses from Swift on a different thread. Polling at
/// this cadence keeps the FFI surface synchronous while still dropping the
/// refresh future quickly enough to leave iOS plenty of expiration headroom.
const CANCELLATION_POLL: Duration = Duration::from_millis(10);

static APP: OnceLock<AppHandle> = OnceLock::new();
static TASKS: CancellationState = CancellationState::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RefreshCompletion {
    Finished,
    Cancelled,
    TimedOut,
}

/// One BGAppRefreshTask can be active for this identifier. Tokens make a late
/// expiration callback harmless: it can cancel only the task it belongs to,
/// never a newer refresh that iOS has started afterward.
struct CancellationState {
    next: AtomicU64,
    active: AtomicU64,
    cancelled: AtomicU64,
}

impl CancellationState {
    const fn new() -> Self {
        Self {
            next: AtomicU64::new(1),
            active: AtomicU64::new(0),
            cancelled: AtomicU64::new(0),
        }
    }

    fn prepare(&self) -> u64 {
        // A u64 token cannot realistically wrap during the lifetime of an app.
        // Zero remains reserved for "no active task".
        let task_id = self.next.fetch_add(1, Ordering::SeqCst);
        self.cancelled.store(0, Ordering::SeqCst);
        self.active.store(task_id, Ordering::SeqCst);
        task_id
    }

    fn cancel(&self, task_id: u64) -> bool {
        if task_id == 0 || self.active.load(Ordering::SeqCst) != task_id {
            return false;
        }
        self.cancelled.store(task_id, Ordering::SeqCst);
        true
    }

    fn is_cancelled(&self, task_id: u64) -> bool {
        task_id == 0
            || self.active.load(Ordering::SeqCst) != task_id
            || self.cancelled.load(Ordering::SeqCst) == task_id
    }

    fn finish(&self, task_id: u64) {
        let _ = self
            .active
            .compare_exchange(task_id, 0, Ordering::SeqCst, Ordering::SeqCst);
        let _ = self
            .cancelled
            .compare_exchange(task_id, 0, Ordering::SeqCst, Ordering::SeqCst);
    }
}

struct ActiveTask(u64);

impl Drop for ActiveTask {
    fn drop(&mut self) {
        TASKS.finish(self.0);
    }
}

async fn wait_for_cancellation(state: &CancellationState, task_id: u64) {
    while !state.is_cancelled(task_id) {
        tokio::time::sleep(CANCELLATION_POLL).await;
    }
}

async fn run_with_controls<F, T>(
    state: &CancellationState,
    task_id: u64,
    budget: Duration,
    work: F,
) -> RefreshCompletion
where
    F: Future<Output = T>,
{
    if state.is_cancelled(task_id) {
        return RefreshCompletion::Cancelled;
    }

    let cancellation = wait_for_cancellation(state, task_id);
    let timeout = tokio::time::sleep(budget);
    tokio::pin!(cancellation);
    tokio::pin!(timeout);
    tokio::pin!(work);

    tokio::select! {
        biased;
        _ = &mut cancellation => RefreshCompletion::Cancelled,
        _ = &mut timeout => RefreshCompletion::TimedOut,
        _ = &mut work => {
            if state.is_cancelled(task_id) {
                RefreshCompletion::Cancelled
            } else {
                RefreshCompletion::Finished
            }
        }
    }
}

/// Called from `setup`, which runs before `UIApplicationMain` and so before any
/// task can fire.
pub fn remember(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

/// Reserves a token before Swift queues the work item. Doing this synchronously
/// means an expiration that arrives before the worker starts is not lost.
#[no_mangle]
pub extern "C" fn http_widgets_background_refresh_prepare() -> u64 {
    TASKS.prepare()
}

/// Signals the Rust future from iOS' expiration callback. The future is dropped
/// on the background worker, which in turn aborts the refresh batch's JoinSet.
#[no_mangle]
pub extern "C" fn http_widgets_background_refresh_cancel(task_id: u64) {
    let _ = TASKS.cancel(task_id);
}

/// `1` if the refresh finished inside the budget, `0` otherwise. iOS uses that
/// answer to decide how generous to be with the next window, so a timeout must
/// be reported honestly rather than swallowed.
///
/// # Safety
/// Called by the Swift task handler on a background queue. `task_id` must be the
/// token returned by [`http_widgets_background_refresh_prepare`]. Calling it
/// before `remember`, with a stale token, or after cancellation returns 0.
#[no_mangle]
pub extern "C" fn http_widgets_background_refresh(task_id: u64) -> i32 {
    let _active = ActiveTask(task_id);
    if TASKS.is_cancelled(task_id) {
        return 0;
    }
    let Some(app) = APP.get() else {
        return 0;
    };
    let app = app.clone();

    crate::scheduler::log_line(&app, "Background refresh started");
    let completion = tauri::async_runtime::block_on(run_with_controls(
        &TASKS,
        task_id,
        BUDGET,
        // A BGAppRefreshTask is scheduled maintenance, not a user-requested
        // refresh, so it must honour the app's Pause setting.
        crate::refresh_everything(&app, false),
    ));

    crate::scheduler::log_line(
        &app,
        match completion {
            RefreshCompletion::Finished => "Background refresh finished",
            RefreshCompletion::Cancelled => "Background refresh cancelled by iOS",
            RefreshCompletion::TimedOut => "Background refresh ran out of time",
        },
    );
    i32::from(completion == RefreshCompletion::Finished)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::time::Instant;

    #[test]
    fn a_stale_token_cannot_cancel_a_new_task() {
        let state = CancellationState::new();
        let first = state.prepare();
        assert!(state.cancel(first));
        assert!(state.is_cancelled(first));
        state.finish(first);

        let second = state.prepare();
        assert_ne!(first, second);
        assert!(!state.cancel(first));
        assert!(!state.is_cancelled(second));
    }

    #[test]
    fn cancellation_drops_running_work_promptly() {
        let state = Arc::new(CancellationState::new());
        let task_id = state.prepare();
        let canceller = state.clone();
        let completed = Arc::new(AtomicBool::new(false));
        let completed_by_work = completed.clone();
        let started = Instant::now();

        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            assert!(canceller.cancel(task_id));
        });
        let completion = tauri::async_runtime::block_on(run_with_controls(
            &state,
            task_id,
            Duration::from_secs(2),
            async move {
                tokio::time::sleep(Duration::from_secs(1)).await;
                completed_by_work.store(true, Ordering::SeqCst);
            },
        ));
        thread.join().unwrap();

        assert_eq!(completion, RefreshCompletion::Cancelled);
        assert!(!completed.load(Ordering::SeqCst));
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn budget_expiry_drops_running_work() {
        let state = CancellationState::new();
        let task_id = state.prepare();
        let completed = Arc::new(AtomicBool::new(false));
        let completed_by_work = completed.clone();

        let completion = tauri::async_runtime::block_on(run_with_controls(
            &state,
            task_id,
            Duration::from_millis(20),
            async move {
                tokio::time::sleep(Duration::from_secs(1)).await;
                completed_by_work.store(true, Ordering::SeqCst);
            },
        ));

        assert_eq!(completion, RefreshCompletion::TimedOut);
        assert!(!completed.load(Ordering::SeqCst));
    }
}
