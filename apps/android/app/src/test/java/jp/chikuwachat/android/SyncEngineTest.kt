package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.ThreadSummary
import jp.chikuwachat.android.sync.ClientFrame
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

    @Test fun conversationDraftsPersistSeparatelyIncludingAttachments() {
        val store = Store()
        val attachment = jp.chikuwachat.android.api.AttachmentOut("a", "note.txt", "text/plain", 4, status = "pending")
        store.setDraft("c1") { it.copy(text = "channel", attachments = listOf(attachment)) }
        store.setDraft("c1", "p1") { it.copy(text = "thread") }
        store.setDraft("c2") { it.copy(text = "other") }
        store.trackUpload("c1", delta = 1)
        val restored = Store.fromSnapshot(store.snapshot())
        assertEquals(listOf(attachment), restored.draft("c1").attachments)
        assertEquals("thread", restored.draft("c1", "p1").text)
        assertEquals("other", restored.draft("c2").text)
        assertEquals(0, restored.uploading("c1"))
        restored.setDraft("c1") { jp.chikuwachat.android.sync.Draft() }
        assertEquals("", Store.fromSnapshot(restored.snapshot()).draft("c1").text)
        assertEquals("thread", restored.draft("c1", "p1").text)
    }

    @Test fun openingDoesNotReadAndBackgroundReadIsIgnored() = runBlocking {
        val w = world()
        w.server.post(w.channelId, w.alice, "unseen")
        w.engine.start(); w.engine.openChannel(w.channelId)
        assertEquals(1, w.store.channel(w.channelId)?.unreadCount)
        w.engine.markRead(w.channelId, 1)
        assertEquals(0, w.store.channel(w.channelId)?.lastReadSeq)
        w.engine.stop()
        w.engine.isActive = { true }
        w.engine.markRead(w.channelId, 1)
        assertEquals(0, w.store.channel(w.channelId)?.lastReadSeq)
        w.engine.send(w.channelId, "offline send")
        assertEquals(1, w.store.outbox.size)
        w.engine.start(); settle(w.engine)
        assertEquals(0, w.store.outbox.size)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun sessionRestorationRetriesTemporaryFailure() = runBlocking {
        val w = world()
        var attempts = 0
        w.store.setDraft("c1") { it.copy(text = "offline draft") }
        w.engine.prepareConnection = {
            attempts++
            if (attempts == 1) throw ApiException.Network(IOException("offline"))
        }
        w.engine.start(); settle(w.engine)
        assertEquals(EngineStatus.ONLINE, w.engine.status.value)
        assertEquals(2, attempts)
        assertEquals("offline draft", w.store.draft("c1").text)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun revokedSessionDuringRestorationSignsOut() = runBlocking {
        val w = world()
        w.engine.prepareConnection = { throw ApiException.Api(401, "session_revoked", "revoked") }
        w.engine.start()
        assertEquals(EngineStatus.SIGNED_OUT, w.engine.status.value)
        w.engine.stop(); w.scope.cancel()
    }

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

    @Test fun markUnreadMovesBackHoldsVisibleMarkingAndFollowsOtherDevices() = runBlocking {
        val w = world()
        w.engine.isActive = { true }
        listOf("m1", "m2", "m3").forEach { w.server.post(w.channelId, w.alice, it) }
        w.engine.start(); settle(w.engine)
        w.engine.openChannel(w.channelId)
        w.engine.markRead(w.channelId, 3); w.engine.flushReads(); settle(w.engine)
        assertEquals(0, w.store.channel(w.channelId)?.unreadCount)

        w.engine.markUnread(w.channelId, 2) // 「ここから未読にする」 on m2
        assertEquals(listOf(1, 2), w.store.channel(w.channelId)?.let { listOf(it.lastReadSeq, it.unreadCount) })
        w.engine.flushReads(); settle(w.engine)
        assertEquals(1, w.server.readState(w.bob, w.channelId).lastReadSeq)
        w.engine.markRead(w.channelId, 3); w.engine.flushReads() // visible-range marking is on hold
        assertEquals(1, w.store.channel(w.channelId)?.lastReadSeq)
        w.engine.markRead(w.channelId, 3, force = true); w.engine.flushReads(); settle(w.engine) // Esc overrides the hold
        assertEquals(3, w.store.channel(w.channelId)?.lastReadSeq)

        w.server.markRead(w.bob, w.channelId, 0, mode = "set"); settle(w.engine) // another device of bob
        assertEquals(listOf(0, 3), w.store.channel(w.channelId)?.let { listOf(it.lastReadSeq, it.unreadCount) })
        // A plain advance event behind the local position (an older PUT of ours) must not lower it.
        w.engine.markRead(w.channelId, 3)
        w.server.markRead(w.bob, w.channelId, 2); settle(w.engine)
        assertEquals(3, w.store.channel(w.channelId)?.lastReadSeq)
        w.engine.flushReads()
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun unreadCountsFollowReadsAcrossDevices() = runBlocking {
        val w = world()
        w.engine.isActive = { true }
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

    @Test fun followedThreadsListUnreadRepliesAndReadPosition() = runBlocking {
        val w = world()
        w.engine.isActive = { true }
        w.engine.start(); w.engine.openChannel(w.channelId)
        assertEquals(ThreadSummary(0, 0), w.store.threadSummary)

        // bob's own topic: alice's reply makes it a followed, unread thread (badge via thread.updated).
        w.engine.send(w.channelId, "topic"); settle(w.engine)
        val parent = w.server.messageByBody(w.channelId, "topic")
        w.server.post(w.channelId, w.alice, "<@${w.bob}> reply 1", parentId = parent.id)
        w.engine.flushThreads(); settle(w.engine)
        assertEquals(ThreadSummary(1, 1), w.store.threadSummary)
        assertEquals(false, w.store.threadsLoaded) // only the badge until the view opens

        w.engine.loadThreads("all")
        val rows = w.store.threadList()
        assertEquals(listOf("topic"), rows.map { it.parent.body })
        assertEquals(1, rows.first().state.unreadCount)
        assertEquals(1, rows.first().state.mentionCount)
        assertEquals(listOf(w.bob, w.alice), rows.first().state.participantIds)

        // Showing the reply marks the thread read (debounced PUT); the badge drops at once.
        val reply = w.server.messageByBody(w.channelId, "<@${w.bob}> reply 1")
        w.engine.loadReplies(w.channelId, parent.id)
        w.engine.markThreadRead(parent.id, reply.seq)
        assertEquals(0, w.store.threads[parent.id]?.state?.unreadCount)
        assertEquals(ThreadSummary(0, 0), w.store.threadSummary)
        w.engine.flushThreads(); settle(w.engine)
        assertEquals(reply.seq, w.server.threadState(w.bob, parent.id).lastReadSeq)
        assertEquals(0, w.store.threadList("unread").size)

        // Unfollowing drops the thread from the list; the next reply does not bring it back.
        w.engine.setThreadFollow(parent.id, false)
        assertEquals(false, w.store.threads[parent.id]?.state?.following)
        assertEquals(0, w.store.threadList().size)
        w.server.post(w.channelId, w.alice, "reply 2", parentId = parent.id)
        w.engine.flushThreads(); settle(w.engine)
        assertEquals(0, w.store.threadList().size)
        assertEquals(0, w.store.threadSummary.unreadCount)
        assertEquals(listOf(w.alice), w.server.threadState(w.alice, parent.id).participantIds) // bob is no push target

        w.engine.setThreadFollow(parent.id, true)
        w.engine.flushThreads(); settle(w.engine)
        assertEquals(listOf(parent.id), w.store.threadList().map { it.parent.id })
        assertEquals(1, w.store.threads[parent.id]?.state?.unreadCount)

        // A fresh client asks for the state when a thread opens from the channel.
        val fresh = Store()
        val second = SyncEngine(w.server.api(w.bob), w.server.connector(w.bob), "ws://fake", fresh, { "t" }, w.scope, EngineOptions(sleep = {}))
        second.start(); second.openChannel(w.channelId); settle(second)
        assertEquals(1, fresh.threadSummary.unreadCount) // from bootstrap
        assertNull(fresh.threads[parent.id])
        second.loadThreadState(parent.id)
        assertEquals(true, fresh.threads[parent.id]?.state?.following)
        assertEquals(1, fresh.threads[parent.id]?.state?.unreadCount)
        second.stop(); w.engine.stop(); w.scope.cancel()
    }

    @Test fun presenceAndTypingAreVolatile() = runBlocking {
        val w = world()
        // alice is connected before bob bootstraps: listed in bootstrap.
        val aliceSocket = w.server.connector(w.alice)("ws://fake", "t")
        aliceSocket.send(ClientFrame.auth("t"))
        w.engine.start(); w.engine.openChannel(w.channelId); settle(w.engine)
        assertEquals("online", w.store.presenceOf(w.alice))
        assertEquals("online", w.store.presenceOf(w.bob)) // own connection announced too

        w.server.awayUsers.add(w.alice)
        w.server.announcePresence(w.alice)
        settle(w.engine)
        assertEquals("away", w.store.presenceOf(w.alice))
        aliceSocket.close()
        settle(w.engine)
        assertEquals("offline", w.store.presenceOf(w.alice))
        assertNull(w.store.presence[w.alice])

        // Typing from alice shows up for bob, expires, and is cleared by her message.
        val aliceAgain = w.server.connector(w.alice)("ws://fake", "t")
        aliceAgain.send(ClientFrame.auth("t"))
        aliceAgain.send(ClientFrame.typing(w.channelId, null))
        settle(w.engine)
        assertEquals(listOf(w.alice), w.store.typingUsers(w.channelId, null))
        assertEquals(emptyList<String>(), w.store.typingUsers(w.channelId, null, System.currentTimeMillis() + 6_000)) // 5 s TTL
        aliceAgain.send(ClientFrame.typing(w.channelId, "p1"))
        settle(w.engine)
        assertEquals(listOf(w.alice), w.store.typingUsers(w.channelId, "p1"))
        w.server.post(w.channelId, w.alice, "here it is")
        settle(w.engine)
        assertEquals(emptyList<String>(), w.store.typingUsers(w.channelId, null))

        // Our own typing goes out at most once per interval and never comes back to us.
        w.engine.sendTyping(w.channelId)
        w.engine.sendTyping(w.channelId)
        settle(w.engine)
        assertEquals(emptyList<String>(), w.store.typingUsers(w.channelId, null))
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun pinsTravelAsMessageUpdatesAndBookmarksFollowTheUserEvent() = runBlocking {
        val w = world()
        val (message, _) = w.server.post(w.channelId, w.alice, "keep this")
        w.server.setBookmark(w.bob, message.id, true) // saved on another device before this one started
        w.engine.start(); w.engine.openChannel(w.channelId); settle(w.engine)
        assertTrue(w.store.isBookmarked(message.id))

        // A pin is an ordinary seq-consuming update: the row gets pinnedBy without a resync.
        w.server.pin(w.channelId, w.alice, message.id, true); settle(w.engine)
        assertEquals(w.alice, w.store.message(w.channelId, message.id)?.pinnedBy)
        assertEquals(2, w.store.message(w.channelId, message.id)?.updatedSeq)
        assertEquals(2, w.store.channel(w.channelId)?.syncedSeq)
        w.server.pin(w.channelId, w.bob, message.id, false); settle(w.engine)
        assertNull(w.store.message(w.channelId, message.id)?.pinnedAt)

        // Another device removes the bookmark: the flag follows the user event.
        w.server.setBookmark(w.bob, message.id, false); settle(w.engine)
        assertEquals(false, w.store.isBookmarked(message.id))
        w.server.setBookmark(w.bob, message.id, true); settle(w.engine)
        assertTrue(w.store.isBookmarked(message.id))
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun attachmentIdsTravelWithTheOutbox() = runBlocking {
        val w = world()
        w.engine.start(); w.engine.openChannel(w.channelId)
        w.engine.send(w.channelId, "", attachmentIds = listOf("a1", "a2")); settle(w.engine)
        val sent = w.store.messages(w.channelId).single()
        assertEquals(listOf("a1", "a2"), sent.attachments.map { it.id })
        assertEquals(listOf("a1", "a2"), w.server.channels.getValue(w.channelId).messages.single().attachments.map { it.id })
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun scheduledRowsLoadAfterBootstrapAndFollowEvents() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val general = server.createChannel("general", alice.id)
        val row = server.schedule(alice.id, general.id, "later", "2026-10-03T00:00:00Z")
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(alice.id), server.connector(alice.id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}))
        engine.start(); settle(engine)
        assertEquals(listOf("later"), store.listScheduled().map { it.body })
        val second = server.schedule(alice.id, general.id, "sooner", "2026-10-02T00:00:00Z")
        server.emitScheduled(alice.id, second); settle(engine)
        assertEquals(listOf("sooner", "later"), store.listScheduled().map { it.body }) // soonest first
        server.emitScheduled(alice.id, row.copy(status = "sent", sentMessageId = "m1"))
        server.emitScheduled(alice.id, second.copy(status = "cancelled")); settle(engine)
        assertTrue(store.listScheduled().isEmpty())
        engine.stop(); scope.cancel()
    }

    @Test fun favoritesSyncAndReadAllClearsEveryChannel() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice"); val bob = server.addUser("bob")
        val general = server.createChannel("general", alice.id)
        val random = server.createChannel("random", alice.id)
        server.join(general.id, bob.id); server.join(random.id, bob.id)
        server.setFavorite(bob.id, random.id, true)
        server.post(general.id, alice.id, "one"); server.post(general.id, alice.id, "two"); server.post(random.id, alice.id, "three")
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}))
        engine.start(); settle(engine)
        assertEquals(setOf(random.id), store.favorites)
        assertEquals(2, store.channel(general.id)?.unreadCount)
        assertEquals(1, store.channel(random.id)?.unreadCount)
        server.setFavorite(bob.id, general.id, true); settle(engine) // another device starred it
        assertTrue(store.isFavorite(general.id))
        engine.markAllRead(); settle(engine)
        assertEquals(0, store.channel(general.id)?.unreadCount)
        assertEquals(2, store.channel(general.id)?.lastReadSeq)
        assertEquals(0, store.channel(random.id)?.unreadCount)
        engine.stop(); scope.cancel()
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
        assertEquals(1, store.channel(general.id)?.channel?.memberCount) // M11h: shown by the channel browser
        assertNull(store.channel(secret.id))
        server.join(general.id, bob.id); server.emitMembership(general.id, bob.id); settle(engine)
        assertEquals(true, store.channel(general.id)?.isMember)
        assertEquals(2, store.channel(general.id)?.channel?.memberCount) // member_added keeps the count current
        engine.stop(); scope.cancel()
    }
}
