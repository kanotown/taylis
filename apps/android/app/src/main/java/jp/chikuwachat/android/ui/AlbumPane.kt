package jp.chikuwachat.android.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.LruCache
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ViewList
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material.icons.outlined.SaveAlt
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Slideshow
import androidx.compose.material.icons.outlined.Star
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.AlbumCreatedOut
import jp.chikuwachat.android.api.AlbumListEntryOut
import jp.chikuwachat.android.api.AlbumOut
import jp.chikuwachat.android.api.DriveItemDetailOut
import jp.chikuwachat.android.api.DriveItemOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.platform.DriveUploadCenter
import jp.chikuwachat.android.sync.AlbumCell
import jp.chikuwachat.android.sync.AlbumListLoader
import jp.chikuwachat.android.sync.AlbumLoader
import jp.chikuwachat.android.sync.AlbumRules
import jp.chikuwachat.android.sync.ConflictChoice
import jp.chikuwachat.android.sync.DriveNames
import jp.chikuwachat.android.sync.describeDriveError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.UUID

/*
 * AL4 (docs/ALBUMS.md §10–§12, §18.4, MOBILE_UI.md §25.7): photo albums on Android. An album is a drive folder, so it
 * opens from 「ドライブ」 (the row of covers above the locations, a folder that is an album, a /d/ card) and shows as a
 * grid of thumbnails by capture day instead of the file list; the viewer swipes between its photos (display-size
 * images), the slideshow keeps the screen on, photos are saved to the gallery and many are uploaded at once by the
 * drive's background uploads. Plain surfaces and thin outlines; no coloured side bars.
 */

/** The grid's thumbnails (512 px, RGB_565), bounded by bytes so a long album scrolled through does not grow the heap. */
private object AlbumThumbs {
    private val held = object : LruCache<String, ImageBitmap>(40 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ImageBitmap): Int = value.width * value.height * 2
    }

    fun peek(path: String): ImageBitmap? = held.get(path)

    suspend fun load(controller: AppController, path: String): ImageBitmap? {
        peek(path)?.let { return it }
        return try {
            val bytes = controller.fetchBytes(path)
            withContext(Dispatchers.Default) {
                val options = BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.RGB_565 }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.asImageBitmap()
            }?.also { held.put(path, it) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
    }
}

/** A square picture of an attachment's thumbnail (or the kind's icon while there is none). */
@Composable
private fun AlbumThumb(controller: AppController, attachmentId: String?, modifier: Modifier, icon: androidx.compose.ui.graphics.vector.ImageVector = Icons.Outlined.Image) {
    val path = attachmentId?.let { AlbumRules.thumbnailPath(it) }
    var image by remember(path) { mutableStateOf(path?.let { AlbumThumbs.peek(it) }) }
    if (path != null && image == null) LaunchedEffect(path) { image = AlbumThumbs.load(controller, path) }
    Box(modifier.background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)), contentAlignment = Alignment.Center) {
        val picture = image
        if (picture != null) Image(picture, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        else Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(24.dp))
    }
}

/** A photo's or a video's grid picture: the thumbnail or the poster, when the server made one. */
private fun cellThumbnail(item: DriveItemOut): String? = item.file?.takeIf { it.hasThumbnail || it.hasPoster }?.attachmentId

@OptIn(ExperimentalFoundationApi::class)
private fun Modifier.tapAndHold(onClick: () -> Unit, onLongClick: (() -> Unit)? = null, label: String? = null): Modifier =
    combinedClickable(role = Role.Button, onClick = onClick, onLongClick = onLongClick, onClickLabel = label)

// --- the albums row above the locations (§12 置き場所) ----------------------------------------------------

