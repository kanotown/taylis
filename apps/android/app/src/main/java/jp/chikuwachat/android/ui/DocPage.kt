package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.PageCrumb
import jp.chikuwachat.android.api.PageItem
import jp.chikuwachat.android.api.PageOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.CanvasSaveStatus
import jp.chikuwachat.android.sync.CanvasSaver
import jp.chikuwachat.android.sync.WikiHub
import jp.chikuwachat.android.sync.WikiLevels
import jp.chikuwachat.android.sync.WikiLinks
import jp.chikuwachat.android.sync.WikiPageSource
import jp.chikuwachat.android.sync.WikiTree
import kotlinx.coroutines.launch

/*
 * M122 (docs/WIKI.md §7.4, §9.2): one page of 「ドキュメント」 on the phone — its breadcrumbs (an ancestor I cannot read is
 * 「…」), icon and title, the body drawn like a canvas (`page:` links with the pages' current titles, files, boxes that
 * tick), its subpages and the pages linking to it. Reading is the default; 「編集」 (edit / full only) is the canvas's
 * Markdown editor, its sections editable from their headings, saved by the canvas's loop on the /wiki endpoints
 * (autosave, merge, the conflict choices, offline copies). A view-only reader sees no edit controls and cannot tick.
 * Sharing, moving and the trash stay on the computer (§9.2).
 */

/** As a canvas: from this width the editor and the preview (and the reading view and the outline) sit side by side. */
private val DOC_WIDE = 840.dp

/** From this width the bar is a single row. */
private val DOC_ONE_ROW = 600.dp

/** What a reader may do on a page, from the level the server gave (the tree's when it knows the page, else the page's). */
data class PageRights(val edit: Boolean, val createChild: Boolean) {
    companion object {
        fun of(level: String?): PageRights = PageRights(WikiLevels.canEdit(level), WikiLevels.canCreateChild(level))
    }
}

object DocPageText {
    /** The breadcrumbs as shown: readable ancestors by title, the others 「…」 (never their titles). */
    fun crumbs(crumbs: List<PageCrumb>): List<Pair<String?, String>> =
        crumbs.map { crumb -> if (crumb.readable && crumb.id != null) crumb.id to ((crumb.icon?.let { "$it " } ?: "") + crumb.title.orEmpty().ifBlank { L10n.str(R.string.docs_untitled) }) else null to "…" }

    /**
     * The level the screen goes by: the tree's (the feed keeps it current, sharing changes come there) when it has the
     * page, else the page's own answer.
     */
    fun level(tree: PageItem?, page: PageOut?): String? = tree?.myLevel ?: page?.myLevel

    /** The subpages: the tree's when it knows them (current, ordered), else the page's answer (ordered the same way). */
    fun children(pages: Map<String, PageItem>, page: PageOut?, pageId: String): List<PageItem> {
        val fromTree = pages.values.filter { it.parentId == pageId && it.kind != "row" }
        if (fromTree.isNotEmpty() || pages.containsKey(pageId)) return fromTree.sortedWith(WikiTree.order)
        return page?.children.orEmpty().sortedWith(WikiTree.order)
    }
}

/** Holds the page's save loop while it is on screen; letting go saves what is typed. */
@Composable
fun DocPagePane(
    controller: AppController,
    pageId: String,
    onOpenPage: (String) -> Unit,
    onOpenCrumb: (String) -> Unit,
) {
    val hub = controller.wiki ?: return CanvasEmpty(stringResource(R.string.common_loading), null, loading = true)
    var held by remember(pageId) { mutableStateOf<Pair<CanvasSaver, WikiPageSource>?>(null) }
    DisposableEffect(hub, pageId) {
        val (saver, source, release) = hub.hold(pageId)
        held = if (saver != null && source != null) saver to source else null
        onDispose { release() }
    }
    val (saver, source) = held ?: return CanvasEmpty(stringResource(R.string.common_loading), null, loading = true)
    DocPageView(controller, hub, pageId, saver, source, onOpenPage, onOpenCrumb)
}

