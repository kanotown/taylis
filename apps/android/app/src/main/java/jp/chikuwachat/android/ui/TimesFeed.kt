package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.ParentThread
import jp.chikuwachat.android.api.TimesFeedOut
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.NotificationLevels
import java.time.Instant
import java.time.OffsetDateTime

/**
 * L8 (docs/TIMES_FEED.md): the Times feed's rows as this device holds them. `loaded`: a first page arrived (an empty
 * list then means there is nothing to show, not that it is still being read). Kept in memory only (§5).
 */
data class TimesFeedState(
    val rows: List<MessageOut> = emptyList(),
    val nextCursor: String? = null,
    val loaded: Boolean = false,
)

/**
 * L8: the feed's rules (TIMES_FEED.md §2, §4, §5), plain list work kept apart from the screen. The first page replaces
 * what is held (on opening, after reconnecting, on pull to refresh); later pages add what is not there yet; live
 * message events keep it while the pane is on screen; a channel left, muted or no longer a times takes its rows along.
 */
object TimesFeed {
    /** POST /channels/read-all's scope for the feed's 「すべて既読にする」 (§4). */
    const val READ_ALL_SCOPE = "times"

    /** §7. */
    const val EMPTY_TEXT = "参加している times がありません。チャンネル一覧から times に参加すると、ここに新しい投稿が並びます"

    /** A channel the feed reads (§2): a times I am a member of and have not muted (§10.5's muted(c)); archived ones too. */
    fun isFeedChannel(channel: ChannelState?, now: Instant = Instant.now()): Boolean =
        channel != null && channel.isMember && channel.channel.timesOwnerId != null && !NotificationLevels.isMuted(channel, now)

    /** §5 isFeedRow: a live, user-typed timeline row (top level, or a reply also sent to the channel) of a feed channel. */
    fun isFeedRow(message: MessageOut, channel: ChannelState?, now: Instant = Instant.now()): Boolean =
        message.type == "user" && !message.deleted && (message.parentId == null || message.alsoInChannel) && isFeedChannel(channel, now)

    /** Newest first across channels: created_at, then the id (UUIDv7) for rows of the same instant (§2). */
    val order: Comparator<MessageOut> =
        compareByDescending<MessageOut> { instant(it.createdAt) ?: Instant.EPOCH }.thenByDescending { it.id }

    /** The row's small 「新しい」 dot (§4): after its times' read position. The read position itself never moves here. */
    fun isNew(message: MessageOut, channel: ChannelState?): Boolean =
        channel != null && message.seq > maxOf(channel.lastReadSeq, channel.unsentReadSeq ?: 0)

    /** GET /times/feed without a cursor: replaces everything held. */
    fun firstPage(page: TimesFeedOut): TimesFeedState =
        TimesFeedState(page.items.distinctBy { it.id }.sortedWith(order), page.nextCursor, loaded = true)

    /** The next page: rows already held (a live one that arrived meanwhile) are not added twice. */
    fun nextPage(state: TimesFeedState, page: TimesFeedOut): TimesFeedState {
        val held = state.rows.mapTo(HashSet()) { it.id }
        val added = page.items.filter { held.add(it.id) }
        return state.copy(rows = (state.rows + added).sortedWith(order), nextCursor = page.nextCursor)
    }

    /**
     * A live event while the pane is on screen (§5): message.created puts a feed row in its place; updated / deleted
     * replace a held row (an older version never replaces a newer one) or drop it once it is deleted or no longer in the
     * timeline. A reply's parent takes its new reply count either way.
     */
    fun applyEvent(
        state: TimesFeedState, event: String, message: MessageOut, thread: ParentThread?, channel: ChannelState?, now: Instant = Instant.now(),
    ): TimesFeedState {
        if (!state.loaded) return state
        var next = when (event) {
            "message.created" -> created(state, message, channel, now)
            "message.updated", "message.deleted" -> updated(state, message)
            else -> state
        }
        if (thread != null) next = withThread(next, thread)
        return next
    }

    private fun created(state: TimesFeedState, message: MessageOut, channel: ChannelState?, now: Instant): TimesFeedState {
        if (state.rows.any { it.id == message.id }) return updated(state, message)
        if (!isFeedRow(message, channel, now)) return state
        return state.copy(rows = (state.rows + message).sortedWith(order))
    }

    private fun updated(state: TimesFeedState, message: MessageOut): TimesFeedState {
        val index = state.rows.indexOfFirst { it.id == message.id }
        if (index < 0) return state
        val held = state.rows[index]
        if (message.deleted || message.type != "user" || (message.parentId != null && !message.alsoInChannel)) {
            return state.copy(rows = state.rows.filterIndexed { i, _ -> i != index })
        }
        if (message.updatedSeq < held.updatedSeq) return state
        return state.copy(rows = state.rows.toMutableList().also { it[index] = message })
    }

    /** A reply arrived or went: its parent's 「返信 N 件」 (as the store's applyParentThread, newer counts only). */
    private fun withThread(state: TimesFeedState, thread: ParentThread): TimesFeedState {
        val index = state.rows.indexOfFirst { it.id == thread.id }
        if (index < 0) return state
        val parent = state.rows[index]
        if (thread.updatedSeq <= parent.updatedSeq) return state
        val updated = parent.copy(
            replyCount = thread.replyCount, lastReplyAt = thread.lastReplyAt,
            replyUserIds = thread.replyUserIds ?: parent.replyUserIds, updatedSeq = thread.updatedSeq,
        )
        return state.copy(rows = state.rows.toMutableList().also { it[index] = updated })
    }

    /**
     * Left, muted or no longer a times (§5): that channel's rows go at once. A channel joined or unmuted comes in with the
     * next read (opening, reconnecting, pull to refresh). Returns the same state when nothing goes.
     */
    fun pruned(state: TimesFeedState, channel: (String) -> ChannelState?, now: Instant = Instant.now()): TimesFeedState {
        val kept = state.rows.filter { isFeedChannel(channel(it.channelId), now) }
        return if (kept.size == state.rows.size) state else state.copy(rows = kept)
    }

    /** 「自分の times に書く」 when I have one (the first of mine I am a member of), else 「自分の times を作る」. */
    fun myTimes(channels: Collection<ChannelState>, meId: String?): ChannelState? =
        meId?.let { me -> channels.firstOrNull { it.isMember && it.channel.timesOwnerId == me } }

    private fun instant(iso: String): Instant? =
        runCatching { Instant.parse(iso) }.getOrNull() ?: runCatching { OffsetDateTime.parse(iso).toInstant() }.getOrNull()
}
