package jp.chikuwachat.android.ui

import android.util.Base64
import androidx.compose.ui.graphics.ImageBitmap
import jp.chikuwachat.android.platform.BoundedImage
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

    /** The setup's QR code (the server's PNG), bounded (2026-11-16, [BoundedImage]): an oversized one is no picture. */
    fun qrBitmap(base64: String): ImageBitmap? = runCatching {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        BoundedImage.image(bytes, QR_MAX_SIDE, BoundedImage.SMALL_MAX_PIXELS)
    }.getOrNull()

    /** The QR code is shown about 200 dp wide. */
    private const val QR_MAX_SIDE = 1024

    /** The recovery codes as one text block for the clipboard. */
    fun recoveryCodesText(codes: List<String>): String =
        (listOf(L10n.str(R.string.totp_taylis_recovery_codes_each_works_once), "") + codes).joinToString("\n")
}
