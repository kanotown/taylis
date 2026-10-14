package jp.chikuwachat.android

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.NotificationPreferenceOut
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.api.TaskStatus
import jp.chikuwachat.android.platform.Notifier
import jp.chikuwachat.android.platform.PushMessage
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.ui.Channels
import jp.chikuwachat.android.widget.TodayEvent
import jp.chikuwachat.android.widget.TodayRow
import jp.chikuwachat.android.widget.TodayWidgetRules
import jp.chikuwachat.android.widget.TodayWidgetSnapshot
import jp.chikuwachat.android.widget.UnreadRow
import jp.chikuwachat.android.widget.UnreadWidgetRules
import jp.chikuwachat.android.widget.UnreadWidgetSnapshot
import jp.chikuwachat.android.widget.WidgetLink
import jp.chikuwachat.android.widget.WidgetLinks
import jp.chikuwachat.android.widget.WidgetScreen
import kotlinx.serialization.Serializable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.time.Instant
import java.time.LocalDate

/** The 未読・メンション and 今日の予定・締切 home-screen widgets' pure parts: snapshots, counts, rows, order, schedule, links. */
class PlanWidgetsTest {
    @get:Rule val tokyo = TokyoZone()

    private val server = "https://lab.example.com"
    private val now = Instant.parse("2026-10-14T03:00:00Z") // 12:00 in Tokyo, Wednesday

    // --- 未読・メンション ---------------------------------------------------------------------------

    private fun channel(
        id: String, type: String = "public", unread: Int = 0, mentions: Int = 0, member: Boolean = true, archived: Boolean = false,
        level: String? = null, mutedUntil: String? = null, muted: Boolean = false, timesOwner: String? = null,
        lastMessageAt: String? = null, dmUsers: List<String>? = null,
    ) = ChannelState(
        channel = ChannelOut(
            id = id, type = type, name = id, archived = archived, lastSeq = 0, createdAt = "", updatedAt = "", lastMessageAt = lastMessageAt,
            notification = if (level == null && mutedUntil == null && !muted) null
            else NotificationPreferenceOut(id, level ?: "none", mutedUntil, followsDefault = level == null, muted = muted),
            timesOwnerId = timesOwner, dmUserIds = dmUsers,
        ),
        isMember = member, unreadCount = unread, mentionCount = mentions,
    )

    private fun title(c: ChannelState) = if (c.channel.isDm) "dm:" + c.id else "#" + c.id

    private fun unread(channels: List<ChannelState>, people: Map<String, String> = emptyMap()) =
        UnreadWidgetRules.snapshot(server, "Kano Lab", "me", channels, ::title, people, now)

    @Test
    fun unreadCountsMentionsInChannelsAndEveryMessageInDms() {
        val s = unread(
            listOf(
                channel("general", unread = 9, mentions = 2, lastMessageAt = "2026-10-14T02:00:00Z"),
                channel("random", unread = 4), // no mention: not counted (the badge rule)
                channel("alice", type = "dm", unread = 3, lastMessageAt = "2026-10-14T02:30:00Z"),
                channel("group", type = "group_dm", unread = 1, lastMessageAt = "2026-10-14T01:00:00Z"),
                channel("muted-dm", type = "dm", unread = 5, mentions = 0, level = "none"), // muted: its mentions only
                channel("muted", unread = 7, mentions = 1, mutedUntil = "2026-10-15T00:00:00Z", lastMessageAt = "2026-10-13T00:00:00Z"),
                channel("times-bob", unread = 6, mentions = 0, timesOwner = "bob"), // quiet: a mention only
                channel("old", unread = 2, mentions = 2, archived = true), // archived: never counted (GET /sync/summary)
                channel("left", unread = 2, mentions = 2, member = false),
            ),
        )
        assertEquals(3, s.mentions)
        assertEquals(4, s.dms)
        assertEquals(7, s.total)
        assertEquals(4, s.conversations)
        // Newest message first; the ones without a time last.
        assertEquals(listOf("alice", "general", "group", "muted"), s.rows.map { it.channelId })
        assertEquals(UnreadRow("alice", "dm:alice", 3, dm = true, lastAt = "2026-10-14T02:30:00Z"), s.rows[0])
        assertEquals(1, s.rows.first { it.channelId == "muted" }.count)
        assertTrue(s.rows.first { it.channelId == "group" }.group)
    }

