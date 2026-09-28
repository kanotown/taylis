package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.SidebarSectionOut

import jp.chikuwachat.android.sync.ChannelState
import java.time.Instant

/** Channel-list rules shared by the list, the badge and notifications (Slack / Mattermost conventions). */
object Channels {
    /** Level "none" or an active timed mute (PUSH_NOTIFICATIONS.md §4). */
    fun isMuted(channel: ChannelState, now: Instant = Instant.now()): Boolean {
        val pref = channel.channel.notification ?: return false
        if (pref.level == "none") return true
        val until = pref.mutedUntil?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return false
        return until.isAfter(now)
    }

    /**
     * M24: someone else's times that I have not set to level "all" is quiet unread: unread only with a mention, a faint
     * dot otherwise (SYNC_PROTOCOL.md §10.5; the vectors in apps/shared/unread-rules.json). A mute takes precedence.
     */
    fun isQuiet(channel: ChannelState, meId: String?, now: Instant = Instant.now()): Boolean {
        val owner = channel.channel.timesOwnerId ?: return false
        return owner != meId && channel.channel.notification?.level != "all" && !isMuted(channel, now)
    }

    /**
     * Bold, the unread filter and the like (§10.5): a muted or quiet conversation is unread only when I am mentioned.
     * `meId` is who is looking: my own times is an ordinary channel.
     */
    fun hasUnread(channel: ChannelState, meId: String?, now: Instant = Instant.now()): Boolean =
        channel.isMember && if (isMuted(channel, now) || isQuiet(channel, meId, now)) channel.mentionCount > 0 else channel.unreadCount > 0

    /** M24: the faint dot of a quiet row with new posts but no mention (a muted row shows nothing). */
    fun showsQuietDot(channel: ChannelState, meId: String?, now: Instant = Instant.now()): Boolean =
        channel.isMember && channel.unreadCount > 0 && isQuiet(channel, meId, now) && !hasUnread(channel, meId, now)

    /** Badge number: mentions for channels and muted conversations, every message for DMs (quiet rows too: they are channels). */
    fun badgeCount(channel: ChannelState, now: Instant = Instant.now()): Int = when {
        isMuted(channel, now) -> channel.mentionCount
        channel.channel.isDm -> channel.unreadCount
        else -> channel.mentionCount
    }

    data class Sections(
        val channels: List<ChannelState>,
        val dms: List<ChannelState>,
        val browse: List<ChannelState>,
        /** Starred conversations (M12a); left out of every other section. */
        val favorites: List<ChannelState> = emptyList(),
        /** My own sections (M14f), in order; their conversations are left out of `channels` / `dms`. */
        val custom: List<Pair<SidebarSectionOut, List<ChannelState>>> = emptyList(),
        /** M24: times channels I am in, mine first, then by name; left out of `channels`. */
        val times: List<ChannelState> = emptyList(),
    )

    /**
     * List order: favorites, channels by name, times (M24), DMs by recency, joinable channels by name. The open one
     * always stays. `meId` decides which times is mine (first, and never quiet).
     */
    fun sections(
        all: Collection<ChannelState>,
        unreadOnly: Boolean = false,
        currentId: String? = null,
        now: Instant = Instant.now(),
        favorites: Set<String> = emptySet(),
        sidebar: List<SidebarSectionOut> = emptyList(),
        meId: String? = null,
    ): Sections {
        fun keep(channel: ChannelState) = !unreadOnly || channel.id == currentId || hasUnread(channel, meId, now)
        fun starred(channel: ChannelState) = channel.id in favorites
        val placed = HashMap<String, String>()
        sidebar.forEach { section -> section.channelIds.forEach { placed[it] = section.id } }
        fun loose(channel: ChannelState) = !starred(channel) && channel.id !in placed
        return Sections(
            favorites = all.filter { it.isMember && !it.channel.archived && starred(it) && keep(it) }.sortedBy { it.channel.name ?: it.channel.lastMessageAt ?: "" },
            custom = sidebar.map { section ->
                val members = all.filter { it.isMember && !it.channel.archived && !starred(it) && keep(it) && placed[it.id] == section.id }
                section to (members.filter { !it.channel.isDm }.sortedBy { it.channel.name ?: "" } + members.filter { it.channel.isDm }.sortedByDescending { it.channel.lastMessageAt ?: "" })
            },
            channels = all.filter { it.isMember && !it.channel.isDm && !it.channel.isTimes && !it.channel.archived && loose(it) && keep(it) }.sortedBy { it.channel.name ?: "" },
            times = all.filter { it.isMember && it.channel.isTimes && !it.channel.archived && loose(it) && keep(it) }
                .sortedWith(compareBy<ChannelState> { it.channel.timesOwnerId != meId }.thenBy { it.channel.name ?: "" }),
            dms = all.filter { it.isMember && it.channel.isDm && loose(it) && keep(it) }.sortedByDescending { it.channel.lastMessageAt ?: "" },
            browse = if (unreadOnly) emptyList() else all.filter { !it.isMember && !it.channel.archived }.sortedBy { it.channel.name ?: "" },
        )
    }
}
