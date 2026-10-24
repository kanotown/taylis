package jp.chikuwachat.android.sync

import android.util.Log
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.DriveChildrenOut
import jp.chikuwachat.android.api.DriveCrumb
import jp.chikuwachat.android.api.DriveDownloadTicketOut
import jp.chikuwachat.android.api.DriveItemDetailOut
import jp.chikuwachat.android.api.DriveItemOut
import jp.chikuwachat.android.api.DriveLocationListOut
import jp.chikuwachat.android.api.DriveLocationOut
import jp.chikuwachat.android.api.DriveSearchHitOut
import jp.chikuwachat.android.api.DriveSearchOut
import jp.chikuwachat.android.api.DriveZipOut
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/** M166 (docs/DRIVE.md §5, §26): the drive endpoints the phone reads, apart from SyncApi (ApiClient and the test fakes). */
interface DriveApi {
    suspend fun driveLocations(): DriveLocationListOut
    suspend fun resolveDriveLocation(channelId: String?): DriveLocationOut
    suspend fun driveChildren(folderId: String, sort: String, order: String, cursor: String?, limit: Int): DriveChildrenOut
    suspend fun driveItem(itemId: String): DriveItemDetailOut
    suspend fun searchDrive(q: String, locationId: String?, cursor: String?, limit: Int): DriveSearchOut
    suspend fun driveDownloadTicket(itemId: String): DriveDownloadTicketOut
    suspend fun driveZip(itemIds: List<String>): DriveZipOut
}

/** Whether a failure means "not there for me" (§3.2: an unreadable item is always 404, never 403). */
internal fun Throwable.isDriveNotFound(): Boolean = this is ApiException.Api && status == 404

/** A failure in words, as AppController.describe (apps/shared/errors.json has the drive's codes): by code, then status. */
fun describeDriveError(e: Throwable): String = when (e) {
    is ApiException.Api -> jp.chikuwachat.android.api.ErrorTexts.code(e.code) ?: jp.chikuwachat.android.api.ErrorTexts.status(e.status) ?: jp.chikuwachat.android.api.ErrorTexts.unknown
    is ApiException.Network -> jp.chikuwachat.android.api.ErrorTexts.network
    else -> jp.chikuwachat.android.api.ErrorTexts.unknown
}

/**
 * The drive's plain rules (DRIVE.md §17 and §26, the desktop's drive/listing.ts and drive/conversation.ts): names of the
 * locations in the UI language, paths, sizes, the time a row shows, which viewer opens a file.
 */
object DriveNames {
    /** 研究室ドライブ / マイドライブ in the UI language (the server names them in Japanese), a channel by its name. */
    fun locationName(kind: String?, name: String): String = when (kind) {
        "workspace" -> L10n.str(R.string.drive_location_workspace)
        "user" -> L10n.str(R.string.drive_location_mine)
        else -> "#$name"
    }

    fun locationName(location: DriveLocationOut): String = locationName(location.kind, location.name)

    /** The list's order: 研究室ドライブ, マイドライブ, then the channels by name. */
    fun order(locations: List<DriveLocationOut>): List<DriveLocationOut> {
        val collator = java.text.Collator.getInstance(java.util.Locale.JAPANESE)
        fun rank(location: DriveLocationOut) = when (location.kind) { "workspace" -> 0; "user" -> 1; else -> 2 }
        return locations.sortedWith(compareBy<DriveLocationOut> { rank(it) }.thenComparator { a, b -> collator.compare(a.name, b.name) })
    }

    /** A path's crumbs with the root named by its location's kind (the server's root name is Japanese, or the channel's). */
    fun crumbs(path: List<DriveCrumb>, kind: String?): List<DriveCrumb> =
        path.mapIndexed { index, crumb -> if (index == 0) crumb.copy(name = locationName(kind, crumb.name)) else crumb }

    /** 「研究室ドライブ › 論文 › 2026年度」. */
    fun pathLine(path: List<DriveCrumb>, kind: String?): String = crumbs(path, kind).joinToString(" › ") { it.name }

