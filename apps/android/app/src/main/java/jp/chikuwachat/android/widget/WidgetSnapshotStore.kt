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
 * Where a home-screen widget kind keeps its snapshots: one per workspace (keyed by the workspace's server address, the
 * app's workspace key: one account per server), each a JSON string in the kind's own SharedPreferences file (it survives
 * the process; no secrets: names and counts the app shows anyway), and a StateFlow of all of them the widgets'
 * compositions follow while the process runs. Each widget picks its workspace's ([WidgetWorkspaces]). Writes are
 * serialised; a change that draws differently asks that kind's widgets on the home screen to redraw.
 *
 * Migration: a version before per-workspace snapshots kept one under "snapshot" (the workspace on screen); it moves to
 * its workspace's key on first read, and that workspace becomes the one the following widgets show.
 */
class WidgetSnapshotStore<T : Any>(
    private val prefsName: String,
    private val widget: Class<out GlanceAppWidget>,
    private val make: () -> GlanceAppWidget,
    private val encode: (T) -> String,
    private val decode: (String?) -> T?,
    /** Whether two snapshots draw the same widget (the time written aside). */
    private val same: (T?, T?) -> Boolean,
    /** The workspace a snapshot is of. */
    private val server: (T) -> String,
) {
    private val lock = Any()
    @Volatile private var state: MutableStateFlow<Map<String, T>>? = null

    private fun state(context: Context): MutableStateFlow<Map<String, T>> = state ?: synchronized(lock) {
        state ?: MutableStateFlow(load(context)).also { state = it }
    }

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(prefsName, Context.MODE_PRIVATE)

    private fun load(context: Context): Map<String, T> {
        val prefs = prefs(context)
        val loaded = WidgetSnapshotKeys.load(prefs.all, decode, server)
        if (loaded.dropLegacy) {
            val migrated = loaded.migrated
            prefs.edit().remove(WidgetSnapshotKeys.LEGACY_KEY).apply {
                loaded.snapshots[migrated]?.let { putString(WidgetSnapshotKeys.key(migrated!!), encode(it)) }
            }.apply()
            if (migrated != null) WidgetWorkspaces.adoptCurrent(context, migrated)
        }
        return loaded.snapshots
    }

    fun flow(context: Context): StateFlow<Map<String, T>> = state(context)

    fun read(context: Context, serverUrl: String): T? = state(context).value[serverUrl]

    fun all(context: Context): Map<String, T> = state(context).value

    /** Replaces [serverUrl]'s snapshot with what [change] makes of it (null = clear it); true when what is drawn changed. */
    fun update(context: Context, serverUrl: String, change: (T?) -> T?): Boolean {
        val flow = state(context)
        synchronized(lock) {
            val old = flow.value[serverUrl]
            val new = change(old)
            if (new == old) return false
            prefs(context).edit().apply {
                if (new == null) remove(WidgetSnapshotKeys.key(serverUrl)) else putString(WidgetSnapshotKeys.key(serverUrl), encode(new))
            }.apply()
            flow.value = if (new == null) flow.value - serverUrl else flow.value + (serverUrl to new)
            return !same(old, new)
        }
    }

    /** [update], then a redraw when the picture changed. */
    suspend fun write(context: Context, serverUrl: String, change: (T?) -> T?) {
        if (update(context, serverUrl, change)) redraw(context)
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

    /** The workspaces this kind's placed widgets show. */
    suspend fun shown(context: Context): List<String> = WidgetWorkspaces.shown(context, widget)

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
        const val TAG = "WidgetSnapshotStore"
    }
}

/** The keys of a [WidgetSnapshotStore]'s file (pure, for the tests). */
object WidgetSnapshotKeys {
    /** The one snapshot of a version before per-workspace snapshots. */
    const val LEGACY_KEY = "snapshot"
    const val PREFIX = "snapshot:"

    fun key(serverUrl: String): String = PREFIX + serverUrl

    /** [migrated]: the legacy snapshot's workspace; [dropLegacy]: the legacy key is there (readable or not) and goes. */
    data class Loaded<T>(val snapshots: Map<String, T>, val migrated: String?, val dropLegacy: Boolean)

    /**
     * The snapshots in [entries] (the file's contents) by workspace. A legacy one is taken under its workspace unless
     * that workspace has its own already. Unreadable text (and a snapshot under another workspace's key) is left out.
     */
    fun <T> load(entries: Map<String, *>, decode: (String?) -> T?, server: (T) -> String): Loaded<T> {
        val out = LinkedHashMap<String, T>()
        for ((key, value) in entries) {
            if (!key.startsWith(PREFIX)) continue
            val snapshot = decode(value as? String) ?: continue
            val serverUrl = key.removePrefix(PREFIX)
            if (server(snapshot) == serverUrl) out[serverUrl] = snapshot
        }
        val legacy = (entries[LEGACY_KEY] as? String)?.let(decode)
        val migrated = legacy?.let(server)
        if (legacy != null && migrated != null && migrated !in out) out[migrated] = legacy
        return Loaded(out, migrated, entries.containsKey(LEGACY_KEY))
    }
}
