package jp.chikuwachat.android.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/** Two-factor authentication helpers (M12i). */
object Totp {
    /** Spaces dropped; a 6-digit app code or a recovery code (letters, digits, one dash). */
    fun normalize(code: String): String = code.filter { !it.isWhitespace() }

    fun isCode(text: String): Boolean = normalize(text).let { it.length == 6 && it.all(Char::isDigit) }

    /** Failures in words; null for anything that is not 2FA specific. */
    fun errorText(code: String): String? = when (code) {
        "invalid_password" -> L10n.str(R.string.totp_wrong_password)
        "invalid_totp" -> L10n.str(R.string.totp_wrong_authentication_code)
        "totp_required" -> L10n.str(R.string.totp_enter_the_code_from_your_authenticator)
        "totp_already_enabled" -> L10n.str(R.string.totp_two_factor_authentication_is_already_on)
        "totp_setup_required" -> L10n.str(R.string.totp_start_the_setup_first)
        else -> null
    }

    fun qrBitmap(base64: String): ImageBitmap? = runCatching {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
    }.getOrNull()

    /** The recovery codes as one text block for the clipboard. */
    fun recoveryCodesText(codes: List<String>): String =
        (listOf(L10n.str(R.string.totp_taylis_recovery_codes_each_works_once), "") + codes).joinToString("\n")
}
