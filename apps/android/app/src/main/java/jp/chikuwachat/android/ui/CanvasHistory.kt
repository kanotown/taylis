package jp.chikuwachat.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.automirrored.outlined.Label
import androidx.compose.material.icons.outlined.Restore
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import jp.chikuwachat.android.api.CanvasMeta
import jp.chikuwachat.android.api.CanvasRevisionMeta
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/*
 * M58 (CANVAS.md §4.9, the desktop's M44 CanvasHistory.tsx): a canvas's history, full screen. The versions newest first
 * (who, when, the kind, lines added / removed, the name given to it, 「現在の版」); one of them compared with the version
 * before it (the default) or with the current one — lines added and removed, the words of a line only touched up — or
 * shown as it was. A version can be made the current one again (a new version: nothing is lost), named (「提出版」),
 * and — by the conversation's owners and administrators, in a DM its creator — have its body erased. Everyone who reads
 * the canvas reads its history. A phone shows the list, then the version; from 840 dp the two sit side by side.
 */

private val KIND_LABELS = mapOf(
    "create" to "作成",
    "save" to "編集",
    "merge" to "同時編集をまとめた版",
    "side" to "送信した版",
    "restore" to "復元",
    "erased" to "本文を消去",
)

/** The kind of a version as the history names it. */
fun revisionKindLabel(kind: String): String = KIND_LABELS[kind] ?: kind

private const val VIEW_PREVIOUS = "previous"
private const val VIEW_CURRENT = "current"
private const val VIEW_BODY = "body"

private val WIDE = 840.dp
private val ADDED = Color(0xFF2E9E5B)
private val REMOVED = Color(0xFFD14343)

