package jp.chikuwachat.android.sync

import java.time.Instant

/**
 * M35: a conversation's notification level and the overall setting (PUSH_NOTIFICATIONS.md §4). The server's `level` is
 * already resolved, but with the overall setting of when it answered: the app resolves again from the channel's own
 * level and my overall setting as the Store has it now, so a change of the overall setting shows at once. The words
 * are [jp.chikuwachat.android.ui.NotificationLabels].
 */
object NotificationLevels {
    const val ALL = "all"
    const val MENTIONS = "mentions"
    const val NONE = "none"

    /** The choices in the order the menus list them. */
    val levels = listOf(ALL, MENTIONS, NONE)

    /**
     * What a conversation notifies me of (the table of §4): its own level if it has one; else nothing when my overall
     * setting is "none", every message of a DM or group DM, mentions in someone else's times (M24), my overall setting
     * in any other channel.
     */
    fun resolve(own: String?, overall: String, isDm: Boolean, othersTimes: Boolean): String = when {
        own != null -> own
        overall == NONE -> NONE
        isDm -> ALL
        othersTimes -> MENTIONS
        else -> overall
    }

    /** The channel's own level (null: it follows the overall setting). */
    fun own(channel: ChannelState): String? = channel.channel.notification?.ownLevel

    /** [resolve] for a conversation seen by `meId` with the overall setting `overall`. */
    fun resolved(channel: ChannelState, overall: String, meId: String?): String {
        val owner = channel.channel.timesOwnerId
        return resolve(own(channel), overall, channel.channel.isDm, othersTimes = owner != null && owner != meId)
    }

    /** Muted until unmuted (the 「ミュート」 switch), apart from a timed mute. */
    fun mutedUntilUnmuted(channel: ChannelState): Boolean = channel.channel.notification?.muted == true

    /** A timed mute (「8 時間ミュート」, /mute) still running. */
    fun timedMuteActive(channel: ChannelState, now: Instant = Instant.now()): Boolean {
        val until = channel.channel.notification?.mutedUntil?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return false
        return until.isAfter(now)
    }

    /** The timed mute to keep when something else changes (null once it has run out). */
    fun keptMutedUntil(channel: ChannelState, now: Instant = Instant.now()): String? =
        if (timedMuteActive(channel, now)) channel.channel.notification?.mutedUntil else null

    /**
     * Muted for the unread rules and the list (SYNC_PROTOCOL.md §10.5): its own level "none", muted until unmuted, or a
     * timed mute still running. The overall setting never counts (setting it to 「なし」 mutes nothing).
     */
    fun isMuted(channel: ChannelState, now: Instant = Instant.now()): Boolean =
        own(channel) == NONE || mutedUntilUnmuted(channel) || timedMuteActive(channel, now)

    /**
     * Whether a new message would notify me (the server's PushPlanner, for the app's own notifications): nothing while
     * muted or at level "none"; at "mentions" only when `involved` (mentioned, a keyword, a thread I follow).
     */
    fun notifies(channel: ChannelState, overall: String, meId: String?, involved: Boolean, now: Instant = Instant.now()): Boolean {
        if (isMuted(channel, now)) return false
        return when (resolved(channel, overall, meId)) {
            NONE -> false
            MENTIONS -> involved
            else -> true
        }
    }
}
