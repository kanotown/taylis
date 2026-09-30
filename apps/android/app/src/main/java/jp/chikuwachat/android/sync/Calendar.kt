package jp.chikuwachat.android.sync

import android.util.Log
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.CalendarAlarmOut
import jp.chikuwachat.android.api.CalendarAlarmUpdated
import jp.chikuwachat.android.api.CalendarEventCreate
import jp.chikuwachat.android.api.CalendarEventDeleted
import jp.chikuwachat.android.api.CalendarEventOut
import jp.chikuwachat.android.api.CalendarEventUpdate
import jp.chikuwachat.android.api.CalendarEventUpdated
import jp.chikuwachat.android.api.Codec
// The overlap and order rules are plain date work shared with the screens (CalendarDates.kt).
import jp.chikuwachat.android.ui.CalendarDates
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.time.ZoneId

/** How a range on screen stands: being read, read, failed (read again on reconnecting), or a server without a calendar. */
enum class CalendarWindowState { LOADING, READY, FAILED, UNSUPPORTED }

/** A range a screen shows: [from, to) (instants with offset), all my calendars or one channel's, and its events in order. */
data class CalendarWindow(
    val from: String,
    val to: String,
    /** Only this channel's calendar (a channel's 「予定」 tab); null: mine and all my channels'. */
    val channelId: String?,
    val state: CalendarWindowState,
    val events: List<CalendarEventOut>,
)

/**
 * M52: the calendar on this device (CALENDAR.md §5, SYNC_PROTOCOL.md §15), as the desktop's src/sync/calendar.ts. Nothing
 * is kept for long: each screen that shows events (the calendar, a channel's 「予定」 tab) opens a window on a range, read
 * from the server, and calendar.* events update the windows they overlap (the rest are dropped: the next read has them).
 * A channel's tab count comes from GET /calendar/upcoming, read again when one of its events changes. After reconnecting
 * every window and count is read again, which fills whatever events were missed. Runs on the app's main thread (the
 * controller's scope), like the engine's queue.
 */
