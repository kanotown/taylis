package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.SystemEventOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.api.WorkspaceSettingsOut
import jp.chikuwachat.android.sync.AddMembers
import jp.chikuwachat.android.sync.ChannelPreview
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncApi
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.PreviewJoin
import jp.chikuwachat.android.ui.SystemMessages
import jp.chikuwachat.android.ui.Timeline
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * M89 (docs/MEMBERSHIP.md §5): the join / leave lines (type "system" + system_event) and the two workspace switches on
 * Android. The line's text follows the desktop's `systemMessageText` (apps/desktop/tests/membership.test.tsx).
 */
class MembershipTest {
    private val names = mapOf("a" to "Alice", "b" to "Bob", "c" to "Carol")
    private val nameOf: (String) -> String? = { names[it] }

    private fun text(kind: String, actor: String, users: List<String>, body: String = "body") =
        SystemMessages.text(body, SystemEventOut(kind, actor, users), nameOf)

    // --- §5 item 2: the line ------------------------------------------------------------------

    @Test fun writesEachKindFromTheDirectorysNames() {
        assertEquals("Alice が参加しました", text("member_joined", "a", listOf("a")))
        assertEquals("Alice が退出しました", text("member_left", "a", listOf("a")))
        assertEquals("Alice が Bob、Carol を追加しました", text("members_added", "a", listOf("b", "c")))
        assertEquals("Alice が Bob を外しました", text("member_removed", "a", listOf("b")))
    }

    @Test fun fallsBackToTheBody() {
        assertEquals("old line", SystemMessages.text("old line", null, nameOf)) // no event (before M88)
        assertEquals("new kind", text("channel_renamed", "a", emptyList(), body = "new kind")) // a kind this version does not know
        assertEquals("Alice が Zed を追加しました", text("members_added", "a", listOf("zz"), body = "Alice が Zed を追加しました")) // not in the directory
        assertEquals("Zed が参加しました", text("member_joined", "zz", listOf("zz"), body = "Zed が参加しました"))
    }

    @Test fun usesTheStoresNamesIncludingMine() {
        val store = Store()
        store.upsertUser(user("b", "Bob"))
        val row = MessageState.from(systemRow("m1", "c1", SystemEventOut("members_added", "b", listOf("b")), "old"))
        assertEquals("Bob が Bob を追加しました", SystemMessages.text(row, store))
        store.upsertUser(user("b", "Robert")) // a rename: the line follows
        assertEquals("Robert が Robert を追加しました", SystemMessages.text(row, store))
    }

    @Test fun isNeverGroupedWithPeoplesPosts() {
        val post = MessageState.from(MessageOut(id = "p", channelId = "c", senderId = "a", seq = 1, updatedSeq = 1, body = "hi", createdAt = "2026-10-03T00:00:00Z", deleted = false))
        val line = MessageState.from(systemRow("s", "c", SystemEventOut("member_joined", "a", listOf("a")), "Alice が参加しました").copy(seq = 2, createdAt = "2026-10-03T00:00:10Z"))
        val next = MessageState.from(MessageOut(id = "q", channelId = "c", senderId = "a", seq = 3, updatedSeq = 3, body = "again", createdAt = "2026-10-03T00:00:20Z", deleted = false))
        assertTrue(line.isSystem)
        assertFalse(Timeline.continues(post, line))
        assertFalse(Timeline.continues(line, next))
        assertFalse(Timeline.continues(line, line.copy(id = "s2")))
    }

    // --- §5 item 1: decoded and kept ------------------------------------------------------------

    @Test fun decodesTheEventAndKeepsItInTheLocalRow() {
        val json = """{"id":"m","channel_id":"c","sender_id":"a","seq":4,"updated_seq":4,"type":"system","body":"Alice が参加しました",
            |"system_event":{"kind":"member_joined","actor_id":"a","user_ids":["a"]},"created_at":"2026-10-03T00:00:00Z","deleted":false}""".trimMargin()
        val message = Codec.snake.decodeFromString(MessageOut.serializer(), json)
        assertEquals(SystemEventOut("member_joined", "a", listOf("a")), message.systemEvent)
        val row = MessageState.from(message)
        // The Room row is the row's JSON (RoomPersistence): the event survives a restart.
        val restored = Codec.plain.decodeFromString(MessageState.serializer(), Codec.plain.encodeToString(MessageState.serializer(), row))
        assertEquals(message.systemEvent, restored.systemEvent)
        assertEquals("system", restored.type)
        // A row persisted before M89 has no event (and decodes).
        val old = Codec.plain.decodeFromString(MessageState.serializer(), """{"id":"m","channelId":"c","senderId":"a","seq":4,"updatedSeq":4,"clientMsgId":null,"body":"x","createdAt":"","type":"system"}""")
        assertNull(old.systemEvent)
    }

