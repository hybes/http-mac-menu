package com.hybes.http_widget

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var appWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Tauri deliberately leaves Android Back to the Activity. On the request
    // form it must take the same Rust path as the visible Back button so dirty
    // edits receive the native discard prompt instead of silently vanishing.
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val webView = appWebView
        if (webView?.url?.contains("/config.html") == true) {
          webView.evaluateJavascript(
            "if (window.api && window.api.close) { window.api.close(); }",
            null,
          )
        } else {
          finish()
        }
      }
    })
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    webView.settings.setSupportZoom(false)
    webView.settings.builtInZoomControls = false
    webView.settings.displayZoomControls = false
    webView.isVerticalScrollBarEnabled = false
    webView.isHorizontalScrollBarEnabled = false
    // Preserve Android's native edge feedback while still hiding the browser's
    // permanent scrollbars. The effect appears only when content can scroll.
    webView.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    webView.addJavascriptInterface(
      NotificationSettingsBridge(this),
      "httpWidgetsNotificationSettings",
    )
  }

  private class NotificationSettingsBridge(private val activity: Activity) {
    @JavascriptInterface
    fun open() {
      // JavaScript-interface calls arrive off the UI thread.
      activity.runOnUiThread {
        val details = Intent(
          Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
          Uri.parse("package:${activity.packageName}"),
        )
        val intent = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
          Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
            putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
          }
        } else {
          details
        }

        try {
          activity.startActivity(intent)
        } catch (_: Exception) {
          // A few vendor builds omit the notification-specific screen.
          if (intent !== details) {
            try {
              activity.startActivity(details)
            } catch (_: Exception) {
              // Settings availability is controlled by the device vendor.
            }
          }
        }
      }
    }
  }
}
