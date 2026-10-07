package jp.chikuwachat.android.sync

import android.util.Log
import jp.chikuwachat.android.api.ReadStateOut
import kotlinx.coroutines.CancellationException

/**
 * M141 「会話を閉じる」 (SYNC_PROTOCOL.md §7.9, DATA_MODEL.md conversation_closes): the client's half, kept apart from the
 * controller so the optimistic steps and their rollback can be tested without a server. The rules shared with the other
 * clients are in apps/shared/dm-close-rules.json.
 */
object DmCloses {
    /** What a close changed here, to put back on a refusal or for 「元に戻す」 (the pin). */
    data class Closed(val channelId: String, val wasPinned: Boolean, val pinPlace: Int?, val before: ChannelState)

    /** The read marks a close sets and compares against (Review v0.1.43 #7, `read_fallback`). */
    data class ReadMark(val lastSeq: Int, val lastReadSeq: Int, val unreadCount: Int, val mentionCount: Int) {
        companion object {
            fun of(state: ChannelState) = ReadMark(state.lastSeq, state.lastReadSeq, state.unreadCount, state.mentionCount)
        }
    }

    /** `channels` without the closed DMs (§7.9: the DM lists, the home's sections and the tablet's lists hide them). */
    fun visible(channels: Collection<ChannelState>, closed: Set<String>): Collection<ChannelState> =
        if (closed.isEmpty()) channels else channels.filter { !(it.channel.isDm && it.id in closed) }

    /** Whether 「会話を閉じる」 is offered for `channel`: a DM or group DM I am in, on a server that closes them. */
    fun canClose(store: Store, channel: ChannelState?): Boolean =
        store.closedDmsKnown && channel != null && channel.isMember && channel.channel.isDm

    /**
     * Review v0.1.43 #6 (`close_event`): whether a dm_close.updated is taken. An open always is; a close is not when this
     * device already holds a timeline message newer than where it was closed (`lastMessageSeq`, the §7.8 last_message):
     * that message reopened the conversation on the server too, it only reached this device first. No `closedSeq` (an
     * older server): taken.
     */
    fun takesEvent(closed: Boolean, closedSeq: Int?, lastMessageSeq: Int?): Boolean =
        !closed || closedSeq == null || lastMessageSeq == null || lastMessageSeq <= closedSeq

    /**
     * Review v0.1.43 #7 (`restore_pin`): a refused close puts back only its own pin, at `place` (its index before, clamped
     * to the list as it is now), or leaves it out when it was not pinned; the other pins stay as events left them.
     */
    fun restoredPins(pins: List<String>, channelId: String, place: Int?): List<String> {
        val next = pins.filter { it != channelId }.toMutableList()
        if (place != null) next.add(minOf(place, next.size), channelId)
        return next
    }

    /**
     * Review v0.1.43 #7 (`read_fallback`): when the read state could not be asked again either, the snapshot goes back only
     * if nothing changed it since the close set it; otherwise what came meanwhile is kept for the next bootstrap.
     */
    fun readFallbackTakesSnapshot(optimistic: ReadMark, now: ReadMark): Boolean = optimistic == now

    /**
     * Closes at once (hidden, unpinned, read to the end), then `put` (PUT /channels/{id}/close). A refusal puts back only
     * what this close touched (Review v0.1.43 #7): its own pin in its place, and the read state as the server has it
     * (`readState`, PUT /channels/{id}/read with 0: it moves nothing and answers the state; the snapshot only when that
     * fails too and nothing changed it since). The refusal is rethrown for the caller to show. Null when there is nothing
     * to close.
     */
    suspend fun close(store: Store, channelId: String, readState: suspend () -> ReadStateOut, put: suspend () -> Unit): Closed? {
        val before = store.channel(channelId) ?: return null
        val pinPlace = store.dmPins.indexOf(channelId).takeIf { it >= 0 }
        val closed = Closed(channelId, pinPlace != null, pinPlace, before)
        store.setDmClosed(channelId, true)
        store.setDmPin(channelId, false)
        store.markReadToEnd(channelId)
        val optimistic = store.channel(channelId)?.let { ReadMark.of(it) }
        try {
            put()
        } catch (e: Throwable) {
            if (e !is CancellationException) {
                store.setDmClosed(channelId, false)
                if (pinPlace != null) store.restoreDmPin(channelId, pinPlace)
                restoreRead(store, channelId, before, optimistic, readState)
            }
            throw e
        }
        return closed
    }

    private suspend fun restoreRead(store: Store, channelId: String, before: ChannelState, optimistic: ReadMark?, readState: suspend () -> ReadStateOut) {
        try {
            store.setReadState(channelId, readState())
            return
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.i("DmCloses", "could not read the read state back after a refused close: $e")
        }
        val now = store.channel(channelId) ?: return
        if (optimistic != null && readFallbackTakesSnapshot(optimistic, ReadMark.of(now))) store.restoreRead(before)
    }

    /**
     * An explicit open of a closed conversation (search, profile 「メッセージを送る」, a link, a notification, 「元に戻す」):
     * shown again at once, then `delete` (DELETE /channels/{id}/close). A failure is only logged by the caller: the next
     * bootstrap closes it again. False when it was not closed (no call made).
     */
    suspend fun reopen(store: Store, channelId: String, delete: suspend () -> Unit): Boolean {
        if (!store.isDmClosed(channelId)) return false
        store.setDmClosed(channelId, false)
        delete()
        return true
    }
}
