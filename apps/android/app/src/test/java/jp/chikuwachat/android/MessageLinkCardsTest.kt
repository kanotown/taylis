package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.AttachmentDriveOut
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.MessagePreviewOut
import jp.chikuwachat.android.api.MessagePreviewsOut
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.MessagePreviewApi
import jp.chikuwachat.android.sync.MessagePreviewHub
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.toOut
import jp.chikuwachat.android.ui.Links
import jp.chikuwachat.android.ui.MessageCards
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** M185 (docs/LINK_PREVIEWS.md): message link cards and removing a preview. */
class MessageLinkCardsTest {
    // --- the shared cases (apps/shared/link-cards.json, the file the server, Desktop / Web and iOS test against too) ---

    /** From the module (apps/android/app), ../../shared (as the other shared cases). */
    private val shared: JsonObject by lazy {
        val file = File("../../shared/link-cards.json")
        check(file.isFile) { "apps/shared/link-cards.json not found from ${File("").absolutePath}" }
        Codec.plain.parseToJsonElement(file.readText()).jsonObject
    }

    @Test fun everySharedKeyCase() {
        val cases = shared.getValue("keys").jsonArray
        assertTrue(cases.size >= 10)
        for (case in cases) {
            val url = case.jsonObject.getValue("url").jsonPrimitive.content
            val key = case.jsonObject.getValue("key").let { if (it is JsonNull) null else it.jsonPrimitive.content }
            assertEquals("key of $url", key, MessageCards.previewKey(url))
        }
    }