    @Test
    fun aDmRowKnowsTheOtherPersonForItsFace() {
        val s = unread(
            listOf(
                channel("bob-dm", type = "dm", unread = 1, dmUsers = listOf("me", "bob")),
                channel("self", type = "dm", unread = 1, dmUsers = listOf("me")),
                channel("group", type = "group_dm", unread = 1, dmUsers = listOf("me", "bob", "carol")),
            ),
        )
        assertEquals("bob", s.rows.first { it.channelId == "bob-dm" }.userId)
        assertEquals("me", s.rows.first { it.channelId == "self" }.userId)
        assertNull(s.rows.first { it.channelId == "group" }.userId)
    }

    @Test
    fun unreadMatchesTheSharedBadgeRuleForEveryVector() {
        for (case in vectors()) {
            for (timed in if (case.muted) listOf(true, false) else listOf(false)) {
                val row = channel(
                    "c", type = case.type, unread = case.unread, mentions = case.mentions, level = case.level,
                    mutedUntil = if (case.muted && timed) "2026-10-15T00:00:00Z" else null, muted = case.muted && !timed,
                    timesOwner = when (case.times) { "mine" -> "me"; "others" -> "someone"; else -> null },
                )
                val s = unread(listOf(row))
                assertEquals(case.name, case.expect.badge, s.total)
                assertEquals(case.name, Channels.badgeCount(row, now), s.total)
                assertEquals(case.name, if (case.expect.badge > 0) 1 else 0, s.rows.size)
            }
        }
    }

    @Serializable
    private data class UnreadCase(
        val name: String, val type: String, val times: String?, val level: String?, val muted: Boolean,
        val unread: Int, val mentions: Int, val expect: Expected,
    )

    @Serializable
    private data class Expected(val hasUnread: Boolean, val badge: Int, val quiet: Boolean)

    @Serializable
    private data class Vectors(val cases: List<UnreadCase>)

    private fun vectors(): List<UnreadCase> {
        val file = File("../../shared/unread-rules.json")
        check(file.isFile) { "apps/shared/unread-rules.json not found from ${File("").absolutePath}" }
        return Codec.snake.decodeFromString(Vectors.serializer(), file.readText()).cases.also { assertTrue(it.isNotEmpty()) }
    }

    @Test
    fun unreadKeepsAtMostTheRowsItDrawsAndCountsTheRest() {
        val many = (1..20).map { channel("c$it", mentions = 1, lastMessageAt = "2026-10-14T00:%02d:00Z".format(it)) }
        val s = unread(many)
        assertEquals(UnreadWidgetRules.MAX_ROWS, s.rows.size)
        assertEquals(20, s.conversations)
        assertEquals("c20", s.rows.first().channelId)
        assertEquals(3, UnreadWidgetRules.rowsThatFit(160f, 82f, 26f, 6))
        assertEquals(6, UnreadWidgetRules.rowsThatFit(1000f, 82f, 26f, 6))
        assertEquals(0, UnreadWidgetRules.rowsThatFit(60f, 82f, 26f, 6))
        assertEquals("99+", UnreadWidgetRules.countText(120))
        assertEquals("7", UnreadWidgetRules.countText(7))
    }

    @Test
    fun unreadSnapshotEncodesAndDecodes() {
        val s = unread(listOf(channel("general", mentions = 2), channel("alice", type = "dm", unread = 1)), mapOf("me" to "Me", "a" to "Alice"))
            .copy(updatedAt = 42L)
        assertEquals(s, UnreadWidgetRules.decode(UnreadWidgetRules.encode(s)))
        assertNull(UnreadWidgetRules.decode(null))
        assertNull(UnreadWidgetRules.decode("{not json"))
        // Unknown fields from a later version are ignored.
        val later = UnreadWidgetRules.encode(s).replaceFirst("{", "{\"future\":1,")
        assertEquals(s, UnreadWidgetRules.decode(later))
        assertTrue(UnreadWidgetRules.same(s, s.copy(updatedAt = 7L)))
        assertFalse(UnreadWidgetRules.same(s, s.copy(mentions = 9)))
    }

    @Test
    fun peopleAreMyDmsPeopleAndMe() {
        val people = UnreadWidgetRules.people(
            listOf(channel("d1", type = "dm", dmUsers = listOf("me", "a")), channel("g", type = "group_dm", dmUsers = listOf("me", "b", "c")),
                channel("x", type = "dm", dmUsers = listOf("me", "z"), member = false), channel("general")),
            "me",
        ) { id -> mapOf("me" to "Kano", "a" to "Alice", "b" to "Bob", "c" to "")[id] }
        assertEquals(mapOf("me" to "Kano", "a" to "Alice", "b" to "Bob"), people)
    }

