package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.ParentThread
import jp.chikuwachat.android.api.hitsKeyword
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

    /** [messageNotifies] for a conversation: nothing while it is muted, else by its level resolved for me. */
    fun notifies(channel: ChannelState, overall: String, meId: String?, facts: Facts, now: Instant = Instant.now()): Boolean =
        !isMuted(channel, now) && messageNotifies(resolved(channel, overall, meId), facts)

    /** Where a message sits for the notification rule: top level, a reply only in its thread, a reply also in the channel. */
    enum class Reply { NONE, THREAD_ONLY, ALSO_IN_CHANNEL }

    /**
     * What one message (from someone else) tells the rule about me (apps/shared/notify-rules.json). `follower`: I am in
     * the reply's parent_thread.participant_ids. `unfollowed`: I took myself off the thread by hand.
     */
    data class Facts(
        val reply: Reply,
        val follower: Boolean = false,
        val unfollowed: Boolean = false,
        val mentioned: Boolean = false,
        val mentionAll: Boolean = false,
        val keyword: Boolean = false,
    )

    /**
     * The facts of a new message for me. The follower comes from the event's `parent_thread` (else the thread state held
     * here). The server does not tell clients who unfollowed by hand, but it auto-follows everyone a reply mentions by id
     * or by keyword (THREADS.md §2) except them: a thread-only reply that names me while `parent_thread` leaves me out
     * means I unfollowed it by hand. Without a `parent_thread` that cannot be told, so it is not assumed.
     */
    fun facts(message: MessageOut, meId: String, keywords: List<String>, thread: ParentThread?, followingHeld: Boolean): Facts {
        val reply = when {
            message.parentId == null -> Reply.NONE
            message.alsoInChannel -> Reply.ALSO_IN_CHANNEL
            else -> Reply.THREAD_ONLY
        }
        val mentioned = meId in message.mentionedUserIds
        val keyword = hitsKeyword(message.body, keywords)
        val follower = if (thread != null) meId in thread.participantIds else reply != Reply.NONE && followingHeld
        val unfollowed = reply == Reply.THREAD_ONLY && thread != null && !follower && (mentioned || keyword)
        return Facts(reply, follower, unfollowed, mentioned, message.mentionAll, keyword)
    }

    /**
     * The server's PushPlanner rule (handle + select_recipients, PUSH_NOTIFICATIONS.md §4) for a conversation's resolved
     * `level`, before the checks each side does on its own (mute, DND, already read, looking at it now): nothing at
     * "none"; at "mentions" only when involved (@channel, mentioned, a keyword, a follower of the reply's thread). A
     * reply only in its thread never notifies one who unfollowed it by hand, and at "all" too only the involved or its
     * followers (Slack's rule). A reply also sent to the channel counts as a channel message.
     */
    fun messageNotifies(level: String, facts: Facts): Boolean {
        if (level == NONE) return false
        if (facts.reply == Reply.THREAD_ONLY && facts.unfollowed) return false
        val involved = facts.mentionAll || facts.mentioned || facts.keyword || facts.follower
        if (level == MENTIONS && !involved) return false
        if (facts.reply == Reply.THREAD_ONLY && !involved) return false
        return true
    }
}
