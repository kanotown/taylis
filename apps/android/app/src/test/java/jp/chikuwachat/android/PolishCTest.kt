package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.ParentThread
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.NotificationLevels
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.toOut
import jp.chikuwachat.android.ui.ChannelDetailsHeader
import jp.chikuwachat.android.ui.ConversationTab
import jp.chikuwachat.android.ui.MainNav
import jp.chikuwachat.android.ui.Route
import jp.chikuwachat.android.ui.Search
import jp.chikuwachat.android.ui.SearchParams
import jp.chikuwachat.android.ui.DetailsButton
import jp.chikuwachat.android.ui.EmojiData
import jp.chikuwachat.android.ui.EmojiPicker
import jp.chikuwachat.android.ui.QuickReactions
import jp.chikuwachat.android.ui.Timeline
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

/** 仕上げ C (MOBILE_POLISH.md C3, D1, C9 / C10): the Android parts that are not layout. */
class PolishCTest {
    private val tokyo = ZoneId.of("Asia/Tokyo")
    private val now = ZonedDateTime.of(2026, 9, 30, 18, 0, 0, 0, tokyo)

    private fun parent(replyUserIds: List<String> = emptyList(), updatedSeq: Int = 5) = MessageOut(
        id = "p1", channelId = "c1", senderId = "u1", seq = 1, updatedSeq = updatedSeq, body = "親", replyCount = 2,
        lastReplyAt = "2026-09-30T05:00:00Z", replyUserIds = replyUserIds, createdAt = "2026-09-30T01:00:00Z", deleted = false,
    )

    // --- C3: 「N 件の返信」's line ---

    @Test
    fun lastReplyLabelSaysTheDayAndTheTimeAsTheWebDoes() {
        assertEquals("最終返信 今日 14:05", Timeline.lastReplyLabel("2026-09-30T05:05:00Z", now))
        assertEquals("最終返信 昨日 09:05", Timeline.lastReplyLabel("2026-09-29T00:05:00Z", now))
        assertEquals("最終返信 9月26日 (土) 14:05", Timeline.lastReplyLabel("2026-09-26T05:05:00Z", now))
        assertEquals("最終返信 2025年12月31日 (水) 14:05", Timeline.lastReplyLabel("2025-12-31T05:05:00Z", now))
        assertEquals("", Timeline.lastReplyLabel("not a time", now))
    }

    @Test
    fun atMostThreeRepliersAreShownMostRecentFirst() {
        assertEquals(listOf("u3", "u2", "u1"), Timeline.replierAvatars(listOf("u3", "u2", "u1", "u4", "u5")))
        assertEquals(listOf("u2"), Timeline.replierAvatars(listOf("u2", "u2")))
        assertEquals(emptyList<String>(), Timeline.replierAvatars(emptyList()))
    }

    @Test
    fun repliersDecodeAndAMissingListIsEmpty() {
        val json = """{"id":"p1","channel_id":"c1","sender_id":"u1","seq":1,"updated_seq":5,"body":"x","created_at":"2026-09-30T01:00:00Z","deleted":false,"reply_count":2,"reply_user_ids":["u3","u2"]}"""
        assertEquals(listOf("u3", "u2"), Codec.snake.decodeFromString(MessageOut.serializer(), json).replyUserIds)
        val older = """{"id":"p1","channel_id":"c1","sender_id":"u1","seq":1,"updated_seq":5,"body":"x","created_at":"2026-09-30T01:00:00Z","deleted":false}"""
        assertEquals(emptyList<String>(), Codec.snake.decodeFromString(MessageOut.serializer(), older).replyUserIds)
        // parent_thread from an older server: null (the parent keeps its list), not empty.
        val thread = """{"id":"p1","reply_count":3,"updated_seq":6}"""
        assertEquals(null, Codec.snake.decodeFromString(ParentThread.serializer(), thread).replyUserIds)
    }