    private fun push(kind: String = "message", channelId: String? = "c1", type: String? = "public", badge: Int? = null, title: String = "#c1", sender: String? = null) =
        PushMessage(kind = kind, channelId = channelId, messageId = "m", seq = 1, title = title, body = "body", badge = badge, channelType = type, senderName = sender)

    @Test
    fun aPushWhileTheAppIsNotLiveMovesItsConversationUpAndTakesTheServersNumber() {
        val old = UnreadWidgetSnapshot(
            server, "Kano Lab", "me", mentions = 1, dms = 2, conversations = 2,
            rows = listOf(UnreadRow("dm1", "Alice", 2, dm = true, "2026-10-14T01:00:00Z"), UnreadRow("general", "#general", 1, dm = false, "2026-10-14T00:00:00Z")),
        )
        // A DM: one more there, on top; the number is the server's.
        val dm = UnreadWidgetRules.pushed(old, push(channelId = "dm2", type = "dm", badge = 4, title = "Bob", sender = "Bob"), 1_000L)!!
        assertEquals(4, dm.total)
        assertEquals(listOf("dm2", "dm1", "general"), dm.rows.map { it.channelId })
        assertEquals(UnreadRow("dm2", "Bob", 1, dm = true, Instant.ofEpochMilli(1_000L).toString()), dm.rows[0])
        assertEquals(3, dm.conversations)
        // A channel the server's number grew for: a mention there.
        val mention = UnreadWidgetRules.pushed(old, push(channelId = "general", badge = 4), 1_000L)!!
        assertEquals(listOf("general", "dm1"), mention.rows.map { it.channelId })
        assertEquals(2, mention.rows[0].count)
        assertEquals(2, mention.conversations)
        // A level-「すべて」 channel's push (the number did not grow): only the number.
        val all = UnreadWidgetRules.pushed(old, push(channelId = "random", badge = 3), 1_000L)!!
        assertEquals(old.rows, all.rows)
        assertEquals(3, all.total)
        // A reaction's push carries no conversation to count; the same number changes nothing.
        assertNull(UnreadWidgetRules.pushed(old, push(kind = "reaction", badge = null), 1_000L))
        assertNull(UnreadWidgetRules.pushed(old.copy(pushedTotal = 3), push(kind = "calendar", channelId = null, badge = 3), 1_000L))
        // A push for the server's previous account (it signed out, someone else signed in): not counted.
        assertNull(UnreadWidgetRules.pushed(old, push(channelId = "dm2", type = "dm", badge = 4).copy(recipientId = "someone-else"), 1_000L))
        // Mine (and from an older server, without a recipient): counted.
        assertEquals(4, UnreadWidgetRules.pushed(old, push(channelId = "dm2", type = "dm", badge = 4).copy(recipientId = "me"), 1_000L)!!.total)
        assertEquals("u1", PushMessage.parse(mapOf("kind" to "message", "recipient_id" to "u1"))!!.recipientId)
    }

    // --- 今日の予定・締切 ---------------------------------------------------------------------------

    private val today = LocalDate.parse("2026-10-14")

    private fun task(id: String, due: String?, dueAt: String? = null, status: String = TaskStatus.TODO, channelId: String? = null, assignees: List<String> = emptyList()) =
        TaskOut(id = id, title = "task $id", channelId = channelId, channelName = channelId?.let { "ch-$it" }, dueOn = due, dueAt = dueAt, status = status, assigneeIds = assignees)

    private fun todaySnapshot(): TodayWidgetSnapshot {
        val events = listOf(
            CalendarFixtures.timed("Seminar", "2026-10-14T05:00:00+00:00", "2026-10-14T06:00:00+00:00", id = "seminar", channelId = "lab", channelName = "lab"), // 14:00–15:00
            CalendarFixtures.timed("Breakfast", "2026-10-13T23:00:00+00:00", "2026-10-14T00:00:00+00:00", id = "breakfast"), // 8:00–9:00: over
            CalendarFixtures.timed("Lunch", "2026-10-14T02:30:00+00:00", "2026-10-14T03:30:00+00:00", id = "lunch"), // 11:30–12:30: under way
            CalendarFixtures.allDay("Holiday", "2026-10-14", id = "holiday"),
            CalendarFixtures.timed("Trip", "2026-10-12T00:00:00+00:00", "2026-10-15T00:00:00+00:00", id = "trip"), // began earlier
            CalendarFixtures.timed("Tomorrow", "2026-10-15T01:00:00+00:00", "2026-10-15T02:00:00+00:00", id = "tomorrow"),
            CalendarFixtures.occurrence("Weekly", "2026-10-14T08:00:00Z", "2026-10-14T09:00:00Z", series = "weekly"), // 17:00–18:00
        )
        val tasks = listOf(
            task("today", "2026-10-14"),
            task("timed", "2026-10-14", dueAt = "2026-10-14T08:00:00Z", channelId = "lab", assignees = listOf("me")), // 17:00
            task("late", "2026-10-10"),
            task("tomorrow", "2026-10-15"),
            task("later", "2026-10-20"),
            task("done", "2026-10-14", status = TaskStatus.DONE),
            task("theirs", "2026-10-14", channelId = "lab", assignees = listOf("bob")), // not mine
            task("undated", null),
        )
        return TodayWidgetRules.snapshot(server, "Kano Lab", "me", today, events, tasks, 1L)
    }

