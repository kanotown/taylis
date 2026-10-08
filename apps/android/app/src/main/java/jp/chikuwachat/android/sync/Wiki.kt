package jp.chikuwachat.android.sync

import android.util.Log
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.CanvasConflictDetails
import jp.chikuwachat.android.api.CanvasOut
import jp.chikuwachat.android.api.CanvasSaveOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.PageConflictDetails
import jp.chikuwachat.android.api.PageItem
import jp.chikuwachat.android.api.PageOut
import jp.chikuwachat.android.api.PageRef
import jp.chikuwachat.android.api.PageSaveOut
import jp.chikuwachat.android.api.PageSearchOut
import jp.chikuwachat.android.api.WikiBootstrap
import jp.chikuwachat.android.api.WikiChangesOut
import jp.chikuwachat.android.api.WikiTreeOut
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/*
 * M122 (docs/WIKI.md §9.2, §10, §14; SYNC_PROTOCOL.md §17): 「ドキュメント」 on Android. The tree comes from GET /wiki/tree
 * (ETag) and then GET /wiki/changes?since= whenever wiki.changed moves the feed (300 ms folded), and is kept in Room's
 * meta table for reading offline. An open page is a canvas save loop ([CanvasSaver], CANVAS.md §4.4) over the /wiki
 * endpoints ([WikiPageSource]): the same autosave, merge, conflict choices and offline copies (Room's `canvases` table,
 * the pseudo conversation [WIKI_CHANNEL]); its unsaved edits are kept under "wikipage:<id>".
 */

/** The "conversation" of a page's save loop and offline copy (pages belong to none). */
const val WIKI_CHANNEL = "wiki"

/** Pages read on this device for offline reading (WIKI.md §10: phones keep the 20 most recently opened). */
const val WIKI_PAGE_CACHE_LIMIT = 20

/** The /wiki endpoints (WIKI.md §14.2), apart from SyncApi like CanvasApi. */
interface WikiApi {
    /** Every page I can read; null when `etag` still matches (304). The second value is the answer's ETag. */
    suspend fun wikiTree(etag: String?): Pair<WikiTreeOut?, String?>
    suspend fun wikiChanges(since: Long): WikiChangesOut
    /** The page with body, breadcrumbs and children; null when `etag` (`"v<version>-<level>"`) still matches. */
    suspend fun wikiPage(pageId: String, etag: String?): PageOut?
    suspend fun saveWikiPage(pageId: String, baseRevId: String, body: String, clientSaveId: String, onConflict: String): PageSaveOut
    /**
     * A new page: `parentId` null for a top-level one, whose access is "workspace" or "private" (§4.2); M146: from a
     * template (null or Blank: an empty page).
     */
    suspend fun createWikiPage(parentId: String?, title: String?, access: String, tz: String?, clientSaveId: String, template: PageTemplateChoice? = null): PageOut
    suspend fun renameWikiPage(pageId: String, title: String): PageOut
    suspend fun resolveWikiPages(ids: List<String>): List<PageRef>
    suspend fun wikiBacklinks(pageId: String): List<PageItem>
    suspend fun searchPages(q: String, limit: Int, offset: Int): PageSearchOut
}

/** A page's copy for offline reading: what the server last gave, and when (CachedCanvas's counterpart). */
@Serializable
data class CachedPage(val page: PageOut, val fetchedAt: Long)

/** The page as the save loop sees it (a canvas of the pseudo conversation). */
fun PageOut.toCanvas(): CanvasOut = CanvasOut(
    id = id, channelId = WIKI_CHANNEL, title = title, version = version, headRevId = headRevId, taskTotal = taskTotal,
    taskDone = taskDone, createdBy = createdBy, updatedBy = updatedBy, createdAt = createdAt, updatedAt = updatedAt,
    deletedAt = deletedAt, body = body,
)

/**
 * One open page's endpoints for [CanvasSaver]: GET /wiki/pages/{id} (If-None-Match `"v<version>-<level>"`) and PUT
 * …/content. The page's own parts (level, breadcrumbs, children, icon) are kept in [page]; a save's answer and a
 * conflict's head have no breadcrumbs or children, so the last ones stay. 409 page_conflict / page_base_expired come
 * back as the canvas codes with the head in the canvas shape, so the saver's choices work unchanged.
 */
class WikiPageSource(val id: String, private val api: WikiApi, private val onPage: (PageOut) -> Unit = {}) : CanvasSaveApi {
    private val _page = MutableStateFlow<PageOut?>(null)
    /** The page as last known (with breadcrumbs and children from the last full read). */
    val page: StateFlow<PageOut?> = _page

    /** A copy kept on this device, shown before the server answers. */
    fun seed(copy: PageOut) {
        if (_page.value == null) {
            _page.value = copy
            onPage(copy)
        }
    }

