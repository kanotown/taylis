package jp.chikuwachat.android

import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncApi
import jp.chikuwachat.android.sync.SyncEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** SYNC_PROTOCOL.md §7.6.1 (M27): a public channel read before joining stays in memory and out of the member sync. */
class ChannelPreviewTest {
    private class World(role: String = "member") {
        val server = FakeServer()
        val alice: UserPublic = server.addUser("alice")
        val bob: UserPublic = server.addUser("bob", role)
        val home = server.createChannel("general", alice.id).also { server.join(it.id, bob.id) }
        /** Alice's channel that Bob has not joined: five posts, the second with two replies. */
        val open = server.createChannel("open", alice.id)
        val posts = (1..5).map { server.post(open.id, alice.id, "post $it").first }
        val replies = (1..2).map { server.post(open.id, alice.id, "reply $it", parentId = posts[1].id).first }
        val persistence = MemoryPersistence()
        val store = Store(persistence)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        // Held as the interface (see SyncEngineTest.World).
        private val syncApi: SyncApi = server.api(bob.id)
        val api: FakeServer.Api get() = syncApi as FakeServer.Api
        val engine = SyncEngine(syncApi, server.connector(bob.id), "ws://fake", store, { "token" }, scope, EngineOptions(pageSize = 3, sleep = {}, random = { 0.5 }))

        suspend fun settle() = repeat(10) { engine.idle(); yield() }

        fun close() {
            engine.stop()
            scope.cancel()
        }
    }

    @Test fun aPreviewLoadsPagesInMemoryOnlyAndNeverSyncsOrReads() = runBlocking {
        val w = World()
        w.engine.isActive = { true }
        w.engine.start(); w.settle()
        assertEquals(false, w.store.channel(w.open.id)?.isMember) // browsable
        w.engine.openChannel(w.open.id); w.settle()
        val preview = w.store.preview!!
        assertEquals(w.open.id, preview.channelId)
        assertEquals(listOf("post 3", "post 4", "post 5"), preview.messages.map { it.body })
        assertTrue(preview.hasOlder)
        w.engine.loadOlderPreview(w.open.id)
        assertEquals(listOf("post 1", "post 2", "post 3", "post 4", "post 5"), w.store.preview!!.messages.map { it.body })
        assertFalse(w.store.preview!!.hasOlder)
        assertEquals(listOf<Pair<Int?, Int>>(null to 3, w.posts[2].seq to 3), w.api.historyCalls)
        w.engine.loadPreviewReplies(w.open.id, w.posts[1].id)
        assertEquals(listOf("reply 1", "reply 2"), w.store.preview!!.replies[w.posts[1].id]?.map { it.body })

        // Nothing of it is synced, read or kept: no cursor, no rows in the store or its tables, no read mark.
        val channel = w.store.channel(w.open.id)!!
        assertNull(channel.syncedSeq)
        assertNull(channel.oldestLoadedSeq)
        w.engine.markRead(w.open.id, w.posts[4].seq, force = true); w.engine.flushReads()
        assertEquals(emptyList<Int>(), w.api.readCalls)
        assertTrue(w.store.messages(w.open.id).isEmpty())
        assertTrue(w.store.snapshot().messages.none { it.channelId == w.open.id })
        assertTrue(w.persistence.messages.values.none { it.channelId == w.open.id })

        // A reconnect keeps the rows (no event reaches a non-member, and the member catch-up skips the channel).
        w.engine.stop(); w.engine.start(); w.settle()
        assertEquals(2, w.api.historyCalls.size)
        assertEquals(5, w.store.preview?.messages?.size)
        assertNull(w.store.channel(w.open.id)?.syncedSeq)

        // Another conversation drops it.
        w.engine.openChannel(w.home.id); w.settle()
        assertNull(w.store.preview)
        w.close()
    }

    @Test fun joiningFromThePreviewCarriesOnAsAJoinedChannel() = runBlocking {
        val w = World()
        w.engine.start(); w.settle()
        w.engine.openChannel(w.open.id); w.settle()
        assertNotNull(w.store.preview)
        // AppController.joinChannel: POST join, the channel as a member, then the conversation opens again.
        w.server.join(w.open.id, w.bob.id)
        w.store.upsertChannel(w.open.copy(lastSeq = w.server.channels.getValue(w.open.id).channel.lastSeq), isMember = true)
        w.engine.openChannel(w.open.id); w.settle()
        assertNull(w.store.preview)
        assertEquals(listOf("post 3", "post 4", "post 5"), w.store.messages(w.open.id).map { it.body })
        assertNotNull(w.store.channel(w.open.id)?.syncedSeq)
        assertTrue(w.persistence.messages.values.any { it.channelId == w.open.id })
        w.close()
    }

    @Test fun closingThePreviewDropsItAndAFailedLoadIsTriedAgain() = runBlocking {
        val w = World()
        w.engine.start(); w.settle()
        w.api.pendingFailure = jp.chikuwachat.android.api.ApiException.Api(503, "unavailable", "down")
        w.engine.openChannel(w.open.id); w.settle()
        assertEquals(true, w.store.preview?.failed)
        assertEquals(false, w.store.preview?.loaded)
        w.engine.openChannel(w.open.id); w.settle() // 再読み込み
        assertEquals(3, w.store.preview?.messages?.size)
        w.engine.closePreview()
        assertNull(w.store.preview)
        w.close()
    }

    @Test fun anArchivedChannelOpenedFromALinkKeepsItsPreviewAcrossAReconnect() = runBlocking { // M28c
        val w = World()
        val old = w.server.createChannel("old", w.alice.id)
        w.server.post(old.id, w.alice.id, "kept")
        w.server.channels.getValue(old.id).let { it.channel = it.channel.copy(archived = true) }
        w.engine.start(); w.settle()
        assertNull(w.store.channel(old.id)) // archived: not offered for joining
        // AppController.revealMessage put it in the store as browsable, and its preview opened.
        w.store.upsertChannel(w.server.channels.getValue(old.id).channel.copy(membership = null), isMember = false)
        w.engine.openChannel(old.id); w.settle()
        assertEquals(listOf("kept"), w.store.preview?.messages?.map { it.body })
        // The reconnect's browse list does not have it; the preview on screen keeps it (it used to close).
        w.engine.stop(); w.engine.start(); w.settle()
        assertNotNull(w.store.channel(old.id))
        assertEquals(old.id, w.store.preview?.channelId)
        // Closed, the next reconnect neither keeps the channel nor opens its preview again.
        w.engine.closeConversation(); w.settle()
        assertNull(w.store.preview)
        assertNull(w.engine.currentChannelId)
        w.engine.stop(); w.engine.start(); w.settle()
        assertNull(w.store.preview)
        assertNull(w.store.channel(old.id))
        w.close()
    }

    @Test fun guestsNeverPreview() = runBlocking {
        val w = World(role = "guest")
        w.engine.start(); w.settle()
        assertNull(w.store.channel(w.open.id)) // not listed for a guest
        // Even a channel that got into the list somehow is not read.
        w.store.upsertChannel(w.open, isMember = false)
        w.engine.openChannel(w.open.id); w.settle()
        assertNull(w.store.preview)
        assertTrue(w.api.historyCalls.isEmpty())
        w.close()
    }
}
