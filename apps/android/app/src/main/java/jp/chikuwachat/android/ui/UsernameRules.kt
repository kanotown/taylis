package jp.chikuwachat.android.ui

/**
 * M96: usernames can change (my own: 3 times in 24 hours, DATA_MODEL.md users「ユーザー名の変更」). The screen checks what
 * the server checks before sending; whether a name is taken (by a person or a group) only the server knows. Same rules
 * and texts as the desktop (apps/desktop/src/ui/username.ts) and iOS (UsernameRules.swift).
 */
object UsernameRules {
    /** groups.schemas.RESERVED_NAMES on the server; `deleted-…` is the anonymized accounts' prefix. */
    val reserved = setOf("channel", "here", "everyone", "all", "group")
    const val ANONYMIZED_PREFIX = "deleted-"
    const val LIMIT_NOTE = "変更は 24 時間に 3 回までです。"
    private val pattern = Regex("^[a-z0-9._-]+$")

    /** As the field keeps it: lowercase, no surrounding spaces. */
    fun normalize(value: String): String = value.trim().lowercase()

    /** Why [value] cannot be a username (null: send it and let the server decide). */
    fun problem(value: String): String? {
        val name = normalize(value)
        return when {
            name.isEmpty() -> "ユーザー名を入力してください"
            name.length < 3 || name.length > 32 -> "3〜32 文字にしてください"
            !pattern.matches(name) -> "使えるのは a-z、0-9、. _ - だけです"
            name in reserved || name.startsWith(ANONYMIZED_PREFIX) -> "このユーザー名は予約されているため使えません"
            else -> null
        }
    }

    /** What the screen says under the field. */
    fun hint(hasPassword: Boolean): String =
        (if (hasPassword) "パスワードでのログインには新しいユーザー名を使います。" else "") +
            "過去のメッセージとメンションはそのままです。古いユーザー名はすぐにほかの人が使えるようになります。"
}
