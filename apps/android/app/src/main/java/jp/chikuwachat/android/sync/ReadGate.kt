package jp.chikuwachat.android.sync

/**
 * SYNC_PROTOCOL.md §10.1 / §10.2 (M17): visible-range reads only once every unread row is held and the first one
 * has been on screen, so opening a conversation never reads past messages this device never loaded. The same pure
 * rules as desktop and iOS; the banner's text lives with the other labels in ui/Timeline.kt.
 */
object ReadGate {
    /** The largest unread count that gets 「最初の未読へ」 (rows held at once stay near the M22 retention). */
    const val UNREAD_JUMP_MAX = 500
    const val JUMP_PAGE_SIZE = 200
    /** A safety valve for rows that are not counted as unread (system messages): at most 800 rows per press. */
    const val JUMP_MAX_PAGES = 4

    /**
     * Every timeline row with seq > m is held (§7.3: the timeline is the contiguous range from oldestLoadedSeq).
     * Conservative: seqs skip thread replies, so it can be false while the first unread row is in fact loaded.
     */
    fun covers(oldestLoadedSeq: Int?, m: Int): Boolean = oldestLoadedSeq == 0 || (oldestLoadedSeq != null && oldestLoadedSeq <= m + 1)

    /**
     * The newer end is held too: no catch-up is on its way. Between a bootstrap that raised last_seq (reconnect,
     * restart, a channel opened behind) and the end of its catch-up the unread rows may not be here at all.
     */
    fun caughtUp(channel: ChannelState): Boolean = channel.syncedSeq != null && channel.syncedSeq >= channel.lastSeq

    fun readRangeReady(channel: ChannelState): Boolean =
        channel.unreadCount == 0 || (covers(channel.oldestLoadedSeq, channel.lastReadSeq) && caughtUp(channel))

    /** The row the 「新着メッセージ」 divider precedes (Timeline.build uses the same rule). Any type, system rows too. */
    fun firstUnreadRow(rows: List<MessageState>, afterSeq: Int, meId: String?): MessageState? =
        rows.firstOrNull { it.seq != null && it.seq > afterSeq && it.senderId != meId }

    /** Where the divider goes: the held (mark-as-unread) or captured position, only when the range reaches it. */
    fun dividerMark(held: Int?, captured: Int?, oldestLoadedSeq: Int?): Int? {
        val m = held ?: captured ?: return null
        return if (covers(oldestLoadedSeq, m)) m else null
    }

    /** The divider position captured when a conversation opens (or the search view is left): none when nothing is unread. */
    fun openMark(channel: ChannelState): Int? = channel.lastReadSeq.takeIf { channel.unreadCount > 0 }

    /**
     * Rule 2, fourth case: the first unread row is above every visible row and not even partly on screen. The list
     * followed the bottom while nobody looked, a catch-up or reload filled rows in, or a jump overshot: the rows on
     * screen are past unread rows never shown. A look with no visible row judges nothing.
     */
    fun passedUnseen(firstUnread: MessageState?, visible: List<MessageState>, onScreenIds: Set<String>): Boolean {
        val seq = firstUnread?.seq ?: return false
        val top = visible.mapNotNull { it.seq }.minOrNull() ?: return false
        return seq < top && firstUnread.id !in onScreenIds
    }

    /**
     * §10.1 rule 2: set once the first unread row was on screen with the range ready; cleared when it stops being
     * ready or when that row was passed unseen. `visible` = rows shown (the read criterion), `onScreenIds` = ids of
     * rows at least partly on screen.
     */
    fun nextAnchored(
        prev: Boolean, unreadCount: Int, ready: Boolean, firstUnread: MessageState?, visible: List<MessageState>,
        onScreenIds: Set<String> = visible.mapTo(HashSet()) { it.id },
    ): Boolean = when {
        unreadCount == 0 -> true
        !ready -> false
        passedUnseen(firstUnread, visible, onScreenIds) -> false
        prev -> true
        else -> firstUnread == null || visible.any { it.id == firstUnread.id }
    }

    /** §10.2: the same for a thread, where `ready` = the whole thread was fetched and its ThreadState is known. */
    fun nextThreadAnchored(
        prev: Boolean, ready: Boolean, firstUnread: MessageState?, visible: List<MessageState>,
        onScreenIds: Set<String> = visible.mapTo(HashSet()) { it.id },
    ): Boolean =
        ready && !passedUnseen(firstUnread, visible, onScreenIds) && (prev || firstUnread == null || visible.any { it.id == firstUnread.id })

    fun jumpButtonShown(ready: Boolean, unreadCount: Int): Boolean = ready || unreadCount <= UNREAD_JUMP_MAX

    /**
     * 「ここから未読にする」 on row `seq` sets the position to seq - 1. Forward, it reads the rows before `seq`, which
     * must then all be held: otherwise unread rows this device never loaded would be read (the action is not offered,
     * and the engine only pauses reading).
     */
    fun markUnreadOffered(channel: ChannelState, seq: Int): Boolean = seq - 1 <= channel.lastReadSeq || readRangeReady(channel)

    /** Connecting or online: a catch-up may be on its way (offline, none comes until reconnecting). */
    fun syncing(status: EngineStatus): Boolean = status == EngineStatus.CONNECTING || status == EngineStatus.ONLINE

    /** Rule 4: a conversation opened behind waits (at most 3 s) for the catch-up, which may bring its first unread row. */
    fun waitsForCatchUp(status: EngineStatus, channel: ChannelState): Boolean = syncing(status) && channel.isMember && !caughtUp(channel)

