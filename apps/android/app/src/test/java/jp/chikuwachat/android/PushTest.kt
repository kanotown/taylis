package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.platform.PushCenter
import jp.chikuwachat.android.platform.PushMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PushTest {
    /** refresh()/tokenReceived() launch work in the scope; the HTTP call hops to Dispatchers.IO, so wait for it. */
    private suspend fun settle(scope: CoroutineScope) = scope.coroutineContext.job.children.toList().forEach { it.join() }

    @Test fun parsesDataOnlyMessages() {
        val push = PushMessage.parse(mapOf("kind" to "message", "channel_id" to "c1", "message_id" to "m1", "seq" to "12", "title" to "alice", "body" to "hi"))!!
        assertEquals("c1", push.channelId)
        assertEquals(12, push.seq)
        assertEquals("alice", push.title)
        assertEquals(false, push.isSilent)
        assertEquals(true, PushMessage.parse(mapOf("kind" to "silent"))!!.isSilent)
        assertNull(PushMessage.parse(mapOf("title" to "no kind")))
        assertNull(push.workspaceId)
        assertNull(push.badge)
    }

    @Test fun readsTheWorkspaceAndTheBadge() { // M16c
        val push = PushMessage.parse(mapOf("kind" to "message", "workspace_id" to "w1", "channel_id" to "c1", "badge" to "4", "title" to "t", "body" to "b"))!!
        assertEquals("w1", push.workspaceId)
        assertEquals(4, push.badge)
        assertNull(PushMessage.parse(mapOf("kind" to "message", "workspace_id" to "", "badge" to "x"))!!.workspaceId)
    }

    @Test fun aCalendarAlarmStandsApartAndMayHaveNoConversation() { // M52 (PUSH_NOTIFICATIONS.md, CALENDAR.md §6)
        val shared = PushMessage.parse(
            mapOf("kind" to "calendar", "channel_id" to "c1", "event_id" to "ev1", "title" to "予定", "body" to "14:00 ゼミ (#lab)", "collapse_key" to "calendar:ev1"),
        )!!
        assertEquals("ev1", shared.eventId)
        assertEquals(true, shared.isCalendar)
        assertEquals("calendar:ev1", shared.notificationKey) // never replaced by the channel's messages, nor cleared by a read
        assertEquals(true, shared.shown)
        assertEquals("予定", shared.displayTitle)
        // My own calendar's: no channel_id at all (the server leaves None out of the data), still shown, keyed by the event.
        val own = PushMessage.parse(mapOf("kind" to "calendar", "event_id" to "ev2", "title" to "予定", "body" to "終日 学会"))!!
        assertNull(own.channelId)
        assertEquals("calendar:ev2", own.notificationKey)
        assertEquals(true, own.shown)
        // A message without its conversation is not shown; neither is a calendar push without its event.
        assertEquals(false, PushMessage.parse(mapOf("kind" to "message", "title" to "t", "body" to "b"))!!.shown)
        assertEquals(false, PushMessage.parse(mapOf("kind" to "calendar", "title" to "予定", "body" to "b"))!!.shown)
        assertEquals(false, PushMessage.parse(mapOf("kind" to "silent", "channel_id" to "c1"))!!.shown)
    }

    @Test fun aTaskNotificationStandsApartAndMayHaveNoConversation() { // M56 (PUSH_NOTIFICATIONS.md, TASKS.md §8)
        val shared = PushMessage.parse(
            mapOf("kind" to "task", "channel_id" to "c1", "task_id" to "t1", "title" to "タスク", "body" to "ボブ がタスクを割り当てました：資料 (#lab)", "collapse_key" to "task:t1"),
        )!!
        assertEquals("t1", shared.taskId)
        assertEquals(true, shared.isTask)
        assertEquals("task:t1", shared.notificationKey) // never replaced by the channel's messages, nor cleared by a read
        assertEquals(true, shared.shown)
        assertEquals("タスク", shared.displayTitle)
        // A personal task's due date: no channel_id, still shown, keyed by the task.
        val own = PushMessage.parse(mapOf("kind" to "task", "task_id" to "t2", "title" to "タスク", "body" to "今日が期限：買い物"))!!
        assertNull(own.channelId)
        assertEquals("task:t2", own.notificationKey)
        assertEquals(true, own.shown)
        assertEquals(false, PushMessage.parse(mapOf("kind" to "task", "title" to "タスク", "body" to "b"))!!.shown)
    }

    @Test fun readsTheThreadParentOfAReply() { // M28c: the tap opens the thread at the reply
        val reply = PushMessage.parse(mapOf("kind" to "message", "channel_id" to "c1", "message_id" to "m2", "parent_id" to "m1", "title" to "t", "body" to "b"))!!
        assertEquals("m1", reply.parentId)
        val post = PushMessage.parse(mapOf("kind" to "message", "channel_id" to "c1", "message_id" to "m3", "parent_id" to "", "title" to "t", "body" to "b"))!!
        assertNull(post.parentId)
        assertNull(PushMessage.parse(mapOf("kind" to "message", "channel_id" to "c1", "message_id" to "m4", "title" to "t", "body" to "b"))!!.parentId)
    }

    @Test fun titlesNameTheSenderAndRemindersStandApart() {
        val channel = PushMessage.parse(mapOf("kind" to "message", "channel_id" to "c1", "title" to "#general", "subtitle" to "Alice", "body" to "hi", "collapse_key" to "c1"))!!
        assertEquals("#general · Alice", channel.displayTitle)
        assertEquals("c1", channel.notificationKey) // replaced by the conversation's next message, cleared by a read
        val dm = PushMessage.parse(mapOf("kind" to "message", "channel_id" to "c2", "title" to "Alice", "body" to "hi"))!!
        assertEquals("Alice", dm.displayTitle)
        val reminder = PushMessage.parse(mapOf("kind" to "reminder", "channel_id" to "c1", "message_id" to "m1", "title" to "リマインダー", "body" to "x", "collapse_key" to "reminder:r1"))!!
        assertEquals("reminder:r1", reminder.notificationKey)
        assertEquals("リマインダー", reminder.displayTitle)
    }

    private fun recordingClient(bodies: MutableList<String>, fail: () -> Boolean = { false }): OkHttpClient =
        OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val buffer = Buffer().also { chain.request().body?.writeTo(it) }
            bodies.add(buffer.readUtf8())
            val status = if (fail()) 503 else 200
            val body = if (status == 200) """{"id":"d","platform":"android","enabled":true,"push_provider":"fcm","push_registered":true,"created_at":"","updated_at":""}"""
            else """{"error":{"code":"unavailable","message":"down","details":{}}}"""
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(status).message("stub")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }).build()

    @Test fun uploadsTokenOncePerSessionAndAgainWhenItChanges() = runBlocking {
        val bodies = ArrayList<String>()
        val api = ApiClient("http://server", recordingClient(bodies)).apply { accessToken = "a" }
        var token: String? = "tok-1"
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val center = PushCenter(scope, { token }, { listOf("http://server" to api) })

        center.attach("http://server"); settle(scope)
        center.refresh(); settle(scope) // unchanged token: no second upload
        assertEquals(1, center.uploads)
        assertEquals(listOf("""{"push_provider":"fcm","push_token":"tok-1"}"""), bodies)

        center.tokenReceived("tok-2"); settle(scope) // onNewToken
        assertEquals(2, center.uploads)
        assertEquals("tok-2", center.uploadedTo("http://server"))

        center.attach("http://server"); settle(scope) // new session → the (unchanged) token is registered again for the new device row
        assertEquals(3, center.uploads)
    }

    @Test fun failedUploadIsRetriedOnNextRefresh() = runBlocking {
        val bodies = ArrayList<String>()
        var failing = true
        val api = ApiClient("http://server", recordingClient(bodies) { failing }).apply { accessToken = "a" }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val center = PushCenter(scope, { "tok" }, { listOf("http://server" to api) })
        center.attach("http://server"); settle(scope)
        assertEquals(0, center.uploads)
        assertNull(center.uploadedTo("http://server"))
        failing = false
        center.refresh(); settle(scope)
        assertEquals(1, center.uploads)
        assertEquals(2, bodies.size)
    }

    @Test fun noTokenSourceMeansNoUpload() = runBlocking {
        val bodies = ArrayList<String>()
        val api = ApiClient("http://server", recordingClient(bodies)).apply { accessToken = "a" }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val center = PushCenter(scope, { null }, { listOf("http://server" to api) })
        center.attach("http://server"); settle(scope)
        assertEquals(0, bodies.size)
    }

    private fun tokens(n: Int) = """{"access_token":"access-$n","refresh_token":"refresh-$n","token_type":"bearer","expires_in":900,"session_id":"s",
        "device":{"id":"d","platform":"android","enabled":true,"created_at":"","updated_at":""},
        "user":{"id":"u","username":"alice","display_name":"Alice","role":"member","created_at":"","updated_at":"","must_change_password":false}}"""

    @Test fun everySignedInWorkspaceGetsTheTokenAndBackgroundOnesRenewTheirSessionFirst() = runBlocking { // WORKSPACES.md §8
        val seen = ArrayList<String>()
        fun server(name: String) = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val request = chain.request()
            val buffer = Buffer().also { request.body?.writeTo(it) }
            seen.add("$name ${request.method} ${request.url.encodedPath} ${request.header("Authorization")} ${buffer.readUtf8()}")
            val body = if (request.url.encodedPath.endsWith("/auth/refresh")) tokens(2)
            else """{"id":"d","platform":"android","enabled":true,"push_provider":"fcm","push_registered":true,"created_at":"","updated_at":""}"""
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("stub")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }).build()
        val active = ApiClient("http://a", server("a")).apply { accessToken = "access-a" }
        // A workspace in the background: only its stored refresh token; the rotated one is saved (onTokens).
        val background = ApiClient("http://b", server("b")).apply { refreshToken = "refresh-1" }
        val saved = ArrayList<String>()
        background.onTokens = { saved.add(it.refreshToken) }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        var current = "tok-1"
        val center = PushCenter(scope, { current }, { listOf("http://a" to active, "http://b" to background) })

        center.refresh(); settle(scope)
        assertEquals(
            listOf(
                """a PUT /api/v1/devices/current Bearer access-a {"push_provider":"fcm","push_token":"tok-1"}""",
                """b POST /api/v1/auth/refresh null {"refresh_token":"refresh-1"}""",
                """b PUT /api/v1/devices/current Bearer access-2 {"push_provider":"fcm","push_token":"tok-1"}""",
            ),
            seen,
        )
        assertEquals(listOf("refresh-2"), saved)
        assertEquals("tok-1", center.uploadedTo("http://b"))

        // A new token goes to both again; the background session is still fresh, so no second refresh.
        seen.clear()
        current = "tok-2"
        center.tokenReceived("tok-2"); settle(scope)
        assertEquals(listOf("a PUT", "b PUT"), seen.map { it.split(" ").take(2).joinToString(" ") })

        // A workspace that signed out is forgotten: signing in there again registers the (same) token anew.
        center.detach("http://b")
        seen.clear()
        center.refresh(); settle(scope)
        assertEquals(listOf("b PUT"), seen.map { it.split(" ").take(2).joinToString(" ") })
    }
}
