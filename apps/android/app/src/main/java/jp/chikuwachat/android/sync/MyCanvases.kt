package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.CanvasMeta
import jp.chikuwachat.android.api.CanvasPage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** M78 (CANVAS.md §21.2): `GET /canvases`, apart from CanvasApi like ChannelLinksApi (ApiClient and the test fakes). */
interface MyCanvasesApi {
    suspend fun myCanvases(cursor: String?, limit: Int): CanvasPage
}

/**
 * What the home's 「キャンバス」 shows. `items` null: the first page is still on its way. `offline`: the server could not be
 * reached, so these are the device's copies (M74's `canvases` table) or the pages read before; no more pages load then.
 * `failure`: the last request failed (a first page that is not a network error, or a further page) — the list says so.
 */
data class MyCanvasesState(
    val items: List<CanvasMeta>? = null,
    val nextCursor: String? = null,
    val loadingMore: Boolean = false,
    val offline: Boolean = false,
    val failure: Throwable? = null,
) {
    /** Another page can be asked for (by scrolling to the end, or 「さらに読み込む」). */
    val canLoadMore: Boolean get() = nextCursor != null && !offline && !loadingMore && items != null
}

/**
 * M78 (CANVAS.md §21.2): the canvases of all my conversations, most recently updated first, 50 at a time (as the
 * desktop's CanvasesView). Pages are merged without duplicates; a refresh (pull to refresh, reconnecting) starts again
 * from the first page and a page still on its way from before it is dropped. When the first page cannot be read because
 * the server is out of reach ([temporary]), the canvases kept on this device stand in for the list (the pages read
 * before, if any, else [cached]) and the state says `offline`.
 */
class MyCanvasList(
    /** Read at each request (null: signed out, nothing is asked). */
    private val api: () -> MyCanvasesApi?,
    private val cached: suspend () -> List<CanvasMeta>,
    private val temporary: (Throwable) -> Boolean = CanvasSaver::temporary,
    val pageSize: Int = PAGE_SIZE,
) {
    private val mutableState = MutableStateFlow(MyCanvasesState())
    val state: StateFlow<MyCanvasesState> = mutableState.asStateFlow()

    /** Bumped by every refresh: an older page arriving afterwards is not applied. */
    private var generation = 0

    /** Forgets everything (the home's tile opens the list afresh); the next [refresh] reads the first page. */
    fun clear() {
        generation++
        mutableState.value = MyCanvasesState()
    }

    suspend fun refresh() {
        val api = api() ?: return
        val mine = ++generation
        try {
            val page = api.myCanvases(null, pageSize)
            if (mine != generation) return
            mutableState.value = MyCanvasesState(items = distinct(page.items), nextCursor = page.nextCursor)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (mine != generation) return
            val current = mutableState.value
            if (!temporary(e)) {
                mutableState.value = current.copy(items = current.items ?: emptyList(), loadingMore = false, failure = e)
                return
            }
            // The pages read from the server before are newer than the copies; without them, the copies.
            val shown = current.items?.takeIf { !current.offline && it.isNotEmpty() } ?: sortCanvases(cached())
            if (mine != generation) return
            mutableState.value = MyCanvasesState(items = shown, nextCursor = current.nextCursor.takeIf { current.items != null && !current.offline }, offline = true, failure = e)
        }
    }

    suspend fun loadMore() {
        val api = api() ?: return
        val current = mutableState.value
        val cursor = current.nextCursor ?: return
        if (!current.canLoadMore) return
        val mine = generation
        mutableState.value = current.copy(loadingMore = true, failure = null)
        try {
            val page = api.myCanvases(cursor, pageSize)
            if (mine != generation) return
            val now = mutableState.value
            mutableState.value = now.copy(items = distinct((now.items ?: emptyList()) + page.items), nextCursor = page.nextCursor, loadingMore = false, failure = null)
        } catch (e: CancellationException) {
            if (mine == generation) mutableState.value = mutableState.value.copy(loadingMore = false)
            throw e
        } catch (e: Exception) {
            if (mine != generation) return
            mutableState.value = mutableState.value.copy(loadingMore = false, failure = e)
        }
    }

    private fun distinct(items: List<CanvasMeta>): List<CanvasMeta> = items.distinctBy { it.id }

    companion object {
        const val PAGE_SIZE = 50

        fun sortCanvases(items: List<CanvasMeta>): List<CanvasMeta> =
            items.distinctBy { it.id }.sortedWith(compareByDescending<CanvasMeta> { it.updatedAt }.thenByDescending { it.id })
    }
}
