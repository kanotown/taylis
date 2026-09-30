package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.CalendarEventCreate
import jp.chikuwachat.android.api.CalendarEventOut
import jp.chikuwachat.android.api.CalendarEventUpdate

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
}
