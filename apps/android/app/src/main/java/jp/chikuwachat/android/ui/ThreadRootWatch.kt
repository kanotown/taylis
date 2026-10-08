package jp.chikuwachat.android.ui

/**
 * What a thread screen does about its root's deletion (THREADS.md; the desktop and iOS follow the same rules). The
 * store says whether the root is known deleted (Store.isRootDeleted: a message.deleted event, a catch-up / delta
 * tombstone, my own delete's answer, or a 404 `message_not_found` for its replies or itself).
 *
 * - A thread shown live in this screen (its replies loaded while the root existed) closes when the root goes, with
 *   「元のメッセージが削除されたため、スレッドを閉じました」 — unless I deleted the root myself from this thread's root row,
 *   which just closes it.
 * - A thread opened on a root already deleted (a stale link, an activity row, a notification) does not close: it shows
 *   「元のメッセージは削除されました」 instead of an empty thread.
 *
 * One per controller (ThreadPane reports to it); no Compose state, so the rules are tested on the JVM.
 */
class ThreadRootWatch {
    enum class Outcome {
        /** The root is not known deleted: the thread shows as usual. */
        SHOWN,
        /** Opened on a root already deleted: the deleted state, no closing. */
        DELETED_STATE,
        /** I deleted the root from this thread's root row: close, no notice. */
        CLOSE,
        /** Deleted elsewhere (the channel's timeline, another device, someone else, an admin): close with the notice. */
        CLOSE_WITH_NOTICE,
    }

    private val live = HashSet<String>()
    private val deletingHere = HashSet<String>()

    /** A thread screen opened on this thread: not live until its replies load. */
    fun opened(parentId: String) {
        live.remove(parentId)
    }

    /** The thread screen left (closed, or another thread replaced it). */
    fun left(parentId: String) {
        live.remove(parentId)
        deletingHere.remove(parentId)
    }

    /** The replies loaded (the server served them, so the root existed): the thread is shown live. */
    fun loaded(parentId: String, rootDeleted: Boolean) {
        if (!rootDeleted) live.add(parentId)
    }

    /** Right before my delete of the root from the thread's own root row. */
    fun deletingFromThread(parentId: String) {
        deletingHere.add(parentId)
    }

    /** That delete was refused or failed: a later deletion from elsewhere says so again. */
    fun deleteFailed(parentId: String) {
        deletingHere.remove(parentId)
    }

    /** What the thread shows now; no change. */
    fun outcome(parentId: String, rootDeleted: Boolean): Outcome = when {
        !rootDeleted -> Outcome.SHOWN
        parentId !in live -> Outcome.DELETED_STATE
        parentId in deletingHere -> Outcome.CLOSE
        else -> Outcome.CLOSE_WITH_NOTICE
    }

    /**
     * [outcome], the closing taken once: a thread that closes is no longer live, and my delete's mark is consumed, so
     * asking again gives [Outcome.DELETED_STATE].
     */
    fun close(parentId: String, rootDeleted: Boolean): Outcome {
        val outcome = outcome(parentId, rootDeleted)
        if (outcome == Outcome.CLOSE || outcome == Outcome.CLOSE_WITH_NOTICE) {
            live.remove(parentId)
            deletingHere.remove(parentId)
        }
        return outcome
    }
}
