// App wiring: plugins, tray, config window, and the one-second engine tick.

pub mod accent;
#[cfg(target_os = "android")]
mod android_widget;
pub mod commands;
pub mod engine;
#[cfg(target_os = "ios")]
pub mod ios_background;
#[cfg(target_os = "ios")]
mod ios_scene;
pub mod notifications;
pub mod scheduler;
pub mod settings;
pub mod state;

use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Instant;

#[cfg(desktop)]
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
#[cfg(desktop)]
use tauri_plugin_opener::OpenerExt;

// Only the tray formats titles and menu labels.
#[cfg(desktop)]
use crate::engine::constants;
#[cfg(desktop)]
use crate::engine::format;
use crate::engine::indicators::to_text;
use crate::state::{AppState, ReqStatus};

/// What the tray last looked like, so an unchanged second does not rebuild the
/// menu (replacing it closes it if it is open).
#[derive(Default)]
pub struct TrayRenderCache {
    pub last_rendered: Mutex<Option<(String, String, String)>>,
    pub last_widget_snapshot: Mutex<Option<String>>,
}

#[cfg(desktop)]
const TRAY_ID: &str = "http-widgets-tray";
#[cfg(desktop)]
const CONFIG_WINDOW_LABEL: &str = "config";
#[cfg(desktop)]
static DISCARD_PROMPT_OPEN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
/// The single webview a phone gets. It is created up front because there is
/// no menu bar there to open one from.
#[cfg(mobile)]
const MAIN_WINDOW_LABEL: &str = "main";

