package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.TableChart
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.PageItem
import jp.chikuwachat.android.api.PageOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.CanvasSaver
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.WikiLevels
import jp.chikuwachat.android.sync.WikiTree
import kotlinx.coroutines.launch

/*
 * M122 (docs/WIKI.md §3.1, §9.2): 「ドキュメント」 on the phone — the tree of the pages I can read, under 共有 and
 * プライベート, opened and closed a level at a time (what is open is kept while a page is on top and across a rotation).
 * A row opens its page over the tree. ＋ beside a heading makes a top-level page (共有: everyone edits; プライベート: only me;
 * not for guests). The field on top filters the titles; its search key looks in the bodies (the search's 「ドキュメント」
 * tab). The tree is the one kept on this device until the server answers (offline: marked so).
 */

/** Where a new page goes: under `parentId` (its title for the dialog), or top-level with `access`. */
data class NewPageTarget(val parentId: String?, val parentTitle: String?, val access: String)

/** What a tree row reads (TalkBack): 「ページ「議事録」、自分だけ、子ページあり」. */
object DocsText {
    fun title(page: PageItem): String = page.title.ifBlank { L10n.str(R.string.docs_untitled) }

    fun spoken(row: jp.chikuwachat.android.sync.WikiTreeRow, topLevel: Boolean): String =
        L10n.str(R.string.docs_row, title(row.page)) +
            (if (topLevel && row.page.private) L10n.str(R.string.docs_row_private) else "") +
            (if (row.hasChildren) L10n.str(R.string.docs_row_children) else "")

    /** The level as a word (閲覧 / 編集 / フルアクセス). */
    fun level(level: String?): String = when (level) {
        "full" -> L10n.str(R.string.docs_level_full)
        "edit" -> L10n.str(R.string.docs_level_edit)
        else -> L10n.str(R.string.docs_level_view)
    }
}

/** The open rows (kept by the main screen, so they stay while a page is on top and across a rotation): ids, joined. */
fun decodeOpenRows(raw: String): Set<String> = raw.split(',').filter { it.isNotBlank() }.toSet()

fun toggleOpenRow(raw: String, id: String): String {
    val open = decodeOpenRows(raw)
    return (if (id in open) open - id else open + id).joinToString(",")
}