@Composable
private fun DocPageView(
    controller: AppController, hub: WikiHub, pageId: String, saver: CanvasSaver, source: WikiPageSource,
    onOpenPage: (String) -> Unit, onOpenCrumb: (String) -> Unit,
) {
    val revision by saver.revision.collectAsState()
    val page by source.page.collectAsState()
    val wikiVersion by hub.version.collectAsState()
    val store = controller.store
    val version by store.version.collectAsState()
    val treeItem = remember(wikiVersion, pageId) { hub.pages[pageId] }
    val level = DocPageText.level(treeItem, page)
    val rights = PageRights.of(level)
    val status = saver.status
    var mode by rememberSaveable(pageId) { mutableStateOf(CanvasMode.VIEW) }
    var section by remember(pageId) { mutableStateOf<CanvasSections.Key?>(null) }
    var conflictOpen by remember(pageId) { mutableStateOf(true) }
    var renaming by remember(pageId) { mutableStateOf(false) }
    var creatingChild by remember(pageId) { mutableStateOf(false) }
    LaunchedEffect(status) { if (status == CanvasSaveStatus.CONFLICT || status == CanvasSaveStatus.EXPIRED) conflictOpen = true }
    val loadError = saver.loadError?.takeIf { status != CanvasSaveStatus.GONE }
    val gone = status == CanvasSaveStatus.GONE
    val usable = status != CanvasSaveStatus.LOADING && !gone && loadError == null
    val editing = rights.edit && mode == CanvasMode.EDIT && usable
    // WIKI.md §4.1: view may not even tick (no canvas-style 「チェックだけは誰でも」).
    val onToggle: ((Int, Boolean) -> Unit)? = if (rights.edit && usable) { line, done ->
        CanvasText.toggleTaskLine(saver.text, line, done)?.let { next ->
            saver.edit(next, external = true)
            saver.flush() // a tick is saved at once
        }
    } else null
    val text = remember(revision) { saver.text }
    val headings = remember(text) { CanvasText.outline(text) }
    // The titles of the pages this body links to that the tree does not have (asked once a session).
    LaunchedEffect(text, wikiVersion) { hub.resolve(WikiLinks.pageIds(text, controller.serverBase)) }
    val title = page?.title ?: treeItem?.title ?: ""
    val icon = page?.icon ?: treeItem?.icon
    // M124: a database shows its rows under its description; a row its properties above its body.
    val kind = treeItem?.kind ?: page?.kind ?: "page"
    val dbSession = if (kind == "database") rememberDatabaseSession(controller, hub, pageId) else null
    val dbVersion = dbSession?.version?.collectAsState()?.value ?: 0
    val rowSession = if (kind == "row") rememberRowSession(controller, hub, pageId) else null
    var selectedRow by rememberSaveable(pageId) { mutableStateOf<String?>(null) }
    var addingRow by remember(pageId) { mutableStateOf(false) }
    var refreshing by remember(pageId) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val onRefresh: (() -> Unit)? = if (dbSession != null || rowSession != null) ({
        refreshing = true
        scope.launch {
            try {
                saver.online()
                dbSession?.refresh()
                rowSession?.refresh()
            } finally {
                refreshing = false
            }
        }
    }) else null
    val listState = rememberLazyListState()
    var backlinks by remember(pageId) { mutableStateOf<List<PageItem>?>(null) }
    LaunchedEffect(pageId, page?.version, controller.engineStatus) { controller.wikiBacklinks(pageId)?.let { backlinks = it } }
    val children = remember(wikiVersion, page, pageId) { DocPageText.children(hub.pages, page, pageId) }
    val crumbs = remember(page?.breadcrumbs) { DocPageText.crumbs(page?.breadcrumbs.orEmpty()) }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val wide = maxWidth >= DOC_WIDE
        val oneRow = maxWidth >= DOC_ONE_ROW
        Column(Modifier.fillMaxSize()) {
            // The bar: where it is (breadcrumbs), the save state, 閲覧 | 編集, the outline, ⋮.
            Row(Modifier.fillMaxWidth().padding(start = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Breadcrumbs(crumbs, Modifier.weight(1f), onOpenCrumb)
                if (oneRow) {
                    if (rights.edit || status != CanvasSaveStatus.SAVED) SaveState(saver, onOpenConflict = { conflictOpen = true })
                    if (!wide && !editing && headings.size >= 3) OutlineMenu(headings) { entry -> scope.launch { scrollToHeading(listState, text, entry.line) } }
                    if (rights.edit && !gone && loadError == null) ModeSwitch(mode) { mode = it }
                }
                PageMenu(
                    controller, pageId, title, rights, gone, saver,
                    onRename = { renaming = true }, onNewChild = { creatingChild = true }, onReload = { saver.online() },
                )
            }
            if (!oneRow) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (rights.edit || status != CanvasSaveStatus.SAVED) SaveState(saver, onOpenConflict = { conflictOpen = true })
                    Spacer(Modifier.weight(1f))
                    if (!editing && headings.size >= 3) OutlineMenu(headings) { entry -> scope.launch { scrollToHeading(listState, text, entry.line) } }
                    if (rights.edit && !gone && loadError == null) ModeSwitch(mode) { mode = it }
                }
            }
            HorizontalDivider()
            val offlineSince = remember(revision) { saver.cachedAt?.takeIf { saver.unreachable } }
            if (offlineSince != null && loadError == null) OfflineCopyNotice(offlineSince) { saver.online() }
            if (loadError == null) PageNotice(controller, rights, saver, status, level)
            when {
                loadError != null -> CanvasEmpty(stringResource(R.string.common_couldnt_load_2), controller.describe(loadError)) {
                    Button(onClick = { saver.load() }) { Icon(Icons.Outlined.Refresh, null); Text(stringResource(R.string.common_reload)) }
                }
                status == CanvasSaveStatus.LOADING -> CanvasEmpty(stringResource(R.string.common_loading), null, loading = true)
                gone && text.isEmpty() -> CanvasEmpty(stringResource(R.string.docs_page_gone), null)
                editing && wide -> Row(Modifier.fillMaxSize()) {
                    // The editor and the preview scroll together (the side last touched drives), as for a canvas.
                    val sync = remember(pageId) { CanvasScrollLink() }
                    val previewState = rememberLazyListState()
                    val spans = remember(text) { parseBlockSpans(text, canvas = true) }
                    CanvasScrollSyncEffect(sync, previewState, spans)
                    CanvasEditorField(controller, saver, null, Modifier.weight(1f).fillMaxHeight(), scroll = sync, presence = false)
                    VerticalDivider()
                    PageReader(
                        controller, saver, version, icon, title, page, rights, onToggle, null, previewState,
                        Modifier.weight(1f).fillMaxHeight().drivesScroll(sync, ScrollDriver.PREVIEW), preview = true,
                        children = emptyList(), backlinks = null, onOpenPage = onOpenPage, onStartWriting = {}, spans = spans,
                    )
                }
                editing -> CanvasEditorField(controller, saver, null, Modifier.fillMaxSize(), presence = false)
                else -> Row(Modifier.fillMaxSize()) {
                    // M124: on a tablet a database's rows and the open row sit side by side.
                    val sideBySide = wide && dbSession != null
                    val openRow: (String) -> Unit = if (sideBySide) ({ id -> selectedRow = id }) else onOpenPage
                    PageReader(
                        controller, saver, version, icon, title, page, rights, onToggle,
                        onEditSection = if (rights.edit && usable) ({ line -> section = CanvasSections.keyAt(saver.text, line) }) else null,
                        listState = listState, modifier = Modifier.weight(1f).fillMaxHeight(), preview = false,
                        children = children, backlinks = backlinks, onOpenPage = onOpenPage, onStartWriting = { mode = CanvasMode.EDIT },
                        kind = kind,
                        header = rowSession?.let { session -> { RowPropertiesSection(controller, session, version, onOpenPage) } },
                        extra = dbSession?.let { session ->
                            { databaseItems(controller, session, dbVersion, version, selectedRow.takeIf { sideBySide }, openRow) { addingRow = true } }
                        },
                        onRefresh = onRefresh, refreshing = refreshing,
                    )
                    if (addingRow && dbSession != null) {
                        NewRowDialog(controller, dbSession, onDismiss = { addingRow = false }) { row ->
                            addingRow = false
                            openRow(row.id)
                        }
                    }
                    if (sideBySide) {
                        VerticalDivider()
                        Box(Modifier.weight(1f).fillMaxHeight()) {
                            val open = selectedRow
                            if (open != null) key(open) { DocPagePane(controller, open, onOpenPage, onOpenCrumb) }
                            else CanvasEmpty(stringResource(R.string.docs_db_select_row), null)
                        }
                    } else if (wide && headings.size >= 3) {
                        VerticalDivider()
                        OutlineColumn(headings, Modifier.width(220.dp).fillMaxHeight()) { entry -> scope.launch { scrollToHeading(listState, text, entry.line) } }
                    }
                }
            }
        }
    }

    section?.let { key ->
        SectionSheet(controller, saver, key, onDismiss = {
            section = null
            saver.flush()
        }, presence = false)
    }
    if (renaming) RenamePageDialog(controller, pageId, title) { renaming = false }
    if (creatingChild) {
        NewPageDialog(controller, NewPageTarget(pageId, title, "workspace"), onDismiss = { creatingChild = false }) { created ->
            creatingChild = false
            onOpenPage(created.id)
        }
    }
    val conflict = saver.conflict
    if (conflictOpen && status == CanvasSaveStatus.CONFLICT && conflict != null) {
        ConflictDialog(controller, saver, tickOnly = false, conflict.details.conflicts, conflict.details.timedOut) { conflictOpen = false }
    }
    val expired = saver.expired
    if (conflictOpen && status == CanvasSaveStatus.EXPIRED && expired != null) {
        ExpiredDialog(controller, saver, expired, canOverwrite = rights.edit) { conflictOpen = false }
    }
}

