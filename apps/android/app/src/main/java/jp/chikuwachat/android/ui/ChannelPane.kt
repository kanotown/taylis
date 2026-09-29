package jp.chikuwachat.android.ui

import jp.chikuwachat.android.ui.EmojiEntry
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.DropdownMenu
import androidx.compose.material.icons.outlined.Campaign
import jp.chikuwachat.android.sync.SendOptions
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.EmojiEmotions
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.PushPin
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
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
import androidx.compose.foundation.lazy.LazyListItemInfo
import androidx.compose.foundation.lazy.LazyListLayoutInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.runtime.rememberUpdatedState
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.ReadAnchor
import jp.chikuwachat.android.sync.ReadGate
import androidx.compose.foundation.interaction.DragInteraction
import java.time.ZonedDateTime
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Checkbox
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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.launch

@Composable
fun ChannelPane(controller: AppController, channelId: String, version: Int, onOpenThread: (String) -> Unit = {}) {
    val store = controller.store
    val channel = store.channel(channelId) ?: return
    val me = store.me?.id
    val focus = controller.messageFocus?.takeIf { it.channelId == channelId }
    val messages = remember(version, channelId, focus) {
        focus?.context?.map { message ->
            store.message(channelId, message.id)?.takeIf { it.updatedSeq >= message.updatedSeq } ?: message
        }?.filter { !it.deleted } ?: store.messages(channelId)
    }
    // The read gate judges the rows the list shows, so it takes the channel state from the same store version as
    // `messages` (store.channel is live, and a scroll can lay out the old rows again before the next recomposition).
    val shown = remember(version, channelId, focus) { store.channel(channelId) ?: channel }
    // A §7.3 reload replaced every row: the view opens again (position, anchor, divider) as if just opened.
    val reloadGen = remember(version, channelId, focus) { controller.engine?.reloadCount(channelId) ?: 0 }
    var loadingOlder by remember(channelId) { mutableStateOf(false) }
    var positioned by remember(channelId, focus?.messageId, reloadGen) { mutableStateOf(false) }
    // §10.1 rule 4: a drag before the view is positioned (it may wait for a catch-up) leaves the list where it is.
    var userScrolled by remember(channelId, focus?.messageId, reloadGen) { mutableStateOf(false) }
    // The 「新着メッセージ」 divider stays where it was when the channel was opened (「最初の未読へ」 moves it). Leaving the
    // search view, however it is left, captures it again like a fresh open (§10.1 rule 4).
    var capturedMark by remember(channelId, reloadGen, focus?.messageId) { mutableStateOf(ReadGate.openMark(shown)) }
    val heldUnread = controller.engine?.heldUnread(channelId)
    // §10.1 rule 2: visible rows are read only after the first unread row was on screen with every unread row held.
    var anchor by remember(channelId, focus?.messageId, reloadGen) { mutableStateOf(ReadAnchor.opened(shown, heldUnread)) }
    var jumping by remember(channelId) { mutableStateOf(false) }
    val shownChannelId by rememberUpdatedState(channelId)
    // Drawn only where the loaded range reaches (§10.1 rule 3): above the oldest loaded row it would be a lie.
    val mark = if (focus != null) null else ReadGate.dividerMark(heldUnread, capturedMark, shown.oldestLoadedSeq)
    val items = remember(messages, channelId, mark) { Timeline.build(messages, mark, me).asReversed() }
    // What the latest composition shows, for the coroutines that wait for it (positioning after a catch-up, the jump).
    val currentItems by rememberUpdatedState(items)
    val currentMessages by rememberUpdatedState(messages)
    val currentShown by rememberUpdatedState(shown)
    val currentMark by rememberUpdatedState(mark)
    val currentHeld by rememberUpdatedState(heldUnread)
    val listState = rememberLazyListState()
    val showJump by remember { derivedStateOf { listState.firstVisibleItemIndex > 2 } }
    val atBottom by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 } }
    // §10.1 rule 7: the divider's position when positioned there, else the newest seq seen at the bottom; later rows
    // from others are 「新着」. Keyed like the divider: the search view moves it to its own (old) rows.
    var seenSeq by remember(channelId, reloadGen, focus?.messageId) { mutableIntStateOf(shown.lastReadSeq) }
    val maxSeq = messages.maxOfOrNull { it.seq ?: 0 } ?: 0
    LaunchedEffect(atBottom, maxSeq, positioned, anchor.landing) { seenSeq = ReadGate.nextSeenSeq(seenSeq, positioned && !anchor.landing, atBottom, maxSeq) }
    val unseenBelow = if (focus != null) 0 else ReadGate.newBelow(messages, seenSeq, me)
    val scope = rememberCoroutineScope()
    LaunchedEffect(listState, channelId, focus?.messageId, reloadGen) {
        listState.interactionSource.interactions.collect { if (it is DragInteraction.Start && !positioned) userScrolled = true }
    }
    LaunchedEffect(channelId, focus?.messageId, items.isEmpty(), reloadGen) {
        if (items.isEmpty() || positioned) return@LaunchedEffect
        // §10.1 rule 4: opened while a catch-up is on its way (it may bring the first unread row), the position waits
        // for it, at most 3 s; offline nothing comes. A drag meanwhile keeps the list where the reader put it.
        val position = focus != null || Timeline.awaitCatchUp(
            snapshotFlow { ReadGate.waitsForCatchUp(controller.engineStatus, currentShown) }, snapshotFlow { userScrolled },
        )
        if (position) {
            val rows = currentMessages
            val listItems = currentItems
            when (val at = Timeline.openPosition(listItems, rows, focus?.let { it.parentId ?: it.messageId }, currentMark, me)) {
                is OpenPosition.Center -> listState.centerOn(at.index)
                is OpenPosition.Top -> {
                    listState.showAtTop(at.index)
                    anchor = anchor.landed() // the first unread row is on screen: no banner, not even for a frame
                    currentMark?.let { seenSeq = it }
                }
                OpenPosition.Bottom -> {
                    listState.scrollToItem(0)
                    if (focus == null) {
                        seenSeq = rows.maxOfOrNull { it.seq ?: 0 } ?: seenSeq
                        val layout = listState.layoutInfo
                        anchor = anchor.observe(currentShown, currentHeld, rows, me, layout.seenIndexes().mapNotNull { rowAt(listItems, it) }, layout.onScreenIds(listItems)).anchor
                    }
                }
            }
        }
        positioned = true
    }
    // Keyed on the read state too: a read.updated, a hold, a catch-up or a §7.3 reload must re-check the range.
    LaunchedEffect(
        channelId, focus?.messageId, positioned, controller.engineStatus, controller.appForeground, items,
        shown.lastReadSeq, shown.unreadCount, shown.oldestLoadedSeq, shown.syncedSeq, shown.lastSeq, heldUnread,
    ) {
        if (!positioned || focus != null) return@LaunchedEffect
        // Rule 2-3: after a lowering, only a change of the view resumes marking. Being away (the background) or
        // offline is one; a lowering noticed after it (a lower bootstrap on reconnecting) is quiet again.
        if (!controller.appForeground || controller.engineStatus == EngineStatus.OFFLINE) anchor = anchor.resumed()
        if (!controller.appForeground) return@LaunchedEffect
        snapshotFlow { listState.layoutInfo }.collectLatest { layout ->
            val step = anchor.observe(shown, heldUnread, messages, me, layout.seenIndexes().mapNotNull { rowAt(items, it) }, layout.onScreenIds(items))
            anchor = step.anchor
            step.markSeq?.let { controller.engine?.markRead(channelId, it) }
        }
    }
    // 「最初の未読へ」 (§10.1 rule 6): older pages until the range reaches the read position, then that row at the top.
    // One coroutine from the press to the scroll: 「読み込み中…」 stays until the row is in place.
    fun jumpToFirstUnread() {
        fun stillShown() = shownChannelId == channelId && controller.messageFocus?.channelId != channelId
        scope.launch {
            jumping = true
            try {
                val ok = try {
                    controller.engine?.loadFirstUnread(channelId) == true
                } catch (e: Exception) {
                    controller.report(e)
                    false
                }
                // Not covered yet: the banner stays and another press goes on from there. The view may also have moved on.
                if (!ok || !stillShown()) return@launch
                val state = store.channel(channelId) ?: return@launch
                capturedMark = state.lastReadSeq
                seenSeq = state.lastReadSeq // rule 7: 「新着 N 件」 counts every unread row below the divider again
                val first = ReadGate.firstUnreadRow(store.messages(channelId), state.lastReadSeq, me)
                if (first == null) {
                    anchor = anchor.landed()
                    return@launch
                }
                // Landing (rule 6): until the row is at the top nothing is judged or read (the viewport still shows the
                // bottom rows), and the banner is gone, so the list has its final height before the last scroll.
                anchor = anchor.startLanding()
                // The loaded pages (and the divider) reach the list with the next recomposition.
                withTimeoutOrNull(2_000) { snapshotFlow { Timeline.topOf(currentItems, first.id) }.first { it >= 0 } } ?: return@launch
                val viewport = listState.layoutInfo.viewportSize
                withTimeoutOrNull(500) { snapshotFlow { listState.layoutInfo.viewportSize }.first { it != viewport } }
                if (!stillShown()) return@launch
                listState.showAtTop(Timeline.topOf(currentItems, first.id))
                anchor = anchor.landed()
            } finally {
                jumping = false
                if (anchor.landing) anchor = anchor.landingCancelled()
            }
        }
    }

    // M15f: the link bar and its editor (null link = add).
    var editingLink by remember(channelId) { mutableStateOf<Pair<Boolean, jp.chikuwachat.android.api.ChannelLinkOut?>>(false to null) }
    if (editingLink.first) ChannelLinkDialog(controller, channelId, editingLink.second, onDismiss = { editingLink = false to null })
    Column(Modifier.fillMaxSize().imePadding()) {
        ChannelLinksRow(controller, channel, version, onAdd = { editingLink = true to null }, onEdit = { editingLink = true to it })
        if (focus != null) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("検索位置の前後の会話", style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                // Like a fresh open (§10.1 rule 4): the divider at the read position of now, then the open position.
                TextButton(onClick = { controller.messageFocus = null }) { Text("最新の会話へ") }
            }
        }
        val awaitingFirstUnread = ReadGate.awaitingFirstUnread(controller.engineStatus, shown, messages, me)
        if (ReadGate.bannerShown(focus != null, positioned, channel.unreadCount, anchor.anchored, heldUnread != null, anchor.landing, awaitingFirstUnread)) {
            val online = controller.engineStatus == jp.chikuwachat.android.sync.EngineStatus.ONLINE
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(Timeline.bannerText(channel.unreadCount, channel.firstUnreadAt, ZonedDateTime.now()), style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                if (jumping) {
                    Text("読み込み中…", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(12.dp))
                } else {
                    // Above 500 unread only 「既読にする」: the rows a device holds at once stay bounded (scrolling up still works).
                    if (ReadGate.jumpButtonShown(ReadGate.readRangeReady(channel), channel.unreadCount)) {
                        TextButton(onClick = { jumpToFirstUnread() }, enabled = online) { Text("最初の未読へ") }
                    }
                    TextButton(onClick = { controller.engine?.markRead(channelId, channel.lastSeq, force = true) }, enabled = online) { Text("既読にする") }
                }
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            // Laid out from the bottom: the newest message stays above the input when the keyboard comes up. A tap on the
            // list closes the keyboard (KeyboardBehavior.kt).
            LazyColumn(state = listState, reverseLayout = true, modifier = Modifier.fillMaxSize().closesKeyboardOnTap(LocalFocusManager.current, rememberKeyboardUp()), contentPadding = PaddingValues(vertical = 8.dp)) {
                items(items, key = { it.key }) { item ->
                    when (item) {
                        is TimelineItem.DateSeparator -> DaySeparator(item.label)
                        is TimelineItem.UnreadSeparator -> UnreadSeparator()
                        is TimelineItem.Message -> {
                            val message = item.message
                            MessageRow(
                                message, store, controller, version, compact = item.compact,
                                canEdit = !message.pending && message.senderId == store.me?.id,
                                canDelete = !message.pending && (message.senderId == store.me?.id || controller.isAdmin),
                                onRetry = { message.clientMsgId?.let { key -> scope.launch { controller.engine?.retryFailed(key) } } },
                                onDiscard = { controller.engine?.discardFailed(message.clientMsgId ?: "") },
                                onReact = { emoji -> scope.launch { controller.toggleReaction(message, emoji) } },
                                onEdit = { body -> controller.editMessage(message.id, Mentions.encode(body, store.users.values, store.groups.values)).isSuccess },
                                onDelete = { scope.launch { controller.deleteMessage(message.id) } },
                                onOpenThread = { onOpenThread(message.parentId ?: message.id) },
                                // Not offered where it would read unread rows this device never loaded (§10.1).
                                onMarkUnread = message.seq?.takeIf { !message.pending && ReadGate.markUnreadOffered(shown, it) }?.let { seq ->
                                    { controller.engine?.markUnread(channelId, seq)?.let { capturedMark = it } }
                                },
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
                            catch (e: Exception) { controller.report(e) }
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
        } else if (!channel.canPostTopLevel(isAdmin = controller.store.me?.role == "admin")) {
            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Campaign, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    "このチャンネルに投稿できるのはオーナーと管理者だけです。スレッドでは返信できます。",
                    color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(start = 8.dp),
                )
            }
        } else {
            TypingLine(controller, channelId, version = version)
            ConversationComposer(controller, channelId, version)
        }
    }
}

private fun rowAt(items: List<TimelineItem>, index: Int): MessageState? = (items.getOrNull(index) as? TimelineItem.Message)?.message

/** Indexes of the items the reader can be said to have seen: fully visible, or taller than the viewport (§10). */
internal fun LazyListLayoutInfo.seenIndexes(): List<Int> = visibleItemsInfo.mapNotNull { visible ->
    val fullyVisible = visible.offset >= viewportStartOffset && visible.offset + visible.size <= viewportEndOffset
    val tall = visible.size > viewportEndOffset - viewportStartOffset
    if (fullyVisible || tall) visible.index else null
}

/** Message ids of the rows at least partly on screen: a row partly shown was not passed unseen (§10.1 rule 2). */
private fun LazyListLayoutInfo.onScreenIds(items: List<TimelineItem>): Set<String> = onScreenIndexes().mapNotNullTo(HashSet()) { rowAt(items, it)?.id }

/** Indexes of the items at least partly inside the viewport. */
internal fun LazyListLayoutInfo.onScreenIndexes(): List<Int> = visibleItemsInfo.mapNotNull { visible ->
    if (visible.offset + visible.size > viewportStartOffset && visible.offset < viewportEndOffset) visible.index else null
}

/** The item once the list has measured it (a scroll asked for before the first layout lands on the next one). */
private suspend fun LazyListState.laidOut(index: Int): LazyListItemInfo? =
    layoutInfo.visibleItemsInfo.firstOrNull { it.index == index }
        ?: withTimeoutOrNull(1_000) { snapshotFlow { layoutInfo.visibleItemsInfo.firstOrNull { it.index == index } }.filterNotNull().first() }

/** Centres the item (a search hit, a permalink). */
internal suspend fun LazyListState.centerOn(index: Int) {
    scrollToItem(index)
    val item = laidOut(index) ?: return
    scrollBy((item.offset + item.size / 2 - (layoutInfo.viewportStartOffset + layoutInfo.viewportEndOffset) / 2).toFloat())
}

/**
 * Reversed list: the item's upper edge goes to the top of the viewport and the newer rows fill in below it
 * (scrollToItem alone leaves it at the bottom edge). Offsets count from the list's start, the bottom here.
 */
private suspend fun LazyListState.showAtTop(index: Int) {
    scrollToItem(index)
    val item = laidOut(index) ?: return
    scrollBy((item.offset + item.size - layoutInfo.viewportEndOffset).toFloat())
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

/** M15c: in the channel a shared reply names its thread (tap opens it); in the thread it says it was shared. */
@Composable
private fun ReplyLine(message: MessageState, store: Store, version: Int, onOpenThread: (() -> Unit)?) {
    val style = MaterialTheme.typography.labelSmall
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    if (onOpenThread != null) {
        val parent = remember(version, message.parentId) { message.parentId?.let { store.message(message.channelId, it) } }
        val excerpt = parent?.let { p -> plainText(Mentions.toNames(p.body, store.users, store.groups), 80).ifEmpty { if (p.attachments.isEmpty()) "" else "(添付ファイル)" } }
        Text(
            "スレッドに返信: " + (excerpt ?: "元のメッセージ"), style = style, color = color, maxLines = 1,
            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.clickable { onOpenThread() },
        )
    } else if (message.alsoInChannel) {
        Text("チャンネルにも送信済み", style = style, color = color)
    }
}

/**
 * One message. `version` (the Store's) makes the row re-read what lives in the Store rather than in
 * `message` — names, status emoji, 「保存済み」, custom emoji images — which strong skipping would keep stale.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun MessageRow(
    message: MessageState,
    store: Store,
    controller: AppController,
    version: Int,
    compact: Boolean = false,
    canEdit: Boolean,
    canDelete: Boolean,
    onRetry: () -> Unit,
    onDiscard: () -> Unit,
    onReact: (String) -> Unit,
    /** Saves an edit; true once the server took it (the editor stays open with the text until then). */
    onEdit: suspend (String) -> Boolean,
    onDelete: () -> Unit,
    onOpenThread: (() -> Unit)? = null,
    onMarkUnread: (() -> Unit)? = null,
) {
    val sender = store.users[message.senderId]?.displayName ?: store.me?.takeIf { it.id == message.senderId }?.displayName ?: "unknown"
    var menuOpen by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf(false) }
    var savingEdit by remember { mutableStateOf(false) }
    val rowScope = rememberCoroutineScope()
    var confirmingDelete by remember { mutableStateOf(false) }
    var showingProfile by remember { mutableStateOf(false) }
    var pickingReaction by remember { mutableStateOf(false) }
    var sharing by remember { mutableStateOf(false) }
    var showingRevisions by remember { mutableStateOf(false) }
    // M25: TalkBack names the long press (its actions menu, double-tap and hold) after the sheet it opens; a pending
    // row has no sheet, so no long press is offered. Links and buttons inside stay their own nodes.
    val rowClick = Modifier.combinedClickable(
        onClickLabel = if (onOpenThread != null) "スレッドを開く" else null,
        onLongClickLabel = "メッセージの操作",
        onLongClick = if (message.pending) null else ({ menuOpen = true }),
        // A tap on a message in the channel opens its thread, to read or to reply (Slack; testers, 2026-09-29; a grouped
        // row showed its time before, which its gutter shows now). With the keyboard up the tap only closes it
        // (closesKeyboardOnTap), as on iOS.
        onClick = { if (!message.pending && onOpenThread != null && !KeyboardBehavior.upAtTouch) onOpenThread() },
    )
    Box(Modifier.fillMaxWidth().background(if (controller.messageFocus?.messageId == message.id) MaterialTheme.colorScheme.tertiaryContainer else Color.Transparent).then(rowClick)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = if (compact) 4.dp else 5.dp).alpha(if (message.pending) 0.6f else 1f)) {
            // Grouped under the previous message: its time where the avatar would be, so where one message ends and the
            // next begins shows (testers, 2026-09-28; the same on iOS and the web).
            if (compact) {
                Text(
                    Timeline.timeLabel(message.createdAt), style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f), textAlign = TextAlign.Center,
                    modifier = Modifier.width(36.dp).padding(top = 3.dp),
                )
            } else Avatar(message.senderId, sender, size = 36.dp, modifier = Modifier.clickable(enabled = !message.pending) { showingProfile = true })
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                if (message.isReply) ReplyLine(message, store, version, onOpenThread)  // M15c
                message.priority?.let { PriorityLabel(it, Modifier.padding(bottom = 2.dp)) }  // M15e
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
                        if (store.users[message.senderId]?.role == "bot") {
                            Surface(shape = MaterialTheme.shapes.extraSmall, color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.padding(start = 6.dp)) {
                                Text("BOT", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 4.dp, vertical = 1.dp))
                            }
                        }
                        StatusEmoji(store.users[message.senderId], modifier = Modifier.padding(start = 6.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(Timeline.timeLabel(message.createdAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (message.editedAt != null) {
                            Spacer(Modifier.width(4.dp))
                            val own = message.senderId == store.me?.id
                            Text(
                                "(編集済み)", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                textDecoration = if (own) androidx.compose.ui.text.style.TextDecoration.Underline else null,
                                modifier = Modifier.clickable(enabled = own) { showingRevisions = true },
                            )
                        }
                    }
                } else if (message.editedAt != null) {
                    Text(
                        Timeline.fullLabel(message.createdAt) + if (message.editedAt != null) " (編集済み)" else "",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (message.body.isNotEmpty() && !pollHidesBody(message.body, message.poll)) {
                    MessageBody(
                        message.body, store.users, groups = store.groups, internalBase = controller.serverBase, onOpenMessage = { id -> controller.scope.launch { controller.openPermalink(id) } },
                        customEmoji = store.customEmoji, emojiImages = store.emojiImages, emojiAnimations = store.emojiAnimations, onNeedEmojiImage = { controller.loadEmojiImage(it) }, version = version,
                    )
                }
                message.poll?.let { PollCard(it, message, controller) }  // M14b
                if (message.ackRequested && !message.pending) AckBar(message, store, controller, version)  // M15e
                AttachmentList(message.attachments, controller)
                if (!message.pending) Links.first(message.body)?.takeIf { link -> controller.serverBase?.let { Permalink.messageId(it, link) } == null }?.let { LinkPreviewCard(controller, it) }
                ReactionChips(
                    message, store, onToggle = onReact, onNeedEmojiImage = { controller.loadEmojiImage(it) },
                    onAdd = if (message.pending) null else ({ pickingReaction = true }), version = version,  // M25 「＋」
                )
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
        var reminding by remember { mutableStateOf(false) }
        if (reminding) ReminderDialog(onDismiss = { reminding = false }) { at, note -> reminding = false; controller.scope.launch { controller.setReminder(message.id, at, note) } }
        MessageMenu(
            expanded = menuOpen, canEdit = canEdit, canDelete = canDelete, onDismiss = { menuOpen = false },
            onReact = onReact, onEdit = { editing = true }, onDelete = { confirmingDelete = true }, onReply = onOpenThread, onMarkUnread = onMarkUnread,
            pinned = message.pinnedAt != null, onPin = { controller.scope.launch { controller.togglePin(message) } },
            bookmarked = store.isBookmarked(message.id), onBookmark = { controller.scope.launch { controller.toggleBookmark(message.id) } },
            onCopyLink = { controller.copyPermalink(message.id) },
            onCopyText = if (message.body.isNotEmpty()) ({ controller.copyText(message) }) else null,
            onRemind = { reminding = true },
            onShare = { sharing = true },
            quick = QuickReactions.pick(QuickReactions.read(controller.prefs)),
            onMoreReactions = { pickingReaction = true },
            reacted = store.me?.id?.let { me -> message.reactions.filter { me in it.userIds }.map { it.emoji }.toSet() } ?: emptySet(),
        )
    }
    if (sharing) ShareDialog(controller, message, onDismiss = { sharing = false })
    if (showingRevisions) RevisionsDialog(controller, message, onDismiss = { showingRevisions = false })
    if (pickingReaction) EmojiPickerDialog(custom = store.customEmoji.values.toList(), images = store.emojiImages, animations = store.emojiAnimations, onNeedImage = { controller.loadEmojiImage(it) }, onDismiss = { pickingReaction = false }, onPick = { pickingReaction = false; onReact(it) })
    if (showingProfile) ProfileDialog(controller, message.senderId, onDismiss = { showingProfile = false }, onOpenDm = { controller.pendingChannelId = it })
    // Codex audit C4: closed only once the edit is saved; a failure (offline) keeps the text and shows the error.
    if (editing) EditMessageDialog(Mentions.decode(message.body, store.users, store.groups), saving = savingEdit, onDismiss = { if (!savingEdit) editing = false }, onSave = { body ->
        rowScope.launch {
            savingEdit = true
            if (onEdit(body)) editing = false
            savingEdit = false
        }
    })
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
    val maxAttachments = store.limits?.maxAttachmentsPerMessage ?: 10
    fun uploadPicked(uris: List<android.net.Uri>) {
        if (pendingUploads.size + uploading + uris.size > maxAttachments) controller.error = "添付は${maxAttachments}件までです"
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
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents(), ::uploadPicked)
    val mediaPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(10), ::uploadPicked)
    Column {
        val query = Mentions.query(draft)
        val candidates = if (query != null) Mentions.candidates(query, store.users.values, store.groups.values) else emptyList()
        // `:tada` completes to an emoji (M11f) when no mention is being typed.
        val emojiHits = if (candidates.isEmpty()) Emoji.query(draft)?.let { q ->
            val names = store.customEmoji.keys.filter { it.startsWith(q) || it.contains(q) }.take(4)
            (names.map { EmojiEntry(shortcode = it, glyph = ":$it:", category = "custom", keywords = it) } + Emoji.candidates(q)).take(8)
        } ?: emptyList() else emptyList()
        var pickingEmoji by remember { mutableStateOf(false) }
        if (pickingEmoji) EmojiPickerDialog(custom = store.customEmoji.values.toList(), images = store.emojiImages, animations = store.emojiAnimations, onNeedImage = { controller.loadEmojiImage(it) }, onDismiss = { pickingEmoji = false }, onPick = { pickingEmoji = false; setText(draft + it) })
        if (emojiHits.isNotEmpty()) {
            LazyRow(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                items(emojiHits, key = { it.shortcode }) { entry ->
                    Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.clickable { setText(Emoji.complete(draft, entry.glyph)) }) {
                        Text(entry.glyph + "  :" + entry.shortcode + ":", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
                    }
                }
            }
        }
        // `/st` at the very start offers the slash commands (M13b).
        val commandHits = if (candidates.isEmpty() && emojiHits.isEmpty()) SlashCommands.candidates(draft) else emptyList()
        if (commandHits.isNotEmpty()) {
            LazyRow(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                items(commandHits, key = { it.name }) { command ->
                    Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.clickable { setText("/" + command.name + " ") }) {
                        Text(command.usage + "  " + command.description, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
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
        PendingAttachments(pendingUploads, controller, uploading) { removed -> store.setDraft(channelId, parentId) { it.copy(attachments = it.attachments - removed) } }
        // M15c: "also send to the channel" for a thread reply; unticked again after each send (Slack).
        var alsoInChannel by remember(channelId, parentId) { mutableStateOf(false) }
        val channel = store.channel(channelId)
        val canShare = parentId != null && channel?.canPostTopLevel(isAdmin = store.me?.role == "admin") == true
        if (canShare) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 4.dp)) {
                Checkbox(checked = alsoInChannel, onCheckedChange = { alsoInChannel = it })
                Text(if (channel?.channel?.isDm == true) "会話にも送信" else "#${channel?.channel?.name ?: ""} にも送信", style = MaterialTheme.typography.bodySmall)
            }
        }
        // M15e: priority and "ask for acknowledgement" for a top-level post; cleared after each send.
        var priority by remember(channelId, parentId) { mutableStateOf<String?>(null) }
        var ackRequested by remember(channelId, parentId) { mutableStateOf(false) }
        var priorityOpen by remember { mutableStateOf(false) }
        if (priority != null || ackRequested) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(start = 16.dp, top = 6.dp)) {
                priority?.let { PriorityLabel(it) }
                if (ackRequested) Text("確認を求める", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("外す", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.clickable { priority = null; ackRequested = false })
            }
        }
        // 「アンケートを作成」 (testers): from the attachment menu, or /poll alone.
        var pollOpen by remember { mutableStateOf(false) }
        if (pollOpen) PollDialog(
            onDismiss = { pollOpen = false },
            onCreate = { question, options, multiple -> controller.createPoll(channelId, parentId, question, options, multiple) },
            launch = { work -> controller.scope.launch { work() } },
        )
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Bottom) {
            var attachmentMenu by remember { mutableStateOf(false) }
            Box {
                IconButton(enabled = uploading == 0, onClick = { attachmentMenu = true }) { Icon(Icons.Default.AttachFile, contentDescription = "ファイルを添付") }
                DropdownMenu(expanded = attachmentMenu, onDismissRequest = { attachmentMenu = false }) {
                    DropdownMenuItem(text = { Text("写真・動画") }, onClick = {
                        attachmentMenu = false
                        mediaPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                    })
                    DropdownMenuItem(text = { Text("ファイル") }, onClick = { attachmentMenu = false; picker.launch("*/*") })
                    DropdownMenuItem(text = { Text("アンケート") }, onClick = { attachmentMenu = false; pollOpen = true })
                }
            }
            IconButton(onClick = { pickingEmoji = true }) { Icon(Icons.Outlined.EmojiEmotions, contentDescription = "絵文字") }
            // M12d 「後で送信」: the same draft, posted by the server at the chosen time.
            var scheduleOpen by remember { mutableStateOf(false) }
            var customOpen by remember { mutableStateOf(false) }
            // Codex audit C2: one key per schedule, kept while the same draft is scheduled again after a failure; no
            // second request while one is on its way.
            var scheduling by remember { mutableStateOf(false) }
            var scheduleKey by remember { mutableStateOf<Pair<String, String>?>(null) }
            val canSchedule = !scheduling && uploading == 0 && (draft.isNotBlank() || pendingUploads.isNotEmpty())
            fun schedule(at: java.time.ZonedDateTime) {
                val body = Mentions.encode(draft.trim(), store.users.values, store.groups.values)
                val ids = pendingUploads.map { it.id }
                if (!canSchedule) return
                if (at.isBefore(java.time.ZonedDateTime.now().plusMinutes(1))) { controller.error = "1 分以上先の時刻を選んでください"; return }
                val what = listOf(channelId, parentId, body, ids).toString()
                val key = scheduleKey?.takeIf { it.second == what }?.first ?: java.util.UUID.randomUUID().toString()
                scheduleKey = key to what
                val typed = draft
                scheduling = true
                controller.scope.launch {
                    val done = controller.scheduleMessage(channelId, parentId, body, ids, at, key)
                    scheduling = false
                    if (!done) return@launch
                    scheduleKey = null
                    // Codex audit C1: what was typed or attached while the request was on its way stays.
                    store.setDraft(channelId, parentId) { it.copy(text = if (it.text == typed) "" else it.text, attachments = it.attachments.filterNot { a -> a.id in ids }) }
                }
            }
            Box {
                IconButton(enabled = canSchedule, onClick = { scheduleOpen = true }) { Icon(Icons.Outlined.Schedule, contentDescription = "後で送信") }
                DropdownMenu(expanded = scheduleOpen, onDismissRequest = { scheduleOpen = false }) {
                    Schedule.presets().forEach { preset ->
                        DropdownMenuItem(text = { Text(preset.label + "  " + Schedule.label(preset.at)) }, onClick = { scheduleOpen = false; schedule(preset.at) })
                    }
                    HorizontalDivider()
                    DropdownMenuItem(text = { Text("日時を指定…") }, onClick = { scheduleOpen = false; customOpen = true })
                }
            }
            if (customOpen) ScheduleDialog(onDismiss = { customOpen = false }) { at -> customOpen = false; schedule(at) }
            OutlinedTextField(
                draft, { setText(it) }, modifier = Modifier.weight(1f), placeholder = { Text(if (parentId == null) "メッセージ" else "スレッドに返信") }, maxLines = 6,
                trailingIcon = if (parentId != null) null else { {
                    Box {
                        IconButton(onClick = { priorityOpen = true }) {
                            Icon(Icons.Outlined.Flag, contentDescription = "重要度", tint = if (priority != null || ackRequested) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        DropdownMenu(expanded = priorityOpen, onDismissRequest = { priorityOpen = false }) {
                            listOf(null to "通常", "important" to "重要", "urgent" to "緊急").forEach { (value, label) ->
                                DropdownMenuItem(
                                    text = { if (value == null) Text(label) else PriorityLabel(value) },
                                    onClick = { priority = value; priorityOpen = false },
                                    trailingIcon = { if (priority == value) Icon(Icons.Default.Check, contentDescription = null) },
                                )
                            }
                            HorizontalDivider()
                            DropdownMenuItem(
                                text = { Text("確認を求める") },
                                onClick = { ackRequested = !ackRequested },
                                leadingIcon = { Checkbox(checked = ackRequested, onCheckedChange = null) },
                            )
                        }
                    }
                } },
            )
            IconButton(
                onClick = {
                    SlashCommands.parse(draft)?.let { command ->  // M13b
                        if (!command.known) { controller.error = "/${command.name} というコマンドはありません (/help で一覧)"; return@IconButton }
                        store.setDraft(channelId, parentId) { jp.chikuwachat.android.sync.Draft() }
                        if (command.name == "poll" && command.args.isBlank()) { pollOpen = true; return@IconButton }
                        controller.scope.launch { controller.runCommand(command, channelId, parentId) }
                        return@IconButton
                    }
                    val body = Mentions.encode(draft.trim(), store.users.values, store.groups.values)
                    val ids = pendingUploads.map { it.id }
                    if (uploading > 0 || (body.isEmpty() && ids.isEmpty())) return@IconButton
                    val maxLength = store.limits?.maxMessageLength ?: 20_000
                    if (body.length > maxLength) { controller.error = "本文は%,d文字までです".format(maxLength); return@IconButton }
                    store.setDraft(channelId, parentId) { jp.chikuwachat.android.sync.Draft() }
                    val options = SendOptions(
                        alsoInChannel = canShare && alsoInChannel,
                        priority = if (parentId == null) priority else null,
                        ackRequested = parentId == null && ackRequested,
                    )
                    alsoInChannel = false
                    priority = null
                    ackRequested = false
                    controller.scope.launch { controller.engine?.send(channelId, body, parentId = parentId, attachmentIds = ids, sendOptions = options) }
                },
                enabled = uploading == 0 && (draft.isNotBlank() || pendingUploads.isNotEmpty()),
            ) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "送信") }
        }
    }
}
