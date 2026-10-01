package jp.chikuwachat.android

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.NotificationPreferenceOut
import jp.chikuwachat.android.api.ParentThread
import jp.chikuwachat.android.api.SearchOut
import jp.chikuwachat.android.api.TimesFeedOut
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.ui.BarMenu
import jp.chikuwachat.android.ui.BarMenuItem
import jp.chikuwachat.android.ui.Search
import jp.chikuwachat.android.ui.SearchParams
import jp.chikuwachat.android.ui.Suggestion
import jp.chikuwachat.android.ui.TimesFeed
import jp.chikuwachat.android.ui.TimesFeedState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** L8 (docs/TIMES_FEED.md §2, §4, §5, §6): the Times feed's rows and the search's `is:times`. */
class TimesFeedTest {
    private val now: Instant = Instant.parse("2026-10-02T12:00:00Z")
    private val me = "me"

    private fun channel(
        id: String, times: String? = "owner-$id", member: Boolean = true, level: String? = null, mutedUntil: String? = null,
        muted: Boolean = false, lastRead: Int = 0, archived: Boolean = false,
    ) = ChannelState(
        channel = ChannelOut(
            id = id, type = "public", name = "times-$id", archived = archived, lastSeq = 0, createdAt = "", updatedAt = "",
            notification = if (level == null && mutedUntil == null && !muted) null
            else NotificationPreferenceOut(id, level ?: "none", mutedUntil, followsDefault = level == null, muted = muted),
            timesOwnerId = times,
        ),
        isMember = member,
        lastReadSeq = lastRead,
    )

    private fun message(
        id: String, at: String, channelId: String = "a", seq: Int = 1, updatedSeq: Int = seq, parentId: String? = null,
        alsoInChannel: Boolean = false, type: String = "user", deleted: Boolean = false, body: String = id,
    ) = MessageOut(
        id = id, channelId = channelId, senderId = "u", seq = seq, updatedSeq = updatedSeq, parentId = parentId,
        alsoInChannel = alsoInChannel, type = type, body = body, createdAt = at, deleted = deleted,
    )

    private val channels = mapOf("a" to channel("a"), "b" to channel("b"))
    private fun loaded(vararg rows: MessageOut) = TimesFeed.firstPage(TimesFeedOut(rows.toList(), null))
    private fun ids(state: TimesFeedState) = state.rows.map { it.id }

    // --- §2 / §5 isFeedRow ---

    @Test
    fun feedRowsAreLiveUserTimelineRowsOfUnmutedTimesIAmIn() {
        val a = channel("a")
        assertTrue(TimesFeed.isFeedRow(message("m", "2026-10-02T10:00:00Z"), a, now))
        // A reply also sent to the channel is in the timeline; one only in its thread is not.
        assertTrue(TimesFeed.isFeedRow(message("r", "2026-10-02T10:00:00Z", parentId = "m", alsoInChannel = true), a, now))
        assertFalse(TimesFeed.isFeedRow(message("r", "2026-10-02T10:00:00Z", parentId = "m"), a, now))
        assertFalse(TimesFeed.isFeedRow(message("s", "2026-10-02T10:00:00Z", type = "system"), a, now))
        assertFalse(TimesFeed.isFeedRow(message("d", "2026-10-02T10:00:00Z", deleted = true), a, now))
        // Not a times, not a member, unknown.
        assertFalse(TimesFeed.isFeedRow(message("m", "2026-10-02T10:00:00Z"), channel("a", times = null), now))
        assertFalse(TimesFeed.isFeedRow(message("m", "2026-10-02T10:00:00Z"), channel("a", member = false), now))
        assertFalse(TimesFeed.isFeedRow(message("m", "2026-10-02T10:00:00Z"), null, now))
        // Muted three ways (§10.5): level none, muted until unmuted, a timed mute still running; one that ran out is not.
        assertFalse(TimesFeed.isFeedChannel(channel("a", level = "none"), now))
        assertFalse(TimesFeed.isFeedChannel(channel("a", level = "mentions", muted = true), now))
        assertFalse(TimesFeed.isFeedChannel(channel("a", level = "mentions", mutedUntil = "2026-10-02T13:00:00Z"), now))
        assertTrue(TimesFeed.isFeedChannel(channel("a", level = "mentions", mutedUntil = "2026-10-02T11:00:00Z"), now))
        // Archived and my own times are in.
        assertTrue(TimesFeed.isFeedChannel(channel("a", archived = true), now))
        assertTrue(TimesFeed.isFeedChannel(channel("a", times = me), now))
    }

    // --- order and paging ---