    @Test
    fun todayKeepsTwoDaysOfEventsAndMyOpenTasksDueByTomorrow() {
        val s = todaySnapshot()
        assertEquals("2026-10-14", s.day)
        assertEquals(7, s.events.size)
        // By date, then a due time (a date alone is the whole day: after the timed ones), as 「締切」 orders them.
        assertEquals(listOf("late", "timed", "today", "tomorrow"), s.tasks.map { it.id })
        assertEquals(s, TodayWidgetRules.decode(TodayWidgetRules.encode(s)))
        assertNull(TodayWidgetRules.decode(""))
        assertTrue(TodayWidgetRules.same(s, s.copy(updatedAt = 99L)))
        assertEquals("2026-10-14T00:00:00+09:00" to "2026-10-16T00:00:00+09:00", TodayWidgetRules.range(today))
    }

    @Test
    fun todaysEventsAllDayAndEarlierFirstThenByTimeOverOnesLeave() {
        val s = todaySnapshot()
        val events = TodayWidgetRules.eventsToday(s, today, now)
        // The calendar's own day order: what began on an earlier day and the all-day ones, then by start time.
        assertEquals(listOf("trip", "holiday", "lunch", "seminar", "weekly"), events.map { it.id.substringBefore('@') })
        // The weekly occurrence keeps its series and key (the link opens that occurrence).
        val weekly = events.last()
        assertEquals("weekly", weekly.seriesId)
        assertEquals("2026-10-14T08:00:00Z", weekly.occurrenceStart)
        assertTrue(weekly.recurring)
        // Evening: only the all-day and the multi-day ones are left.
        val evening = Instant.parse("2026-10-14T10:00:00Z")
        assertEquals(listOf("trip", "holiday"), TodayWidgetRules.eventsToday(s, today, evening).map { it.id })
    }

    @Test
    fun todaysTasksOverdueFirstThenTodayByTime() {
        val s = todaySnapshot()
        val rows = TodayWidgetRules.rows(s, today, now)
        val tasks = rows.filterIsInstance<TodayRow.Task>()
        assertEquals(listOf("late", "timed", "today"), tasks.map { it.task.id })
        assertEquals(listOf(true, false, false), tasks.map { it.overdue })
        // Events come first, then tasks.
        assertTrue(rows.take(5).all { it is TodayRow.Event })
        // Past its due time the timed one is overdue too.
        val after = Instant.parse("2026-10-14T08:30:00Z")
        assertTrue(TodayWidgetRules.rows(s, today, after).filterIsInstance<TodayRow.Task>().first { it.task.id == "timed" }.overdue)
        // Tomorrow: what the snapshot holds for the next day, before any read.
        val tomorrow = today.plusDays(1)
        assertEquals(listOf("late", "timed", "today", "tomorrow"), TodayWidgetRules.tasksDue(s, tomorrow).map { it.id })
        assertEquals(listOf("trip", "tomorrow"), TodayWidgetRules.eventsToday(s, tomorrow, Instant.parse("2026-10-14T23:00:00Z")).map { it.id })
        // Two days on it covers nothing (the widget says it could not update).
        assertFalse(TodayWidgetRules.covers(s, today.plusDays(2)))
        assertEquals(emptyList<TodayRow>(), TodayWidgetRules.rows(s, today.plusDays(2), now))
    }

    @Test
    fun theCompactWidgetsNextEvent() {
        val s = todaySnapshot()
        assertEquals("lunch", TodayWidgetRules.next(s, today, now)?.id) // under way
        assertEquals("seminar", TodayWidgetRules.next(s, today, Instant.parse("2026-10-14T04:00:00Z"))?.id) // 13:00
        assertEquals("holiday", TodayWidgetRules.next(s, today, Instant.parse("2026-10-14T10:00:00Z"))?.id) // 19:00: the all-day one
        assertEquals("trip", TodayWidgetRules.next(s.copy(events = s.events.filter { !it.allDay }), today, Instant.parse("2026-10-14T10:00:00Z"))?.id)
        assertNull(TodayWidgetRules.next(s.copy(events = emptyList()), today, now))
        // The tall compact widget lists the rest of the day under it.
        val lunch = TodayWidgetRules.next(s, today, now)!!
        assertEquals(listOf("trip", "holiday", "seminar", "weekly"), TodayWidgetRules.laterToday(s, today, now, lunch).map { it.id.substringBefore('@') })
    }