@Composable
fun DocsPane(
    controller: AppController,
    listState: LazyListState,
    /** The open rows ([decodeOpenRows]) and the filter, held by the main screen. */
    openRows: String,
    onOpenRows: (String) -> Unit,
    query: String,
    onQuery: (String) -> Unit,
    onOpen: (pageId: String) -> Unit,
    onSearchBodies: (String) -> Unit,
) {
    val hub = controller.wiki
    if (hub == null) {
        CanvasEmpty(stringResource(R.string.common_loading), null, loading = true)
        return
    }
    val wikiVersion by hub.version.collectAsState()
    val store = controller.store
    val version by store.version.collectAsState()
    // From the tile: the tree asked again (ETag: usually a 304).
    LaunchedEffect(hub) { hub.reloadTree() }
    val open = remember(openRows) { decodeOpenRows(openRows) }
    fun toggle(id: String) = onOpenRows(toggleOpenRow(openRows, id))
    var creating by remember { mutableStateOf<NewPageTarget?>(null) }
    val pages = remember(wikiVersion) { hub.pages }
    val sections = remember(pages) { WikiTree.sections(pages) }
    val sharedRows = remember(pages, open) { WikiTree.rows(pages, sections.shared, open) }
    val privateRows = remember(pages, open) { WikiTree.rows(pages, sections.private, open) }
    val filtered = remember(pages, query) { WikiTree.filter(pages, query) }
    val canCreateTop = WikiLevels.canCreateTopLevel(store.me?.role) && hub.available
    val submit = { val q = query.trim(); if (q.isNotEmpty()) onSearchBodies(q) }
    val offline = hub.loadError?.let { CanvasSaver.temporary(it) } == true

    creating?.let { target ->
        NewPageDialog(controller, target, onDismiss = { creating = null }) { page ->
            creating = null
            onOpen(page.id)
        }
    }

    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            query, onQuery, singleLine = true,
            placeholder = { Text(stringResource(R.string.docs_filter)) },
            leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { submit() }),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
        )
        if (offline && hub.hasTree) {
            Row(
                Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.tertiaryContainer)
                    .padding(start = 12.dp, end = 4.dp, top = 2.dp, bottom = 2.dp).semantics { liveRegion = LiveRegionMode.Polite },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.CloudOff, null, tint = MaterialTheme.colorScheme.onTertiaryContainer, modifier = Modifier.size(15.dp))
                Spacer(Modifier.width(6.dp))
                Text(stringResource(R.string.docs_offline_tree), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onTertiaryContainer, modifier = Modifier.weight(1f))
                TextButton(onClick = { hub.reloadTree() }) { Text(stringResource(R.string.common_reload), style = MaterialTheme.typography.labelMedium) }
            }
        }
        when {
            !hub.hasTree && hub.loadError != null && !offline -> CanvasEmpty(stringResource(R.string.docs_load_failed), controller.describe(hub.loadError!!)) {
                Button(onClick = { hub.reloadTree() }) { Icon(Icons.Outlined.Refresh, null); Text(stringResource(R.string.common_reload)) }
            }
            !hub.hasTree && !hub.supported && controller.engineStatus == EngineStatus.ONLINE ->
                CanvasEmpty(stringResource(R.string.docs_unavailable), stringResource(R.string.docs_unavailable_text))
            !hub.hasTree && offline -> CanvasEmpty(stringResource(R.string.docs_load_failed), stringResource(R.string.docs_offline_tree)) {
                Button(onClick = { hub.reloadTree() }) { Icon(Icons.Outlined.Refresh, null); Text(stringResource(R.string.common_reload)) }
            }
            !hub.hasTree -> CanvasEmpty(stringResource(R.string.common_loading), null, loading = true)
            query.isNotBlank() -> LazyColumn(Modifier.fillMaxSize()) {
                if (filtered.isEmpty()) item(key = "none") {
                    Text(
                        stringResource(R.string.docs_no_title_match), style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 20.dp, vertical = 16.dp),
                    )
                }
                items(filtered, key = { "f:" + it.id }) { page ->
                    val path = remember(pages, page.id) { WikiTree.ancestors(pages, page.id).joinToString(" / ") { DocsText.title(it) } }
                    PageRow(controller, version, page, depth = 0, hasChildren = false, expanded = false, subtitle = path.ifEmpty { null }, onToggle = {}, onOpen = { onOpen(page.id) })
                }
                item(key = "bodies") {
                    TextButton(onClick = submit, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                        Text(stringResource(R.string.docs_search_bodies, query.trim()))
                    }
                }
            }
            else -> LazyColumn(Modifier.fillMaxSize(), state = listState) {
                item(key = "h:shared") {
                    SectionHeading(stringResource(R.string.docs_shared), if (canCreateTop) stringResource(R.string.docs_new_shared_page) else null) {
                        creating = NewPageTarget(null, null, "workspace")
                    }
                }
                if (sharedRows.isEmpty()) item(key = "e:shared") { EmptyLine(stringResource(R.string.docs_empty_shared)) }
                items(sharedRows, key = { "s:" + it.page.id }) { row ->
                    PageRow(controller, version, row.page, row.depth, row.hasChildren, row.expanded, null, onToggle = { toggle(row.page.id) }, onOpen = { onOpen(row.page.id) }, spoken = DocsText.spoken(row, row.depth == 0))
                }
                item(key = "h:private") {
                    SectionHeading(stringResource(R.string.docs_private), if (canCreateTop) stringResource(R.string.docs_new_private_page) else null) {
                        creating = NewPageTarget(null, null, "private")
                    }
                }
                if (privateRows.isEmpty()) item(key = "e:private") { EmptyLine(stringResource(R.string.docs_empty_private)) }
                items(privateRows, key = { "p:" + it.page.id }) { row ->
                    PageRow(controller, version, row.page, row.depth, row.hasChildren, row.expanded, null, onToggle = { toggle(row.page.id) }, onOpen = { onOpen(row.page.id) }, spoken = DocsText.spoken(row, row.depth == 0))
                }
                item(key = "end") { Spacer(Modifier.heightIn(min = 48.dp)) }
            }
        }
    }
}

@Composable
private fun SectionHeading(title: String, addLabel: String?, onAdd: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 4.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        if (addLabel != null) IconButton(onClick = onAdd) { Icon(Icons.Outlined.Add, contentDescription = addLabel) }
    }
}