    /** A /d/ card's second line: where the item is, and its size (a folder: 「フォルダ」). */
    fun cardDetails(detail: DriveItemDetailOut): String {
        val where = pathLine(detail.path, detail.locationKind)
        val what = if (detail.item.isFolder) L10n.str(R.string.drive_folder) else bytes(detail.item.sizeBytes)
        return if (where.isEmpty()) what else "$where · $what"
    }

    /** 「1.2 GB」: the drive's sizes go past the attachments' MB (the desktop's formatBytes). */
    fun bytes(size: Long?): String {
        if (size == null) return ""
        val kib = 1024.0
        val mib = kib * 1024
        val gib = mib * 1024
        return when {
            size >= gib -> String.format(java.util.Locale.ROOT, if (size >= 10 * gib) "%.0f GB" else "%.1f GB", size / gib)
            size >= mib -> String.format(java.util.Locale.ROOT, if (size >= 10 * mib) "%.0f MB" else "%.1f MB", size / mib)
            size >= kib -> "${Math.round(size / kib)} KB"
            else -> "$size B"
        }
    }

    /** The time a row shows: the file's own time when known, else the last change. */
    fun itemTime(item: DriveItemOut): String = item.contentModifiedAt ?: item.updatedAt

    enum class Viewer { IMAGE, VIDEO, DOCUMENT }

    /**
     * Which of the app's viewers opens a file (§17.2, §27.3, the desktop's viewerKind): photos with a thumbnail (the
     * server could read them), videos, every PDF (its own bytes while its preview is not made) and Office files (the
     * viewer asks for, or waits for, the preview). Anything else shows its details.
     */
    fun viewer(item: DriveItemOut): Viewer? {
        val file = item.file ?: return null
        if (item.isFolder) return null
        val type = item.contentType.orEmpty().lowercase()
        return when {
            type.startsWith("video/") -> Viewer.VIDEO
            type.startsWith("image/") && file.hasThumbnail -> Viewer.IMAGE
            file.preview?.isReady == true || file.preview?.isPending == true || isPdf(item) || isOffice(item) -> Viewer.DOCUMENT
            else -> null
        }
    }

    private val OFFICE_EXTENSIONS = setOf("doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf")
    private val OFFICE_TYPE = Regex("^application/(msword|rtf|vnd\\.ms-(excel|powerpoint)|vnd\\.openxmlformats-officedocument\\.|vnd\\.oasis\\.opendocument\\.(text|spreadsheet|presentation)$)")
    /** What the server's sniffer answers for a file it could not place (the server then goes by the extension). */
    private val UNPLACED = setOf("", "application/octet-stream", "application/zip", "application/x-ole-storage")

    private fun extension(name: String): String = name.substringAfterLast('.', "").lowercase().takeIf { name.lastIndexOf('.') > 0 } ?: ""

    /** A PDF: by its type, or by its name when the server could not tell (bytes before the header, §27.3). */
    fun isPdf(item: DriveItemOut): Boolean {
        if (item.isFolder) return false
        val type = item.contentType.orEmpty().lowercase()
        return type == "application/pdf" || (extension(item.name) == "pdf" && (type == "" || type == "application/octet-stream"))
    }

    /** An Office file the converter may turn into a PDF (the server's preview_kinds.source_kind). */
    fun isOffice(item: DriveItemOut): Boolean {
        if (item.isFolder) return false
        val type = item.contentType.orEmpty().lowercase()
        return OFFICE_TYPE.containsMatchIn(type) || (type in UNPLACED && extension(item.name) in OFFICE_EXTENSIONS)
    }

    /**
     * Where the document viewer reads a file's pages (§27.3, the desktop's documentSource): the made preview; a PDF's
     * own bytes while its preview is not ready; an Office file's preview being made; one never asked for (imported,
     * §24: the viewer asks); one that failed.
     */
    enum class DocumentSource { PREVIEW, ORIGINAL, MAKING, ASK, FAILED }

    fun documentSource(item: DriveItemOut): DocumentSource {
        val preview = item.file?.preview
        return when {
            preview?.isReady == true -> DocumentSource.PREVIEW
            isPdf(item) -> DocumentSource.ORIGINAL
            preview?.isPending == true -> DocumentSource.MAKING
            preview?.status == "failed" -> DocumentSource.FAILED
            else -> DocumentSource.ASK
        }
    }