/** 「ドキュメント › 研究室マニュアル › … › 計算機」: a readable ancestor opens on a tap; one I cannot read is 「…」. */
@Composable
private fun Breadcrumbs(crumbs: List<Pair<String?, String>>, modifier: Modifier, onOpen: (String) -> Unit) {
    Row(
        modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp)
            .semantics { contentDescription = L10n.str(R.string.docs_breadcrumbs) },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(stringResource(R.string.docs_title), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        crumbs.forEach { (id, label) ->
            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
            if (id != null) {
                Text(
                    label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, maxLines = 1,
                    modifier = Modifier.clickable { onOpen(id) }.heightIn(min = 36.dp).padding(horizontal = 2.dp, vertical = 9.dp),
                )
            } else {
                Text(
                    label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.semantics { contentDescription = L10n.str(R.string.docs_hidden_ancestor) }.padding(horizontal = 2.dp),
                )
            }
        }
    }
}

/** A line under the bar: view only (with the level), or what happened (in the trash, could not save; 本文をコピー). */
@Composable
private fun PageNotice(controller: AppController, rights: PageRights, saver: CanvasSaver, status: CanvasSaveStatus, level: String?) {
    val (text, warn) = when {
        status == CanvasSaveStatus.GONE -> stringResource(R.string.docs_page_gone) to true
        status == CanvasSaveStatus.BLOCKED -> stringResource(R.string.canvas_pane_couldnt_save, saver.error?.let { controller.describe(it) } ?: "") to true
        status == CanvasSaveStatus.LOADING -> return
        !rights.edit && level != null -> stringResource(R.string.docs_view_only) to false
        else -> return
    }
    Row(
        Modifier.fillMaxWidth()
            .background(if (warn) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f),
            color = if (warn) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (warn && saver.text.isNotEmpty()) TextButton(onClick = { controller.copyCanvasText(saver.text) }) {
            Icon(Icons.Outlined.ContentCopy, null, modifier = Modifier.size(14.dp))
            Text(stringResource(R.string.canvas_pane_copy_text), style = MaterialTheme.typography.labelMedium)
        }
    }
}