/** 「アルバム」 at the top of 「ドライブ」: the covers of the albums I can read, newest first, scrolled sideways. */
@Composable
internal fun AlbumsRow(controller: AppController, onOpen: (AlbumListEntryOut) -> Unit) {
    val api = controller.albumApi ?: return
    val hub = controller.drive ?: return
    val loader = remember { AlbumListLoader(api, null, ::describeDriveError) }
    val state by loader.state.collectAsState()
    hub.version.collectAsState().value
    val epoch = hub.anyEpoch()
    LaunchedEffect(epoch) { loader.reload() }
    if (state.loaded && state.entries.isEmpty()) return // none yet (or a server before AL1): nothing above the locations
    val list = rememberLazyListState()
    LaunchedEffect(list) {
        snapshotFlow { list.layoutInfo.let { (it.visibleItemsInfo.lastOrNull()?.index ?: 0) >= it.totalItemsCount - 3 } }
            .distinctUntilChanged().collect { if (it) loader.loadMore() }
    }
    Column(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
        Text(stringResource(R.string.album_title), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 16.dp, top = 12.dp, bottom = 6.dp))
        if (!state.loaded) Box(Modifier.fillMaxWidth().heightIn(min = 120.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
        else LazyRow(state = list, contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            items(state.entries, key = { it.folder.id }) { entry ->
                Column(Modifier.width(128.dp).clip(RoundedCornerShape(10.dp)).tapAndHold(onClick = { onOpen(entry) }, label = stringResource(R.string.drive_open)).padding(2.dp)) {
                    AlbumThumb(controller, entry.album.cover?.attachmentId, Modifier.size(124.dp).clip(RoundedCornerShape(10.dp))
                        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp)), icon = Icons.Outlined.PhotoLibrary)
                    Text(entry.folder.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(top = 4.dp))
                    Text(AlbumRules.cardLine(entry.album), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        HorizontalDivider(Modifier.padding(top = 10.dp))
    }
}

// --- the album screen (§12 格子) --------------------------------------------------------------------------

/**
 * A folder that is an album: its header (題名・日付・枚数・説明), 「スライドショー」, 「写真を追加」 and the ⋯ (settings, the
 * file list, ZIP), then the grid by capture day; long-press selects (save to the gallery, the cover). Read again when
 * drive.changed names the folder or the connection comes back.
 */
@Composable
internal fun AlbumScreen(
    controller: AppController, locationId: String, folderId: String,
    onShowFiles: () -> Unit, onNotAlbum: () -> Unit, onGone: () -> Unit,
) {
    val api = controller.albumApi ?: return
    val hub = controller.drive ?: return
    hub.version.collectAsState().value
    val loader = remember(folderId) { AlbumLoader(api, folderId, ::describeDriveError) }
    val state by loader.state.collectAsState()
    val scope = rememberCoroutineScope()
    val epoch = hub.folderEpoch(folderId)
    LaunchedEffect(folderId, epoch) { loader.reload() }
    LaunchedEffect(state.notAlbum) { if (state.notAlbum) onNotAlbum() }
    LaunchedEffect(state.gone) { if (state.gone) onGone() }
    val detail = state.detail
    val album = state.album
    val canWrite = detail?.canWrite == true
    var viewing by remember { mutableStateOf<Int?>(null) }
    var playing by remember { mutableStateOf<DriveItemOut?>(null) }
    var slideshowFrom by remember { mutableStateOf<Int?>(null) }
    var selected by remember(folderId) { mutableStateOf<Set<String>>(emptySet()) }
    var settings by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    val grid = rememberLazyGridState()
    // 100 more as the grid nears its end (only the cells on screen read their thumbnails: LazyVerticalGrid).
    LaunchedEffect(grid, loader) {
        snapshotFlow { grid.layoutInfo.let { (it.visibleItemsInfo.lastOrNull()?.index ?: 0) >= it.totalItemsCount - 12 } }
            .distinctUntilChanged().collect { if (it) loader.loadMore() }
    }
    val cells = remember(state.items, album?.sort) { AlbumRules.cells(state.items, album?.sort ?: "taken") }
    fun setCover(item: DriveItemOut?) {
        scope.launch {
            try {
                loader.showAlbum(api.putAlbum(folderId, mapOf("cover_item_id" to item?.id)))
                controller.notice = L10n.str(R.string.album_cover_set)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                controller.error = describeDriveError(e)
            }
        }
    }
    Column(Modifier.fillMaxSize()) {
        if (selected.isNotEmpty()) SelectionBar(
            count = selected.size, canCover = canWrite && selected.size == 1,
            onSave = { controller.saveToGallery(state.items.filter { it.id in selected }); selected = emptySet() },
            onCover = { setCover(state.items.firstOrNull { it.id in selected }); selected = emptySet() },
            onClear = { selected = emptySet() },
        )
        controller.gallerySave?.let { (done, total) ->
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
                Text(L10n.str(R.string.album_saving, done, total), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                LinearProgressIndicator(progress = { if (total == 0) 0f else done.toFloat() / total }, modifier = Modifier.fillMaxWidth().padding(top = 4.dp))
            }
        }
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { refreshing = true; scope.launch { try { loader.reload() } finally { refreshing = false } } },
            modifier = Modifier.weight(1f).fillMaxWidth(),
        ) {
            BoxWithConstraints(Modifier.fillMaxSize()) {
                // §12: 3 columns on a phone, 5–6 on a tablet.
                val columns = when { maxWidth >= 840.dp -> 6; maxWidth >= 600.dp -> 5; else -> 3 }
                LazyVerticalGrid(
                    columns = GridCells.Fixed(columns), state = grid, modifier = Modifier.fillMaxSize(),
                    horizontalArrangement = Arrangement.spacedBy(2.dp), verticalArrangement = Arrangement.spacedBy(2.dp),
                    contentPadding = PaddingValues(bottom = 16.dp),
                ) {
                    item(key = "header", span = { GridItemSpan(maxLineSpan) }) {
                        when {
                            detail != null && album != null -> AlbumHeader(
                                controller, detail.folder, album, canWrite, detail.folderCount, detail.otherCount,
                                path = DriveNames.pathLine(detail.path.dropLast(1), detail.locationKind, hub.systemFolders),
                                hasItems = state.items.isNotEmpty(),
                                onSlideshow = { slideshowFrom = 0 }, onSettings = { settings = true }, onShowFiles = onShowFiles,
                                locationId = locationId, folderId = folderId,
                            )
                            state.error != null -> DriveNote(state.error!!) { scope.launch { loader.reload() } }
                            else -> Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                        }
                    }
                    if (detail != null && state.items.isEmpty() && !state.loading) {
                        item(key = "empty", span = { GridItemSpan(maxLineSpan) }) {
                            Text(stringResource(R.string.album_empty), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = 24.dp, vertical = 32.dp))
                        }
                    }
                    items(cells, key = { it.key }, span = { if (it is AlbumCell.Day) GridItemSpan(maxLineSpan) else GridItemSpan(1) }) { cell ->
                        when (cell) {
                            is AlbumCell.Day -> Text(cell.label, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.padding(start = 12.dp, top = 14.dp, bottom = 6.dp))
                            is AlbumCell.Photo -> AlbumCellView(
                                controller, cell.item, selecting = selected.isNotEmpty(), chosen = cell.item.id in selected,
                                isCover = album?.cover?.itemId == cell.item.id && album.coverItemId != null,
                                onClick = {
                                    if (selected.isNotEmpty()) selected = if (cell.item.id in selected) selected - cell.item.id else selected + cell.item.id
                                    else viewing = cell.index
                                },
                                onLongClick = { selected = selected + cell.item.id },
                            )
                        }
                    }
                    if (state.loadingMore) item(key = "more", span = { GridItemSpan(maxLineSpan) }) {
                        Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
                    }
                    if (detail != null && state.error != null) item(key = "error", span = { GridItemSpan(maxLineSpan) }) {
                        DriveNote(state.error!!) { scope.launch { if (state.nextCursor != null) loader.loadMore() else loader.reload() } }
                    }
                }
            }
        }
    }
    viewing?.let { start ->
        val items = state.items
        val photos = remember(items) { albumViewerPages(items) }
        PhotoViewer(
            photos, start, controller, onDismiss = { viewing = null },
            onOpenElsewhere = { index -> items.getOrNull(index)?.let { controller.downloadDrive(it, AppController.DriveAction.OPEN) } },
            onPage = { index -> if (index >= items.size - 5) scope.launch { loader.loadMore() } },
            onPlayVideo = { index -> playing = items.getOrNull(index) },
            menu = { index, close ->
                val item = items.getOrNull(index)
                if (item != null) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.album_save_to_gallery)) }, leadingIcon = { Icon(Icons.Outlined.SaveAlt, null) },
                        onClick = { close(); controller.saveToGallery(listOf(item)) })
                    if (canWrite) DropdownMenuItem(text = { Text(stringResource(R.string.album_make_cover)) }, leadingIcon = { Icon(Icons.Outlined.Star, null) },
                        onClick = { close(); setCover(item) })
                    DropdownMenuItem(text = { Text(stringResource(R.string.album_slideshow_from_here)) }, leadingIcon = { Icon(Icons.Outlined.Slideshow, null) },
                        onClick = { close(); viewing = null; slideshowFrom = index })
                }
            },
        )
    }
    playing?.let { item ->
        val attachment = remember(item) { DriveNames.asAttachment(item) }
        if (attachment == null) playing = null
        else VideoViewer(attachment, controller, null, onDismiss = { playing = null }, stream = { controller.driveStreamUrl(item.id) },
            onOpenElsewhere = { controller.downloadDrive(item, AppController.DriveAction.OPEN) })
    }
    slideshowFrom?.let { start ->
        AlbumSlideshow(controller, state.items, start, hasMore = state.nextCursor != null, loadMore = { loader.loadMore() }, onDismiss = { slideshowFrom = null })
    }
    if (settings && album != null && detail != null) AlbumSettingsDialog(
        controller, folderId, detail.folder.name, album, onDismiss = { settings = false },
        onSaved = { settings = false; loader.showAlbum(it) },
        onRemoved = { settings = false; onNotAlbum() },
    )
}