    @Test
    fun aRowStoredBeforeTheFieldStillLoads() {
        // Room keeps MessageState as JSON (RoomPersistence); a row written before C3 has no replyUserIds.
        val stored = Codec.plain.encodeToString(MessageState.serializer(), MessageState.from(parent()))
            .replace(Regex(""","replyUserIds":\[[^\]]*]"""), "")
        assertTrue("replyUserIds" !in stored)
        val loaded = Codec.plain.decodeFromString(MessageState.serializer(), stored)
        assertEquals(emptyList<String>(), loaded.replyUserIds)
        assertEquals(2, loaded.replyCount)
        // …and a row with the list keeps it, through the server shape too.
        val withList = MessageState.from(parent(listOf("u3", "u2")))
        assertEquals(withList, Codec.plain.decodeFromString(MessageState.serializer(), Codec.plain.encodeToString(MessageState.serializer(), withList)))
        assertEquals(listOf("u3", "u2"), withList.toOut()?.replyUserIds)
    }

    @Test
    fun parentThreadTakesTheNewListAndKeepsTheOldOneWhenMissing() {
        val store = Store()
        store.upsertMessage(parent(listOf("u2", "u1")))
        store.applyParentThread("c1", ParentThread(id = "p1", replyCount = 3, lastReplyAt = "2026-09-30T06:00:00Z", updatedSeq = 6, replyUserIds = listOf("u3", "u2", "u1")))
        store.message("c1", "p1")!!.let {
            assertEquals(listOf("u3", "u2", "u1"), it.replyUserIds)
            assertEquals(3, it.replyCount)
        }
        // An older server's parent_thread: the counters move, the repliers stay.
        store.applyParentThread("c1", ParentThread(id = "p1", replyCount = 4, updatedSeq = 7))
        store.message("c1", "p1")!!.let {
            assertEquals(listOf("u3", "u2", "u1"), it.replyUserIds)
            assertEquals(4, it.replyCount)
        }
        // A deleted reply's recount can empty it.
        store.applyParentThread("c1", ParentThread(id = "p1", replyCount = 0, updatedSeq = 8, replyUserIds = emptyList()))
        assertEquals(emptyList<String>(), store.message("c1", "p1")!!.replyUserIds)
        // A stale event (older updated_seq) changes nothing.
        store.applyParentThread("c1", ParentThread(id = "p1", replyCount = 9, updatedSeq = 7, replyUserIds = listOf("u9")))
        assertEquals(emptyList<String>(), store.message("c1", "p1")!!.replyUserIds)
        // message.updated brings the whole MessageOut, list included.
        store.upsertMessage(parent(listOf("u5"), updatedSeq = 9))
        assertEquals(listOf("u5"), store.message("c1", "p1")!!.replyUserIds)
    }

    @Test
    fun theSameVersionFromTheServerFillsTheRepliersOfARowStoredBefore() {
        // Migration 0049 filled the lists without moving updated_seq: a page or GET /messages/{id} of the same version
        // must still bring them in.
        val store = Store()
        store.upsertMessage(parent())
        assertEquals(emptyList<String>(), store.message("c1", "p1")!!.replyUserIds)
        store.upsertMessage(parent(listOf("u3", "u2")))
        assertEquals(listOf("u3", "u2"), store.message("c1", "p1")!!.replyUserIds)
        // An empty list at the same version (an older server) does not clear it; an older version changes nothing.
        store.upsertMessage(parent())
        assertEquals(listOf("u3", "u2"), store.message("c1", "p1")!!.replyUserIds)
        store.upsertMessage(parent(listOf("u9"), updatedSeq = 4))
        assertEquals(listOf("u3", "u2"), store.message("c1", "p1")!!.replyUserIds)
    }

    // --- D1: the details page's header ---

    @Test
    fun detailsButtonsFollowWhatTheConversationAllows() {
        val all = listOf(DetailsButton.FAVORITE, DetailsButton.NOTIFICATIONS, DetailsButton.SEARCH, DetailsButton.ADD_MEMBER)
        assertEquals(all, ChannelDetailsHeader.buttons(isChannel = true, isMember = true, archived = false))
        assertEquals(all - DetailsButton.ADD_MEMBER, ChannelDetailsHeader.buttons(isChannel = true, isMember = true, archived = true))
        assertEquals(all - DetailsButton.ADD_MEMBER, ChannelDetailsHeader.buttons(isChannel = false, isMember = true, archived = false))
        assertEquals(listOf(DetailsButton.SEARCH), ChannelDetailsHeader.buttons(isChannel = true, isMember = false, archived = false))
    }

