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
import org.junit.Assert.assertFalse
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

    @Test fun lostRefreshAnswerIsRetriedWithinTheGraceWithTheSameToken() = runBlocking { // §7.2
        val sent = ArrayList<String>()
        var attempts = 0
        val sleeps = ArrayList<Long>()
        var now = 0L
        val client = ApiClient("http://server", stubbed { request ->
            val buffer = okio.Buffer(); request.body?.writeTo(buffer); sent.add(buffer.readUtf8())
            attempts += 1
            if (attempts == 1) throw java.io.IOException("connection reset") // the server may have rotated already
            200 to tokens(2)
        }, clock = { now }, sleep = { sleeps.add(it); now += it })
        client.refreshToken = "refresh-1"
        assertFalse(client.hasFreshAccessToken())
        client.refresh()
        assertEquals(listOf(1_000L), sleeps)
        assertEquals(2, sent.size)
        assertTrue(sent.all { it.contains("refresh-1") }) // the old token again, inside the 30 s grace
        assertEquals("refresh-2", client.refreshToken)
        assertTrue(client.hasFreshAccessToken()) // expires_in 900: no rotation needed on the next connect
        now += 841_000
        assertFalse(client.hasFreshAccessToken()) // under 60 s left
    }

    @Test fun refreshGivesUpOnceTheGraceWouldBeOver() = runBlocking {
        var now = 0L
        val client = ApiClient("http://server", stubbed { throw java.io.IOException("offline") }, clock = { now }, sleep = { now += it })
        client.refreshToken = "refresh-1"
        try { client.refresh(); fail("expected a network error") } catch (e: ApiException.Network) { assertTrue(now < 25_000) }
        assertEquals("refresh-1", client.refreshToken) // kept: the session is not over
    }

    @Test fun logoutRenewsAnExpiredTokenAndSaysWhetherTheServerKnows() = runBlocking { // §11
        val paths = ArrayList<String>()
        val client = ApiClient("http://server", stubbed { request ->
            paths.add(request.url.encodedPath + " " + request.header("Authorization"))
            when {
                request.url.encodedPath.endsWith("/auth/refresh") -> 200 to tokens(2)
                request.header("Authorization") == "Bearer access-1" -> 401 to """{"error":{"code":"token_expired","message":"expired","details":{}}}"""
                else -> 204 to ""
            }
        })
        var signedOut = false
        client.onSignedOut = { signedOut = true }
        client.accessToken = "access-1"; client.refreshToken = "refresh-1"
        assertTrue(client.logout())
        assertEquals(listOf("/api/v1/auth/logout Bearer access-1", "/api/v1/auth/refresh null", "/api/v1/auth/logout Bearer access-2"), paths)
        assertTrue(signedOut)
        assertNull(client.refreshToken)

        val offline = ApiClient("http://server", stubbed { throw java.io.IOException("offline") }, sleep = {})
        offline.accessToken = "a"; offline.refreshToken = "r"
        assertFalse(offline.logout()) // not revoked on the server: the caller drops the push token
        assertNull(offline.refreshToken)
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

    @Test fun loginSendsTheTotpCodeOnlyWhenGiven() = runBlocking {
        val bodies = ArrayList<String>()
        val client = ApiClient("http://server", stubbed { request ->
            val buffer = okio.Buffer(); request.body?.writeTo(buffer); val body = buffer.readUtf8(); bodies.add(body)
            when {
                request.url.encodedPath == "/api/v1/auth/totp" -> 200 to """{"enabled":true,"enabled_at":"2026-09-27T00:00:00Z","recovery_codes_left":7}"""
                body.contains("totp_code") -> 200 to tokens(5)
                else -> 401 to """{"error":{"code":"totp_required","message":"Two-factor code required","details":{}}}"""
            }
        })
        try { client.login("alice", "pw", "android", null, null); fail("expected totp_required") } catch (e: ApiException.Api) { assertEquals("totp_required", e.code) }
        val tokens = client.login("alice", "pw", "android", null, null, totpCode = "123456")
        assertEquals("refresh-5", tokens.refreshToken)
        assertFalse(bodies[0].contains("totp_code"))
        assertTrue(bodies[1], bodies[1].contains("\"totp_code\":\"123456\""))
        val status = client.totpStatus()
        assertTrue(status.enabled); assertEquals(7, status.recoveryCodesLeft)
    }

    @Test fun requestsWithoutATokenShareOneRefresh() = runBlocking { // WORKSPACES.md §8: a background workspace
        var refreshes = 0
        val gate = CountDownLatch(1)
        val client = ApiClient("http://server", stubbed { request ->
            when (request.url.encodedPath) {
                "/api/v1/auth/refresh" -> { refreshes += 1; gate.await(5, TimeUnit.SECONDS); 200 to tokens(2) }
                "/api/v1/sync/summary" -> 200 to """{"badge":3,"has_unread":true}"""
                else -> 200 to """{"product":"chikuwachat","workspace_id":"w1","name":"開発チーム","api_version":"0.1.0"}"""
            }
        })
        client.refreshToken = "refresh-1"
        val first = async(kotlinx.coroutines.Dispatchers.IO) { client.syncSummary() }
        val second = async(kotlinx.coroutines.Dispatchers.IO) { client.syncSummary() }
        Thread.sleep(200)
        gate.countDown()
        assertEquals(3, first.await().badge)
        assertTrue(second.await().hasUnread)
        assertEquals(1, refreshes)
        assertEquals("refresh-2", client.refreshToken)
        // GET /server needs no sign-in.
        val info = ApiClient("http://server", stubbed { request ->
            assertNull(request.header("Authorization"))
            200 to """{"product":"chikuwachat","workspace_id":"w1","name":"開発チーム","api_version":"0.1.0"}"""
        }).serverInfo()
        assertEquals("w1", info.workspaceId)
        assertEquals("開発チーム", info.name)
    }

    @Test fun messageRevisionsDecode() = runBlocking {
        val paths = ArrayList<String>()
        val client = ApiClient("http://server", stubbed { request ->
            paths.add(request.url.encodedPath)
            200 to """[{"body":"old","written_at":"2026-09-27T00:00:00Z","replaced_at":"2026-09-27T00:05:00Z"}]"""
        })
        client.accessToken = "a"
        val rows = client.messageRevisions("m1")
        assertEquals(listOf(jp.chikuwachat.android.api.MessageRevisionOut("old", "2026-09-27T00:00:00Z", "2026-09-27T00:05:00Z")), rows)
        assertEquals(listOf("/api/v1/messages/m1/revisions"), paths)
    }
}
