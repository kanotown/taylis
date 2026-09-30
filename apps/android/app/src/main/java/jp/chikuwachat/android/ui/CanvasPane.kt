package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.FormatListBulleted
import androidx.compose.material.icons.automirrored.outlined.List
import androidx.compose.material.icons.outlined.AlternateEmail
import androidx.compose.material.icons.outlined.ArrowDropDown
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.CloudDone
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.FormatBold
import androidx.compose.material.icons.outlined.FormatListNumbered
import androidx.compose.material.icons.outlined.FormatQuote
import androidx.compose.material.icons.outlined.HorizontalRule
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Restore
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.Title
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.CanvasConflict
import jp.chikuwachat.android.api.CanvasMeta
import jp.chikuwachat.android.api.CanvasOut
import jp.chikuwachat.android.api.CanvasRevisionMeta
import jp.chikuwachat.android.api.CanvasRevisionOut
import jp.chikuwachat.android.api.CanvasTemplateOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.CanvasSaveStatus
import jp.chikuwachat.android.sync.CanvasSaver
import jp.chikuwachat.android.sync.ChannelState
import kotlinx.coroutines.launch

/*
 * M46: a conversation's 「キャンバス」 tab on Android (CANVAS.md §4.1 / §5), matching the desktop's M43 screen: its
 * canvases (the conversation's tab canvas first), one of them open — rendered with boxes that tick (閲覧, the default),
 * or in the Markdown editor (編集; beside the preview on a wide screen) — with the save state (保存済み / 編集中 /
 * 保存中… / オフライン / 再試行中… / 競合 / 保存できません), the conflict choice, a new canvas from a template, the
 * settings (title, who edits, the tab), the trash and a read-only history. A heading's 「このセクションを編集」 edits one
 * section in a sheet (§5 Android: phones edit a long canvas a section at a time).
 */

/** The width from which the editor and the preview (and the reading view and the outline) sit side by side. */
private val WIDE = 840.dp

/** The width from which the bar is a single row. */
private val ONE_ROW = 600.dp

/** The pane of the conversation's 「キャンバス」 tab. `canvasId` null: the default one (or the empty state). */
@Composable
fun CanvasPane(controller: AppController, channel: ChannelState, version: Int, canvasId: String?, onSelect: (String?) -> Unit) {
    val store = controller.store
    val hub = controller.engine?.canvases
    val list = remember(version, channel.id) { store.canvasesOf(channel.id) }
    // The list arrives with the conversation (engine.openChannel); a pane shown before that asks once more.
    LaunchedEffect(hub, channel.id, list == null) { if (list == null) hub?.loadList(channel.id) }
    var dialog by rememberSaveable(channel.id) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val me = store.me
    val createRights = CanvasRights.of(channel, me?.id, me?.role, null)
    val selectedId = canvasId ?: list?.let { CanvasText.defaultCanvasId(it) }

    when (dialog) {
        "new" -> NewCanvasDialog(controller, channel, list ?: emptyList(), onDismiss = { dialog = null }) { created ->
            dialog = null
            onSelect(created.id)
        }
        "trash" -> TrashDialog(controller, channel, onDismiss = { dialog = null }) { restored ->
            dialog = null
            onSelect(restored.id)
        }
        "list" -> CanvasListSheet(
            controller, list ?: emptyList(), selectedId, version,
            onDismiss = { dialog = null },
            onPick = { dialog = null; onSelect(it) },
            onNew = if (createRights.create) ({ dialog = "new" }) else null,
            onTrash = { dialog = "trash" },
        )
    }

    when {
        hub == null || !hub.available -> CanvasEmpty("キャンバスを使えません", "サーバがキャンバスに対応していません。")
        list == null && selectedId == null -> CanvasEmpty("読み込み中…", null, loading = true)
        selectedId == null -> CanvasEmpty(
            "この会話にはまだキャンバスがありません",
            "議事録・週報・チェックリストなど、会話のメンバーで一緒に書く文書です。",
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (createRights.create) Button(onClick = { dialog = "new" }) { Icon(Icons.Outlined.Add, null); Text(" キャンバスを作成") }
                OutlinedButton(onClick = { dialog = "trash" }) { Icon(Icons.Outlined.Delete, null); Text(" ゴミ箱") }
            }
        }
        else -> key(selectedId) {
            OpenCanvas(controller, channel, version, selectedId, list ?: emptyList(), onOpenList = { dialog = "list" }, onTrashed = {
                scope.launch { hub.loadList(channel.id) }
                onSelect(null)
            })
        }
    }
}

@Composable
private fun CanvasEmpty(title: String, text: String?, loading: Boolean = false, action: (@Composable () -> Unit)? = null) {
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (loading) CircularProgressIndicator(Modifier.size(28.dp)) else Icon(Icons.Outlined.Description, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(36.dp))
        Spacer(Modifier.height(10.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        if (text != null) Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp).widthIn(max = 360.dp))
        if (action != null) Box(Modifier.padding(top = 14.dp)) { action() }
    }
}

/** Holds the canvas's save loop while it is on screen; letting go saves what is typed (§4.4 「画面を閉じるとき」). */
@Composable
private fun OpenCanvas(
    controller: AppController, channel: ChannelState, version: Int, canvasId: String, list: List<CanvasMeta>,
    onOpenList: () -> Unit, onTrashed: () -> Unit,
) {
    val hub = controller.engine?.canvases ?: return
    var saver by remember(canvasId) { mutableStateOf<CanvasSaver?>(null) }
    DisposableEffect(hub, canvasId) {
        val (held, release) = hub.hold(canvasId, channel.id)
        saver = held
        onDispose { release() }
    }
    val open = saver ?: return CanvasEmpty("読み込み中…", null, loading = true)
    CanvasView(controller, channel, version, canvasId, list, open, onOpenList, onTrashed)
}