    /** The small picture a row or a card shows (null: an icon): a photo's thumbnail, a video's poster, a document's first page. */
    fun thumbnailPath(item: DriveItemOut): String? {
        val file = item.file ?: return null
        if (item.isFolder) return null
        return when {
            file.hasThumbnail || file.hasPoster -> "/api/v1/attachments/${file.attachmentId}/thumbnail"
            file.preview?.isReady == true -> "/api/v1/attachments/${file.attachmentId}/preview/thumbnail"
            else -> null
        }
    }

    /** The current version as the viewers' AttachmentOut (§5.2: /attachments/{attachment_id}/… serve a drive version too). */
    fun asAttachment(item: DriveItemOut): AttachmentOut? {
        val file = item.file ?: return null
        if (item.isFolder) return null
        return AttachmentOut(
            id = file.attachmentId, filename = item.name, contentType = item.contentType ?: "application/octet-stream",
            sizeBytes = item.sizeBytes ?: 0, width = file.width, height = file.height, hasThumbnail = file.hasThumbnail,
            createdAt = item.updatedAt, hasPoster = file.hasPoster, durationMs = file.durationMs, preview = file.preview,
        )
    }

    enum class Icon { FOLDER, IMAGE, VIDEO, PDF, DOCUMENT, SHEET, SLIDES, ARCHIVE, TEXT, FILE }

    private val OFFICE = mapOf(
        "doc" to Icon.DOCUMENT, "docx" to Icon.DOCUMENT, "odt" to Icon.DOCUMENT, "rtf" to Icon.DOCUMENT,
        "xls" to Icon.SHEET, "xlsx" to Icon.SHEET, "ods" to Icon.SHEET, "csv" to Icon.SHEET,
        "ppt" to Icon.SLIDES, "pptx" to Icon.SLIDES, "odp" to Icon.SLIDES,
        "zip" to Icon.ARCHIVE, "7z" to Icon.ARCHIVE, "gz" to Icon.ARCHIVE, "tar" to Icon.ARCHIVE, "rar" to Icon.ARCHIVE,
        "txt" to Icon.TEXT, "md" to Icon.TEXT, "tex" to Icon.TEXT, "json" to Icon.TEXT,
    )

    fun icon(item: DriveItemOut): Icon {
        if (item.isFolder) return Icon.FOLDER
        val type = item.contentType.orEmpty().lowercase()
        return when {
            type.startsWith("image/") -> Icon.IMAGE
            type.startsWith("video/") -> Icon.VIDEO
            isPdf(item) -> Icon.PDF
            else -> OFFICE[item.name.substringAfterLast('.', "").lowercase()] ?: Icon.FILE
        }
    }
}

/** The folder listing's order (§5.2: folders first is the server's). */
enum class DriveSort(val key: String, private val labelRes: Int, val defaultOrder: String) {
    NAME("name", R.string.drive_sort_name, "asc"),
    MODIFIED("modified", R.string.drive_sort_modified, "desc"),
    SIZE("size", R.string.drive_sort_size, "desc"),
    ;

    val label: String get() = L10n.str(labelRes)
}

/** A folder as the screen shows it: what was read so far (pages of 100), the next page's cursor, and how it went. */
data class DriveFolderState(
    val folder: DriveItemOut? = null,
    val path: List<DriveCrumb> = emptyList(),
    val items: List<DriveItemOut> = emptyList(),
    val nextCursor: String? = null,
    val loading: Boolean = false,
    val loadingMore: Boolean = false,
    /** The failure of the last read, in words; the rows read before stay. */
    val error: String? = null,
    /** The folder is not there for me any more (404: moved to the trash, my membership ended, deleted). */
    val gone: Boolean = false,
    val sort: DriveSort = DriveSort.NAME,
    val order: String = DriveSort.NAME.defaultOrder,
) {
    val canLoadMore: Boolean get() = nextCursor != null && !loading && !loadingMore
}

object DriveListing {
    const val PAGE = 100

