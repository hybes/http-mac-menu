// Minimal Android-only bridge for asking AppWidgetManager to re-render after
// Rust has atomically replaced the shared widget snapshot.

use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

#[derive(Debug)]
struct AndroidWidgetRefresh<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("widget-refresh")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin("com.hybes.http_widget", "WidgetRefreshPlugin")?;
            app.manage(AndroidWidgetRefresh(handle));
            Ok(())
        })
        .build()
}

pub fn refresh<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    app.state::<AndroidWidgetRefresh<R>>()
        .0
        .run_mobile_plugin::<()>("refresh", serde_json::json!({}))
        .map_err(|error| error.to_string())
}