/** The viewer's pages of an album (§12): every photo and video, photos from their display image. */
internal fun albumViewerPages(items: List<DriveItemOut>): List<ViewerPhoto> = items.mapNotNull { item ->
    val attachment = DriveNames.asAttachment(item) ?: return@mapNotNull null
    val taken = (item.file?.takenAt)?.let { AlbumRules.instant(it) }?.let { Timeline.fullLabel(it.toString()) }
    ViewerPhoto(attachment, display = !AlbumRules.isVideo(item), subtitle = AlbumRules.viewerLine(item, taken), video = AlbumRules.isVideo(item), key = item.id)
}

@Composable
private fun SelectionBar(count: Int, canCover: Boolean, onSave: () -> Unit, onCover: () -> Unit, onClear: () -> Unit) {
    Surface(tonalElevation = 2.dp, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onClear) { Icon(Icons.Outlined.Close, stringResource(R.string.album_selection_clear)) }
            Text(L10n.plural(R.plurals.album_selected, count, count), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            if (canCover) TextButton(onClick = onCover) { Text(stringResource(R.string.album_make_cover)) }
            TextButton(onClick = onSave) {
                Icon(Icons.Outlined.SaveAlt, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(stringResource(R.string.album_save_to_gallery))
            }
        }
    }
}

