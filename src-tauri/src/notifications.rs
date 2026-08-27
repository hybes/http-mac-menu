// Notification permission and delivery live behind one small service so the
// scheduler and every UI surface report the same state. Permission is only
// requested in response to a user action; background work never tries to show
// a system prompt.

use serde::Serialize;
use tauri::plugin::PermissionState;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
#[cfg(any(target_os = "ios", target_os = "macos", target_os = "windows"))]
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Clone, Serialize)]
pub struct NotificationReport {
    pub ok: bool,
    pub state: String,
    pub message: String,
}

impl NotificationReport {
    fn from_state(state: PermissionState) -> Self {
        let (ok, message) = match state {
            PermissionState::Granted => (
                true,
                if cfg!(desktop) {
                    "HTTP Widgets can submit notifications. Send a test to confirm system settings."
                } else {
                    "Notifications are enabled."
                },
            ),
            PermissionState::Denied => (false, "Notifications are disabled in system settings."),
            PermissionState::Prompt | PermissionState::PromptWithRationale => {
                (false, "Enable notifications to receive widget alerts.")
            }
        };
        Self {
            ok,
            state: state.to_string(),
            message: message.into(),
        }
    }

    fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            state: "error".into(),
            message: message.into(),
        }
    }
}

pub fn status(app: &AppHandle) -> NotificationReport {
    match app.notification().permission_state() {
        Ok(state) => NotificationReport::from_state(state),
        Err(error) => {
            NotificationReport::error(format!("Could not read notification permission: {error}"))
        }
    }
}

pub fn enable(app: &AppHandle) -> NotificationReport {
    let notifier = app.notification();
    let current = match notifier.permission_state() {
        Ok(state) => state,
        Err(error) => {
            return NotificationReport::error(format!(
                "Could not read notification permission: {error}"
            ));
        }
    };
    match current {
        PermissionState::Granted | PermissionState::Denied => {
            NotificationReport::from_state(current)
        }
        PermissionState::Prompt | PermissionState::PromptWithRationale => {
            match notifier.request_permission() {
                Ok(state) => NotificationReport::from_state(state),
                Err(error) => NotificationReport::error(format!(
                    "Could not request notification permission: {error}"
                )),
            }
        }
    }
}

pub fn send_test(app: &AppHandle) -> NotificationReport {
    let permission = enable(app);
    if permission.state != PermissionState::Granted.to_string() {
        return permission;
    }
    match app
        .notification()
        .builder()
        .title("HTTP Widgets")
        .body("Alerts look like this. If you can see it, notifications work.")
        .show()
    {
        Ok(()) => NotificationReport {
            ok: true,
            state: PermissionState::Granted.to_string(),
            message: "Test notification submitted. Check that it appeared.".into(),
        },
        Err(error) => NotificationReport::error(format!(
            "The test notification could not be submitted: {error}"
        )),
    }
}

pub fn send_alert(app: &AppHandle, title: String, body: String) -> Result<(), String> {
    let state = app
        .notification()
        .permission_state()
        .map_err(|error| error.to_string())?;
    if state != PermissionState::Granted {
        return Err(format!("notification permission is {state}"));
    }
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())
}

/// Opens the app-specific notification controls after a permission denial.
/// Android uses a tiny native Settings intent exposed to the webview instead;
/// Linux desktop environments do not share a stable settings URI.
pub fn open_settings(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let url = "x-apple.systempreferences:com.apple.Notifications-Settings.extension";
    #[cfg(target_os = "windows")]
    let url = "ms-settings:notifications";
    #[cfg(target_os = "ios")]
    let url = "app-settings:";

    #[cfg(any(target_os = "ios", target_os = "macos", target_os = "windows"))]
    {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|error| format!("Could not open notification settings: {error}"))
    }

    #[cfg(target_os = "android")]
    {
        let _ = app;
        Err("Open Settings > Apps > HTTP Widgets > Notifications on this device.".into())
    }

    #[cfg(not(any(
        target_os = "android",
        target_os = "ios",
        target_os = "macos",
        target_os = "windows"
    )))]
    {
        let _ = app;
        Err("Open your desktop's notification settings and enable HTTP Widgets.".into())
    }
}
