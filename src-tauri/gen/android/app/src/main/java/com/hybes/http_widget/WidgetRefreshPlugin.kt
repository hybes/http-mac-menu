package com.hybes.http_widget

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/** Keeps the native side thin: Rust owns the snapshot, Android only redraws it. */
@TauriPlugin
class WidgetRefreshPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun refresh(invoke: Invoke) {
        HttpWidgetsWidgetProvider.refreshAll(activity.applicationContext)
        invoke.resolve()
    }
}
