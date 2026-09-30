package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.ErrorMessages
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.app.PendingSsoStore
import jp.chikuwachat.android.app.Sso
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/** M48 Google sign-in (docs/SSO.md §3, §6): PKCE-style verifier, the browser's return, the pending flow, the button. */
class SsoTest {
    // --- verifier and challenge ---------------------------------------------------------------

    @Test fun challengeIsS256OfTheVerifier() {
        // RFC 7636 Appendix B.
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", Sso.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
    }

    @Test fun base64UrlHasNoPadding() {
        val octets = intArrayOf(116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121)
        assertEquals("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", Sso.base64Url(ByteArray(octets.size) { octets[it].toByte() }))
        assertEquals("-_8", Sso.base64Url(byteArrayOf(0xfb.toByte(), 0xff.toByte())))
    }

    @Test fun verifierIs32RandomBytesInTheServersShape() {
        val a = Sso.newVerifier()
        val b = Sso.newVerifier()
        val pattern = Regex("^[A-Za-z0-9_-]{43,128}$") // the server's VERIFIER_PATTERN
        assertTrue(pattern.matches(a))
        assertEquals(43, a.length)
        assertNotEquals(a, b)
        assertTrue(Regex("^[A-Za-z0-9_-]{43}$").matches(Sso.challenge(a))) // CHALLENGE_PATTERN
    }

    @Test fun startUrlNamesAndroidAndTheChallenge() {
        assertEquals(
            "https://chat.example.ac.jp/api/v1/auth/sso/google/start?platform=android&challenge=abc",
            Sso.startUrl("https://chat.example.ac.jp/", "abc"),
        )
    }

    // --- the browser's return -----------------------------------------------------------------

    @Test fun parsesATicket() {
        val ticket = "Qm9vdHN0cmFwLXRpY2tldC0xMjM0NTY3ODkwYWJjZGVm"
        assertEquals(Sso.Callback.Ticket(ticket), Sso.parseCallback("chikuwachat://sso?ticket=$ticket"))
        assertEquals(Sso.Callback.Ticket(ticket), Sso.parseCallback("CHIKUWACHAT://SSO?ticket=$ticket&extra=1"))
    }

    @Test fun parsesAnErrorCode() {
        assertEquals(Sso.Callback.Failure("not_registered"), Sso.parseCallback("chikuwachat://sso?sso_error=not_registered"))
        // An error wins over a ticket; a code that cannot be one reads as a provider error.
        assertEquals(Sso.Callback.Failure("cancelled"), Sso.parseCallback("chikuwachat://sso?ticket=abc&sso_error=cancelled"))
        assertEquals(Sso.Callback.Failure("provider_error"), Sso.parseCallback("chikuwachat://sso?sso_error=%3Cscript%3E"))
    }

    @Test fun aMalformedTicketIsNotSent() {
        assertEquals(Sso.Callback.Failure("invalid_ticket"), Sso.parseCallback("chikuwachat://sso?ticket=a%20b"))
        assertEquals(Sso.Callback.Failure("invalid_ticket"), Sso.parseCallback("chikuwachat://sso?ticket="))
    }

    @Test fun ignoresOtherLinks() {
        assertNull(Sso.parseCallback(null))
        assertNull(Sso.parseCallback("chikuwachat://sso"))
        assertNull(Sso.parseCallback("chikuwachat://other?ticket=abc"))
        assertNull(Sso.parseCallback("https://sso?ticket=abc"))
        assertNull(Sso.parseCallback("not a url"))
    }

    @Test fun errorCodesHaveJapaneseTexts() {
        for (code in listOf("cancelled", "expired", "domain_not_allowed", "email_not_verified", "not_registered", "account_disabled", "provider_error", "invalid_ticket")) {
            assertEquals(ErrorMessages.byCode.getValue(code), Sso.errorText(code))
        }
        assertEquals(ErrorMessages.byCode.getValue("provider_error"), Sso.errorText("something_new"))
    }

    // --- the pending flow ---------------------------------------------------------------------

    private class Stored(var text: String? = null, var now: Long = 1_000_000L) {
        val store = PendingSsoStore({ text }, { text = it }, { now })
    }

    @Test fun pendingFlowIsTakenOnce() = runBlocking {
        val s = Stored()
        s.store.save("https://a.example", "verifier-1")
        val taken = s.store.take()
        assertEquals("https://a.example", taken?.serverUrl)
        assertEquals("verifier-1", taken?.verifier)
        assertNull(s.text)
        assertNull(s.store.take()) // a replayed return finds nothing pending
    }