#[cfg(target_os = "ios")]
fn harden_ios_webview(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|platform| unsafe {
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2_ui_kit::{UIScrollView, UIScrollViewKeyboardDismissMode};

        let webview = &*platform.inner().cast::<AnyObject>();
        let scroll_view: Retained<UIScrollView> = objc2::msg_send![webview, scrollView];
        scroll_view.setShowsVerticalScrollIndicator(false);
        scroll_view.setShowsHorizontalScrollIndicator(false);
        // Keep the scrollbar and browser chrome hidden, but retain iOS's
        // native edge resistance/rubber-banding so scrolling feels like an
        // application rather than a constrained web page.
        scroll_view.setBounces(true);
        scroll_view.setAlwaysBounceVertical(true);
        scroll_view.setAlwaysBounceHorizontal(false);
        scroll_view.setDirectionalLockEnabled(true);
        scroll_view.setKeyboardDismissMode(UIScrollViewKeyboardDismissMode::Interactive);
        if let Some(pinch) = scroll_view.pinchGestureRecognizer() {
            pinch.setEnabled(false);
        }
        let _: () = objc2::msg_send![webview, setAllowsLinkPreview: false];
    })
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        // Second launch: bring the existing app to the front instead.
        let id = {
            let state = app.state::<AppState>();
            let requests = state.requests.lock().unwrap();
            requests
                .first()
                .map(|r| r.id.clone())
                .unwrap_or_else(|| "new".into())
        };
        open_config(app, &id);
    }));

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None,
    ));

    #[cfg(target_os = "android")]
    let builder = builder.plugin(android_widget::init());

    let app = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .manage(TrayRenderCache::default())
        .invoke_handler(tauri::generate_handler![
            commands::load_config,
            commands::save_config,
            commands::remove_config,
            commands::test_config,
            commands::import_curl,
            commands::list_presets,
            commands::set_dirty,
            commands::close_config,
            commands::fit_window,
            commands::accent_color,
            commands::refresh_all,
            commands::refresh_request_now,
            commands::set_updates_paused,
            commands::copy_request_value,
            commands::copy_all_values,
            commands::list_requests,
            commands::notification_status,
            commands::enable_notifications,
            commands::send_test_notification,
            commands::open_notification_settings,
            commands::app_info,
            commands::confirm_remove,
            commands::read_log,
            commands::ui_log,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // A background refresh can arrive as soon as launching finishes, so
            // the handle it needs is published here rather than later.
            #[cfg(target_os = "ios")]
            ios_background::remember(&handle);

            let loaded = settings::load(&handle).map_err(std::io::Error::other)?;
            let startup_warning = loaded.warning.clone();
            if loaded.imported {
                // Write the imported document back out in the new shape so the
                // legacy lookup never has to happen again.
                let _ = settings::save(
                    &handle,
                    &loaded.indicator,
                    loaded.show_in_dock,
                    &loaded.requests,
                );
            }
            {
                let state = handle.state::<AppState>();
                let cached_status = settings::load_widget_statuses(
                    &handle,
                    loaded
                        .requests
                        .iter()
                        .filter(|request| request.configured())
                        .map(|request| request.id.as_str()),
                );
                let mut history = settings::load_history(&handle);
                history
                    .retain_request_ids(loaded.requests.iter().map(|request| request.id.as_str()));
                let mut rule_states = settings::load_rule_states(&handle);
                rule_states.retain(|request_id, rules| {
                    let Some(request) = loaded
                        .requests
                        .iter()
                        .find(|request| request.id == *request_id)
                    else {
                        return false;
                    };
                    rules
                        .retain(|rule_id, _| request.alerts.iter().any(|rule| rule.id == *rule_id));
                    !rules.is_empty()
                });
                *state.requests.lock().unwrap() = loaded.requests;
                *state.status.lock().unwrap() = cached_status;
                *state.indicator.lock().unwrap() = loaded.indicator;
                *state.series_history.lock().unwrap() = history;
                *state.rule_states.lock().unwrap() = rule_states;
                state
                    .show_in_dock
                    .store(loaded.show_in_dock, Ordering::SeqCst);
            }

            scheduler::log_line(
                &handle,
                &format!("Started HTTP Widgets {}", app.package_info().version),
            );
            if let Some(warning) = startup_warning {
                scheduler::log_line(&handle, &warning);
            }

            // The engine heartbeat. One tick a second is cheap with at most
            // ten requests and keeps every scheduling rule in one place.
            let tick_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    // A slow endpoint must not stop the one-second heartbeat.
                    // Each due batch owns its own task; the scheduler's
                    // generation/in-flight reservations deduplicate the next
                    // tick while that batch is still running.
                    let batch_handle = tick_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        if scheduler::run_tick(&batch_handle).await {
                            render_tray(&batch_handle);
                        }
                    });
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            });

            #[cfg(desktop)]
            {
                use tauri::tray::TrayIconBuilder;
                let mut tray_builder =
                    TrayIconBuilder::with_id(TRAY_ID).on_menu_event(|app, event| {
                        handle_tray_menu_event(app, event.id().as_ref());
                    });
                if !cfg!(target_os = "macos") {
                    // macOS shows the live text as the whole tray; elsewhere
                    // there is only the icon itself.
                    if let Some(icon) = app.default_window_icon().cloned() {
                        tray_builder = tray_builder.icon(icon);
                    }
                }
                tray_builder.build(app)?;
            }

            #[cfg(target_os = "macos")]
            {
                apply_activation_policy(&handle);
                install_app_menu(&handle)?;
            }

            render_tray(&handle);

            // The request list stands in for the menu bar on phones.
            #[cfg(mobile)]
            {
                let url = WebviewUrl::App("index.html".into());
                let _window = WebviewWindowBuilder::new(&handle, MAIN_WINDOW_LABEL, url)
                    .title("HTTP Widgets")
                    .zoom_hotkeys_enabled(false)
                    .build()?;
                #[cfg(target_os = "ios")]
                harden_ios_webview(&_window)?;
            }

            // Desktop shows nothing at all until the menu bar has an entry, so
            // a first run goes straight to the form. Phones have the list.
            #[cfg(desktop)]
            {
                let requests_empty = {
                    let state = handle.state::<AppState>();
                    let requests = state.requests.lock().unwrap();
                    requests.is_empty()
                };
                if requests_empty {
                    open_config(&handle, "new");
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building HTTP Widgets");

    // Building creates tao's AppDelegate; running enters UIApplicationMain.
    // Install the iOS 27 scene-lifecycle compatibility fix between those two
    // operations, before UIKit asks the delegate for its first scene.
    #[cfg(target_os = "ios")]
    ios_scene::install().expect("failed to install the iOS scene lifecycle patch");

    app.run(|app, event| {
        // Mobile operating systems suspend the process rather than letting the
        // one-second heartbeat continue in the background. Refresh through the
        // shared engine as soon as the event loop resumes, even if the saved
        // per-request deadline has not elapsed yet. In-flight reservations make
        // this safe when the initial heartbeat and resume arrive together.
        #[cfg(mobile)]
        let resumed = match &event {
            // tauri-runtime-wry forwards winit's mobile lifecycle event to
            // each window. Match the one shared phone window so a future iPad
            // multi-window scene cannot trigger one full batch per scene.
            tauri::RunEvent::WindowEvent { label, event, .. } => {
                label == MAIN_WINDOW_LABEL && matches!(event, tauri::WindowEvent::Resumed)
            }
            // Keep the top-level variant for alternate runtimes and future
            // Tauri versions that may expose resume there directly.
            tauri::RunEvent::Resumed => true,
            _ => false,
        };
        #[cfg(mobile)]
        if resumed {
            let handle = app.clone();
            scheduler::log_line(&handle, "App resumed — refreshing");
            tauri::async_runtime::spawn(async move {
                refresh_everything(&handle, false).await;
            });
        }

        #[cfg(not(mobile))]
        let _ = (app, event);
    });
}

// ---------------------------------------------------------------------------
// Status views (ports of trayTitleFor / tooltipFor / menuLabelFor)
// ---------------------------------------------------------------------------

/// Why a request is not showing a fresh value, or None when it is fine.
pub(crate) fn problem_with(status: &ReqStatus) -> Option<String> {
    status.error.clone()
}

#[cfg(desktop)]
fn format_clock(ms: i64) -> String {
    chrono::DateTime::<chrono::Local>::from(
        std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms.max(0) as u64),
    )
    .format("%H:%M:%S")
    .to_string()
}

