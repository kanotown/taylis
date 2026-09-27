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
        val center = PushCenter(scope, { token }, { api })

        center.attach(); settle(scope)
        center.refresh(); settle(scope) // unchanged token: no second upload
        assertEquals(1, center.uploads)
        assertEquals(listOf("""{"push_provider":"fcm","push_token":"tok-1"}"""), bodies)

        center.tokenReceived("tok-2"); settle(scope) // onNewToken
        assertEquals(2, center.uploads)
        assertEquals("tok-2", center.uploadedToken)

        center.attach(); settle(scope) // new session → the (unchanged) token is registered again for the new device row
        assertEquals(3, center.uploads)
    }

    @Test fun failedUploadIsRetriedOnNextRefresh() = runBlocking {
        val bodies = ArrayList<String>()
        var failing = true
        val api = ApiClient("http://server", recordingClient(bodies) { failing }).apply { accessToken = "a" }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val center = PushCenter(scope, { "tok" }, { api })
        center.attach(); settle(scope)
        assertEquals(0, center.uploads)
        assertNull(center.uploadedToken)
        failing = false
        center.refresh(); settle(scope)
        assertEquals(1, center.uploads)
        assertEquals(2, bodies.size)
    }

    @Test fun noTokenSourceMeansNoUpload() = runBlocking {
        val bodies = ArrayList<String>()
        val api = ApiClient("http://server", recordingClient(bodies)).apply { accessToken = "a" }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val center = PushCenter(scope, { null }, { api })
        center.attach(); settle(scope)
        assertEquals(0, bodies.size)
    }
}
