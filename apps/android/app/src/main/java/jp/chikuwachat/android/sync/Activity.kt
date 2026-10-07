package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.ActivityItem
import jp.chikuwachat.android.api.ActivitySummaryOut
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.ParentThread
import jp.chikuwachat.android.api.UserMe
import java.time.Instant
import java.time.OffsetDateTime

/** M39: the activity tab's badge as the engine keeps it current (ApiClient and the test fake). */
interface ActivityApi {
    suspend fun activitySummary(): ActivitySummaryOut

    /** PUT /activity/read (「すべて既読にする」): everything up to `readAt` is read. */
    suspend fun markActivityRead(readAt: String): ActivitySummaryOut

    /** PUT /activity/items/read (2026-10-07, MOBILE_UI.md §6.4): the items I opened. */
    suspend fun markActivityItemsRead(itemIds: List<String>): ActivitySummaryOut
}

/**
 * M39 (MOBILE_UI.md §6.4, §7.2; SYNC_PROTOCOL.md §4.1, §6): the activity rules the engine and the tab share, as pure
 * functions (tested in ActivityTest). The server decides what the feed holds; these only decide when to ask again and
 * which rows show as unread.
 */
object ActivityRules {
    /**
     * Whether a new message may be an activity item for me, so the badge is read again (the server counts it): from
     * someone else, not deleted, and mentioning me (by name, group, @channel or one of my keywords), or a reply in a
     * thread I follow — known from the event's followers (`thread`), else from the thread state held here.
     */
    fun isActivity(message: MessageOut, me: UserMe?, thread: ParentThread?, followingHeld: Boolean): Boolean {
        if (me == null || message.deleted || message.senderId == me.id) return false
        if (message.type != "user") return false // M88: a join / leave line is never an activity item
        if (message.mentions(me.id, me.notifyKeywords)) return true
        if (message.parentId == null) return false
        return followingHeld || thread?.participantIds?.contains(me.id) == true
    }

    /** An item newer than the read position has the unread dot; without a position (not loaded) none has. */
    fun isUnread(at: String, readAt: String?): Boolean {
        val time = parse(at) ?: return false
        val read = readAt?.let(::parse) ?: return false
        return time.isAfter(read)
    }

    /** The later of two times (a read position only moves forward); an unreadable one loses. */
    fun later(a: String?, b: String?): String? {
        val first = a?.let(::parse) ?: return b
        val second = b?.let(::parse) ?: return a
        return if (second.isAfter(first)) b else a
    }

    /**
     * MOBILE_UI.md §6.4 rule 2, from the read positions held here: a mention or thread reply whose message I have read
     * in its conversation. A timeline row (top level, or a reply also sent to the channel) at or below the channel's
     * read position; a reply at or below its thread's (either one for a reply also in the channel). Other kinds never.
     */
    fun readInConversation(item: ActivityItem, channelReadSeq: (String) -> Int?, threadReadSeq: (String) -> Int?): Boolean {
        if (item.kind != "mention" && item.kind != "thread_reply") return false
        val message = item.message ?: return false
        if (message.seq <= 0) return false
        val parentId = message.parentId
        if ((parentId == null || message.alsoInChannel) && (channelReadSeq(message.channelId) ?: 0) >= message.seq) return true
        return parentId != null && (threadReadSeq(parentId) ?: 0) >= message.seq
    }

    /**
     * The server says the item is read although it is newer than the page's read position: it was read in its
     * conversation (§6.4) or, since 2026-10-07, opened. One the read position covers is not this (the position held
     * decides its dot).
     */
    fun readByServerInConversation(item: ActivityItem, pageReadAt: String?): Boolean =
        item.read == true && isUnread(item.at, pageReadAt)

    /**
     * The unread dot (MOBILE_UI.md §6.4; since 2026-10-07 「開いたら既読」, nothing is read by being on screen): newer than
     * the read position held now ([readAt]: 「すべて既読にする」 here or on another device moves it), not opened since
     * ([openedAt]: when I opened it, here or on another device — a reaction item with a newer reaction is unread again)
     * and, with a server that sends `read` ([conversationRule]), not read in its conversation or opened, whether by the
     * server's flag when the page came ([serverRead]) or the positions held since ([readHere]).
     */
    fun showsUnread(
        item: ActivityItem, readAt: String?, conversationRule: Boolean, serverRead: Boolean, readHere: Boolean, openedAt: String? = null,
    ): Boolean =
        isUnread(item.at, readAt) && (openedAt == null || isUnread(item.at, openedAt)) && !(conversationRule && (serverRead || readHere))

    /**
     * 「すべて既読にする」's time: now, or the newest row held should this device's clock be behind the server's (the
     * server never moves the position past its own now).
     */
    fun markAllAt(items: List<ActivityItem>, now: Instant): String {
        val newest = items.mapNotNull { parse(it.at) }.maxOrNull()
        return (if (newest != null && newest.isAfter(now)) newest else now).toString()
    }

    fun parse(iso: String): Instant? =
        runCatching { Instant.parse(iso) }.getOrNull() ?: runCatching { OffsetDateTime.parse(iso).toInstant() }.getOrNull()
}
