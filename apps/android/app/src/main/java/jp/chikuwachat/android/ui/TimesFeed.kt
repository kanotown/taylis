package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.ParentThread
import jp.chikuwachat.android.api.TimesFeedOut
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.MyPollPart
import jp.chikuwachat.android.sync.TimelineEvent
import jp.chikuwachat.android.sync.NotificationLevels
import java.time.Instant
import java.time.OffsetDateTime

/**
 * L8 (docs/TIMES_FEED.md): the Times feed's rows as this device holds them. `loaded`: a first page arrived (an empty
 * list then means there is nothing to show, not that it is still being read). Kept in memory only (§5).
 *
 * `loads`: page reads on their way; `journal`: the events that arrived meanwhile, applied again over each page that
 * arrives (its rows were read before them): a new row is not lost, an edit not undone, a row deleted while loading (its
 * tombstone) not brought back.
 */
data class TimesFeedState(
    val rows: List<MessageOut> = emptyList(),
    val nextCursor: String? = null,
    val loaded: Boolean = false,
    val loads: Int = 0,
    val journal: List<TimelineEvent> = emptyList(),
)

/**
 * L8: the feed's rules (TIMES_FEED.md §2, §4, §5), plain list work kept apart from the screen. The first page replaces
 * what is held (on opening, after reconnecting, on pull to refresh); later pages add what is not there yet; every page
 * keeps only the rows of the times I still read, then takes again the events that arrived while it was read. Live
 * events and the rows the store takes otherwise keep it while the pane is on screen; a channel left, muted or no longer
 * a times takes its rows along.
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

    /** A page read starts: events from now on are kept to be applied again over its answer. */
    fun beginLoad(state: TimesFeedState): TimesFeedState = state.copy(loads = state.loads + 1)

    /** A page read ended without its page (failed, superseded, left the screen); the last one forgets the journal. */
    fun endLoad(state: TimesFeedState): TimesFeedState {
        val loads = (state.loads - 1).coerceAtLeast(0)
        return state.copy(loads = loads, journal = if (loads == 0) emptyList() else state.journal)
    }

    /**
     * GET /times/feed without a cursor: replaces everything held, with the rows of the times I still read only (a page
     * read before I left, muted or was removed from one never brings its rows back), then the journal again.
     */
    fun firstPage(state: TimesFeedState, page: TimesFeedOut, channel: (String) -> ChannelState?, now: Instant = Instant.now()): TimesFeedState {
        val rows = page.items.distinctBy { it.id }.filter { isFeedRow(it, channel(it.channelId), now) }.sortedWith(order)
        return endLoad(replay(state.copy(rows = rows, nextCursor = page.nextCursor, loaded = true), channel, now))
    }

    /** The next page: pruned the same way; rows already held (a live one that arrived meanwhile) are not added twice. */
    fun nextPage(state: TimesFeedState, page: TimesFeedOut, channel: (String) -> ChannelState?, now: Instant = Instant.now()): TimesFeedState {
        val held = state.rows.mapTo(HashSet()) { it.id }
        val added = page.items.filter { isFeedRow(it, channel(it.channelId), now) && held.add(it.id) }
        val merged = state.copy(rows = (state.rows + added).sortedWith(order), nextCursor = page.nextCursor)
        return endLoad(replay(merged, channel, now))
    }

    /**
     * An event while the pane is on screen (§5), kept in the journal while a page is on its way. message.created and a
     * row the store took ([TimelineEvent.SYNCED]: a catch-up after a gap, the answer to my own action) put a feed row in
     * its place; updated / deleted replace a held row (an older version never replaces a newer one, and my own poll
     * answers stay, SYNC_PROTOCOL.md §8) or drop it once it is deleted or no longer in the timeline; my poll answer
     * ([TimelineEvent.MY_POLL]) puts my part in whatever the version. A reply's parent takes its new reply count.
     */
    fun applyEvent(state: TimesFeedState, event: TimelineEvent, channel: (String) -> ChannelState?, now: Instant = Instant.now()): TimesFeedState {
        val kept = if (state.loads > 0) state.copy(journal = state.journal + event) else state
        if (!kept.loaded) return kept
        return apply(kept, event, channel, now)
    }

    private fun replay(state: TimesFeedState, channel: (String) -> ChannelState?, now: Instant): TimesFeedState =
        state.journal.sortedBy { it.version }.fold(state) { next, event -> apply(next, event, channel, now) }

    private fun apply(state: TimesFeedState, event: TimelineEvent, channel: (String) -> ChannelState?, now: Instant): TimesFeedState {
        val message = event.message
        var next = when {
            message == null -> state
            event.event == "message.created" || event.event == TimelineEvent.SYNCED || event.event == TimelineEvent.MY_POLL ->
                created(state, message, channel(message.channelId), now, mine = event.event == TimelineEvent.MY_POLL)
            event.event == "message.updated" || event.event == "message.deleted" -> updated(state, message, mine = false)
            else -> state
        }
        event.thread?.let { next = withThread(next, it) }
        return next
    }

    private fun created(state: TimesFeedState, message: MessageOut, channel: ChannelState?, now: Instant, mine: Boolean): TimesFeedState {
        if (state.rows.any { it.id == message.id }) return updated(state, message, mine)
        if (!isFeedRow(message, channel, now) || !inRange(state, message)) return state
        return state.copy(rows = (state.rows + message).sortedWith(order))
    }

    /**
     * A row not held goes in only where the rows held reach: one older than the last of them, with pages still to come,
     * waits for its page (a catch-up of old rows would otherwise stand after a gap).
     */
    private fun inRange(state: TimesFeedState, message: MessageOut): Boolean =
        state.nextCursor == null || state.rows.isEmpty() || order.compare(message, state.rows.last()) < 0

    private fun updated(state: TimesFeedState, message: MessageOut, mine: Boolean): TimesFeedState {
        val index = state.rows.indexOfFirst { it.id == message.id }
        if (index < 0) return state
        val held = state.rows[index]
        if (message.deleted || message.type != "user" || (message.parentId != null && !message.alsoInChannel)) {
            return state.copy(rows = state.rows.filterIndexed { i, _ -> i != index })
        }
        // Older: only the answer to my vote still says my part (another member's newer event overtook it).
        val row = if (message.updatedSeq < held.updatedSeq) {
            (if (mine) withMyPart(held, message) else null) ?: return state
        } else keepingMyPart(message, held)
        if (row == held) return state
        return state.copy(rows = state.rows.toMutableList().also { it[index] = row })
    }

    /** §8: an event (my part null) keeps what I was known to have answered; a response of the same version says it. */
    private fun keepingMyPart(incoming: MessageOut, held: MessageOut): MessageOut {
        val poll = incoming.poll ?: return incoming
        val known = held.poll ?: return incoming
        val kept = MyPollPart.keep(poll, known)
        return if (kept === poll) incoming else incoming.copy(poll = kept)
    }

    private fun withMyPart(held: MessageOut, response: MessageOut): MessageOut? {
        val poll = held.poll ?: return null
        val answer = response.poll ?: return null
        return MyPollPart.taken(poll, answer)?.let { held.copy(poll = it) }
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
     * §7: tapping a row shows it in its channel. A reply also sent to the channel is the channel's row there (no thread);
     * its thread is what 「返信 N 件」 / 「スレッドで返信」 open ([threadOf]).
     */
    fun revealTarget(message: MessageOut): MessageOut =
        if (message.parentId != null && message.alsoInChannel) message.copy(parentId = null) else message

    /** The thread a row's 「返信 N 件」 / 「スレッドで返信」 opens: its own, or (a reply also in the channel) its parent's. */
    fun threadOf(message: MessageOut): String = message.parentId ?: message.id

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
