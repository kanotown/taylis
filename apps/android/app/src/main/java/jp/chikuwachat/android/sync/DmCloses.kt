package jp.chikuwachat.android.sync

import kotlinx.coroutines.CancellationException

/**
 * M141 「会話を閉じる」 (SYNC_PROTOCOL.md §7.9, DATA_MODEL.md conversation_closes): the client's half, kept apart from the
 * controller so the optimistic steps and their rollback can be tested without a server.
 */
object DmCloses {
    /** What a close changed here, to put back on a refusal or for 「元に戻す」 (the pin). */
    data class Closed(val channelId: String, val wasPinned: Boolean, val pinsBefore: List<String>, val before: ChannelState)

    /** `channels` without the closed DMs (§7.9: the DM lists, the home's sections and the tablet's lists hide them). */
    fun visible(channels: Collection<ChannelState>, closed: Set<String>): Collection<ChannelState> =
        if (closed.isEmpty()) channels else channels.filter { !(it.channel.isDm && it.id in closed) }

    /** Whether 「会話を閉じる」 is offered for `channel`: a DM or group DM I am in, on a server that closes them. */
    fun canClose(store: Store, channel: ChannelState?): Boolean =
        store.closedDmsKnown && channel != null && channel.isMember && channel.channel.isDm

    /**
     * Closes at once (hidden, unpinned, read to the end), then `put` (PUT /channels/{id}/close). A refusal puts all three
     * back and is rethrown for the caller to show. Null when there is nothing to close.
     */
    suspend fun close(store: Store, channelId: String, put: suspend () -> Unit): Closed? {
        val before = store.channel(channelId) ?: return null
        val pinsBefore = store.dmPins.toList()
        val closed = Closed(channelId, channelId in pinsBefore, pinsBefore, before)
        store.setDmClosed(channelId, true)
        store.setDmPin(channelId, false)
        store.markReadToEnd(channelId)
        try {
            put()
        } catch (e: Throwable) {
            if (e !is CancellationException) {
                store.setDmClosed(channelId, false)
                store.restoreDmPins(pinsBefore)
                store.restoreRead(before)
            }
            throw e
        }
        return closed
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
