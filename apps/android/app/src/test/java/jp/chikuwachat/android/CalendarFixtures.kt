package jp.chikuwachat.android

import jp.chikuwachat.android.api.CalendarEventOut
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import java.util.TimeZone

/** M52: calendar events for the tests, shaped like the server's CalendarEventOut (the desktop's calendarFixtures.ts). */
object CalendarFixtures {
    private var n = 0

    fun timed(
        title: String, startsAt: String, endsAt: String, id: String? = null, channelId: String? = null, channelName: String? = null,
        ownerId: String = "me", canEdit: Boolean = true, alarm: jp.chikuwachat.android.api.CalendarAlarmOut? = null, location: String? = null,
    ): CalendarEventOut {
        n += 1
        return CalendarEventOut(
            id = id ?: "e$n", channelId = channelId, channelName = channelName, ownerId = ownerId, title = title, allDay = false,
            startsAt = startsAt, endsAt = endsAt, location = location, createdAt = "2026-10-01T00:00:00Z", updatedAt = "2026-10-01T00:00:00Z",
            canEdit = canEdit, alarm = alarm,
        )
    }

    /** M69: an occurrence of a series as GET /calendar/events expands it (the first one has the series' id). */
    fun occurrence(
        title: String, startsAt: String, endsAt: String, series: String, rrule: String = "FREQ=WEEKLY;BYDAY=MO", first: Boolean = false,
        channelId: String? = null, alarm: jp.chikuwachat.android.api.CalendarAlarmOut? = null,
    ): CalendarEventOut = timed(title, startsAt, endsAt, id = if (first) series else "$series@$startsAt", channelId = channelId, alarm = alarm).copy(
        seriesId = series, occurrenceStart = startsAt, recurring = true, rrule = rrule, tz = "Asia/Tokyo",
    )

    fun allDay(title: String, start: String, end: String = start, id: String? = null, channelId: String? = null): CalendarEventOut {
        n += 1
        return CalendarEventOut(
            id = id ?: "e$n", channelId = channelId, ownerId = "me", title = title, allDay = true, startDate = start, endDate = end,
            createdAt = "2026-10-01T00:00:00Z", updatedAt = "2026-10-01T00:00:00Z", canEdit = true,
        )
    }
}

/** Runs a test class in Tokyo, like the lab's devices (the date math reads the default zone each time). */
class TokyoZone : TestWatcher() {
    private var saved: TimeZone? = null

    override fun starting(description: Description) {
        saved = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("Asia/Tokyo"))
    }

    override fun finished(description: Description) {
        saved?.let { TimeZone.setDefault(it) }
    }
}