private enum class CanvasMode { VIEW, EDIT }

/** One canvas on screen: its bar, the document (and the editor), the choices a save may ask for. */
@Composable
private fun CanvasView(
    controller: AppController, channel: ChannelState, version: Int, canvasId: String, list: List<CanvasMeta>, saver: CanvasSaver,
    onOpenList: () -> Unit, onTrashed: () -> Unit,
) {
    val revision by saver.revision.collectAsState()
    val store = controller.store
    val me = store.me
    val listed = remember(version, list, canvasId) { list.firstOrNull { it.id == canvasId } }
    val fetched = saver.canvas
    // The newer of the list's metadata (events) and the saver's (answers).
    val meta: CanvasMeta? = if (listed != null && (fetched == null || listed.version >= fetched.version)) listed else fetched?.meta
    val rights = meta?.let { CanvasRights.of(channel, me?.id, me?.role, it) } ?: CanvasRights.NONE
    val status = saver.status
    // §1: a phone reads, ticks and makes short changes; 閲覧 is where a canvas opens (the desktop's phone width too).
    var mode by rememberSaveable(canvasId) { mutableStateOf(CanvasMode.VIEW) }
    var section by remember(canvasId) { mutableStateOf<CanvasSections.Key?>(null) }
    var conflictOpen by remember(canvasId) { mutableStateOf(true) }
    var renaming by remember(canvasId) { mutableStateOf(false) }
    var history by remember(canvasId) { mutableStateOf(false) }
    LaunchedEffect(status) { if (status == CanvasSaveStatus.CONFLICT || status == CanvasSaveStatus.EXPIRED) conflictOpen = true }
    val usable = status != CanvasSaveStatus.LOADING && status != CanvasSaveStatus.GONE
    val editing = rights.edit && mode == CanvasMode.EDIT && usable
    val onToggle: ((Int, Boolean) -> Unit)? = if (rights.tick && usable) { line, done ->
        CanvasText.toggleTaskLine(saver.text, line, done)?.let { next ->
            saver.edit(next, external = true)
            saver.flush() // §4.4: a tick is saved at once
        }
    } else null
    val text = remember(revision) { saver.text }
    val headings = remember(text) { CanvasText.outline(text) }
    val title = meta?.title ?: "キャンバス"
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val wide = maxWidth >= WIDE
        // From a phone on its side on, the bar is one row (the landscape keyboard leaves little height for the text).
        val oneRow = maxWidth >= ONE_ROW
        Column(Modifier.fillMaxSize()) {
            // The bar: the canvas's name (its list), ⋮; then the save state, 閲覧 | 編集 and the outline.
            Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 0.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) {
                    TextButton(onClick = onOpenList, modifier = Modifier.semantics { contentDescription = "キャンバスの一覧: $title" }) {
                        Icon(Icons.Outlined.Description, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f, fill = false))
                        Icon(Icons.Outlined.ArrowDropDown, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (oneRow) {
                    SaveState(saver, onOpenConflict = { conflictOpen = true })
                    if (!wide && !editing && headings.size >= 3) OutlineMenu(headings) { entry -> scope.launch { scrollToHeading(listState, text, entry.line) } }
                    if (rights.edit && status != CanvasSaveStatus.GONE) ModeSwitch(mode) { mode = it }
                }
                if (meta != null) CanvasMenu(controller, channel, meta, rights, saver, status, onRename = { renaming = true }, onHistory = { history = true }, onTrashed = onTrashed)
            }
            if (!oneRow) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    SaveState(saver, onOpenConflict = { conflictOpen = true })
                    Spacer(Modifier.weight(1f))
                    if (!editing && headings.size >= 3) OutlineMenu(headings) { entry -> scope.launch { scrollToHeading(listState, text, entry.line) } }
                    if (rights.edit && status != CanvasSaveStatus.GONE) ModeSwitch(mode) { mode = it }
                }
            }
            HorizontalDivider()
            CanvasNotice(controller, channel, rights, saver, status)
            when {
                status == CanvasSaveStatus.LOADING -> CanvasEmpty("読み込み中…", null, loading = true)
                editing && wide -> Row(Modifier.fillMaxSize()) {
                    CanvasEditorField(controller, saver, null, Modifier.weight(1f).fillMaxHeight())
                    VerticalDivider()
                    CanvasReader(controller, saver, meta, title, rights, onToggle, null, rememberLazyListState(), Modifier.weight(1f).fillMaxHeight(), preview = true, onStartWriting = {})
                }
                editing -> CanvasEditorField(controller, saver, null, Modifier.fillMaxSize())
                else -> Row(Modifier.fillMaxSize()) {
                    CanvasReader(
                        controller, saver, meta, title, rights, onToggle,
                        onEditSection = if (rights.edit && usable) ({ line -> section = CanvasSections.keyAt(saver.text, line) }) else null,
                        listState = listState, modifier = Modifier.weight(1f).fillMaxHeight(), preview = false,
                        onStartWriting = { mode = CanvasMode.EDIT },
                    )
                    if (wide && headings.size >= 3) {
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
        })
    }
    if (renaming && meta != null) RenameDialog(controller, meta) { renaming = false }
    if (history && meta != null) HistoryDialog(controller, meta) { history = false }
    val conflict = saver.conflict
    if (conflictOpen && status == CanvasSaveStatus.CONFLICT && conflict != null) {
        ConflictDialog(controller, saver, tickOnly = !rights.edit, conflict.details.conflicts, conflict.details.timedOut) { conflictOpen = false }
    }
    val expired = saver.expired
    if (conflictOpen && status == CanvasSaveStatus.EXPIRED && expired != null) {
        ExpiredDialog(controller, saver, expired, canOverwrite = rights.edit) { conflictOpen = false }
    }
}