@Composable
private fun DriveNote(text: String, retry: (() -> Unit)?) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (retry != null) TextButton(onClick = retry) { Text(stringResource(R.string.common_retry)) }
    }
}

@Composable
private fun AlbumHeader(
    controller: AppController, folder: DriveItemOut, album: AlbumOut, canWrite: Boolean, folderCount: Int, otherCount: Int, path: String,
    hasItems: Boolean, onSlideshow: () -> Unit, onSettings: () -> Unit, onShowFiles: () -> Unit, locationId: String, folderId: String,
) {
    var expanded by rememberSaveable(folder.id) { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp)) {
        Text(folder.name, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        Text(AlbumRules.cardLine(album), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp))
        if (path.isNotEmpty()) Text(path, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (album.description.isNotBlank()) {
            Text(album.description, style = MaterialTheme.typography.bodyMedium, maxLines = if (expanded) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 6.dp, end = 8.dp))
            if (!expanded && (album.description.length > 90 || album.description.count { it == '\n' } >= 3)) {
                TextButton(onClick = { expanded = true }, contentPadding = PaddingValues(0.dp)) { Text(stringResource(R.string.album_more_description)) }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilledTonalButton(onClick = onSlideshow, enabled = hasItems) {
                Icon(Icons.Outlined.Slideshow, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(stringResource(R.string.album_slideshow))
            }
            if (canWrite) AlbumAddPhotosButton(controller, locationId, folderId, label = path.let { if (it.isEmpty()) folder.name else "$it › ${folder.name}" })
            Spacer(Modifier.weight(1f))
            Box {
                IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, stringResource(R.string.album_menu)) }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    if (canWrite) DropdownMenuItem(text = { Text(stringResource(R.string.album_settings)) }, leadingIcon = { Icon(Icons.Outlined.Settings, null) },
                        onClick = { menu = false; onSettings() })
                    DropdownMenuItem(text = { Text(stringResource(R.string.album_show_files)) }, leadingIcon = { Icon(Icons.AutoMirrored.Outlined.ViewList, null) },
                        onClick = { menu = false; onShowFiles() })
                    DropdownMenuItem(text = { Text(stringResource(R.string.album_download_all)) }, leadingIcon = { Icon(Icons.Outlined.Download, null) },
                        onClick = { menu = false; controller.downloadDrive(folder, AppController.DriveAction.SAVE) })
                }
            }
        }
        // §4.1: subfolders and other files (PDF…) are not in the grid; the file list shows them.
        if (folderCount > 0 || otherCount > 0) {
            val parts = listOfNotNull(
                folderCount.takeIf { it > 0 }?.let { L10n.plural(R.plurals.album_folders, it, it) },
                otherCount.takeIf { it > 0 }?.let { L10n.plural(R.plurals.album_other_files, it, it) },
            ).joinToString(" · ")
            TextButton(onClick = onShowFiles, contentPadding = PaddingValues(horizontal = 0.dp)) { Text(L10n.str(R.string.album_others_line, parts)) }
        }
    }
}