    @Test fun bootstrapWithoutSettingsMeansBothOn() {
        val out = Codec.snake.decodeFromString(WorkspaceSettingsOut.serializer(), "{}")
        assertTrue(out.showMembershipMessages)
        assertTrue(out.previewBeforeJoin)
    }

    // --- §5 items 1, 4: live lines, unread and notifications -------------------------------------

    private class World {
        val server = FakeServer()
        val alice: UserPublic = server.addUser("alice")
        val bob: UserPublic = server.addUser("bob")
        val carol: UserPublic = server.addUser("carol")
        val home = server.createChannel("general", alice.id).also { server.join(it.id, bob.id) }
        /** Alice's public channel that Bob has not joined. */
        val open = server.createChannel("open", alice.id).also { channel -> (1..3).forEach { server.post(channel.id, alice.id, "post $it") } }
        val store = Store(MemoryPersistence())
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        private val syncApi: SyncApi = server.api(bob.id)
        val api: FakeServer.Api get() = syncApi as FakeServer.Api
        val engine = SyncEngine(syncApi, server.connector(bob.id), "ws://fake", store, { "token" }, scope, EngineOptions(pageSize = 10, sleep = {}, random = { 0.5 }))
        val notifications = ArrayList<String>()

        init {
            engine.isActive = { false }
            engine.onNotify = { message, _ -> notifications.add(message.body) }
        }

        suspend fun settle() = repeat(10) { engine.idle(); yield() }

        fun close() {
            engine.stop()
            scope.cancel()
        }
    }

    @Test fun aLiveLineIsStoredWithItsEventButIsNeverUnreadNorNotified() = runBlocking {
        val w = World()
        w.server.notificationDefaults[w.bob.id] = "all"
        w.engine.start(); w.settle()
        w.engine.openChannel(w.home.id); w.settle()
        val before = w.store.channel(w.home.id)!!
        val event = SystemEventOut("members_added", w.alice.id, listOf(w.carol.id))
        val line = w.server.postSystem(w.home.id, event, "alice が carol を追加しました"); w.settle()
        val row = w.store.message(w.home.id, line.id)!!
        assertEquals(event, row.systemEvent)
        assertTrue(row.isSystem)
        assertEquals("Alice が Carol を追加しました", SystemMessages.text(row, w.store)) // the directory's names, not the body
        val after = w.store.channel(w.home.id)!!
        assertEquals(line.seq, after.lastSeq)
        assertEquals(before.unreadCount, after.unreadCount)
        assertEquals(before.mentionCount, after.mentionCount)
        assertEquals(before.channel.lastMessageAt, after.channel.lastMessageAt) // the 「最近」 order stays (MEMBERSHIP.md §1)
        assertEquals(emptyList<String>(), w.notifications)
        // A person's post at the same level still notifies.
        w.server.post(w.home.id, w.alice.id, "plain"); w.settle()
        assertEquals(listOf("plain"), w.notifications)
        w.close()
    }

    // --- §5 item 5: the preview switch --------------------------------------------------------

    @Test fun settingsComeFromBootstrapAndTheEvent() = runBlocking {
        val w = World()
        w.server.workspaceSettings = WorkspaceSettingsOut(showMembershipMessages = false, previewBeforeJoin = false)
        w.engine.start(); w.settle()
        assertEquals(WorkspaceSettingsOut(false, false), w.store.workspaceSettings)
        w.server.updateWorkspaceSettings(WorkspaceSettingsOut(true, true)); w.settle()
        assertEquals(WorkspaceSettingsOut(true, true), w.store.workspaceSettings)
        w.close()
    }

    @Test fun previewOffShowsThePanelWithoutFetchingAndFollowsTheSwitchLive() = runBlocking {
        val w = World()
        w.server.workspaceSettings = WorkspaceSettingsOut(previewBeforeJoin = false)
        w.engine.start(); w.settle()
        w.engine.openChannel(w.open.id); w.settle()
        assertEquals(ChannelPreview(w.open.id, disabled = true), w.store.preview)
        assertTrue(w.api.historyCalls.isEmpty()) // the history is not asked for
        assertTrue(PreviewJoin.refused(w.store.preview, w.store.workspaceSettings))

        // Turned on while open: read now.
        w.server.updateWorkspaceSettings(WorkspaceSettingsOut(previewBeforeJoin = true)); w.settle()
        assertEquals(listOf("post 1", "post 2", "post 3"), w.store.preview?.messages?.map { it.body })
        assertFalse(PreviewJoin.refused(w.store.preview, w.store.workspaceSettings))

        // Turned off again: the rows go, the panel shows.
        w.server.updateWorkspaceSettings(WorkspaceSettingsOut(previewBeforeJoin = false)); w.settle()
        assertEquals(ChannelPreview(w.open.id, disabled = true), w.store.preview)

        // Joining from the panel carries on as a member.
        w.server.workspaceSettings = WorkspaceSettingsOut(previewBeforeJoin = false)
        w.server.join(w.open.id, w.bob.id); w.server.emitMembership(w.open.id, w.bob.id); w.settle()
        w.engine.openChannel(w.open.id); w.settle()
        assertNull(w.store.preview)
        assertEquals(3, w.store.messages(w.open.id).size)
        w.close()
    }