#[cfg(desktop)]
fn tray_title_for(status: Option<&ReqStatus>) -> String {
    match status {
        None => constants::PENDING_TITLE.into(),
        Some(c) => {
            let value = c
                .value
                .as_deref()
                .map(|v| format::truncate(v, constants::MAX_ITEM_TITLE_CHARS));
            match problem_with(c) {
                Some(_) => match value {
                    Some(v) => format!(
                        "{} {v}",
                        crate::engine::indicators::text_glyph(crate::engine::indicators::MARK_WARN)
                    ),
                    None => {
                        crate::engine::indicators::text_glyph(crate::engine::indicators::MARK_WARN)
                            .to_string()
                    }
                },
                None => value.unwrap_or_else(|| constants::PENDING_TITLE.into()),
            }
        }
    }
}

#[cfg(desktop)]
fn tooltip_for(name: &str, status: Option<&ReqStatus>) -> String {
    let Some(c) = status else {
        return format!("{name}: loading…");
    };
    match problem_with(c) {
        Some(problem) => match c.value.as_deref() {
            Some(value) if !value.is_empty() => format!(
                "{name}: {problem} (showing value from {})",
                format_clock(c.updated_at)
            ),
            _ => format!("{name}: {problem}"),
        },
        None => format!(
            "{name}: {} (updated {})",
            to_text(c.value.as_deref().unwrap_or("")),
            format_clock(c.updated_at)
        ),
    }
}

#[cfg(desktop)]
fn menu_label_for(name: &str, ready: bool, status: Option<&ReqStatus>) -> String {
    if !ready {
        return format!("{name}: not set up");
    }
    let Some(c) = status else {
        return format!("{name}: loading…");
    };
    let text = match problem_with(c) {
        Some(problem) => format!("⚠ {problem}"),
        None => to_text(c.value.as_deref().unwrap_or("")),
    };
    format!("{name}: {}", format::truncate(&text, 60))
}

#[cfg(desktop)]
struct RequestView {
    id: String,
    name: String,
    ready: bool,
    label: String,
    tooltip: String,
    /// Raw stored value (may still carry direction markers).
    value: Option<String>,
}