/** The list item of the heading on `line` (the title row comes first). */
private suspend fun scrollToHeading(state: LazyListState, text: String, line: Int) {
    val index = parseBlocks(text, canvas = true).indexOfFirst { it is BodyBlock.Heading && it.line == line }
    if (index >= 0) state.animateScrollToItem(index + 1)
}

@Composable
private fun ModeSwitch(mode: CanvasMode, onChange: (CanvasMode) -> Unit) {
    SingleChoiceSegmentedButtonRow(Modifier.height(36.dp)) {
        listOf(CanvasMode.VIEW to "閲覧", CanvasMode.EDIT to "編集").forEachIndexed { index, (value, label) ->
            SegmentedButton(
                selected = mode == value,
                onClick = { onChange(value) },
                shape = SegmentedButtonDefaults.itemShape(index, 2),
                icon = {},
            ) { Text(label, style = MaterialTheme.typography.labelMedium) }
        }
    }
}

/** 「保存済み」 and the rest; a conflict reopens its choice. */
@Composable
private fun SaveState(saver: CanvasSaver, onOpenConflict: () -> Unit) {
    // Collected here too: the section sheet shows it outside the screen that collects the saver's changes.
    val revision by saver.revision.collectAsState()
    val status = remember(revision) { saver.status }
    val (label, tone) = when (status) {
        CanvasSaveStatus.LOADING -> "読み込み中…" to MaterialTheme.colorScheme.onSurfaceVariant
        CanvasSaveStatus.SAVED -> "保存済み" to MaterialTheme.colorScheme.onSurfaceVariant
        CanvasSaveStatus.EDITING -> "編集中" to MaterialTheme.colorScheme.onSurfaceVariant
        CanvasSaveStatus.SAVING -> "保存中…" to MaterialTheme.colorScheme.onSurfaceVariant
        CanvasSaveStatus.OFFLINE -> "オフライン" to MaterialTheme.colorScheme.tertiary
        CanvasSaveStatus.RETRYING -> "再試行中…" to MaterialTheme.colorScheme.tertiary
        CanvasSaveStatus.CONFLICT, CanvasSaveStatus.EXPIRED -> "競合" to MaterialTheme.colorScheme.error
        CanvasSaveStatus.BLOCKED -> "保存できません" to MaterialTheme.colorScheme.error
        CanvasSaveStatus.GONE -> "ゴミ箱" to MaterialTheme.colorScheme.onSurfaceVariant
    }
    val icon = when (status) {
        CanvasSaveStatus.OFFLINE -> Icons.Outlined.CloudOff
        CanvasSaveStatus.SAVING, CanvasSaveStatus.RETRYING, CanvasSaveStatus.LOADING -> Icons.Outlined.Sync
        CanvasSaveStatus.EDITING -> Icons.Outlined.Edit
        CanvasSaveStatus.CONFLICT, CanvasSaveStatus.EXPIRED, CanvasSaveStatus.BLOCKED -> Icons.Outlined.ErrorOutline
        CanvasSaveStatus.GONE -> Icons.Outlined.Delete
        CanvasSaveStatus.SAVED -> Icons.Outlined.CloudDone
    }
    val choice = status == CanvasSaveStatus.CONFLICT || status == CanvasSaveStatus.EXPIRED
    val hint = when (status) {
        CanvasSaveStatus.OFFLINE -> "オフラインです。つながったら保存します"
        CanvasSaveStatus.RETRYING -> "サーバが混み合っています。自動で保存し直します"
        else -> label
    }
    Row(
        Modifier
            .then(if (choice) Modifier.clickable(role = Role.Button, onClick = onOpenConflict) else Modifier)
            .heightIn(min = 36.dp)
            .padding(horizontal = 6.dp)
            .semantics { contentDescription = "保存の状態: $hint" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = tone, modifier = Modifier.size(15.dp))
        Spacer(Modifier.width(4.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = tone, fontWeight = if (choice) FontWeight.SemiBold else null)
    }
}

/** A line under the bar: why this canvas cannot be changed here, or what happened to it (with 本文をコピー). */
@Composable
private fun CanvasNotice(controller: AppController, channel: ChannelState, rights: CanvasRights, saver: CanvasSaver, status: CanvasSaveStatus) {
    // `status` is passed (not read from the saver here): the saver is the same object throughout, so strong skipping
    // would keep this line as it was drawn while loading (CANVAS.md §5 Android: pass what the composable shows).
    val (text, warn) = when {
        status == CanvasSaveStatus.GONE -> "このキャンバスはゴミ箱に移されたか、見られなくなりました。手元の本文はコピーできます。" to true
        status == CanvasSaveStatus.BLOCKED -> "保存できませんでした: ${saver.error?.let { controller.describe(it) } ?: ""}" to true
        channel.channel.archived -> "アーカイブされた会話のキャンバスは閲覧だけです。" to false
        status == CanvasSaveStatus.LOADING -> return
        rights.tickOnly -> "チェックだけ付けられます。本文を変更できるのは作成者・オーナー・管理者です。" to false
        !rights.tick -> "閲覧のみです。" to false
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
        if (warn) TextButton(onClick = { controller.copyCanvasText(saver.text) }) {
            Icon(Icons.Outlined.ContentCopy, null, modifier = Modifier.size(14.dp))
            Text(" 本文をコピー", style = MaterialTheme.typography.labelMedium)
        }
    }
}

/** The rendered canvas: its title, 「最終更新」, the blocks (boxes that tick), or 「まだ何も書かれていません」. */
@Composable
private fun CanvasReader(
    controller: AppController, saver: CanvasSaver, meta: CanvasMeta?, title: String, rights: CanvasRights,
    onToggle: ((Int, Boolean) -> Unit)?, onEditSection: ((Int) -> Unit)?, listState: LazyListState, modifier: Modifier,
    preview: Boolean, onStartWriting: () -> Unit,
) {
    val revision by saver.revision.collectAsState()
    val text = remember(revision) { saver.text }
    val blocks = remember(text) { parseBlocks(text, canvas = true) }
    val store = controller.store
    val version by store.version.collectAsState()
    val inline = bodyInline(
        store.users, internalBase = controller.serverBase,
        onOpenMessage = { id -> controller.scope.launch { controller.openPermalink(id) } },
        onOpenCanvas = { id -> controller.scope.launch { controller.openCanvasLink(id) } },
        customEmoji = store.customEmoji, emojiImages = store.emojiImages, emojiAnimations = store.emojiAnimations,
        onNeedEmojiImage = { controller.loadEmojiImage(it) }, groups = store.groups, version = version,
    )
    LazyColumn(modifier.semantics { contentDescription = if (preview) "キャンバスのプレビュー" else "キャンバスの内容" }, state = listState, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        item(key = "title") {
            Column(Modifier.canvasColumn()) {
                if (preview) Text("プレビュー", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 6.dp))
                else {
                    Text(title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    if (meta != null) Byline(controller, meta)
                    Spacer(Modifier.height(12.dp))
                }
                if (text.isBlank()) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("まだ何も書かれていません。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (rights.edit && !preview) TextButton(onClick = onStartWriting) { Text("書き始める") }
                    }
                }
            }
        }
        itemsIndexed(blocks) { _, block ->
            Box(Modifier.canvasColumn().padding(vertical = 1.dp)) {
                CanvasBlockView(block, inline, controller, onToggle, onEditSection)
            }
        }
        item(key = "end") { Spacer(Modifier.height(48.dp)) }
    }
}

