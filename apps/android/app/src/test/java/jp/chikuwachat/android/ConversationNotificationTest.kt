package jp.chikuwachat.android

import androidx.core.app.Person
import jp.chikuwachat.android.platform.ConversationLine
import jp.chikuwachat.android.platform.ConversationNote
import jp.chikuwachat.android.platform.ConversationStyle
import jp.chikuwachat.android.platform.PushMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import jp.chikuwachat.android.ui.Timeline
import kotlin.math.abs
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** PUSH_NOTIFICATIONS.md §16: message notifications as conversations with the sender's picture. */
class ConversationNotificationTest {
    private fun push(extra: Map<String, String> = emptyMap()) = PushMessage.parse(
        mapOf(
            "kind" to "message", "channel_id" to "c1", "message_id" to "m1", "title" to "Alice", "body" to "hi",
            "sender_id" to "u1", "sender_name" to "Alice", "sender_avatar" to "2026-10-06T12:00:00+00:00", "channel_type" to "dm",
        ) + extra,
    )!!

    @Test fun aDirectMessageIsTheSendersConversation() {
        val note = push().conversation!!
        assertEquals("u1", note.senderId)
        assertEquals("Alice", note.senderName)
        assertEquals("2026-10-06T12:00:00+00:00", note.senderAvatar)
        assertFalse(note.isGroup)
        assertNull(note.conversationTitle)
    }

    @Test fun aChannelIsAGroupNamedAfterIt() {
        val note = push(mapOf("channel_type" to "public", "title" to "#general", "subtitle" to "Alice")).conversation!!
        assertTrue(note.isGroup)
        assertEquals("#general", note.conversationTitle)
        assertEquals("Alice", note.senderName)
        assertTrue(push(mapOf("channel_type" to "group_dm", "title" to "グループ DM")).conversation!!.isGroup)
        assertTrue(push(mapOf("channel_type" to "private")).conversation!!.isGroup)
    }

    @Test fun otherPushesAndOlderServersKeepThePlainNotification() {
        assertNull(push(mapOf("kind" to "reminder")).conversation)
        assertNull(push(mapOf("kind" to "reaction")).conversation)
        val old = PushMessage.parse(mapOf("kind" to "message", "channel_id" to "c1", "title" to "Alice", "body" to "hi"))!!
        assertNull(old.conversation)
    }

    @Test fun aMissingNameFallsBackToWhatTheTitleSays() {
        val dm = PushMessage.parse(mapOf("kind" to "message", "channel_id" to "c1", "title" to "Alice", "body" to "hi", "sender_id" to "u1"))!!
        assertEquals("Alice", dm.conversation!!.senderName)
        val channel = PushMessage.parse(
            mapOf("kind" to "message", "channel_id" to "c1", "title" to "#general", "subtitle" to "Bob", "body" to "hi", "sender_id" to "u2", "channel_type" to "public"),
        )!!
        assertEquals("Bob", channel.conversation!!.senderName)
        assertNull(channel.conversation!!.senderAvatar)
    }

    @Test fun theSameMessageIsListedOnceAndOnlyTheNewestStay() {
        val first = ConversationLine("m1", "u1", "Alice", "one", 1)
        val listed = ConversationStyle.append(emptyList(), first)
        assertSame(listed, ConversationStyle.append(listed, first.copy(text = "one (FCM)")))
        var lines = listed
        for (i in 2..10) lines = ConversationStyle.append(lines, ConversationLine("m$i", "u1", "Alice", "#$i", i.toLong()))
        assertEquals(ConversationStyle.MAX_LINES, lines.size)
        assertEquals("#10", lines.last().text)
        // A line without an id (never from the server) is still listed.
        assertEquals(2, ConversationStyle.append(listed, ConversationLine(null, "u1", "Alice", "x", 2)).size)
    }

    @Test fun theStyleHasEachSenderAsAPerson() {
        val me = Person.Builder().setKey("me").setName("自分").build()
        val lines = listOf(
            ConversationLine("m1", "u1", "Alice", "hello", 1),
            ConversationLine("m2", "u2", "Bob", "hi there", 2),
        )
        val group = ConversationStyle.style(me, lines, emptyMap(), isGroup = true, title = "#general")
        assertTrue(group.isGroupConversation)
        assertEquals("#general", group.conversationTitle)
        assertEquals(listOf("hello", "hi there"), group.messages.map { it.text })
        assertEquals(listOf("Alice", "Bob"), group.messages.map { it.person?.name })
        assertEquals(listOf("u1", "u2"), group.messages.map { it.person?.key })
        assertEquals("自分", group.user.name)

        val dm = ConversationStyle.style(me, lines.take(1), emptyMap(), isGroup = false, title = "ignored")
        assertFalse(dm.isGroupConversation)
        assertNull(dm.conversationTitle)
    }

    @Test fun shortcutsAreOnePerConversationAndWorkspace() {
        val a = ConversationStyle.shortcutId("https://a.example", "c1")
        assertEquals(a, ConversationStyle.shortcutId("https://a.example", "c1"))
        assertNotEquals(a, ConversationStyle.shortcutId("https://b.example", "c1"))
        assertNotEquals(a, ConversationStyle.shortcutId("https://a.example", "c2"))
        assertTrue(a.startsWith(ConversationStyle.shortcutId("https://a.example", "")))
        assertTrue(a.endsWith(":c1"))
    }

    @Test fun picturesAreCachedPerVersionWithoutClearIds() {
        val one = ConversationStyle.cacheName("https://a.example", "u1", "v1")
        assertEquals(one, ConversationStyle.cacheName("https://a.example", "u1", "v1"))
        assertNotEquals(one, ConversationStyle.cacheName("https://a.example", "u1", "v2"))
        assertFalse(one.contains("u1"))
        assertEquals("/api/v1/users/u1/avatar?v=2026-10-06T12%3A00%3A00%2B00%3A00", ConversationStyle.avatarPath("u1", "2026-10-06T12:00:00+00:00"))
    }

    /** The default avatar against the cases every client shares (apps/shared/avatar-initials.json), as the app draws it. */
    private val avatarVectors: JsonObject by lazy {
        val file = File("../../shared/avatar-initials.json")
        check(file.isFile) { "apps/shared/avatar-initials.json not found from ${File("").absolutePath}" }
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    @Test fun initialsAndColoursFollowTheSharedRule() {
        val initials = avatarVectors["initials"]!!.jsonArray
        assertTrue(initials.size > 10)
        for (case in initials) {
            val name = case.jsonObject["name"]!!.jsonPrimitive.content
            val expected = case.jsonObject["initials"]!!.jsonPrimitive.content
            assertEquals(name, expected, ConversationStyle.initials(name))
            assertEquals(name, expected, Timeline.initials(name)) // the app's avatars
        }
        for (case in avatarVectors["colors"]!!.jsonArray) {
            val id = case.jsonObject["id"]!!.jsonPrimitive.content
            assertEquals(id, case.jsonObject["hue"]!!.jsonPrimitive.int, Timeline.hue(id))
            val rgb = case.jsonObject["rgb"]!!.jsonArray.map { it.jsonPrimitive.int }
            val color = ConversationStyle.colorFor(id)
            assertEquals(id, 0xFF, color ushr 24)
            val got = listOf((color shr 16) and 0xFF, (color shr 8) and 0xFF, color and 0xFF)
            for ((a, b) in got.zip(rgb)) assertTrue("$id: $got vs $rgb", abs(a - b) <= 1)
        }
        assertTrue(ConversationNote.isGroup("public") && !ConversationNote.isGroup("dm") && !ConversationNote.isGroup(null))
    }
}