/** 「写真を追加」: the photo picker (as many as the system allows), then the drive's background uploads, names kept apart. */
@Composable
private fun AlbumAddPhotosButton(controller: AppController, locationId: String, folderId: String, label: String) {
    val context = LocalContext.current
    fun add(uris: List<Uri>) {
        val server = controller.activeKey ?: return
        val (userId, session) = controller.shareAccount(server) ?: return
        if (uris.isEmpty()) return
        // §9: two people's 「IMG_1234.jpg」 both stay (「IMG_1234 (1).jpg」); no question for each.
        DriveUploadCenter.addUris(context, controller.scope, uris, DriveUploadCenter.Target(server, userId, session, locationId, folderId, label, onConflict = ConflictChoice.RENAME))
    }
    val media = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { add(it) }
    OutlinedButton(onClick = { media.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) }) {
        Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(6.dp))
        Text(stringResource(R.string.album_add_photos))
    }
}

@Composable
private fun AlbumCellView(
    controller: AppController, item: DriveItemOut, selecting: Boolean, chosen: Boolean, isCover: Boolean,
    onClick: () -> Unit, onLongClick: () -> Unit,
) {
    val video = AlbumRules.isVideo(item)
    Box(
        Modifier.fillMaxWidth().aspectRatio(1f).tapAndHold(onClick = onClick, onLongClick = onLongClick)
            .semantics { contentDescription = item.name + if (chosen) " · " + L10n.str(R.string.album_cell_selected) else "" },
    ) {
        AlbumThumb(controller, cellThumbnail(item), Modifier.fillMaxSize(), icon = if (video) Icons.Outlined.PlayArrow else Icons.Outlined.Image)
        if (video) {
            Row(
                Modifier.align(Alignment.BottomStart).padding(4.dp).clip(RoundedCornerShape(4.dp)).background(Color.Black.copy(alpha = 0.55f)).padding(horizontal = 4.dp, vertical = 1.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.PlayArrow, contentDescription = null, tint = Color.White, modifier = Modifier.size(14.dp))
                formatDuration(item.file?.durationMs)?.let { Text(it, color = Color.White, style = MaterialTheme.typography.labelSmall) }
            }
        }
        if (isCover) Icon(Icons.Outlined.Star, stringResource(R.string.album_cover), tint = Color.White,
            modifier = Modifier.align(Alignment.TopStart).padding(4.dp).size(18.dp).background(Color.Black.copy(alpha = 0.4f), RoundedCornerShape(9.dp)).padding(2.dp))
        if (selecting) {
            if (chosen) Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.primary.copy(alpha = 0.25f)))
            Icon(
                if (chosen) Icons.Outlined.CheckCircle else Icons.Outlined.RadioButtonUnchecked, contentDescription = null,
                tint = if (chosen) MaterialTheme.colorScheme.primary else Color.White,
                modifier = Modifier.align(Alignment.TopEnd).padding(4.dp).size(22.dp).background(Color.Black.copy(alpha = 0.3f), RoundedCornerShape(11.dp)),
            )
        }
    }
}

// --- settings, new album, 「アルバムにする」 --------------------------------------------------------------