#[cfg(desktop)]
fn snapshot_views(app: &AppHandle) -> Vec<RequestView> {
    let state = app.state::<AppState>();
    let requests = state.requests.lock().unwrap();
    let status = state.status.lock().unwrap();
    requests
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let name = crate::engine::model::display_name(r, i);
            let current = status.get(&r.id);
            RequestView {
                id: r.id.clone(),
                ready: r.configured(),
                label: menu_label_for(&name, r.configured(), current),
                tooltip: tooltip_for(&name, current),
                value: current.and_then(|c| c.value.clone()),
                name,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tray rendering
// ---------------------------------------------------------------------------

pub fn render_tray(app: &AppHandle) {
    write_widget_snapshot(app);

    #[cfg(desktop)]
    render_tray_desktop(app);
}

#[cfg(desktop)]
fn render_tray_desktop(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };

    let state = app.state::<AppState>();
    let paused = state.is_paused();
    let views = snapshot_views(app);
    let login_enabled = autostart_enabled(app);
    let indicator = state.indicator.lock().unwrap().clone();
    let status_map = {
        let status = state.status.lock().unwrap();
        status.clone()
    };

    let ready: Vec<&RequestView> = views.iter().filter(|v| v.ready).collect();

    let items: Vec<String> = if ready.is_empty() {
        vec![constants::PLACEHOLDER_TITLE.into()]
    } else {
        ready
            .iter()
            .map(|v| tray_title_for(status_map.get(&v.id)))
            .collect()
    };
    let title = if ready.is_empty() {
        constants::PLACEHOLDER_TITLE.to_string()
    } else {
        format::truncate(
            &items.join(constants::TITLE_SEPARATOR),
            constants::MAX_TITLE_CHARS,
        )
    };

    let tooltip = if ready.is_empty() {
        "No requests set up yet — click to add one".to_string()
    } else {
        let mut lines: Vec<String> = ready.iter().map(|v| v.tooltip.clone()).collect();
        if paused {
            lines.push("Updates paused".into());
        }
        lines.join("\n")
    };

    // Signature of everything the context menu depends on. Rebuilding the menu
    // closes it while open, so it must only happen when something changed.
    let mut signature_parts: Vec<String> = views.iter().map(|v| v.label.clone()).collect();
    signature_parts.push(format!("count:{}", views.len()));
    signature_parts.push(format!("paused:{paused}"));
    signature_parts.push(format!("login:{login_enabled}"));
    signature_parts.push(format!("indicator:{indicator}"));
    signature_parts.push(format!(
        "dock:{}",
        state.show_in_dock.load(Ordering::SeqCst)
    ));
    for v in views.iter().filter(|v| v.ready && v.value.is_some()) {
        signature_parts.push(format!("copy:{}", v.value.clone().unwrap_or_default()));
    }
    let signature = signature_parts.join("\n");

    let cache = app.state::<TrayRenderCache>();
    let mut last = cache.last_rendered.lock().unwrap();
    let (last_contents, last_tooltip, last_menu) = match *last {
        Some((ref c, ref t, ref m)) => (Some(c.clone()), Some(t.clone()), Some(m.clone())),
        None => (None, None, None),
    };

    // The style is part of what is drawn, so a change to it has to repaint too.
    let contents = format!("{}\u{0}{indicator}", items.join("\u{0}"));
    if contents != last_contents.unwrap_or_default() {
        show_tray_contents(&tray, &title, &indicator);
    }
    if tooltip != last_tooltip.unwrap_or_default() {
        let _ = tray.set_tooltip(Some(&tooltip));
    }
    if signature != last_menu.unwrap_or_default() {
        match build_tray_menu(app) {
            Ok(menu) => {
                let _ = tray.set_menu(Some(menu));
            }
            Err(e) => scheduler::log_line(app, &format!("Tray menu build failed: {e}")),
        }
    }
    *last = Some((contents, tooltip, signature));
}

#[cfg(desktop)]
fn show_tray_contents(tray: &tauri::tray::TrayIcon<tauri::Wry>, title: &str, style: &str) {
    // 1.x drew the direction marks as a template image here. This renders them
    // as characters in the title instead, so the chosen style still shows.
    let _ = tray.set_title(Some(&crate::engine::indicators::to_text_styled(
        title, style,
    )));
}

// ---------------------------------------------------------------------------
// Tray context menu
// ---------------------------------------------------------------------------

#[cfg(desktop)]
fn build_tray_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let state = app.state::<AppState>();
    let paused = state.is_paused();
    let views = snapshot_views(app);

    let mut menu = MenuBuilder::new(app);

    if views.is_empty() {
        let none = MenuItemBuilder::with_id("noop", "No requests yet")
            .enabled(false)
            .build(app)?;
        menu = menu.item(&none);
    } else {
        for v in &views {
            let item = MenuItemBuilder::with_id(format!("req:{}", v.id), &v.label).build(app)?;
            menu = menu.item(&item);
        }
    }

    let add = MenuItemBuilder::with_id("add", "Add Request…")
        .enabled(views.len() < constants::MAX_REQUESTS)
        .build(app)?;
    menu = menu.item(&add).separator();

    let refresh = MenuItemBuilder::with_id("refresh", "Refresh Now").build(app)?;
    menu = menu.item(&refresh);

    let copyable: Vec<&RequestView> = views
        .iter()
        .filter(|v| v.ready && v.value.is_some())
        .collect();
    if copyable.is_empty() {
        let copy = MenuItemBuilder::with_id("copy-none", "Copy Value")
            .enabled(false)
            .build(app)?;
        menu = menu.item(&copy);
    } else {
        let mut sub = SubmenuBuilder::new(app, "Copy Value");
        for v in &copyable {
            let label = format::truncate(
                &format!("{}: {}", v.name, to_text(v.value.as_deref().unwrap_or(""))),
                60,
            );
            sub = sub.text(format!("copy:{}", v.id), label);
        }
        if copyable.len() > 1 {
            sub = sub.separator().text("copyall", "All Values");
        }
        let submenu = sub.build()?;
        menu = menu.item(&submenu);
    }

    let pause_label = if paused {
        "Resume Updates"
    } else {
        "Pause Updates"
    };
    let pause_id = if paused { "resume" } else { "pause" };
    let pause_item = MenuItemBuilder::with_id(pause_id, pause_label)
        .enabled(!views.is_empty())
        .build(app)?;
    menu = menu.item(&pause_item);

    let indicator = state.indicator.lock().unwrap().clone();
    let mut styles = SubmenuBuilder::new(app, "Rise / Fall Icon");
    for (id, label) in crate::engine::indicators::STYLES {
        styles = styles.check(format!("indicator:{id}"), label);
    }
    let styles = styles.build()?;
    for (id, _) in crate::engine::indicators::STYLES {
        if let Some(item) = styles.get(&format!("indicator:{id}")) {
            if let Some(check) = item.as_check_menuitem() {
                let _ = check.set_checked(id == indicator);
            }
        }
    }
    menu = menu.item(&styles);

    let login = CheckMenuItemBuilder::with_id("login", "Launch at Login")
        .checked(autostart_enabled(app))
        .build(app)?;
    menu = menu.item(&login);

    #[cfg(target_os = "macos")]
    {
        let dock = CheckMenuItemBuilder::with_id("dock", "Show in Dock")
            .checked(state.show_in_dock.load(Ordering::SeqCst))
            .build(app)?;
        menu = menu.item(&dock);
    }

    let log_item = MenuItemBuilder::with_id("log", "Open Log").build(app)?;
    menu = menu.item(&log_item);

    // Alerts are useless if the system is quietly dropping them, and macOS
    // only lists an app under Notifications once it has posted one.
    let mut notifications = SubmenuBuilder::new(app, "Notifications");
    notifications = notifications.text("notify-test", "Send a Test Notification");
    // macOS and Windows have stable settings URIs. Linux desktop environments
    // do not share one, so do not offer a menu item that is guaranteed to open
    // a Windows-only URI there.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        notifications = notifications.text("notify-settings", "Open Notification Settings…");
    }
    let notifications = notifications.build()?;
    menu = menu.item(&notifications).separator();

    let version = MenuItemBuilder::with_id(
        "version",
        format!("HTTP Widgets {}", app.package_info().version),
    )
    .enabled(false)
    .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    menu = menu.item(&version).item(&quit);

    menu.build()
}

