package jp.chikuwachat.android.ui

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

    /** A muted conversation is unread only when I am mentioned. */
    fun hasUnread(channel: ChannelState, now: Instant = Instant.now()): Boolean =
        channel.isMember && if (isMuted(channel, now)) channel.mentionCount > 0 else channel.unreadCount > 0

    /** Badge number: mentions for channels and muted conversations, every message for DMs. */
    fun badgeCount(channel: ChannelState, now: Instant = Instant.now()): Int = when {
        isMuted(channel, now) -> channel.mentionCount
        channel.channel.isDm -> channel.unreadCount
        else -> channel.mentionCount
    }

    data class Sections(
        val channels: List<ChannelState>,
        val dms: List<ChannelState>,
        val browse: List<ChannelState>,
        /** Starred conversations (M12a); left out of `channels` / `dms`. */
        val favorites: List<ChannelState> = emptyList(),
    )

    /** List order: favorites, channels by name, DMs by recency, joinable channels by name. The open one always stays. */
    fun sections(
        all: Collection<ChannelState>,
        unreadOnly: Boolean = false,
        currentId: String? = null,
        now: Instant = Instant.now(),
        favorites: Set<String> = emptySet(),
    ): Sections {
        fun keep(channel: ChannelState) = !unreadOnly || channel.id == currentId || hasUnread(channel, now)
        fun starred(channel: ChannelState) = channel.id in favorites
        return Sections(
            favorites = all.filter { it.isMember && !it.channel.archived && starred(it) && keep(it) }.sortedBy { it.channel.name ?: it.channel.lastMessageAt ?: "" },
            channels = all.filter { it.isMember && !it.channel.isDm && !it.channel.archived && !starred(it) && keep(it) }.sortedBy { it.channel.name ?: "" },
            dms = all.filter { it.isMember && it.channel.isDm && !starred(it) && keep(it) }.sortedByDescending { it.channel.lastMessageAt ?: "" },
            browse = if (unreadOnly) emptyList() else all.filter { !it.isMember && !it.channel.archived }.sortedBy { it.channel.name ?: "" },
        )
    }
}