    /**
     * Rule 5: catching up and no unread row held yet. The banner waits, or it would flash on every reconnect before
     * the catch-up brings the rows.
     */
    fun awaitingFirstUnread(status: EngineStatus, channel: ChannelState, rows: List<MessageState>, meId: String?): Boolean =
        syncing(status) && !caughtUp(channel) && firstUnreadRow(rows, channel.lastReadSeq, meId) == null

    /**
     * §10.1 rule 5: not over a search position, after positioning, while unread and not anchored, held or landing,
     * and not while a catch-up may still bring the first unread row.
     */
    fun bannerShown(
        focused: Boolean, positioned: Boolean, unreadCount: Int, anchored: Boolean, held: Boolean,
        landing: Boolean = false, awaitingFirstUnread: Boolean = false,
    ): Boolean = !focused && positioned && unreadCount > 0 && !anchored && !held && !landing && !awaitingFirstUnread

    /** 「新着 N 件」 (rule 7): rows from others after seenSeq. Every row it counts is held (rule 4), so N is the true count. */
    fun newBelow(rows: List<MessageState>, seenSeq: Int, meId: String?): Int = rows.count { (it.seq ?: 0) > seenSeq && it.senderId != meId }

    /**
     * Rule 7: seenSeq follows the newest row while the reader is at the bottom, but only once the view is positioned
     * (the list starts at the bottom before it lands on the divider; advancing there would make 「新着 N 件」 zero).
     */
    fun nextSeenSeq(seenSeq: Int, settled: Boolean, atBottom: Boolean, newestSeq: Int): Int =
        if (settled && atBottom && newestSeq > seenSeq) newestSeq else seenSeq

    /** One pass of the visible-range read: the view's new `anchored`, and the seq to mark (null = nothing). */
    data class ReadStep(val anchored: Boolean, val markSeq: Int?)

    fun visibleRead(
        prev: Boolean, channel: ChannelState, rows: List<MessageState>, meId: String?, visible: List<MessageState>,
        onScreenIds: Set<String> = visible.mapTo(HashSet()) { it.id },
    ): ReadStep {
        val anchored = nextAnchored(prev, channel.unreadCount, readRangeReady(channel), firstUnreadRow(rows, channel.lastReadSeq, meId), visible, onScreenIds)
        return ReadStep(anchored, if (anchored) visible.mapNotNull { it.seq }.maxOrNull() else null)
    }
}

/**
 * The read anchor of one open channel view (§10.1 rule 2) as a value: the view keeps it in one state, and tests replay
 * the order of events. Visible rows mark read only while anchored. Nothing is judged while a positioning scroll is
 * landing (the viewport still shows the old position), and a read position that went down is not undone by rows that
 * were already on screen.
 */
data class ReadAnchor(
    val anchored: Boolean = false,
    /** A positioning scroll (the open at the divider, 「最初の未読へ」) is on its way: no judging, no marks, no banner. */
    val landing: Boolean = false,
    /** The read position and the 「ここから未読にする」 hold at the last look, to notice them going down. */
    val readSeq: Int = 0,
    val held: Int? = null,
    /**
     * Rule 2, third case: the ids on screen (partly too) when the position went down. Until a row outside them is seen
     * (a scroll, rows added), the view stays unanchored and marks nothing: the look's own consequences (the banner it
     * brings, a remeasure) change the layout too, and must not undo the lowering with rows that were already there.
     */
    val quiet: Set<String>? = null,
) {
    data class Step(val anchor: ReadAnchor, val markSeq: Int?)

    fun startLanding(): ReadAnchor = copy(landing = true)

    /** The positioning scroll put the first unread row (or its divider) at the top: anchored (rule 2 catches a mis-landing). */
    fun landed(): ReadAnchor = copy(landing = false, anchored = true, quiet = null)

    /** The scroll never happened (the view moved on): back to judging from the screen. */
    fun landingCancelled(): ReadAnchor = copy(landing = false)

    /** The reader was away (the background) or the connection dropped: rule 2-3's next change of the view has come. */
    fun resumed(): ReadAnchor = copy(quiet = null)

    /** One look at the screen: the anchor after it, and the seq visible rows mark read (null = nothing). */
    fun observe(channel: ChannelState, held: Int?, rows: List<MessageState>, meId: String?, visible: List<MessageState>, onScreenIds: Set<String>): Step {
        if (landing) return Step(this, null)
        // Rule 2, third case: lowered here or on another device (a set, a lower bootstrap), or a hold that ended without a
        // read. This look sends nothing even if the first unread row is on screen, nor do the looks after it until a row
        // that was not on screen then is seen.
        val lowered = channel.lastReadSeq < readSeq || (this.held != null && held == null && channel.lastReadSeq <= this.held)
        val seen = copy(readSeq = channel.lastReadSeq, held = held)
        val unread = channel.unreadCount > 0 // with nothing unread there is nothing to protect
        if (lowered) return Step(seen.copy(anchored = false, quiet = if (unread) (quiet ?: emptySet()) + onScreenIds + visible.map { it.id } else null), null)
        if (unread && quiet != null && visible.all { it.id in quiet }) return Step(seen.copy(anchored = false), null)
        val step = ReadGate.visibleRead(anchored, channel, rows, meId, visible, onScreenIds)
        return Step(seen.copy(anchored = step.anchored, quiet = null), step.markSeq)
    }

    companion object {
        /** Opened, back from the search view, or reloaded (§7.3): the first unread row has to be seen again. */
        fun opened(channel: ChannelState, held: Int?): ReadAnchor = ReadAnchor(readSeq = channel.lastReadSeq, held = held)
    }
}
