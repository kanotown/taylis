package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.DraftOut
import jp.chikuwachat.android.api.DraftUpdated
import jp.chikuwachat.android.api.isRetryable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** M15d: the draft endpoints (ApiClient and the test fake). */
interface DraftApi {
    suspend fun saveDraft(channelId: String, parentId: String?, body: String): DraftOut
    suspend fun deleteDraft(channelId: String, parentId: String?)
}

/**
 * M15d: keeps my drafts in step across my devices (SYNC_PROTOCOL.md §8 「下書きの同期」).
 * Local edits are saved a moment after typing pauses; while a draft has unsaved edits (dirty),
 * versions from other devices are ignored so that nothing typed here is lost.
 */
class DraftSync(
    private val api: DraftApi?,
    private val store: Store,
    private val scope: CoroutineScope,
    private val isOnline: () -> Boolean,
    private val delayMs: Long,
) {
    private val timers = HashMap<String, Job>()
    private val saving = Mutex()

    private fun key(channelId: String, parentId: String?) = "$channelId:${parentId ?: ""}"

    /** A local edit: save it once typing pauses (an emptied composer, e.g. after sending, right away). */
    fun edited(channelId: String, parentId: String?) {
        if (api == null) return
        val key = key(channelId, parentId)
        timers.remove(key)?.cancel()
        val wait = if (store.draft(channelId, parentId).text.isEmpty()) 0L else delayMs
        timers[key] = scope.launch {
            if (wait > 0) delay(wait)
            timers.remove(key)
            push(channelId, parentId)
        }
    }

    /** Bootstrap: take the server's drafts, forget the ones sent or deleted elsewhere. */
    fun applyBootstrap(drafts: List<DraftOut>) {
        store.draftEntries().filter { !it.draft.dirty && it.draft.syncedAt == null && it.draft.text.isNotBlank() && store.channel(it.channelId)?.isMember == true }
            .forEach { store.markDraftDirty(it.channelId, it.parentId) } // written before drafts synced: this device's text wins
        val onServer = HashSet<String>()
        drafts.forEach { draft ->
            onServer.add(key(draft.channelId, draft.parentId))
            store.applyRemoteDraft(draft.channelId, draft.parentId, draft.body, draft.updatedAt)
        }
        store.draftEntries().filter { !it.draft.dirty && it.draft.syncedAt != null && key(it.channelId, it.parentId) !in onServer }
            .forEach { store.applyRemoteDraft(it.channelId, it.parentId, null, null) }
    }

    fun applyEvent(data: DraftUpdated) {
        store.applyRemoteDraft(data.channelId, data.parentId, if (data.deleted) null else data.body, data.updatedAt)
    }

    /** Save every draft edited while offline (after connecting), or now instead of after the pause. */
    suspend fun flush() {
        timers.values.forEach { it.cancel() }
        timers.clear()
        store.draftEntries().filter { it.draft.dirty && store.channel(it.channelId)?.isMember == true }.forEach { push(it.channelId, it.parentId) }
    }

    /** Saves run one at a time, in order. */
    private suspend fun push(channelId: String, parentId: String?) = saving.withLock { save(channelId, parentId) }

    private suspend fun save(channelId: String, parentId: String?) {
        val api = api ?: return
        if (!isOnline()) return // stays dirty: flushed after reconnecting
        val draft = store.draft(channelId, parentId)
        if (!draft.dirty) return
        val text = draft.text
        try {
            if (text.isBlank()) {
                api.deleteDraft(channelId, parentId)
                store.markDraftSaved(channelId, parentId, text, null)
            } else {
                val saved = api.saveDraft(channelId, parentId, text)
                store.markDraftSaved(channelId, parentId, text, saved.updatedAt)
            }
        } catch (error: ApiException) {
            // Refused for good (left the conversation, the thread is gone …): keep the text here only.
            if (!error.isRetryable()) store.markDraftSaved(channelId, parentId, text, null)
        }
    }
}
