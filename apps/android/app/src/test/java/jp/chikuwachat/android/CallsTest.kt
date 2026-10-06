package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.CallOut
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MessageCallOut
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.api.WorkspaceSettingsOut
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.toOut
import jp.chikuwachat.android.ui.CallKeys
import jp.chikuwachat.android.ui.Calls
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M117 (docs/CALLS.md): the call message, the 📞's conditions and the retry key. */
class CallsTest {
    private val message = """
        {"id":"m1","channel_id":"c1","sender_id":"u1","seq":7,"updated_seq":7,"client_msg_id":"k1","body":"📞 通話を始めました\nhttps://meet.jit.si/taylis-abc",
         "created_at":"2026-10-06T11:00:00Z","deleted":false,"call":{"url":"https://meet.jit.si/taylis-abc","started_by":"u1"}}
    """.trimIndent()

    @Test fun aCallMessageCarriesItsRoomThroughTheStore() {
        val out = Codec.snake.decodeFromString(MessageOut.serializer(), message)
        assertEquals(MessageCallOut("https://meet.jit.si/taylis-abc", "u1"), out.call)
        val state = MessageState.from(out)
        assertEquals(out.call, state.call)
        assertEquals(out.call, state.toOut()?.call)
        // Persisted locally as JSON (rows written before M117 have no call).
        assertEquals(state, Codec.plain.decodeFromString(MessageState.serializer(), Codec.plain.encodeToString(MessageState.serializer(), state)))
        val plain = Codec.snake.decodeFromString(MessageOut.serializer(), message.replace(Regex(""","call":\{[^}]*\}"""), ""))
        assertNull(plain.call)
        val response = Codec.snake.decodeFromString(CallOut.serializer(), """{"url":"https://meet.jit.si/taylis-abc","message":$message}""")
        assertEquals("https://meet.jit.si/taylis-abc", response.url)
        assertEquals("m1", response.message.id)
    }

    @Test fun theSettingsSayWhetherCallsAreOn() {
        val on = Codec.snake.decodeFromString(
            WorkspaceSettingsOut.serializer(),
            """{"show_membership_messages":true,"preview_before_join":true,"icon_version":null,"calls_enabled":true,"meeting_base_url":"https://meet.jit.si/"}""",
        )
        assertTrue(on.callsEnabled)
        assertEquals("https://meet.jit.si/", on.meetingBaseUrl)
        val off = Codec.snake.decodeFromString(WorkspaceSettingsOut.serializer(), """{"calls_enabled":false,"meeting_base_url":null}""")
        assertFalse(off.callsEnabled)
        // A server before M117 does not send it: no 📞.
        assertFalse(Codec.snake.decodeFromString(WorkspaceSettingsOut.serializer(), """{"show_membership_messages":true}""").callsEnabled)
    }

    private fun conversation(type: String = "dm", archived: Boolean = false, member: Boolean = true, policy: String? = null, role: String = "member") = ChannelState(
        ChannelOut(
            id = "c1", type = type, name = if (type == "dm") null else "general", archived = archived, lastSeq = 0, createdAt = "t", updatedAt = "t",
            membership = jp.chikuwachat.android.api.MembershipOut(role = role, joinedAt = "t"), postingPolicy = policy,
        ),
        isMember = member,
    )

    @Test fun theCallButtonFollowsWhoMayPost() {
        val on = WorkspaceSettingsOut(callsEnabled = true)
        assertTrue(Calls.canStart(on, conversation("dm"), isAdmin = false))
        assertTrue(Calls.canStart(on, conversation("group_dm"), isAdmin = false))
        assertTrue(Calls.canStart(on, conversation("public"), isAdmin = false))
        assertTrue(Calls.canStart(on, conversation("private"), isAdmin = false))
        assertFalse(Calls.canStart(WorkspaceSettingsOut(), conversation("dm"), isAdmin = false))
        assertFalse(Calls.canStart(on, conversation("public", archived = true), isAdmin = true))
        assertFalse(Calls.canStart(on, conversation("public", member = false), isAdmin = true))
        assertFalse(Calls.canStart(on, null, isAdmin = true))
        // An announcement channel: owners and admins only.
        assertFalse(Calls.canStart(on, conversation("public", policy = "owners"), isAdmin = false))
        assertTrue(Calls.canStart(on, conversation("public", policy = "owners", role = "owner"), isAdmin = false))
        assertTrue(Calls.canStart(on, conversation("public", policy = "owners"), isAdmin = true))
    }

    @Test fun aCallSaysWhoStartedIt() {
        val users = mapOf("u1" to UserPublic("u1", "kano", "加納", "member", null, "t", "t"))
        val call = MessageCallOut("https://meet.jit.si/taylis-abc", "u1")
        assertEquals("📞 加納 さんが通話を始めました", Calls.startedLine(call, users))
        assertEquals("📞 加納 さんが通話を始めました", Calls.notificationLine(call, deleted = false, users))
        assertNull(Calls.notificationLine(call, deleted = true, users))
        assertNull(Calls.notificationLine(null, deleted = false, users))
        assertEquals("📞 ? さんが通話を始めました", Calls.startedLine(call, emptyMap()))
    }

    @Test fun aRetryAfterAnUnknownOutcomeSendsTheSameKey() {
        var now = 0L
        val keys = CallKeys(ttlMillis = 1_000, now = { now })
        val first = keys.take("c1")
        keys.settle("c1", ApiException.Network(RuntimeException("offline")))
        assertEquals(first, keys.take("c1"))
        keys.settle("c1", ApiException.Api(503, "unavailable", ""))
        assertEquals(first, keys.take("c1"))
        assertNotEquals(first, keys.take("c2")) // each conversation its own
        // A refusal or a success: the next tap is a new call.
        keys.settle("c1", ApiException.Api(409, "calls_disabled", ""))
        val second = keys.take("c1")
        assertNotEquals(first, second)
        keys.settle("c1", null)
        val third = keys.take("c1")
        assertNotEquals(second, third)
        keys.settle("c1", ApiException.Network(RuntimeException("offline")))
        now = 2_000 // much later: a new call
        assertNotEquals(third, keys.take("c1"))
    }
}
