package jp.chikuwachat.android

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.NotificationPreferenceOut
import jp.chikuwachat.android.api.ParentThread
import jp.chikuwachat.android.api.SearchOut
import jp.chikuwachat.android.api.TimesFeedOut
import jp.chikuwachat.android.api.PollOut
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.TimelineEvent
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
    private fun loaded(vararg rows: MessageOut) = first(TimesFeedOut(rows.toList(), null))
    private fun ids(state: TimesFeedState) = state.rows.map { it.id }
    private val look: (String) -> ChannelState? = { channels[it] }
    private fun first(page: TimesFeedOut, state: TimesFeedState = TimesFeedState()) = TimesFeed.firstPage(state, page, look, now)
    private fun next(state: TimesFeedState, page: TimesFeedOut) = TimesFeed.nextPage(state, page, look, now)
    private fun applied(state: TimesFeedState, event: String, m: MessageOut, thread: ParentThread?, channel: ChannelState?, now: Instant) =
        TimesFeed.applyEvent(state, TimelineEvent(event, m, thread), { channel }, now)
    private fun ev(state: TimesFeedState, event: String, m: MessageOut?, thread: ParentThread? = null) =
        TimesFeed.applyEvent(state, TimelineEvent(event, m, thread), look, now)

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
        val first = first(TimesFeedOut(listOf(message("05", "2026-10-02T10:05:00Z"), message("04", "2026-10-02T10:04:00Z")), "c1"))
        assertEquals("c1", first.nextCursor)
        // A row of the same instant lands on both pages (or a live one arrived meanwhile): once.
        val second = next(first, TimesFeedOut(listOf(message("04", "2026-10-02T10:04:00Z"), message("03", "2026-10-02T10:03:00Z")), null))
        assertEquals(listOf("05", "04", "03"), ids(second))
        assertNull(second.nextCursor)
        // The first page replaces everything, the rows of a longer list included.
        assertEquals(listOf("09"), ids(first(TimesFeedOut(listOf(message("09", "2026-10-02T11:00:00Z")), null))))
    }

    // --- live events (§5) ---

    @Test
    fun aCreatedFeedRowGoesInItsPlace() {
        val state = loaded(message("02", "2026-10-02T10:02:00Z"), message("01", "2026-10-02T10:01:00Z"))
        val next = applied(state, "message.created", message("03", "2026-10-02T10:03:00Z", channelId = "b"), null, channels["b"], now)
        assertEquals(listOf("03", "02", "01"), ids(next))
        // Twice (a duplicate event): once.
        assertEquals(ids(next), ids(applied(next, "message.created", message("03", "2026-10-02T10:03:00Z", channelId = "b"), null, channels["b"], now)))
    }

    @Test
    fun rowsThatAreNotFeedRowsStayOut() {
        val state = loaded(message("01", "2026-10-02T10:01:00Z"))
        val a = channels["a"]
        for (m in listOf(
            message("r", "2026-10-02T10:03:00Z", parentId = "01"), // thread only
            message("s", "2026-10-02T10:03:00Z", type = "system"), // joined / left
            message("d", "2026-10-02T10:03:00Z", deleted = true),
        )) assertSame(state, applied(state, "message.created", m, null, a, now))
        assertSame(state, applied(state, "message.created", message("x", "2026-10-02T10:03:00Z", channelId = "x"), null, channel("x", times = null), now))
        assertSame(state, applied(state, "message.created", message("m", "2026-10-02T10:03:00Z"), null, channel("a", level = "none"), now))
        // Before the first page there is nothing to keep (opening reads it).
        val unread = TimesFeedState()
        assertSame(unread, applied(unread, "message.created", message("m", "2026-10-02T10:03:00Z"), null, a, now))
    }

    @Test
    fun updatesReplaceHeldRowsAndDeletionsDropThem() {
        val state = loaded(message("02", "2026-10-02T10:02:00Z", seq = 2), message("01", "2026-10-02T10:01:00Z", seq = 1))
        val edited = applied(state, "message.updated", message("01", "2026-10-02T10:01:00Z", seq = 1, updatedSeq = 5, body = "edited"), null, channels["a"], now)
        assertEquals("edited", edited.rows[1].body)
        // An older version arriving late changes nothing.
        val stale = applied(edited, "message.updated", message("01", "2026-10-02T10:01:00Z", seq = 1, updatedSeq = 3, body = "older"), null, channels["a"], now)
        assertEquals("edited", stale.rows[1].body)
        // Not held: nothing.
        assertSame(edited, applied(edited, "message.updated", message("09", "2026-10-02T10:09:00Z"), null, channels["a"], now))
        val deleted = applied(edited, "message.deleted", message("02", "2026-10-02T10:02:00Z", seq = 2, updatedSeq = 6, deleted = true), null, channels["a"], now)
        assertEquals(listOf("01"), ids(deleted))
    }

    @Test
    fun aReplyMovesItsParentsCount() {
        val state = loaded(message("01", "2026-10-02T10:01:00Z", seq = 1))
        val reply = message("r", "2026-10-02T10:05:00Z", seq = 2, parentId = "01")
        val thread = ParentThread(id = "01", replyCount = 1, lastReplyAt = "2026-10-02T10:05:00Z", updatedSeq = 3, replyUserIds = listOf("u"))
        val next = applied(state, "message.created", reply, thread, channels["a"], now)
        assertEquals(listOf("01"), ids(next)) // the reply itself is not a row
        assertEquals(1, next.rows[0].replyCount)
        assertEquals(listOf("u"), next.rows[0].replyUserIds)
        // An older count does not win.
        val older = ParentThread(id = "01", replyCount = 0, updatedSeq = 2)
        assertEquals(1, applied(next, "message.deleted", reply.copy(deleted = true), older, channels["a"], now).rows[0].replyCount)
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

    // --- review v0.1.15 #2: every page is pruned against the times I still read ---

    @Test
    fun aPageReadBeforeLeavingATimesDoesNotBringItsRowsBack() {
        // The first page was asked for; meanwhile I left b (or was removed from a private times): the answer predates it.
        val left: (String) -> ChannelState? = { if (it == "b") channel("b", member = false) else channels[it] }
        val loading = TimesFeed.beginLoad(TimesFeedState())
        val page = TimesFeedOut(listOf(message("02", "2026-10-02T10:02:00Z", channelId = "b"), message("01", "2026-10-02T10:01:00Z"), message("00", "2026-10-02T10:00:00Z", channelId = "gone")), "c1")
        val firstState = TimesFeed.firstPage(loading, page, left, now)
        assertEquals(listOf("01"), ids(firstState))
        // The next page too, and a channel muted meanwhile.
        val muted: (String) -> ChannelState? = { if (it == "a") channel("a", level = "none") else left(it) }
        val more = TimesFeed.nextPage(TimesFeed.beginLoad(firstState), TimesFeedOut(listOf(message("-1", "2026-10-02T09:59:00Z", channelId = "b"), message("-2", "2026-10-02T09:58:00Z")), null), muted, now)
        assertEquals(listOf("01"), ids(more))
        assertEquals(0, more.loads)
    }

    // --- review v0.1.15 #3: events during a page read are applied again over its answer ---

    @Test
    fun eventsDuringTheFirstPageSurviveIt() {
        var state = TimesFeed.beginLoad(TimesFeedState())
        state = ev(state, "message.created", message("new", "2026-10-02T11:00:00Z", seq = 9))
        state = ev(state, "message.updated", message("01", "2026-10-02T10:01:00Z", seq = 1, updatedSeq = 7, body = "edited"))
        state = ev(state, "message.deleted", message("02", "2026-10-02T10:02:00Z", seq = 2, updatedSeq = 8, deleted = true))
        state = ev(state, "message.created", message("x", "2026-10-02T11:01:00Z", seq = 10))
        state = ev(state, "message.deleted", message("x", "2026-10-02T11:01:00Z", seq = 10, updatedSeq = 11, deleted = true))
        state = ev(state, "message.created", message("r", "2026-10-02T11:02:00Z", seq = 12, parentId = "03"), ParentThread(id = "03", replyCount = 1, updatedSeq = 12))
        assertFalse(state.loaded)
        // The page was read before all of them.
        val page = TimesFeedOut(listOf(message("02", "2026-10-02T10:02:00Z", seq = 2), message("01", "2026-10-02T10:01:00Z", seq = 1), message("03", "2026-10-02T10:00:00Z", seq = 3)), null)
        val done = first(page, state)
        assertEquals(listOf("new", "01", "03"), ids(done))
        assertEquals("edited", done.rows[1].body)
        assertEquals(1, done.rows[2].replyCount)
        assertEquals(0, done.loads)
        assertTrue(done.journal.isEmpty())
    }

    @Test
    fun aRefreshDoesNotUndoAnEditNorReviveADeletion() {
        val held = loaded(message("02", "2026-10-02T10:02:00Z", seq = 2), message("01", "2026-10-02T10:01:00Z", seq = 1))
        var state = TimesFeed.beginLoad(held)
        state = ev(state, "message.updated", message("01", "2026-10-02T10:01:00Z", seq = 1, updatedSeq = 5, body = "edited"))
        state = ev(state, "message.deleted", message("02", "2026-10-02T10:02:00Z", seq = 2, updatedSeq = 6, deleted = true))
        assertEquals(listOf("01"), ids(state)) // shown at once
        val done = first(TimesFeedOut(listOf(message("02", "2026-10-02T10:02:00Z", seq = 2), message("01", "2026-10-02T10:01:00Z", seq = 1, body = "old")), null), state)
        assertEquals(listOf("01"), ids(done))
        assertEquals("edited", done.rows.single().body)
    }

    @Test
    fun aRowDeletedOrEditedWhileTheNextPageIsReadStaysSo() {
        val held = first(TimesFeedOut(listOf(message("05", "2026-10-02T10:05:00Z", seq = 5)), "c1"))
        var state = TimesFeed.beginLoad(held)
        // Rows of the next page, not held yet: their events change nothing on screen but are kept.
        state = ev(state, "message.deleted", message("04", "2026-10-02T10:04:00Z", seq = 4, updatedSeq = 9, deleted = true))
        state = ev(state, "message.updated", message("03", "2026-10-02T10:03:00Z", seq = 3, updatedSeq = 8, body = "edited"))
        assertEquals(listOf("05"), ids(state))
        val done = next(state, TimesFeedOut(listOf(message("04", "2026-10-02T10:04:00Z", seq = 4), message("03", "2026-10-02T10:03:00Z", seq = 3, body = "old")), null))
        assertEquals(listOf("05", "03"), ids(done))
        assertEquals("edited", done.rows[1].body)
    }

    @Test
    fun theJournalLastsUntilTheLastLoadEnds() {
        var state = TimesFeed.beginLoad(TimesFeed.beginLoad(loaded(message("01", "2026-10-02T10:01:00Z"))))
        state = ev(state, "message.created", message("02", "2026-10-02T10:02:00Z", seq = 2))
        state = TimesFeed.endLoad(state) // a superseded read
        assertEquals(1, state.journal.size)
        val done = first(TimesFeedOut(listOf(message("01", "2026-10-02T10:01:00Z")), null), state)
        assertEquals(listOf("02", "01"), ids(done))
        assertTrue(done.journal.isEmpty())
        // No read on its way: nothing is kept.
        assertTrue(ev(done, "message.created", message("03", "2026-10-02T10:03:00Z", seq = 3)).journal.isEmpty())
        assertEquals(0, TimesFeed.endLoad(TimesFeedState()).loads)
    }

    // --- review v0.1.15 #4: rows the store takes otherwise (catch-up, my own actions) ---

    @Test
    fun aRowRecoveredByTheCatchUpOrMyOwnActionReachesTheFeed() {
        val state = first(TimesFeedOut(listOf(message("05", "2026-10-02T10:05:00Z", seq = 5), message("03", "2026-10-02T10:03:00Z", seq = 3)), "c1"))
        // A new row the delta brought after a lost event goes in its place.
        val recovered = ev(state, TimelineEvent.SYNCED, message("04", "2026-10-02T10:04:00Z", seq = 4))
        assertEquals(listOf("05", "04", "03"), ids(recovered))
        // The answer to my edit / reaction replaces the row (an older version does not).
        val edited = ev(recovered, TimelineEvent.SYNCED, message("03", "2026-10-02T10:03:00Z", seq = 3, updatedSeq = 6, body = "edited"))
        assertEquals("edited", edited.rows[2].body)
        assertEquals("edited", ev(edited, TimelineEvent.SYNCED, message("03", "2026-10-02T10:03:00Z", seq = 3, updatedSeq = 3, body = "old")).rows[2].body)
        // My delete's answer drops it.
        assertEquals(listOf("05", "04"), ids(ev(edited, TimelineEvent.SYNCED, message("03", "2026-10-02T10:03:00Z", seq = 3, updatedSeq = 7, deleted = true))))
        // An old row (a history page of a times) waits for its own page while there are pages to come; without, it goes in.
        assertSame(edited, ev(edited, TimelineEvent.SYNCED, message("01", "2026-10-02T10:01:00Z", seq = 1)))
        val all = first(TimesFeedOut(listOf(message("05", "2026-10-02T10:05:00Z", seq = 5)), null))
        assertEquals(listOf("05", "01"), ids(ev(all, TimelineEvent.SYNCED, message("01", "2026-10-02T10:01:00Z", seq = 1))))
        // A parent's counts from the store.
        assertEquals(2, ev(all, TimelineEvent.PARENT_THREAD, null, ParentThread(id = "05", replyCount = 2, updatedSeq = 9)).rows[0].replyCount)
    }

    // --- review v0.1.15 #10: per-viewer poll fields survive merges ---

    private fun poll(mine: List<Int>?, counts: List<Int> = listOf(1, 0), answers: List<String?>? = null, comment: String? = null) =
        PollOut(question = "q", options = listOf("x", "y"), anonymous = true, counts = counts, mine = mine, myAnswers = answers, myComment = comment)

    @Test
    fun myVoteSurvivesOthersEventsAndMyResponseGoesIn() {
        val row = message("01", "2026-10-02T10:01:00Z", seq = 1, updatedSeq = 4).copy(poll = poll(listOf(0)))
        val state = loaded(row)
        // Someone else voted: the event (newer, mine null) keeps my vote and takes the counts.
        val other = ev(state, "message.updated", row.copy(updatedSeq = 5, poll = poll(null, counts = listOf(1, 1))))
        assertEquals(listOf(0), other.rows[0].poll?.mine)
        assertEquals(listOf(1, 1), other.rows[0].poll?.counts)
        // My vote's answer, then its own event (same version, mine null): my vote stays.
        val voted = ev(other, TimelineEvent.MY_POLL, row.copy(updatedSeq = 6, poll = poll(listOf(1), counts = listOf(0, 2))))
        assertEquals(listOf(1), voted.rows[0].poll?.mine)
        assertEquals(listOf(1), ev(voted, "message.updated", row.copy(updatedSeq = 6, poll = poll(null, counts = listOf(0, 2)))).rows[0].poll?.mine)
        // The event first, my answer after it (same version): the answer's part goes in.
        val eventFirst = ev(other, "message.updated", row.copy(updatedSeq = 6, poll = poll(null, counts = listOf(0, 2))))
        assertEquals(listOf(0), eventFirst.rows[0].poll?.mine)
        assertEquals(listOf(1), ev(eventFirst, TimelineEvent.MY_POLL, row.copy(updatedSeq = 6, poll = poll(listOf(1), counts = listOf(0, 2)))).rows[0].poll?.mine)
        // Another member's newer event overtook my answer: the answer still puts my part in, the newer counts stay.
        val overtaken = ev(other, "message.updated", row.copy(updatedSeq = 8, poll = poll(null, counts = listOf(3, 3))))
        val late = ev(overtaken, TimelineEvent.MY_POLL, row.copy(updatedSeq = 7, poll = poll(listOf(1), counts = listOf(0, 2))))
        assertEquals(listOf(1), late.rows[0].poll?.mine)
        assertEquals(listOf(3, 3), late.rows[0].poll?.counts)
        // A scheduling poll's answers and comment the same way.
        val schedule = loaded(row.copy(poll = poll(null, answers = listOf("yes", null), comment = "c")))
        val after = ev(schedule, "message.updated", row.copy(updatedSeq = 5, poll = poll(null)))
        assertEquals(listOf("yes", null), after.rows[0].poll?.myAnswers)
        assertEquals("c", after.rows[0].poll?.myComment)
    }

    // --- review v0.1.15 #8 / #13: what a row and its thread open ---

    @Test
    fun aReplyAlsoInTheChannelOpensAsTheChannelsRowAndItsParentsThread() {
        val top = message("01", "2026-10-02T10:01:00Z")
        assertSame(top, TimesFeed.revealTarget(top))
        assertEquals("01", TimesFeed.threadOf(top))
        val shared = message("r", "2026-10-02T10:02:00Z", parentId = "p", alsoInChannel = true)
        assertNull(TimesFeed.revealTarget(shared).parentId)
        assertEquals("r", TimesFeed.revealTarget(shared).id)
        assertEquals("p", TimesFeed.threadOf(shared))
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
