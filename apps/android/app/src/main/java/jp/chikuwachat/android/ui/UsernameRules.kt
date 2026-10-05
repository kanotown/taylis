package jp.chikuwachat.android.ui
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/**
 * M96: usernames can change (my own: 3 times in 24 hours, DATA_MODEL.md users「ユーザー名の変更」). The screen checks what
 * the server checks before sending; whether a name is taken (by a person or a group) only the server knows. Same rules
 * and texts as the desktop (apps/desktop/src/ui/username.ts) and iOS (UsernameRules.swift).
 */
object UsernameRules {
    /** groups.schemas.RESERVED_NAMES on the server; `deleted-…` is the anonymized accounts' prefix. */
    val reserved = setOf("channel", "here", "everyone", "all", "group")
    const val ANONYMIZED_PREFIX = "deleted-"
    val LIMIT_NOTE: String get() = L10n.str(R.string.username_rules_you_can_change_it_up_to)
    private val pattern = Regex("^[a-z0-9._-]+$")

    /** As the field keeps it: lowercase, no surrounding spaces. */
    fun normalize(value: String): String = value.trim().lowercase()

    /** Why [value] cannot be a username (null: send it and let the server decide). */
    fun problem(value: String): String? {
        val name = normalize(value)
        return when {
            name.isEmpty() -> L10n.str(R.string.username_rules_enter_a_username)
            name.length < 3 || name.length > 32 -> L10n.str(R.string.username_rules_use_3_32_characters)
            !pattern.matches(name) -> L10n.str(R.string.username_rules_only_a_z_0_9_are)
            name in reserved || name.startsWith(ANONYMIZED_PREFIX) -> L10n.str(R.string.username_rules_this_username_is_reserved_and_cant)
            else -> null
        }
    }

    /** What the screen says under the field. */
    fun hint(hasPassword: Boolean): String =
        (if (hasPassword) L10n.str(R.string.username_rules_password_sign_in_uses_the_new) else "") +
            L10n.str(R.string.username_rules_past_messages_and_mentions_stay_as)
}