    @Test fun aServerRefusalWithPreviewDisabledShowsTheSamePanel() = runBlocking {
        val w = World()
        w.engine.start(); w.settle()
        // Turned off while this device did not hear of it.
        w.server.updateWorkspaceSettings(WorkspaceSettingsOut(previewBeforeJoin = false), announce = false)
        w.engine.openChannel(w.open.id); w.settle()
        assertTrue(w.store.workspaceSettings.previewBeforeJoin) // still the old value here
        assertEquals(ChannelPreview(w.open.id, disabled = true), w.store.preview)
        assertTrue(PreviewJoin.refused(w.store.preview, w.store.workspaceSettings))
        // The next connect brings the setting; turned on again (heard), the preview is read.
        w.engine.stop(); w.engine.start(); w.settle()
        assertFalse(w.store.workspaceSettings.previewBeforeJoin)
        w.server.updateWorkspaceSettings(WorkspaceSettingsOut(previewBeforeJoin = true)); w.settle()
        assertEquals(3, w.store.preview?.messages?.size)
        w.close()
    }

    @Test fun thePanelSaysThePurposeAndTheMemberCount() {
        val channel = ChannelOut(id = "c", type = "public", name = "lab", topic = "topic", purpose = "purpose", memberCount = 4, archived = false, lastSeq = 0, createdAt = "", updatedAt = "")
        assertEquals("purpose", PreviewJoin.about(channel))
        assertEquals("topic", PreviewJoin.about(channel.copy(purpose = " ")))
        assertNull(PreviewJoin.about(channel.copy(purpose = null, topic = null)))
        assertEquals("メンバー 4 人", PreviewJoin.memberLine(channel))
        assertNull(PreviewJoin.memberLine(channel.copy(memberCount = null)))
        assertEquals("参加するとメッセージを読めます", PreviewJoin.REFUSED_TITLE)
        assertFalse(PreviewJoin.refused(ChannelPreview("c"), WorkspaceSettingsOut()))
        assertTrue(PreviewJoin.refused(null, WorkspaceSettingsOut(previewBeforeJoin = false)))
    }

    // --- §5 item 6: adding several people --------------------------------------------------------

    @Test fun addingSeveralPeopleIsOneBatch() = runBlocking {
        val batches = ArrayList<List<String>>()
        val singles = ArrayList<String>()
        AddMembers.add(listOf("a", "b", "a"), batch = { batches.add(it) }, single = { singles.add(it) })
        assertEquals(listOf(listOf("a", "b")), batches)
        assertTrue(singles.isEmpty())
        // More than the endpoint takes: in chunks of 50.
        batches.clear()
        AddMembers.add((1..120).map { "u$it" }, batch = { batches.add(it) }, single = { singles.add(it) })
        assertEquals(listOf(50, 50, 20), batches.map { it.size })
    }

    @Test fun anOlderServerGetsOneRequestPerPerson() = runBlocking {
        val singles = ArrayList<String>()
        AddMembers.add(listOf("a", "b"), batch = { throw ApiException.Api(405, "method_not_allowed", "no") }, single = { singles.add(it) })
        assertEquals(listOf("a", "b"), singles)
        // Any other refusal is the answer (no fallback).
        try {
            AddMembers.add(listOf("a"), batch = { throw ApiException.Api(403, "not_channel_owner", "no") }, single = { fail("no fallback") })
            fail("expected the refusal")
        } catch (e: ApiException.Api) {
            assertEquals(403, e.status)
        }
    }

    private fun user(id: String, name: String) = UserPublic(id = id, username = id, displayName = name, role = "member", createdAt = "", updatedAt = "")

    private fun systemRow(id: String, channelId: String, event: SystemEventOut, body: String) = MessageOut(
        id = id, channelId = channelId, senderId = event.actorId, seq = 1, updatedSeq = 1, type = "system", body = body,
        systemEvent = event, createdAt = "2026-10-03T00:00:00Z", deleted = false,
    )
}
