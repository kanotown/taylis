package jp.chikuwachat.android

import jp.chikuwachat.android.CalendarFixtures.allDay
import jp.chikuwachat.android.CalendarFixtures.timed
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.CalendarAlarmOut
import jp.chikuwachat.android.api.CalendarEventCreate
import jp.chikuwachat.android.api.CalendarEventOut
import jp.chikuwachat.android.api.CalendarEventUpdate
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.sync.CalendarApi
import jp.chikuwachat.android.sync.CalendarHub
import jp.chikuwachat.android.sync.CalendarWindowState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * M52: the calendar on this device (sync/Calendar.kt), the scenarios of the desktop's calendarHub.test.ts: windows on
 * ranges, the calendar.* events as ws-events.json shapes them (decoded here), my own changes, reconnecting, leaving.
 */
class CalendarHubTest {
    @get:Rule val tokyo = TokyoZone()

    private val oct = "2026-10-01T00:00:00+09:00" to "2026-11-01T00:00:00+09:00"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    private class FakeCalendarApi(var rows: List<CalendarEventOut> = emptyList()) : CalendarApi {
        var upcoming: List<CalendarEventOut> = emptyList()
        val calls = ArrayList<String>()
        var failWith: Exception? = null

        override suspend fun calendarEvents(from: String, to: String, channelId: String?): List<CalendarEventOut> {
            calls += "events $from $to ${channelId ?: "-"}"
            failWith?.let { throw it }
            return rows.filter { channelId == null || it.channelId == channelId }
        }

        override suspend fun calendarUpcoming(channelId: String?, days: Int, tz: String): List<CalendarEventOut> {
            calls += "upcoming ${channelId ?: "-"} $days $tz"
            return upcoming
        }

        override suspend fun calendarEvent(eventId: String): CalendarEventOut {
            calls += "event $eventId"
            return rows.firstOrNull { it.id == eventId } ?: throw ApiException.Api(404, "calendar_event_not_found", "gone")
        }

        override suspend fun createCalendarEvent(body: CalendarEventCreate): CalendarEventOut {
            calls += "create ${body.clientEventId}"
            return timed(body.title, body.startsAt!!, body.endsAt!!, id = "new", channelId = body.channelId)
        }

        override suspend fun updateCalendarEvent(eventId: String, patch: CalendarEventUpdate): CalendarEventOut {
            calls += "update $eventId"
            return rows.first { it.id == eventId }.copy(title = patch.title, startsAt = patch.startsAt, endsAt = patch.endsAt)
        }

        override suspend fun deleteCalendarEvent(eventId: String) {
            calls += "delete $eventId"
        }

        override suspend fun setCalendarAlarm(eventId: String, minutesBefore: Int, tz: String): CalendarEventOut {
            calls += "alarm $eventId $minutesBefore $tz"
            return rows.first { it.id == eventId }.copy(alarm = CalendarAlarmOut(minutesBefore, "2026-10-05T04:50:00Z", "pending"))
        }

        override suspend fun clearCalendarAlarm(eventId: String) {
            calls += "clear $eventId"
        }
    }

    private fun hub(api: CalendarApi?, onAlarm: ((CalendarEventOut) -> Unit)? = null) =
        CalendarHub(api, scope, { "me" }, { "Asia/Tokyo" }).also { it.onAlarm = onAlarm }

    /** calendar.event.updated as the server sends it: the event without `can_edit` and `alarm`, and `editor_ids`. */
    private fun updated(event: CalendarEventOut, editors: List<String>): JsonObject {
        val shared = Codec.snake.encodeToJsonElement(CalendarEventOut.serializer(), event).jsonObject.filterKeys { it != "can_edit" && it != "alarm" }
        return JsonObject(mapOf("event" to JsonObject(shared), "editor_ids" to JsonArray(editors.map { JsonPrimitive(it) })))
    }

    private fun json(text: String): JsonObject = Codec.plain.parseToJsonElement(text).jsonObject

