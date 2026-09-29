package jp.chikuwachat.android

import jp.chikuwachat.android.api.AckPendingOut
import jp.chikuwachat.android.api.AckRemindOut
import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MemberOut
import jp.chikuwachat.android.api.MembershipOut
import jp.chikuwachat.android.api.ReminderOut
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.AckReminders
import jp.chikuwachat.android.ui.ChannelOwners
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M31 (L4): reminding those who have not acknowledged, channel owners, converting, hiding presence. */
class OwnersTest {
    private fun me(id: String, role: String = "member") = UserMe(id, id, id, role, null, "", "", null, false)
    private fun user(id: String, role: String = "member") = UserPublic(id, id, id, role, createdAt = "", updatedAt = "")
    private fun member(id: String, role: String = "member") = MemberOut(id, role, "")

    private fun channel(type: String = "public", myRole: String? = "member", isMember: Boolean = myRole != null) = ChannelState(
        channel = ChannelOut(
            id = "c", type = type, name = "c", archived = false, lastSeq = 0, createdAt = "", updatedAt = "",
            membership = myRole?.let { MembershipOut(it, "") },
        ),
        isMember = isMember,
    )

    private fun message(sender: String = "author", ackRequested: Boolean = true) =
        MessageState(id = "m", channelId = "c", senderId = sender, seq = 1, updatedSeq = 1, clientMsgId = null, body = "b", createdAt = "", ackRequested = ackRequested)

    @Test fun theAuthorOrAnAdminRemindsWhileSomeoneIsPending() {
        assertTrue(AckReminders.canRemind(message(), me("author"), pendingCount = 2))
        assertTrue(AckReminders.canRemind(message(), me("teacher", "admin"), pendingCount = 1))
        assertFalse(AckReminders.canRemind(message(), me("reader"), pendingCount = 2)) // 403 ack_remind_forbidden
        assertFalse(AckReminders.canRemind(message(), me("author"), pendingCount = 0)) // everyone acknowledged
        assertFalse(AckReminders.canRemind(message(ackRequested = false), me("author"), pendingCount = 2))
        assertFalse(AckReminders.canRemind(message(), null, pendingCount = 2))
    }

    @Test fun theReminderNoticeSaysHowManyWereReminded() {
        assertEquals("3 人にリマインドしました", AckReminders.notice(3))
        assertEquals("リマインド済みの人だけです", AckReminders.notice(0))
    }

    @Test fun ownersAndAdminsMakeOwnersButNotOfGuestsOrBots() {
        val owned = channel(myRole = "owner")
        assertEquals("owner", ChannelOwners.action(owned, "member", member("a"), user("a"), ownerCount = 1))
        assertNull(ChannelOwners.action(owned, "member", member("g"), user("g", "guest"), ownerCount = 1))
        assertNull(ChannelOwners.action(owned, "member", member("b"), user("b", "bot"), ownerCount = 1))
        assertNull(ChannelOwners.action(owned, "member", member("x"), null, ownerCount = 1)) // not known yet
        // Taking it back: not from the last owner (409 last_owner).
        assertEquals("member", ChannelOwners.action(owned, "member", member("a", "owner"), user("a"), ownerCount = 2))
        assertNull(ChannelOwners.action(owned, "member", member("a", "owner"), user("a"), ownerCount = 1))
        // A plain member: nothing; an admin: even when not a member.
        assertNull(ChannelOwners.action(channel(), "member", member("a"), user("a"), ownerCount = 1))
        assertEquals("owner", ChannelOwners.action(channel(myRole = null), "admin", member("a"), user("a"), ownerCount = 1))
        // Never in DMs.
        assertNull(ChannelOwners.action(channel(type = "dm", myRole = "owner"), "admin", member("a"), user("a"), ownerCount = 1))
        assertNull(ChannelOwners.action(channel(type = "group_dm", myRole = "owner"), "admin", member("a"), user("a"), ownerCount = 1))
        assertEquals("オーナーにする", ChannelOwners.actionLabel("owner"))
        assertEquals("オーナーから外す", ChannelOwners.actionLabel("member"))
    }

    @Test fun onlyAnAdminWhoIsAMemberMakesAPrivateChannelPublic() {
        assertTrue(ChannelOwners.canConvert(channel(type = "private", myRole = "member"), "admin"))
        assertFalse(ChannelOwners.canConvert(channel(type = "private", myRole = null), "admin")) // 403 admin_not_member
        assertFalse(ChannelOwners.canConvert(channel(type = "private", myRole = "owner"), "member"))
        // Public → private: owners and admins.
        assertTrue(ChannelOwners.canConvert(channel(myRole = "owner"), "member"))
        assertTrue(ChannelOwners.canConvert(channel(myRole = "member"), "admin"))
        assertFalse(ChannelOwners.canConvert(channel(myRole = "member"), "member"))
        assertFalse(ChannelOwners.canConvert(channel(type = "dm", myRole = "member"), "admin"))
    }

    @Test fun memberUpdatedChangesMyRoleAndReloadsTheList() {
        val store = Store()
        store.setMe(me("me"))
        store.upsertChannel(channel(myRole = "member").channel, isMember = true)
        val before = store.version.value
        store.applyMemberUpdated("c", "someone", "owner") // another member: only the open list reloads
        assertEquals("member", store.channel("c")?.channel?.membership?.role)
        assertEquals(1, store.memberEpoch("c"))
        assertTrue(store.version.value > before)
        store.applyMemberUpdated("c", "me", "owner")
        assertEquals("owner", store.channel("c")?.channel?.membership?.role)
        assertTrue(ChannelOwners.canManage(store.channel("c")!!, "member")) // owner-only actions appear
        assertEquals(2, store.memberEpoch("c"))
        store.applyMemberUpdated("c", "me", "member")
        assertFalse(ChannelOwners.canManage(store.channel("c")!!, "member"))
        assertEquals(0, store.memberEpoch("other"))
    }

