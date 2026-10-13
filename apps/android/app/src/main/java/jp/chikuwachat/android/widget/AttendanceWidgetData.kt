package jp.chikuwachat.android.widget

import android.content.Context
import android.util.Log
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.updateAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Where the 在室状況 widget's snapshot lives: one JSON string in its own SharedPreferences file (it survives the process;
 * no secrets: names, colours and counts the app shows anyway), and a StateFlow the widget's composition follows while
 * the process runs. Writes are serialised; every change asks the widgets on the home screen to redraw.
 */
object AttendanceWidgetData {
    private const val PREFS = "attendance_widget"
    private const val KEY = "snapshot"

    private val lock = Any()
    @Volatile private var state: MutableStateFlow<AttendanceWidgetSnapshot?>? = null

    private fun state(context: Context): MutableStateFlow<AttendanceWidgetSnapshot?> = state ?: synchronized(lock) {
        state ?: MutableStateFlow(AttendanceWidgetRules.decode(prefs(context).getString(KEY, null))).also { state = it }
    }

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun flow(context: Context): StateFlow<AttendanceWidgetSnapshot?> = state(context)

    fun read(context: Context): AttendanceWidgetSnapshot? = state(context).value

    /** Replaces the snapshot with what [change] makes of it (null = clear it); true when anything the widget draws changed. */
    fun update(context: Context, change: (AttendanceWidgetSnapshot?) -> AttendanceWidgetSnapshot?): Boolean {
        val flow = state(context)
        synchronized(lock) {
            val old = flow.value
            val new = change(old)
            if (new == old) return false
            prefs(context).edit().apply { if (new == null) remove(KEY) else putString(KEY, AttendanceWidgetRules.encode(new)) }.apply()
            flow.value = new
            return !AttendanceWidgetRules.same(old, new)
        }
    }

    /** The app's snapshot of the workspace on screen (a widget press still waiting keeps its look, [AttendanceWidgetRules.merge]). */
    suspend fun publish(context: Context, snapshot: AttendanceWidgetSnapshot) {
        val now = System.currentTimeMillis()
        if (update(context) { old -> AttendanceWidgetRules.merge(old, snapshot, now) }) redraw(context)
    }

    /** The workspace left this device: the widget asks to open the app until another workspace writes its own. */
    suspend fun forget(context: Context, serverUrl: String) {
        if (update(context) { old -> old?.takeIf { it.serverUrl != serverUrl } }) redraw(context)
    }

    /** Its session ended (signed out elsewhere, refused refresh): the last state stays with 「更新できません」. */
    suspend fun signedOut(context: Context, serverUrl: String) {
        if (update(context) { old -> old?.let { if (it.serverUrl == serverUrl) AttendanceWidgetRules.failed(it) else it } }) redraw(context)
    }

    /** Redraws the widgets on the home screen (none placed: nothing to do). */
    suspend fun redraw(context: Context) {
        try {
            val ids = GlanceAppWidgetManager(context).getGlanceIds(AttendanceWidget::class.java)
            if (ids.isNotEmpty()) AttendanceWidget().updateAll(context)
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            Log.w("AttendanceWidget", "could not redraw the widget", e)
        }
    }
}
