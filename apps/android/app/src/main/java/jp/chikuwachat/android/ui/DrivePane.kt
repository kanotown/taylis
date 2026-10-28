package jp.chikuwachat.android.ui

import android.graphics.BitmapFactory
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.annotation.StringRes
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.FolderShared
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.Slideshow
import androidx.compose.material.icons.automirrored.outlined.Sort
import androidx.compose.material.icons.outlined.TableChart
import androidx.compose.material.icons.outlined.Tag
import androidx.compose.material.icons.automirrored.outlined.TextSnippet
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.DriveItemOut
import jp.chikuwachat.android.api.DriveLocationOut
import jp.chikuwachat.android.api.DriveSearchHitOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.ChannelFiles
import jp.chikuwachat.android.sync.DriveFolderLoader
import jp.chikuwachat.android.sync.DriveLinkState
import jp.chikuwachat.android.sync.DriveListing
import jp.chikuwachat.android.sync.DriveNames
import jp.chikuwachat.android.sync.DriveSearchLoader
import jp.chikuwachat.android.sync.DriveSort
import jp.chikuwachat.android.sync.describeDriveError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/*
 * M166 (docs/DRIVE.md §17.6, §26, the phones' D7): 「ドライブ」 on Android, read only — the locations, a folder (breadcrumbs,
 * sort, pull to refresh, 100 rows a page), the file-name search of a location, the details sheet, the app's viewers, and
 * downloads streamed to disk (共有 / ほかのアプリで開く / ダウンロードに保存; a folder as a ZIP). No upload, rename, move,
 * trash or share links here (§17.6: later). Plain rows, no coloured side bars (an icon or a thumbnail marks the kind).
 */

/** Whether the server has the drive (GET /drive/locations answered): the home tile and the channels' tab follow it. */
@Composable
fun driveAvailable(controller: AppController): Boolean {
    val hub = controller.drive ?: return false
    hub.version.collectAsState().value
    return hub.available == true
}

/** The app bar's title of a drive page: 「ドライブ」, a location's name, or the folder's. */
@Composable
fun DriveBarTitle(controller: AppController, route: Route.Drive) {
    val hub = controller.drive
    hub?.version?.collectAsState()?.value
    val location = route.locationId?.let { hub?.location(it) }
    val title = when {
        route.locationId == null -> stringResource(R.string.drive_title)
        location != null && route.folderId == location.rootId -> DriveNames.locationName(location)
        else -> route.folderId?.let { hub?.folderName(it) } ?: location?.let { DriveNames.locationName(it) } ?: stringResource(R.string.drive_title)
    }
    Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** The home's 「ドライブ」: the list of locations, or one folder ([Route.Drive]). */
@Composable
fun DrivePane(
    controller: AppController, route: Route.Drive,
    onOpenFolder: (locationId: String, folderId: String, itemId: String?) -> Unit,
    onCrumb: (locationId: String, folderId: String) -> Unit,
    onGone: (locationId: String, rootId: String?) -> Unit,
) {
    val locationId = route.locationId
    val folderId = route.folderId
    if (locationId == null || folderId == null) {
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f)) { DriveLocations(controller) { location -> onOpenFolder(location.id, location.rootId, null) } }
            DriveUploadsBar(controller)
        }
    } else {
        androidx.compose.runtime.key(folderId) {
            DriveFolder(controller, locationId, folderId, route.itemId, onOpenFolder, onCrumb, onGone)
        }
    }
}

/** M166 (DRIVE.md §13.3): the channel's 「ドライブ」 tab — its drive's root (made when it has none yet); a folder opens over it. */
@Composable
fun ChannelDriveTab(controller: AppController, channel: ChannelState, onOpenFolder: (locationId: String, folderId: String, itemId: String?) -> Unit) {
    val hub = controller.drive ?: return
    var location by remember(channel.id) { mutableStateOf<DriveLocationOut?>(null) }
    var error by remember(channel.id) { mutableStateOf<String?>(null) }
    var attempt by remember(channel.id) { mutableIntStateOf(0) }
    LaunchedEffect(channel.id, attempt) {
        error = null
        try {
            location = hub.channelLocation(channel.id)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = describeDriveError(e)
        }
    }
    val held = location
    when {
        held != null -> androidx.compose.runtime.key(held.rootId) {
            DriveFolder(controller, held.id, held.rootId, null, onOpenFolder, onCrumb = { _, _ -> }, onGone = { _, _ -> attempt += 1 }, inTab = true)
        }
        error != null -> DriveMessage(error!!, retry = { attempt += 1 })
        else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
    }
}