private fun epochDay(text: String?): Long? = text?.let { runCatching { LocalDate.parse(it.take(10)).toEpochDay() * 86_400_000L }.getOrNull() }

private fun dayOf(millis: Long?): String? = millis?.let { Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate().toString() }

/** The album's settings (§10.2 ⋯): description, order, the event's days, the cover back to the first; 「アルバムをやめる」. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AlbumSettingsDialog(
    controller: AppController, folderId: String, name: String, album: AlbumOut, onDismiss: () -> Unit, onSaved: (AlbumOut) -> Unit, onRemoved: () -> Unit,
) {
    val api = controller.albumApi ?: return
    var description by rememberSaveable { mutableStateOf(album.description) }
    var sort by rememberSaveable { mutableStateOf(album.sort) }
    var order by rememberSaveable { mutableStateOf(album.sortOrder) }
    var starts by rememberSaveable { mutableStateOf(album.startsOn) }
    var ends by rememberSaveable { mutableStateOf(album.endsOn) }
    var picking by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmRemove by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(stringResource(R.string.album_settings)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(name, style = MaterialTheme.typography.titleSmall)
                OutlinedTextField(description, { description = it }, label = { Text(stringResource(R.string.album_description)) }, minLines = 2, maxLines = 6, modifier = Modifier.fillMaxWidth())
                Text(stringResource(R.string.album_sort), style = MaterialTheme.typography.labelLarge)
                listOf("taken" to R.string.album_sort_taken, "name" to R.string.album_sort_name, "added" to R.string.album_sort_added).forEach { (key, label) ->
                    Row(Modifier.fillMaxWidth().selectable(sort == key, role = Role.RadioButton) { sort = key }, verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(sort == key, onClick = null)
                        Text(stringResource(label), modifier = Modifier.padding(start = 8.dp))
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("asc" to R.string.album_order_asc, "desc" to R.string.album_order_desc).forEach { (key, label) ->
                        Row(Modifier.selectable(order == key, role = Role.RadioButton) { order = key }, verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(order == key, onClick = null)
                            Text(stringResource(label), modifier = Modifier.padding(start = 6.dp, end = 8.dp))
                        }
                    }
                }
                Text(stringResource(R.string.album_dates), style = MaterialTheme.typography.labelLarge)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedButton(onClick = { picking = "starts" }) { Text(starts ?: stringResource(R.string.album_starts_on)) }
                    Text("〜")
                    OutlinedButton(onClick = { picking = "ends" }) { Text(ends ?: stringResource(R.string.album_ends_on)) }
                }
                if (starts != null || ends != null) TextButton(onClick = { starts = null; ends = null }) { Text(stringResource(R.string.album_dates_clear)) }
                if (album.coverItemId != null) TextButton(onClick = {
                    busy = true
                    scope.launch {
                        try { onSaved(api.putAlbum(folderId, mapOf("cover_item_id" to null))) } catch (e: CancellationException) { throw e } catch (e: Exception) { error = describeDriveError(e) } finally { busy = false }
                    }
                }) { Text(stringResource(R.string.album_cover_reset)) }
                HorizontalDivider()
                TextButton(onClick = { confirmRemove = true }) { Text(stringResource(R.string.album_remove), color = MaterialTheme.colorScheme.error) }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy, onClick = {
                busy = true
                scope.launch {
                    try {
                        onSaved(api.putAlbum(folderId, mapOf(
                            "description" to description.trim(), "sort" to sort, "sort_order" to order, "starts_on" to starts, "ends_on" to ends,
                        )))
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        error = describeDriveError(e)
                    } finally {
                        busy = false
                    }
                }
            }) { Text(stringResource(R.string.common_save)) }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
    picking?.let { which ->
        val state = rememberDatePickerState(initialSelectedDateMillis = epochDay(if (which == "starts") starts else ends ?: starts))
        DatePickerDialog(
            onDismissRequest = { picking = null },
            confirmButton = {
                TextButton(onClick = {
                    val day = dayOf(state.selectedDateMillis)
                    if (which == "starts") { starts = day; if (ends != null && day != null && ends!! < day) ends = day } else ends = day
                    picking = null
                }) { Text(stringResource(R.string.common_done)) }
            },
            dismissButton = { TextButton(onClick = { picking = null }) { Text(stringResource(R.string.common_cancel)) } },
        ) { DatePicker(state) }
    }
    if (confirmRemove) AlertDialog(
        onDismissRequest = { confirmRemove = false },
        title = { Text(stringResource(R.string.album_remove)) },
        text = { Text(stringResource(R.string.album_remove_note)) },
        confirmButton = {
            TextButton(onClick = {
                confirmRemove = false
                busy = true
                scope.launch {
                    try { api.deleteAlbum(folderId); onRemoved() } catch (e: CancellationException) { throw e } catch (e: Exception) { error = describeDriveError(e) } finally { busy = false }
                }
            }) { Text(stringResource(R.string.album_remove_confirm), color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = { confirmRemove = false }) { Text(stringResource(R.string.common_cancel)) } },
    )
}

/**
 * 「新しいアルバム」: POST /drive/albums in [parentId] or in [locationId]'s 「アルバム」 folder (§17 Q2); the same dialog sent
 * again keeps its client_op_id (one album). [initialName]: 「#学会 2026-09-16」 from a post.
 */
