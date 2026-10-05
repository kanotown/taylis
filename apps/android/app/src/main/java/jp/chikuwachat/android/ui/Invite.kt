package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.InviteLabPreview
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

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
            lab.supervisorName?.ifBlank { null }?.let { L10n.str(R.string.invite_supervisor, it) },
        )
        val roster = if (who.isEmpty()) L10n.str(R.string.invite_you_will_be_listed_in_the) else L10n.str(R.string.invite_listed_as, who.joinToString(L10n.str(R.string.common_list_separator_dot)))
        return if (lab.times) roster + L10n.str(R.string.invite_a_times_channel_will_be_created) else roster
    }

    /** Invite failures in words; null for anything that is not invite specific. */
    fun errorText(code: String): String? = when (code) {
        "invite_not_found" -> L10n.str(R.string.invite_this_invite_link_is_not_valid)
        "invite_expired" -> L10n.str(R.string.invite_this_invite_link_has_expired)
        "invite_exhausted" -> L10n.str(R.string.invite_this_invite_link_has_already_been)
        "invite_revoked" -> L10n.str(R.string.invite_this_invite_link_has_been_revoked)
        "username_taken" -> L10n.str(R.string.invite_this_username_is_already_taken)
        "validation_error" -> L10n.str(R.string.invite_check_what_you_entered)
        else -> null
    }
}
