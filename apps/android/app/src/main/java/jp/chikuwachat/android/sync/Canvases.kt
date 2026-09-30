package jp.chikuwachat.android.sync

import android.util.Log
import jp.chikuwachat.android.api.CanvasMeta
import jp.chikuwachat.android.api.Codec
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * M46: canvases on this device (CANVAS.md §4.4 / §4.6), as the desktop's src/sync/canvases.ts. The conversation's list
 * lives in the Store (loaded when it opens and after reconnecting, kept current by canvas.* events: the larger version
 * wins); each canvas on screen, or with edits not saved yet, has a [CanvasSaver]. Unsaved edits are kept in the Room
 * store's meta table, so a restart sends them with the same idempotency key.
 */
class CanvasHub(
    private val api: CanvasApi?,
    private val store: Store,
    private val scope: CoroutineScope,
    private val options: CanvasSaverOptions = CanvasSaverOptions(),
) {
    private val savers = HashMap<String, CanvasSaver>()
    /** How many screens show each canvas: one nobody shows is dropped once it holds nothing unsaved. */
    private val holds = HashMap<String, Int>()

    val available: Boolean get() = api != null

    /** The conversation's canvases (when it opens, after reconnecting). */
    suspend fun loadList(channelId: String) {
        val api = api ?: return
        try {
            store.setCanvases(channelId, api.listCanvases(channelId))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w("CanvasHub", "could not load the canvases", e)
        }
    }

    /** The saver of a canvas (made, and its unsaved edits restored, on first use). */
    fun saver(canvasId: String, channelId: String): CanvasSaver? {
        val api = api ?: return null
        savers[canvasId]?.let { return it }
        val saver = CanvasSaver(canvasId, channelId, api, scope, options, store.pendingCanvas(canvasId)) { state -> store.setPendingCanvas(canvasId, state) }
        savers[canvasId] = saver
        saver.load()
        return saver
    }

    /** A screen shows the canvas; the returned function lets go (saving what is typed, §4.4 「画面を閉じるとき」). */
    fun hold(canvasId: String, channelId: String): Pair<CanvasSaver?, () -> Unit> {
        val saver = saver(canvasId, channelId)
        holds[canvasId] = (holds[canvasId] ?: 0) + 1
        var released = false
        return saver to release@{
            if (released) return@release
            released = true
            val left = (holds[canvasId] ?: 1) - 1
            if (left > 0) holds[canvasId] = left else holds.remove(canvasId)
            if (saver == null) return@release
            saver.flush()
            scope.launch {
                saver.settled()
                dropIfIdle(canvasId)
            }
        }
    }

    fun current(canvasId: String): CanvasSaver? = savers[canvasId]

    private fun dropIfIdle(canvasId: String) {
        val saver = savers[canvasId] ?: return
        if (holds.containsKey(canvasId) || saver.unsaved) return
        saver.dispose()
        savers.remove(canvasId)
    }

    /** canvas.created / canvas.updated / canvas.deleted (§4.6). */
    fun applyEvent(event: String, data: JsonObject) {
        when (event) {
            "canvas.created" -> decodeMeta(data)?.let { store.applyCanvasMeta(it) }
            "canvas.updated" -> {
                val meta = decodeMeta(data) ?: return
                store.applyCanvasMeta(meta)
                savers[meta.id]?.let { saver ->
                    saver.applyMeta(meta)
                    saver.remoteVersion(meta.version)
                }
            }
            "canvas.deleted" -> {
                val canvasId = data["canvas_id"]?.jsonPrimitive?.content ?: return
                val channelId = data["channel_id"]?.jsonPrimitive?.content ?: return
                trashed(canvasId, channelId)
            }
        }
    }

    /** Moved to the trash (an event, or my own DELETE): out of the list, nothing more saved. */
    fun trashed(canvasId: String, channelId: String) {
        store.removeCanvas(channelId, canvasId)
        savers[canvasId]?.let { saver ->
            saver.gone()
            store.setPendingCanvas(canvasId, null)
        }
    }

    private fun decodeMeta(data: JsonObject): CanvasMeta? =
        data["canvas"]?.let { runCatching { Codec.snake.decodeFromJsonElement(CanvasMeta.serializer(), it) }.getOrNull() }

    /** After (re)connecting: failed saves go out, open canvases are read again, edits kept from before a restart resume. */
    fun online() {
        if (api == null) return
        savers.values.toList().forEach { it.online() }
        store.pendingCanvases().forEach { (canvasId, pending) ->
            if (savers.containsKey(canvasId)) return@forEach
            if (store.channel(pending.channelId)?.isMember != true) return@forEach
            val saver = saver(canvasId, pending.channelId) ?: return@forEach
            scope.launch {
                saver.settled()
                dropIfIdle(canvasId)
            }
        }
    }

    /** Save everything typed now (the app goes to the background, sign-out). */
    fun flushAll() {
        savers.values.toList().forEach { it.flush() }
    }

    suspend fun settleAll() {
        savers.values.toList().forEach { it.settled() }
    }

    /** I left the conversation (or it was removed): its canvases and their savers go (§4.6). */
    fun removeChannel(channelId: String) {
        savers.entries.filter { it.value.channelId == channelId }.forEach { (canvasId, saver) ->
            saver.dispose()
            savers.remove(canvasId)
        }
    }

    fun stop() {
        savers.values.forEach { it.dispose() }
        savers.clear()
        holds.clear()
    }
}