@Composable
internal fun NewAlbumDialog(
    controller: AppController, parentId: String?, locationId: String?, initialName: String = "", onDismiss: () -> Unit, onMade: (AlbumCreatedOut) -> Unit,
) {
    var name by rememberSaveable { mutableStateOf(initialName) }
    var description by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val opId = rememberSaveable { UUID.randomUUID().toString() }
    var sentName by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(stringResource(R.string.album_new)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it; error = null }, singleLine = true, label = { Text(stringResource(R.string.album_name)) })
                OutlinedTextField(description, { description = it }, minLines = 2, maxLines = 4, label = { Text(stringResource(R.string.album_description)) })
                if (parentId == null) Text(stringResource(R.string.album_new_where), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            TextButton(enabled = name.isNotBlank() && !busy, onClick = {
                val api = controller.albumApi ?: return@TextButton
                busy = true
                scope.launch {
                    try {
                        val key = if (sentName == null || sentName == name.trim()) opId else UUID.randomUUID().toString()
                        sentName = name.trim()
                        onMade(api.createAlbum(parentId, locationId, name.trim(), description.trim(), key))
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        error = describeDriveError(e)
                    } finally {
                        busy = false
                    }
                }
            }) { Text(stringResource(R.string.drive_new_folder_create)) }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}

/** 「アルバムにする」 on a plain folder (PUT with nothing: the defaults). */
internal suspend fun makeAlbum(controller: AppController, folder: DriveItemOut): Boolean {
    val api = controller.albumApi ?: return false
    return try {
        api.putAlbum(folder.id, emptyMap())
        controller.drive?.applyChanged(listOfNotNull(folder.id, folder.parentId), null)
        controller.notice = L10n.str(R.string.album_made)
        true
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        controller.error = describeDriveError(e)
        false
    }
}

// --- 「この投稿の写真をアルバムに」 (§9) ------------------------------------------------------------------

