package jp.chikuwachat.android

import jp.chikuwachat.android.api.NotificationPreferenceOut
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.ThreadSummary
import jp.chikuwachat.android.sync.CLOSE_AUTH_FAILED
import jp.chikuwachat.android.sync.ClientFrame
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.Snapshot
import jp.chikuwachat.android.sync.SendOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncApi
import jp.chikuwachat.android.sync.SyncEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class SyncEngineTest {
    class World(
        val server: FakeServer, val alice: String, val bob: String, val channelId: String, val store: Store, val engine: SyncEngine, private val syncApi: SyncApi,
        val scope: CoroutineScope, val notifications: MutableList<String>, val time: ManualTime,
    ) {
        // Held as the interface: a field of the inner class type makes the Compose compiler read
        // FakeServer$Api.$stable, which an incremental rebuild of FakeServer.kt alone leaves out.
        val api: FakeServer.Api get() = syncApi as FakeServer.Api
    }

    /**
     * A single-threaded scope: the engine's work queue and the fake server never race. The heartbeat and the
     * outbox retry run on `time` (they only fire when a test advances it); with `manualBackoff` the reconnect
     * backoff (1 s ± jitter) waits for it too, otherwise reconnects and debounces are immediate.
     */
    private fun world(hold: Boolean = false, pageSize: Int = 3, gapLimit: Int = 5, manualBackoff: Boolean = false): World {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        val channel = server.createChannel("general", alice.id)
        server.join(channel.id, bob.id)
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val notifications = ArrayList<String>()
        val api = server.api(bob.id)
        val time = ManualTime()
        val instant: suspend (Long) -> Unit = {}
        val engine = SyncEngine(api, server.connector(bob.id), "ws://fake", store, { "token" }, scope,
            EngineOptions(
                pageSize = pageSize, gapLimit = gapLimit, reconnectMinMs = if (manualBackoff) 1_000 else 0, sleep = if (manualBackoff) time.timer else instant,
                random = { 0.5 }, clock = time.clock, timer = time.timer,
            ))
        engine.isActive = { false }
        engine.onNotify = { message, _ -> notifications.add(message.body) }
        server.holdEvents = hold
        return World(server, alice.id, bob.id, channel.id, store, engine, api, scope, notifications, time)
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

    /**
     * PUSH_NOTIFICATIONS.md §4.1: the server counts a new connection as in use; one from the background says it is not
     * at once, not a heartbeat later (the reader's pushes were held back meanwhile).
     */
    @Test fun aConnectionNotInUseSaysSoAtOnce() = runBlocking {
        for (active in listOf(false, true)) {
            val w = world()
            w.engine.isActive = { active }
            w.engine.start()
            settle(w.engine)
            assertEquals(if (active) emptyList() else listOf(false), w.server.sockets.first().pingActive)
            w.engine.stop()
        }
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

    @Test fun theOverallSettingAndTheMuteDecideTheAppsNotifications() = runBlocking { // M35
        val w = world()
        w.server.notificationDefaults[w.bob] = "all"
        w.engine.start(); settle(w.engine)
        w.server.post(w.channelId, w.alice, "plain"); settle(w.engine)
        assertEquals(listOf("plain"), w.notifications) // no level of its own: the overall "all"
        // Muted until unmuted, still following the overall setting: the event carries both, nothing notifies.
        w.server.emitNotificationPreference(w.bob, NotificationPreferenceOut(w.channelId, "all", null, followsDefault = true, muted = true)); settle(w.engine)
        val pref = w.store.channel(w.channelId)!!.channel.notification!!
        assertTrue(pref.muted)
        assertEquals(true, pref.followsDefault)
        assertTrue(jp.chikuwachat.android.ui.Channels.isMuted(w.store.channel(w.channelId)!!))
        w.server.post(w.channelId, w.alice, "hey <@${w.bob}>"); settle(w.engine)
        assertEquals(listOf("plain"), w.notifications)
        // Unmuted with a level of its own: mentions only.
        w.server.emitNotificationPreference(w.bob, NotificationPreferenceOut(w.channelId, "mentions", null, followsDefault = false, muted = false)); settle(w.engine)
        w.server.post(w.channelId, w.alice, "plain again"); settle(w.engine)
        w.server.post(w.channelId, w.alice, "again <@${w.bob}>"); settle(w.engine)
        assertEquals(listOf("plain", "again <@${w.bob}>"), w.notifications)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun theOverallSettingNoneSilencesChannelsWithoutALevel() = runBlocking { // M35
        val w = world()
        w.server.notificationDefaults[w.bob] = "none"
        w.engine.start(); settle(w.engine)
        w.server.post(w.channelId, w.alice, "hey <@${w.bob}>"); settle(w.engine)
        assertEquals(0, w.notifications.size)
        // ...but it does not mute: the unread rules never read the overall setting (SYNC_PROTOCOL.md §10.5).
        val state = w.store.channel(w.channelId)!!
        assertFalse(jp.chikuwachat.android.ui.Channels.isMuted(state))
        assertTrue(jp.chikuwachat.android.ui.Channels.hasUnread(state, w.bob))
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun myNotificationKeywordsCountAndNotifyEvenThoughTheServerKeepsThemPrivate() = runBlocking {
        val w = world()
        w.server.keywords[w.bob] = listOf("デプロイ")
        w.engine.start(); settle(w.engine)
        val before = w.store.channel(w.channelId)!!.mentionCount
        w.server.post(w.channelId, w.alice, "今夜デプロイします"); settle(w.engine)
        assertEquals(listOf("今夜デプロイします"), w.notifications)
        assertEquals(before + 1, w.store.channel(w.channelId)!!.mentionCount)
        assertTrue(jp.chikuwachat.android.api.hitsKeyword("DEPLOY now", listOf("deploy")))
        assertFalse(jp.chikuwachat.android.api.hitsKeyword("nothing", listOf("deploy", "")))
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
        w.engine.openChannel(w.channelId) // §10.1: visible-range reads need the unread rows loaded
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

    @Test fun priorityAndAckRequestSurviveTheOutboxOnTopLevelPostsOnly() = runBlocking { // M15e
        val w = world()
        w.engine.start(); w.engine.openChannel(w.channelId)
        w.api.pendingFailure = ApiException.Network(java.io.IOException("offline")) // the first attempt fails: the flags must survive the retry
        w.engine.send(w.channelId, "本番を止めます", sendOptions = SendOptions(priority = "urgent", ackRequested = true))
        assertEquals("urgent" to true, w.store.outbox.first().let { it.priority to it.ackRequested })
        w.engine.flushOutbox(); settle(w.engine)
        val sent = w.store.messages(w.channelId).last()
        assertEquals(listOf("本番を止めます", "urgent", true, false), listOf(sent.body, sent.priority, sent.ackRequested, sent.pending))
        w.engine.send(w.channelId, "返信", parentId = sent.id, sendOptions = SendOptions(priority = "important", ackRequested = true)); settle(w.engine)
        val reply = w.store.replies(w.channelId, sent.id).last()
        assertEquals(null to false, reply.priority to reply.ackRequested)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun replyAlsoSentToTheChannelShowsInBothPlacesAndCountsUnread() = runBlocking { // M15c
        val w = world()
        w.engine.start(); w.engine.openChannel(w.channelId)
        val (parent, _) = w.server.post(w.channelId, w.alice, "topic"); settle(w.engine)
        w.server.post(w.channelId, w.alice, "quiet", parentId = parent.id)
        w.server.post(w.channelId, w.alice, "loud", parentId = parent.id, options = SendOptions(alsoInChannel = true)); settle(w.engine)
        assertEquals(listOf("topic", "loud"), w.store.messages(w.channelId).map { it.body })
        assertEquals(listOf("quiet", "loud"), w.store.replies(w.channelId, parent.id).map { it.body })
        assertEquals(2, w.store.channel(w.channelId)?.unreadCount) // the topic and the shared reply

        w.engine.send(w.channelId, "mine too", parentId = parent.id, sendOptions = SendOptions(alsoInChannel = true)); settle(w.engine)
        val mine = w.store.messages(w.channelId).last()
        assertEquals(Triple("mine too", true, false), Triple(mine.body, mine.alsoInChannel, mine.pending))

        // Another device finds both shared replies in the channel history.
        val restored = Store()
        val second = SyncEngine(w.server.api(w.bob), w.server.connector(w.bob), "ws://fake", restored, { "t" }, w.scope, EngineOptions(pageSize = 3, sleep = {}))
        second.start(); second.openChannel(w.channelId); settle(second)
        assertEquals(listOf("topic", "loud", "mine too"), restored.messages(w.channelId).map { it.body })
        second.stop(); w.engine.stop(); w.scope.cancel()
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

    @Test fun customEmojiLoadFromBootstrapAndFollowEvents() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice")
        server.createChannel("general", alice.id)
        server.addEmoji("party_parrot", alice.id)
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(alice.id), server.connector(alice.id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}))
        engine.start(); settle(engine)
        assertEquals(listOf("party_parrot"), store.customEmoji.keys.toList())
        val ok = server.addEmoji("ok", alice.id)
        server.emitEmoji(ok, false); settle(engine)
        assertEquals(listOf("ok", "party_parrot"), store.customEmoji.keys.sorted())
        server.emitEmoji(ok, true); settle(engine)
        assertEquals(listOf("party_parrot"), store.customEmoji.keys.toList())
        engine.stop(); scope.cancel()
    }

    @Test fun remindersLoadListFiredFirstAndNudgeOnce() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val general = server.createChannel("general", alice.id)
        val (message, _) = server.post(general.id, alice.id, "remember me")
        val later = server.remind(alice.id, general.id, message.id, "2026-10-03T00:00:00Z")
        val sooner = server.remind(alice.id, general.id, message.id, "2026-10-02T00:00:00Z", "reply")
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(alice.id), server.connector(alice.id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}))
        val nudges = ArrayList<String>()
        engine.onReminder = { nudges += it.id }
        engine.start(); settle(engine)
        assertEquals(listOf(sooner.id, later.id), store.listReminders().map { it.id })
        val fired = sooner.copy(status = "fired", firedAt = "2026-10-02T00:00:00Z")
        server.emitReminder(alice.id, fired); server.emitReminder(alice.id, fired); settle(engine) // replayed event
        assertEquals(listOf(sooner.id), nudges)
        assertEquals(1, store.firedReminderCount())
        assertEquals(listOf("fired", "pending"), store.listReminders().map { it.status })
        server.emitReminder(alice.id, sooner.copy(status = "done")); server.emitReminder(alice.id, later.copy(status = "cancelled")); settle(engine)
        assertTrue(store.listReminders().isEmpty())
        engine.stop(); scope.cancel()
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
        // Codex audit C3: a failed row stays, first, with its error, until it is dismissed.
        val third = server.schedule(alice.id, general.id, "never lands", "2026-10-04T00:00:00Z")
        val fourth = server.schedule(alice.id, general.id, "fine", "2026-10-01T00:00:00Z")
        server.emitScheduled(alice.id, fourth)
        server.emitScheduled(alice.id, third.copy(status = "failed", error = "channel_archived")); settle(engine)
        assertEquals(listOf("never lands" to "failed", "fine" to "pending"), store.listScheduled().map { it.body to it.status })
        server.emitScheduled(alice.id, third.copy(status = "cancelled", error = "channel_archived")); settle(engine)
        assertEquals(listOf("fine"), store.listScheduled().map { it.body })
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

    @Test fun channelSettingsKeepMyRoleAndHideChannelsMadePrivate() = runBlocking { // M15
        val server = FakeServer()
        val alice = server.addUser("alice"); val bob = server.addUser("bob")
        val general = server.createChannel("general", alice.id)
        val owner = Store(); val outsider = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engines = listOf(alice.id to owner, bob.id to outsider).map { (id, store) ->
            SyncEngine(server.api(id), server.connector(id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}))
        }
        engines.forEach { it.start(); settle(it) }
        assertEquals("owner", owner.channel(general.id)?.channel?.membership?.role)
        assertEquals(false, outsider.channel(general.id)?.isMember)

        server.updateChannel(general.id, postingPolicy = "owners"); engines.forEach { settle(it) }
        assertEquals(true, owner.channel(general.id)?.channel?.isAnnouncement)
        assertEquals(true, owner.channel(general.id)?.canPostTopLevel(isAdmin = false)) // the event carries no membership

        server.updateChannel(general.id, type = "private"); engines.forEach { settle(it) }
        assertEquals("private", owner.channel(general.id)?.channel?.type)
        assertNull(outsider.channel(general.id))
        engines.forEach { it.stop() }; scope.cancel()
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

    // --- SYNC_PROTOCOL.md §5.3 / §7.3 / §7.4 / §9 / §10 rules (release review) ------------------------

    @Test fun halfOpenSocketIsDroppedTwoIntervalsAfterTheLastFrame() = runBlocking { // §5.3
        val w = world()
        w.engine.isActive = { true } // heartbeat pings only (one not in use also says so on connecting)
        w.engine.start(); settle(w.engine)
        val first = w.server.socketsOf(w.bob).single()
        w.time.advance(30_000) // ping → pong
        assertEquals(1, first.pings)
        first.halfOpen = true // the network path dies without a close
        w.time.advance(30_000) // this ping goes nowhere; pinging must not push the deadline back
        w.time.advance(29_999)
        assertEquals(EngineStatus.ONLINE, w.engine.status.value)
        assertEquals(0, w.engine.reconnects)
        w.time.advance(1) // 60 s since the last pong: dropped and reconnected
        settle(w.engine)
        assertTrue(first.closed)
        assertEquals(1, w.engine.reconnects)
        assertEquals(EngineStatus.ONLINE, w.engine.status.value)
        assertEquals(1, w.server.socketsOf(w.bob).size)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun refusedTokenIsRenewedAndReconnectedInsteadOfSigningOut() = runBlocking { // §5.3 close 4001
        val w = world()
        val prepared = ArrayList<Boolean>()
        var signedOut = false
        w.engine.onSignedOut = { signedOut = true }
        w.engine.prepareConnection = { refresh -> prepared.add(refresh) }
        w.engine.start(); settle(w.engine)
        // The server refuses the token: an error frame, then close 4001.
        val socket = w.server.socketsOf(w.bob).single()
        socket.deliver(buildJsonObject { put("type", "error"); put("code", "invalid_token"); put("message", "Invalid access token") })
        socket.closeRemote(CLOSE_AUTH_FAILED); settle(w.engine)
        assertEquals(listOf(false, true), prepared)
        assertEquals(EngineStatus.ONLINE, w.engine.status.value)
        assertFalse(signedOut)
        // Only a renewal the server refuses (401) signs out.
        w.engine.prepareConnection = { refresh -> if (refresh) throw ApiException.Api(401, "session_revoked", "revoked") }
        w.server.socketsOf(w.bob).single().closeRemote(CLOSE_AUTH_FAILED); settle(w.engine)
        assertEquals(EngineStatus.SIGNED_OUT, w.engine.status.value)
        assertTrue(signedOut)
        w.scope.cancel()
    }

    @Test fun failedBootstrapLeavesOneReconnectAndOneSocket() = runBlocking { // §5.3
        val w = world()
        w.api.pendingFailure = ApiException.Network(IOException("bootstrap lost")) // the socket is up, bootstrap fails
        w.engine.start(); settle(w.engine)
        assertEquals(EngineStatus.ONLINE, w.engine.status.value)
        assertEquals(1, w.engine.reconnects)
        assertEquals(1, w.server.socketsOf(w.bob).size)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun socketLostBeforeBootstrapFinishesIsNeverReportedOnline() = runBlocking { // §5.3
        val w = world(manualBackoff = true)
        w.server.dropAfterHello = 1 // closes right after hello, while the client bootstraps
        w.engine.start(); settle(w.engine)
        assertEquals(EngineStatus.OFFLINE, w.engine.status.value) // no socket: not "connected"
        assertEquals(1, w.engine.reconnects)
        w.time.advance(1_000) // the one pending reconnect (1 s with this jitter)
        settle(w.engine)
        assertEquals(EngineStatus.ONLINE, w.engine.status.value)
        assertEquals(1, w.engine.reconnects)
        assertEquals(1, w.server.socketsOf(w.bob).size)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun outboxSendsWhatWasQueuedMeanwhileAndRetriesWithBackoff() = runBlocking { // §9
        val w = world()
        w.engine.start(); w.engine.openChannel(w.channelId); settle(w.engine)
        // A send made while another one is in flight returns at once; the running loop sends it next.
        val gate = CompletableDeferred<Unit>()
        w.api.postGate = gate
        val first = async(start = CoroutineStart.UNDISPATCHED) { w.engine.send(w.channelId, "one") }
        w.engine.send(w.channelId, "two")
        assertEquals(2, w.store.outbox.size)
        gate.complete(Unit); first.await(); settle(w.engine)
        assertEquals(0, w.store.outbox.size)
        assertEquals(listOf("one", "two"), w.server.channels.getValue(w.channelId).messages.map { it.body })

        // Temporary failures retry on a timer while online (2 s, then 4 s …) instead of staying pending.
        w.api.postFailures.addAll(listOf(ApiException.Network(IOException("lost")), ApiException.Api(503, "unavailable", "down")))
        w.engine.send(w.channelId, "three")
        w.time.advance(1_999)
        assertEquals(1, w.store.outbox.size)
        w.time.advance(1) // 503 this time: the next wait doubles
        w.time.advance(3_999)
        assertEquals(1, w.store.outbox.size)
        w.time.advance(1); settle(w.engine)
        assertEquals(0, w.store.outbox.size)
        assertEquals("three", w.server.channels.getValue(w.channelId).messages.last().body)

        // A refusal is kept as failed (再送 / 破棄) and the queue goes on.
        w.api.postFailures.add(ApiException.Api(409, "channel_archived", "archived"))
        w.engine.send(w.channelId, "four")
        w.engine.send(w.channelId, "five"); settle(w.engine)
        assertEquals(listOf("four" to "channel_archived"), w.store.outbox.map { it.body to it.failed })
        assertEquals("five", w.server.channels.getValue(w.channelId).messages.last().body)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun scrollBackPagesFromTheLoadedRangeNotFromOldRowsThatArrivedLater() = runBlocking { // §7.3
        val w = world(pageSize = 3)
        val sent = (1..6).map { w.server.post(w.channelId, w.alice, "m$it").first }
        w.engine.start(); w.engine.openChannel(w.channelId); settle(w.engine)
        assertEquals(listOf("m4", "m5", "m6"), w.store.messages(w.channelId).map { it.body })
        assertEquals(4, w.store.channel(w.channelId)?.oldestLoadedSeq)
        // Old rows arrive from outside the range: a reaction on m1 (live) and a reply bumping m2 (in the delta after a restart).
        w.server.react(w.channelId, w.alice, sent[0].id, "👍", present = true); settle(w.engine)
        w.engine.stop()
        w.server.post(w.channelId, w.alice, "reply", parentId = sent[1].id)
        w.engine.start(); settle(w.engine)
        assertNotNull(w.store.message(w.channelId, sent[0].id)) // stored…
        assertNotNull(w.store.message(w.channelId, sent[1].id))
        assertEquals(listOf("m4", "m5", "m6"), w.store.messages(w.channelId).map { it.body }) // …but not shown (m3 would be missing in between)
        w.engine.loadOlder(w.channelId) // pages from seq 4, not from m1
        assertEquals(listOf("m1", "m2", "m3", "m4", "m5", "m6"), w.store.messages(w.channelId).map { it.body })
        assertEquals(0, w.store.channel(w.channelId)?.oldestLoadedSeq)
        assertEquals(false, w.store.channel(w.channelId)?.hasOlder)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun bootstrapReadStateWinsAndUnsentReadMarksAreSentAgain() = runBlocking { // §10
        val w = world()
        w.engine.isActive = { true }
        listOf("m1", "m2", "m3").forEach { w.server.post(w.channelId, w.alice, it) }
        w.engine.start(); w.engine.openChannel(w.channelId); settle(w.engine)
        // The PUT is lost: the position moved here only. It is kept and sent again after reconnecting.
        w.api.pendingFailure = ApiException.Network(IOException("lost"))
        w.engine.markRead(w.channelId, 3); w.engine.flushReads(); settle(w.engine)
        assertEquals(Triple(3, 0, 3), w.store.channel(w.channelId)!!.let { Triple(it.lastReadSeq, it.unreadCount, it.unsentReadSeq) })
        assertEquals(0, w.server.readState(w.bob, w.channelId).lastReadSeq)
        w.server.disconnect(w.bob); settle(w.engine); w.engine.flushReads(); settle(w.engine)
        assertEquals(EngineStatus.ONLINE, w.engine.status.value)
        assertEquals(3, w.server.readState(w.bob, w.channelId).lastReadSeq)
        assertEquals(Triple(3, 0, null), w.store.channel(w.channelId)!!.let { Triple(it.lastReadSeq, it.unreadCount, it.unsentReadSeq) })
        // Another device marks m2 unread while this one is away: bootstrap moves the position back (no max merge).
        w.engine.stop()
        w.server.markRead(w.bob, w.channelId, 1, mode = "set")
        w.engine.start(); settle(w.engine)
        assertEquals(1 to 2, w.store.channel(w.channelId)!!.let { it.lastReadSeq to it.unreadCount })
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun unsentThreadReadMarkIsSentAgainAfterReconnecting() = runBlocking { // §10 / THREADS.md §5
        val w = world()
        w.engine.isActive = { true }
        w.engine.start(); w.engine.openChannel(w.channelId)
        w.engine.send(w.channelId, "topic"); settle(w.engine)
        val parent = w.server.messageByBody(w.channelId, "topic")
        val (reply, _) = w.server.post(w.channelId, w.alice, "reply", parentId = parent.id)
        w.engine.flushThreads(); settle(w.engine)
        w.engine.loadThreadState(parent.id)
        assertTrue(w.engine.loadReplies(w.channelId, parent.id)) // §10.2: only a fully loaded thread is read
        w.api.pendingFailure = ApiException.Network(IOException("lost"))
        w.engine.markThreadRead(parent.id, reply.seq); w.engine.flushReads(); settle(w.engine)
        assertEquals(0, w.server.threadState(w.bob, parent.id).lastReadSeq)
        assertEquals(reply.seq, w.store.threads[parent.id]?.state?.lastReadSeq) // shown read meanwhile
        w.server.disconnect(w.bob); settle(w.engine); w.engine.flushReads(); settle(w.engine)
        assertEquals(reply.seq, w.server.threadState(w.bob, parent.id).lastReadSeq)
        assertEquals(reply.seq, w.store.threads[parent.id]?.state?.lastReadSeq)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun ownThreadReplyLeavesTheChannelUnread() = runBlocking { // §10
        val w = world()
        val (parent, _) = w.server.post(w.channelId, w.alice, "topic")
        w.server.post(w.channelId, w.alice, "later")
        w.engine.start(); w.engine.openChannel(w.channelId); settle(w.engine)
        assertEquals(0 to 2, w.store.channel(w.channelId)!!.let { it.lastReadSeq to it.unreadCount })
        w.engine.send(w.channelId, "my reply", parentId = parent.id); settle(w.engine)
        assertEquals(0 to 2, w.store.channel(w.channelId)!!.let { it.lastReadSeq to it.unreadCount }) // the thread's position moved, not the channel's
        assertEquals(0, w.server.readState(w.bob, w.channelId).lastReadSeq)
        w.engine.send(w.channelId, "my post"); settle(w.engine) // a top-level post reads the channel
        assertEquals(4 to 0, w.store.channel(w.channelId)!!.let { it.lastReadSeq to it.unreadCount })
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun openThreadFollowsLiveRepliesWithoutTheChannelTimeline() = runBlocking { // §7.4
        val w = world()
        val (parent, _) = w.server.post(w.channelId, w.alice, "topic")
        w.server.post(w.channelId, w.alice, "<@${w.bob}> first", parentId = parent.id) // bob now follows the thread
        w.engine.start(); settle(w.engine) // the channel itself is never opened: no timeline
        w.engine.loadThreads("all")
        w.engine.loadReplies(w.channelId, parent.id) // opened from the threads list
        w.server.post(w.channelId, w.alice, "second", parentId = parent.id); settle(w.engine)
        assertEquals(listOf("<@${w.bob}> first", "second"), w.store.replies(w.channelId, parent.id).map { it.body })
        assertEquals(2, w.store.message(w.channelId, parent.id)?.replyCount)
        assertNull(w.store.channel(w.channelId)?.syncedSeq)
        assertTrue(w.store.messages(w.channelId).isEmpty()) // still no timeline
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun threadListIsRefreshedOnceTheReconnectIsOnline() = runBlocking { // THREADS.md §6
        val w = world()
        w.engine.start(); w.engine.openChannel(w.channelId)
        w.engine.send(w.channelId, "topic"); settle(w.engine)
        val parent = w.server.messageByBody(w.channelId, "topic")
        w.server.post(w.channelId, w.alice, "reply 1", parentId = parent.id); w.engine.flushThreads(); settle(w.engine)
        w.engine.loadThreads("all")
        assertEquals(1, w.store.threads[parent.id]?.state?.unreadCount)
        w.engine.stop()
        w.server.post(w.channelId, w.alice, "reply 2", parentId = parent.id) // missed while away
        w.engine.start(); w.engine.flushThreads(); settle(w.engine)
        assertEquals(2, w.store.threads[parent.id]?.state?.unreadCount)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun newTopLevelPostsMoveTheConversationUpTheList() = runBlocking { // §7.4 (DM order)
        val w = world()
        val dm = w.server.createChannel("", w.alice, "dm")
        w.server.join(dm.id, w.bob)
        w.engine.start(); settle(w.engine)
        assertNull(w.store.channel(dm.id)?.channel?.lastMessageAt)
        val (message, _) = w.server.post(dm.id, w.alice, "hi"); settle(w.engine)
        assertEquals(message.createdAt, w.store.channel(dm.id)?.channel?.lastMessageAt)
        w.server.post(dm.id, w.alice, "in a thread", parentId = message.id); settle(w.engine)
        assertEquals(message.createdAt, w.store.channel(dm.id)?.channel?.lastMessageAt) // replies do not reorder
        // M28c: a reply also sent to the channel is in the timeline, so it reorders like a post (desktop, iOS).
        val (shared, _) = w.server.post(dm.id, w.alice, "shared reply", parentId = message.id, options = SendOptions(alsoInChannel = true)); settle(w.engine)
        assertEquals(shared.createdAt, w.store.channel(dm.id)?.channel?.lastMessageAt)
        w.engine.stop(); w.scope.cancel()
    }

    // --- M28c (the Android audit and the cross-client spec audit) ----------------------------------------

    @Test fun closingTheConversationEndsTheHoldAndAnnouncesItsMentionsAgain() = runBlocking { // §7.7 / §10
        val w = world()
        w.engine.isActive = { true }
        listOf("m1", "m2", "m3").forEach { w.server.post(w.channelId, w.alice, it) }
        w.engine.start(); w.engine.openChannel(w.channelId); settle(w.engine)
        assertEquals(w.channelId, w.engine.currentChannelId)
        assertEquals(1, w.engine.markUnread(w.channelId, 2)); settle(w.engine)
        assertNotNull(w.engine.heldUnread(w.channelId))
        w.server.post(w.channelId, w.alice, "hey <@${w.bob}> (open)"); settle(w.engine)
        assertEquals(0, w.notifications.size) // the conversation on screen is not announced
        w.engine.closeConversation(); settle(w.engine)
        assertNull(w.engine.currentChannelId)
        assertNull(w.engine.heldUnread(w.channelId))
        w.server.post(w.channelId, w.alice, "hey <@${w.bob}> (closed)"); settle(w.engine)
        assertEquals(listOf("hey <@${w.bob}> (closed)"), w.notifications)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun a401AfterTheRefreshIsTemporaryForReadMarksAndSends() = runBlocking { // §7.2 / §9 / §10
        val w = world()
        w.engine.isActive = { true }
        w.server.post(w.channelId, w.alice, "m1")
        w.engine.start(); w.engine.openChannel(w.channelId); settle(w.engine)
        // The read mark waits for the reconnect (which renews the token) instead of being dropped as refused.
        w.api.pendingFailure = ApiException.Api(401, "token_expired", "expired")
        w.engine.markRead(w.channelId, 1); w.engine.flushReads(); settle(w.engine)
        assertEquals(1, w.store.channel(w.channelId)?.unsentReadSeq)
        assertEquals(0, w.server.readState(w.bob, w.channelId).lastReadSeq)
        // The send stays queued (not failed) and goes out on the retry timer.
        w.api.postFailures.add(ApiException.Api(401, "token_expired", "expired"))
        w.engine.send(w.channelId, "kept")
        assertEquals(listOf("kept" to null), w.store.outbox.map { it.body to it.failed })
        w.time.advance(2_000); settle(w.engine)
        assertEquals(0, w.store.outbox.size)
        assertEquals("kept", w.server.channels.getValue(w.channelId).messages.last().body)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun anUnsentReadMarkIsAppliedOverTheBootstrapBeforeItIsSentAgain() = runBlocking { // §10
        val w = world()
        w.engine.isActive = { true }
        listOf("m1", "m2", "m3").forEach { w.server.post(w.channelId, w.alice, it) }
        w.engine.start(); w.engine.openChannel(w.channelId); settle(w.engine)
        w.api.pendingFailure = ApiException.Network(IOException("lost"))
        w.engine.markRead(w.channelId, 3); w.engine.flushReads(); settle(w.engine)
        assertEquals(Triple(3, 0, 3), w.store.channel(w.channelId)!!.let { Triple(it.lastReadSeq, it.unreadCount, it.unsentReadSeq) })
        // The reconnect's bootstrap says 0 read / 3 unread; while the resend is still on its way the rows do not flash unread.
        w.engine.stop()
        val gate = CompletableDeferred<Unit>()
        w.api.readGate = gate
        w.engine.start(); settle(w.engine)
        assertEquals(EngineStatus.ONLINE, w.engine.status.value)
        assertEquals(Triple(3, 0, 3), w.store.channel(w.channelId)!!.let { Triple(it.lastReadSeq, it.unreadCount, it.unsentReadSeq) })
        gate.complete(Unit); settle(w.engine)
        assertEquals(3, w.server.readState(w.bob, w.channelId).lastReadSeq)
        assertEquals(Triple(3, 0, null), w.store.channel(w.channelId)!!.let { Triple(it.lastReadSeq, it.unreadCount, it.unsentReadSeq) })
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun aPushForAnotherConversationCatchesItUpWhenItsRowIsMissing() = runBlocking { // PUSH_NOTIFICATIONS.md §9
        val w = world()
        val other = w.server.createChannel("random", w.alice).id.also { w.server.join(it, w.bob) }
        w.engine.start(); w.engine.openChannel(w.channelId); settle(w.engine)
        w.server.socketsOf(w.bob).forEach { it.dropNext = 1 }
        val (lost, _) = w.server.post(other, w.alice, "lost event"); settle(w.engine)
        assertNull(w.store.message(other, lost.id))
        // The open conversation catches up as before (reconnectNow), and the push's own conversation with it.
        val before = w.engine.catchUps
        w.engine.pushReceived(other, lost.id); settle(w.engine)
        assertEquals(before + 2, w.engine.catchUps)
        assertEquals("lost event", w.store.message(other, lost.id)?.body)
        w.engine.pushReceived(other, lost.id); settle(w.engine) // the row is here: only the open conversation again
        assertEquals(before + 3, w.engine.catchUps)
        w.engine.stop(); w.scope.cancel()
    }
}
