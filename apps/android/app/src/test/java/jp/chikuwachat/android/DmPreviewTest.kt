package jp.chikuwachat.android

import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.LastMessageOut
import jp.chikuwachat.android.api.MembershipOut
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.ReactionOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncApi
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.lastMessageOf
import jp.chikuwachat.android.ui.previewExcerpt
import jp.chikuwachat.android.ui.previewLine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * M49: the DM list's preview (MOBILE_UI.md §6.3 / §7.1, SYNC_PROTOCOL.md §7.8): the rule against the cases every client
 * shares (apps/shared/dm-preview.json), how the Store keeps `last_message` current, and the engine with the fake server.
 */
class DmPreviewTest {
    /** The file the other clients test against: from the module (apps/android/app), ../../shared. */
    private val vectors: JsonObject by lazy {
        val file = File("../../shared/dm-preview.json")
        check(file.isFile) { "apps/shared/dm-preview.json not found from ${File("").absolutePath}" }
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun JsonObject.text(key: String) = this[key]!!.jsonPrimitive.content
    private fun JsonObject.list(key: String) = this[key]!!.let { if (it is JsonNull) null else it.jsonArray.map { v -> v.jsonPrimitive.content } }

    private val users: Map<String, UserPublic> by lazy {
        vectors["users"]!!.jsonObject.mapValues { (id, name) -> UserPublic(id, id, name.jsonPrimitive.content, "member", null, "", "") }
    }
    private val groups: Map<String, GroupOut> by lazy {
        vectors["groups"]!!.jsonObject.mapValues { (id, name) -> GroupOut(id, name.jsonPrimitive.content, createdBy = "", createdAt = "", updatedAt = "") }
    }

    // --- the shared cases ------------------------------------------------------------------------------------------

    @Test fun sharedExcerptCases() {
        val cases = vectors["excerpt"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.size > 10)
        cases.forEach { case ->
            assertEquals(case.text("name"), case.text("excerpt"), previewExcerpt(case.text("body"), case.list("attachments")!!, users, groups))
        }
    }

    @Test fun sharedLineCases() {
        val me = vectors.text("me")
        val cases = vectors["line"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.size > 5)
        cases.forEach { case ->
            val last = (case["last_message"] as? JsonObject)?.let { LastMessageOut(id = "m", senderId = it.text("sender_id"), type = it.text("type"), seq = 1, excerpt = it.text("excerpt")) }
            assertEquals(case.text("name"), case.text("line"), previewLine(case.text("type"), case.list("dm_user_ids"), last, me, users))
        }
    }

    /** The prefix rule on the row's own inputs: a blank display name reads 「メンバー」, no me (signed out) never says あなた. */
    @Test fun prefixRuleEdges() {
        val last = LastMessageOut(id = "m", senderId = "you", seq = 1, excerpt = "hi")
        val blank = mapOf("you" to UserPublic("you", "you", "  ", "member", null, "", ""))
        assertEquals("メンバー: hi", previewLine("group_dm", listOf("me", "you", "x"), last, "me", blank))
        assertEquals("hi", previewLine("dm", listOf("me", "you"), last, null, blank))
        assertEquals("あなた：hi", previewLine("private", null, last.copy(senderId = "me"), "me", blank))
        assertEquals("hi", previewLine("dm", listOf("me"), last.copy(senderId = "me"), "me", blank)) // my own DM
        assertEquals("", previewLine("dm", listOf("me", "you"), null, "me", blank))
    }

    // --- the store -----------------------------------------------------------------------------------------------

    private val me = "me"
    private var seqCounter = 0

    private fun dm(lastMessage: LastMessageOut? = null, name: String? = null) = ChannelOut(
        id = "d", type = "dm", name = name, archived = false, lastSeq = 0, createdAt = "", updatedAt = "",
        membership = MembershipOut("member", ""), dmUserIds = listOf(me, "you"), lastMessage = lastMessage,
    )

    private fun message(seq: Int, body: String, channelId: String = "d", parentId: String? = null, alsoInChannel: Boolean = false, deleted: Boolean = false, attachments: List<AttachmentOut> = emptyList(), editedAt: String? = null, reactions: List<ReactionOut> = emptyList()) =
        MessageOut(
            id = "m$seq", channelId = channelId, senderId = "you", seq = seq, updatedSeq = seq + ++seqCounter * 1000, parentId = parentId, alsoInChannel = alsoInChannel,
            body = body, attachments = attachments, createdAt = "2026-09-30T10:00:${seq.toString().padStart(2, '0')}Z", editedAt = editedAt, deleted = deleted, reactions = reactions,
        )

    private fun Store.last(): LastMessageOut? = channel("d")?.channel?.lastMessage

    private fun storeWith(held: LastMessageOut?): Store = Store().also { it.upsertChannel(dm(held), isMember = true, replaceLastMessage = true) }

    @Test fun anAnswerThatSaysNothingKeepsItBootstrapReplacesItNullToo() {
        val held = lastMessageOf(MessageState.from(message(3, "held")), emptyMap())
        val store = storeWith(held)
        store.upsertChannel(dm(name = "renamed")) // a PATCH answer, channel.updated …: null = not said
        assertEquals(held, store.last())
        store.upsertChannel(dm(held.copy(excerpt = "fresh"))) // GET /channels/{id}, POST /dms
        assertEquals("fresh", store.last()?.excerpt)
        store.upsertChannel(dm(), isMember = true, replaceLastMessage = true) // bootstrap: nothing left
        assertNull(store.last())
    }

    @Test fun aNewerTimelineMessageTakesItsPlaceOthersDoNot() {
        val store = storeWith(null)
        store.upsertMessage(message(2, "two"))
        assertEquals("two", store.last()?.excerpt)
        store.upsertMessage(message(1, "older (a history page)"))
        store.upsertMessage(message(3, "only in the thread", parentId = "m2"))
        store.applyLastMessage(MessageState.placeholder("c", "d", me, "pending", "2026-09-30T10:00:59Z"))
        assertEquals("m2", store.last()?.id)
        store.upsertMessage(message(4, "also in the channel", parentId = "m2", alsoInChannel = true))
        assertEquals(LastMessageOut("m4", "you", "user", 4, "also in the channel", false, "2026-09-30T10:00:04Z"), store.last())
        val image = AttachmentOut("a", "p.png", "image/png", 1, 1, 1, hasThumbnail = true)
        store.upsertMessage(message(5, "", attachments = listOf(image)))
        assertEquals("画像を送信しました", store.last()?.excerpt)
        assertEquals(true, store.last()?.hasAttachments)

        // A public channel I have not joined (a preview's row) keeps none.
        store.upsertChannel(dm().copy(id = "p", type = "public", name = "p", dmUserIds = null, membership = null), isMember = false)
        store.upsertMessage(message(7, "a preview's row", channelId = "p"))
        assertNull(store.channel("p")?.channel?.lastMessage)
    }

    @Test fun anEditOfTheOneShownBringsItsTextAReactionAloneChangesNothing() {
        val store = storeWith(null)
        val you = "00000000-0000-7000-8000-0000000000a1"
        store.upsertUser(UserPublic(you, "you", "相手", "member", null, "", ""))
        store.upsertMessage(message(2, "before"))
        store.upsertMessage(message(2, "after <@$you>", editedAt = "x"))
        assertEquals("after @相手", store.last()?.excerpt)
        val version = store.version.value
        store.upsertMessage(message(2, "after <@$you>", editedAt = "x", reactions = listOf(ReactionOut("👍", 1, listOf(me)))))
        assertEquals(version + 1, store.version.value) // the row's own change, not a second one for the preview
    }

    @Test fun deletingTheOneShownFallsBackToTheNewestLiveRowHeldBelow() {
        val store = storeWith(null)
        val stale = ArrayList<String>()
        store.onStalePreview = { stale.add(it) }
        listOf(1, 2, 3).forEach { store.upsertMessage(message(it, "m$it")) }
        store.upsertMessage(message(2, "", deleted = true)) // not the one shown: nothing moves
        assertEquals("m3", store.last()?.id)
        store.updateChannel("d") { it.copy(syncedSeq = 3, oldestLoadedSeq = 1, hasOlder = false) }
        store.upsertMessage(message(3, "", deleted = true))
        assertEquals("m1", store.last()?.id)
        store.upsertMessage(message(1, "", deleted = true))
        assertNull(store.last()) // the start of the conversation: nothing left, nothing to ask
        assertTrue(stale.isEmpty())
    }

    @Test fun whenTheRowsHeldCannotSayItEmptiesAndAsksTheAnswerNeverReplacesANewerOne() {
        val store = storeWith(lastMessageOf(MessageState.from(message(8, "shown")), emptyMap()))
        val stale = ArrayList<String>()
        store.onStalePreview = { stale.add(it) }
        store.applyLastMessage(MessageState.from(message(8, "", deleted = true))) // no timeline here (syncedSeq null)
        assertNull(store.last())
        assertEquals(listOf("d"), stale)

        store.applyLastMessage(MessageState.from(message(9, "arrived meanwhile")))
        store.setFetchedLastMessage("d", lastMessageOf(MessageState.from(message(7, "the server's (older)")), emptyMap()))
        assertEquals("m9", store.last()?.id)
        store.setFetchedLastMessage("d", null)
        assertEquals("m9", store.last()?.id)
        val emptied = storeWith(null)
        emptied.setFetchedLastMessage("d", lastMessageOf(MessageState.from(message(7, "the server's")), emptyMap()))
        assertEquals("the server's", emptied.last()?.excerpt)
    }

    @Test fun itIsPersistedWithTheChannel() {
        val persistence = MemoryPersistence()
        val store = Store(persistence)
        store.upsertChannel(dm(), isMember = true, replaceLastMessage = true)
        store.upsertMessage(message(4, "kept"))
        val reloaded = Store(persistence).also { it.load() }
        assertEquals("kept", reloaded.last()?.excerpt)
    }

    // --- the engine and the fake server ----------------------------------------------------------------------------

    @Test fun bootstrapBringsItLiveEventsMoveItADeletionWithoutTimelineAsks() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        val dmId = server.createChannel("", alice.id, "dm").id
        server.channels.getValue(dmId).let { it.channel = it.channel.copy(dmUserIds = listOf(alice.id, bob.id)) }
        server.join(dmId, bob.id)
        val first = server.post(dmId, alice.id, "はじめまして").first
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        // Held as the interface (see SyncEngineTest.World).
        val syncApi: SyncApi = server.api(bob.id)
        val api = syncApi as FakeServer.Api
        val engine = SyncEngine(syncApi, server.connector(bob.id), "ws://fake", store, { "token" }, scope, EngineOptions(pageSize = 50, sleep = {}, random = { 0.5 }))
        engine.isActive = { false }
        suspend fun settle() = repeat(10) { engine.idle(); yield() }
        fun shown() = store.channel(dmId)!!.channel.let { previewLine(it, bob.id, store.users) }
        try {
            engine.start(); settle()
            assertEquals(first.id, store.channel(dmId)?.channel?.lastMessage?.id)
            assertNull(store.channel(dmId)?.syncedSeq) // never opened: no timeline
            assertEquals("はじめまして", shown())

            val mine = server.post(dmId, bob.id, "よろしく").first // another device of mine
            settle()
            assertEquals("あなた：よろしく", shown())
            server.edit(dmId, bob.id, mine.id, "よろしくお願いします")
            settle()
            assertEquals("あなた：よろしくお願いします", shown())
            server.delete(dmId, bob.id, mine.id)
            settle()
            assertEquals("はじめまして", shown())
            assertEquals(listOf(dmId), api.channelCalls)

            // With the conversation open (its timeline held), a deletion falls back without asking.
            engine.openChannel(dmId); settle()
            val again = server.post(dmId, bob.id, "もう一度").first
            settle()
            assertEquals("あなた：もう一度", shown())
            server.delete(dmId, bob.id, again.id)
            settle()
            assertEquals("はじめまして", shown())
            assertEquals(listOf(dmId), api.channelCalls)
        } finally {
            engine.stop()
            scope.cancel()
        }
    }
}