    @Test
    fun aWindowIsReadAndTheEventsThatOverlapItStayCurrent() = runBlocking {
        val zemi = timed("ゼミ", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", channelId = "c1", channelName = "lab", ownerId = "bob", canEdit = false,
            alarm = CalendarAlarmOut(10, "2026-10-05T04:50:00Z", "pending"))
        val api = FakeCalendarApi(listOf(zemi))
        val hub = hub(api)
        hub.open("view", oct.first, oct.second)
        assertEquals(CalendarWindowState.READY, hub.window("view")!!.state)
        assertEquals(listOf("ゼミ"), hub.window("view")!!.events.map { it.title })
        assertEquals(listOf("events ${oct.first} ${oct.second} -"), api.calls)

        // Changed by someone else: my alarm stays, can_edit follows editor_ids.
        hub.applyEvent("calendar.event.updated", updated(zemi.copy(title = "ゼミ (変更)"), listOf("bob", "me")))
        val changed = hub.window("view")!!.events.single()
        assertEquals("ゼミ (変更)", changed.title)
        assertTrue(changed.canEdit)
        assertEquals(10, changed.alarm?.minutesBefore)

        // A new one inside the range comes in, in order; one outside is dropped.
        val early = allDay("学会", "2026-10-02", "2026-10-03", channelId = "c2")
        hub.applyEvent("calendar.event.updated", updated(early, emptyList()))
        hub.applyEvent("calendar.event.updated", updated(allDay("来月", "2026-11-01"), listOf("me")))
        assertEquals(listOf("学会", "ゼミ (変更)"), hub.window("view")!!.events.map { it.title })
        assertFalse(hub.window("view")!!.events[0].canEdit)

        // Moved out of the range: it leaves. Deleted: gone.
        hub.applyEvent("calendar.event.updated", updated(zemi.copy(startsAt = "2026-11-05T05:00:00Z", endsAt = "2026-11-05T06:00:00Z"), emptyList()))
        assertEquals(listOf("学会"), hub.window("view")!!.events.map { it.title })
        hub.applyEvent("calendar.event.deleted", json("""{"id": "${early.id}", "channel_id": "c2"}"""))
        assertTrue(hub.window("view")!!.events.isEmpty())
    }

    @Test
    fun theEventsDecodeFromTheWireShapes() = runBlocking {
        val hub = hub(FakeCalendarApi())
        hub.open("view", oct.first, oct.second)
        // ws-events.json's CalendarEventData (no can_edit / alarm), with the fields a newer server may add.
        hub.applyEvent(
            "calendar.event.updated",
            json(
                """{"event": {"id": "e-wire", "channel_id": null, "channel_name": null, "owner_id": "me", "title": "面談", "all_day": false,
                "starts_at": "2026-10-07T01:00:00Z", "ends_at": "2026-10-07T02:00:00+00:00", "start_date": null, "end_date": null,
                "location": "オンライン", "description": null, "created_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-01T00:00:00Z",
                "future_field": 1}, "editor_ids": ["me"]}""",
            ),
        )
        val event = hub.find("e-wire")!!
        assertEquals("面談", event.title)
        assertEquals("オンライン", event.location)
        assertTrue(event.canEdit)
        assertNull(event.alarm)
        hub.applyEvent("calendar.alarm.updated", json("""{"event_id": "e-wire", "channel_id": null, "alarm": {"minutes_before": 15, "fire_at": "2026-10-07T00:45:00Z", "status": "pending"}}"""))
        assertEquals(CalendarAlarmOut(15, "2026-10-07T00:45:00Z", "pending"), hub.find("e-wire")!!.alarm)
        // Unreadable data is dropped, not thrown.
        hub.applyEvent("calendar.event.updated", json("""{"event": {"id": 3}}"""))
        hub.applyEvent("calendar.event.deleted", json("""{}"""))
        assertEquals(listOf("面談"), hub.window("view")!!.events.map { it.title })
    }

