package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import java.text.Collator
import java.util.Locale

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

    /** `kind` (M12k): "group" notifies the members; "all" is @channel / @here. `ai` (M66): an AI bot (shown with 「AI」). */
    data class Candidate(val username: String, val label: String, val kind: String = "user", val ai: Boolean = false)

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
        val people = USER_TOKEN.replace(text) { m -> users[m.groupValues[1]]?.let { "@" + it.displayName } ?: L10n.str(R.string.mentions_member) }
        val teams = GROUP_TOKEN.replace(people) { m -> "@" + (groups[m.groupValues[1]]?.name ?: L10n.str(R.string.common_group)) }
        return ALL_TOKEN.replace(teams) { "@" + it.groupValues[1] }
    }

    fun decode(text: String, users: Map<String, UserPublic>, groups: Map<String, GroupOut> = emptyMap()): String {
        val people = USER_TOKEN.replace(text) { m -> users[m.groupValues[1]]?.let { "@" + it.username } ?: m.value }
        val teams = GROUP_TOKEN.replace(people) { m -> groups[m.groupValues[1]]?.let { "@" + it.name } ?: m.value }
        return ALL_TOKEN.replace(teams) { "@" + it.groupValues[1] }
    }

    /** The `@prefix` being typed at the end of `text`, or null. */
    fun query(text: String): String? = QUERY.find(text)?.groupValues?.get(2)

    /**
     * docs/AI.md §2.1: who `@` suggests — people (not bots, not deactivated) and the AI bots (`bot_kind = "ai"`), which
     * answer a mention; no other bot (webhooks, feeds, reservations…). `aiBotIds` (M66): the AI bots of `GET /ai/status`
     * once it was read (null before): then only those, so a stopped or deleted one is not offered either.
     */
    fun suggests(user: UserPublic, aiBotIds: Set<String>?): Boolean = user.deactivatedAt == null && when {
        user.role != "bot" -> true
        aiBotIds != null -> user.id in aiBotIds
        else -> user.botKind == "ai"
    }

    /** How many of the newest messages of a thread and of the channel count as recent (apps/shared/mention-rank.json). */
    const val RECENT_MESSAGES = 50

    /** What [recentSpeakers] reads of a message. */
    data class Spoken(val senderId: String, val deleted: Boolean = false, val type: String = "user")

    /**
     * Whom the list puts first (MOBILE_UI.md §23): what the device holds about the conversation being written in.
     * `recent`: [recentSpeakers], newest first; `members`: the conversation's members as known locally (a DM / group DM:
     * its participants); `me`: offered last.
     */
    data class Context(val recent: List<String> = emptyList(), val members: List<String> = emptyList(), val me: String? = null)

    /**
     * Who spoke recently, newest first, each once (MOBILE_UI.md §23, mention-rank.json `recent`): the thread's senders
     * (its parent and replies, oldest first as given) before the channel's (the loaded timeline). Deleted and system
     * messages do not count; only the newest [cap] counting messages of each list.
     */
    fun recentSpeakers(channel: List<Spoken>, thread: List<Spoken> = emptyList(), cap: Int = RECENT_MESSAGES): List<String> {
        val speakers = LinkedHashSet<String>()
        for (list in listOf(thread, channel)) {
            list.filter { !it.deleted && it.type != "system" }.takeLast(cap).asReversed().forEach { speakers.add(it.senderId) }
        }
        return speakers.toList()
    }

    private fun MessageState.spoken() = Spoken(senderId, deleted, type)

    /**
     * The composer's context: the loaded messages' senders (in a thread, its own first) and a DM's participants. A
     * channel's members are not held on the device (GET /channels/{id}/members is read by the member screens only), so
     * a channel has no members tier.
     */
    fun context(store: Store, channelId: String, parentId: String?): Context {
        val thread = if (parentId == null) emptyList() else listOfNotNull(store.message(channelId, parentId)?.spoken()) + store.replies(channelId, parentId).map { it.spoken() }
        return documentContext(store, channelId).copy(recent = recentSpeakers(store.messages(channelId).map { it.spoken() }, thread))
    }

    /** A canvas (MOBILE_UI.md §23): no conversation, only the participants of the DM it belongs to, and me last. */
    fun documentContext(store: Store, channelId: String?): Context =
        Context(members = channelId?.let { store.channel(it)?.channel?.dmUserIds }.orEmpty(), me = store.me?.id)

    /**
     * `aiBotIds`: as [suggests]; the AI bots are marked `ai`. People are ranked by [context] (MOBILE_UI.md §23): a prefix
     * match first, then recent speakers, members, everybody else and me, then by display name; the groups and
     * @channel / @here follow as before.
     */
    fun candidates(query: String, users: Collection<UserPublic>, groups: Collection<GroupOut> = emptyList(), limit: Int = 8, aiBotIds: Set<String>? = null, context: Context = Context()): List<Candidate> {
        val q = query.lowercase()
        val recent = HashMap<String, Int>()
        context.recent.forEach { recent.putIfAbsent(it, recent.size) }
        val members = context.members.toSet()
        fun tier(id: String) = when {
            id == context.me -> 3
            id in recent -> 0
            id in members -> 1
            else -> 2
        }
        fun match(user: UserPublic) = if (q.isEmpty() || user.username.lowercase().startsWith(q) || user.displayName.lowercase().startsWith(q)) 0 else 1
        val collator = Collator.getInstance(Locale.JAPANESE)
        val people = users.filter { suggests(it, aiBotIds) }
            .filter { it.username.lowercase().startsWith(q) || it.displayName.lowercase().contains(q) }
            .sortedWith(
                compareBy<UserPublic>({ match(it) }, { tier(it.id) }, { if (tier(it.id) == 0) recent.getValue(it.id) else 0 })
                    .thenComparator { a, b -> collator.compare(a.displayName, b.displayName) }
                    .thenBy { it.username },
            )
            .map { Candidate(it.username, it.displayName, ai = it.role == "bot") }
        val teams = groups.filter { it.name.lowercase().startsWith(q) || (it.description ?: "").lowercase().contains(q) }
            .sortedBy { it.name }
            .map { Candidate(it.name, L10n.str(R.string.mentions_group_people, it.memberIds.size) + (it.description?.let { d -> " · $d" } ?: ""), kind = "group") }
        val special = listOf(Candidate("channel", L10n.str(R.string.mentions_notify_everyone), kind = "all"), Candidate("here", L10n.str(R.string.mentions_notify_everyone), kind = "all")).filter { it.username.startsWith(q) }
        return (people + teams + special).take(limit)
    }

    /** Replace the `@prefix` at the end of `text` with the chosen handle. */
    fun complete(text: String, username: String): String {
        val match = QUERY.find(text) ?: return text
        return text.substring(0, match.range.first) + match.groupValues[1] + "@" + username + " "
    }
}