    @Test
    fun newestFirstByCreatedAtThenId() {
        val state = loaded(
            message("01", "2026-10-02T09:00:00Z"),
            message("03", "2026-10-02T10:00:00.5Z"),
            message("02", "2026-10-02T10:00:00.5Z", channelId = "b"),
            message("04", "2026-10-02T10:00:00+09:00"), // 01:00Z: the oldest, whatever the string says
        )
        assertEquals(listOf("03", "02", "01", "04"), ids(state))
        assertTrue(state.loaded)
        assertNull(state.nextCursor)
    }

    @Test
    fun pagesAddOnlyWhatIsNotHeld() {
        val first = TimesFeed.firstPage(TimesFeedOut(listOf(message("05", "2026-10-02T10:05:00Z"), message("04", "2026-10-02T10:04:00Z")), "c1"))
        assertEquals("c1", first.nextCursor)
        // A row of the same instant lands on both pages (or a live one arrived meanwhile): once.
        val second = TimesFeed.nextPage(first, TimesFeedOut(listOf(message("04", "2026-10-02T10:04:00Z"), message("03", "2026-10-02T10:03:00Z")), null))
        assertEquals(listOf("05", "04", "03"), ids(second))
        assertNull(second.nextCursor)
        // The first page replaces everything, the rows of a longer list included.
        assertEquals(listOf("09"), ids(TimesFeed.firstPage(TimesFeedOut(listOf(message("09", "2026-10-02T11:00:00Z")), null))))
    }

    // --- live events (§5) ---

    @Test
    fun aCreatedFeedRowGoesInItsPlace() {
        val state = loaded(message("02", "2026-10-02T10:02:00Z"), message("01", "2026-10-02T10:01:00Z"))
        val next = TimesFeed.applyEvent(state, "message.created", message("03", "2026-10-02T10:03:00Z", channelId = "b"), null, channels["b"], now)
        assertEquals(listOf("03", "02", "01"), ids(next))
        // Twice (a duplicate event): once.
        assertEquals(ids(next), ids(TimesFeed.applyEvent(next, "message.created", message("03", "2026-10-02T10:03:00Z", channelId = "b"), null, channels["b"], now)))
    }

    @Test
    fun rowsThatAreNotFeedRowsStayOut() {
        val state = loaded(message("01", "2026-10-02T10:01:00Z"))
        val a = channels["a"]
        for (m in listOf(
            message("r", "2026-10-02T10:03:00Z", parentId = "01"), // thread only
            message("s", "2026-10-02T10:03:00Z", type = "system"), // joined / left
            message("d", "2026-10-02T10:03:00Z", deleted = true),
        )) assertSame(state, TimesFeed.applyEvent(state, "message.created", m, null, a, now))
        assertSame(state, TimesFeed.applyEvent(state, "message.created", message("x", "2026-10-02T10:03:00Z", channelId = "x"), null, channel("x", times = null), now))
        assertSame(state, TimesFeed.applyEvent(state, "message.created", message("m", "2026-10-02T10:03:00Z"), null, channel("a", level = "none"), now))
        // Before the first page there is nothing to keep (opening reads it).
        val unread = TimesFeedState()
        assertSame(unread, TimesFeed.applyEvent(unread, "message.created", message("m", "2026-10-02T10:03:00Z"), null, a, now))
    }

    @Test
    fun updatesReplaceHeldRowsAndDeletionsDropThem() {
        val state = loaded(message("02", "2026-10-02T10:02:00Z", seq = 2), message("01", "2026-10-02T10:01:00Z", seq = 1))
        val edited = TimesFeed.applyEvent(state, "message.updated", message("01", "2026-10-02T10:01:00Z", seq = 1, updatedSeq = 5, body = "edited"), null, channels["a"], now)
        assertEquals("edited", edited.rows[1].body)
        // An older version arriving late changes nothing.
        val stale = TimesFeed.applyEvent(edited, "message.updated", message("01", "2026-10-02T10:01:00Z", seq = 1, updatedSeq = 3, body = "older"), null, channels["a"], now)
        assertEquals("edited", stale.rows[1].body)
        // Not held: nothing.
        assertSame(edited, TimesFeed.applyEvent(edited, "message.updated", message("09", "2026-10-02T10:09:00Z"), null, channels["a"], now))
        val deleted = TimesFeed.applyEvent(edited, "message.deleted", message("02", "2026-10-02T10:02:00Z", seq = 2, updatedSeq = 6, deleted = true), null, channels["a"], now)
        assertEquals(listOf("01"), ids(deleted))
    }

    @Test
    fun aReplyMovesItsParentsCount() {
        val state = loaded(message("01", "2026-10-02T10:01:00Z", seq = 1))
        val reply = message("r", "2026-10-02T10:05:00Z", seq = 2, parentId = "01")
        val thread = ParentThread(id = "01", replyCount = 1, lastReplyAt = "2026-10-02T10:05:00Z", updatedSeq = 3, replyUserIds = listOf("u"))
        val next = TimesFeed.applyEvent(state, "message.created", reply, thread, channels["a"], now)
        assertEquals(listOf("01"), ids(next)) // the reply itself is not a row
        assertEquals(1, next.rows[0].replyCount)
        assertEquals(listOf("u"), next.rows[0].replyUserIds)
        // An older count does not win.
        val older = ParentThread(id = "01", replyCount = 0, updatedSeq = 2)
        assertEquals(1, TimesFeed.applyEvent(next, "message.deleted", reply.copy(deleted = true), older, channels["a"], now).rows[0].replyCount)
    }