    private fun take(next: PageOut) {
        val known = _page.value
        _page.value = if (next.breadcrumbs == null && known != null) next.copy(breadcrumbs = known.breadcrumbs, children = known.children) else next
        onPage(_page.value!!)
    }

    override suspend fun getCanvas(canvasId: String, knownVersion: Long?): CanvasOut? {
        val level = _page.value?.myLevel
        val etag = if (knownVersion != null && level != null) "\"v$knownVersion-$level\"" else null
        val got = api.wikiPage(id, etag) ?: return null
        take(got)
        return got.toCanvas()
    }

    override suspend fun saveCanvas(canvasId: String, baseRevId: String, body: String, clientSaveId: String, onConflict: String): CanvasSaveOut {
        val answer = try {
            api.saveWikiPage(id, baseRevId, body, clientSaveId, onConflict)
        } catch (e: ApiException.Api) {
            throw translate(e)
        }
        take(answer.page)
        return CanvasSaveOut(answer.page.toCanvas(), answer.submittedRevId, answer.merged)
    }

    /** page_conflict / page_base_expired → canvas_conflict / canvas_base_expired with the canvas-shaped head. */
    private fun translate(e: ApiException.Api): ApiException.Api {
        val code = when (e.code) {
            "page_conflict" -> "canvas_conflict"
            "page_base_expired" -> "canvas_base_expired"
            else -> return e
        }
        val details = e.details?.let { runCatching { Codec.snake.decodeFromJsonElement(PageConflictDetails.serializer(), it) }.getOrNull() }
            ?: return ApiException.Api(e.status, code, e.detail, null)
        take(details.head)
        val mapped: JsonElement = Codec.snake.encodeToJsonElement(
            CanvasConflictDetails.serializer(), CanvasConflictDetails(details.head.toCanvas(), details.conflicts, details.timedOut),
        )
        return ApiException.Api(e.status, code, e.detail, mapped)
    }
}

/** What a `page:` link shows: the page's title and icon, 「表示できないページ」, or (not asked yet) the link's own text. */
sealed interface PageLabel {
    data class Known(val title: String, val icon: String?) : PageLabel
    data object Hidden : PageLabel
    data object Unknown : PageLabel
}

/**
 * 「ドキュメント」 on this device: the tree (kept current by the feed, kept in Room), the titles of linked pages outside it
 * (POST /wiki/pages/resolve, once a session), and the save loops of the pages on screen or with unsaved edits. Runs on
 * the engine's scope (the main thread); [version] moves with every change the screens show.
 */
