package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.EmojiEmotions
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.PushPin
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.graphics.Color
import kotlinx.coroutines.flow.collectLatest
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.launch

@Composable
fun ChannelPane(controller: AppController, channelId: String, version: Int, onOpenThread: (String) -> Unit = {}) {
    val store = controller.store
    val channel = store.channel(channelId) ?: return
    val focus = controller.messageFocus?.takeIf { it.channelId == channelId }
    val messages = remember(version, channelId, focus) {
        focus?.context?.map { message ->
            store.message(channelId, message.id)?.takeIf { it.updatedSeq >= message.updatedSeq } ?: message
        }?.filter { !it.deleted } ?: store.messages(channelId)
    }
    var loadingOlder by remember(channelId) { mutableStateOf(false) }
    var positioned by remember(channelId, focus?.messageId) { mutableStateOf(false) }
    // The 「新着メッセージ」 divider stays where it was when the channel was opened.
    var unreadMark by remember(channelId) { mutableStateOf(channel.lastReadSeq.takeIf { channel.unreadCount > 0 }) }
    val heldUnread = controller.engine?.heldUnread(channelId)
    val items = remember(messages, channelId, focus, unreadMark, heldUnread) { Timeline.build(messages, heldUnread ?: unreadMark, store.me?.id).asReversed() }
    val listState = rememberLazyListState()
    val showJump by remember { derivedStateOf { listState.firstVisibleItemIndex > 2 } }
    val atBottom by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 } }
    // Newest seq the reader has had on screen at the bottom; later messages from others are "new".
    var seenSeq by remember(channelId) { mutableStateOf(channel.lastReadSeq) }
    val maxSeq = messages.maxOfOrNull { it.seq ?: 0 } ?: 0
    LaunchedEffect(atBottom, maxSeq) { if (atBottom && maxSeq > seenSeq) seenSeq = maxSeq }
    val unseenBelow = if (focus != null) 0 else messages.count { (it.seq ?: 0) > seenSeq && it.senderId != store.me?.id }
    val scope = rememberCoroutineScope()
    LaunchedEffect(channelId, focus?.messageId, items.isEmpty()) {
        if (items.isEmpty() || positioned) return@LaunchedEffect
        val target = focus?.let { it.parentId ?: it.messageId }
            ?: messages.firstOrNull { message -> unreadMark?.let { (message.seq ?: 0) > it } == true }?.id
        val index = items.indexOfFirst { it.key == target }.coerceAtLeast(0)
        listState.scrollToItem(index)
        positioned = true
    }
    LaunchedEffect(channelId, focus?.messageId, positioned, controller.engineStatus, controller.appForeground, items) {
        if (!positioned || focus != null) return@LaunchedEffect
        snapshotFlow { listState.layoutInfo }.collectLatest { layout ->
            val seq = layout.visibleItemsInfo.mapNotNull { visible ->
                val fullyVisible = visible.offset >= layout.viewportStartOffset &&
                    visible.offset + visible.size <= layout.viewportEndOffset
                val tall = visible.size > layout.viewportEndOffset - layout.viewportStartOffset
                if (!fullyVisible && !tall) null
                else (items.getOrNull(visible.index) as? TimelineItem.Message)?.message?.seq
            }.maxOrNull()
            if (seq != null) controller.engine?.markRead(channelId, seq)
        }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        if (focus != null) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("検索位置の前後の会話", style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                TextButton(onClick = { unreadMark = null; controller.messageFocus = null; scope.launch { listState.scrollToItem(0) } }) { Text("最新の会話へ") }
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(state = listState, reverseLayout = true, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 8.dp)) {
                items(items, key = { it.key }) { item ->
                    when (item) {
                        is TimelineItem.DateSeparator -> DaySeparator(item.label)
                        is TimelineItem.UnreadSeparator -> UnreadSeparator()
                        is TimelineItem.Message -> {
                            val message = item.message
                            MessageRow(
                                message, store, controller, compact = item.compact,
                                canEdit = !message.pending && message.senderId == store.me?.id,
                                canDelete = !message.pending && (message.senderId == store.me?.id || controller.isAdmin),
                                onRetry = { scope.launch { controller.engine?.retryFailed() } },
                                onDiscard = { controller.engine?.discardFailed(message.clientMsgId ?: "") },
                                onReact = { emoji -> scope.launch { controller.toggleReaction(message, emoji) } },
                                onEdit = { body -> scope.launch { controller.editMessage(message.id, Mentions.encode(body, store.users.values)) } },
                                onDelete = { scope.launch { controller.deleteMessage(message.id) } },
                                onOpenThread = { onOpenThread(message.id) },
                                onMarkUnread = message.seq?.takeIf { !message.pending }?.let { seq -> { controller.engine?.markUnread(channelId, seq); unreadMark = seq - 1 } },
                            )
                        }
                    }
                }
                if (focus == null && channel.hasOlder && channel.syncedSeq != null) {
                    item(key = "older") {
                        LaunchedEffect(messages.size, controller.engineStatus) {
                            if (controller.engineStatus != jp.chikuwachat.android.sync.EngineStatus.ONLINE || loadingOlder) return@LaunchedEffect
                            loadingOlder = true
                            try { controller.engine?.loadOlder(channelId) }
                            catch (e: Exception) { controller.error = controller.describe(e) }
                            finally { loadingOlder = false }
                        }
                        Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.width(20.dp), strokeWidth = 2.dp) }
                    }
                } else if (messages.isEmpty()) {
                    item(key = "empty") {
                        Column(Modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("まだメッセージはありません", style = MaterialTheme.typography.titleMedium)
                            Text("最初のメッセージを送ってみましょう。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                } else if (focus == null) {
                    item(key = "start") {
                        controller.store.channel(channelId)?.let { ChannelIntro(it, controller.store) }
                    }
                }
            }
            if (showJump && focus == null) {
                if (unseenBelow > 0) {
                    ExtendedFloatingActionButton(
                        onClick = { scope.launch { listState.animateScrollToItem(0) } },
                        icon = { Icon(Icons.Default.KeyboardArrowDown, contentDescription = null) },
                        text = { Text("新着 $unseenBelow 件") },
                        modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp),
                    )
                } else {
                    SmallFloatingActionButton(
                        onClick = { scope.launch { listState.animateScrollToItem(0) } },
                        modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp),
                    ) { Icon(Icons.Default.KeyboardArrowDown, contentDescription = "最新のメッセージへ") }
                }
            }
        }
        HorizontalDivider()
        if (channel.channel.archived) {
            Text("このチャンネルはアーカイブされています", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else if (!channel.isMember) {
            TextButton(onClick = { scope.launch { controller.joinChannel(channelId) } }, modifier = Modifier.fillMaxWidth().padding(8.dp)) { Text("このチャンネルに参加する") }
        } else {
            TypingLine(controller, channelId, version = version)
            ConversationComposer(controller, channelId, version)
        }
    }
}