    /** The next page appended to the rows held (an item moved between pages by a change counts once). */
    fun appendPage(held: List<DriveItemOut>, page: List<DriveItemOut>): List<DriveItemOut> {
        val seen = held.mapTo(HashSet()) { it.id }
        return held + page.filter { seen.add(it.id) }
    }

    /** How many rows a re-read asks for: as many as are held (so a refresh keeps the place), within the server's 200. */
    fun reloadLimit(held: Int): Int = held.coerceIn(PAGE, 200)

    /** Choosing a sort: the same one flips the order, another starts at its own default order. */
    fun choose(state: DriveFolderState, sort: DriveSort): Pair<DriveSort, String> =
        if (state.sort == sort) sort to (if (state.order == "asc") "desc" else "asc") else sort to sort.defaultOrder
}

/**
 * One folder's pages (DRIVE.md §17.2, §26): the first page, then 100 more each time the list nears its end; a re-read
 * (pull to refresh, drive.changed, a reconnect) asks for as many rows as are held. An answer that started before a newer
 * read is dropped, so a sort changed during a load never shows the old order.
 */
class DriveFolderLoader(private val api: DriveApi, val folderId: String, private val describe: (Throwable) -> String) {
    private val _state = MutableStateFlow(DriveFolderState())
    val state: StateFlow<DriveFolderState> = _state
    private var generation = 0

