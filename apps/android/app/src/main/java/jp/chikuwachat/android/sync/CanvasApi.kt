package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.CanvasMeta
import jp.chikuwachat.android.api.CanvasOut
import jp.chikuwachat.android.api.CanvasSaveOut
import jp.chikuwachat.android.api.CanvasTemplateOut

/** M46: what the save loop of one canvas needs (CANVAS.md §4.4; ApiClient and the test fakes). */
interface CanvasSaveApi {
    /** Null: `knownVersion` is still the current one (If-None-Match → 304). */
    suspend fun getCanvas(canvasId: String, knownVersion: Long?): CanvasOut?
    /** `onConflict`: "fail" | "ours" | "theirs" | "both" (§4.4). */
    suspend fun saveCanvas(canvasId: String, baseRevId: String, body: String, clientSaveId: String, onConflict: String): CanvasSaveOut
}

/** M46: the canvas endpoints (CANVAS.md §4.5), apart from SyncApi like ChannelLinksApi. */
interface CanvasApi : CanvasSaveApi {
    suspend fun listCanvases(channelId: String, trashed: Boolean = false): List<CanvasMeta>
    suspend fun createCanvas(channelId: String, clientSaveId: String, templateKey: String?, title: String?, asTab: Boolean, tz: String?): CanvasOut
    suspend fun updateCanvas(canvasId: String, title: String? = null, editPolicy: String? = null, isChannelTab: Boolean? = null): CanvasOut
    suspend fun deleteCanvas(canvasId: String)
    suspend fun restoreCanvas(canvasId: String): CanvasOut
    suspend fun canvasTemplates(): List<CanvasTemplateOut>
}
