package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.UserPublic

/**
 * The composer shows `@username`; the wire format is `<@uuid>` / `<!channel>` (DATA_MODEL.md).
 * Encoding happens on send, decoding when a message is opened for editing.
 */
object Mentions {
    // After anything but an ASCII handle character, @ or <: 「まとめます。@kano」 is a mention, a@b.jp and <@uuid> are not.
    private val HANDLE = Regex("""(^|[^A-Za-z0-9._@<-])@([A-Za-z0-9._-]+)""")
    private val USER_TOKEN = Regex("""<@([0-9a-f-]{36})>""")
    private val ALL_TOKEN = Regex("""<!(channel|here)>""")
    private val GROUP_TOKEN = Regex("""<@group:([0-9a-f-]{36})>""")
    private val QUERY = Regex("""(^|[^A-Za-z0-9._@<-])@([\p{L}\p{M}\p{N}._-]*)$""")

    /** `kind` (M12k): "group" notifies the members; "all" is @channel / @here. */
    data class Candidate(val username: String, val label: String, val kind: String = "user")

    fun encode(text: String, users: Collection<UserPublic>, groups: Collection<GroupOut> = emptyList()): String {
        val byName = HashMap<String, String>()
        users.forEach { byName[it.username.lowercase()] = "<@${it.id}>" }
        groups.forEach { byName[it.name.lowercase()] = "<@group:${it.id}>" } // names never collide (server)
        return HANDLE.replace(text) { match ->
            val lead = match.groupValues[1]
            val name = match.groupValues[2].lowercase()
            when {
                name == "channel" || name == "here" -> "$lead<!$name>"
                byName[name] != null -> lead + byName.getValue(name)
                else -> match.value
            }
        }
    }

    /** Mention tokens as display names, for notifications and previews. */
    fun toNames(text: String, users: Map<String, UserPublic>, groups: Map<String, GroupOut> = emptyMap()): String {
        val people = USER_TOKEN.replace(text) { m -> users[m.groupValues[1]]?.let { "@" + it.displayName } ?: "@メンバー" }
        val teams = GROUP_TOKEN.replace(people) { m -> "@" + (groups[m.groupValues[1]]?.name ?: "グループ") }
        return ALL_TOKEN.replace(teams) { "@" + it.groupValues[1] }
    }

    fun decode(text: String, users: Map<String, UserPublic>, groups: Map<String, GroupOut> = emptyMap()): String {
        val people = USER_TOKEN.replace(text) { m -> users[m.groupValues[1]]?.let { "@" + it.username } ?: m.value }
        val teams = GROUP_TOKEN.replace(people) { m -> groups[m.groupValues[1]]?.let { "@" + it.name } ?: m.value }
        return ALL_TOKEN.replace(teams) { "@" + it.groupValues[1] }
    }

    /** The `@prefix` being typed at the end of `text`, or null. */
    fun query(text: String): String? = QUERY.find(text)?.groupValues?.get(2)

    fun candidates(query: String, users: Collection<UserPublic>, groups: Collection<GroupOut> = emptyList(), limit: Int = 6): List<Candidate> {
        val q = query.lowercase()
        val people = users.filter { it.deactivatedAt == null }
            .filter { it.username.lowercase().startsWith(q) || it.displayName.lowercase().contains(q) }
            .sortedBy { it.username }
            .map { Candidate(it.username, it.displayName) }
        val teams = groups.filter { it.name.lowercase().startsWith(q) || (it.description ?: "").lowercase().contains(q) }
            .sortedBy { it.name }
            .map { Candidate(it.name, "グループ · ${it.memberIds.size} 人" + (it.description?.let { d -> " · $d" } ?: ""), kind = "group") }
        val special = listOf(Candidate("channel", "全員に通知", kind = "all"), Candidate("here", "全員に通知", kind = "all")).filter { it.username.startsWith(q) }
        return (people + teams + special).take(limit)
    }

    /** Replace the `@prefix` at the end of `text` with the chosen handle. */
    fun complete(text: String, username: String): String {
        val match = QUERY.find(text) ?: return text
        return text.substring(0, match.range.first) + match.groupValues[1] + "@" + username + " "
    }
}
