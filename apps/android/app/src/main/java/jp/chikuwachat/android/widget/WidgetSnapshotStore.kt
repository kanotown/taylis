package jp.chikuwachat.android.widget

import android.content.Context
import android.util.Log
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.updateAll
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Where a home-screen widget's snapshot lives (the 未読・メンション and 今日の予定・締切 widgets; 在室状況 keeps its own,
 * the first of these): one JSON string in its own SharedPreferences file (it survives the process; no secrets: names
 * and counts the app shows anyway), and a StateFlow the widget's composition follows while the process runs. Writes
 * are serialised; a change that draws differently asks that widget's instances on the home screen to redraw.
 */
class WidgetSnapshotStore<T : Any>(
    private val prefsName: String,
    private val widget: Class<out GlanceAppWidget>,
    private val make: () -> GlanceAppWidget,
    private val encode: (T) -> String,
    private val decode: (String?) -> T?,
    /** Whether two snapshots draw the same widget (the time written aside). */
    private val same: (T?, T?) -> Boolean,
) {
    private val lock = Any()
    @Volatile private var state: MutableStateFlow<T?>? = null

    private fun state(context: Context): MutableStateFlow<T?> = state ?: synchronized(lock) {
        state ?: MutableStateFlow(decode(prefs(context).getString(KEY, null))).also { state = it }
    }

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(prefsName, Context.MODE_PRIVATE)

    fun flow(context: Context): StateFlow<T?> = state(context)

    fun read(context: Context): T? = state(context).value

    /** Replaces the snapshot with what [change] makes of it (null = clear it); true when anything the widget draws changed. */
    fun update(context: Context, change: (T?) -> T?): Boolean {
        val flow = state(context)
        synchronized(lock) {
            val old = flow.value
            val new = change(old)
            if (new == old) return false
            prefs(context).edit().apply { if (new == null) remove(KEY) else putString(KEY, encode(new)) }.apply()
            flow.value = new
            return !same(old, new)
        }
    }

    /** [update], then a redraw when the picture changed. */
    suspend fun write(context: Context, change: (T?) -> T?) {
        if (update(context, change)) redraw(context)
    }

    /** Whether this widget is on some home screen (nothing to fetch for otherwise). */
    suspend fun placed(context: Context): Boolean = try {
        GlanceAppWidgetManager(context).getGlanceIds(widget).isNotEmpty()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Log.w(TAG, "could not list the widgets", e)
        false
    }

    /** Redraws the widget's instances on the home screen (none placed: nothing to do). */
    suspend fun redraw(context: Context) {
        try {
            if (placed(context)) make().updateAll(context)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "could not redraw the widget", e)
        }
    }

    private companion object {
        const val KEY = "snapshot"
        const val TAG = "WidgetSnapshotStore"
    }
}