    @Test
    fun aChannelsWindowKeepsToThatChannel() = runBlocking {
        val api = FakeCalendarApi()
        val hub = hub(api)
        hub.open("channel:c1", oct.first, oct.second, "c1")
        hub.applyEvent("calendar.event.updated", updated(timed("other", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", channelId = "c2"), emptyList()))
        hub.applyEvent("calendar.event.updated", updated(timed("mine", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z"), listOf("me")))
        hub.applyEvent("calendar.event.updated", updated(timed("lab", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", channelId = "c1"), emptyList()))
        assertEquals(listOf("lab"), hub.window("channel:c1")!!.events.map { it.title })
        assertEquals(listOf("events ${oct.first} ${oct.second} c1"), api.calls)
        hub.close("channel:c1")
        assertNull(hub.window("channel:c1"))
    }

    @Test
    fun myAlarmAppliesAndSaysSoOnceWhenItFires() = runBlocking {
        val zemi = timed("ゼミ", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z")
        val said = ArrayList<CalendarEventOut>()
        val hub = hub(FakeCalendarApi(listOf(zemi))) { said += it }
        hub.open("view", oct.first, oct.second)
        val alarm = CalendarAlarmOut(10, "2026-10-05T04:50:00Z", "pending")
        fun alarmEvent(value: CalendarAlarmOut?) = JsonObject(
            mapOf("event_id" to JsonPrimitive(zemi.id), "channel_id" to kotlinx.serialization.json.JsonNull, "alarm" to (value?.let { Codec.snake.encodeToJsonElement(CalendarAlarmOut.serializer(), it) } ?: kotlinx.serialization.json.JsonNull)),
        )
        hub.applyEvent("calendar.alarm.updated", alarmEvent(alarm))
        assertEquals(alarm, hub.find(zemi.id)!!.alarm)
        hub.applyEvent("calendar.alarm.updated", alarmEvent(alarm.copy(status = "fired")))
        hub.applyEvent("calendar.alarm.updated", alarmEvent(alarm.copy(status = "fired")))
        assertEquals(listOf("ゼミ"), said.map { it.title })
        hub.applyEvent("calendar.alarm.updated", alarmEvent(null))
        assertNull(hub.find(zemi.id)!!.alarm)

        // An alarm of an event outside every window: the event is read to say it; one gone says nothing.
        val later = timed("来月の予定", "2026-11-20T05:00:00Z", "2026-11-20T06:00:00Z", id = "far")
        val said2 = ArrayList<CalendarEventOut>()
        val hub2 = hub(FakeCalendarApi(listOf(later))) { said2 += it }
        hub2.applyEvent("calendar.alarm.updated", json("""{"event_id": "far", "channel_id": null, "alarm": {"minutes_before": 10, "fire_at": "x", "status": "fired"}}"""))
        hub2.applyEvent("calendar.alarm.updated", json("""{"event_id": "gone", "channel_id": null, "alarm": {"minutes_before": 10, "fire_at": "x", "status": "fired"}}"""))
        assertEquals(listOf(later), said2)
    }

    @Test
    fun everythingIsReadAgainAfterReconnectingAndAChannelLeftGoes() = runBlocking {
        val lab = timed("lab", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", channelId = "c1")
        val mine = timed("mine", "2026-10-06T05:00:00Z", "2026-10-06T06:00:00Z")
        val api = FakeCalendarApi(listOf(lab))
        val hub = hub(api)
        hub.open("view", oct.first, oct.second)
        api.upcoming = listOf(lab)
        hub.loadUpcoming("c1")
        assertEquals(1, hub.upcomingOf("c1")!!.size)
        assertEquals("upcoming c1 2 Asia/Tokyo", api.calls.last())
        // Missed while offline: the next read has it.
        api.rows = listOf(lab, mine)
        hub.online()
        assertEquals(listOf("lab", "mine"), hub.window("view")!!.events.map { it.title })
        assertEquals(2, api.calls.count { it.startsWith("upcoming") })
        hub.removeChannel("c1")
        assertEquals(listOf("mine"), hub.window("view")!!.events.map { it.title })
        assertNull(hub.upcomingOf("c1"))
    }

    @Test
    fun theTabCountIsReadAgainWhenOneOfTheChannelsEventsChanges() = runBlocking {
        val api = FakeCalendarApi()
        val hub = hub(api)
        hub.loadUpcoming("c1")
        val lab = timed("lab", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", channelId = "c1")
        api.upcoming = listOf(lab)
        hub.applyEvent("calendar.event.updated", updated(lab, emptyList()))
        assertEquals(1, hub.upcomingOf("c1")!!.size)
        // Another channel's count, never read, is not asked for.
        hub.applyEvent("calendar.event.updated", updated(timed("x", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", channelId = "c9"), emptyList()))
        assertTrue(api.calls.filter { it.startsWith("upcoming") }.all { it.startsWith("upcoming c1") })
        // Deleted: out of the count at once, and read again.
        hub.applyEvent("calendar.event.deleted", json("""{"id": "${lab.id}", "channel_id": "c1"}"""))
        assertEquals(3, api.calls.count { it.startsWith("upcoming c1") })
    }

    @Test
    fun whatIChangeGoesIntoTheWindowsAtOnce() = runBlocking {
        val zemi = timed("ゼミ", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z")
        val api = FakeCalendarApi(listOf(zemi))
        val hub = hub(api)
        hub.open("view", oct.first, oct.second)
        hub.setAlarm(zemi.id, 10)
        assertEquals("alarm ${zemi.id} 10 Asia/Tokyo", api.calls.last())
        assertEquals(10, hub.find(zemi.id)!!.alarm?.minutesBefore)
        hub.setAlarm(zemi.id, null)
        assertEquals("clear ${zemi.id}", api.calls.last())
        assertNull(hub.find(zemi.id)!!.alarm)
        hub.create(CalendarEventCreate(title = "新しい予定", startsAt = "2026-10-07T05:00:00Z", endsAt = "2026-10-07T06:00:00Z", clientEventId = "k1"))
        assertEquals("create k1", api.calls.last())
        assertEquals(listOf("ゼミ", "新しい予定"), hub.window("view")!!.events.map { it.title })
        hub.update(zemi.id, CalendarEventUpdate("ゼミ (移動)", false, "2026-10-09T05:00:00Z", "2026-10-09T06:00:00Z", null, null, null, null))
        assertEquals(listOf("新しい予定", "ゼミ (移動)"), hub.window("view")!!.events.map { it.title })
        hub.remove(zemi.id)
        assertEquals(listOf("新しい予定"), hub.window("view")!!.events.map { it.title })
        // An event known only by its id (a tapped alarm): as held here, else read.
        assertEquals("新しい予定", hub.get("new").title)
        assertFalse(api.calls.contains("event new"))
    }

    @Test
    fun aServerWithoutTheCalendarIsSaidSoAndAFailureIsReadAgainOnReconnect() = runBlocking {
        val api = FakeCalendarApi()
        api.failWith = ApiException.Api(404, "not_found", "Not Found")
        val hub = hub(api)
        hub.open("view", oct.first, oct.second)
        assertEquals(CalendarWindowState.UNSUPPORTED, hub.window("view")!!.state)
        api.failWith = ApiException.Network(java.io.IOException("offline"))
        hub.open("other", oct.first, oct.second)
        assertEquals(CalendarWindowState.FAILED, hub.window("other")!!.state)
        api.failWith = null
        hub.online()
        assertEquals(CalendarWindowState.READY, hub.window("other")!!.state)
        // Without the endpoints (an older fake, no API): nothing is available and nothing is read.
        val none = hub(null)
        assertFalse(none.available)
        none.open("view", oct.first, oct.second)
        assertEquals(CalendarWindowState.LOADING, none.window("view")!!.state)
    }
}