#[cfg(desktop)]
fn autostart_enabled(app: &AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[cfg(desktop)]
fn handle_tray_menu_event(app: &AppHandle, id: &str) {
    match id {
        id if id.starts_with("req:") => {
            open_config(app, &id["req:".len()..]);
        }
        "add" => {
            open_config(app, "new");
        }
        "refresh" => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                refresh_everything(&handle, true).await;
            });
        }
        id if id.starts_with("copy:") => {
            let request_id = &id["copy:".len()..];
            let _ = commands::copy_request_value(app.clone(), request_id.to_string());
        }
        "copyall" => {
            let _ = commands::copy_all_values(app.clone());
        }
        "pause" | "resume" => {
            let paused = paused_for_menu_event(id).unwrap_or(false);
            let _ = commands::set_updates_paused(app.clone(), paused);
        }
        id if id.starts_with("indicator:") => {
            let style = crate::engine::indicators::normalize_style(&id["indicator:".len()..]);
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                match commands::set_indicator_preference(&handle, style.clone()).await {
                    Ok(()) => {
                        scheduler::log_line(&handle, &format!("Rise / fall icon set to {style}"));
                    }
                    Err(error) => scheduler::log_line(
                        &handle,
                        &format!("Could not save the icon style: {error}"),
                    ),
                }
                render_tray(&handle);
            });
        }
        "dock" => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                match commands::toggle_dock_preference(&handle).await {
                    Ok(next) => {
                        scheduler::log_line(&handle, &format!("Show in Dock set to {next}"));
                    }
                    Err(error) => scheduler::log_line(
                        &handle,
                        &format!("Could not save the Dock preference: {error}"),
                    ),
                }
                #[cfg(target_os = "macos")]
                apply_activation_policy(&handle);
                render_tray(&handle);
            });
        }
        "login" => {
            use tauri_plugin_autostart::ManagerExt;
            let autolaunch = app.autolaunch();
            let result = match autolaunch.is_enabled() {
                Ok(true) => autolaunch.disable().map(|_| false),
                Ok(false) => autolaunch.enable().map(|_| true),
                Err(e) => Err(e),
            };
            match result {
                Ok(enabled) => {
                    scheduler::log_line(app, &format!("Launch at login set to {enabled}"));
                }
                Err(error) => {
                    scheduler::log_line(app, &format!("Could not change Launch at Login: {error}"));
                }
            }
            render_tray(app);
        }
        "notify-test" => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let report = crate::notifications::send_test(&handle);
                scheduler::log_line(&handle, &format!("Notification test: {}", report.message));
            });
        }
        "notify-settings" => {
            // The Notifications pane, which is where allowing them lives.
            #[cfg(target_os = "macos")]
            let url = "x-apple.systempreferences:com.apple.Notifications-Settings.extension";
            #[cfg(target_os = "windows")]
            let url = "ms-settings:notifications";
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            if let Err(e) = app.opener().open_url(url, None::<&str>) {
                scheduler::log_line(app, &format!("Could not open notification settings: {e}"));
            }
        }
        "log" => {
            let path = scheduler::log_file_path(app);
            if let Err(e) = app.opener().open_path(path.to_string_lossy(), None::<&str>) {
                scheduler::log_line(app, &format!("Could not open log: {e}"));
            }
        }
        "menu-close" | "menu-hide" => {
            // Cmd-W and Cmd-Q both put the settings away; the app carries on
            // in the menu bar. The dirty check still runs.
            close_config_window(app, false);
        }
        "menu-quit" | "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

