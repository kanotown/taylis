package jp.chikuwachat.android.app

import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.ErrorMessages
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/**
 * M48: Google sign-in (docs/SSO.md §3, §6). The app opens the server's start URL in a Custom Tab with `challenge` =
 * base64url(SHA-256(verifier)); the server talks to Google and sends the browser back to `chikuwachat://sso?ticket=…`
 * (or `?sso_error=<code>`); the app exchanges the ticket with its verifier on the server it started on. A ticket alone
 * is useless to another app that registers the scheme.
 */
object Sso {
    const val SCHEME = "chikuwachat"
    const val HOST = "sso"
    const val PLATFORM = "android"
    /** A started sign-in is kept this long (the server's own request lives 10 minutes, its ticket 2). */
    const val PENDING_TTL_MS = 10 * 60 * 1000L
    private const val VERIFIER_BYTES = 32
    private val TICKET = Regex("^[A-Za-z0-9_-]{1,128}$")
    private val CODE = Regex("^[a-z_]{1,64}$")

    /** 32 random bytes, base64url without padding (43 characters, RFC 7636 §4.1). */
    fun newVerifier(random: SecureRandom = SecureRandom()): String =
        base64Url(ByteArray(VERIFIER_BYTES).also(random::nextBytes))

    /** S256: base64url(SHA-256(verifier)) without padding. */
    fun challenge(verifier: String): String =
        base64Url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

    fun base64Url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun startUrl(serverUrl: String, challenge: String): String =
        serverUrl.trimEnd('/') + "/api/v1/auth/sso/google/start?platform=$PLATFORM&challenge=$challenge"

    sealed interface Callback {
        data class Ticket(val ticket: String) : Callback
        data class Failure(val code: String) : Callback
    }

    /**
     * `chikuwachat://sso?ticket=…` or `chikuwachat://sso?sso_error=<code>`; null for anything else (another link of the
     * scheme, or a return without either). A ticket that cannot be one is a failure (`invalid_ticket`), not sent.
     */
    fun parseCallback(url: String?): Callback? {
        if (url == null) return null
        val uri = runCatching { URI(url.trim()) }.getOrNull() ?: return null
        if (!uri.scheme.equals(SCHEME, ignoreCase = true) || !uri.host.equals(HOST, ignoreCase = true)) return null
        val query = (uri.rawQuery ?: "").split('&').filter { it.isNotEmpty() }.associate { part ->
            val name = part.substringBefore('=')
            val value = part.substringAfter('=', "")
            decode(name) to decode(value)
        }
        query["sso_error"]?.let { code -> return Callback.Failure(if (CODE.matches(code)) code else "provider_error") }
        val ticket = query["ticket"] ?: return null
        return if (TICKET.matches(ticket)) Callback.Ticket(ticket) else Callback.Failure("invalid_ticket")
    }

    private fun decode(text: String): String = runCatching { URLDecoder.decode(text, "UTF-8") }.getOrDefault("")

    /** The Japanese text of a returned `sso_error` (apps/shared/errors.json). */
    fun errorText(code: String): String = ErrorMessages.byCode[code] ?: ErrorMessages.byCode["provider_error"] ?: ErrorMessages.UNKNOWN

    /**
     * The login screen's Google button from GET /auth/methods, null when the server offers none. A server before M48
     * answers 404, and an unreachable one fails; both hide the button (the password form stays).
     */
    suspend fun googleButton(api: ApiClient): GoogleButtonText? = try {
        api.authMethods().google.takeIf { it.enabled }?.let { buttonText(it.domains, it.label) }
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    /**
     * The Google button's words (App Store guideline 4.8, docs/SSO.md §6). A server restricted to Workspace domains
     * names the organisation (its label, else the first domain, 「など」 for several) over 「組織の Google Workspace
     * アカウント」, so the button reads as the organisation's login. Unrestricted, or a server before the field:
     * 「Google でログイン」.
     */
    fun buttonText(domains: List<String>, label: String?): GoogleButtonText {
        val allowed = domains.filter { it.isNotBlank() }
        val first = allowed.firstOrNull() ?: return GoogleButtonText.GOOGLE
        val org = label?.trim()?.takeIf { it.isNotEmpty() } ?: if (allowed.size > 1) L10n.str(R.string.sso_etc, first) else first
        return GoogleButtonText(L10n.str(R.string.sso_sign_in_with_your_account, org), L10n.str(R.string.sso_your_organizations_google_workspace))
    }
}

/** What the Google button says; `subtitle` is set when the button names the organisation. */
data class GoogleButtonText(val title: String, val subtitle: String?) {
    companion object {
        val GOOGLE get() = GoogleButtonText(L10n.str(R.string.sso_sign_in_with_google), null)
    }
}

/** A sign-in waiting for the browser to come back: the server it started on and the verifier behind its challenge. */
@Serializable
data class PendingSso(val serverUrl: String, val verifier: String, val startedAt: Long)

/**
 * The one pending Google sign-in, kept outside memory because the process may die while the browser is open. The
 * verifier is a short-lived secret: the app stores it through the Keystore-encrypted store ([read] / [write]), takes
 * it out once (used or not), and a flow older than [Sso.PENDING_TTL_MS] counts as none and is deleted.
 */
class PendingSsoStore(
    private val read: suspend () -> String?,
    private val write: suspend (String?) -> Unit,
    private val clock: () -> Long = { System.currentTimeMillis() },
) {
    private val json = Json { ignoreUnknownKeys = true }

    /** Replaces any earlier flow: only the latest start URL's ticket can be exchanged. */
    suspend fun save(serverUrl: String, verifier: String): PendingSso =
        PendingSso(serverUrl, verifier, clock()).also { write(json.encodeToString(PendingSso.serializer(), it)) }

    /** The pending flow, removed from storage; null when there is none or it expired. */
    suspend fun take(): PendingSso? {
        val text = read() ?: return null
        write(null)
        return decode(text)?.takeIf { fresh(it) }
    }

    /** Deletes an expired (or unreadable) flow; a fresh one stays. */
    suspend fun purgeExpired() {
        val text = read() ?: return
        if (decode(text)?.let { fresh(it) } != true) write(null)
    }

    private fun decode(text: String): PendingSso? =
        runCatching { json.decodeFromString(PendingSso.serializer(), text) }.getOrNull()

    private fun fresh(pending: PendingSso): Boolean {
        val age = clock() - pending.startedAt
        return age in 0..<Sso.PENDING_TTL_MS
    }
}
