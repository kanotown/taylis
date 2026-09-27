package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.ApiException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The client is exercised through an OkHttp interceptor that fabricates responses (no network). */
class ApiClientTest {
    private fun stubbed(handler: (Request) -> Pair<Int, String>): OkHttpClient =
        OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val (status, body) = handler(chain.request())
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(status).message("stub")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }).build()

    private fun tokens(n: Int) = """{"access_token":"access-$n","refresh_token":"refresh-$n","token_type":"bearer","expires_in":900,"session_id":"s",
        "device":{"id":"d","platform":"android","enabled":true,"created_at":"","updated_at":""},
        "user":{"id":"u","username":"alice","display_name":"Alice","role":"member","created_at":"","updated_at":"","must_change_password":false}}"""

    @Test fun refreshesOnceOnTokenExpiredAndRetries() = runBlocking {
        var refreshed = 0
        val auths = ArrayList<String?>()
        val client = ApiClient("http://server", stubbed { request ->
            auths.add(request.header("Authorization"))
            when {
                request.url.encodedPath == "/api/v1/auth/refresh" -> { refreshed += 1; 200 to tokens(2) }
                request.header("Authorization") == "Bearer access-1" -> 401 to """{"error":{"code":"token_expired","message":"expired","details":{}}}"""
                else -> 200 to """{"id":"u","username":"alice","display_name":"Alice","role":"member","created_at":"","updated_at":"","must_change_password":false}"""
            }
        })
        client.accessToken = "access-1"; client.refreshToken = "refresh-1"
        assertEquals("alice", client.me().username)
        assertEquals(1, refreshed)
        assertEquals("refresh-2", client.refreshToken)
        assertEquals(listOf("Bearer access-1", null, "Bearer access-2"), auths)
    }

    @Test fun signsOutWhenRefreshFails() = runBlocking {
        var signedOut = false
        val client = ApiClient("http://server", stubbed { request ->
            if (request.url.encodedPath.endsWith("/auth/refresh")) 401 to """{"error":{"code":"session_revoked","message":"revoked","details":{}}}"""
            else 401 to """{"error":{"code":"token_expired","message":"expired","details":{}}}"""
        })
        client.onSignedOut = { signedOut = true }
        client.accessToken = "a"; client.refreshToken = "r"
        try { client.me(); fail("expected failure") } catch (e: ApiException.Api) { assertEquals("session_revoked", e.code); assertEquals(401, e.status) }
        assertTrue(signedOut)
        assertNull(client.accessToken)
    }

    @Test fun restoredSessionRefreshesBeforeAuthenticatedRequest() = runBlocking {
        val paths = ArrayList<String>()
        val client = ApiClient("http://server", stubbed { request ->
            paths.add(request.url.encodedPath)
            if (request.url.encodedPath.endsWith("/auth/refresh")) 200 to tokens(2)
            else {
                assertEquals("Bearer access-2", request.header("Authorization"))
                200 to """{"id":"u","username":"alice","display_name":"Alice","role":"member","created_at":"","updated_at":"","must_change_password":false}"""
            }
        })
        client.refreshToken = "refresh-1"
        client.me()
        assertEquals(listOf("/api/v1/auth/refresh", "/api/v1/users/me"), paths)
    }

    @Test fun lateRefreshDoesNotRestoreSignedOutCredentials() = runBlocking {
        val received = CompletableDeferred<Unit>()
        val gate = CountDownLatch(1)
        val client = ApiClient("http://server", stubbed {
            received.complete(Unit)
            gate.await(5, TimeUnit.SECONDS)
            200 to tokens(2)
        })
        client.refreshToken = "refresh-1"
        var saved = false
        client.onTokens = { saved = true }
        val refresh = async { runCatching { client.refresh() } }
        received.await()
        client.signOut()
        gate.countDown()
        assertTrue(refresh.await().isFailure)
        assertNull(client.accessToken)
        assertNull(client.refreshToken)
        assertEquals(false, saved)
    }

    @Test fun errorClassificationAndWsUrl() {
        assertTrue(ApiException.Api(503, "unavailable", "").isRetryable)
        assertTrue(!ApiException.Api(422, "validation_error", "").isRetryable)
        assertEquals("wss://chat.example.com/api/v1/ws", ApiClient("https://chat.example.com").wsUrl)
        assertEquals("ws://10.0.2.2:8000/api/v1/ws", ApiClient("http://10.0.2.2:8000/").wsUrl)
    }

    @Test fun acceptingAnInviteNeedsNoTokenAndLogsIn() = runBlocking {
        val seen = ArrayList<Pair<String, String?>>()
        var body = ""
        val client = ApiClient("http://server", stubbed { request ->
            seen.add(request.url.encodedPath to request.header("Authorization"))
            if (request.url.encodedPath.endsWith("/accept")) {
                val buffer = okio.Buffer(); request.body!!.writeTo(buffer); body = buffer.readUtf8()
                201 to tokens(3)
            } else 200 to """{"invited_by":"Root","role":"member","channels":["general"],"expires_at":"2026-10-04T00:00:00Z","password_min_length":8}"""
        })
        val preview = client.invitePreview("t_k")
        assertEquals("Root", preview.invitedBy)
        assertEquals(listOf("general"), preview.channels)
        val tokens = client.acceptInvite("t_k", "tanaka", "田中", "pw", "android", null, null)
        assertEquals("alice", tokens.user.username)
        assertEquals("refresh-3", client.refreshToken)
        assertEquals(listOf("/api/v1/invites/t_k" to null, "/api/v1/invites/t_k/accept" to null), seen)
        assertTrue(body, body.contains("\"display_name\":\"田中\""))
    }
}