@Composable
private fun EmptyLine(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
}

/**
 * A page's icon (an emoji, or a custom one by `:name:`) and title, as rows and headings show them. Without an icon a
 * page shows 📄, a database (M124) a table icon, a database's row only its title.
 */
@Composable
fun PageTitleText(
    controller: AppController, version: Int, icon: String?, title: String, style: androidx.compose.ui.text.TextStyle,
    modifier: Modifier = Modifier, maxLines: Int = 1, fontWeight: FontWeight? = null, kind: String = "page",
) {
    val own = icon?.takeIf { it.isNotBlank() }
    val text = title.ifBlank { L10n.str(R.string.docs_untitled) }
    if (own == null && kind == "database") {
        Row(modifier, verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.TableChart, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(with(LocalDensity.current) { style.fontSize.toDp() * 1.1f }))
            Spacer(Modifier.width(6.dp))
            EmojiLineText(text, controller, version, style, MaterialTheme.colorScheme.onSurface, Modifier, maxLines, fontWeight)
        }
        return
    }
    EmojiLineText(
        (own ?: if (kind == "row") null else "📄")?.let { "$it  " }.orEmpty() + text,
        controller, version, style, MaterialTheme.colorScheme.onSurface, modifier, maxLines, fontWeight,
    )
}

/** A row of the tree: ▸ / ▾ when it has children (they open in place), the icon and title; a tap opens the page. */
@Composable
private fun PageRow(
    controller: AppController, version: Int, page: PageItem, depth: Int, hasChildren: Boolean, expanded: Boolean, subtitle: String?,
    onToggle: () -> Unit, onOpen: () -> Unit, spoken: String? = null,
) {
    val title = DocsText.title(page)
    Row(
        Modifier.fillMaxWidth().clickable(onClickLabel = stringResource(R.string.docs_open_page), onClick = onOpen)
            .heightIn(min = 44.dp).padding(start = (4 + depth * 16).dp, end = 12.dp)
            .then(if (spoken != null) Modifier.semantics(mergeDescendants = false) { contentDescription = spoken } else Modifier),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
            if (hasChildren) {
                IconButton(
                    onClick = onToggle,
                    modifier = Modifier.semantics { stateDescription = if (expanded) L10n.str(R.string.docs_collapse, title) else L10n.str(R.string.docs_expand, title) },
                ) {
                    Icon(
                        if (expanded) Icons.Outlined.KeyboardArrowDown else Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                        contentDescription = if (expanded) L10n.str(R.string.docs_collapse, title) else L10n.str(R.string.docs_expand, title),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        Column(Modifier.weight(1f).padding(vertical = 6.dp)) {
            PageTitleText(controller, version, page.icon, page.title, MaterialTheme.typography.bodyLarge, kind = page.kind)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** A new page's title (empty: 「無題」) and where it goes; creating it opens it. */
@Composable
fun NewPageDialog(controller: AppController, target: NewPageTarget, onDismiss: () -> Unit, onCreated: (PageOut) -> Unit) {
    var title by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = {
            Text(
                when {
                    target.parentId != null -> stringResource(R.string.docs_new_subpage)
                    target.access == "private" -> stringResource(R.string.docs_new_private_page)
                    else -> stringResource(R.string.docs_new_shared_page)
                },
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    when {
                        target.parentId != null -> stringResource(R.string.docs_new_subpage_note, target.parentTitle?.ifBlank { null } ?: L10n.str(R.string.docs_untitled))
                        target.access == "private" -> stringResource(R.string.docs_new_private_note)
                        else -> stringResource(R.string.docs_new_shared_note)
                    },
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    title, { title = it.take(200) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    label = { Text(stringResource(R.string.docs_title_label)) },
                    placeholder = { Text(stringResource(R.string.docs_title_placeholder)) },
                )
            }
        },
        confirmButton = {
            TextButton(enabled = !busy, onClick = {
                busy = true
                scope.launch {
                    val created = controller.createWikiPage(target.parentId, title.trim().ifEmpty { null }, target.access)
                    busy = false
                    if (created != null) onCreated(created)
                }
            }) {
                if (busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) else Text(stringResource(R.string.common_create))
            }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}
