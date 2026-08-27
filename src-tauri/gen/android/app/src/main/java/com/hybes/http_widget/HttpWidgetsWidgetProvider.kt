package com.hybes.http_widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject
import java.io.File

class HttpWidgetsWidgetProvider : AppWidgetProvider() {

    private data class GraphPoint(val timestamp: Long, val value: Double)

    private data class GraphSeries(
        val itemIndex: Int,
        val item: JSONObject,
        val points: List<GraphPoint>,
    )

    private data class DisplayValue(val text: String, val hasError: Boolean)

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        val snapshot = readSnapshot(context)
        for (appWidgetId in appWidgetIds) {
            appWidgetManager.updateAppWidget(appWidgetId, buildViews(context, snapshot))
        }
    }

    private fun readSnapshot(context: Context): JSONObject? {
        // Tauri's Android app_data_dir is the application data root, not its
        // files/ child. Keep the older locations as read-only fallbacks for
        // snapshots written by earlier builds.
        val file = directSnapshot(File(context.dataDir, SNAPSHOT_NAME))
            ?: directSnapshot(File(context.filesDir, SNAPSHOT_NAME))
            ?: directSnapshot(File(context.getExternalFilesDir(null), SNAPSHOT_NAME))
            ?: searchOneLevel(context.filesDir)
            ?: searchOneLevel(context.getExternalFilesDir(null))
            ?: return null
        return try {
            file.inputStream().use { stream ->
                JSONObject(stream.bufferedReader().readText())
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun directSnapshot(file: File?): File? =
        if (file != null && file.isFile) file else null

    private fun searchOneLevel(root: File?): File? {
        if (root == null || !root.isDirectory) return null
        val children = root.listFiles() ?: return null
        for (child in children) {
            if (child.isDirectory) {
                val candidate = File(child, SNAPSHOT_NAME)
                if (candidate.isFile) return candidate
            }
        }
        return null
    }

    private fun buildViews(context: Context, snapshot: JSONObject?): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.http_widgets_widget)
        views.setOnClickPendingIntent(R.id.widget_root, mainActivityPendingIntent(context))

        val array = snapshot?.optJSONArray("items")
        if (array == null || array.length() == 0) {
            showEmpty(context, views)
            return views
        }

        val items = buildList {
            for (i in 0 until array.length()) {
                array.optJSONObject(i)?.let(::add)
            }
        }
        if (items.isEmpty()) {
            showEmpty(context, views)
            return views
        }

        val graph = firstGraph(items)
        val rows: List<JSONObject>
        if (graph == null) {
            views.setTextViewText(R.id.widget_title, context.getString(R.string.widget_title))
            views.setTextColor(R.id.widget_title, context.getColor(R.color.widget_text))
            views.setViewVisibility(R.id.widget_graph, View.GONE)
            rows = items
        } else {
            val name = graph.item.optString("name").ifEmpty { "Request" }
            val display = displayValue(graph.item)
            views.setTextViewText(R.id.widget_title, "$name: ${display.text}")
            views.setTextColor(
                R.id.widget_title,
                context.getColor(if (display.hasError) R.color.widget_error else R.color.widget_text),
            )
            views.setImageViewBitmap(
                R.id.widget_graph,
                renderSparkline(
                    graph.points,
                    context.getColor(if (display.hasError) R.color.widget_error else R.color.widget_text),
                ),
            )
            views.setContentDescription(
                R.id.widget_graph,
                context.getString(R.string.widget_graph_description, name),
            )
            views.setViewVisibility(R.id.widget_graph, View.VISIBLE)
            rows = items.filterIndexed { index, _ -> index != graph.itemIndex }
        }

        val rowLimit = if (graph == null) ROW_IDS.size else MAX_ROWS_WITH_GRAPH
        renderRows(context, views, rows, rowLimit)
        return views
    }

    private fun renderRows(
        context: Context,
        views: RemoteViews,
        items: List<JSONObject>,
        limit: Int,
    ) {
        for (i in ROW_IDS.indices) {
            val id = ROW_IDS[i]
            if (i >= items.size || i >= limit) {
                views.setViewVisibility(id, View.GONE)
                continue
            }
            val item = items[i]
            val name = item.optString("name").ifEmpty { "Request" }
            val display = displayValue(item)
            views.setTextViewText(id, "$name: ${display.text}")
            views.setTextColor(
                id,
                context.getColor(if (display.hasError) R.color.widget_error else R.color.widget_text),
            )
            views.setViewVisibility(id, View.VISIBLE)
        }
    }

    private fun displayValue(item: JSONObject): DisplayValue {
        val value = item.optString("value", "").takeIf { it.isNotEmpty() }
        val error = item.optString("error", "").takeIf { it.isNotEmpty() }
        return when {
            error != null && value != null -> DisplayValue("\u26A0 $value", true)
            error != null -> DisplayValue("\u26A0 $error", true)
            value != null -> DisplayValue(value, false)
            else -> DisplayValue("\u2013", false)
        }
    }

    private fun firstGraph(items: List<JSONObject>): GraphSeries? {
        for ((index, item) in items.withIndex()) {
            val points = graphPoints(item)
            if (points.size >= 2) return GraphSeries(index, item, points)
        }
        return null
    }

    private fun graphPoints(item: JSONObject): List<GraphPoint> {
        val points = item.optJSONArray("points") ?: return emptyList()
        val valid = ArrayList<GraphPoint>(points.length())
        for (i in 0 until points.length()) {
            val point = points.optJSONObject(i) ?: continue
            val timestamp = (point.opt("timestamp") as? Number)?.toLong() ?: continue
            val value = (point.opt("value") as? Number)?.toDouble() ?: continue
            if (value.isFinite()) valid += GraphPoint(timestamp, value)
        }
        return valid.sortedBy(GraphPoint::timestamp)
    }

    private fun renderSparkline(points: List<GraphPoint>, color: Int): Bitmap {
        val bitmap = Bitmap.createBitmap(
            GRAPH_BITMAP_WIDTH,
            GRAPH_BITMAP_HEIGHT,
            Bitmap.Config.ARGB_8888,
        )
        if (points.size < 2) return bitmap

        val minimumValue = points.minOf { it.value }
        val maximumValue = points.maxOf { it.value }
        val minimumTime = points.first().timestamp.toDouble()
        val maximumTime = points.last().timestamp.toDouble()
        val timeRange = maximumTime - minimumTime
        val valueRange = maximumValue - minimumValue
        val width = GRAPH_BITMAP_WIDTH.toFloat() - GRAPH_PADDING * 2
        val height = GRAPH_BITMAP_HEIGHT.toFloat() - GRAPH_PADDING * 2

        val path = Path()
        points.forEachIndexed { index, point ->
            val xFraction = if (timeRange > 0.0 && timeRange.isFinite()) {
                ((point.timestamp.toDouble() - minimumTime) / timeRange).toFloat()
            } else {
                index.toFloat() / (points.size - 1).toFloat()
            }
            val yFraction = if (valueRange > 0.0 && valueRange.isFinite()) {
                ((point.value - minimumValue) / valueRange).toFloat()
            } else {
                0.5f
            }
            val x = GRAPH_PADDING + width * xFraction
            val y = GRAPH_PADDING + height * (1f - yFraction)
            if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }

        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            this.color = color
            style = Paint.Style.STROKE
            strokeWidth = GRAPH_STROKE_WIDTH
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        Canvas(bitmap).drawPath(path, paint)
        return bitmap
    }

    private fun showEmpty(context: Context, views: RemoteViews) {
        views.setTextViewText(R.id.widget_title, EMPTY_TEXT)
        views.setTextColor(R.id.widget_title, context.getColor(R.color.widget_text))
        views.setViewVisibility(R.id.widget_graph, View.GONE)
        for (id in ROW_IDS) {
            views.setViewVisibility(id, View.GONE)
        }
    }

    private fun mainActivityPendingIntent(context: Context): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
        return PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    companion object {
        fun refreshAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val provider = ComponentName(context, HttpWidgetsWidgetProvider::class.java)
            val widgetIds = manager.getAppWidgetIds(provider)
            if (widgetIds.isNotEmpty()) {
                HttpWidgetsWidgetProvider().onUpdate(context, manager, widgetIds)
            }
        }

        private const val SNAPSHOT_NAME = "widget-snapshot.json"
        private const val EMPTY_TEXT = "Open HTTP Widgets"
        private const val MAX_ROWS_WITH_GRAPH = 2
        // Kept comfortably below RemoteViews' Binder transaction limit while
        // still rendering cleanly when the launcher scales it to widget width.
        private const val GRAPH_BITMAP_WIDTH = 480
        private const val GRAPH_BITMAP_HEIGHT = 96
        private const val GRAPH_PADDING = 5f
        private const val GRAPH_STROKE_WIDTH = 4f
        private val ROW_IDS = intArrayOf(
            R.id.widget_item_1,
            R.id.widget_item_2,
            R.id.widget_item_3,
            R.id.widget_item_4,
        )
    }
}
