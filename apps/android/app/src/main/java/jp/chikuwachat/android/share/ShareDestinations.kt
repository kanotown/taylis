package jp.chikuwachat.android.share

import jp.chikuwachat.android.platform.ConversationStyle
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.ui.JumpMatch

/**
 * MOBILE_UI.md §20.3: where a share can go. Conversations I am in that are not archived and where I may start a post
 * (an announcement channel only for its owners and admins, M15a). Without a query: the recent ones first (the jump
 * screen's 「最近の会話」 of this device, then the ones I shared to), then the rest by their newest message; with a query:
 * the jump screen's matching rule (apps/shared/jump-match.json) over channel names and the DM members' names.
 */
object ShareDestinations {
    /** Recent conversations shown before the rest when nothing is typed. */
    const val MAX_RECENT = 8

    fun postable(channel: ChannelState, isAdmin: Boolean): Boolean =
        channel.isMember && !channel.channel.archived && channel.canPostTopLevel(isAdmin)

    data class Lists(val recent: List<ChannelState>, val others: List<ChannelState>)

    fun list(
        query: String,
        channels: Collection<ChannelState>,
        recentIds: List<String>,
        meId: String?,
        isAdmin: Boolean,
        title: (ChannelState) -> String,
        userNames: (String) -> List<String>,
    ): Lists {
        val open = channels.filter { postable(it, isAdmin) }
        if (query.isNotBlank()) {
            val ranked = JumpMatch.rank(query, open) {
                JumpMatch.Item(it.id, title(it), jp.chikuwachat.android.ui.Jump.names(it, meId, userNames))
            }
            return Lists(emptyList(), ranked)
        }
        val byId = open.associateBy { it.id }
        val recent = recentIds.distinct().mapNotNull { byId[it] }.take(MAX_RECENT)
        val taken = recent.map { it.id }.toSet()
        val others = open.filter { it.id !in taken }.sortedWith(
            compareByDescending<ChannelState> { it.channel.lastMessageAt ?: "" }.thenBy { JumpMatch.normalize(title(it)) }.thenBy { it.id },
        )
        return Lists(recent, others)
    }

    /**
     * The workspace and conversation a Direct Share shortcut names ([ConversationStyle.shortcutId]: `conv:<digest of
     * the workspace>:<channel id>`); null for any other id or a workspace this device no longer has.
     */
    fun shortcutTarget(shortcutId: String?, workspaces: List<String>): Pair<String, String>? {
        if (shortcutId == null || !shortcutId.startsWith("conv:")) return null
        for (workspace in workspaces) {
            val prefix = ConversationStyle.shortcutId(workspace, "")
            if (shortcutId.startsWith(prefix)) {
                val channelId = shortcutId.removePrefix(prefix)
                if (channelId.isNotEmpty()) return workspace to channelId
            }
        }
        return null
    }
}