    @Test
    fun theNotificationRowShowsTheCurrentSetting() {
        assertEquals("メンションのみ", ChannelDetailsHeader.notificationSummary(NotificationLevels.MENTIONS, mutedOn = false, timedMute = null))
        assertEquals("すべて", ChannelDetailsHeader.notificationSummary(NotificationLevels.ALL, mutedOn = false, timedMute = null))
        assertEquals("通知しない", ChannelDetailsHeader.notificationSummary(NotificationLevels.NONE, mutedOn = false, timedMute = null))
        assertEquals("18:00 までミュート", ChannelDetailsHeader.notificationSummary(NotificationLevels.ALL, mutedOn = false, timedMute = "18:00 までミュート"))
        assertEquals("ミュート中", ChannelDetailsHeader.notificationSummary(NotificationLevels.ALL, mutedOn = true, timedMute = "18:00 までミュート"))
        assertEquals("メンバー 12 人", ChannelDetailsHeader.memberLine(12))
        assertEquals("", ChannelDetailsHeader.memberLine(null))
    }

    @Test
    fun theSearchButtonSearchesTheConversationAndBackReturnsToTheDetails() {
        val details = listOf(Route.ChannelList, Route.Channel("c1", ConversationTab.MESSAGES, detailsOpen = true))
        val params = SearchParams(channelId = "c1", sort = Search.NEWEST)
        // What the details page's 「検索」 does: open the search, then run it (runSearch alone needs a search on top).
        val searching = MainNav.runSearch(MainNav.openSearch(details), params)
        assertEquals(Route.Search(params = params, expanded = false), searching.last())
        assertEquals(details, MainNav.back(searching))
    }

    // --- C9 / C10: the emoji sheet ---

    @Test
    fun frequentComesFirstFromThisDevicesRecentEmoji() {
        val prefs = MemoryStore()
        QuickReactions.remember(prefs, "🎉")
        QuickReactions.remember(prefs, ":hanpen:")
        QuickReactions.remember(prefs, "👍")
        QuickReactions.remember(prefs, "🎉")
        val sections = EmojiPicker.sections(QuickReactions.read(prefs), customNames = listOf("hanpen"))
        assertEquals(EmojiPicker.FREQUENT, sections.first().key)
        assertEquals("よく使う", sections.first().label)
        assertEquals(listOf("🎉", "👍", ":hanpen:"), sections.first().cells)
        assertEquals(EmojiData.categories.map { it.first }, sections.drop(1).dropLast(1).map { it.key })
        assertEquals(EmojiPicker.CUSTOM, sections.last().key)
        assertEquals(listOf(":hanpen:"), sections.last().cells)
    }

    @Test
    fun withNothingUsedTheSheetStartsAtTheFirstCategory() {
        val sections = EmojiPicker.sections(emptyList(), customNames = emptyList())
        assertEquals(EmojiData.categories.map { it.first }, sections.map { it.key })
        assertEquals(EmojiData.all.size, sections.sumOf { it.cells.size })
    }

    @Test
    fun aRemovedCustomEmojiLeavesFrequentAndTheListIsCapped() {
        assertEquals(listOf("👍"), EmojiPicker.frequent(listOf(":gone:", "👍", ""), customNames = emptySet()))
        val many = (0 until 30).map { "e$it" }
        assertEquals(EmojiPicker.FREQUENT_MAX, EmojiPicker.frequent(many, emptySet()).size)
    }

    @Test
    fun searchListsCustomThenStandardEmoji() {
        val hits = EmojiPicker.search("tada", customNames = listOf("tada-cat", "hanpen"))
        assertEquals(":tada-cat:", hits.first())
        assertTrue("🎉" in hits)
        assertTrue(":hanpen:" !in hits)
        assertEquals(emptyList<String>(), EmojiPicker.search("  ", listOf("hanpen")))
        assertEquals("😄", EmojiPicker.tabGlyph("smileys"))
    }
}
