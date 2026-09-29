package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.InviteLabPreview

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

    /**
     * M32: what the invite's lab preset does, in one line for the acceptance screen, with the roster's labels:
     * 「研究室の名簿に 学生 (B4)・指導教員 加納 として載ります。times を作ります。」
     */
    fun labText(lab: InviteLabPreview): String {
        val affiliation = Roster.AFFILIATIONS.firstOrNull { it.first == lab.affiliation }?.second
        val step = when (lab.affiliation) {
            "faculty" -> lab.rank?.let { rank -> Roster.RANKS.firstOrNull { it.first == rank }?.second ?: rank }
            "student" -> lab.grade
            else -> null
        }
        val who = listOfNotNull(
            affiliation?.let { if (step != null) "$it ($step)" else it },
            lab.supervisorName?.ifBlank { null }?.let { "指導教員 $it" },
        )
        val roster = if (who.isEmpty()) "研究室の名簿に載ります。" else "研究室の名簿に ${who.joinToString("・")} として載ります。"
        return if (lab.times) roster + "times を作ります。" else roster
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