#[cfg(desktop)]
fn paused_for_menu_event(id: &str) -> Option<bool> {
    match id {
        "pause" => Some(true),
        "resume" => Some(false),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// macOS app presence
//
// The app is a menu bar extra (LSUIElement in src-tauri/Info.plist), so by
// default it has no Dock icon and no place in the app switcher. That is right
// while it is only a menu bar title, and wrong while a settings window is
// open — an on-screen window you cannot Cmd-Tab to is a dead end. So the
// policy follows whichever is true: the user asked to always show in the Dock,
// or the settings window is visible.
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
pub fn apply_activation_policy(app: &AppHandle) {
    let config_visible = app
        .get_webview_window(CONFIG_WINDOW_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    let wanted = app.state::<AppState>().show_in_dock.load(Ordering::SeqCst) || config_visible;
    let policy = if wanted {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    };
    if let Err(e) = app.set_activation_policy(policy) {
        scheduler::log_line(app, &format!("Could not set the activation policy: {e}"));
    }
}

/// Without a menu, a macOS webview has no Cmd-C, Cmd-V or Cmd-A — the standard
/// edit commands are menu key equivalents, not built into the text fields. The
/// app menu also decides what Cmd-Q does: for a menu bar app, closing the
/// window and staying resident is the expected behaviour, so quitting outright
/// is moved to Cmd-Shift-Q and the tray.
#[cfg(target_os = "macos")]
fn install_app_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadata, PredefinedMenuItem};

    let close = MenuItemBuilder::with_id("menu-close", "Close Settings")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let hide_settings = MenuItemBuilder::with_id("menu-hide", "Close Settings and Keep Running")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let quit = MenuItemBuilder::with_id("menu-quit", "Quit HTTP Widgets")
        .accelerator("CmdOrCtrl+Shift+Q")
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, "HTTP Widgets")
        .item(&PredefinedMenuItem::about(
            app,
            Some("About HTTP Widgets"),
            Some(AboutMetadata::default()),
        )?)
        .separator()
        .item(&hide_settings)
        .item(&quit)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&close)
        .minimize()
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &window_menu])
        .build()?;
    app.set_menu(menu)?;
    // Tray menu clicks reach this app-wide handler too, after the tray's own
    // handler has already run them once. Acting on them again here turns every
    // toggle (Launch at Login, Show in Dock) into an instant enable-disable
    // pair, so only the app menu's own items belong to this handler.
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if id.starts_with("menu-") {
            handle_tray_menu_event(app, id);
        }
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Config surface
//
// Desktop opens a second window over the menu bar. Phones only ever have the
// one webview, so there the same calls navigate it between the request list
// and the form.
// ---------------------------------------------------------------------------

fn encode_query_component(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    encoded
}

fn config_page(id: &str) -> String {
    format!("config.html?id={}", encode_query_component(id))
}

fn navigate_window(window: &tauri::WebviewWindow<tauri::Wry>, page: &str) {
    // JSON string encoding keeps even hand-edited request IDs from becoming
    // JavaScript when this native navigation crosses into the webview.
    if let Ok(page) = serde_json::to_string(page) {
        let _ = window.eval(format!("location.href={page}"));
    }
}

#[cfg(mobile)]
fn navigate_main(app: &AppHandle, page: &str) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        navigate_window(&window, page);
    }
}

#[cfg(mobile)]
pub fn open_config(app: &AppHandle, id: &str) {
    navigate_main(app, &config_page(id));
}

#[cfg(mobile)]
pub fn close_config_window(app: &AppHandle, force: bool) {
    let dirty = app.state::<AppState>().ui_dirty.load(Ordering::SeqCst);
    if force || !dirty {
        app.state::<AppState>()
            .ui_dirty
            .store(false, Ordering::SeqCst);
        navigate_main(app, "index.html");
        return;
    }
    // Leaving the form is the only way back to the list, so unsaved edits get
    // the same question the desktop close button asks. Non-blocking: the answer
    // arrives once the sheet is dismissed, and the event loop keeps running.
    let handle = app.clone();
    app.dialog()
        .message("Discard unsaved changes?")
        .title("HTTP Widgets")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Discard".to_string(),
            "Keep Editing".to_string(),
        ))
        .show(move |discard| {
            if discard {
                handle
                    .state::<AppState>()
                    .ui_dirty
                    .store(false, Ordering::SeqCst);
                navigate_main(&handle, "index.html");
            }
        });
}