class WikiHub(
    private val api: WikiApi?,
    private val store: Store,
    private val scope: CoroutineScope,
    private val options: CanvasSaverOptions = CanvasSaverOptions(),
    /** wiki.changed is folded for this long before GET /wiki/changes (SYNC_PROTOCOL.md §17). */
    private val changesDelayMs: Long = 300,
) {
    /** The server keeps 「ドキュメント」 (bootstrap has `wiki`); before the first bootstrap, whether a tree was kept here. */
    var supported = false
        private set
    var pages: Map<String, PageItem> = emptyMap()
        private set
    /** The feed's position the tree is at (null: no tree yet). */
    var cursor: Long? = null
        private set
    private var etag: String? = null
    /** The last read of the tree or the feed failed (the tree shown is the kept one, or none). */
    var loadError: Throwable? = null
        private set
    /** A read of the tree or the feed is on its way. */
    var syncing = false
        private set
    private val refs = HashMap<String, PageRef?>()
    private val asking = HashSet<String>()
    private val savers = HashMap<String, CanvasSaver>()
    private val sources = HashMap<String, WikiPageSource>()
    private val holds = HashMap<String, Int>()
    private var running: Job? = null
    private var again = false
    private var wantTree = false
    private var changesTimer: Job? = null
    private val _version = MutableStateFlow(0)
    val version: StateFlow<Int> = _version

    val available: Boolean get() = api != null && supported

    /** M124: the database endpoints (the same client). */
    val dbApi: WikiDbApi? get() = api as? WikiDbApi

    /** M149: the embedded databases read in this session (closed by [stop]: nothing of it shows for another account). */
    val embeds = EmbedCache()

    private val _rowsSignal = MutableStateFlow<Map<String, Long>>(emptyMap())
    /** M124: per database, how many wiki.rows.changed came (an open database reads again, folded). */
    val rowsSignal: StateFlow<Map<String, Long>> = _rowsSignal
    private val _propsSignal = MutableStateFlow<Map<String, Long>>(emptyMap())
    /** M124: per row, how many wiki.page.updated with change "props" came (an open row reads its cells again). */
    val propsSignal: StateFlow<Map<String, Long>> = _propsSignal
    private val _reconnects = MutableStateFlow(0)
    /** M124: moves on every reconnect (open databases and rows read again: events may have been missed). */
    val reconnects: StateFlow<Int> = _reconnects

    /** wiki.rows.changed: rows, the schema or the views of a database changed. */
    fun rowsChanged(databaseId: String) {
        _rowsSignal.value = _rowsSignal.value + (databaseId to ((_rowsSignal.value[databaseId] ?: 0) + 1))
    }

    /** wiki.page.updated with change "props": a row's cells changed. */
    fun propsChanged(pageId: String) {
        _propsSignal.value = _propsSignal.value + (pageId to ((_propsSignal.value[pageId] ?: 0) + 1))
    }

    /** Whether there is a tree to show (from the server, or kept on this device). */
    val hasTree: Boolean get() = cursor != null

    private fun emit() {
        _version.value = _version.value + 1
    }

    /** At start: the tree kept on this device shows until the server answers. */
    fun restore() {
        val kept = store.wikiTree() ?: return
        pages = kept.pages.associateBy { it.id }
        cursor = kept.cursor
        etag = kept.etag
        supported = true
        emit()
    }

    /** Bootstrap's `wiki` (null: the server has no 「ドキュメント」): the tree is read, or caught up from the feed. */
    fun applyBootstrap(wiki: WikiBootstrap?) {
        if (api == null) return
        if (wiki == null) {
            if (supported || cursor != null) {
                supported = false
                pages = emptyMap()
                cursor = null
                etag = null
                store.saveWikiTree(null)
                emit()
            }
            return
        }
        supported = true
        val known = cursor
        when {
            known == null || wiki.changeSeq < known -> sync(tree = true)
            wiki.changeSeq > known || loadError != null -> sync(tree = false)
        }
        emit()
    }

    /** wiki.changed: the feed moved; read it after a short pause (several changes fold into one read). */
    fun changed(seq: Long) {
        if (!available) return
        val known = cursor
        if (known != null && seq <= known) return
        changesTimer?.cancel()
        changesTimer = scope.launch {
            delay(changesDelayMs)
            changesTimer = null
            sync(tree = known == null)
        }
    }

    /** group.updated, my role changed, 再読み込み: who can read what may have changed — the tree again (ETag). */
    fun reloadTree() {
        if (available) sync(tree = true)
    }

    /** Reads the feed (or the tree), one read at a time; a request while one runs reads again after it. */
    private fun sync(tree: Boolean) {
        val api = api ?: return
        if (tree) wantTree = true
        if (running?.isActive == true) {
            again = true
            return
        }
        running = scope.launch {
            do {
                again = false
                val full = wantTree || cursor == null
                wantTree = false
                syncing = true
                emit()
                try {
                    if (full) readTree(api) else readChanges(api)
                    loadError = null
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Log.w("WikiHub", "could not read the tree", e)
                    loadError = e
                } finally {
                    syncing = false
                    emit()
                }
            } while (again)
        }
    }

    private suspend fun readTree(api: WikiApi) {
        val (tree, tag) = api.wikiTree(etag.takeIf { cursor != null })
        if (tree == null) return // 304: what is here is current
        val before = pages
        pages = tree.pages.filter { it.kind != "row" }.associateBy { it.id }
        cursor = tree.cursor
        etag = tag
        before.keys.filter { it !in pages }.forEach(::vanished)
        persist()
    }

    private suspend fun readChanges(api: WikiApi) {
        val since = cursor ?: return readTree(api)
        val changes = api.wikiChanges(since)
        if (changes.reset) return readTree(api)
        pages = WikiTree.apply(pages, changes)
        cursor = changes.cursor
        changes.removed.forEach(::vanished)
        changes.pages.forEach { page -> refs.remove(page.id) }
        persist()
    }

    /** A page left my tree (trash, purged, no longer mine to read): an open one reads again and finds out (404). */
    private fun vanished(pageId: String) {
        refs.remove(pageId)
        savers[pageId]?.remoteVersion(Long.MAX_VALUE)
    }

    private fun persist() {
        store.saveWikiTree(WikiTreeSnapshot(pages.values.toList(), cursor ?: 0, etag))
    }

    /** wiki.page.updated: the tree's row takes the new title and icon; an open page reads again unless typing. */
    fun pageUpdated(meta: PageItem) {
        pages = WikiTree.applyMeta(pages, meta)
        savers[meta.id]?.remoteVersion(meta.version)
        emit()
    }

    // --- titles of linked pages --------------------------------------------------------------------

    fun label(pageId: String): PageLabel {
        pages[pageId]?.let { return PageLabel.Known(it.title, it.icon) }
        if (!refs.containsKey(pageId)) return PageLabel.Unknown
        val ref = refs[pageId] ?: return PageLabel.Hidden
        return PageLabel.Known(ref.title, ref.icon)
    }

    /** Links outside the tree (or not known yet) are asked about once a session (POST /wiki/pages/resolve, 200 at a time). */
    fun resolve(ids: Collection<String>) {
        val api = api ?: return
        if (!supported) return
        val need = ids.filter { it !in pages && !refs.containsKey(it) && asking.add(it) }
        if (need.isEmpty()) return
        need.chunked(200).forEach { chunk ->
            scope.launch {
                try {
                    val found = api.resolveWikiPages(chunk).associateBy { it.id }
                    chunk.forEach { id -> refs[id] = found[id] }
                    emit()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Log.w("WikiHub", "could not resolve page links", e)
                } finally {
                    asking.removeAll(chunk.toSet())
                }
            }
        }
    }

    /** A page this device made or read (create's answer, a link opened): into the tree when it belongs there. */
    fun noteItem(item: PageItem) {
        // M146: templates never show in the tree (the server leaves them out too).
        if (item.kind == "row" || item.isTemplate || cursor == null) return
        val known = pages[item.id]
        if (known != null && known.version > item.version) return
        // A page whose parent I cannot read comes with parent_id null; one I just made has its place already.
        pages = pages + (item.id to item)
        refs.remove(item.id)
        persist()
        emit()
    }

    // --- the save loops ---------------------------------------------------------------------------

    private suspend fun <T> onIo(work: () -> T): T = options.io?.let { withContext(it) { work() } } ?: work()

    private fun open(pageId: String): Pair<CanvasSaver, WikiPageSource>? {
        val api = api ?: return null
        val saver = savers[pageId]
        val source = sources[pageId]
        if (saver != null && source != null) return saver to source
        val made = WikiPageSource(pageId, api) { page ->
            if (pages.containsKey(page.id)) {
                val known = pages.getValue(page.id)
                if (page.version >= known.version) {
                    pages = pages + (page.id to page.item.copy(parentId = known.parentId, position = known.position.ifEmpty { page.position }))
                    emit()
                }
            } else if (openTitles[page.id] != page.title) {
                // M124: a page outside the tree (a row): the bar's title and icon come from here.
                openTitles[page.id] = page.title
                emit()
            }
        }
        val loop = CanvasSaver(
            pageId, WIKI_CHANNEL, made, scope, options, store.pendingPage(pageId),
            cached = {
                onIo { store.cachedPage(pageId) }?.let { copy ->
                    made.seed(copy.page)
                    CachedCanvas(copy.page.toCanvas(), copy.fetchedAt)
                }
            },
            remember = { got -> if (got == null) store.uncachePage(pageId) else made.page.value?.let { store.cachePage(it, options.now()) } },
        ) { state -> store.setPendingPage(pageId, state) }
        savers[pageId] = loop
        sources[pageId] = made
        loop.load()
        return loop to made
    }

    /** A screen shows the page; the returned function lets go (what is typed is saved, §4.4). */
    fun hold(pageId: String): Triple<CanvasSaver?, WikiPageSource?, () -> Unit> {
        val opened = open(pageId)
        holds[pageId] = (holds[pageId] ?: 0) + 1
        var released = false
        return Triple(opened?.first, opened?.second) release@{
            if (released) return@release
            released = true
            val left = (holds[pageId] ?: 1) - 1
            if (left > 0) holds[pageId] = left else holds.remove(pageId)
            val saver = opened?.first ?: return@release
            saver.flush()
            scope.launch {
                saver.settled()
                dropIfIdle(pageId)
            }
        }
    }

    fun current(pageId: String): CanvasSaver? = savers[pageId]

    /** M124: an open page as last read (a row is not in the tree: its title, icon and kind are here). */
    fun openPage(pageId: String): PageOut? = sources[pageId]?.page?.value

    private val openTitles = HashMap<String, String>()

    private fun dropIfIdle(pageId: String) {
        val saver = savers[pageId] ?: return
        if (holds.containsKey(pageId) || saver.unsaved) return
        saver.dispose()
        savers.remove(pageId)
        sources.remove(pageId)
    }

    /** After (re)connecting: failed saves go out, open pages are read again, edits kept from before a restart resume. */
    fun online() {
        if (api == null) return
        _reconnects.value = _reconnects.value + 1
        savers.values.toList().forEach { it.online() }
        store.pendingPages().forEach { (pageId, _) ->
            if (savers.containsKey(pageId)) return@forEach
            val saver = open(pageId)?.first ?: return@forEach
            scope.launch {
                saver.settled()
                dropIfIdle(pageId)
            }
        }
    }

    fun flushAll() {
        savers.values.toList().forEach { it.flush() }
    }

    suspend fun settleAll() {
        savers.values.toList().forEach { it.settled() }
    }

    fun stop() {
        changesTimer?.cancel()
        running?.cancel()
        savers.values.forEach { it.dispose() }
        savers.clear()
        sources.clear()
        holds.clear()
        embeds.close()
    }
}