/**
 * The page drawn: icon and title, 「最終更新」, the blocks, then (reading, not the editor's preview) the subpages and the
 * pages linking here. The items are title, blocks, end — the scroll sync of the two columns counts on it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PageReader(
    controller: AppController, saver: CanvasSaver, version: Int, icon: String?, title: String, page: PageOut?, rights: PageRights,
    onToggle: ((Int, Boolean) -> Unit)?, onEditSection: ((Int) -> Unit)?, listState: LazyListState, modifier: Modifier,
    preview: Boolean, children: List<PageItem>, backlinks: List<PageItem>?, onOpenPage: (String) -> Unit, onStartWriting: () -> Unit,
    spans: List<BlockSpan>? = null,
    /** M124: page, database or row. */
    kind: String = "page",
    /** M124: under the title (a row's properties). */
    header: (@Composable () -> Unit)? = null,
    /** M124: after the body (a database's rows). */
    extra: (LazyListScope.() -> Unit)? = null,
    onRefresh: (() -> Unit)? = null,
    refreshing: Boolean = false,
) {
    val revision by saver.revision.collectAsState()
    val text = remember(revision) { saver.text }
    val blocks = remember(text, spans) { spans?.map { it.block } ?: parseBlocks(text, canvas = true) }
    val store = controller.store
    val inline = bodyInline(
        store.users, internalBase = controller.serverBase,
        onOpenMessage = { id -> controller.scope.launch { controller.openPermalink(id) } },
        onOpenCanvas = { id -> controller.scope.launch { controller.openCanvasLink(id) } },
        customEmoji = store.customEmoji, emojiImages = store.emojiImages, emojiAnimations = store.emojiAnimations,
        onNeedEmojiImage = { controller.loadEmojiImage(it) }, groups = store.groups, version = version,
    )
    val list = @Composable { listModifier: Modifier -> LazyColumn(
        listModifier.semantics { contentDescription = if (preview) L10n.str(R.string.docs_page_preview) else L10n.str(R.string.docs_page_content) },
        state = listState, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item(key = "title") {
            Column(Modifier.canvasColumn()) {
                if (preview) Text(stringResource(R.string.common_preview), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 6.dp))
                else {
                    PageTitleText(controller, version, icon, title, MaterialTheme.typography.headlineSmall, Modifier.semantics { heading() }, maxLines = 3, fontWeight = FontWeight.Bold, kind = kind)
                    if (page != null) {
                        val who = store.users[page.updatedBy]?.displayName ?: stringResource(R.string.common_member)
                        Text(
                            stringResource(R.string.docs_last_updated, who, YouSettings.lastUsedLabel(page.updatedAt)),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp),
                        )
                    }
                    Spacer(Modifier.height(12.dp))
                    header?.invoke()
                }
                if (text.isBlank() && kind != "database") {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(stringResource(R.string.common_nothing_written_yet), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (rights.edit && !preview) TextButton(onClick = onStartWriting) { Text(stringResource(R.string.canvas_pane_start_writing)) }
                    }
                }
            }
        }
        itemsIndexed(blocks) { _, block ->
            Box(Modifier.canvasColumn().padding(vertical = 1.dp)) {
                CanvasBlockView(block, inline, controller, onToggle, onEditSection)
            }
        }
        if (!preview && children.isNotEmpty()) {
            item(key = "children") {
                PageList(controller, version, stringResource(R.string.docs_subpages), children, onOpenPage)
            }
        }
        if (!preview && !backlinks.isNullOrEmpty()) {
            item(key = "backlinks") {
                PageList(controller, version, stringResource(R.string.docs_backlinks), backlinks, onOpenPage)
            }
        }
        if (!preview) extra?.invoke(this)
        item(key = "end") { Spacer(Modifier.height(48.dp)) }
    } }
    if (onRefresh != null && !preview) {
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = onRefresh, modifier = modifier) { list(Modifier.fillMaxSize()) }
    } else list(modifier)
}

