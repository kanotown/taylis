package jp.chikuwachat.android.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/*
 * The calendar (CALENDAR.md; the server and web in M51, this client in M52). The shapes are openapi.json's
 * CalendarEventOut / CalendarAlarmOut / CalendarEventCreate / CalendarEventUpdate and ws-events.json's calendar.* data.
 */

/**
 * My alarm on an event (§2, §6). `status`: "pending" | "fired" | "cancelled". M69 (§10.4): on a series it is the series'
 * (one per person); `occurrence_start` is the occurrence it is for (null: a one-off event).
 */
@Serializable
data class CalendarAlarmOut(val minutesBefore: Int, val fireAt: String, val status: String = "pending", val occurrenceStart: String? = null)

/**
 * An event as I see it. Timed events carry `starts_at` / `ends_at` (instants), all-day ones `start_date` / `end_date`
 * ("YYYY-MM-DD", the end included). `channel_id` null: my own calendar. calendar.event.updated carries the same shape
 * without `can_edit` and `alarm` (they differ per person, CALENDAR.md §9 1.): they are filled in here.
 */
@Serializable
data class CalendarEventOut(
    val id: String,
    val channelId: String? = null,
    val channelName: String? = null,
    val ownerId: String = "",
    val title: String,
    val allDay: Boolean = false,
    val startsAt: String? = null,
    val endsAt: String? = null,
    val startDate: String? = null,
    val endDate: String? = null,
    val location: String? = null,
    val description: String? = null,
    val createdAt: String = "",
    val updatedAt: String = "",
    val canEdit: Boolean = false,
    val alarm: CalendarAlarmOut? = null,
    /** M69 (CALENDAR.md §10.3): the series' (parent's) id; a one-off event's own. Absent from a server before M68. */
    val seriesId: String? = null,
    /** The occurrence's key: its original start (`…Z` for a timed event, the date for an all-day one); a one-off event's start. */
    val occurrenceStart: String? = null,
    val recurring: Boolean = false,
    /** The series' rule and its wall-clock zone (null for a one-off event). */
    val rrule: String? = null,
    val tz: String? = null,
) {
    /** The series this entry belongs to (a one-off event is its own). */
    val series: String get() = seriesId ?: id

    /** The occurrence's key for the occurrence endpoints (a server always sends it for a recurring event). */
    val occurrenceKey: String get() = occurrenceStart ?: (if (allDay) startDate else startsAt) ?: ""
}

/** calendar.event.updated: the event as everyone sees it, and who may change it (my `can_edit` is whether I am among them). */
@Serializable
data class CalendarEventUpdated(val event: CalendarEventOut, val editorIds: List<String> = emptyList())

/** calendar.event.deleted. */
@Serializable
data class CalendarEventDeleted(val id: String, val channelId: String? = null)

/**
 * calendar.alarm.updated (to me only): my alarm was set, recomputed, fired or removed (null). `occurrence` (Review v0.1.22 #9,
 * CALENDAR.md §10.11): the occurrence the alarm is for as the server resolved it (a series' occurrence with its edits, a
 * one-off event as it is; shaped like calendar.event.updated's `event`, without `can_edit` and `alarm`). Null when there is
 * none; absent from a server before it.
 */
@Serializable
data class CalendarAlarmUpdated(
    val eventId: String,
    val channelId: String? = null,
    val alarm: CalendarAlarmOut? = null,
    val occurrence: CalendarEventOut? = null,
)

/** POST /calendar/events. `client_event_id` makes a retry return the same event (§9 4.); `tz` is the alarm's zone. */
@Serializable
data class CalendarEventCreate(
    val channelId: String? = null,
    val title: String,
    val allDay: Boolean = false,
    val startsAt: String? = null,
    val endsAt: String? = null,
    val startDate: String? = null,
    val endDate: String? = null,
    val location: String? = null,
    val description: String? = null,
    val alarmMinutes: Int? = null,
    val tz: String? = null,
    val clientEventId: String? = null,
    /** M69: the rule (CALENDAR.md §10.1); null (left out): a one-off event. */
    val rrule: String? = null,
)

/**
 * PATCH /calendar/events/{id}: the whole form (its calendar cannot move). Sent with its nulls written out: the other pair
 * of times is cleared when the event turns all-day (or back), and an emptied 場所 / 説明 is removed.
 */
data class CalendarEventUpdate(
    val title: String,
    val allDay: Boolean,
    val startsAt: String?,
    val endsAt: String?,
    val startDate: String?,
    val endDate: String?,
    val location: String?,
    val description: String?,
    /** M69: a one-off event made recurring (`tz`: the rule's zone); null leaves it one-off (not sent). */
    val rrule: String? = null,
    val tz: String? = null,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("title", JsonPrimitive(title))
        put("all_day", JsonPrimitive(allDay))
        put("starts_at", startsAt?.let { JsonPrimitive(it) } ?: JsonNull)
        put("ends_at", endsAt?.let { JsonPrimitive(it) } ?: JsonNull)
        put("start_date", startDate?.let { JsonPrimitive(it) } ?: JsonNull)
        put("end_date", endDate?.let { JsonPrimitive(it) } ?: JsonNull)
        put("location", location?.let { JsonPrimitive(it) } ?: JsonNull)
        put("description", description?.let { JsonPrimitive(it) } ?: JsonNull)
        rrule?.let { rule ->
            put("rrule", JsonPrimitive(rule))
            tz?.let { put("tz", JsonPrimitive(it)) }
        }
    }
}

/** M69 (CALENDAR.md §10.6): a private iCal feed, without its token. `scope`: "all" | "personal". */
@Serializable
data class CalendarFeedOut(val id: String, val scope: String = "all", val createdAt: String = "", val lastUsedAt: String? = null)

/** POST /calendar/ical-feeds: the feed and its URL (in this answer only: the server keeps a hash). */
@Serializable
data class CalendarFeedCreated(val feed: CalendarFeedOut, val url: String)
