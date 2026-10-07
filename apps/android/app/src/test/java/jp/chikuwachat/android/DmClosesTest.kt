package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.SidebarSectionOut
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.DmCloses
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.BarMenu
import jp.chikuwachat.android.ui.BarMenuItem
import jp.chikuwachat.android.ui.Channels
import jp.chikuwachat.android.ui.MainTabs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** M141 「会話を閉じる」 (SYNC_PROTOCOL.md §7.9): what the lists hide, the optimistic close, and what opens it again. */
class DmClosesTest {
    private fun dm(id: String, last: String, users: List<String> = listOf("me", id), type: String = "dm") = ChannelState(
        ChannelOut(id = id, type = type, archived = false, lastSeq = 1, createdAt = "2026-01-01T00:00:00Z", updatedAt = "t", lastMessageAt = last, dmUserIds = users),
        isMember = true,
    )

    private fun channel(id: String, name: String) = ChannelState(
        ChannelOut(id = id, type = "public", name = name, archived = false, lastSeq = 1, createdAt = "t", updatedAt = "t"),
        isMember = true,
    )

    private val self = dm("self", "2026-10-01T00:00:00Z", listOf("me"))
    private val a = dm("a", "2026-10-05T00:00:00Z")
    private val b = dm("b", "2026-10-04T00:00:00Z")
    private val g = dm("g", "2026-10-02T00:00:00Z", listOf("me", "x", "y"), type = "group_dm")
    private val ch = channel("ch", "general")
    private val all = listOf(self, a, b, g, ch)
    private fun title(row: ChannelState) = row.channel.name ?: row.id

    @Test fun theDmListsHideClosedConversations() {
        assertEquals(listOf("self", "a", "b", "g"), MainTabs.dmList(all, ::title, "me").map { it.id })
        assertEquals(listOf("a", "g"), MainTabs.dmList(all, ::title, "me", closedDms = setOf("self", "b")).map { it.id })
        // A pinned one that is closed is not listed either (closing unpins, but an event may come first).
        assertEquals(listOf("a", "g"), MainTabs.dmList(all, ::title, "me", dmPins = listOf("b"), closedDms = setOf("self", "b")).map { it.id })

        val home = Channels.sections(all, meId = "me", title = ::title, closedDms = setOf("a", "ch"))
        assertEquals(listOf("self", "b", "g"), home.dms.map { it.id })
        assertEquals(listOf("ch"), home.channels.map { it.id }) // a channel id in the set is never hidden
        // The favourites and my own sections hide them too.
        val section = SidebarSectionOut("s1", "研究", 0, channelIds = listOf("a", "b"), sort = "name")
        val placed = Channels.sections(all, meId = "me", sidebar = listOf(section), favorites = setOf("g", "self"), title = ::title, closedDms = setOf("b", "g"))
        assertEquals(listOf("a"), placed.custom.single().second.map { it.id })
        assertEquals(listOf("self"), placed.favorites.map { it.id })
        assertTrue(placed.dms.isEmpty())
    }

    @Test fun myOwnClosedDmLeavesNoPlaceholder() {
        // The placeholder stands for my own DM before it exists; closed, it exists (only hidden).
        assertFalse(MainTabs.showsSelfNotesPlaceholder(all, "me", "わたし"))
        assertFalse(MainTabs.showsSelfNotesInDmSection(all, "me", "わたし"))
        assertTrue(MainTabs.showsSelfNotesPlaceholder(all - self, "me", "わたし"))
    }

    @Test fun theCloseActionNeedsAServerThatClosesAndADm() {
        val store = Store()
        store.upsertChannel(a.channel, isMember = true)
        store.upsertChannel(ch.channel, isMember = true)
        assertFalse(DmCloses.canClose(store, store.channel("a"))) // a server before M141
        store.replaceClosedDms(emptyList())
        assertTrue(DmCloses.canClose(store, store.channel("a")))
        assertFalse(DmCloses.canClose(store, store.channel("ch")))
        assertTrue(BarMenuItem.CLOSE_DM in BarMenu.items(conversation = true, channel = false, archived = false, activityFeed = false, closeDm = true))
        assertFalse(BarMenuItem.CLOSE_DM in BarMenu.items(conversation = true, channel = false, archived = false, activityFeed = false, closeDm = false))
        assertFalse(BarMenuItem.CLOSE_DM in BarMenu.items(conversation = true, channel = true, archived = false, activityFeed = false, closeDm = true))
    }

    private fun storeWithUnreadPinnedDm(): Store {
        val store = Store()
        store.replaceClosedDms(emptyList())
        store.upsertChannel(a.channel.copy(lastSeq = 7), isMember = true)
        store.updateChannel("a") { it.copy(lastSeq = 7, lastReadSeq = 3, unreadCount = 4, mentionCount = 1, firstUnreadAt = "2026-10-05T00:00:00Z") }
        store.replaceDmPins(listOf("b", "a"))
        return store
    }