    @Test
    fun leavingOrMutingATimesTakesItsRows() {
        val state = loaded(message("02", "2026-10-02T10:02:00Z", channelId = "b"), message("01", "2026-10-02T10:01:00Z"))
        assertSame(state, TimesFeed.pruned(state, { channels[it] }, now))
        val muted = mapOf("a" to channel("a"), "b" to channel("b", level = "none"))
        assertEquals(listOf("01"), ids(TimesFeed.pruned(state, { muted[it] }, now)))
        assertEquals(listOf("02"), ids(TimesFeed.pruned(state, { if (it == "a") null else channels[it] }, now)))
        assertEquals(listOf("02"), ids(TimesFeed.pruned(state, { if (it == "a") channel("a", member = false) else channels[it] }, now)))
    }

    // --- §4: the 「新しい」 dot, and the menu ---

    @Test
    fun theDotMarksRowsAfterTheReadPosition() {
        val a = channel("a", lastRead = 5)
        assertTrue(TimesFeed.isNew(message("m", "2026-10-02T10:00:00Z", seq = 6), a))
        assertFalse(TimesFeed.isNew(message("m", "2026-10-02T10:00:00Z", seq = 5), a))
        // A read mark not confirmed yet counts already.
        assertFalse(TimesFeed.isNew(message("m", "2026-10-02T10:00:00Z", seq = 6), a.copy(unsentReadSeq = 7)))
        assertFalse(TimesFeed.isNew(message("m", "2026-10-02T10:00:00Z", seq = 6), null))
    }

    @Test
    fun myTimesAndTheFeedsMenu() {
        val mine = channel("mine", times = me)
        assertEquals("mine", TimesFeed.myTimes(listOf(channel("a"), mine), me)?.id)
        assertNull(TimesFeed.myTimes(listOf(channel("a")), me))
        assertNull(TimesFeed.myTimes(listOf(mine.copy(isMember = false)), me))
        assertEquals(
            listOf(BarMenuItem.READ_ALL_TIMES, BarMenuItem.MY_TIMES),
            BarMenu.items(conversation = false, channel = false, archived = false, activityFeed = false, timesFeed = true, myTimes = true),
        )
        assertEquals(
            listOf(BarMenuItem.READ_ALL_TIMES),
            BarMenu.items(conversation = false, channel = false, archived = false, activityFeed = false, timesFeed = true, myTimes = false),
        )
    }

    // --- §6 search ---

    @Test
    fun isTimesIsAFilterAndASuggestion() {
        val params = SearchParams(isTimes = true)
        assertTrue(Search.hasFilters(params))
        assertFalse(Search.isEmpty(params))
        assertTrue(Search.toQuery(params).isTimes)
        assertEquals("newest", Search.toQuery(params).sort)
        assertEquals("実験 · Times", Search.describe(params.copy(q = "実験"), { null }, { null }))
        assertEquals(SearchParams(q = "実験"), Search.cleared(params.copy(q = "実験")))
        val empty = Search.suggestions("", emptyList(), emptyList(), emptyList()) { "" }
        assertEquals(Suggestion.Times, empty.last())
        assertEquals(SearchParams(isTimes = true, sort = Search.NEWEST), Suggestion.Times.toParams())
    }

    @Test
    fun searchAnswersNameChannelsIAmNotIn() {
        val text = """{"hits":[],"keywords":[],"filters":{"text":"","is_times":true},"limit":20,"offset":0,"has_more":false,
            "channels":[{"id":"t1","type":"public","name":"times-sato","archived":true,"last_seq":3,"created_at":"x","updated_at":"x","times_owner_id":"sato"}]}"""
        val out = Codec.snake.decodeFromString(SearchOut.serializer(), text)
        assertTrue(out.filters!!.isTimes)
        assertEquals("times-sato", out.channels.single().name)
        // An older server sends neither.
        val old = Codec.snake.decodeFromString(SearchOut.serializer(), """{"hits":[],"filters":{"text":""},"limit":20,"offset":0,"has_more":false}""")
        assertTrue(old.channels.isEmpty())
        assertFalse(old.filters!!.isTimes)
        val feed = Codec.snake.decodeFromString(TimesFeedOut.serializer(), """{"items":[],"next_cursor":"2026-10-02T10:00:00Z_0199"}""")
        assertEquals("2026-10-02T10:00:00Z_0199", feed.nextCursor)
    }
}
