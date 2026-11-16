package jp.chikuwachat.android.platform

import android.content.Context
import android.content.Intent
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * 2026-11-16 (a hostile-server review): MainActivity is exported (the launcher, and the browser's return from Google
 * sign-in through a BROWSABLE filter), so any app, and any web page through a Chrome `intent:` link with `S.workspace=…`
 * / `S.channel_id=…`, could start it with the extras of a notification or a widget and have the app switch workspaces and
 * open what they name. This app's own intents (notifications, widgets, conversation shortcuts, uploads and shares) carry
 * a random token made once per install, kept in the app's private preferences; MainActivity acts on those extras only
 * when the token matches.
 */
class OpenToken(private val store: KeyValueStore, private val random: SecureRandom = SecureRandom()) {
    /** This install's token, made at the first use. */
    fun value(): String = synchronized(LOCK) {
        store.getString(KEY)?.takeIf { it.length >= MIN_LENGTH } ?: newToken().also { store.putString(KEY, it) }
    }

    /** Whether an intent's token is this install's (compared in constant time). */
    fun matches(candidate: String?): Boolean =
        candidate != null && MessageDigest.isEqual(candidate.toByteArray(Charsets.US_ASCII), value().toByteArray(Charsets.US_ASCII))

    private fun newToken(): String = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(BYTES).also(random::nextBytes))

    companion object {
        const val EXTRA = "jp.chikuwachat.android.extra.OPEN_TOKEN"
        const val KEY = "chikuwa.open_token"
        private const val BYTES = 32
        private const val MIN_LENGTH = 43
        private val LOCK = Any()

        fun of(context: Context): OpenToken = OpenToken(SharedPrefsStore(context.applicationContext))

        /** [intent] with this install's token: an intent of the app's own that MainActivity may act on. */
        fun stamp(context: Context, intent: Intent): Intent = intent.putExtra(EXTRA, of(context).value())

        /** Whether MainActivity may act on [intent]'s extras (it came from one of this app's own intents). */
        fun verify(context: Context, intent: Intent): Boolean = of(context).matches(intent.getStringExtra(EXTRA))
    }
}