/**
 * The long-press sheet's 「アルバムに追加」: the albums (the conversation's channel drive first), or 「新しいアルバム」 in
 * that channel's drive (a DM: マイドライブ) named after the channel and the day; then POST …/add with the message's
 * photos and videos (a posted file in the same channel drive moves, anything else is copied).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddToAlbumSheet(controller: AppController, message: jp.chikuwachat.android.sync.MessageState, onDismiss: () -> Unit) {
    val api = controller.albumApi ?: return
    val hub = controller.drive ?: return
    val media = remember(message) { AlbumRules.postMedia(message.attachments) }
    val channel = controller.store.channel(message.channelId)?.channel
    val isChannel = channel?.type == "public" || channel?.type == "private"
    val loader = remember { AlbumListLoader(api, null, ::describeDriveError) }
    val state by loader.state.collectAsState()
    hub.version.collectAsState().value
    var target by remember { mutableStateOf<String?>(null) } // the location 「新しいアルバム」 goes to
    var creating by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val opId = remember { UUID.randomUUID().toString() }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) {
        loader.reload()
        if (hub.locations == null) hub.loadLocations()
        target = try {
            if (isChannel) hub.channelLocation(message.channelId).id
            else hub.locations?.firstOrNull { it.kind == "user" }?.id ?: controller.driveApi?.resolveDriveLocation(null)?.id
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
    }
    fun add(folderId: String) {
        busy = true
        scope.launch {
            try {
                val out = api.addToAlbum(folderId, media.map { it.id }, emptyList(), "auto", opId)
                hub.applyChanged(listOf(folderId), null)
                if (out.results.all { it.ok }) controller.notice = AlbumRules.addSummary(out.results) else controller.error = AlbumRules.addSummary(out.results)
                onDismiss()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                controller.error = describeDriveError(e)
            } finally {
                busy = false
            }
        }
    }
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = { if (!busy) onDismiss() }, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 12.dp)) {
            Text(L10n.plural(R.plurals.album_add_title, media.size, media.size), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(horizontal = 20.dp))
            Row(
                Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(enabled = !busy && target != null) { creating = true }.padding(horizontal = 20.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Box(Modifier.size(44.dp).clip(RoundedCornerShape(8.dp)).border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.Add, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(stringResource(R.string.album_new), style = MaterialTheme.typography.bodyLarge)
            }
            HorizontalDivider()
            val preferred = target.takeIf { isChannel }
            val entries = AlbumRules.pickerOrder(state.entries, preferred)
                .filter { hub.location(it.folder.locationId)?.canWrite != false } // only where I may add
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                when {
                    !state.loaded -> Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
                    state.error != null && entries.isEmpty() -> DriveNote(state.error!!) { scope.launch { loader.reload() } }
                    entries.isEmpty() -> Text(stringResource(R.string.album_none_yet), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(20.dp))
                }
                entries.forEach { entry ->
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 60.dp).clickable(enabled = !busy) { add(entry.folder.id) }.padding(horizontal = 20.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        AlbumThumb(controller, entry.album.cover?.attachmentId, Modifier.size(44.dp).clip(RoundedCornerShape(8.dp)), icon = Icons.Outlined.PhotoLibrary)
                        Column(Modifier.weight(1f)) {
                            Text(entry.folder.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                listOf(DriveNames.pathLine(entry.path, entry.locationKind, hub.systemFolders), AlbumRules.countLine(entry.album)).filter { it.isNotEmpty() }.joinToString(" · "),
                                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
                if (state.nextCursor != null) TextButton(onClick = { scope.launch { loader.loadMore() } }, modifier = Modifier.padding(horizontal = 12.dp)) { Text(stringResource(R.string.drive_show_more)) }
            }
        }
    }
    if (creating) target?.let { location ->
        NewAlbumDialog(
            controller, parentId = null, locationId = location,
            initialName = AlbumRules.postAlbumName(channel?.name?.takeIf { isChannel }, message.createdAt),
            onDismiss = { creating = false },
            onMade = { made -> creating = false; add(made.folder.id) },
        )
    }
}

// --- the /d/ card of an album (§10.4) ---------------------------------------------------------------------

/** 4 pictures (2 × 2), the title, 「312 枚 · 2026/9/16〜9/19」 and where it is; a tap opens the album. */
@Composable
internal fun AlbumLinkCard(controller: AppController, detail: DriveItemDetailOut, album: AlbumOut, onOpen: () -> Unit) {
    val shape = RoundedCornerShape(12.dp)
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        Modifier.padding(vertical = 4.dp).widthIn(max = 420.dp).fillMaxWidth().clip(shape).border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .clickable(onClickLabel = stringResource(R.string.drive_open)) { onOpen() }.padding(8.dp)
            .semantics { contentDescription = L10n.str(R.string.album_card_named, detail.item.name) },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        val pictures = AlbumRules.previews(album)
        Column(Modifier.size(88.dp).clip(RoundedCornerShape(8.dp)), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            for (row in 0 until 2) Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                for (column in 0 until 2) {
                    val id = pictures.getOrNull(row * 2 + column)
                    AlbumThumb(controller, id, Modifier.weight(1f).aspectRatio(1f), icon = Icons.Outlined.Image)
                }
            }
        }
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Icons.Outlined.PhotoLibrary, contentDescription = null, tint = muted, modifier = Modifier.size(16.dp))
                Text(detail.item.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Text(AlbumRules.cardLine(album), style = MaterialTheme.typography.labelSmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val where = DriveNames.pathLine(detail.path, detail.locationKind)
            if (where.isNotEmpty()) Text(where, style = MaterialTheme.typography.labelSmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
