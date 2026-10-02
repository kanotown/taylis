package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.CalendarEventCreate
import jp.chikuwachat.android.api.CalendarEventOut
import jp.chikuwachat.android.api.CalendarEventUpdate
import jp.chikuwachat.android.api.CalendarFeedCreated
import jp.chikuwachat.android.api.CalendarFeedOut
import jp.chikuwachat.android.ui.OccurrenceScope
import kotlinx.serialization.json.JsonObject

/** M52: the calendar endpoints (CALENDAR.md §4), apart from SyncApi like CanvasApi (ApiClient and the test fakes). */
interface CalendarApi {
    /** The events overlapping [from, to) (instants with offset; at most 100 days), mine and my channels' (or one channel's). */
    suspend fun calendarEvents(from: String, to: String, channelId: String? = null): List<CalendarEventOut>
    /** A channel's events today and the next days (`days` 1–7) not over yet, in `tz`'s days; at most 10. */
    suspend fun calendarUpcoming(channelId: String?, days: Int, tz: String): List<CalendarEventOut>
    suspend fun calendarEvent(eventId: String): CalendarEventOut
    suspend fun createCalendarEvent(body: CalendarEventCreate): CalendarEventOut
    suspend fun updateCalendarEvent(eventId: String, patch: CalendarEventUpdate): CalendarEventOut
    suspend fun deleteCalendarEvent(eventId: String)
    /** My alarm (`tz`: the zone its 8:00 and its text are read in, CALENDAR.md §9 2.); the event comes back. */
    suspend fun setCalendarAlarm(eventId: String, minutesBefore: Int, tz: String): CalendarEventOut
    suspend fun clearCalendarAlarm(eventId: String)

    /**
     * M69 (CALENDAR.md §10.3): one occurrence of a series (`scope` this), it and the later ones (following) or the whole
     * series (all). `body` is CalendarOccurrenceUpdate: the scope and only what changed (CalendarDates.occurrenceUpdate).
     */
    suspend fun updateCalendarOccurrence(seriesId: String, occurrenceStart: String, body: JsonObject): CalendarEventOut
    suspend fun deleteCalendarOccurrence(seriesId: String, occurrenceStart: String, scope: OccurrenceScope)
}

/** M69 (CALENDAR.md §10.3, §10.6): my private iCal feed URLs. */
interface CalendarFeedApi {
    suspend fun calendarFeeds(): List<CalendarFeedOut>
    /** `scope`: "all" | "personal". The URL is in this answer only. */
    suspend fun createCalendarFeed(scope: String): CalendarFeedCreated
    suspend fun deleteCalendarFeed(feedId: String)
}