/** サブページ / このページへのリンク: a heading and the pages, each opening on a tap. */
@Composable
private fun PageList(controller: AppController, version: Int, heading: String, pages: List<PageItem>, onOpen: (String) -> Unit) {
    Column(Modifier.canvasColumn().padding(top = 20.dp)) {
        HorizontalDivider()
        Text(
            heading, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 10.dp, bottom = 4.dp).semantics { heading() },
        )
        pages.forEach { item ->
            Row(
                Modifier.fillMaxWidth().clickable(onClickLabel = stringResource(R.string.docs_open_page)) { onOpen(item.id) }.heightIn(min = 40.dp).padding(vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                PageTitleText(controller, version, item.icon, item.title, MaterialTheme.typography.bodyMedium, Modifier.weight(1f), kind = item.kind)
            }
        }
    }
}

/** ⋮: 子ページを作る (edit), 題名を変更 (edit), リンクをコピー, 本文をコピー, 再読み込み. */
@Composable
private fun PageMenu(
    controller: AppController, pageId: String, title: String, rights: PageRights, gone: Boolean, saver: CanvasSaver,
    onRename: () -> Unit, onNewChild: () -> Unit, onReload: () -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) { Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.docs_page_actions)) }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            if (rights.createChild && !gone) DropdownMenuItem(text = { Text(stringResource(R.string.docs_new_subpage)) }, leadingIcon = { Icon(Icons.Outlined.Add, null) }, onClick = { open = false; onNewChild() })
            if (rights.edit && !gone) DropdownMenuItem(text = { Text(stringResource(R.string.docs_rename)) }, leadingIcon = { Icon(Icons.Outlined.Edit, null) }, onClick = { open = false; onRename() })
            DropdownMenuItem(text = { Text(stringResource(R.string.docs_copy_link)) }, leadingIcon = { Icon(Icons.Outlined.Link, null) }, onClick = { open = false; controller.copyPageLink(pageId) })
            DropdownMenuItem(text = { Text(stringResource(R.string.canvas_pane_copy_text_2)) }, leadingIcon = { Icon(Icons.Outlined.ContentCopy, null) }, onClick = { open = false; controller.copyCanvasText(saver.text) })
            DropdownMenuItem(text = { Text(stringResource(R.string.common_reload)) }, leadingIcon = { Icon(Icons.Outlined.Refresh, null) }, onClick = { open = false; onReload() })
        }
    }
}

