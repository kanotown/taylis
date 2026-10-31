package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.ScheduledOut
import jp.chikuwachat.android.sync.SendOptions
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
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
import org.junit.Test

/** Functional review v0.1.84 #1: 「後で送信」 carries the composer's options; an older server's row still reads. */
class ScheduledOptionsTest {
    private val reply = """{"id":"s1","channel_id":"c1","parent_id":null,"client_msg_id":"k","body":"x","attachments":[],
        "send_at":"2026-10-01T00:00:00Z","status":"pending","error":null,"sent_message_id":null,"created_at":"2026-09-27T00:00:00Z",
        "also_in_channel":false,"priority":"urgent","ack_requested":true}"""

    @Test fun theOptionsGoWithTheSchedule() = runBlocking {
        val bodies = ArrayList<JsonObject>()
        val http = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val request = chain.request()
            val buffer = Buffer()
            request.body?.writeTo(buffer)
            bodies.add(Json.parseToJsonElement(buffer.readUtf8()).jsonObject)
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(201).message("stub")
                .body(reply.toResponseBody("application/json".toMediaType())).build()
        }).build()
        val api = ApiClient("http://server", http)
        api.accessToken = "a"
        val at = "2026-10-01T00:00:00Z"
        val row = api.scheduleMessage("c1", "k1", "x", null, emptyList(), at, SendOptions(priority = "urgent", ackRequested = true))
        assertEquals("urgent", row.priority)
        assertEquals(true, row.ackRequested)
        api.scheduleMessage("c1", "k2", "x", "p1", emptyList(), at, SendOptions(alsoInChannel = true))
        api.scheduleMessage("c1", "k3", "x", null, emptyList(), at)
        assertEquals(
            listOf(
                listOf("false", "\"urgent\"", "true"),
                listOf("true", "null", "false"),
                listOf("false", "null", "false"),
            ),
            bodies.map { body -> listOf("also_in_channel", "priority", "ack_requested").map { body[it].toString() } },
        )
    }

    @Test fun aRowFromAnOlderServerHasNoOptions() {
        val old = Codec.snake.decodeFromString(
            ScheduledOut.serializer(),
            """{"id":"s1","channel_id":"c1","parent_id":null,"client_msg_id":"k","body":"x","attachments":[],"send_at":"2026-10-01T00:00:00Z",
               "status":"pending","error":null,"sent_message_id":null,"created_at":"2026-09-27T00:00:00Z"}""",
        )
        assertFalse(old.alsoInChannel)
        assertNull(old.priority)
        assertFalse(old.ackRequested)
    }
}
