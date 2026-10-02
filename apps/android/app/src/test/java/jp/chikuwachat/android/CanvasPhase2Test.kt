package jp.chikuwachat.android

import jp.chikuwachat.android.api.CanvasMentioned
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.NotificationPreferenceOut
import jp.chikuwachat.android.api.TaskCreate
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.platform.PushMessage
import jp.chikuwachat.android.sync.CANVAS_PRESENCE_TTL_MS
import jp.chikuwachat.android.sync.CanvasEditor
import jp.chikuwachat.android.sync.CanvasEditors
import jp.chikuwachat.android.sync.CanvasPresenceOut
import jp.chikuwachat.android.sync.CanvasPresenceSender
import jp.chikuwachat.android.sync.ClientFrame
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.ServerFrame
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.CanvasTaskSource
import jp.chikuwachat.android.ui.CanvasTasks
import jp.chikuwachat.android.ui.TaskRules
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M73 (CANVAS.md §18, the phones' part §18.5): canvas mention notices and pushes, 「編集中」 (`canvas_presence`: the
 * sender's throttle, the receivers' 45 s, the frames, the engine with the fake server) and 「タスクにする」 on a checklist
 * item (the desktop's canvasTasks.ts rules), the task's canvas_source.
 */
class CanvasPhase2Test {
    // --- the sender ---------------------------------------------------------------------------------

    @Test fun senderSaysTrueAtOnceThenEvery20SecondsAndNewHeadingsAfter2Seconds() {
        val sender = CanvasPresenceSender()
        assertEquals(CanvasPresenceOut("c1", true, "議題"), sender.next("c1", true, "  議題 ", 0))
        assertNull(sender.next("c1", true, "議題", 1_000)) // the same: nothing
        assertNull(sender.next("c1", true, "議題", 19_999))
        assertEquals(CanvasPresenceOut("c1", true, "議題"), sender.next("c1", true, "議題", 20_000)) // the refresh
        assertNull(sender.next("c1", true, "TODO", 21_000)) // a new heading within 2 s of the last frame waits
        assertEquals(CanvasPresenceOut("c1", true, "TODO"), sender.next("c1", true, "TODO", 22_000))
        // Another canvas is apart.
        assertEquals(CanvasPresenceOut("c2", true, null), sender.next("c2", true, "  ", 22_000))
        assertEquals(listOf("c1", "c2"), sender.editing())
        // A stop only after a start, once.
        assertEquals(CanvasPresenceOut("c1", false, null), sender.next("c1", false, "TODO", 22_100))
        assertNull(sender.next("c1", false, null, 22_200))
        assertNull(sender.next("c3", false, null, 0))
        // A new connection: the next true goes out at once.
        sender.reset()
        assertEquals(CanvasPresenceOut("c2", true, null), sender.next("c2", true, null, 22_300))
    }

    @Test fun senderCutsTheSectionToOneLineOf120Characters() {
        assertEquals("a b", CanvasPresenceSender.normalize(" a \n b "))
        assertEquals(120, CanvasPresenceSender.normalize("あ".repeat(200))!!.length)
        assertNull(CanvasPresenceSender.normalize(null))
    }

    // --- the receivers ------------------------------------------------------------------------------

    @Test fun editorsExpire45SecondsAfterTheirLastRefreshAndEndOnFalse() {
        val editors = CanvasEditors()
        assertTrue(editors.note("c1", "bob", true, "議題", 0))
        assertTrue(editors.note("c1", "carol", true, null, 1_000))
        assertEquals(listOf(CanvasEditor("bob", "議題"), CanvasEditor("carol", null)), editors.of("c1", 2_000))
        assertEquals(CANVAS_PRESENCE_TTL_MS, editors.nextExpiry("c1", 2_000))
        // bob refreshes at 30 s: still there at 60 s, carol (last at 1 s) gone at 46 s.
        editors.note("c1", "bob", true, "TODO", 30_000)
        assertEquals(listOf(CanvasEditor("bob", "TODO")), editors.of("c1", 46_000))
        assertEquals(listOf(CanvasEditor("bob", "TODO")), editors.of("c1", 74_999))
        assertEquals(emptyList<CanvasEditor>(), editors.of("c1", 75_000))
        // A false ends it at once; a false for nobody changes nothing.
        editors.note("c1", "bob", true, null, 80_000)
        assertTrue(editors.note("c1", "bob", false, null, 81_000))
        assertEquals(emptyList<CanvasEditor>(), editors.of("c1", 81_000))
        assertFalse(editors.note("c1", "bob", false, null, 82_000))
        assertNull(editors.nextExpiry("c1", 82_000))
        assertEquals(emptyList<CanvasEditor>(), editors.of("other", 0))
    }

    @Test fun editingLabelNamesOneTwoOrTheFirstAndHowManyMore() {
        assertEquals("", CanvasEditors.label(emptyList()))
        assertEquals("加納 が編集中", CanvasEditors.label(listOf("加納")))
        assertEquals("加納、海老 が編集中", CanvasEditors.label(listOf("加納", "海老")))
        assertEquals("加納 ほか 2 人が編集中", CanvasEditors.label(listOf("加納", "海老", "竹輪")))
    }

    // --- the frames ---------------------------------------------------------------------------------

    @Test fun framesEncodeAndDecodeLeniently() {
        val out = Codec.plain.parseToJsonElement(ClientFrame.canvasPresence(CanvasPresenceOut("c1", true, null))).jsonObject
        assertEquals("canvas_presence", out["type"]!!.jsonPrimitive.content)
        assertEquals("c1", out["canvas_id"]!!.jsonPrimitive.content)
        assertTrue(out["editing"]!!.jsonPrimitive.boolean)
        assertEquals(JsonNull, out["section"]) // said, as null
        val stop = Codec.plain.parseToJsonElement(ClientFrame.canvasPresence(CanvasPresenceOut("c1", false, null))).jsonObject
        assertFalse(stop["editing"]!!.jsonPrimitive.boolean)

        assertEquals(
            ServerFrame.CanvasPresence("c1", "ch", "u2", true, "議題"),
            ServerFrame.parse("""{"type":"canvas_presence","canvas_id":"c1","channel_id":"ch","user_id":"u2","editing":true,"section":"議題"}"""),
        )
        // No section, no channel, a blank section: still read; no `editing` reads as a stop.
        assertEquals(ServerFrame.CanvasPresence("c1", null, "u2", true, null), ServerFrame.parse("""{"type":"canvas_presence","canvas_id":"c1","user_id":"u2","editing":true,"section":" "}"""))
        assertEquals(ServerFrame.CanvasPresence("c1", "ch", "u2", false, null), ServerFrame.parse("""{"type":"canvas_presence","canvas_id":"c1","channel_id":"ch","user_id":"u2","extra":1}"""))
        // Without the canvas or the person it says nothing.
        assertNull(ServerFrame.parse("""{"type":"canvas_presence","user_id":"u2","editing":true}"""))
        assertNull(ServerFrame.parse("""{"type":"canvas_presence","canvas_id":"c1","editing":true}"""))
    }

    // --- the engine with the fake server -------------------------------------------------------------

    private class World(val server: FakeServer, val alice: String, val bob: String, val channelId: String, val store: Store, val engine: SyncEngine, val scope: CoroutineScope, val time: ManualTime)

    private fun world(): World {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        val channel = server.createChannel("general", alice.id)
        server.join(channel.id, bob.id)
        server.canvasChannels["cv1"] = channel.id
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val time = ManualTime()
        val engine = SyncEngine(
            server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "token" }, scope,
            EngineOptions(reconnectMinMs = 0, sleep = {}, random = { 0.5 }, clock = time.clock, timer = time.timer),
        )
        engine.isActive = { false }
        return World(server, alice.id, bob.id, channel.id, store, engine, scope, time)
    }

    private suspend fun settle(engine: SyncEngine) { repeat(20) { engine.idle(); yield() } }

    @Test fun myEditingGoesToTheOtherMembersThrottledAndStopsInTheBackground() = runBlocking {
        val w = world()
        val alice = w.server.connector(w.alice)("ws://fake", "t")
        val received = ArrayList<ServerFrame>()
        alice.onMessage = { text -> ServerFrame.parse(text)?.let { if (it is ServerFrame.CanvasPresence) received.add(it) } }
        alice.send(ClientFrame.auth("t"))
        w.engine.start(); settle(w.engine)

        w.engine.setCanvasEditing("cv1", true, "議題")
        w.engine.setCanvasEditing("cv1", true, "議題") // the same within 20 s: not sent
        assertEquals(1, w.server.canvasPresenceReceived.size)
        assertEquals(listOf(ServerFrame.CanvasPresence("cv1", w.channelId, w.bob, true, "議題")), received)
        w.time.advance(20_000)
        w.engine.setCanvasEditing("cv1", true, "議題") // the refresh
        assertEquals(2, w.server.canvasPresenceReceived.size)
        // The app goes to the background: a false for the canvas, once.
        w.engine.stopCanvasEditing()
        w.engine.stopCanvasEditing()
        assertEquals(3, w.server.canvasPresenceReceived.size)
        assertEquals(ServerFrame.CanvasPresence("cv1", w.channelId, w.bob, false, null), received.last())
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun othersEditingShowsInTheStoreAndEndsOnFalse() = runBlocking {
        val w = world()
        w.engine.start(); settle(w.engine)
        val alice = w.server.connector(w.alice)("ws://fake", "t")
        alice.send(ClientFrame.auth("t"))
        alice.send(ClientFrame.canvasPresence(CanvasPresenceOut("cv1", true, "TODO")))
        settle(w.engine)
        assertEquals(listOf(CanvasEditor(w.alice, "TODO")), w.store.canvasEditors("cv1"))
        assertEquals(emptyList<CanvasEditor>(), w.store.canvasEditors("cv1", System.currentTimeMillis() + CANVAS_PRESENCE_TTL_MS + 1)) // 45 s
        alice.send(ClientFrame.canvasPresence(CanvasPresenceOut("cv1", false, null)))
        settle(w.engine)
        assertEquals(emptyList<CanvasEditor>(), w.store.canvasEditors("cv1"))
        // A canvas of a conversation I am not in never reaches me (the server drops it).
        w.server.canvasChannels["cv2"] = w.server.createChannel("secret", w.alice, type = "private").id
        alice.send(ClientFrame.canvasPresence(CanvasPresenceOut("cv2", true, null)))
        settle(w.engine)
        assertEquals(emptyList<CanvasEditor>(), w.store.canvasEditors("cv2"))
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun aCanvasMentionIsSaidUnlessTheConversationIsMutedOrNone() = runBlocking {
        val w = world()
        val said = ArrayList<CanvasMentioned>()
        w.engine.onCanvasMention = { mention, _ -> said.add(mention) }
        w.engine.start(); w.engine.openChannel(w.channelId); settle(w.engine)
        w.server.emitCanvasMentioned(w.bob, "cv1", w.channelId, "議事録", w.alice)
        settle(w.engine)
        assertEquals(listOf("議事録"), said.map { it.title })
        assertEquals(w.alice, said.single().byUserId)
        // Muted: nothing.
        w.server.emitNotificationPreference(w.bob, NotificationPreferenceOut(w.channelId, "all", null, followsDefault = true, muted = true)); settle(w.engine)
        w.server.emitCanvasMentioned(w.bob, "cv1", w.channelId, "議事録", w.alice)
        settle(w.engine)
        assertEquals(1, said.size)
        // Level 「なし」: nothing; 「メンションのみ」: said (it is a mention).
        w.server.emitNotificationPreference(w.bob, NotificationPreferenceOut(w.channelId, "none", "none", followsDefault = false, muted = false)); settle(w.engine)
        w.server.emitCanvasMentioned(w.bob, "cv1", w.channelId, "議事録", w.alice)
        settle(w.engine)
        assertEquals(1, said.size)
        w.server.emitNotificationPreference(w.bob, NotificationPreferenceOut(w.channelId, "mentions", "mentions", followsDefault = false, muted = false)); settle(w.engine)
        w.server.emitCanvasMentioned(w.bob, "cv1", w.channelId, "週報", w.alice)
        settle(w.engine)
        assertEquals(listOf("議事録", "週報"), said.map { it.title })
        // A conversation I am not in: nothing.
        w.server.emitCanvasMentioned(w.bob, "cv9", "no-such-channel", "x", w.alice)
        settle(w.engine)
        assertEquals(2, said.size)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun mentionTextIsWordedLikeThePush() {
        val mention = CanvasMentioned("cv1", "c-lab", title = "議事録", byUserId = "u-bob")
        val names = mapOf("u-bob" to "海老")
        assertEquals("海老 が「議事録」であなたをメンションしました (#c-lab)", CanvasTasks.mentionText(mention, TaskFixtures.channel("c-lab"), names::get))
        assertEquals("メンバー が「議事録」であなたをメンションしました", CanvasTasks.mentionText(mention, TaskFixtures.channel("d1", type = "dm"), { null }))
        // Lenient: only the canvas and its conversation are needed.
        val decoded = Codec.snake.decodeFromString(CanvasMentioned.serializer(), """{"canvas_id":"cv1","channel_id":"c1","future":true}""")
        assertEquals(CanvasMentioned("cv1", "c1"), decoded)
    }

    @Test fun aCanvasPushOpensTheCanvasOnePerCanvas() {
        val push = PushMessage.parse(mapOf("kind" to "canvas", "channel_id" to "c1", "canvas_id" to "cv1", "title" to "キャンバス", "subtitle" to "#lab", "body" to "b"))!!
        assertTrue(push.isCanvas)
        assertTrue(push.shown)
        assertEquals("cv1", push.canvasId)
        assertEquals("canvas:cv1", push.notificationKey)
        assertEquals("canvas:x", PushMessage.parse(mapOf("kind" to "canvas", "channel_id" to "c1", "canvas_id" to "cv1", "collapse_key" to "canvas:x"))!!.notificationKey)
        assertFalse(PushMessage.parse(mapOf("kind" to "canvas", "channel_id" to "c1"))!!.isCanvas)
        assertNull(PushMessage.parse(mapOf("kind" to "message", "channel_id" to "c1"))!!.canvasId)
    }

    // --- 「タスクにする」 -------------------------------------------------------------------------------

    private val kano = UserPublic("0190a000-0000-7000-8000-000000000001", "kano", "加納", "member", null, "t", "t")
    private val ebi = UserPublic("0190a000-0000-7000-8000-000000000002", "ebi", "海老", "member", null, "t", "t")
    private val users = mapOf(kano.id to kano, ebi.id to ebi)
    private val ghost = "0190a000-0000-7000-8000-00000000dead"

    @Test fun checklistItemsAreFoundByTheirLine() {
        val body = "# 議事録\n- [ ] 資料を作る\n  * [x] 済んだ\n- 箇条書き\n- [ ]"
        assertEquals(CanvasTasks.Item("- [ ] 資料を作る", "資料を作る", false), CanvasTasks.checklistItem(body, 1))
        assertEquals(CanvasTasks.Item("  * [x] 済んだ", "済んだ", true), CanvasTasks.checklistItem(body, 2))
        assertNull(CanvasTasks.checklistItem(body, 0))
        assertNull(CanvasTasks.checklistItem(body, 3))
        assertEquals("", CanvasTasks.checklistItem(body, 4)!!.text)
        assertNull(CanvasTasks.checklistItem(body, 9))
    }

    @Test fun aChannelCanvasItemGoesToTheBoardWithItsDueDateAndAssignees() {
        val line = "- [ ] **資料**を作る <@${kano.id}> <@${ghost}> <@${kano.id}> 📅 2026-10-09"
        val body = "# 議事録\n$line"
        val init = CanvasTasks.taskInit("cv1", body, 1, TaskFixtures.channel("c-lab"), users, emptyMap(), isAdmin = false)!!
        assertEquals("資料を作る @加納 @メンバー @加納", init.title)
        assertEquals("2026-10-09", init.dueOn)
        assertEquals(listOf(kano.id), init.assigneeIds) // known people only, once; groups are not expanded
        assertEquals("c-lab", init.channelId)
        assertEquals(listOf("c-lab"), init.boardChoices)
        assertNull(init.dmChannelId)
        assertEquals("cv1", init.sourceCanvasId)
        assertEquals(line, init.sourceCanvasLine)
        assertEquals("資料を作る @加納 @メンバー @加納 📅 2026-10-09", init.sourceCanvasExcerpt)
        // Not a checklist item: nothing.
        assertNull(CanvasTasks.taskInit("cv1", body, 0, TaskFixtures.channel("c-lab"), users, emptyMap(), isAdmin = false))
    }

    @Test fun aDmCanvasItemIsMineSharedOnceSomeoneIsAssignedAndABoardIMayNotUseIsMineAlone() {
        val body = "- [ ] 確認 <@${ebi.id}> 📅 2026-02-30"
        val dm = CanvasTasks.taskInit("cv1", body, 0, TaskFixtures.channel("d1", type = "dm"), users, emptyMap(), isAdmin = false)!!
        assertNull(dm.channelId)
        assertEquals("d1", dm.dmChannelId)
        assertEquals(listOf(ebi.id), dm.assigneeIds)
        assertEquals("", dm.dueOn) // not a real date
        assertEquals("確認 @海老", dm.title) // the 📅 is taken out of the title either way (the desktop's rule)
        // An announcement channel where only owners post: 「自分のタスク」, nobody assigned.
        val restricted = TaskFixtures.channel("c-news", postingPolicy = "owners")
        val mine = CanvasTasks.taskInit("cv1", body, 0, restricted, users, emptyMap(), isAdmin = false)!!
        assertNull(mine.channelId)
        assertNull(mine.dmChannelId)
        assertEquals(emptyList<String>(), mine.assigneeIds)
        assertEquals(emptyList<String>(), mine.boardChoices)
    }

    @Test fun sectionAtIsTheCaretsHeading() {
        val text = "前書き\n# 議題\n本文\n## TODO\n- [ ] a"
        assertNull(CanvasTasks.sectionAt(text, 2))
        assertEquals("議題", CanvasTasks.sectionAt(text, text.indexOf("本文")))
        assertEquals("TODO", CanvasTasks.sectionAt(text, text.length))
        assertEquals("TODO", CanvasTasks.sectionAt(text, 10_000))
    }

    // --- the task's canvas_source --------------------------------------------------------------------

    private fun decodeTask(json: String): TaskOut = Codec.snake.decodeFromString(TaskOut.serializer(), json)

    @Test fun canvasSourceDecodesLenientlyAndSaysLinkDeletedOrNone() {
        val base = """"id":"t1","title":"資料""""
        val linked = decodeTask("""{$base,"canvas_source":{"canvas_id":"cv1","excerpt":"資料を作る"}}""")
        assertEquals(CanvasTaskSource.Link("cv1", "資料を作る"), TaskRules.canvasSourceState(linked))
        val purged = decodeTask("""{$base,"canvas_source":{"canvas_id":null,"excerpt":"資料を作る"}}""")
        assertEquals(CanvasTaskSource.Deleted("資料を作る"), TaskRules.canvasSourceState(purged))
        assertEquals(CanvasTaskSource.Deleted(null), TaskRules.canvasSourceState(decodeTask("""{$base,"canvas_source":{}}""")))
        assertEquals(CanvasTaskSource.None, TaskRules.canvasSourceState(decodeTask("""{$base,"canvas_source":null}""")))
        assertEquals(CanvasTaskSource.None, TaskRules.canvasSourceState(decodeTask("""{$base}""")))
        // Apart from `source` (a message): a canvas task has none.
        assertNull(linked.source)
    }

    @Test fun createSendsTheCanvasAndItsLine() {
        val json = Codec.snake.encodeToJsonElement(TaskCreate.serializer(), TaskCreate(title = "資料", sourceCanvasId = "cv1", sourceCanvasLine = "- [ ] 資料")) as JsonObject
        assertEquals("cv1", json["source_canvas_id"]!!.jsonPrimitive.content)
        assertEquals("- [ ] 資料", json["source_canvas_line"]!!.jsonPrimitive.content)
        assertFalse(json.containsKey("source_message_id"))
        val plain = Codec.snake.encodeToJsonElement(TaskCreate.serializer(), TaskCreate(title = "資料")) as JsonObject
        assertFalse(plain.containsKey("source_canvas_id"))
        assertNotNull(plain["title"])
    }
}
