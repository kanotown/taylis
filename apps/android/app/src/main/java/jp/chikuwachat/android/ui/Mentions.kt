package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.UserPublic

/**
 * The composer shows `@username`; the wire format is `<@uuid>` / `<!channel>` (DATA_MODEL.md).
 * Encoding happens on send, decoding when a message is opened for editing.
 */
object Mentions {
    private val HANDLE = Regex("""(^|[\s(])@([A-Za-z0-9._-]+)""")
    private val USER_TOKEN = Regex("""<@([0-9a-f-]{36})>""")
    private val ALL_TOKEN = Regex("""<!(channel|here)>""")
    private val QUERY = Regex("""(^|[\s(])@([A-Za-z0-9._-]*)$""")

    data class Candidate(val username: String, val label: String)

    fun encode(text: String, users: Collection<UserPublic>): String {
        val byName = users.associateBy { it.username.lowercase() }
        return HANDLE.replace(text) { match ->
            val lead = match.groupValues[1]
            val name = match.groupValues[2].lowercase()
            when {
                name == "channel" || name == "here" -> "$lead<!$name>"
                byName[name] != null -> "$lead<@${byName.getValue(name).id}>"
                else -> match.value
            }
        }
    }

    /** Mention tokens as display names, for notifications and previews. */
    fun toNames(text: String, users: Map<String, UserPublic>): String =
        ALL_TOKEN.replace(USER_TOKEN.replace(text) { m -> users[m.groupValues[1]]?.let { "@" + it.displayName } ?: "@メンバー" }) { "@" + it.groupValues[1] }

    fun decode(text: String, users: Map<String, UserPublic>): String =
        ALL_TOKEN.replace(USER_TOKEN.replace(text) { m -> users[m.groupValues[1]]?.let { "@" + it.username } ?: m.value }) { "@" + it.groupValues[1] }

    /** The `@prefix` being typed at the end of `text`, or null. */
    fun query(text: String): String? = QUERY.find(text)?.groupValues?.get(2)

    fun candidates(query: String, users: Collection<UserPublic>, limit: Int = 6): List<Candidate> {
        val q = query.lowercase()
        val people = users.filter { it.deactivatedAt == null }
            .filter { it.username.lowercase().startsWith(q) || it.displayName.lowercase().contains(q) }
            .sortedBy { it.username }
            .map { Candidate(it.username, it.displayName) }
        val special = listOf(Candidate("channel", "全員に通知"), Candidate("here", "全員に通知")).filter { it.username.startsWith(q) }
        return (people + special).take(limit)
    }

    /** Replace the `@prefix` at the end of `text` with the chosen handle. */
    fun complete(text: String, username: String): String {
        val match = QUERY.find(text) ?: return text
        return text.substring(0, match.range.first) + match.groupValues[1] + "@" + username + " "
    }
}