    @Test fun theEngineAppliesMemberUpdated() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice"); val bob = server.addUser("bob")
        val general = server.createChannel("general", alice.id)
        server.join(general.id, bob.id)
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}))
        engine.start(); repeat(20) { engine.idle(); yield() }
        assertEquals("member", store.channel(general.id)?.channel?.membership?.role)
        server.emitMemberUpdated(general.id, bob.id, "owner"); repeat(20) { engine.idle(); yield() }
        assertEquals("owner", store.channel(general.id)?.channel?.membership?.role)
        assertEquals(1, store.memberEpoch(general.id))
        engine.stop(); scope.cancel()
    }

    @Test fun aChannelIMadeElsewhereArrivesWithMeAsItsOwner() = runBlocking { // M32: the channel.created membership gap
        val server = FakeServer()
        val alice = server.addUser("alice"); val bob = server.addUser("bob")
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(alice.id), server.connector(alice.id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}))
        engine.start(); repeat(20) { engine.idle(); yield() }
        // Made on another device: channel.created carries no membership.
        val mine = server.createChannel("lab", alice.id, type = "private")
        server.emitMembership(mine.id, alice.id); repeat(20) { engine.idle(); yield() }
        assertEquals(MembershipOut("owner", mine.createdAt), store.channel(mine.id)?.channel?.membership)
        assertTrue(ChannelOwners.canManage(store.channel(mine.id)!!, "member"))
        // Someone else's channel I was added to: no role is made up.
        val theirs = server.createChannel("theirs", bob.id)
        server.join(theirs.id, alice.id); server.emitMembership(theirs.id, alice.id); repeat(20) { engine.idle(); yield() }
        assertTrue(store.channel(theirs.id)!!.isMember)
        assertNull(store.channel(theirs.id)?.channel?.membership)
        // Not for a group DM.
        val group = server.createChannel("", alice.id, type = "group_dm")
        server.join(group.id, bob.id); server.emitMembership(group.id, alice.id); repeat(20) { engine.idle(); yield() }
        assertNull(store.channel(group.id)?.channel?.membership)
        // A membership already known stays (made a plain member since): a later channel.created does not raise it.
        store.applyMemberUpdated(mine.id, alice.id, "member")
        server.emitMembership(mine.id, alice.id); repeat(20) { engine.idle(); yield() }
        assertEquals("member", store.channel(mine.id)?.channel?.membership?.role)
        engine.stop(); scope.cancel()
    }

    @Test fun requestsGoWhereTheServerExpectsThem() = runBlocking {
        val seen = ArrayList<String>()
        val http = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val request = chain.request()
            val body = request.body?.let { b -> Buffer().also { b.writeTo(it) }.readUtf8() } ?: ""
            seen.add("${request.method} ${request.url.encodedPath} $body".trim())
            val reply = when {
                request.url.encodedPath.endsWith("/ack/pending") -> """{"user_ids":["b","a"]}"""
                request.url.encodedPath.endsWith("/ack/remind") -> """{"reminded":2}"""
                else -> """{"user_id":"u","role":"owner","joined_at":""}"""
            }
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("ok").body(reply.toResponseBody("application/json".toMediaType())).build()
        }).build()
        val client = ApiClient("http://server", http)
        client.accessToken = "t"
        assertEquals(listOf("b", "a"), client.ackPending("m").userIds)
        assertEquals(2, client.remindAck("m").reminded)
        assertEquals("owner", client.updateMemberRole("c", "u", "owner").role)
        assertEquals(
            listOf("GET /api/v1/messages/m/ack/pending", "POST /api/v1/messages/m/ack/remind {}", """PATCH /api/v1/channels/c/members/u {"role":"owner"}"""),
            seen,
        )
    }

    @Test fun decodesTheNewFieldsWithDefaults() {
        val base = """"id":"u","username":"u","display_name":"U","role":"member","created_at":"","updated_at":"","must_change_password":false"""
        assertFalse(Codec.snake.decodeFromString(UserMe.serializer(), "{$base}").presenceHidden) // an older server
        assertTrue(Codec.snake.decodeFromString(UserMe.serializer(), "{$base,\"presence_hidden\":true}").presenceHidden)
        val reminder = """"id":"r","message_id":"m","channel_id":"c","remind_at":"2026-09-29T00:00:00Z","status":"fired","created_at":"2026-09-29T00:00:00Z""""
        assertEquals("personal", Codec.snake.decodeFromString(ReminderOut.serializer(), "{$reminder}").kind)
        assertEquals("ack", Codec.snake.decodeFromString(ReminderOut.serializer(), "{$reminder,\"kind\":\"ack\"}").kind)
        assertEquals(listOf("a", "b"), Codec.snake.decodeFromString(AckPendingOut.serializer(), """{"user_ids":["a","b"]}""").userIds)
        assertEquals(2, Codec.snake.decodeFromString(AckRemindOut.serializer(), """{"reminded":2}""").reminded)
        assertEquals("owner", Codec.snake.decodeFromString(MemberOut.serializer(), """{"user_id":"u","role":"owner","joined_at":""}""").role)
    }
}