#[cfg(desktop)]
pub fn open_config(app: &AppHandle, id: &str) {
    let Some(window) = app.get_webview_window(CONFIG_WINDOW_LABEL) else {
        create_config_window(app, id);
        return;
    };

    let dirty = app.state::<AppState>().ui_dirty.load(Ordering::SeqCst);
    let page = config_page(id);

    if !dirty {
        navigate_window(&window, &page);
        show_config_window(app, &window);
        return;
    }

    // Loading another request over unsaved edits needs an answer first; ask on
    // a side thread so the main thread keeps pumping events.
    if DISCARD_PROMPT_OPEN.swap(true, Ordering::SeqCst) {
        show_config_window(app, &window);
        return;
    }
    let thread_window = window;
    let thread_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let discard = confirm_discard_blocking(&thread_app);
        DISCARD_PROMPT_OPEN.store(false, Ordering::SeqCst);
        if discard {
            thread_app
                .state::<AppState>()
                .ui_dirty
                .store(false, Ordering::SeqCst);
            navigate_window(&thread_window, &page);
        }
        show_config_window(&thread_app, &thread_window);
    });
}

#[cfg(desktop)]
fn show_config_window(app: &AppHandle, window: &tauri::WebviewWindow<tauri::Wry>) {
    let _ = window.unminimize();
    if let Err(error) = window.show() {
        scheduler::log_line(app, &format!("Could not show the config window: {error}"));
    }
    #[cfg(target_os = "macos")]
    apply_activation_policy(app);
    let _ = window.set_focus();
}

#[cfg(desktop)]
fn hide_config_window(app: &AppHandle, window: &tauri::WebviewWindow<tauri::Wry>) {
    if let Err(error) = window.hide() {
        scheduler::log_line(app, &format!("Could not hide the config window: {error}"));
        return;
    }
    app.state::<AppState>()
        .ui_dirty
        .store(false, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    apply_activation_policy(app);
}

#[cfg(desktop)]
fn request_hide_config_window(
    app: &AppHandle,
    window: &tauri::WebviewWindow<tauri::Wry>,
    force: bool,
) {
    let dirty = app.state::<AppState>().ui_dirty.load(Ordering::SeqCst);
    if force || !dirty {
        hide_config_window(app, window);
        return;
    }

    if DISCARD_PROMPT_OPEN.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        let discard = confirm_discard_blocking(&app);
        DISCARD_PROMPT_OPEN.store(false, Ordering::SeqCst);
        if discard {
            hide_config_window(&app, &window);
        } else if app.state::<AppState>().ui_dirty.load(Ordering::SeqCst) {
            show_config_window(&app, &window);
        }
    });
}

#[cfg(desktop)]
fn create_config_window(app: &AppHandle, id: &str) {
    let url = WebviewUrl::App(config_page(id).into());

    let builder = WebviewWindowBuilder::new(app, CONFIG_WINDOW_LABEL, url)
        .title("HTTP Widgets")
        .inner_size(560.0, 720.0)
        .min_inner_size(440.0, 520.0)
        .resizable(true)
        .zoom_hotkeys_enabled(false)
        .visible(false);

    // A settings panel, not a document window: no title text, and the traffic
    // lights sit over the content at the same x as `.page`'s left padding, so
    // the heading below lines up with them.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .allow_link_preview(false);

    match builder.build() {
        Ok(window) => {
            attach_close_guard(&window);
            show_config_window(app, &window);
        }
        Err(e) => {
            scheduler::log_line(app, &format!("Could not create config window: {e}"));
        }
    }
}

/// Catches every way the window can be dismissed — the red button, Cmd-W and
/// Escape all end up here, so the dirty check lives in one place.
#[cfg(desktop)]
fn attach_close_guard(window: &tauri::WebviewWindow<tauri::Wry>) {
    let guarded = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // Keep one hidden webview alive so closing settings never turns into
            // an application-exit request. OS logout/shutdown can still exit the
            // app because the top-level ExitRequested event is not prevented.
            api.prevent_close();
            let app = guarded.app_handle().clone();
            request_hide_config_window(&app, &guarded, false);
        }
    });
}

/// Blocking confirm dialog. Must run off the main thread: the native sheet
/// needs the event loop alive, which means this thread waits, not that one.
#[cfg(desktop)]
fn confirm_discard_blocking(app: &AppHandle) -> bool {
    app.dialog()
        .message("Discard unsaved changes?")
        .title("HTTP Widgets")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Discard".to_string(),
            "Keep Editing".to_string(),
        ))
        .blocking_show()
}