class CalendarHub(
    private val api: CalendarApi?,
    private val scope: CoroutineScope,
    /** My user id (`can_edit` is `editor_ids` holding it). */
    private val me: () -> String?,
    private val tz: () -> String = { ZoneId.systemDefault().id },
) {
    private val windows = LinkedHashMap<String, CalendarWindow>()
    private val upcoming = LinkedHashMap<String, List<CalendarEventOut>>()
    /** A read in flight per window: an older answer never replaces a newer one. */
    private val reads = HashMap<String, Int>()
    private val _version = MutableStateFlow(0)
    /** Bumped by every change: the screens read their windows again. */
    val version: StateFlow<Int> = _version

    /** One of my alarms fired (the app says so while open: the server's push is not shown then). */
    var onAlarm: ((CalendarEventOut) -> Unit)? = null

    val available: Boolean get() = api != null

    private fun changed() {
        _version.value = _version.value + 1
    }

    fun window(key: String): CalendarWindow? = windows[key]

    /** A channel's events today and tomorrow not over yet (null: not read). */
    fun upcomingOf(channelId: String): List<CalendarEventOut>? = upcoming[channelId]

    /** A screen shows [from, to): read it (again when the range changes). */
    suspend fun open(key: String, from: String, to: String, channelId: String? = null) {
        val current = windows[key]
        val same = current != null && current.from == from && current.to == to && current.channelId == channelId
        if (same && current!!.state == CalendarWindowState.READY) return
        windows[key] = CalendarWindow(from, to, channelId, CalendarWindowState.LOADING, if (same) current!!.events else emptyList())
        changed()
        read(key)
    }

    fun close(key: String) {
        reads.remove(key)
        if (windows.remove(key) != null) changed()
    }

    private suspend fun read(key: String) {
        val api = api ?: return
        val window = windows[key] ?: return
        val ticket = (reads[key] ?: 0) + 1
        reads[key] = ticket
        try {
            val events = api.calendarEvents(window.from, window.to, window.channelId)
            val now = windows[key]
            if (reads[key] != ticket || now == null || now.from != window.from || now.to != window.to) return
            windows[key] = now.copy(state = CalendarWindowState.READY, events = events.sortedWith(CalendarDates.eventOrder))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w("CalendarHub", "could not read the calendar", e)
            val now = windows[key]
            if (reads[key] != ticket || now == null) return
            windows[key] = now.copy(state = if (serverLacksCalendar(e)) CalendarWindowState.UNSUPPORTED else CalendarWindowState.FAILED)
        }
        changed()
    }

    suspend fun loadUpcoming(channelId: String) {
        val api = api ?: return
        try {
            upcoming[channelId] = api.calendarUpcoming(channelId, CalendarDates.UPCOMING_DAYS, tz())
            changed()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w("CalendarHub", "could not read the channel's upcoming events", e)
        }
    }

    // --- changes made here -------------------------------------------------------------------------

    suspend fun create(body: CalendarEventCreate): CalendarEventOut = requireApi().createCalendarEvent(body).also { put(it) }

    suspend fun update(eventId: String, patch: CalendarEventUpdate): CalendarEventOut = requireApi().updateCalendarEvent(eventId, patch).also { put(it) }

    suspend fun remove(eventId: String) {
        val known = find(eventId)
        requireApi().deleteCalendarEvent(eventId)
        drop(eventId, known?.channelId)
    }

    /** My alarm: minutes before (null removes it). */
    suspend fun setAlarm(eventId: String, minutes: Int?) {
        val api = requireApi()
        if (minutes == null) {
            api.clearCalendarAlarm(eventId)
            patchAlarm(eventId, null)
        } else {
            put(api.setCalendarAlarm(eventId, minutes, tz()))
        }
    }

    /** An event known only by its id (a notification tapped): as held here, else read. */
    suspend fun get(eventId: String): CalendarEventOut = find(eventId) ?: requireApi().calendarEvent(eventId)

    private fun requireApi(): CalendarApi = api ?: throw IllegalStateException("The calendar is not available")

    // --- events (§5) -------------------------------------------------------------------------------

    fun applyEvent(event: String, data: JsonObject) {
        when (event) {
            "calendar.event.updated" -> {
                val update = decode { Codec.snake.decodeFromJsonElement(CalendarEventUpdated.serializer(), data) } ?: return
                val mine = me()
                val known = find(update.event.id)
                put(update.event.copy(canEdit = mine != null && mine in update.editorIds, alarm = known?.alarm))
                update.event.channelId?.let { refreshUpcoming(it) }
            }
            "calendar.event.deleted" -> {
                val deleted = decode { Codec.snake.decodeFromJsonElement(CalendarEventDeleted.serializer(), data) } ?: return
                drop(deleted.id, deleted.channelId)
            }
            "calendar.alarm.updated" -> {
                val update = decode { Codec.snake.decodeFromJsonElement(CalendarAlarmUpdated.serializer(), data) } ?: return
                val before = find(update.eventId)?.alarm?.status
                patchAlarm(update.eventId, update.alarm)
                if (update.alarm?.status == "fired" && before != "fired") announce(update.eventId)
            }
        }
    }

    private fun <T> decode(block: () -> T): T? = runCatching(block).onFailure { Log.w("CalendarHub", "unreadable calendar event", it) }.getOrNull()

    /** A fired alarm: its event as known here, else read (it may be outside every window). */
    private fun announce(eventId: String) {
        val callback = onAlarm ?: return
        find(eventId)?.let {
            callback(it)
            return
        }
        val api = api ?: return
        scope.launch {
            // Gone, or no longer mine to see: nothing to say.
            val event = runCatching { api.calendarEvent(eventId) }.getOrNull() ?: return@launch
            callback(event)
        }
    }

    /** An event as it is now: into every window it overlaps (out of those it left), and the counts holding it. */
    fun put(event: CalendarEventOut) {
        for ((key, window) in windows.entries.toList()) {
            val fits = (window.channelId == null || window.channelId == event.channelId) && CalendarDates.overlapsRange(event, window.from, window.to)
            val rest = window.events.filter { it.id != event.id }
            if (!fits && rest.size == window.events.size) continue
            windows[key] = window.copy(events = if (fits) (rest + event).sortedWith(CalendarDates.eventOrder) else rest)
        }
        for ((channelId, list) in upcoming.entries.toList()) {
            if (list.any { it.id == event.id }) upcoming[channelId] = list.map { if (it.id == event.id) event else it }
        }
        changed()
    }

    private fun drop(eventId: String, channelId: String?) {
        for ((key, window) in windows.entries.toList()) {
            if (window.events.any { it.id == eventId }) windows[key] = window.copy(events = window.events.filter { it.id != eventId })
        }
        for ((id, list) in upcoming.entries.toList()) {
            if (list.any { it.id == eventId }) upcoming[id] = list.filter { it.id != eventId }
        }
        channelId?.let { refreshUpcoming(it) }
        changed()
    }

    private fun patchAlarm(eventId: String, alarm: CalendarAlarmOut?) {
        val known = find(eventId) ?: return
        put(known.copy(alarm = alarm))
    }

    private fun refreshUpcoming(channelId: String) {
        if (upcoming.containsKey(channelId)) scope.launch { loadUpcoming(channelId) }
    }

    fun find(eventId: String): CalendarEventOut? =
        windows.values.firstNotNullOfOrNull { window -> window.events.firstOrNull { it.id == eventId } }
            ?: upcoming.values.firstNotNullOfOrNull { list -> list.firstOrNull { it.id == eventId } }

    // --- lifecycle ---------------------------------------------------------------------------------

    /** After (re)connecting: every window and count is read again (events missed while away, §5). */
    fun online() {
        if (api == null) return
        windows.keys.toList().forEach { key -> scope.launch { read(key) } }
        upcoming.keys.toList().forEach { channelId -> scope.launch { loadUpcoming(channelId) } }
    }

    /** I left the channel (or was removed): its events leave every window. */
    fun removeChannel(channelId: String) {
        for ((key, window) in windows.entries.toList()) {
            if (window.channelId == channelId) windows.remove(key)
            else windows[key] = window.copy(events = window.events.filter { it.channelId != channelId })
        }
        upcoming.remove(channelId)
        changed()
    }

    fun stop() {
        windows.clear()
        upcoming.clear()
        reads.clear()
        changed()
    }

    companion object {
        /** A server from before M51 has no such route (404 not_found): trying again cannot help until it is updated. */
        fun serverLacksCalendar(e: Throwable): Boolean = e is ApiException.Api && e.status == 404 && (e.code == "not_found" || e.code == "http_404")
    }
}