@Composable
private fun DriveLocations(controller: AppController, onOpen: (DriveLocationOut) -> Unit) {
    val hub = controller.drive ?: return
    hub.version.collectAsState().value
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    // マイドライブ is made when first opened (§3.1): asked here, not for a guest.
    LaunchedEffect(hub) { hub.loadLocations(withMine = true) }
    val locations = hub.locations
    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = { refreshing = true; scope.launch { try { hub.loadLocations(withMine = true) } finally { refreshing = false } } },
        modifier = Modifier.fillMaxSize(),
    ) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 4.dp)) {
            when {
                locations == null && hub.locationsError != null -> item { DriveMessage(hub.locationsError!!, retry = { scope.launch { hub.loadLocations(withMine = true) } }) }
                locations == null -> item { Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
                locations.isEmpty() -> item { DriveMessage(stringResource(R.string.drive_no_locations)) }
                else -> {
                    val (own, channels) = locations.partition { it.kind != "channel" }
                    items(own, key = { it.id }) { LocationRow(it) { onOpen(it) } }
                    if (channels.isNotEmpty()) {
                        item(key = "channels") {
                            Text(stringResource(R.string.drive_channels), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp))
                        }
                        items(channels, key = { it.id }) { LocationRow(it) { onOpen(it) } }
                    }
                }
            }
        }
    }
}

@Composable
private fun LocationRow(location: DriveLocationOut, onClick: () -> Unit) {
    val icon = when (location.kind) { "workspace" -> Icons.Outlined.FolderShared; "user" -> Icons.Outlined.Person; else -> Icons.Outlined.Tag }
    val used = DriveNames.bytes(location.usedBytes)
    val usage = location.quotaBytes?.let { L10n.str(R.string.drive_usage_of, used, DriveNames.bytes(it)) } ?: used
    Row(
        Modifier.fillMaxWidth().heightIn(min = 64.dp).combinedClickableCompat(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        DriveBadge(icon)
        Column(Modifier.weight(1f)) {
            Text(DriveNames.locationName(location), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                L10n.str(R.string.drive_location_line, usage, location.itemCount) + if (!location.canWrite) " · " + L10n.str(R.string.drive_read_only_short) else "",
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** A plain square with the kind's icon (an even tint and a thin outline: no coloured side bar). */
@Composable
private fun DriveBadge(icon: ImageVector, size: Dp = 40.dp) {
    Box(
        Modifier.size(size).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f))
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(8.dp)),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(size / 2)) }
}

internal fun driveIcon(item: DriveItemOut): ImageVector = when (DriveNames.icon(item)) {
    DriveNames.Icon.FOLDER -> Icons.Outlined.Folder
    DriveNames.Icon.CHANNEL_POSTS -> Icons.Outlined.Forum // CF1 §3.3: 「投稿のファイル」 (speech bubbles: the posts)
    DriveNames.Icon.IMAGE -> Icons.Outlined.Image
    DriveNames.Icon.VIDEO -> Icons.Outlined.Movie
    DriveNames.Icon.PDF -> Icons.Outlined.PictureAsPdf
    DriveNames.Icon.DOCUMENT -> Icons.Outlined.Description
    DriveNames.Icon.SHEET -> Icons.Outlined.TableChart
    DriveNames.Icon.SLIDES -> Icons.Outlined.Slideshow
    DriveNames.Icon.ARCHIVE -> Icons.Outlined.Archive
    DriveNames.Icon.TEXT -> Icons.AutoMirrored.Outlined.TextSnippet
    DriveNames.Icon.FILE -> Icons.AutoMirrored.Outlined.InsertDriveFile
}

/** The thumbnails read this session (a few dozen small JPEG / WebP), so scrolling back does not read them again. */
private object DriveThumbs {
    private val held = object : LinkedHashMap<String, ImageBitmap>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ImageBitmap>?): Boolean = size > 120
    }

    fun peek(path: String): ImageBitmap? = synchronized(held) { held[path] }

    suspend fun load(controller: AppController, path: String): ImageBitmap? {
        peek(path)?.let { return it }
        return try {
            val bytes = controller.fetchBytes(path)
            withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }?.also { synchronized(held) { held[path] = it } }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
    }
}