@Composable
fun CanvasHistoryDialog(controller: AppController, canvas: CanvasMeta, rights: CanvasRights, onDismiss: () -> Unit) {
    val store = controller.store
    val scope = rememberCoroutineScope()
    var items by remember(canvas.id) { mutableStateOf<List<CanvasRevisionMeta>?>(null) }
    var cursor by remember(canvas.id) { mutableStateOf<String?>(null) }
    var failed by remember(canvas.id) { mutableStateOf(false) }
    var tries by remember(canvas.id) { mutableIntStateOf(0) }
    var selectedId by rememberSaveable(canvas.id) { mutableStateOf<String?>(null) }
    var view by rememberSaveable(canvas.id) { mutableStateOf(VIEW_PREVIOUS) }
    val bodies = remember(canvas.id) { mutableStateMapOf<String, String>() }
    var confirmRestore by remember { mutableStateOf<CanvasRevisionMeta?>(null) }
    var confirmErase by remember { mutableStateOf<CanvasRevisionMeta?>(null) }
    var labelling by remember { mutableStateOf<CanvasRevisionMeta?>(null) }
    var busy by remember { mutableStateOf(false) }
    val headId = canvas.headRevId

    suspend fun load(more: Boolean) {
        val page = controller.canvasRevisions(canvas.id, if (more) cursor else null)
        if (page == null) {
            if (!more) failed = true
            return
        }
        failed = false
        items = if (more) (items ?: emptyList()) + page.items else page.items
        cursor = page.nextCursor
    }
    // Read again when the canvas gets a new version (a restore here, someone's save meanwhile).
    LaunchedEffect(canvas.id, headId, tries) { load(false) }

    val list = items ?: emptyList()
    val index = list.indexOfFirst { it.id == selectedId }
    val selected = list.getOrNull(index)
    val previousId = if (selected != null) CanvasDiff.previousId(list, index) else null
    val otherId = when (view) {
        VIEW_CURRENT -> headId
        VIEW_PREVIOUS -> previousId
        else -> null
    }
    // Bodies are read as they are needed, once each.
    LaunchedEffect(selected?.id, selected?.kind, otherId) {
        if (selected == null || selected.kind == "erased") return@LaunchedEffect
        for (id in listOfNotNull(selected.id, otherId)) {
            if (bodies.containsKey(id) || list.firstOrNull { it.id == id }?.kind == "erased") continue
            controller.canvasRevision(canvas.id, id)?.let { bodies[id] = it.body }
        }
    }
    val selectedBody = selected?.let { bodies[it.id] }
    val otherBody = otherId?.let { bodies[it] } ?: if (view == VIEW_PREVIOUS && selected != null) "" else null
    val rows by produceState<List<CanvasDiff.Row>?>(null, view, selectedBody, otherBody) {
        value = null
        if (view == VIEW_BODY || selectedBody == null || otherBody == null) return@produceState
        // Previous → this version; this version → the current one. Mentions as names (`<@uuid>` reads as nothing).
        val (from, to) = if (view == VIEW_PREVIOUS) otherBody to selectedBody else selectedBody to otherBody
        value = withContext(Dispatchers.Default) {
            CanvasDiff.rows(CanvasDiff.lines(Mentions.toNames(from, store.users, store.groups), Mentions.toNames(to, store.users, store.groups)))
        }
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val window = LocalView.current
        val lightBars = !isSystemInDarkTheme()
        SideEffect {
            (window.parent as? DialogWindowProvider)?.window?.let { w ->
                WindowCompat.getInsetsController(w, window).apply {
                    isAppearanceLightStatusBars = lightBars
                    isAppearanceLightNavigationBars = lightBars
                }
            }
        }
        Surface(Modifier.fillMaxSize()) {
            BoxWithConstraints(Modifier.fillMaxSize().systemBarsPadding()) {
                val wide = maxWidth >= WIDE
                // A phone: back from a version returns to the list.
                BackHandler(enabled = !wide && selected != null) { selectedId = null }
                Column(Modifier.fillMaxSize()) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (!wide && selected != null) {
                            IconButton(onClick = { selectedId = null }) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "版の一覧に戻る") }
                        } else {
                            IconButton(onClick = onDismiss) { Icon(Icons.Outlined.Close, contentDescription = "閉じる") }
                        }
                        Column(Modifier.weight(1f)) {
                            Text("履歴", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
                            Text(canvas.title, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    HorizontalDivider()
                    val showList = wide || selected == null
                    val showDetail = wide || selected != null
                    Row(Modifier.fillMaxSize()) {
                        if (showList) {
                            RevisionList(
                                controller, items, failed, cursor != null, headId, selectedId,
                                modifier = if (wide) Modifier.width(320.dp).fillMaxHeight() else Modifier.fillMaxSize(),
                                onRetry = { tries += 1 },
                                onMore = { scope.launch { load(true) } },
                                onSelect = { selectedId = it.id },
                            )
                        }
                        if (wide) VerticalDivider()
                        if (showDetail) {
                            Column(Modifier.weight(1f).fillMaxHeight()) {
                                if (selected == null) {
                                    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                                        Icon(Icons.Outlined.History, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                                        Spacer(Modifier.width(6.dp))
                                        Text("版を選んでください", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                } else {
                                    RevisionDetail(
                                        controller, selected, selected.id == headId, rights, view, onView = { view = it },
                                        selectedBody, rows, otherErased = otherId != null && list.firstOrNull { it.id == otherId }?.kind == "erased",
                                        busy = busy,
                                        onLabel = { labelling = selected },
                                        onErase = { confirmErase = selected },
                                        onRestore = { confirmRestore = selected },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }

        confirmRestore?.let { revision ->
            AlertDialog(
                onDismissRequest = { confirmRestore = null },
                title = { Text("この版に戻しますか？") },
                text = { Text("${Timeline.fullLabel(revision.createdAt)} の版の本文を、新しい版として保存します。今の本文も履歴に残ります。") },
                confirmButton = {
                    Button(enabled = !busy, onClick = {
                        busy = true
                        scope.launch {
                            val restored = controller.restoreCanvasRevision(canvas.id, revision.id)
                            busy = false
                            confirmRestore = null
                            if (restored != null) {
                                controller.notice = "この版を復元しました"
                                selectedId = restored.headRevId
                                view = VIEW_PREVIOUS
                            }
                        }
                    }) { Text("この版に戻す") }
                },
                dismissButton = { TextButton(onClick = { confirmRestore = null }) { Text("キャンセル") } },
            )
        }
        confirmErase?.let { revision ->
            AlertDialog(
                onDismissRequest = { confirmErase = null },
                title = { Text("この版の本文を消去しますか？") },
                text = { Text("誤って書いた秘密などを履歴から消します。消した本文は戻せません。消去したことは監査ログに残ります。") },
                confirmButton = {
                    TextButton(enabled = !busy, onClick = {
                        busy = true
                        scope.launch {
                            val erased = controller.eraseCanvasRevision(canvas.id, revision.id)
                            busy = false
                            confirmErase = null
                            if (erased != null) {
                                items = items?.map { if (it.id == erased.id) erased else it }
                                bodies.remove(revision.id)
                            }
                        }
                    }) { Text("消去する", color = MaterialTheme.colorScheme.error) }
                },
                dismissButton = { TextButton(onClick = { confirmErase = null }) { Text("キャンセル") } },
            )
        }
        labelling?.let { revision ->
            LabelDialog(revision, busy, onDismiss = { labelling = null }) { label ->
                busy = true
                scope.launch {
                    val named = controller.labelCanvasRevision(canvas.id, revision.id, label)
                    busy = false
                    if (named != null) {
                        labelling = null
                        items = items?.map { if (it.id == named.id) named else it }
                    }
                }
            }
        }
    }
}

@Composable
private fun RevisionList(
    controller: AppController, items: List<CanvasRevisionMeta>?, failed: Boolean, hasMore: Boolean, headId: String, selectedId: String?,
    modifier: Modifier, onRetry: () -> Unit, onMore: () -> Unit, onSelect: (CanvasRevisionMeta) -> Unit,
) {
    val store = controller.store
    val version by store.version.collectAsState()
    LazyColumn(modifier.semantics { contentDescription = "版の一覧" }) {
        when {
            failed && items == null -> item(key = "failed") {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("読み込めませんでした。", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(onClick = onRetry) { Text("再読み込み") }
                }
            }
            items == null -> item(key = "loading") {
                Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) }
            }
            items.isEmpty() -> item(key = "empty") { Text("版はありません。", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp)) }
            else -> items(items, key = { it.id }) { revision ->
                val author = remember(version, revision.authorId) { store.users[revision.authorId]?.displayName ?: "メンバー" }
                val current = revision.id == headId
                Row(
                    Modifier.fillMaxWidth()
                        .background(if (revision.id == selectedId) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
                        .clickable(onClickLabel = "この版を見る") { onSelect(revision) }
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                ) {
                    Avatar(revision.authorId, author, size = 28.dp)
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(author, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                            if (current) {
                                Spacer(Modifier.width(6.dp))
                                Surface(shape = RoundedCornerShape(4.dp), color = MaterialTheme.colorScheme.primaryContainer) {
                                    Text("現在の版", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp))
                                }
                            }
                        }
                        Text(
                            Timeline.fullLabel(revision.createdAt) + " · " + revisionKindLabel(revision.kind),
                            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if ((revision.kind != "erased" && (revision.linesAdded > 0 || revision.linesRemoved > 0)) || revision.label != null) {
                            Row(Modifier.padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                if (revision.kind != "erased" && (revision.linesAdded > 0 || revision.linesRemoved > 0)) {
                                    Text(
                                        buildAnnotatedString {
                                            withStyle(SpanStyle(color = ADDED)) { append("+${revision.linesAdded}") }
                                            append(" ")
                                            withStyle(SpanStyle(color = REMOVED)) { append("−${revision.linesRemoved}") }
                                        },
                                        style = MaterialTheme.typography.labelSmall,
                                        modifier = Modifier.semantics { contentDescription = "${revision.linesAdded} 行追加、${revision.linesRemoved} 行削除" },
                                    )
                                }
                                revision.label?.let { label ->
                                    Surface(shape = RoundedCornerShape(4.dp), color = MaterialTheme.colorScheme.tertiaryContainer) {
                                        Row(Modifier.padding(horizontal = 6.dp, vertical = 1.dp), verticalAlignment = Alignment.CenterVertically) {
                                            Icon(Icons.AutoMirrored.Outlined.Label, null, modifier = Modifier.size(11.dp), tint = MaterialTheme.colorScheme.onTertiaryContainer)
                                            Spacer(Modifier.width(3.dp))
                                            Text(label, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.onTertiaryContainer)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                HorizontalDivider()
            }
        }
        if (hasMore) item(key = "more") {
            Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) { OutlinedButton(onClick = onMore) { Text("さらに読み込む") } }
        }
    }
}

@Composable
private fun RevisionDetail(
    controller: AppController, revision: CanvasRevisionMeta, current: Boolean, rights: CanvasRights, view: String, onView: (String) -> Unit,
    body: String?, rows: List<CanvasDiff.Row>?, otherErased: Boolean, busy: Boolean,
    onLabel: () -> Unit, onErase: () -> Unit, onRestore: () -> Unit,
) {
    val erased = revision.kind == "erased"
    Column(Modifier.fillMaxSize()) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
            listOf(VIEW_PREVIOUS to "前の版との差分", VIEW_CURRENT to "現在の版との差分", VIEW_BODY to "この版の本文").forEachIndexed { index, (value, label) ->
                SegmentedButton(selected = view == value, onClick = { onView(value) }, shape = SegmentedButtonDefaults.itemShape(index, 3), icon = {}) {
                    Text(label, style = MaterialTheme.typography.labelSmall, maxLines = 1)
                }
            }
        }
        if (!erased && (rights.edit || rights.erase)) {
            FlowRow(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (rights.edit) OutlinedButton(onClick = onLabel, enabled = !busy) {
                    Icon(Icons.AutoMirrored.Outlined.Label, null, modifier = Modifier.size(16.dp))
                    Text(if (revision.label != null) " 名前を変更" else " 名前を付ける")
                }
                if (rights.erase && !current) OutlinedButton(onClick = onErase, enabled = !busy) {
                    Icon(Icons.Outlined.Delete, null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.error)
                    Text(" 本文を消去", color = MaterialTheme.colorScheme.error)
                }
                if (rights.edit && !current) Button(onClick = onRestore, enabled = !busy) {
                    Icon(Icons.Outlined.Restore, null, modifier = Modifier.size(16.dp))
                    Text(" この版に戻す")
                }
            }
        }
        HorizontalDivider(Modifier.padding(top = 8.dp))
        val muted = MaterialTheme.colorScheme.onSurfaceVariant
        when {
            erased -> Text("この版の本文は消去されています。", color = muted, modifier = Modifier.padding(16.dp))
            view == VIEW_CURRENT && current -> Text("これが現在の版です。", color = muted, modifier = Modifier.padding(16.dp))
            view == VIEW_BODY -> if (body == null) Loading() else RevisionBody(controller, body)
            rows == null -> if (otherErased) Text("比べる版の本文は消去されています。", color = muted, modifier = Modifier.padding(16.dp)) else Loading()
            else -> DiffView(rows)
        }
    }
}

@Composable
private fun Loading() {
    Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) }
}

/** A version as it read (its boxes do not tick). */
@Composable
private fun RevisionBody(controller: AppController, body: String) {
    val store = controller.store
    val version by store.version.collectAsState()
    val inline = bodyInline(store.users, customEmoji = store.customEmoji, emojiImages = store.emojiImages, emojiAnimations = store.emojiAnimations, groups = store.groups, version = version)
    val blocks = remember(body) { parseBlocks(body, canvas = true) }
    LazyColumn(Modifier.fillMaxSize().semantics { contentDescription = "この版の本文" }, contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp)) {
        if (body.isBlank()) item { Text("まだ何も書かれていません。", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        itemsIndexed(blocks) { _, block -> Box(Modifier.padding(vertical = 1.dp)) { CanvasBlockView(block, inline, controller, onToggle = null, onEditSection = null) } }
    }
}

/** The comparison: removed lines red, added green, the changed words of a touched-up line marked; kept stretches folded. */
@Composable
private fun DiffView(rows: List<CanvasDiff.Row>) {
    val lines = remember(rows) { rows.mapNotNull { (it as? CanvasDiff.Row.Text)?.line } }
    val (added, removed) = remember(lines) { CanvasDiff.counts(lines) }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    if (added == 0 && removed == 0) {
        Text("違いはありません。", color = muted, modifier = Modifier.padding(16.dp))
        return
    }
    LazyColumn(Modifier.fillMaxSize().semantics { contentDescription = "差分" }, contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 8.dp)) {
        item(key = "counts") {
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(color = ADDED)) { append("+$added 行") }
                    append(" · ")
                    withStyle(SpanStyle(color = REMOVED)) { append("−$removed 行") }
                },
                style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
        }
        itemsIndexed(rows) { _, row ->
            when (row) {
                is CanvasDiff.Row.Skip -> Text(
                    "… ${row.count} 行 …", style = MaterialTheme.typography.labelSmall, color = muted,
                    modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)).padding(horizontal = 16.dp, vertical = 2.dp),
                )
                is CanvasDiff.Row.Text -> DiffLineRow(row.line)
            }
        }
    }
}

@Composable
private fun DiffLineRow(line: CanvasDiff.Line) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val (sign, tone, background) = when (line.kind) {
        CanvasDiff.Kind.ADD -> Triple("+", ADDED, ADDED.copy(alpha = 0.12f))
        CanvasDiff.Kind.DEL -> Triple("−", REMOVED, REMOVED.copy(alpha = 0.10f))
        CanvasDiff.Kind.SAME -> Triple("", muted, Color.Transparent)
    }
    val text = buildAnnotatedString {
        val words = line.words
        if (words != null) {
            for (piece in words) {
                if (!piece.changed) append(piece.text)
                else withStyle(
                    if (line.kind == CanvasDiff.Kind.ADD) SpanStyle(background = ADDED.copy(alpha = 0.35f))
                    else SpanStyle(background = REMOVED.copy(alpha = 0.30f), textDecoration = TextDecoration.LineThrough),
                ) { append(piece.text) }
            }
        } else if (line.kind == CanvasDiff.Kind.DEL) {
            withStyle(SpanStyle(color = muted, textDecoration = TextDecoration.LineThrough)) { append(line.text) }
        } else append(line.text.ifEmpty { " " })
    }
    Row(
        Modifier.fillMaxWidth().background(background).padding(horizontal = 8.dp, vertical = 1.dp)
            .semantics { contentDescription = (if (line.kind == CanvasDiff.Kind.ADD) "追加: " else if (line.kind == CanvasDiff.Kind.DEL) "削除: " else "") + line.text },
    ) {
        Text(sign, color = tone, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(16.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
    }
}

/** 「版に名前を付ける」: named versions are kept however old they get (§4.9); empty takes the name off. */
@Composable
private fun LabelDialog(revision: CanvasRevisionMeta, busy: Boolean, onDismiss: () -> Unit, onSave: (String?) -> Unit) {
    var label by rememberSaveable(revision.id) { mutableStateOf(revision.label ?: "") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("版に名前を付ける") },
        text = {
            Column {
                Text("「提出版」「ゼミ発表前」のように名前を付けた版は、古くなっても整理されずに残ります。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.size(8.dp))
                OutlinedTextField(label, { label = it.take(80) }, singleLine = true, placeholder = { Text("提出版") }, label = { Text("版の名前") }, modifier = Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End)) {
                if (revision.label != null) TextButton(enabled = !busy, onClick = { onSave(null) }) { Text("名前を外す") }
                TextButton(onClick = onDismiss) { Text("キャンセル") }
                TextButton(enabled = !busy && label.isNotBlank(), onClick = { onSave(label.trim()) }) { Text("保存") }
            }
        },
    )
}
