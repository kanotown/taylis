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
import jp.chikuwachat.android.ui.OccurrenceScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.time.ZoneId

/**
 * Review v0.1.22 #9: one of my alarms fired. `eventId` is the alarm's event (a series' id): the notification's key and what
 * a tap opens, as before. `event`: the occurrence it is for, or null when this device cannot tell (the neutral notice).
 */
data class CalendarAlarmFired(val eventId: String, val channelId: String?, val event: CalendarEventOut?)

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
 *
 * M69 (CALENDAR.md §10.4): a recurring event comes as one entry per occurrence (its own `id`, the series' `series_id`).
 * The server alone expands a series: any change to one (its calendar.event.updated has `recurring`, as do the answers to
 * my own changes) reads the windows it may touch again instead of patching them here. A series' alarm is one per person
 * and applies to all its occurrences.
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

    /**
     * One of my alarms fired (the app says so while open: the server's push is not shown then): the occurrence it is for,
     * or none when this device cannot tell which occurrence that is (Review v0.1.22 #9): then the notice is neutral.
     */
    var onAlarm: ((CalendarAlarmFired) -> Unit)? = null

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

    suspend fun create(body: CalendarEventCreate): CalendarEventOut = requireApi().createCalendarEvent(body).also { settle(it) }

    /** A whole event (a series: all its occurrences, 「すべての予定」 without moving it from an occurrence). */
    suspend fun update(eventId: String, patch: CalendarEventUpdate): CalendarEventOut = requireApi().updateCalendarEvent(eventId, patch).also { settle(it) }

    /** A whole event (a series: every occurrence). */
    suspend fun remove(eventId: String) {
        val known = find(eventId)
        requireApi().deleteCalendarEvent(eventId)
        drop(eventId, known?.channelId)
    }

    /** M69: one occurrence of a series, it and the later ones, or all of them (the windows are read again). */
    suspend fun updateOccurrence(seriesId: String, occurrenceStart: String, body: JsonObject): CalendarEventOut {
        val known = findSeries(seriesId)
        val event = requireApi().updateCalendarOccurrence(seriesId, occurrenceStart, body)
        reloadFor(event.channelId ?: known?.channelId)
        return event
    }

    suspend fun removeOccurrence(seriesId: String, occurrenceStart: String, scope: OccurrenceScope) {
        val known = findSeries(seriesId)
        requireApi().deleteCalendarOccurrence(seriesId, occurrenceStart, scope)
        val channelId = known?.channelId
        if (scope == OccurrenceScope.ALL) {
            drop(seriesId, channelId)
        } else {
            // The occurrence (or the later ones) leave at once; the windows' next read confirms it.
            dropWhere(channelId) {
                it.series == seriesId && if (scope == OccurrenceScope.THIS) it.occurrenceStart == occurrenceStart else (it.occurrenceStart ?: "") >= occurrenceStart
            }
            reloadFor(channelId)
        }
    }

    /** My alarm: minutes before (null removes it). On a series it is the series' (every occurrence's): pass its id. */
    suspend fun setAlarm(eventId: String, minutes: Int?) {
        val api = requireApi()
        if (minutes == null) {
            api.clearCalendarAlarm(eventId)
            patchAlarm(eventId, null)
        } else {
            val event = api.setCalendarAlarm(eventId, minutes, tz())
            if (event.recurring) patchAlarm(event.series, event.alarm) else put(event)
        }
    }

    /** An event known only by its id (a notification tapped): as held here, else read. */
    suspend fun get(eventId: String): CalendarEventOut = find(eventId) ?: requireApi().calendarEvent(eventId)

    private fun requireApi(): CalendarApi = api ?: throw IllegalStateException("The calendar is not available")

    /** My change's answer: a one-off event goes in as it is; a series is read again where it may show. */
    private fun settle(event: CalendarEventOut) {
        if (event.recurring) reloadFor(event.channelId) else put(event)
    }

    /** Reads again every window that may hold the channel's events (null: my own calendar), and its count. */
    private fun reloadFor(channelId: String?) {
        if (api == null) return
        windows.filterValues { it.channelId == null || it.channelId == channelId }.keys.toList().forEach { key -> scope.launch { read(key) } }
        channelId?.let { refreshUpcoming(it) }
    }

    // --- events (§5, §10.4) ------------------------------------------------------------------------

    fun applyEvent(event: String, data: JsonObject) {
        when (event) {
            "calendar.event.updated" -> {
                val update = decode { Codec.snake.decodeFromJsonElement(CalendarEventUpdated.serializer(), data) } ?: return
                if (update.event.recurring) {
                    // A series changed (its rule, an occurrence, a split): only the server expands it.
                    reloadFor(update.event.channelId)
                    return
                }
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
                val before = findSeries(update.eventId)?.alarm
                patchAlarm(update.eventId, update.alarm)
                // A series' alarm fires once per occurrence: only the same occurrence fired again is not said twice.
                val again = before?.status == "fired" && before.occurrenceStart == update.alarm?.occurrenceStart
                if (update.alarm?.status == "fired" && !again) announce(update.eventId, update.channelId, update.alarm, update.occurrence)
            }
        }
    }

    private fun <T> decode(block: () -> T): T? = runCatching(block).onFailure { Log.w("CalendarHub", "unreadable calendar event", it) }.getOrNull()

    /**
     * A fired alarm, said for the occurrence it is for (Review v0.1.22 #9, CALENDAR.md §10.11): (1) the one the server put
     * in the event; from an older server (2) the occurrence held here, else (3) the event read, only when it is that
     * occurrence (a one-off, or a series' first occurrence); (4) otherwise the neutral notice (no event), never another
     * occurrence (GET /calendar/events/{series} answers the series' first one).
     */
    private fun announce(eventId: String, channelId: String?, alarm: CalendarAlarmOut, occurrence: CalendarEventOut?) {
        val callback = onAlarm ?: return
        val key = alarm.occurrenceStart
        if (occurrence != null && (key == null || occurrence.occurrenceStart == key)) {
            val held = occurrence.occurrenceStart?.let { findOccurrence(occurrence.series, it) }
            val canEdit = held?.canEdit ?: findSeries(eventId)?.canEdit ?: false
            callback(CalendarAlarmFired(eventId, occurrence.channelId, occurrence.copy(canEdit = canEdit, alarm = alarm)))
            return
        }
        val fits = { e: CalendarEventOut? -> e != null && (if (key == null) !e.recurring else e.occurrenceStart == key) }
        val known = if (key != null) findOccurrence(eventId, key) else find(eventId)
        if (known != null && fits(known)) {
            callback(CalendarAlarmFired(eventId, known.channelId, known))
            return
        }
        val api = api
        if (api == null) {
            callback(CalendarAlarmFired(eventId, channelId, null))
            return
        }
        scope.launch {
            val read = try {
                api.calendarEvent(eventId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                return@launch // gone, or no longer mine to see: nothing to say
            }
            callback(CalendarAlarmFired(eventId, read.channelId ?: channelId, read.takeIf { fits(it) }))
        }
    }

    /**
     * An event as it is now: into every window it overlaps (out of those it left), and the counts holding it. A one-off
     * event also replaces what was left of its series (it no longer repeats).
     */
    fun put(event: CalendarEventOut) {
        val series = event.series
        val other = { e: CalendarEventOut -> e.id != event.id && (event.recurring || e.series != series) }
        for ((key, window) in windows.entries.toList()) {
            val fits = (window.channelId == null || window.channelId == event.channelId) && CalendarDates.overlapsRange(event, window.from, window.to)
            val rest = window.events.filter(other)
            if (!fits && rest.size == window.events.size) continue
            windows[key] = window.copy(events = if (fits) (rest + event).sortedWith(CalendarDates.eventOrder) else rest)
        }
        for ((channelId, list) in upcoming.entries.toList()) {
            if (list.any { it.id == event.id }) upcoming[channelId] = list.map { if (it.id == event.id) event else it }
        }
        changed()
    }

    /** An event gone (a series: every occurrence). */
    private fun drop(eventId: String, channelId: String?) = dropWhere(channelId) { it.id == eventId || it.series == eventId }

    private fun dropWhere(channelId: String?, gone: (CalendarEventOut) -> Boolean) {
        for ((key, window) in windows.entries.toList()) {
            if (window.events.any(gone)) windows[key] = window.copy(events = window.events.filterNot(gone))
        }
        for ((id, list) in upcoming.entries.toList()) {
            if (list.any(gone)) upcoming[id] = list.filterNot(gone)
        }
        channelId?.let { refreshUpcoming(it) }
        changed()
    }

    /** My alarm on an event, or on every occurrence of a series. */
    private fun patchAlarm(eventId: String, alarm: CalendarAlarmOut?) {
        val mine = { e: CalendarEventOut -> e.id == eventId || e.series == eventId }
        var found = false
        for ((key, window) in windows.entries.toList()) {
            if (window.events.none(mine)) continue
            found = true
            windows[key] = window.copy(events = window.events.map { if (mine(it)) it.copy(alarm = alarm) else it })
        }
        for ((id, list) in upcoming.entries.toList()) {
            if (list.none(mine)) continue
            found = true
            upcoming[id] = list.map { if (mine(it)) it.copy(alarm = alarm) else it }
        }
        if (found) changed()
    }

    private fun refreshUpcoming(channelId: String) {
        if (upcoming.containsKey(channelId)) scope.launch { loadUpcoming(channelId) }
    }

    fun find(eventId: String): CalendarEventOut? =
        windows.values.firstNotNullOfOrNull { window -> window.events.firstOrNull { it.id == eventId } }
            ?: upcoming.values.firstNotNullOfOrNull { list -> list.firstOrNull { it.id == eventId } }

    /** Any occurrence of a series (or the one-off event) held here. */
    fun findSeries(seriesId: String): CalendarEventOut? = find(seriesId) ?: all().firstOrNull { it.series == seriesId }

    fun findOccurrence(seriesId: String, occurrenceStart: String): CalendarEventOut? =
        all().firstOrNull { it.series == seriesId && it.occurrenceStart == occurrenceStart }

    private fun all(): Sequence<CalendarEventOut> = windows.values.asSequence().flatMap { it.events } + upcoming.values.asSequence().flatten()

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