#[cfg(desktop)]
pub fn close_config_window(app: &AppHandle, force: bool) {
    if let Some(window) = app.get_webview_window(CONFIG_WINDOW_LABEL) {
        request_hide_config_window(app, &window, force);
    }
}

// ---------------------------------------------------------------------------
// Refresh + widget snapshot
// ---------------------------------------------------------------------------

/// `force` is for refreshes the user asked for by hand, which happen even while
/// updates are paused.
pub async fn refresh_everything(app: &AppHandle, force: bool) -> bool {
    let ids: Vec<String> = {
        let state = app.state::<AppState>();
        if state.is_paused() && !force {
            return false;
        }
        let requests = state.requests.lock().unwrap();
        let ids: Vec<String> = requests
            .iter()
            .filter(|r| r.configured())
            .map(|r| r.id.clone())
            .collect();
        if force {
            let mut due = state.due.lock().unwrap();
            let now = Instant::now();
            for id in &ids {
                due.insert(id.clone(), now);
            }
        }
        ids
    };

    let changed = scheduler::refresh_many(app, ids).await;
    render_tray(app);
    changed
}

fn write_widget_snapshot(app: &AppHandle) {
    // Serialize writers as well as deduplicating them: config saves and fetch
    // completions can render concurrently, and an older snapshot must never
    // win the race after a newer one has reached disk.
    let cache = app.state::<TrayRenderCache>();
    let mut last_snapshot = cache.last_widget_snapshot.lock().unwrap();
    let state = app.state::<AppState>();
    let (generated_at, items): (i64, Vec<serde_json::Value>) = {
        let requests = state.requests.lock().unwrap();
        let status = state.status.lock().unwrap();
        let history = state.series_history.lock().unwrap();
        let generated_at = status
            .values()
            .map(|current| current.attempted_at.max(current.updated_at))
            .max()
            .unwrap_or(0);
        let items = requests
            .iter()
            .enumerate()
            .filter(|(_, r)| r.configured())
            .map(|(i, r)| {
                let name = crate::engine::model::display_name(r, i);
                let current = status.get(&r.id);
                let problem = current.and_then(problem_with);
                let value = current
                    .and_then(|c| c.value.clone())
                    .map(|v| serde_json::Value::String(to_text(&v)))
                    .unwrap_or(serde_json::Value::Null);
                let item_state = match current {
                    None => "pending",
                    Some(current) if current.error.is_some() && current.value.is_some() => "stale",
                    Some(current) if current.error.is_some() => "error",
                    Some(_) => "fresh",
                };
                serde_json::json!({
                    "id": r.id,
                    "name": name,
                    "value": value,
                    "numeric": current.and_then(|item| item.numeric),
                    "error": problem,
                    "state": item_state,
                    "lastAttemptAt": current.map(|item| item.attempted_at).unwrap_or(0),
                    "lastSuccessAt": current.map(|item| item.updated_at).unwrap_or(0),
                    "points": history.snapshot_points(&r.id, generated_at),
                })
            })
            .collect();
        (generated_at, items)
    };
    let doc = serde_json::json!({
        "schemaVersion": 2,
        "generatedAt": generated_at,
        "items": items,
    });
    let Ok(body) = serde_json::to_string(&doc) else {
        return;
    };
    if last_snapshot.as_deref() == Some(body.as_str()) {
        return;
    }
    let path = match settings::widget_snapshot_path(app) {
        Ok(path) => path,
        Err(error) => {
            scheduler::log_line(app, &format!("Could not locate widget storage: {error}"));
            return;
        }
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
        match settings::write_atomic(&path, body.as_bytes()) {
            Ok(()) => {
                *last_snapshot = Some(body);
                #[cfg(target_os = "android")]
                {
                    drop(last_snapshot);
                    if let Err(error) = android_widget::refresh(app) {
                        scheduler::log_line(
                            app,
                            &format!("Could not refresh Android widgets: {error}"),
                        );
                    }
                }
            }
            Err(error) => scheduler::log_line(
                app,
                &format!("Could not write the widget snapshot: {error}"),
            ),
        }
    }
}

#[cfg(all(test, desktop))]
mod tests {
    use super::{config_page, paused_for_menu_event};

    #[test]
    fn tray_pause_actions_set_the_expected_state() {
        assert_eq!(paused_for_menu_event("pause"), Some(true));
        assert_eq!(paused_for_menu_event("resume"), Some(false));
        assert_eq!(paused_for_menu_event("refresh"), None);
    }

    #[test]
    fn config_navigation_encodes_hand_edited_request_ids() {
        assert_eq!(config_page("r 1'&?#"), "config.html?id=r%201%27%26%3F%23");
    }
}
