package jp.chikuwachat.android.widget

import android.content.Context
import android.util.Log
import androidx.glance.GlanceId
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Which workspace each home-screen widget shows. [current]: the workspace on screen in the app (written by the app
 * whenever it opens one). [choices]: a widget's own choice by its appWidgetId (its configuration screen); a widget with
 * none follows [current] — every widget placed before the choice existed, and a new one placed without configuring.
 * [names]: the registered workspaces' names (the header of a chosen workspace the app has written nothing for yet).
 */
data class WidgetWorkspaceState(
    val current: String? = null,
    val choices: Map<Int, String> = emptyMap(),
    val names: Map<String, String> = emptyMap(),
) {
    /** The workspace the widget [appWidgetId] shows: its choice, else the one on screen in the app (null: none yet). */
    fun resolve(appWidgetId: Int): String? = WidgetWorkspaceRules.resolve(choices[appWidgetId], current)
}

object WidgetWorkspaceRules {
    fun resolve(choice: String?, current: String?): String? = choice ?: current

    /** The workspaces the widgets [ids] show, each once, in the widgets' order. */
    fun shown(ids: Collection<Int>, state: WidgetWorkspaceState): List<String> = ids.mapNotNull { state.resolve(it) }.distinct()

    /** The widgets [ids] that show a workspace of their own other than the one on screen (they need their own reads). */
    fun elsewhere(ids: Collection<Int>, state: WidgetWorkspaceState): List<String> =
        ids.mapNotNull { state.choices[it] }.filter { it != state.current }.distinct()

    /** A widget's choice: a workspace, or null to follow the app. */
    fun choose(state: WidgetWorkspaceState, appWidgetId: Int, serverUrl: String?): WidgetWorkspaceState =
        state.copy(choices = if (serverUrl == null) state.choices - appWidgetId else state.choices + (appWidgetId to serverUrl))

    /** Widgets removed from the home screen: their choices go. */
    fun deleted(state: WidgetWorkspaceState, ids: Collection<Int>): WidgetWorkspaceState = state.copy(choices = state.choices - ids.toSet())

    /**
     * The registered workspaces now ([names], key → name). A choice of a workspace that left this device goes (that
     * widget follows the app again); so does [current] when its workspace left.
     */
    fun registered(state: WidgetWorkspaceState, names: Map<String, String>): WidgetWorkspaceState = state.copy(
        names = names,
        choices = state.choices.filterValues { it in names },
        current = state.current?.takeIf { it in names },
    )

    // --- storage: one SharedPreferences file, plain strings (no secrets: server addresses and names) -------------

    const val CURRENT_KEY = "current"
    const val CHOICE_PREFIX = "choice."
    const val NAME_PREFIX = "name."

    fun load(entries: Map<String, *>): WidgetWorkspaceState {
        val choices = HashMap<Int, String>()
        val names = LinkedHashMap<String, String>()
        var current: String? = null
        for ((key, value) in entries) {
            val text = value as? String ?: continue
            when {
                key == CURRENT_KEY -> current = text
                key.startsWith(CHOICE_PREFIX) -> key.removePrefix(CHOICE_PREFIX).toIntOrNull()?.let { choices[it] = text }
                key.startsWith(NAME_PREFIX) -> names[key.removePrefix(NAME_PREFIX)] = text
            }
        }
        return WidgetWorkspaceState(current, choices, names)
    }

    fun save(state: WidgetWorkspaceState): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        state.current?.let { out[CURRENT_KEY] = it }
        state.choices.forEach { (id, server) -> out[CHOICE_PREFIX + id] = server }
        state.names.forEach { (server, name) -> out[NAME_PREFIX + server] = name }
        return out
    }
}

/** [WidgetWorkspaceState] kept in its own SharedPreferences file, with a StateFlow the widgets' compositions follow. */
object WidgetWorkspaces {
    private const val PREFS = "widget_workspaces"
    private const val TAG = "WidgetWorkspaces"
    private val lock = Any()
    @Volatile private var state: MutableStateFlow<WidgetWorkspaceState>? = null

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun state(context: Context): MutableStateFlow<WidgetWorkspaceState> = state ?: synchronized(lock) {
        state ?: MutableStateFlow(WidgetWorkspaceRules.load(prefs(context).all)).also { state = it }
    }

    fun flow(context: Context): StateFlow<WidgetWorkspaceState> = state(context)

    fun read(context: Context): WidgetWorkspaceState = state(context).value

    /** Applies [change]; true when anything changed (then saved). */
    fun update(context: Context, change: (WidgetWorkspaceState) -> WidgetWorkspaceState): Boolean {
        val flow = state(context)
        synchronized(lock) {
            val old = flow.value
            val new = change(old)
            if (new == old) return false
            prefs(context).edit().apply {
                clear()
                WidgetWorkspaceRules.save(new).forEach { (k, v) -> putString(k, v) }
            }.apply()
            flow.value = new
            return true
        }
    }

    /** The app opened [serverUrl]: the widgets that follow the app show it. */
    suspend fun setCurrent(context: Context, serverUrl: String) {
        if (update(context) { it.copy(current = serverUrl) }) redrawAll(context)
    }

    /** A snapshot written before workspaces were kept apart names the workspace widgets followed then. */
    fun adoptCurrent(context: Context, serverUrl: String) {
        update(context) { if (it.current == null) it.copy(current = serverUrl) else it }
    }

    suspend fun choose(context: Context, appWidgetId: Int, serverUrl: String?) {
        if (update(context) { WidgetWorkspaceRules.choose(it, appWidgetId, serverUrl) }) redrawAll(context)
    }

    fun deleted(context: Context, ids: IntArray) {
        update(context) { WidgetWorkspaceRules.deleted(it, ids.toList()) }
    }

    suspend fun registered(context: Context, names: Map<String, String>) {
        if (update(context) { WidgetWorkspaceRules.registered(it, names) }) redrawAll(context)
    }

    /** The appWidgetId of a Glance widget (needed to look up its choice); null when the launcher has no such widget. */
    suspend fun appWidgetId(context: Context, id: GlanceId): Int? = try {
        GlanceAppWidgetManager(context).getAppWidgetId(id)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }

    /** The appWidgetIds of [widget]'s instances on the home screen. */
    suspend fun ids(context: Context, widget: Class<out GlanceAppWidget>): List<Int> = try {
        val manager = GlanceAppWidgetManager(context)
        manager.getGlanceIds(widget).map { manager.getAppWidgetId(it) }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Log.w(TAG, "could not list the widgets", e)
        emptyList()
    }

    /** The workspaces [widget]'s placed instances show. */
    suspend fun shown(context: Context, widget: Class<out GlanceAppWidget>): List<String> =
        WidgetWorkspaceRules.shown(ids(context, widget), read(context))

    /** Every widget draws again (a workspace choice or the app's workspace changed). */
    suspend fun redrawAll(context: Context) {
        AttendanceWidgetData.store.redraw(context)
        UnreadWidgetData.store.redraw(context)
        TodayWidgetData.store.redraw(context)
    }
}