    @Test fun everySharedCardCase() {
        val base = shared.getValue("base_url").jsonPrimitive.content
        val cases = shared.getValue("cards").jsonArray
        assertTrue(cases.size >= 12)
        for (element in cases) {
            val case = element.jsonObject
            val name = case.getValue("name").jsonPrimitive.content
            val cards = MessageCards.cardLinks(
                case.getValue("body").jsonPrimitive.content, base,
                selfId = case["self_id"]?.jsonPrimitive?.contentOrNull,
                hidden = case["hidden"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
                call = case["call"]?.jsonPrimitive?.booleanOrNull ?: false,
            )
            val messages = case.getValue("messages").jsonArray.map {
                MessageCards.MessageLink(it.jsonObject.getValue("id").jsonPrimitive.content, it.jsonObject.getValue("url").jsonPrimitive.content)
            }
            assertEquals("$name: messages", messages, cards.messages)
            assertEquals("$name: external", case["external"]?.jsonPrimitive?.contentOrNull, cards.external)
        }
    }

    /**
     * 2026-11-05: a body's links are the links its tokenizer reads (not the closing mark or the Japanese after them); their
     * keys are what a removed card is kept under, the same as the other clients and the server's.
     */
    @Test fun everySharedBodyKeysCase() {
        val cases = shared.getValue("body_keys").jsonArray
        assertTrue(cases.size >= 5)
        for (element in cases) {
            val case = element.jsonObject
            val body = case.getValue("body").jsonPrimitive.content
            val keys = case.getValue("keys").jsonArray.map { it.jsonPrimitive.content }
            assertEquals(body, keys, Links.all(body).mapNotNull { MessageCards.previewKey(it) }.distinct())
        }
    }

    @Test fun noBaseMeansNoMessageCards() {
        // Signed out (no server): a /m/ link is an ordinary link.
        val cards = MessageCards.cardLinks("https://chat.example.com/m/0190a1b2-0000-7000-8000-00000000000a", null)
        assertEquals(emptyList<MessageCards.MessageLink>(), cards.messages)
        assertEquals("https://chat.example.com/m/0190a1b2-0000-7000-8000-00000000000a", cards.external)
    }

    @Test fun thisServersCanvasPageAndEventLinksGetNoOpenGraphCard() {
        // As before on Android: these show in the app (a canvas has its card in the body); the next link gets the card.
        val base = "https://chat.example.com"
        for (path in listOf("c", "p", "e", "d")) {
            val cards = MessageCards.cardLinks("$base/$path/0190a1b2-0000-7000-8000-00000000000a https://example.com/x", base)
            assertEquals(path, "https://example.com/x", cards.external)
        }
    }

    @Test fun aFullWidthSpaceEndsALinkAsOnTheWebAndTheServer() {
        assertEquals(listOf("https://example.com/a", "https://example.com/b"), Links.all("https://example.com/a　次 https://example.com/b、"))
        assertEquals("https://example.com/a", Links.first("見て https://example.com/a　です"))
        assertNull(MessageCards.previewKey("https://example.com/a　b"))
    }

    // --- what a card shows (§5) ---

    private val alice = UserPublic("00000000-0000-7000-8000-000000000001", "alice", "Alice", "member", null, "", "")
    private val users = mapOf(alice.id to alice)

    @Test fun excerptLinesArePlainWithNamesAndAtMostFour() {
        assertEquals(
            "@Alice 見てください\n太字と リンク\n項目",
            MessageCards.excerptText("<@${alice.id}> 見てください\n\n**太字**と [リンク](https://example.com)\n- 項目", false, users),
        )
        assertEquals("1\n2\n3\n4…", MessageCards.excerptText("1\n2\n\n3\n4\n5", false, users))
        assertEquals("1\n2…", MessageCards.excerptText("1\n2", true, users)) // the server cut it
        assertEquals("", MessageCards.excerptText("\n \n", true, users)) // nothing to show: the caller says what is attached
        // Someone I cannot see (a guest's view): 「@メンバー」, as the one-line previews.
        assertEquals("@メンバー こんにちは", MessageCards.excerptText("<@00000000-0000-7000-8000-0000000000ff> こんにちは", false, users))
    }

    private fun file(id: String, type: String, thumbnail: Boolean = false, poster: Boolean = false, drive: String? = null) =
        AttachmentOut(id, "f", type, 1, hasThumbnail = thumbnail, hasPoster = poster, drive = drive?.let { AttachmentDriveOut(itemId = "i", state = it) })

    @Test fun theHeldRowsThumbnailIsTheServersRule() {
        assertNull(MessageCards.thumbnail(listOf(file("a", "application/pdf"))))
        assertEquals("b", MessageCards.thumbnail(listOf(file("a", "application/pdf"), file("b", "image/png", thumbnail = true))))
        assertEquals("v", MessageCards.thumbnail(listOf(file("v", "video/mp4", poster = true))))
        // A posted file moved to another drive location (or the trash) is skipped: the reader may get a 404.
        assertEquals("c", MessageCards.thumbnail(listOf(file("m", "image/png", thumbnail = true, drive = "moved"), file("c", "image/png", thumbnail = true, drive = "available"))))
    }

    private fun preview(type: String, name: String? = null, parent: String? = null, channel: String = "c1") =
        MessagePreviewOut(id = "m", state = "ok", channelId = channel, channelType = type, channelName = name, parentId = parent, senderId = alice.id)

    private fun dm(id: String, others: List<String>) = ChannelState(
        ChannelOut(id = id, type = "dm", archived = false, lastSeq = 0, createdAt = "2026-11-01T00:00:00Z", updatedAt = "2026-11-01T00:00:00Z", dmUserIds = others),
        isMember = true,
    )

    @Test fun theConversationLine() {
        val store = Store()
        store.users[alice.id] = alice
        store.setMe(Codec.snake.decodeFromString(UserMe.serializer(), """{"id":"me","username":"me","display_name":"Me","role":"member","created_at":"","updated_at":"","must_change_password":false}"""))
        assertEquals("#general", MessageCards.conversation(preview("public", "general"), null, store))
        assertEquals("#general のスレッド", MessageCards.conversation(preview("private", "general", parent = "p"), null, store))
        // A DM: the other person from my own list; not in it (yet), 「ダイレクトメッセージ」.
        assertEquals("Alice", MessageCards.conversation(preview("dm"), dm("c1", listOf("me", alice.id)), store))
        assertEquals("ダイレクトメッセージ", MessageCards.conversation(preview("group_dm"), null, store))
        assertEquals("ダイレクトメッセージ のスレッド", MessageCards.conversation(preview("dm", parent = "p"), null, store))
        // The sheet's names for several cards.
        assertEquals("Alice · #general", MessageCards.label(preview("public", "general"), store))
        assertEquals("削除されたメッセージ", MessageCards.label(MessagePreviewOut("m", "deleted"), store))
        assertEquals("表示できないメッセージ", MessageCards.label(MessagePreviewOut("m", "unavailable"), store))
        store.blockedUsers.add(alice.id)
        assertEquals("ブロック中のユーザーのメッセージ", MessageCards.label(preview("public", "general"), store))
    }

    // --- MessageOut.hidden_previews (§4, §8 1.) ---

    private fun wire(extra: String = "") = """
        {"id": "m1", "channel_id": "c1", "sender_id": "u1", "seq": 3, "updated_seq": 3, "body": "https://example.com/a",
         "created_at": "2026-11-05T01:00:00Z", "deleted": false$extra}
    """.trimIndent()

    @Test fun hiddenPreviewsDecodePersistAndConvert() {
        // An older server (no field): nothing removed.
        assertEquals(emptyList<String>(), Codec.snake.decodeFromString(MessageOut.serializer(), wire()).hiddenPreviews)
        val message = Codec.snake.decodeFromString(MessageOut.serializer(), wire(""", "hidden_previews": ["https://example.com/a"]"""))
        assertEquals(listOf("https://example.com/a"), message.hiddenPreviews)
        val state = MessageState.from(message)
        val persisted = Codec.plain.decodeFromString(MessageState.serializer(), Codec.plain.encodeToString(MessageState.serializer(), state))
        assertEquals(listOf("https://example.com/a"), persisted.hiddenPreviews)
        assertEquals(listOf("https://example.com/a"), persisted.toOut()?.hiddenPreviews)
        // A row stored before M185 (Room keeps the JSON): no field, nothing removed.
        val old = Codec.plain.encodeToString(MessageState.serializer(), state).replace(""","hiddenPreviews":["https://example.com/a"]""", "")
        assertTrue(!old.contains("hiddenPreviews"))
        assertEquals(emptyList<String>(), Codec.plain.decodeFromString(MessageState.serializer(), old).hiddenPreviews)
    }

    @Test fun aPreviewsChangeReplacesTheRowAsAnyUpdate() {
        // message.updated (change "previews") carries the whole message with a new updated_seq: the held row is replaced.
        val store = Store()
        store.upsertMessage(Codec.snake.decodeFromString(MessageOut.serializer(), wire()))
        val removed = Codec.snake.decodeFromString(MessageOut.serializer(), wire(""", "hidden_previews": ["https://example.com/a"]""").replace("\"updated_seq\": 3", "\"updated_seq\": 9"))
        store.upsertMessage(removed)
        assertEquals(listOf("https://example.com/a"), store.message("c1", "m1")?.hiddenPreviews)
        val held = store.message("c1", "m1")!!
        assertEquals(null, MessageCards.cardLinks(held.body, "https://chat.example.com", held.id, held.hiddenPreviews).external)
    }

    // --- asking for the cards (§3.3, §8 3.) ---

    private class FakeApi : MessagePreviewApi {
        val calls = ArrayList<List<String>>()
        var failing = false
        override suspend fun messagePreviews(ids: List<String>): MessagePreviewsOut {
            calls.add(ids)
            if (failing) throw ApiException.Api(429, "rate_limited", "slow down")
            return MessagePreviewsOut(ids.map { MessagePreviewOut(it, if (it.startsWith("x")) "unavailable" else "ok", excerpt = "v${calls.size}") })
        }
    }

    @Test fun cardsAskingTogetherGoInOneRequestOfAtMostTwenty() = runBlocking {
        val api = FakeApi()
        val hub = MessagePreviewHub(api, this, batchDelayMs = 30)
        hub.request("a")
        hub.request("B") // ids are lower case on the wire and in the cache
        hub.request("a")
        assertNull(hub.peek("a"))
        delay(150)
        assertEquals(listOf(listOf("a", "b")), api.calls)
        assertEquals("ok", hub.peek("a")?.preview?.state)
        assertEquals("ok", hub.peek("b")?.preview?.state)
        // A jump that brings 45 cards at once: 20 + 20 + 5.
        api.calls.clear()
        val before = hub.version.value
        (1..45).forEach { hub.request("m$it") }
        delay(150)
        assertEquals(listOf(20, 20, 5), api.calls.map { it.size })
        assertEquals(before + 3, hub.version.value) // each answer redraws the cards
        assertEquals("ok", hub.peek("m45")?.preview?.state)
    }

    @Test fun freshAnswersAreKeptStaleOnesAreReadAgainAndFailuresWaitAMinute() = runBlocking {
        val api = FakeApi()
        var now = 1_000_000L
        val hub = MessagePreviewHub(api, this, clock = { now }, batchDelayMs = 1)
        hub.request("a")
        delay(50)
        assertEquals(1, api.calls.size)
        now += MessagePreviewHub.TTL_MS - 1
        hub.request("a") // still fresh: not asked
        delay(50)
        assertEquals(1, api.calls.size)
        now += 2
        api.failing = true
        hub.request("a") // stale: asked again; the failure keeps the card read before
        delay(50)
        assertEquals(2, api.calls.size)
        assertEquals("v1", hub.peek("a")?.preview?.excerpt)
        hub.request("a") // and is not asked again on every draw…
        delay(50)
        assertEquals(2, api.calls.size)
        now += MessagePreviewHub.RETRY_MS
        api.failing = false
        hub.request("a") // …but a minute later
        delay(50)
        assertEquals(3, api.calls.size)
        assertEquals("v3", hub.peek("a")?.preview?.excerpt)

        // A card never read: the failure is held (no card) for a minute, then asked again.
        api.failing = true
        hub.request("x1")
        delay(50)
        assertEquals(4, api.calls.size)
        val failed = hub.peek("x1")
        assertTrue(failed != null && failed.preview == null)
        now += MessagePreviewHub.RETRY_MS - 1
        hub.request("x1")
        delay(50)
        assertEquals(4, api.calls.size)
        now += 1
        api.failing = false
        hub.request("x1")
        delay(50)
        assertEquals(5, api.calls.size)
        assertEquals("unavailable", hub.peek("x1")?.preview?.state)
    }

    @Test fun withoutTheApiNothingIsAsked() = runBlocking {
        val hub = MessagePreviewHub(null, this, batchDelayMs = 1)
        hub.request("a")
        delay(20)
        assertNull(hub.peek("a"))
    }
}
