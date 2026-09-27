package jp.chikuwachat.android.ui

/** Invite links (M12h): `<server>/invite/<token>`; the token is 20-128 URL-safe characters. */
object Invite {
    private val TOKEN = Regex("^[A-Za-z0-9_-]{20,128}$")
    private val LINK = Regex("^\\s*(https?://[^\\s/?#]+)/invite/([^\\s/?#]+)", RegexOption.IGNORE_CASE)

    data class Target(val server: String, val token: String)

    fun url(baseUrl: String, token: String): String = baseUrl.trimEnd('/') + "/invite/" + token

    /** The server and the token from a pasted link (trailing path, query and fragment ignored). */
    fun parse(text: String): Target? {
        val match = LINK.find(text) ?: return null
        val token = match.groupValues[2]
        return if (TOKEN.matches(token)) Target(match.groupValues[1], token) else null
    }

    /** Invite failures in words; null for anything that is not invite specific. */
    fun errorText(code: String): String? = when (code) {
        "invite_not_found" -> "この招待リンクは無効です"
        "invite_expired" -> "この招待リンクは期限切れです"
        "invite_exhausted" -> "この招待リンクはすでに使われています"
        "invite_revoked" -> "この招待リンクは取り消されています"
        "username_taken" -> "このユーザー名はすでに使われています"
        "validation_error" -> "入力内容を確認してください"
        else -> null
    }
}