    @Test fun closingIsOptimistic() = runBlocking {
        val store = storeWithUnreadPinnedDm()
        var calls = 0
        val closed = DmCloses.close(store, "a", readState = { fail("asked only after a refusal"); throw IllegalStateException() }) {
            calls++
            // Before the answer: hidden, unpinned and read.
            assertTrue(store.isDmClosed("a"))
            assertFalse(store.isDmPinned("a"))
            assertEquals(0, store.channel("a")!!.unreadCount)
        }
        assertEquals(1, calls)
        assertNotNull(closed)
        assertTrue(closed!!.wasPinned)
        val row = store.channel("a")!!
        assertEquals(7, row.lastReadSeq)
        assertEquals(0, row.mentionCount)
        assertEquals(listOf("b"), store.dmPins)
    }

    @Test fun aRefusedCloseIsRolledBack() = runBlocking {
        val store = storeWithUnreadPinnedDm()
        try {
            // The read state cannot be asked either (as unreachable as the close): nothing changed it, so the snapshot.
            DmCloses.close(store, "a", readState = { throw ApiException.Network(java.io.IOException("offline")) }) { throw ApiException.Api(409, "dm_close_not_dm", "no") }
            fail("the refusal is passed on")
        } catch (e: ApiException.Api) {
            assertEquals("dm_close_not_dm", e.code)
        }
        assertFalse(store.isDmClosed("a"))
        assertEquals(listOf("b", "a"), store.dmPins) // back in its place
        val row = store.channel("a")!!
        assertEquals(3, row.lastReadSeq)
        assertEquals(4, row.unreadCount)
        assertEquals(1, row.mentionCount)
        assertEquals("2026-10-05T00:00:00Z", row.firstUnreadAt)
    }

    @Test fun anExplicitOpenCallsDeleteOnlyWhenClosed() = runBlocking {
        val store = Store()
        store.replaceClosedDms(listOf("a"))
        var deletes = 0
        assertFalse(DmCloses.reopen(store, "b") { deletes++ })
        assertEquals(0, deletes)
        assertTrue(DmCloses.reopen(store, "a") { assertFalse(store.isDmClosed("a")); deletes++ })
        assertEquals(1, deletes)
        assertFalse(store.isDmClosed("a"))
        // A failed DELETE leaves it open here (the next bootstrap closes it again).
        store.setDmClosed("a", true)
        runCatching { DmCloses.reopen(store, "a") { throw ApiException.Api(500, "internal", "x") } }
        assertFalse(store.isDmClosed("a"))
    }

    @Test fun theStoreFollowsBootstrap() {
        val store = Store()
        assertFalse(store.closedDmsKnown)
        store.replaceClosedDms(listOf("a", "b"))
        assertTrue(store.closedDmsKnown)
        store.setDmClosed("a", false)
        store.setDmClosed("c", true)
        assertEquals(setOf("b", "c"), store.closedDms)
        store.replaceClosedDms(null) // a server before M141
        assertFalse(store.closedDmsKnown)
        assertTrue(store.closedDms.isEmpty())
    }

    private suspend fun settle(engine: SyncEngine) { repeat(20) { engine.idle(); yield() } }

    @Test fun eventsAndNewMessagesOpenItAgain() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        val conversation = server.createChannel("", alice.id, type = "dm")
        server.join(conversation.id, bob.id)
        val (topic, _) = server.post(conversation.id, alice.id, "topic")
        server.closedDms = hashMapOf(bob.id to mutableListOf(conversation.id))
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "token" }, scope, EngineOptions(sleep = {}, reconnectMinMs = 0, random = { 0.5 }))
        engine.isActive = { false }
        engine.start(); settle(engine)
        assertTrue(store.closedDmsKnown)
        assertTrue(store.isDmClosed(conversation.id)) // from bootstrap

        // Opened on another of my devices, then closed there again.
        server.emitDmClose(bob.id, conversation.id, closed = false); settle(engine)
        assertFalse(store.isDmClosed(conversation.id))
        server.emitDmClose(bob.id, conversation.id, closed = true); settle(engine)
        assertTrue(store.isDmClosed(conversation.id))

        // A reply in a thread only does not open it; a new timeline row does (no call: the server counts it open too).
        server.post(conversation.id, alice.id, "in the thread", parentId = topic.id); settle(engine)
        assertTrue(store.isDmClosed(conversation.id))
        server.post(conversation.id, alice.id, "new"); settle(engine)
        assertFalse(store.isDmClosed(conversation.id))
        engine.stop(); scope.cancel()
    }
}