@Composable
private fun RenamePageDialog(controller: AppController, pageId: String, current: String, onDismiss: () -> Unit) {
    var title by rememberSaveable(pageId) { mutableStateOf(current) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.docs_rename)) },
        text = { OutlinedTextField(title, { title = it.take(200) }, singleLine = true, label = { Text(stringResource(R.string.docs_title_label)) }) },
        confirmButton = {
            TextButton(enabled = !busy, onClick = {
                val trimmed = title.trim()
                if (trimmed == current) { onDismiss(); return@TextButton }
                busy = true
                scope.launch {
                    val ok = controller.renameWikiPage(pageId, trimmed)
                    busy = false
                    if (ok) onDismiss()
                }
            }) { Text(stringResource(R.string.common_change)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}

/** The app bar's title over a page: its icon and current title (the tree's, else 「ドキュメント」 until it is known). */
@Composable
fun DocPageBarTitle(controller: AppController, pageId: String) {
    val hub = controller.wiki
    val wikiVersion = hub?.version?.collectAsState()?.value ?: 0
    val version by controller.store.version.collectAsState()
    val item = remember(wikiVersion, pageId) { hub?.pages?.get(pageId) }
    val held = remember(wikiVersion, pageId) { hub?.current(pageId) }
    val title = item?.title ?: held?.canvas?.title
    if (title == null) Text(stringResource(R.string.docs_title), maxLines = 1, overflow = TextOverflow.Ellipsis)
    else PageTitleText(controller, version, item?.icon, title, MaterialTheme.typography.titleLarge, kind = item?.kind ?: "page")
}
