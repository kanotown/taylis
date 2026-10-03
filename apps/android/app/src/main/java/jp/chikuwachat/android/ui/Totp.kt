package jp.chikuwachat.android.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap

/** Two-factor authentication helpers (M12i). */
object Totp {
    /** Spaces dropped; a 6-digit app code or a recovery code (letters, digits, one dash). */
    fun normalize(code: String): String = code.filter { !it.isWhitespace() }

    fun isCode(text: String): Boolean = normalize(text).let { it.length == 6 && it.all(Char::isDigit) }

    /** Failures in words; null for anything that is not 2FA specific. */
    fun errorText(code: String): String? = when (code) {
        "invalid_password" -> "パスワードが違います"
        "invalid_totp" -> "認証コードが違います"
        "totp_required" -> "認証アプリのコードを入力してください"
        "totp_already_enabled" -> "2 要素認証はすでに有効です"
        "totp_setup_required" -> "先に設定を始めてください"
        else -> null
    }

    fun qrBitmap(base64: String): ImageBitmap? = runCatching {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
    }.getOrNull()

    /** The recovery codes as one text block for the clipboard. */
    fun recoveryCodesText(codes: List<String>): String =
        (listOf("Taylis の回復コード (各 1 回だけ使えます)", "") + codes).joinToString("\n")
}
