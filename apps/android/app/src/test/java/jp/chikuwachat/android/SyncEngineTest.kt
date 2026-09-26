package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.Snapshot
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class SyncEngineTest {
    class World(val server: FakeServer, val alice: String, val bob: String, val channelId: String, val store: Store, val engine: SyncEngine, val api: FakeServer.Api, val scope: CoroutineScope, val notifications: MutableList<String>)

    /** A single-threaded scope: the engine's work queue and the fake server never race. */
    private fun world(hold: Boolean = false, pageSize: Int = 3, gapLimit: Int = 5): World {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        val channel = server.createChannel("general", alice.id)
        server.join(channel.id, bob.id)
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val notifications = ArrayList<String>()
        val api = server.api(bob.id)
        val engine = SyncEngine(api, server.connector(bob.id), "ws://fake", store, { "token" }, scope,
            EngineOptions(pageSize = pageSize, gapLimit = gapLimit, reconnectMinMs = 0, sleep = {}, random = { 0.5 }))
        engine.isActive = { false }
        engine.onNotify = { message, _ -> notifications.add(message.body) }
        server.holdEvents = hold
        return World(server, alice.id, bob.id, channel.id, store, engine, api, scope, notifications)
    }

    private suspend fun settle(engine: SyncEngine) { repeat(20) { engine.idle(); yield() } }

    @Test fun bootstrapLoadsLatestPage() = runBlocking {
        val w = world()
        repeat(5) { w.server.post(w.channelId, w.alice, "m${it + 1}") }
        w.engine.openChannel(w.channelId)
        w.engine.start(); settle(w.engine)
        assertEquals(EngineStatus.ONLINE, w.engine.status.value)
        assertEquals("bob", w.store.me?.username)
        assertEquals(listOf("m3", "m4", "m5"), w.store.messages(w.channelId).map { it.body })
        assertEquals(5, w.store.channel(w.channelId)?.syncedSeq)
        w.engine.loadOlder(w.channelId)
        assertEquals(listOf("m1", "m2", "m3", "m4", "m5"), w.store.messages(w.channelId).map { it.body })
        assertEquals(false, w.store.channel(w.channelId)?.hasOlder)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun contiguousEventsAndGapDetection() = runBlocking {
        val w = world()
        w.engine.start(); w.engine.openChannel(w.channelId)
        w.server.post(w.channelId, w.alice, "m1"); settle(w.engine)
        assertEquals(listOf("m1"), w.store.messages(w.channelId).map { it.body })
        w.server.socketsOf(w.bob).first().dropNext = 2
        w.server.post(w.channelId, w.alice, "m2"); w.server.post(w.channelId, w.alice, "m3"); settle(w.engine)
        assertEquals(listOf("m1"), w.store.messages(w.channelId).map { it.body })
        w.server.post(w.channelId, w.alice, "m4"); settle(w.engine) // gap → catch_up
        assertEquals(listOf("m1", "m2", "m3", "m4"), w.store.messages(w.channelId).map { it.body })
        assertEquals(4, w.store.channel(w.channelId)?.syncedSeq)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun eventsDuringBootstrapAreBuffered() = runBlocking {
        val w = world()
        w.engine.openChannel(w.channelId)
        // Bootstrap blocks on the gate; the event delivered meanwhile is queued behind it (§7.2 buffering).
        val gate = CompletableDeferred<Unit>()
        w.api.bootstrapGate = gate
        val started = async { w.engine.start() }
        w.server.post(w.channelId, w.alice, "during")
        assertEquals(0, w.store.messages(w.channelId).size)
        gate.complete(Unit)
        started.await(); settle(w.engine)
        assertEquals(listOf("during"), w.store.messages(w.channelId).map { it.body })
        assertEquals(1, w.store.channel(w.channelId)?.syncedSeq)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun optimisticSendRetriesWithoutDuplicates() = runBlocking {
        val w = world()
        w.engine.start(); w.engine.openChannel(w.channelId)
        w.api.pendingFailure = ApiException.Network(IOException("offline"))
        w.engine.send(w.channelId, "hello")
        assertEquals(1, w.store.outbox.size)
        assertEquals(listOf("hello:true"), w.store.messages(w.channelId).map { "${it.body}:${it.pending}" })
        w.engine.flushOutbox(); settle(w.engine)
        assertEquals(0, w.store.outbox.size)
        assertEquals(listOf("hello:1:false"), w.store.messages(w.channelId).map { "${it.body}:${it.seq}:${it.pending}" })
        assertEquals(1, w.server.channels.getValue(w.channelId).messages.size)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun permanentFailureCanBeDiscarded() = runBlocking {
        val w = world()
        w.engine.start()
        w.api.pendingFailure = ApiException.Api(409, "channel_archived", "archived")
        w.engine.send(w.channelId, "nope")
        assertEquals("channel_archived", w.store.outbox.first().failed)
        assertEquals(true, w.store.messages(w.channelId).first().failed)
        w.engine.discardFailed(w.store.outbox.first().clientMsgId)
        assertEquals(0, w.store.outbox.size)
        assertEquals(0, w.store.messages(w.channelId).size)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun reconnectRecoversMissedEvents() = runBlocking {
        val w = world()
        w.engine.start(); w.engine.openChannel(w.channelId)
        w.server.post(w.channelId, w.alice, "m1"); settle(w.engine)
        w.server.disconnect(w.bob)
        w.server.post(w.channelId, w.alice, "m2"); w.server.post(w.channelId, w.alice, "m3")
        repeat(50) { if (w.engine.status.value != EngineStatus.ONLINE) settle(w.engine) }
        settle(w.engine)
        assertEquals(EngineStatus.ONLINE, w.engine.status.value)
        assertEquals(1, w.engine.reconnects)
        assertEquals(listOf("m1", "m2", "m3"), w.store.messages(w.channelId).map { it.body })
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun sessionRevocationSignsOut() = runBlocking {
        val w = world()
        var signedOut = false
        w.engine.onSignedOut = { signedOut = true }
        w.engine.start()
        w.server.revokeSession(w.bob); settle(w.engine)
        assertEquals(EngineStatus.SIGNED_OUT, w.engine.status.value)
        assertTrue(signedOut)
        w.scope.cancel()
    }

    @Test fun directMessagesNotifyWhenInactive() = runBlocking {
        val w = world()
        val dm = w.server.createChannel("", w.alice, "dm")
        w.server.join(dm.id, w.bob)
        w.engine.start()
        w.server.post(dm.id, w.alice, "psst"); settle(w.engine)
        assertEquals(listOf("psst"), w.notifications)
        assertEquals(1, w.store.channel(dm.id)?.lastSeq)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun resumesFromPersistedSnapshot() = runBlocking {
        val w = world()
        w.engine.start(); w.engine.openChannel(w.channelId)
        w.server.post(w.channelId, w.alice, "m1"); settle(w.engine)
        w.engine.stop()
        w.server.post(w.channelId, w.alice, "m2")
        val restored = Store.fromSnapshot(w.store.snapshot())
        val second = SyncEngine(w.server.api(w.bob), w.server.connector(w.bob), "ws://fake", restored, { "t" }, w.scope, EngineOptions(pageSize = 3, sleep = {}))
        second.openChannel(w.channelId); second.start(); settle(second)
        assertEquals(listOf("m1", "m2"), restored.messages(w.channelId).map { it.body })
        assertEquals(2, restored.channel(w.channelId)?.syncedSeq)
        second.stop(); w.scope.cancel()
    }

    @Test fun appliesLiveEditsDeletionsAndReactions() = runBlocking {
        val w = world()
        w.engine.start(); w.engine.openChannel(w.channelId)
        val (m1, _) = w.server.post(w.channelId, w.alice, "m1")
        val (m2, _) = w.server.post(w.channelId, w.alice, "m2"); settle(w.engine)
        w.server.edit(w.channelId, w.alice, m1.id, "m1 edited"); settle(w.engine)
        assertEquals(listOf("m1 edited", "m2"), w.store.messages(w.channelId).map { it.body })
        assertTrue(w.store.message(w.channelId, m1.id)!!.editedAt != null)
        w.server.react(w.channelId, w.bob, m2.id, "👍", present = true); settle(w.engine)
        assertEquals(listOf("👍"), w.store.message(w.channelId, m2.id)!!.reactions.map { it.emoji })
        assertTrue(w.store.message(w.channelId, m2.id)!!.reactedBy(w.bob, "👍"))
        w.server.react(w.channelId, w.bob, m2.id, "👍", present = false); settle(w.engine)
        assertEquals(0, w.store.message(w.channelId, m2.id)!!.reactions.size)
        w.server.delete(w.channelId, w.alice, m2.id); settle(w.engine)
        assertEquals(listOf("m1 edited"), w.store.messages(w.channelId).map { it.body })
        assertEquals(6, w.store.channel(w.channelId)?.syncedSeq)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun channelMentionsNotify() = runBlocking {
        val w = world()
        w.engine.start()
        w.server.post(w.channelId, w.alice, "plain"); settle(w.engine)
        assertEquals(0, w.notifications.size)
        w.server.post(w.channelId, w.alice, "hey <@${w.bob}>"); settle(w.engine)
        w.server.post(w.channelId, w.alice, "<!channel> all"); settle(w.engine)
        assertEquals(listOf("hey <@${w.bob}>", "<!channel> all"), w.notifications)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun unreadCountsFollowReadsAcrossDevices() = runBlocking {
        val w = world()
        w.server.post(w.channelId, w.alice, "m1"); w.server.post(w.channelId, w.alice, "m2")
        w.engine.start(); settle(w.engine)
        assertEquals(2, w.store.channel(w.channelId)?.unreadCount)
        w.server.post(w.channelId, w.alice, "hey <@${w.bob}>"); settle(w.engine)
        assertEquals(3 to 1, w.store.channel(w.channelId)!!.let { it.unreadCount to it.mentionCount })
        w.engine.markRead(w.channelId, 2); w.engine.flushReads(); settle(w.engine)
        assertEquals(Triple(2, 1, 1), w.store.channel(w.channelId)!!.let { Triple(it.lastReadSeq, it.unreadCount, it.mentionCount) })
        w.server.markRead(w.bob, w.channelId, 3); settle(w.engine) // another device of bob
        assertEquals(Triple(3, 0, 0), w.store.channel(w.channelId)!!.let { Triple(it.lastReadSeq, it.unreadCount, it.mentionCount) })
        w.engine.markRead(w.channelId, 1); w.engine.flushReads(); settle(w.engine) // stale: ignored
        assertEquals(3, w.store.channel(w.channelId)?.lastReadSeq)
        w.server.post(w.channelId, w.alice, "m4"); settle(w.engine)
        w.engine.openChannel(w.channelId); w.engine.send(w.channelId, "mine"); settle(w.engine)
        assertEquals(Triple(5, 0, 0), w.store.channel(w.channelId)!!.let { Triple(it.lastReadSeq, it.unreadCount, it.mentionCount) })
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun threadsKeepRepliesOutOfTheTimelineAndUpdateTheParent() = runBlocking {
        val w = world()
        w.engine.start(); w.engine.openChannel(w.channelId)
        val (parent, _) = w.server.post(w.channelId, w.alice, "topic"); settle(w.engine)
        w.server.post(w.channelId, w.alice, "reply 1", parentId = parent.id); settle(w.engine)
        assertEquals(listOf("topic"), w.store.messages(w.channelId).map { it.body })
        assertEquals(listOf("reply 1"), w.store.replies(w.channelId, parent.id).map { it.body })
        assertEquals(1, w.store.message(w.channelId, parent.id)?.replyCount)
        assertEquals(0, w.notifications.size) // bob is not part of the thread
        assertEquals(1, w.store.channel(w.channelId)?.unreadCount) // replies are not unread items

        w.engine.send(w.channelId, "reply 2", parentId = parent.id); settle(w.engine)
        assertEquals(listOf("reply 1", "reply 2"), w.store.replies(w.channelId, parent.id).map { it.body })
        assertEquals(2, w.store.message(w.channelId, parent.id)?.replyCount)
        w.server.post(w.channelId, w.alice, "reply 3", parentId = parent.id); settle(w.engine)
        assertEquals(listOf("reply 3"), w.notifications) // now bob replied, so alice's reply notifies him

        // A fresh client loads the thread on demand.
        val restored = Store.fromSnapshot(Snapshot(users = w.store.users.values.toList(), channels = w.store.channels.values.toList()))
        val second = SyncEngine(w.server.api(w.bob), w.server.connector(w.bob), "ws://fake", restored, { "t" }, w.scope, EngineOptions(sleep = {}))
        second.start(); settle(second)
        assertEquals(0, restored.replies(w.channelId, parent.id).size)
        second.loadReplies(w.channelId, parent.id)
        assertEquals(listOf("reply 1", "reply 2", "reply 3"), restored.replies(w.channelId, parent.id).map { it.body })
        second.stop(); w.engine.stop(); w.scope.cancel()
    }

    @Test fun browsablePublicChannelsAndJoining() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice"); val bob = server.addUser("bob")
        val general = server.createChannel("general", alice.id)
        val secret = server.createChannel("secret", alice.id, "private")
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}))
        engine.start(); settle(engine)
        assertEquals(false, store.channel(general.id)?.isMember)
        assertNull(store.channel(secret.id))
        server.join(general.id, bob.id); server.emitMembership(general.id, bob.id); settle(engine)
        assertEquals(true, store.channel(general.id)?.isMember)
        engine.stop(); scope.cancel()
    }
}