    suspend fun reload(sort: DriveSort = _state.value.sort, order: String = _state.value.order) {
        val ticket = ++generation
        val held = if (sort == _state.value.sort && order == _state.value.order) _state.value.items.size else 0
        _state.value = _state.value.copy(loading = true, error = null, sort = sort, order = order, items = if (held == 0) emptyList() else _state.value.items)
        try {
            val page = api.driveChildren(folderId, sort.key, order, null, DriveListing.reloadLimit(held))
            if (ticket != generation) return
            _state.value = _state.value.copy(folder = page.folder, path = page.path, items = page.items, nextCursor = page.nextCursor, loading = false, gone = false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (ticket != generation) return
            _state.value = _state.value.copy(loading = false, gone = e.isDriveNotFound(), error = describe(e))
        }
    }

    suspend fun loadMore() {
        val now = _state.value
        val cursor = now.nextCursor ?: return
        if (!now.canLoadMore) return
        val ticket = generation
        _state.value = now.copy(loadingMore = true, error = null)
        try {
            val page = api.driveChildren(folderId, now.sort.key, now.order, cursor, DriveListing.PAGE)
            if (ticket != generation) return
            _state.value = _state.value.copy(items = DriveListing.appendPage(_state.value.items, page.items), nextCursor = page.nextCursor, loadingMore = false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (ticket != generation) return
            _state.value = _state.value.copy(loadingMore = false, gone = e.isDriveNotFound(), error = describe(e))
        }
    }
}

/** The file-name search within a location (§12: `GET /search/drive?location_id=`), paged by its cursor. */
data class DriveSearchState(
    val query: String = "",
    val hits: List<DriveSearchHitOut> = emptyList(),
    val nextCursor: String? = null,
    val loading: Boolean = false,
    val error: String? = null,
)

class DriveSearchLoader(private val api: DriveApi, private val locationId: String?, private val describe: (Throwable) -> String) {
    private val _state = MutableStateFlow(DriveSearchState())
    val state: StateFlow<DriveSearchState> = _state
    private var generation = 0

    /** A blank query clears the results (the folder shows again). */
    suspend fun search(query: String) {
        val ticket = ++generation
        val q = query.trim()
        if (q.isEmpty()) { _state.value = DriveSearchState(); return }
        _state.value = DriveSearchState(query = q, loading = true)
        try {
            val out = api.searchDrive(q, locationId, null, 50)
            if (ticket == generation) _state.value = DriveSearchState(q, out.items, out.nextCursor)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (ticket == generation) _state.value = DriveSearchState(q, error = describe(e))
        }
    }

    suspend fun loadMore() {
        val now = _state.value
        val cursor = now.nextCursor ?: return
        if (now.loading) return
        val ticket = generation
        _state.value = now.copy(loading = true)
        try {
            val out = api.searchDrive(now.query, locationId, cursor, 50)
            if (ticket != generation) return
            val seen = now.hits.mapTo(HashSet()) { it.item.id }
            _state.value = now.copy(hits = now.hits + out.items.filter { seen.add(it.item.id) }, nextCursor = out.nextCursor, loading = false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (ticket == generation) _state.value = now.copy(loading = false, error = describe(e))
        }
    }
}

/** A `/d/<id>` card's item (§13.1, §25.1): readable, not there for me (404, the trash too) or not read (try again). */
sealed interface DriveLinkState {
    data class Ok(val detail: DriveItemDetailOut) : DriveLinkState
    data object Unreadable : DriveLinkState
    data object Failed : DriveLinkState

    companion object {
        fun of(e: Throwable): DriveLinkState = if (e.isDriveNotFound()) Unreadable else Failed
    }
}

/**
 * What the `/d/` links in a body read as (§26, the same on iOS): inline a short label — never the markdown `[name]`,
 * which whoever cannot read the item must not see — and under the body a card for each distinct item, at most three.
 */
object DriveLinks {
    const val MAX_CARDS = 3
    private val UUID = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", RegexOption.IGNORE_CASE)

    /** Every drive item linked on `base` in a text, each once, in order (the first [MAX_CARDS] get a card). */
    fun idsIn(base: String?, text: String): List<String> {
        if (base == null || !text.contains("/d/")) return emptyList()
        val prefix = base.trimEnd('/') + "/d/"
        val found = LinkedHashSet<String>()
        var at = text.indexOf(prefix, ignoreCase = true)
        while (at >= 0) {
            val start = at + prefix.length
            val id = text.substring(start, minOf(text.length, start + 36))
            if (id.length == 36 && UUID.matches(id)) found.add(id.lowercase())
            at = text.indexOf(prefix, start, ignoreCase = true)
        }
        return found.toList()
    }

    fun cards(base: String?, text: String): List<String> = idsIn(base, text).take(MAX_CARDS)

    /** The inline label of a link: 「📁 名前」 / 「📎 名前」 once read, 「表示できないファイル」, else 「ドライブのファイル」. */
    fun label(state: DriveLinkState?): String = when (state) {
        is DriveLinkState.Ok -> (if (state.detail.item.isFolder) "📁 " else "📎 ") + state.detail.item.name
        DriveLinkState.Unreadable -> L10n.str(R.string.drive_card_unavailable)
        else -> L10n.str(R.string.drive_link_unknown)
    }
}

/**
 * M166 (docs/DRIVE.md §14, §26): what the phone knows of the drive — nothing is kept on the device (§14: online only).
 * Whether the server has the drive at all (`GET /drive/locations` answered: the home's 「ドライブ」 tile and the channels'
 * tab show only then), the locations, the `/d/` cards' items (one minute each, as the desktop's controller.driveLink),
 * and the signals that make the open folder read again: `drive.changed` naming it (300 ms folded, an older `seq`
 * dropped), `drive.location.updated` and my membership (the locations), and every reconnect (everything: events may have
 * been lost). Runs on the app's main thread (the controller's scope), like AiHub.
 */
class DriveHub(
    private val api: DriveApi?,
    private val scope: CoroutineScope,
    private val isGuest: () -> Boolean = { false },
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val debounceMs: Long = 300,
) {
    /** Null until asked (and while it could not be asked); false: the server has no drive (404 on an older server). */
    var available: Boolean? = null
        private set
    /** The locations I can open, in the list's order; null until read. */
    var locations: List<DriveLocationOut>? = null
        private set
    var locationsError: String? = null
        private set
    private val _version = MutableStateFlow(0)
    /** Bumped by every change: the screens read [locations], [folderEpoch] and [link] again. */
    val version: StateFlow<Int> = _version
    private var reconnects = 0
    private val folderTicks = HashMap<String, Int>()
    private var maxSeq = -1L
    private val pending = HashSet<String>()
    private var flush: Job? = null
    private var locationsJob: Job? = null
    private val links = HashMap<String, Pair<DriveLinkState, Long>>()
    /** Folder names read by the screens (the app bar's title of a folder). */
    private val names = HashMap<String, String>()

    private fun changed() { _version.value = _version.value + 1 }

    /** Changes when the folder should be read again (an event named it, or the connection came back). */
    fun folderEpoch(folderId: String): Int = reconnects + (folderTicks[folderId] ?: 0)

    fun folderName(id: String): String? = names[id]

    fun noteFolder(id: String, name: String) {
        if (names[id] != name) { names[id] = name; changed() }
    }

    /** The connection is (back) up: the locations again, and every open folder reads again (§14). */
    fun online() {
        reconnects += 1
        links.clear()
        changed()
        reloadLocations()
    }

    fun stop() {
        flush?.cancel()
        locationsJob?.cancel()
    }

    /** `drive.changed {location_id, folder_ids, seq}`: the folders named read again 300 ms after the last such event. */
    fun applyChanged(folderIds: List<String>, seq: Long?) {
        if (seq != null) {
            if (seq <= maxSeq) return // a duplicate or an older event after a newer one
            maxSeq = seq
        }
        pending.addAll(folderIds)
        folderIds.forEach { links.remove(it) }
        if (flush?.isActive == true) return
        flush = scope.launch {
            delay(debounceMs)
            pending.forEach { folderTicks[it] = (folderTicks[it] ?: 0) + 1 }
            pending.clear()
            links.entries.removeAll { (_, value) -> value.first !is DriveLinkState.Ok } // what was not there may be now
            changed()
        }
    }

    /** `drive.location.updated`, my membership or role changed: the locations again (folded like the folders). */
    fun reloadLocations() {
        if (api == null) return
        locationsJob?.cancel()
        locationsJob = scope.launch {
            delay(if (locations == null) 0 else debounceMs)
            loadLocations()
        }
    }

    /**
     * GET /drive/locations; マイドライブ is made when first opened (§3.1), so a person (not a guest) without one gets it
     * from `resolve {kind: "me"}` once the drive screen asks ([withMine]).
     */
    suspend fun loadLocations(withMine: Boolean = false) {
        val api = api ?: return
        try {
            var list = api.driveLocations().locations
            if (withMine && !isGuest() && list.none { it.kind == "user" }) {
                list = list + runCatching { api.resolveDriveLocation(null) }.getOrElse {
                    if (it is CancellationException) throw it
                    Log.w("DriveHub", "could not make マイドライブ", it)
                    null
                }.let(::listOfNotNull)
            }
            available = true
            locations = DriveNames.order(list)
            locationsError = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (e is ApiException.Api && e.status == 404) available = false
            locationsError = describeDriveError(e)
            Log.w("DriveHub", "could not read the drive's locations", e)
        }
        changed()
    }

    /** The channel's own drive (§13.3, the channel's 「ドライブ」 tab), made when it has none yet. */
    suspend fun channelLocation(channelId: String): DriveLocationOut {
        val api = api ?: throw IllegalStateException("signed out")
        locations?.firstOrNull { it.kind == "channel" && it.channelId == channelId }?.let { return it }
        val made = api.resolveDriveLocation(channelId)
        locations = locations?.let { held -> DriveNames.order(held.filterNot { it.id == made.id } + made) }
        changed()
        return made
    }

    fun location(id: String): DriveLocationOut? = locations?.firstOrNull { it.id == id }

    /** The card's state when read within the last minute (null: not read, or too old). */
    fun peekLink(itemId: String): DriveLinkState? {
        val (state, at) = links[itemId] ?: return null
        return if (clock() - at < LINK_TTL_MS) state else null
    }

    /** Reads the card's item (kept a minute; `force`: a tap on 「もう一度」). A failure is kept only until asked again. */
    suspend fun link(itemId: String, force: Boolean = false): DriveLinkState {
        if (!force) peekLink(itemId)?.let { if (it != DriveLinkState.Failed) return it }
        val api = api ?: return DriveLinkState.Failed
        val state = try {
            DriveLinkState.Ok(api.driveItem(itemId))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            DriveLinkState.of(e)
        }
        links[itemId] = state to clock()
        changed()
        return state
    }

    companion object {
        const val LINK_TTL_MS = 60_000L
    }
}
