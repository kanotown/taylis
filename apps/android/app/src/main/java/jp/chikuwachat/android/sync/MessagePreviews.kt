package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.MessagePreviewOut
import jp.chikuwachat.android.api.MessagePreviewsOut
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/** M185 (docs/LINK_PREVIEWS.md §3.1): what the message link cards read. */
interface MessagePreviewApi {
    suspend fun messagePreviews(ids: List<String>): MessagePreviewsOut
}

/**
 * M185 (docs/LINK_PREVIEWS.md §3.3, §8 3.): the cards of `<server>/m/<id>` links, as the server answers for me
 * (`POST /messages/previews`). A card asks when it is composed (the list composes the rows near the screen, so a jump that
 * adds hundreds of rows asks only for those); the ids asked within [batchDelayMs] go in one request, [BATCH] per request.
 * An answer is kept for the session and read again when a card is drawn after [TTL_MS] (the old card stays meanwhile);
 * a failure (429, offline, an older server's 404) is asked again only after [RETRY_MS], and shows no card.
 */
class MessagePreviewHub(
    private val api: MessagePreviewApi?,
    private val scope: CoroutineScope,
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val batchDelayMs: Long = BATCH_DELAY_MS,
) {
    /** A linked message as last read, and when (ms). `preview` null: the read failed. */
    data class Entry(val preview: MessagePreviewOut?, val at: Long)

    private val entries = HashMap<String, Entry>()
    private val queue = LinkedHashSet<String>()
    private val loading = HashSet<String>()
    private var scheduled = false
    private val _version = MutableStateFlow(0)
    /** Bumped when answers come in: the cards read [peek] again. */
    val version: StateFlow<Int> = _version

    /** The card's entry as held (a stale one too: it shows until the new answer comes). */
    fun peek(id: String): Entry? = entries[id.lowercase()]

    /** A card wants its message: asked unless a fresh answer (or a recent failure) is held, or it is on its way. */
    fun request(id: String) {
        val key = id.lowercase()
        val held = entries[key]
        if (held != null && clock() - held.at < (if (held.preview != null) TTL_MS else RETRY_MS)) return
        if (api == null || key in loading) return
        queue.add(key)
        if (scheduled) return
        scheduled = true
        scope.launch {
            delay(batchDelayMs)
            scheduled = false
            flush()
        }
    }

    private suspend fun flush() {
        val api = api ?: return
        val ids = queue.toList()
        queue.clear()
        for (batch in ids.chunked(BATCH)) {
            loading.addAll(batch)
            try {
                val answer = api.messagePreviews(batch)
                val at = clock()
                for (item in answer.items) entries[item.id.lowercase()] = Entry(item, at)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Rate limited or offline: no card for now (the link in the body still opens the message). A card already
                // read stays as it was, and is read again a minute from now (not on every draw).
                val at = clock()
                for (id in batch) {
                    val held = entries[id]?.preview
                    entries[id] = if (held == null) Entry(null, at) else Entry(held, at - TTL_MS + RETRY_MS)
                }
            } finally {
                loading.removeAll(batch.toSet())
                _version.value = _version.value + 1
            }
        }
    }

    companion object {
        /** Ids per request (the server's MESSAGE_PREVIEW_BATCH). */
        const val BATCH = 20
        /** Cards asking within this long go in one request. */
        const val BATCH_DELAY_MS = 30L
        /** An answer older than this is read again when its card is drawn (an edit of the linked message). */
        const val TTL_MS = 5 * 60_000L
        /** A failure waits this long before it is asked again. */
        const val RETRY_MS = 60_000L
    }
}