    @Test
    fun theNextRedrawIsTheNextEndDueTimeOrMidnight() {
        val s = todaySnapshot()
        val slack = TodayWidgetRules.REFRESH_SLACK_MS
        // 12:00: Lunch ends at 12:30.
        assertEquals(Instant.parse("2026-10-14T03:30:00Z").plusMillis(slack), TodayWidgetRules.nextRefresh(s, now))
        // 15:30: the weekly one and the timed task at 17:00 (the task turns overdue).
        assertEquals(Instant.parse("2026-10-14T08:00:00Z").plusMillis(slack), TodayWidgetRules.nextRefresh(s, Instant.parse("2026-10-14T06:30:00Z")))
        // 18:30: nothing more today but Trip's end (tomorrow 9:00) — midnight comes first.
        assertEquals(Instant.parse("2026-10-14T15:00:00Z").plusMillis(slack), TodayWidgetRules.nextRefresh(s, Instant.parse("2026-10-14T09:30:00Z")))
        // Nothing held: midnight.
        assertEquals(Instant.parse("2026-10-14T15:00:00Z").plusMillis(slack), TodayWidgetRules.nextRefresh(null, now))
        // Never sooner than a minute.
        val almost = Instant.parse("2026-10-14T03:29:50Z")
        assertEquals(almost.plusMillis(TodayWidgetRules.MIN_REFRESH_MS), TodayWidgetRules.nextRefresh(s, almost))
        // A new day reads the server; the same day only redraws.
        assertFalse(TodayWidgetRules.needsRead(s, today))
        assertTrue(TodayWidgetRules.needsRead(s, today.plusDays(1)))
        assertTrue(TodayWidgetRules.needsRead(null, today))
    }

    @Test
    fun todaysPlaces() {
        assertEquals("#lab", TodayWidgetRules.place("c", "lab"))
        assertNull(TodayWidgetRules.place(null, null))
        assertNull(TodayWidgetRules.place("dm", null))
        assertEquals(TodayEvent("x", "X", allDay = true, startDate = "2026-10-14"), TodayEvent.of(TodayEvent("x", "X", allDay = true, startDate = "2026-10-14").toOut()))
    }

    // --- deep links ---------------------------------------------------------------------------------

    @Test
    fun widgetLinksRoundTripThroughTheIntentsExtras() {
        val links = listOf(
            WidgetLink.Conversation(server, "c1"),
            WidgetLink.Event(server, "lab", "weekly@x", seriesId = "weekly", occurrenceStart = "2026-10-14T08:00:00Z", day = "2026-10-14"),
            WidgetLink.Event(null, null, "e1"),
            WidgetLink.Task(server, null, "t1"),
            WidgetLink.Task(server, "lab", "t2"),
            WidgetLink.Screen(server, WidgetScreen.HOME),
            WidgetLink.Screen(server, WidgetScreen.CALENDAR),
            WidgetLink.Screen(null, WidgetScreen.TASKS),
        )
        for (link in links) {
            val extras = WidgetLinks.extras(link)
            assertTrue(extras.keys.all { it in WidgetLinks.KEYS })
            assertEquals(link, WidgetLinks.parse { extras[it] })
        }
        // The ids ride in the notifications' own extras (MainActivity reads one set of names).
        val event = WidgetLinks.extras(links[1])
        assertEquals("weekly@x", event[Notifier.EXTRA_EVENT_ID])
        assertEquals("lab", event[Notifier.EXTRA_CHANNEL_ID])
        assertEquals(server, event[Notifier.EXTRA_WORKSPACE])
        // Not a widget's intent, or an incomplete one: nothing.
        assertNull(WidgetLinks.parse { mapOf(Notifier.EXTRA_CHANNEL_ID to "c1")[it] })
        assertNull(WidgetLinks.parse { mapOf(WidgetLinks.EXTRA_LINK to "task")[it] })
        assertNull(WidgetLinks.parse { mapOf(WidgetLinks.EXTRA_LINK to "screen", WidgetLinks.EXTRA_SCREEN to "nowhere")[it] })
    }
}
