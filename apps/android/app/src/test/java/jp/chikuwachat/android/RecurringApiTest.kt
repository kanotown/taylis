package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.ui.Recurring
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.LocalDate

/** L6 (M60, RECURRING.md §3): the five calls' methods, paths and bodies, through a stubbed OkHttp (no network). */
class RecurringApiTest {
    @Test fun callsTheServer() = runBlocking {
        val seen = ArrayList<Triple<String, String, String>>()
        val row = """{"id":"p1","channel_id":"c1","bot_user_id":"b","created_by":"u","name":"週報","body":"x","schedule":{"kind":"weekly","weekdays":[0],"time":"09:00"},
            "tz":"Asia/Tokyo","collect":null,"enabled":true,"next_run_at":"2026-10-05T00:00:00Z","last_run_at":null,"created_at":"","updated_at":""}"""
        val http = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val request = chain.request()
            val buffer = Buffer()
            request.body?.writeTo(buffer)
            seen.add(Triple(request.method, request.url.encodedPath, buffer.readUtf8()))
            val (status, text) = when {
                request.method == "GET" -> 200 to "[$row]"
                request.method == "DELETE" -> 204 to ""
                request.url.encodedPath.endsWith("/run") -> 201 to """{"message_id":"m9"}"""
                else -> 200 to row
            }
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(status).message("stub")
                .body(text.toResponseBody("application/json".toMediaType())).build()
        }).build()
        val api = ApiClient("http://server", http)
        api.accessToken = "a"
        assertEquals("週報", api.recurringPosts("c1").single().name)
        val draft = Recurring.emptyDraft(LocalDate.of(2026, 10, 5)).copy(name = "週報", body = "x")
        api.createRecurringPost("c1", Recurring.createBody(draft, "Asia/Tokyo"))
        api.updateRecurringPost("p1", Recurring.enabledBody(false))
        assertEquals("m9", api.runRecurringPost("p1").messageId)
        api.deleteRecurringPost("p1")
        assertEquals(
            listOf(
                "GET" to "/api/v1/channels/c1/recurring-posts",
                "POST" to "/api/v1/channels/c1/recurring-posts",
                "PATCH" to "/api/v1/recurring-posts/p1",
                "POST" to "/api/v1/recurring-posts/p1/run",
                "DELETE" to "/api/v1/recurring-posts/p1",
            ),
            seen.map { it.first to it.second },
        )
        assertEquals(
            Json.parseToJsonElement("""{"name":"週報","body":"x","schedule":{"kind":"weekly","weekdays":[0],"time":"09:00"},"tz":"Asia/Tokyo","collect":null,"enabled":true}"""),
            Json.parseToJsonElement(seen[1].third),
        )
        assertEquals("""{"enabled":false}""", seen[2].third)
    }
}