@Composable
private fun DaySeparator(label: String) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f))
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 10.dp))
        HorizontalDivider(Modifier.weight(1f))
    }
}

@Composable
private fun UnreadSeparator() {
    val color = MaterialTheme.colorScheme.error
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = color)
        Text("新着メッセージ", style = MaterialTheme.typography.labelSmall, color = color, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 10.dp))
        HorizontalDivider(Modifier.weight(1f), color = color)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun MessageRow(
    message: MessageState,
    store: Store,
    controller: AppController,
    compact: Boolean = false,
    canEdit: Boolean,
    canDelete: Boolean,
    onRetry: () -> Unit,
    onDiscard: () -> Unit,
    onReact: (String) -> Unit,
    onEdit: (String) -> Unit,
    onDelete: () -> Unit,
    onOpenThread: (() -> Unit)? = null,
    onMarkUnread: (() -> Unit)? = null,
) {
    val sender = store.users[message.senderId]?.displayName ?: store.me?.takeIf { it.id == message.senderId }?.displayName ?: "unknown"
    var menuOpen by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf(false) }
    var confirmingDelete by remember { mutableStateOf(false) }
    var showTime by remember { mutableStateOf(false) }
    var showingProfile by remember { mutableStateOf(false) }
    var pickingReaction by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth().background(if (controller.messageFocus?.messageId == message.id) MaterialTheme.colorScheme.tertiaryContainer else Color.Transparent).combinedClickable(onClick = { if (compact) showTime = !showTime }, onLongClick = { if (!message.pending) menuOpen = true })) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = if (compact) 1.dp else 5.dp).alpha(if (message.pending) 0.6f else 1f)) {
            if (compact) Spacer(Modifier.width(36.dp)) else Avatar(message.senderId, sender, size = 36.dp, modifier = Modifier.clickable(enabled = !message.pending) { showingProfile = true })
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                val saved = store.isBookmarked(message.id)
                val pinnedBy = message.pinnedAt?.let { store.users[message.pinnedBy ?: ""]?.displayName ?: "?" }
                if (pinnedBy != null || saved) {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (pinnedBy != null) {
                            Icon(Icons.Default.PushPin, contentDescription = null, tint = Color(0xFFFF9500), modifier = Modifier.size(12.dp))
                            Text("$pinnedBy がピン留め", style = MaterialTheme.typography.labelSmall, color = Color(0xFFFF9500))
                        }
                        if (saved) {
                            Icon(Icons.Default.Bookmark, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(12.dp))
                            Text("保存済み", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                        }
                    }
                }
                if (!compact) {
                    Row(verticalAlignment = Alignment.Bottom) {
                        Text(sender, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.clickable(enabled = !message.pending) { showingProfile = true })
                        StatusEmoji(store.users[message.senderId], modifier = Modifier.padding(start = 6.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(Timeline.timeLabel(message.createdAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (message.editedAt != null) { Spacer(Modifier.width(4.dp)); Text("(編集済み)", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                } else if (showTime || message.editedAt != null) {
                    Text(
                        Timeline.fullLabel(message.createdAt) + if (message.editedAt != null) " (編集済み)" else "",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (message.body.isNotEmpty()) {
                    MessageBody(message.body, store.users, internalBase = controller.serverBase, onOpenMessage = { id -> controller.scope.launch { controller.openPermalink(id) } })
                }
                AttachmentList(message.attachments, controller)
                if (!message.pending) Links.first(message.body)?.takeIf { link -> controller.serverBase?.let { Permalink.messageId(it, link) } == null }?.let { LinkPreviewCard(controller, it) }
                ReactionChips(message, store, onToggle = onReact)
                if (message.replyCount > 0 && onOpenThread != null) {
                    TextButton(onClick = onOpenThread, contentPadding = PaddingValues(0.dp)) {
                        Icon(Icons.Outlined.ChatBubbleOutline, contentDescription = null, modifier = Modifier.size(14.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("${message.replyCount} 件の返信", style = MaterialTheme.typography.labelLarge)
                    }
                }
                if (message.failed) {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("送信に失敗しました", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelMedium)
                        TextButton(onClick = onRetry) { Text("再送") }
                        TextButton(onClick = onDiscard) { Text("破棄") }
                    }
                }
            }
        }
        MessageMenu(
            expanded = menuOpen, canEdit = canEdit, canDelete = canDelete, onDismiss = { menuOpen = false },
            onReact = onReact, onEdit = { editing = true }, onDelete = { confirmingDelete = true }, onReply = onOpenThread, onMarkUnread = onMarkUnread,
            pinned = message.pinnedAt != null, onPin = { controller.scope.launch { controller.togglePin(message) } },
            bookmarked = store.isBookmarked(message.id), onBookmark = { controller.scope.launch { controller.toggleBookmark(message.id) } },
            onCopyLink = { controller.copyPermalink(message.id) },
            onMoreReactions = { pickingReaction = true },
        )
    }
    if (pickingReaction) EmojiPickerDialog(onDismiss = { pickingReaction = false }, onPick = { pickingReaction = false; onReact(it) })
    if (showingProfile) ProfileDialog(controller, message.senderId, onDismiss = { showingProfile = false }, onOpenDm = { controller.pendingChannelId = it })
    if (editing) EditMessageDialog(Mentions.decode(message.body, store.users), onDismiss = { editing = false }, onSave = { editing = false; onEdit(it) })
    if (confirmingDelete) ConfirmDeleteDialog(onDismiss = { confirmingDelete = false }, onConfirm = { confirmingDelete = false; onDelete() })
}


/**
 * Shared composer: drafts and in-flight uploads stay bound to the original conversation.
 * The draft lives in the Store, so `version` must change for the field to show what was typed
 * (strong skipping would otherwise skip this composable: `controller` is always the same instance).
 */
@Composable
fun ConversationComposer(controller: AppController, channelId: String, version: Int, parentId: String? = null) {
    val store = controller.store
    val state = remember(version, channelId, parentId) { store.draft(channelId, parentId) }
    val draft = state.text
    val pendingUploads = state.attachments
    val uploading = store.uploading(channelId, parentId)
    fun setText(value: String) {
        store.setDraft(channelId, parentId) { it.copy(text = value) }
        if (value.isNotBlank()) controller.engine?.sendTyping(channelId, parentId) // §5.2, throttled by the engine
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        if (pendingUploads.size + uploading + uris.size > 10) controller.error = "添付は10件までです"
        else {
            store.trackUpload(channelId, parentId, uris.size)
            uris.forEach { uri -> controller.scope.launch {
                try {
                    controller.uploadAttachment(uri).onSuccess { attachment ->
                        store.setDraft(channelId, parentId) { it.copy(attachments = it.attachments + attachment) }
                    }
                } finally { store.trackUpload(channelId, parentId, -1) }
            } }
        }
    }
    Column {
        if (uploading > 0) Text("添付をアップロード中…", style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 12.dp))
        val query = Mentions.query(draft)
        val candidates = if (query != null) Mentions.candidates(query, store.users.values) else emptyList()
        // `:tada` completes to an emoji (M11f) when no mention is being typed.
        val emojiHits = if (candidates.isEmpty()) Emoji.query(draft)?.let { Emoji.candidates(it) } ?: emptyList() else emptyList()
        var pickingEmoji by remember { mutableStateOf(false) }
        if (pickingEmoji) EmojiPickerDialog(onDismiss = { pickingEmoji = false }, onPick = { pickingEmoji = false; setText(draft + it) })
        if (emojiHits.isNotEmpty()) {
            LazyRow(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                items(emojiHits, key = { it.shortcode }) { entry ->
                    Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.clickable { setText(Emoji.complete(draft, entry.glyph)) }) {
                        Text(entry.glyph + "  :" + entry.shortcode + ":", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
                    }
                }
            }
        }
        if (candidates.isNotEmpty()) {
            LazyRow(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                items(candidates, key = { it.username }) { candidate ->
                    Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.clickable { setText(Mentions.complete(draft, candidate.username)) }) {
                        Text("@" + candidate.username + "  " + candidate.label, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
                    }
                }
            }
        }
        PendingAttachments(pendingUploads) { removed -> store.setDraft(channelId, parentId) { it.copy(attachments = it.attachments - removed) } }
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Bottom) {
            IconButton(enabled = uploading == 0, onClick = { picker.launch("*/*") }) { Icon(Icons.Default.AttachFile, contentDescription = "ファイルを添付") }
            IconButton(onClick = { pickingEmoji = true }) { Icon(Icons.Outlined.EmojiEmotions, contentDescription = "絵文字") }
            OutlinedTextField(draft, { setText(it) }, modifier = Modifier.weight(1f), placeholder = { Text(if (parentId == null) "メッセージ" else "スレッドに返信") }, maxLines = 6)
            IconButton(
                onClick = {
                    val body = Mentions.encode(draft.trim(), store.users.values)
                    val ids = pendingUploads.map { it.id }
                    if (uploading > 0 || (body.isEmpty() && ids.isEmpty())) return@IconButton
                    if (body.length > 20_000) { controller.error = "本文は20,000文字までです"; return@IconButton }
                    store.setDraft(channelId, parentId) { jp.chikuwachat.android.sync.Draft() }
                    controller.scope.launch { controller.engine?.send(channelId, body, parentId = parentId, attachmentIds = ids) }
                },
                enabled = uploading == 0 && (draft.isNotBlank() || pendingUploads.isNotEmpty()),
            ) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "送信") }
        }
    }
}
