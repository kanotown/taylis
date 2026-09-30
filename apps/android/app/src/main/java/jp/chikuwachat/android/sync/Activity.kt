package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.ActivitySummaryOut
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.ParentThread
import jp.chikuwachat.android.api.UserMe
import java.time.Instant
import java.time.OffsetDateTime

/** M39: the activity tab's badge as the engine keeps it current (ApiClient and the test fake). */
interface ActivityApi {
    suspend fun activitySummary(): ActivitySummaryOut
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

    fun parse(iso: String): Instant? =
        runCatching { Instant.parse(iso) }.getOrNull() ?: runCatching { OffsetDateTime.parse(iso).toInstant() }.getOrNull()
}
