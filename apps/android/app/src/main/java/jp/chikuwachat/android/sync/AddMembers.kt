package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.ApiException

/**
 * M89 (MEMBERSHIP.md §5 item 6): adding several people at once. One `POST /channels/{id}/members/batch` so the channel
 * gets one 「A が B、C を追加しました」 line; a server before M88 answers 405 and then each person is added on their own
 * (one line per person there). A single person goes through the batch too (the same line, the same endpoint).
 */
object AddMembers {
    /** The batch endpoint's limit (MembersAdd.user_ids maxItems). */
    const val MAX_BATCH = 50

    suspend fun add(userIds: List<String>, batch: suspend (List<String>) -> Unit, single: suspend (String) -> Unit) {
        val ids = userIds.distinct()
        if (ids.isEmpty()) return
        for (chunk in ids.chunked(MAX_BATCH)) {
            try {
                batch(chunk)
            } catch (e: ApiException.Api) {
                if (e.status != 405) throw e
                chunk.forEach { single(it) }
            }
        }
    }
}