/** A row's or a card's picture: the thumbnail (photo, video poster, document's first page) or the kind's icon. */
@Composable
internal fun DriveThumb(controller: AppController, item: DriveItemOut, size: Dp = 40.dp) {
    val path = DriveNames.thumbnailPath(item)
    var image by remember(path) { mutableStateOf(path?.let { DriveThumbs.peek(it) }) }
    if (path != null && image == null) LaunchedEffect(path) { image = DriveThumbs.load(controller, path) }
    val picture = image
    if (picture != null) {
        Image(picture, contentDescription = null, contentScale = ContentScale.Crop,
            modifier = Modifier.size(size).clip(RoundedCornerShape(8.dp)).border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(8.dp)))
    } else DriveBadge(driveIcon(item), size)
}

@Composable
private fun DriveFolder(
    controller: AppController, locationId: String, folderId: String, itemId: String?,
    onOpenFolder: (locationId: String, folderId: String, itemId: String?) -> Unit,
    onCrumb: (locationId: String, folderId: String) -> Unit,
    onGone: (locationId: String, rootId: String?) -> Unit,
    inTab: Boolean = false,
) {
    val hub = controller.drive ?: return
    val api = controller.driveApi ?: return
    hub.version.collectAsState().value
    val loader = remember(folderId) { DriveFolderLoader(api, folderId, ::describeDriveError) }
    val state by loader.state.collectAsState()
    val searcher = remember(locationId) { DriveSearchLoader(api, locationId, ::describeDriveError) }
    val search by searcher.state.collectAsState()
    var query by rememberSaveable(folderId) { mutableStateOf("") }
    var includePosted by rememberSaveable(locationId) { mutableStateOf(true) }
    searcher.origin = ChannelFiles.origin(includePosted)
    var details by remember { mutableStateOf<DriveItemOut?>(null) }
    var viewing by remember { mutableStateOf<DriveItemOut?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    val location = hub.location(locationId)
    // Read on opening, again when drive.changed names this folder (300 ms folded) or the connection comes back (§14).
    val epoch = hub.folderEpoch(folderId)
    LaunchedEffect(folderId, epoch) { loader.reload() }
    LaunchedEffect(state.folder?.name) { state.folder?.let { hub.noteItems(listOf(it)); hub.noteFolder(it.id, DriveNames.displayName(it)) } }
    LaunchedEffect(state.items) { hub.noteItems(state.items) } // CF1: 「投稿のファイル」 in the crumbs below it
    // Not there for me any more (404): the location's root, then the list (§14).
    LaunchedEffect(state.gone) {
        if (state.gone) {
            hub.reloadLocations()
            onGone(locationId, location?.rootId)
        }
    }
    // A /d/ link to a file: its details over its folder (§26).
    LaunchedEffect(itemId) {
        val id = itemId ?: return@LaunchedEffect
        (hub.link(id) as? DriveLinkState.Ok)?.let { details = it.detail.item }
    }
    LaunchedEffect(query) {
        delay(300)
        searcher.search(query)
    }
    // 100 more rows as the list nears its end.
    LaunchedEffect(listState, loader) {
        snapshotFlow { listState.layoutInfo.let { info -> (info.visibleItemsInfo.lastOrNull()?.index ?: 0) >= info.totalItemsCount - 5 } }
            .distinctUntilChanged()
            .collect { near -> if (near && query.isBlank()) loader.loadMore() }
    }
    val kind = location?.kind
    val crumbs = DriveNames.crumbs(state.path, kind, hub.systemFolders)
    fun open(item: DriveItemOut) {
        if (item.isFolder) onOpenFolder(item.locationId.ifEmpty { locationId }, item.id, null)
        else if (DriveNames.viewer(item) != null) viewing = item
        else details = item
    }
    Column(Modifier.fillMaxSize()) {
        if (crumbs.size > 1 || !inTab) DriveCrumbs(crumbs, onCrumb = { onCrumb(locationId, it) })
        DriveToolbar(
            query = query, onQuery = { query = it },
            placeholder = location?.let { L10n.str(R.string.drive_search_in, DriveNames.locationName(it)) } ?: L10n.str(R.string.drive_search),
            sort = state.sort, order = state.order,
            onSort = { sort -> val (s, o) = DriveListing.choose(state, sort); scope.launch { loader.reload(s, o); listState.scrollToItem(0) } },
            extra = {
                // DRIVE.md §6: uploads and 「新しいフォルダ」 only where the location can be written (read only: none).
                if (location?.canWrite == true) DriveUploadButton(controller, locationId, folderId, DriveNames.pathLine(state.path, kind, hub.systemFolders)) {
                    scope.launch { loader.reload() }
                }
            },
        )
        if (location != null && !location.canWrite) {
            Text(stringResource(R.string.drive_read_only), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp))
        }
        // CF1 (CHANNEL_FILES.md §12.6): while searching, 「投稿のファイルを含む」 (on: `origin=all`, off: `uploads`).
        if (query.isNotBlank()) {
            FilterChip(
                selected = includePosted,
                onClick = {
                    includePosted = !includePosted
                    searcher.origin = ChannelFiles.origin(includePosted)
                    scope.launch { searcher.search(query) }
                },
                label = { Text(stringResource(R.string.channel_files_search_include)) },
                leadingIcon = if (includePosted) ({ Icon(Icons.Outlined.Check, contentDescription = null, modifier = Modifier.size(16.dp)) }) else null,
                modifier = Modifier.padding(horizontal = 12.dp),
            )
        }
        HorizontalDivider()
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { refreshing = true; scope.launch { try { if (query.isBlank()) loader.reload() else searcher.search(query) } finally { refreshing = false } } },
            modifier = Modifier.weight(1f).fillMaxWidth(),
        ) {
            if (query.isNotBlank()) {
                LazyColumn(Modifier.fillMaxSize()) {
                    when {
                        search.hits.isEmpty() && search.loading -> item { Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
                        search.hits.isEmpty() && search.error != null -> item { DriveMessage(search.error!!, retry = { scope.launch { searcher.search(query) } }) }
                        search.hits.isEmpty() && search.query.isNotEmpty() -> item { DriveMessage(L10n.str(R.string.drive_no_results, search.query)) }
                    }
                    items(search.hits, key = { "hit:" + it.item.id }) { hit ->
                        DriveRow(controller, hit.item, subtitle = DriveNames.pathLine(hit.path, hit.locationKind, hub.systemFolders), onClick = { open(hit.item) }, onDetails = { details = hit.item })
                        // §29: the words around a match inside the file, under the name (past the picture).
                        val inside = stringResource(R.string.drive_search_inside)
                        val page = hit.page?.let { stringResource(drivePageLabel(hit), it) }
                        driveSnippet(hit, inside, page, MaterialTheme.colorScheme.onSurfaceVariant)?.let { snippet ->
                            Text(
                                snippet, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.fillMaxWidth().combinedClickableCompat(onClick = { open(hit.item) }).padding(start = 68.dp, end = 16.dp, bottom = 8.dp),
                            )
                        }
                    }
                    if (search.nextCursor != null) item(key = "more") { MoreRow(search.loading) { scope.launch { searcher.loadMore() } } }
                }
            } else {
                LazyColumn(Modifier.fillMaxSize(), state = listState) {
                    when {
                        state.items.isEmpty() && state.loading -> item { Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
                        state.items.isEmpty() && state.error != null -> item { DriveMessage(state.error!!, retry = { scope.launch { loader.reload() } }) }
                        state.items.isEmpty() && state.folder != null -> item { DriveMessage(stringResource(R.string.drive_empty_folder)) }
                    }
                    items(state.items, key = { it.id }) { item -> DriveRow(controller, item, subtitle = null, onClick = { open(item) }, onDetails = { details = item }) }
                    if (state.nextCursor != null || state.loadingMore) item(key = "more") { MoreRow(state.loadingMore) { scope.launch { loader.loadMore() } } }
                    if (state.items.isNotEmpty() && state.error != null && !state.loading) item(key = "error") { DriveMessage(state.error!!, retry = { scope.launch { loader.reload() } }) }
                }
            }
        }
        DriveUploadsBar(controller) // DRIVE.md §6: the account's uploads (a tap opens the sheet)
    }
    details?.let { item ->
        DriveDetailsSheet(controller, item, kind = kind, onDismiss = { details = null }, onPreview = { details = null; viewing = item },
            onOpenFolder = { details = null; onOpenFolder(item.locationId.ifEmpty { locationId }, item.id, null) })
    }
    viewing?.let { item -> DriveViewer(controller, item, onDismiss = { viewing = null }) }
}

@Composable
private fun DriveCrumbs(crumbs: List<jp.chikuwachat.android.api.DriveCrumb>, onCrumb: (String) -> Unit) {
    if (crumbs.isEmpty()) return
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp).semantics { contentDescription = L10n.str(R.string.drive_breadcrumbs) },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        crumbs.forEachIndexed { index, crumb ->
            if (index > 0) Text("›", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 2.dp))
            val last = index == crumbs.lastIndex
            TextButton(onClick = { onCrumb(crumb.id) }, enabled = !last, contentPadding = PaddingValues(horizontal = 6.dp)) {
                Text(crumb.name, maxLines = 1, style = MaterialTheme.typography.labelLarge, fontWeight = if (last) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (last) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.primary)
            }
        }
    }
}