/** 「最終更新: 名前 · 10:23」, the task progress, the tab and who edits. */
@Composable
private fun Byline(controller: AppController, canvas: CanvasMeta) {
    val who = controller.store.users[canvas.updatedBy]?.displayName ?: "メンバー"
    val progress = CanvasText.taskProgress(canvas.taskTotal, canvas.taskDone)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.padding(top = 2.dp)) {
        val muted = MaterialTheme.colorScheme.onSurfaceVariant
        Text("最終更新: $who · ${YouSettings.lastUsedLabel(canvas.updatedAt)}", style = MaterialTheme.typography.bodySmall, color = muted)
        if (progress != null) Text("✓ $progress", style = MaterialTheme.typography.bodySmall, color = muted)
        if (canvas.isChannelTab) Text("会話のキャンバス", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
        if (canvas.editPolicy == "owners") Text("編集: 作成者・オーナー・管理者", style = MaterialTheme.typography.bodySmall, color = muted)
    }
}

@Composable
private fun OutlineMenu(headings: List<CanvasText.OutlineEntry>, onPick: (CanvasText.OutlineEntry) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) { Icon(Icons.AutoMirrored.Outlined.List, contentDescription = "目次") }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            headings.forEach { entry ->
                DropdownMenuItem(
                    text = { Text(entry.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = ((entry.level - 1) * 12).dp)) },
                    onClick = { open = false; onPick(entry) },
                )
            }
        }
    }
}