    @Test fun aNewStartReplacesTheOldOne() = runBlocking {
        val s = Stored()
        s.store.save("https://a.example", "verifier-1")
        s.store.save("https://b.example", "verifier-2")
        assertEquals("https://b.example", s.store.take()?.serverUrl)
    }

    @Test fun pendingFlowExpiresAfterTenMinutes() = runBlocking {
        val s = Stored()
        s.store.save("https://a.example", "v")
        s.now += Sso.PENDING_TTL_MS - 1
        s.store.purgeExpired()
        assertTrue(s.text != null) // still fresh
        s.now += 1
        s.store.purgeExpired()
        assertNull(s.text)

        s.store.save("https://a.example", "v")
        s.now += Sso.PENDING_TTL_MS
        assertNull(s.store.take())
        assertNull(s.text) // deleted even though too old to use
    }

    @Test fun unreadableOrFutureFlowIsNone() = runBlocking {
        val s = Stored(text = "{broken")
        s.store.purgeExpired()
        assertNull(s.text)
        s.store.save("https://a.example", "v")
        s.now -= 60_000 // the clock went back: not trusted
        assertNull(s.store.take())
    }

    // --- the server -----------------------------------------------------------------------------

    private fun stubbed(handler: (Request) -> Pair<Int, String>): OkHttpClient =
        OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val (status, body) = handler(chain.request())
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(status).message("stub")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }).build()

    @Test fun googleButtonFollowsAuthMethods() = runBlocking {
        val on = ApiClient("http://server", stubbed { request ->
            assertEquals("/api/v1/auth/methods", request.url.encodedPath)
            assertNull(request.header("Authorization"))
            200 to """{"password":true,"google":{"enabled":true}}"""
        })
        assertTrue(Sso.googleEnabled(on))
        val off = ApiClient("http://server", stubbed { 200 to """{"password":true,"google":{"enabled":false}}""" })
        assertFalse(Sso.googleEnabled(off))
    }

    @Test fun anOlderServerHidesTheGoogleButton() = runBlocking {
        val old = ApiClient("http://server", stubbed { 404 to """{"detail":"Not Found"}""" })
        assertFalse(Sso.googleEnabled(old))
        val offline = ApiClient("http://server", OkHttpClient.Builder().addInterceptor(Interceptor { throw IOException("offline") }).build())
        assertFalse(Sso.googleEnabled(offline))
    }

    @Test fun exchangeSendsTicketVerifierAndTheLoginDevice() = runBlocking {
        val bodies = HashMap<String, JsonObject>()
        val tokens = """{"access_token":"access-1","refresh_token":"refresh-1","token_type":"bearer","expires_in":900,"session_id":"s",
            "device":{"id":"d","platform":"android","enabled":true,"created_at":"","updated_at":""},
            "user":{"id":"u","username":"taro","display_name":"Taro","role":"member","created_at":"","updated_at":"","must_change_password":false,"has_password":false}}"""
        val client = ApiClient("http://server", stubbed { request ->
            val buffer = Buffer().also { request.body!!.writeTo(it) }
            bodies[request.url.encodedPath] = Json.parseToJsonElement(buffer.readUtf8()).jsonObject
            200 to tokens
        })
        val answer = client.ssoExchange("ticket-1", "verifier-1", "android", "Pixel 9", "0.1.0")
        client.login("taro", "pw", "android", "Pixel 9", "0.1.0")
        val exchange = bodies.getValue("/api/v1/auth/sso/exchange")
        assertEquals("ticket-1", exchange["ticket"]?.jsonPrimitive?.content)
        assertEquals("verifier-1", exchange["verifier"]?.jsonPrimitive?.content)
        assertEquals(bodies.getValue("/api/v1/auth/login")["device"], exchange["device"])
        assertEquals("android", exchange["device"]?.jsonObject?.get("platform")?.jsonPrimitive?.content)
        assertEquals("refresh-1", client.refreshToken)
        assertFalse(answer.user.hasPassword)
    }

    @Test fun userMeWithoutHasPasswordHasOne() {
        val older = """{"id":"u","username":"a","display_name":"A","role":"member","created_at":"","updated_at":"","must_change_password":false}"""
        assertTrue(Codec.snake.decodeFromString(UserMe.serializer(), older).hasPassword)
        val sso = older.dropLast(1) + ""","has_password":false}"""
        assertFalse(Codec.snake.decodeFromString(UserMe.serializer(), sso).hasPassword)
    }
}
