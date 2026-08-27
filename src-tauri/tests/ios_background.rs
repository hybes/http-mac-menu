// The production module is iOS-gated in lib.rs, so host `cargo test` would not
// otherwise compile its platform-neutral cancellation state machine. These two
// stubs satisfy the app callbacks while the module's focused tests exercise the
// exact code that is linked into iOS.

pub mod scheduler {
    pub fn log_line(_app: &tauri::AppHandle, _line: &str) {}
}

pub async fn refresh_everything(_app: &tauri::AppHandle, _force: bool) -> bool {
    false
}

#[path = "../src/ios_background.rs"]
#[allow(dead_code)]
mod ios_background;