@Composable
private fun OutlineColumn(headings: List<CanvasText.OutlineEntry>, modifier: Modifier, onPick: (CanvasText.OutlineEntry) -> Unit) {
    Column(modifier.verticalScroll(rememberScrollState()).padding(vertical = 12.dp)) {
        Text("目次", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        headings.forEach { entry ->
            Text(
                entry.text, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().clickable { onPick(entry) }.padding(start = (16 + (entry.level - 1) * 12).dp, end = 12.dp, top = 6.dp, bottom = 6.dp),
            )
        }
    }
}

// --- the editor ------------------------------------------------------------------------------

/** The stored text the editor last showed or wrote, and the section's lines in it (null: the whole body). */
private class EditorLink(var wire: String, var range: IntRange?)

private val HEADING_IN_SECTION = Regex("""(?m)^#{1,3}\s+\S""")

/**
 * The canvas's Markdown source editor (CANVAS.md §5 「編集」): a text field with a toolbar (heading, bold, lists,
 * checklist, quote, link, mention, rule), list continuation on Enter and `@` completion. Mentions show as `@username` and
 * are stored as `<@uuid>` (§4.2). Every change goes to the save loop; a body the loop replaces (someone else's merged
 * edits) comes back here with the caret kept — never while an IME composition is open (§4.4).
 *
 * `section`: only that section's lines (under its heading) are edited; they are put back into the whole body.
 */
@Composable
private fun CanvasEditorField(
    controller: AppController, saver: CanvasSaver, section: CanvasSections.Key?, modifier: Modifier,
    autoFocus: Boolean = false, onSectionGone: () -> Unit = {},
) {
    val store = controller.store
    fun decode(stored: String) = Mentions.decode(stored, store.users, store.groups)
    fun encode(shown: String) = CanvasText.encodeMentions(shown, store.users.values, store.groups.values)
    /** The part of the stored body this editor shows: the whole, or the section's lines (null: the section is gone). */
    fun window(stored: String): Pair<IntRange?, String>? {
        if (section == null) return null to stored
        val range = CanvasSections.find(stored, section) ?: return null
        return range to CanvasSections.text(stored, range)
    }
    val link = remember(saver, section) { window(saver.text).let { EditorLink(saver.text, it?.first) } }
    var field by remember(saver, section) {
        val shown = decode(window(saver.text)?.second ?: "")
        mutableStateOf(TextFieldValue(shown, TextRange(if (section != null) shown.length else 0)))
    }
    val revision by saver.revision.collectAsState()
    // An IME composition must not have its text replaced under it; nor a section that now holds a heading of its own
    // (it would be cut there). The loop keeps a merged body for later meanwhile.
    DisposableEffect(saver, section) {
        saver.canReplace = { field.composition == null && (section == null || !HEADING_IN_SECTION.containsMatchIn(field.text)) }
        onDispose { saver.canReplace = { true } }
    }
    // The loop replaced the text (a merge, someone else's version, a tick in the preview): show it, the caret kept.
    LaunchedEffect(revision) {
        val stored = saver.text
        if (stored == link.wire) return@LaunchedEffect
        link.wire = stored
        val shown = window(stored)
        if (shown == null) { onSectionGone(); return@LaunchedEffect }
        link.range = shown.first
        val next = decode(shown.second)
        val current = field
        if (next != current.text) {
            field = TextFieldValue(
                next,
                TextRange(CanvasText.preserveCaret(current.text, next, current.selection.min), CanvasText.preserveCaret(current.text, next, current.selection.max)),
            )
        }
    }

    fun commit(shown: String) {
        val encoded = encode(shown)
        val stored = if (section == null) encoded else {
            val range = link.range ?: return
            val lines = if (encoded.isEmpty()) 0 else encoded.split("\n").size
            link.range = range.first until range.first + lines
            CanvasSections.replace(saver.text, range, encoded)
        }
        link.wire = stored
        saver.edit(stored)
    }

    fun change(incoming: TextFieldValue) {
        var next = incoming
        val previous = field
        // Enter in a list, a checklist or a quote goes on with it (a new open box …); on an empty item it ends it.
        val c = previous.selection.start
        if (next.composition == null && previous.selection.collapsed && next.selection.collapsed && next.text.length == previous.text.length + 1 &&
            next.selection.start == c + 1 && next.text[c] == '\n' && next.text.startsWith(previous.text.substring(0, c)) && next.text.endsWith(previous.text.substring(c))
        ) {
            CanvasText.continueStructure(CanvasText.Edit(previous.text, c))?.let { next = TextFieldValue(it.text, TextRange(it.start, it.end)) }
        }
        val changed = next.text != previous.text
        field = next
        if (changed) commit(next.text)
        if (previous.composition != null && next.composition == null) saver.replaceable() // a merge that waited for the IME
    }

    fun apply(transform: (CanvasText.Edit) -> CanvasText.Edit) {
        val current = field
        val result = transform(CanvasText.Edit(current.text, current.selection.min, current.selection.max))
        field = TextFieldValue(result.text, TextRange(result.start, result.end))
        if (result.text != current.text) commit(result.text)
    }

    val focus = remember { FocusRequester() }
    var focused by remember { mutableStateOf(false) }
    LaunchedEffect(autoFocus) { if (autoFocus) runCatching { focus.requestFocus() } }
    val caret = field.selection.start
    val query = if (field.selection.collapsed) Mentions.query(field.text.substring(0, caret.coerceIn(0, field.text.length))) else null
    // `<!channel>` notifies nobody in a canvas (§4.2): @channel / @here are not offered.
    val candidates = query?.let { q -> Mentions.candidates(q, store.users.values, store.groups.values, limit = 8).filter { it.kind != "all" } } ?: emptyList()

    Column(modifier) {
        EditorToolbar(::apply)
        HorizontalDivider()
        if (candidates.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                candidates.forEach { candidate ->
                    Surface(
                        shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.secondaryContainer,
                        modifier = Modifier.clickable {
                            val before = field.text.substring(0, caret)
                            val completed = Mentions.complete(before, candidate.username)
                            apply { CanvasText.Edit(completed + it.text.substring(caret), completed.length) }
                        },
                    ) {
                        Text("@" + candidate.username + "  " + candidate.label, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
                    }
                }
            }
        }
        BasicTextField(
            value = field,
            onValueChange = ::change,
            textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .focusRequester(focus)
                .onFocusChanged { state ->
                    if (focused && !state.isFocused) saver.flush() // leaving the field saves now (the desktop's blur)
                    focused = state.isFocused
                }
                .semantics { contentDescription = if (section == null) "キャンバスの本文 (Markdown)" else "セクションの本文 (Markdown)" }
                .padding(horizontal = 16.dp, vertical = 12.dp),
            decorationBox = { inner ->
                Box {
                    if (field.text.isEmpty()) {
                        Text(
                            if (section == null) "# 見出し\n本文を書きます。\n- [ ] チェックリスト\n@名前 でメンション" else "このセクションの本文",
                            style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    inner()
                }
            },
        )
    }
}

/** 見出し, 太字, 箇条書き, 番号, チェックリスト, 引用, リンク, メンション, 区切り線 (the desktop's toolbar, for a thumb). */
@Composable
private fun EditorToolbar(apply: ((CanvasText.Edit) -> CanvasText.Edit) -> Unit) {
    var headingMenu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Box {
            IconButton(onClick = { headingMenu = true }) { Icon(Icons.Outlined.Title, contentDescription = "見出し") }
            DropdownMenu(expanded = headingMenu, onDismissRequest = { headingMenu = false }) {
                (1..3).forEach { level ->
                    DropdownMenuItem(text = { Text("見出し $level") }, onClick = { headingMenu = false; apply { CanvasText.setHeading(it, level) } })
                }
            }
        }
        IconButton(onClick = { apply { CanvasText.toggleWrap(it, "**") } }) { Icon(Icons.Outlined.FormatBold, contentDescription = "太字") }
        IconButton(onClick = { apply { CanvasText.toggleLinePrefix(it, "- ") } }) { Icon(Icons.AutoMirrored.Outlined.FormatListBulleted, contentDescription = "箇条書き") }
        IconButton(onClick = { apply { CanvasText.toggleTasks(it) } }) { Icon(Icons.Outlined.Checklist, contentDescription = "チェックリスト") }
        IconButton(onClick = { apply { CanvasText.toggleLinePrefix(it, "1. ") } }) { Icon(Icons.Outlined.FormatListNumbered, contentDescription = "番号付きリスト") }
        IconButton(onClick = { apply { CanvasText.toggleLinePrefix(it, "> ") } }) { Icon(Icons.Outlined.FormatQuote, contentDescription = "引用") }
        IconButton(onClick = { apply { CanvasText.insertLink(it) } }) { Icon(Icons.Outlined.Link, contentDescription = "リンク") }
        IconButton(onClick = { apply { CanvasText.insertMention(it) } }) { Icon(Icons.Outlined.AlternateEmail, contentDescription = "メンション") }
        IconButton(onClick = { apply { CanvasText.insertRule(it) } }) { Icon(Icons.Outlined.HorizontalRule, contentDescription = "区切り線") }
    }
}

/** 「このセクションを編集」: the lines under one heading in a sheet (the rest of the canvas stays as it is). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SectionSheet(controller: AppController, saver: CanvasSaver, key: CanvasSections.Key, onDismiss: () -> Unit) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val heading = key.heading.replace(Regex("""^#{1,3}\s+"""), "")
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.92f).imePadding()) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("セクションを編集", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(heading, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                SaveState(saver, onOpenConflict = onDismiss)
                TextButton(onClick = onDismiss) { Text("完了") }
            }
            CanvasEditorField(controller, saver, key, Modifier.fillMaxWidth().weight(1f), autoFocus = true, onSectionGone = {
                controller.notice = "見出しが変わったため、セクションの編集を閉じました"
                onDismiss()
            })
        }
    }
}

// --- the list, the menu, the dialogs -----------------------------------------------------------

/** The canvas's name as a button opens this: the conversation's canvases, a new one, the trash. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CanvasListSheet(
    controller: AppController, list: List<CanvasMeta>, currentId: String?, version: Int,
    onDismiss: () -> Unit, onPick: (String) -> Unit, onNew: (() -> Unit)?, onTrash: () -> Unit,
) {
    val store = controller.store
    val names = remember(version, list) { list.associate { it.id to (store.users[it.updatedBy]?.displayName ?: "メンバー") } }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
            Text("この会話のキャンバス", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            LazyColumn(Modifier.heightIn(max = 420.dp)) {
                items(list, key = { it.id }) { canvas ->
                    val progress = CanvasText.taskProgress(canvas.taskTotal, canvas.taskDone)
                    ListItem(
                        headlineContent = { Text(canvas.title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = if (canvas.id == currentId) FontWeight.SemiBold else null) },
                        supportingContent = {
                            Text(
                                names[canvas.id].orEmpty() + " · " + YouSettings.lastUsedLabel(canvas.updatedAt),
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        },
                        leadingContent = { Icon(Icons.Outlined.Description, null, tint = if (canvas.id == currentId) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant) },
                        trailingContent = {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                if (canvas.isChannelTab) Text("タブ", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                                if (progress != null) Text(progress, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        },
                        modifier = Modifier.clickable { onPick(canvas.id) },
                    )
                }
            }
            HorizontalDivider(Modifier.padding(vertical = 4.dp))
            if (onNew != null) ListItem(headlineContent = { Text("新しいキャンバス") }, leadingContent = { Icon(Icons.Outlined.Add, null) }, modifier = Modifier.clickable(onClick = onNew))
            ListItem(headlineContent = { Text("ゴミ箱") }, leadingContent = { Icon(Icons.Outlined.Delete, null) }, modifier = Modifier.clickable(onClick = onTrash))
        }
    }
}

/** ⋮: title, who edits (not in a DM), the conversation's tab, the history, copy, the trash (CANVAS.md §4.7). */
@Composable
private fun CanvasMenu(
    controller: AppController, channel: ChannelState, canvas: CanvasMeta, rights: CanvasRights, saver: CanvasSaver, status: CanvasSaveStatus,
    onRename: () -> Unit, onHistory: () -> Unit, onTrashed: () -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    var confirmTrash by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val gone = status == CanvasSaveStatus.GONE
    val tabTaken = (controller.store.canvasesOf(channel.id) ?: emptyList()).any { it.isChannelTab && it.id != canvas.id }
    Box {
        IconButton(onClick = { open = true }) { Icon(Icons.Outlined.MoreVert, contentDescription = "キャンバスの操作") }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            if (rights.manage && !gone) {
                DropdownMenuItem(text = { Text("題名を変更…") }, onClick = { open = false; onRename() })
                if (!tabTaken) DropdownMenuItem(
                    text = { Text(if (canvas.isChannelTab) "会話のキャンバスから外す" else "会話のキャンバスにする") },
                    onClick = { open = false; scope.launch { controller.updateCanvas(canvas.id, isChannelTab = !canvas.isChannelTab) } },
                )
                if (!channel.channel.isDm) {
                    HorizontalDivider()
                    Text("本文を編集できる人", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
                    listOf("members" to "投稿できるメンバー全員", "owners" to "作成者・オーナー・管理者 (チェックは全員)").forEach { (value, label) ->
                        DropdownMenuItem(
                            text = { Text((if (canvas.editPolicy == value) "✓ " else "    ") + label) },
                            onClick = { open = false; if (canvas.editPolicy != value) scope.launch { controller.updateCanvas(canvas.id, editPolicy = value) } },
                        )
                    }
                }
                HorizontalDivider()
            }
            DropdownMenuItem(text = { Text("履歴") }, leadingIcon = { Icon(Icons.Outlined.History, null) }, onClick = { open = false; onHistory() })
            DropdownMenuItem(text = { Text("本文をコピー") }, leadingIcon = { Icon(Icons.Outlined.ContentCopy, null) }, onClick = { open = false; controller.copyCanvasText(saver.text) })
            if (rights.trash && !gone) {
                HorizontalDivider()
                DropdownMenuItem(
                    text = { Text("ゴミ箱に移す", color = MaterialTheme.colorScheme.error) },
                    leadingIcon = { Icon(Icons.Outlined.Delete, null, tint = MaterialTheme.colorScheme.error) },
                    onClick = { open = false; confirmTrash = true },
                )
            }
        }
    }
    if (confirmTrash) {
        AlertDialog(
            onDismissRequest = { confirmTrash = false },
            title = { Text("ゴミ箱に移しますか？") },
            text = { Text("「${canvas.title}」をゴミ箱に移します。30 日以内ならゴミ箱から戻せます。") },
            confirmButton = {
                TextButton(onClick = {
                    confirmTrash = false
                    scope.launch { if (controller.trashCanvas(canvas.id, channel.id)) onTrashed() }
                }) { Text("ゴミ箱に移す", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmTrash = false }) { Text("キャンセル") } },
        )
    }
}

@Composable
private fun RenameDialog(controller: AppController, canvas: CanvasMeta, onDismiss: () -> Unit) {
    var title by rememberSaveable(canvas.id) { mutableStateOf(canvas.title) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("題名を変更") },
        text = { OutlinedTextField(title, { title = it.take(200) }, singleLine = true, label = { Text("題名") }) },
        confirmButton = {
            TextButton(enabled = !busy && title.isNotBlank(), onClick = {
                val trimmed = title.trim()
                if (trimmed == canvas.title) { onDismiss(); return@TextButton }
                busy = true
                scope.launch {
                    val ok = controller.updateCanvas(canvas.id, title = trimmed)
                    busy = false
                    if (ok) onDismiss()
                }
            }) { Text("変更") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
}

/** A new canvas: empty or from a template (§4.12); the conversation's tab when it has none. */
@Composable
private fun NewCanvasDialog(controller: AppController, channel: ChannelState, list: List<CanvasMeta>, onDismiss: () -> Unit, onCreated: (CanvasOut) -> Unit) {
    var templates by remember { mutableStateOf<List<CanvasTemplateOut>?>(null) }
    var choice by rememberSaveable { mutableStateOf("") }
    var title by rememberSaveable { mutableStateOf("") }
    val hasTab = list.any { it.isChannelTab }
    var asTab by rememberSaveable { mutableStateOf(!hasTab) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { templates = controller.canvasTemplates() ?: emptyList() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("新しいキャンバス") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text("空白から、またはテンプレートから作ります。日付や名前はテンプレートに入ります。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(8.dp))
                @Composable
                fun option(key: String, name: String, description: String?) {
                    Row(
                        Modifier.fillMaxWidth().selectable(selected = choice == key, role = Role.RadioButton, onClick = { choice = key }).padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = choice == key, onClick = null)
                        Spacer(Modifier.width(8.dp))
                        Column {
                            Text(name, style = MaterialTheme.typography.bodyMedium)
                            if (description != null) Text(description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                option("", "空白のキャンバス", null)
                val loaded = templates
                if (loaded == null) Text("テンプレートを読み込んでいます…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                else loaded.forEach { option(it.key, it.name, it.description) }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    title, { title = it.take(200) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    label = { Text("題名") },
                    placeholder = { Text(if (choice.isNotEmpty()) "空欄ならテンプレートの題名" else "空欄なら「無題のキャンバス」") },
                )
                if (!hasTab) {
                    Row(Modifier.fillMaxWidth().selectable(selected = asTab, role = Role.Checkbox, onClick = { asTab = !asTab }).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = asTab, onCheckedChange = null)
                        Spacer(Modifier.width(8.dp))
                        Text("会話のキャンバスにする (「キャンバス」タブで最初に開きます)", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy, onClick = {
                busy = true
                scope.launch {
                    val created = controller.createCanvas(channel.id, choice.ifEmpty { null }, title.trim().ifEmpty { null }, asTab && !hasTab)
                    busy = false
                    if (created != null) onCreated(created)
                }
            }) { Text("作成") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
}

/** The conversation's trash: canvases moved there (restorable; the server purges them after 30 days). */
@Composable
private fun TrashDialog(controller: AppController, channel: ChannelState, onDismiss: () -> Unit, onRestored: (CanvasOut) -> Unit) {
    var rows by remember { mutableStateOf<List<CanvasMeta>?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(channel.id) { rows = controller.trashedCanvases(channel.id) ?: emptyList() }
    val me = controller.store.me
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("キャンバスのゴミ箱") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text("ゴミ箱のキャンバスは 30 日後に完全に削除されます。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(8.dp))
                val loaded = rows
                when {
                    loaded == null -> Text("読み込み中…", style = MaterialTheme.typography.bodyMedium)
                    loaded.isEmpty() -> Text("ゴミ箱は空です。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    else -> loaded.forEach { canvas ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(canvas.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text("削除: " + YouSettings.lastUsedLabel(canvas.deletedAt), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            if (CanvasRights.of(channel, me?.id, me?.role, canvas).trash) {
                                OutlinedButton(onClick = { scope.launch { controller.restoreCanvas(canvas.id)?.let(onRestored) } }) {
                                    Icon(Icons.Outlined.Restore, null, modifier = Modifier.size(16.dp))
                                    Text(" 戻す")
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
    )
}

/** §4.4 409 canvas_conflict: where both changed the same words, and the choices (a ticker only takes theirs). */
@Composable
private fun ConflictDialog(controller: AppController, saver: CanvasSaver, tickOnly: Boolean, conflicts: List<CanvasConflict>, timedOut: Boolean, onDismiss: () -> Unit) {
    val store = controller.store
    fun names(text: String) = Mentions.toNames(text, store.users, store.groups)
    val shown = conflicts.take(5)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("同じ箇所がほかの人にも変更されました") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(
                    if (tickOnly) "相手の版を残して、チェックを付け直してください。" else "重なった箇所だけ、どちらを残すか選んでください。ほかの変更はどちらも残ります。",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (timedOut) Text("文書が大きく、細かく比べられませんでした。文書全体をひとつの箇所として扱います。", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp))
                shown.forEach { conflict ->
                    Column(
                        Modifier.fillMaxWidth().padding(top = 10.dp)
                            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f), RoundedCornerShape(8.dp)).padding(8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        ConflictSide("自分の版", names(conflict.ours), mine = true)
                        ConflictSide("相手の版", names(conflict.theirs), mine = false)
                        if (conflict.base.isNotBlank()) Text("元の文: " + names(conflict.base).take(200), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (conflicts.size > shown.size) Text("ほか ${conflicts.size - shown.size} 箇所", style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 6.dp))
            }
        },
        confirmButton = {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End)) {
                TextButton(onClick = onDismiss) { Text("あとで") }
                if (!tickOnly) TextButton(onClick = { onDismiss(); saver.resolveConflict("both") }) { Text("両方残す") }
                TextButton(onClick = { onDismiss(); saver.resolveConflict("theirs") }) { Text("相手の版") }
                if (!tickOnly) Button(onClick = { onDismiss(); saver.resolveConflict("ours") }) { Text("自分の版") }
            }
        },
    )
}

@Composable
private fun ConflictSide(label: String, text: String, mine: Boolean) {
    Column(
        Modifier.fillMaxWidth()
            .background(if (mine) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.6f) else MaterialTheme.colorScheme.surface, RoundedCornerShape(6.dp))
            .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Text(label, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(text.ifEmpty { "(削除)" }, style = MaterialTheme.typography.bodyMedium)
    }
}

/** §4.4 409 canvas_base_expired: mine and the current body one above the other. */
@Composable
private fun ExpiredDialog(controller: AppController, saver: CanvasSaver, head: CanvasOut, canOverwrite: Boolean, onDismiss: () -> Unit) {
    val store = controller.store
    fun names(text: String) = Mentions.toNames(text, store.users, store.groups)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("編集の元にした版がなくなりました") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("長くオフラインだった間に版が整理されました。自分の本文と今の本文を見比べて選んでください。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                ConflictSide("自分の本文", names(saver.text), mine = true)
                ConflictSide("今の本文", names(head.body), mine = false)
            }
        },
        confirmButton = {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End)) {
                TextButton(onClick = { controller.copyCanvasText(saver.text) }) { Text("自分の本文をコピー") }
                TextButton(onClick = { onDismiss(); saver.resolveExpired(mine = false) }) { Text("今の本文にする") }
                if (canOverwrite) Button(onClick = { onDismiss(); saver.resolveExpired(mine = true) }) { Text("自分の本文で上書き") }
            }
        },
    )
}

private fun revisionKind(kind: String): String = when (kind) {
    "create" -> "作成"
    "save" -> "保存"
    "merge" -> "マージ"
    "restore" -> "復元"
    "erased" -> "消去済み"
    else -> kind
}

/** The history, read only (M46; the desktop's M44 dialog also compares, restores and labels): versions, and one version. */
@Composable
private fun HistoryDialog(controller: AppController, canvas: CanvasMeta, onDismiss: () -> Unit) {
    var rows by remember { mutableStateOf<List<CanvasRevisionMeta>?>(null) }
    var shown by remember { mutableStateOf<CanvasRevisionOut?>(null) }
    val scope = rememberCoroutineScope()
    val store = controller.store
    LaunchedEffect(canvas.id) { rows = controller.canvasRevisions(canvas.id) ?: emptyList() }
    val revision = shown
    if (revision != null) {
        val version by store.version.collectAsState()
        val inline = bodyInline(store.users, customEmoji = store.customEmoji, emojiImages = store.emojiImages, emojiAnimations = store.emojiAnimations, groups = store.groups, version = version)
        val blocks = remember(revision.id) { parseBlocks(revision.body, canvas = true) }
        AlertDialog(
            onDismissRequest = { shown = null },
            title = { Text(revision.label ?: ("版 " + (revision.version?.toString() ?: ""))) },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    Text(
                        (store.users[revision.authorId]?.displayName ?: "メンバー") + " · " + YouSettings.lastUsedLabel(revision.createdAt) + " · " + revisionKind(revision.kind),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(8.dp))
                    if (revision.kind == "erased") Text("この版の本文は消去されています", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    else blocks.forEach { CanvasBlockView(it, inline, controller, onToggle = null, onEditSection = null) }
                }
            },
            confirmButton = { TextButton(onClick = { shown = null }) { Text("戻る") } },
        )
        return
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("履歴") },
        text = {
            val loaded = rows
            when {
                loaded == null -> Text("読み込み中…")
                loaded.isEmpty() -> Text("版はありません。", color = MaterialTheme.colorScheme.onSurfaceVariant)
                else -> LazyColumn(Modifier.heightIn(max = 460.dp)) {
                    items(loaded, key = { it.id }) { row ->
                        ListItem(
                            headlineContent = {
                                Text((store.users[row.authorId]?.displayName ?: "メンバー") + " · " + YouSettings.lastUsedLabel(row.createdAt), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            },
                            supportingContent = {
                                Text(
                                    listOfNotNull(revisionKind(row.kind), row.label?.let { "「$it」" }, "+${row.linesAdded} −${row.linesRemoved} 行").joinToString(" · "),
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            },
                            modifier = Modifier.clickable(enabled = row.kind != "erased") { scope.launch { shown = controller.canvasRevision(canvas.id, row.id) } },
                        )
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
    )
}