@Composable
private fun DriveToolbar(
    query: String, onQuery: (String) -> Unit, placeholder: String, sort: DriveSort, order: String, onSort: (DriveSort) -> Unit,
    extra: @Composable () -> Unit = {},
) {
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = query, onValueChange = onQuery, singleLine = true, modifier = Modifier.weight(1f),
            placeholder = { Text(placeholder, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
            trailingIcon = if (query.isEmpty()) null else ({ IconButton(onClick = { onQuery("") }) { Icon(Icons.Outlined.Close, stringResource(R.string.drive_clear_search)) } }),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = {}),
            textStyle = MaterialTheme.typography.bodyMedium,
        )
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.AutoMirrored.Outlined.Sort, L10n.str(R.string.drive_sort_by, sort.label)) }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DriveSort.entries.forEach { entry ->
                    val chosen = entry == sort
                    DropdownMenuItem(
                        text = { Text(entry.label + if (chosen) (if (order == "asc") " ↑" else " ↓") else "") },
                        leadingIcon = { if (chosen) Icon(Icons.Outlined.Check, contentDescription = null) else Spacer(Modifier.size(24.dp)) },
                        onClick = { menu = false; onSort(entry) },
                    )
                }
            }
        }
        extra()
    }
}

@Composable
private fun DriveRow(controller: AppController, item: DriveItemOut, subtitle: String?, onClick: () -> Unit, onDetails: () -> Unit) {
    val time = Timeline.fullLabel(DriveNames.itemTime(item))
    val line = subtitle ?: if (item.isFolder) time else listOf(time, DriveNames.bytes(item.sizeBytes)).filter { it.isNotEmpty() }.joinToString(" · ")
    Row(
        Modifier.fillMaxWidth().heightIn(min = 60.dp).combinedClickableCompat(onClick = onClick, onLongClick = onDetails).padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        DriveThumb(controller, item)
        Column(Modifier.weight(1f)) {
            FileNameText(DriveNames.displayName(item))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                // CF1 (CHANNEL_FILES.md §12.2): a small speech bubble on a file attached to a message.
                if (item.posted) Icon(Icons.Outlined.ChatBubbleOutline, stringResource(R.string.channel_files_posted_marker), tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(12.dp))
                Text(line, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        IconButton(onClick = onDetails) { Icon(Icons.Outlined.Info, L10n.str(R.string.drive_details_of, DriveNames.displayName(item)), tint = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@OptIn(ExperimentalFoundationApi::class)
private fun Modifier.combinedClickableCompat(onClick: () -> Unit, onLongClick: (() -> Unit)? = null): Modifier =
    combinedClickable(role = Role.Button, onClick = onClick, onLongClick = onLongClick)

/**
 * §29.6: the string for a hit's `page`: 「12 枚目」 for a slide, 「シート 2」 for a sheet, else 「3 ページ目」 (a PDF page; an
 * older server sends no `page_kind`).
 */
@StringRes
internal fun drivePageLabel(hit: DriveSearchHitOut): Int = when (hit.pageKind) {
    "slide" -> R.string.drive_search_slide
    "sheet" -> R.string.drive_search_sheet
    else -> R.string.drive_search_page
}

/**
 * docs/DRIVE.md §29: a drive search hit's snippet — 「中身 · 2 ページ目」 dimmed, then the server's plain text pieces with
 * the found words marked like the message search; null for a name match (or an older server).
 */
internal fun driveSnippet(hit: DriveSearchHitOut, inside: String, page: String?, dim: Color = Color.Gray): AnnotatedString? {
    val parts = hit.snippet?.takeIf { it.isNotEmpty() } ?: return null
    return buildAnnotatedString {
        withStyle(SpanStyle(color = dim)) { append(listOfNotNull(inside, page).joinToString(" · ") + "  ") }
        for (part in parts) {
            if (part.hit) withStyle(SEARCH_HIT) { append(part.text) } else append(part.text)
        }
    }
}

@Composable
private fun MoreRow(loading: Boolean, onClick: () -> Unit) {
    Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) {
        if (loading) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
        else TextButton(onClick = onClick) { Text(stringResource(R.string.drive_show_more)) }
    }
}

@Composable
private fun DriveMessage(text: String, retry: (() -> Unit)? = null) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (retry != null) TextButton(onClick = retry) { Text(stringResource(R.string.common_retry)) }
    }
}

/** The details (§17.2's right pane, as a sheet) and what a phone may do with the item (§17.6: read only). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DriveDetailsSheet(
    controller: AppController, item: DriveItemOut, kind: String?, onDismiss: () -> Unit, onPreview: () -> Unit, onOpenFolder: () -> Unit,
) {
    val users = controller.store.users
    var path by remember(item.id) { mutableStateOf<String?>(null) }
    // CF1 (CHANNEL_FILES.md §12.2): the messages showing the file (GET /drive/items/{id} only), 「メッセージを表示」 each.
    var posts by remember(item.id) { mutableStateOf<List<jp.chikuwachat.android.api.DrivePostOut>>(emptyList()) }
    LaunchedEffect(item.id) {
        (controller.drive?.link(item.id) as? DriveLinkState.Ok)?.let {
            path = DriveNames.pathLine(it.detail.path, it.detail.locationKind ?: kind, controller.drive?.systemFolders ?: emptySet())
            posts = it.detail.item.posts.orEmpty()
        }
    }
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 12.dp)) {
            Row(Modifier.padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                DriveThumb(controller, item, size = 48.dp)
                FileNameText(DriveNames.displayName(item), Modifier.weight(1f))
            }
            if (posts.isNotEmpty()) {
                HorizontalDivider()
                Text(stringResource(R.string.channel_files_posts), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 20.dp, top = 8.dp))
                posts.forEach { post ->
                    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            ChannelFiles.postLine(post, post.senderId?.let { users[it]?.displayName }, controller.store.channel(post.channelId)?.channel?.name, Timeline.fullLabel(post.postedAt)),
                            style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis,
                        )
                        TextButton(onClick = {
                            onDismiss()
                            controller.scope.launch { controller.openPermalink(post.messageId) }
                        }) { Text(stringResource(R.string.channel_files_show_message)) }
                    }
                }
            }
            HorizontalDivider()
            fun who(id: String?): String = id?.let { users[it]?.displayName } ?: L10n.str(R.string.drive_someone)
            val rows = buildList {
                add(L10n.str(R.string.drive_detail_kind) to if (item.isFolder) L10n.str(R.string.drive_folder) else item.contentType.orEmpty())
                if (!item.isFolder) add(L10n.str(R.string.drive_column_size) to DriveNames.bytes(item.sizeBytes))
                add(L10n.str(R.string.drive_column_modified) to Timeline.fullLabel(DriveNames.itemTime(item)))
                add(L10n.str(R.string.drive_detail_created_by) to who(item.createdBy) + " · " + Timeline.fullLabel(item.createdAt))
                add(L10n.str(R.string.drive_column_by) to who(item.updatedBy) + " · " + Timeline.fullLabel(item.updatedAt))
                if (!item.isFolder) add(L10n.str(R.string.drive_detail_versions) to L10n.str(R.string.drive_versions_count, item.versionCount))
                path?.let { add(L10n.str(R.string.drive_detail_where) to it) }
            }
            rows.forEach { (label, value) ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp)) {
                    Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(96.dp))
                    Text(value, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                }
            }
            HorizontalDivider(Modifier.padding(top = 6.dp))
            @Composable
            fun Action(icon: ImageVector, label: String, onClick: () -> Unit) {
                Row(
                    Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).combinedClickableCompat(onClick = onClick).padding(horizontal = 20.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(label, style = MaterialTheme.typography.bodyLarge)
                }
            }
            if (item.isFolder) {
                Action(Icons.Outlined.Folder, stringResource(R.string.drive_open), onOpenFolder)
                Action(Icons.Outlined.Share, stringResource(R.string.drive_share_zip)) { onDismiss(); controller.downloadDrive(item, AppController.DriveAction.SHARE) }
                Action(Icons.Outlined.Download, stringResource(R.string.drive_save_zip)) { onDismiss(); controller.downloadDrive(item, AppController.DriveAction.SAVE) }
            } else {
                if (DriveNames.viewer(item) != null) Action(Icons.Outlined.Visibility, stringResource(R.string.drive_preview), onPreview)
                Action(Icons.Outlined.Share, stringResource(R.string.drive_share)) { onDismiss(); controller.downloadDrive(item, AppController.DriveAction.SHARE) }
                Action(Icons.AutoMirrored.Outlined.OpenInNew, stringResource(R.string.common_open_in_another_app)) { onDismiss(); controller.downloadDrive(item, AppController.DriveAction.OPEN) }
                Action(Icons.Outlined.Download, stringResource(R.string.drive_save_to_downloads)) { onDismiss(); controller.downloadDrive(item, AppController.DriveAction.SAVE) }
            }
        }
    }
}

/**
 * A drive file in the app's viewers (§8): a photo, a video (streamed from its download ticket, §21.2: Range, so seeking
 * reads only what it shows) or a document's PDF preview; their 「ほかのアプリで開く」 streams the file to disk first.
 */
@Composable
fun DriveViewer(controller: AppController, item: DriveItemOut, onDismiss: () -> Unit) {
    val attachment = remember(item) { DriveNames.asAttachment(item) } ?: return
    val elsewhere = { controller.downloadDrive(item, AppController.DriveAction.OPEN) }
    when (DriveNames.viewer(item)) {
        DriveNames.Viewer.IMAGE -> ImageViewer(attachment, controller, onDismiss, onOpenElsewhere = elsewhere)
        DriveNames.Viewer.VIDEO -> VideoViewer(attachment, controller, null, onDismiss, stream = { controller.driveStreamUrl(item.id) }, onOpenElsewhere = elsewhere)
        DriveNames.Viewer.DOCUMENT -> DriveDocumentViewer(controller, item, onDismiss, onOpenElsewhere = elsewhere) // §27.3
        null -> LaunchedEffect(item.id) { onDismiss() }
    }
}

/** The download on screen (§26): the name, how far, 「キャンセル」; then the share sheet, another app or Downloads. */
@Composable
fun DriveTransferDialog(controller: AppController) {
    val transfer = controller.driveTransfer ?: return
    // Android 8–9: no MediaStore.Downloads; the finished file goes where the system's dialog says.
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(if (transfer.zip) "application/zip" else "*/*")) { uri ->
        controller.finishDriveSave(transfer, uri)
    }
    val pending = transfer.savePending
    LaunchedEffect(pending) { if (pending != null && Build.VERSION.SDK_INT < 29) pick.launch(transfer.name) }
    val total = transfer.total
    val error = transfer.error
    AlertDialog(
        onDismissRequest = {},
        title = { Text(if (error != null) stringResource(R.string.drive_download_failed) else if (transfer.zip) stringResource(R.string.drive_zip_preparing) else stringResource(R.string.drive_downloading)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                FileNameText(transfer.name)
                if (error != null) Text(error, style = MaterialTheme.typography.bodyMedium)
                else {
                    if (total != null && total > 0) LinearProgressIndicator(progress = { (transfer.received.toFloat() / total).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                    else LinearProgressIndicator(Modifier.fillMaxWidth())
                    Text(
                        if (total != null && total > 0) L10n.str(R.string.drive_progress, DriveNames.bytes(transfer.received), DriveNames.bytes(total)) else DriveNames.bytes(transfer.received),
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { controller.cancelDriveTransfer() }) { Text(if (error != null) stringResource(R.string.common_close) else stringResource(R.string.drive_cancel)) }
        },
        icon = { Icon(if (error != null) Icons.Outlined.WarningAmber else Icons.Outlined.Download, contentDescription = null) },
    )
}
