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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.TemplateOut
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.outlined.PostAdd
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import java.time.LocalDate
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.launch

/**
 * One conversation's timeline and composer. `onScreen` (M29): false while the 「ピン留め」 / 「ファイル」 tab or the details
 * page covers it. It stays composed underneath (its scroll position, read anchor and draft survive the switch), but it
 * counts as not being looked at (SYNC_PROTOCOL.md §10.1 2.): no rows are judged or marked read, 「新着」 does not count
 * rows as seen at the bottom, and TalkBack does not reach it.
 */
@Composable
fun ChannelPane(controller: AppController, channelId: String, version: Int, onScreen: Boolean = true, onOpenThread: (String) -> Unit = {}) {
    val store = controller.store
    val channel = store.channel(channelId) ?: return
    val me = store.me?.id
    val focus = controller.messageFocus?.takeIf { it.channelId == channelId }
    // The same list instance while the rows are unchanged (M28c): every version bump (a typing frame, a presence
    // change) otherwise built the timeline again and restarted the read effect below.
    val messages = rememberUnchanged(version, channelId, focus) {
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
    // M28c: a failed older page offers 「再読み込み」 instead of spinning for good (the effect only ran again on a new row).
    var olderFailed by remember(channelId) { mutableStateOf(false) }
    var olderAttempt by remember(channelId) { mutableIntStateOf(0) }
    // The position, the divider, the anchor and the seen seq are saveable (M28c): across an activity recreation (a
    // rotation) the list keeps its scroll position, so the open positioning must not run again (the divider jumped).
    var positioned by rememberSaveable(channelId, focus?.messageId, reloadGen) { mutableStateOf(false) }
    // §10.1 rule 4: a drag before the view is positioned (it may wait for a catch-up) leaves the list where it is.
    var userScrolled by rememberSaveable(channelId, focus?.messageId, reloadGen) { mutableStateOf(false) }
    // The 「新着メッセージ」 divider stays where it was when the channel was opened (「最初の未読へ」 moves it). Leaving the
    // search view, however it is left, captures it again like a fresh open (§10.1 rule 4).
    var capturedMark by rememberSaveable(channelId, reloadGen, focus?.messageId) { mutableStateOf(ReadGate.openMark(shown)) }
    val heldUnread = controller.engine?.heldUnread(channelId)
    // §10.1 rule 2: visible rows are read only after the first unread row was on screen with every unread row held.
    var anchor by rememberSaveable(channelId, focus?.messageId, reloadGen, stateSaver = ReadAnchorSaver) { mutableStateOf(ReadAnchor.opened(shown, heldUnread)) }
    var jumping by remember(channelId) { mutableStateOf(false) }
    val shownChannelId by rememberUpdatedState(channelId)
    // Drawn only where the loaded range reaches (§10.1 rule 3): above the oldest loaded row it would be a lie.
    val mark = if (focus != null) null else ReadGate.dividerMark(heldUnread, capturedMark, shown.oldestLoadedSeq)
    // M47: switching 「連続した投稿をまとめる」 only changes rows' headers, never which rows there are or their keys.
    val grouping = controller.groupPosts
    val items = remember(messages, channelId, mark, grouping) { Timeline.build(messages, mark, me, grouping = grouping).asReversed() }
    // What the latest composition shows, for the coroutines that wait for it (positioning after a catch-up, the jump).
    val currentItems by rememberUpdatedState(items)
    val currentMessages by rememberUpdatedState(messages)
    val currentShown by rememberUpdatedState(shown)
    val currentMark by rememberUpdatedState(mark)
    val currentHeld by rememberUpdatedState(heldUnread)
    val listState = rememberLazyListState()
    val showJump by remember { derivedStateOf { listState.firstVisibleItemIndex > 2 } }
    val atBottom by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 } }
    // §10.1 2-4 (tester, 2026-09-30): a row that arrives while the reader is at the newest edge is shown there. The list
    // keeps its first item (the old newest row) in place by key, so the new row went just below the edge, unseen and
    // unread, and after a few of them 「新着 N 件」 came up for a reader who never left the bottom. Asked for in the
    // composition that brings the row (the list's position is still the one before it), the list lays it out at the
    // edge in the same frame: no jolt.
    val followed = remember(channelId) { LastShown<List<TimelineItem>>() }
    val edgeSlop = with(LocalDensity.current) { Timeline.NEWEST_EDGE_SLOP_DP.dp.roundToPx() }
    followed.value?.let { before ->
        if (before !== items) {
            val atEdge = Snapshot.withoutReadObservation { Timeline.atNewestEdge(listState.firstVisibleItemIndex, listState.firstVisibleItemScrollOffset, edgeSlop) }
            val arrived = atEdge && Timeline.arrivedAtNewest(before.map { it.key }, items.map { it.key })
            if (Timeline.followsArrival(atEdge, arrived, positioned, anchor.landing, focus != null)) listState.requestScrollToItem(0)
        }
    }
    SideEffect { followed.value = items }
    // §10.1 rule 7: the divider's position when positioned there, else the newest seq seen at the bottom; later rows
    // from others are 「新着」. Keyed like the divider: the search view moves it to its own (old) rows.
    var seenSeq by rememberSaveable(channelId, reloadGen, focus?.messageId) { mutableIntStateOf(shown.lastReadSeq) }
    val maxSeq = messages.maxOfOrNull { it.seq ?: 0 } ?: 0
    // M29: rows that reach the bottom while a tab covers the timeline were not seen there.
    LaunchedEffect(atBottom, maxSeq, positioned, anchor.landing, onScreen) { seenSeq = ReadGate.nextSeenSeq(seenSeq, positioned && !anchor.landing, atBottom && onScreen, maxSeq) }
    val unseenBelow = if (focus != null) 0 else ReadGate.newBelow(messages, seenSeq, me)
    val scope = rememberCoroutineScope()
    // §10.1 rule 11 (M28c): my own top-level post from this device shows at the bottom, whether it came from the outbox
    // (its pending row) or an endpoint of its own (a poll, `postedHere`), as on the desktop and iOS.
    val newest = messages.lastOrNull()
    LaunchedEffect(newest?.rowKey, controller.postedHere) {
        val last = newest ?: return@LaunchedEffect
        if (focus != null || !positioned || last.senderId != me || last.parentId != null) return@LaunchedEffect
        if (!last.pending && last.id != controller.postedHere) return@LaunchedEffect
        if (anchor.landing) anchor = anchor.landed()
        listState.scrollToItem(0)
    }
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
        shown.lastReadSeq, shown.unreadCount, shown.oldestLoadedSeq, shown.syncedSeq, shown.lastSeq, heldUnread, onScreen,
    ) {
        if (!positioned || focus != null) return@LaunchedEffect
        // Rule 2-3: after a lowering, only a change of the view resumes marking. Being away (the background, the pins or
        // files tab, the details page) or offline is one; a lowering noticed after it (a lower bootstrap on reconnecting)
        // is quiet again.
        val away = !controller.appForeground || !onScreen
        if (away || controller.engineStatus == EngineStatus.OFFLINE) anchor = anchor.resumed()
        // Not looked at: no look at all (rule 2-4 judges only looks with rows on screen). Coming back is a fresh look.
        if (away) return@LaunchedEffect
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

    // M29: the link bar moved into the tab row above (ConversationTabRow).
    Column(Modifier.fillMaxSize().imePadding().then(if (onScreen) Modifier else Modifier.clearAndSetSemantics {})) {
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
                                // Through the controller (M28c): offline it says so instead of silently doing nothing.
                                onMarkUnread = message.seq?.takeIf { !message.pending && ReadGate.markUnreadOffered(shown, it) }?.let { seq ->
                                    { controller.markUnread(channelId, seq)?.let { capturedMark = it } }
                                },
                            )
                        }
                    }
                }
                if (focus == null && channel.hasOlder && channel.syncedSeq != null) {
                    item(key = "older") {
                        LaunchedEffect(messages.size, controller.engineStatus, olderAttempt) {
                            if (controller.engineStatus != EngineStatus.ONLINE || loadingOlder || olderFailed) return@LaunchedEffect
                            loadingOlder = true
                            try { controller.engine?.loadOlder(channelId); olderFailed = false }
                            catch (e: Exception) { controller.report(e); olderFailed = true }
                            finally { loadingOlder = false }
                        }
                        if (olderFailed) LoadFailedRow("以前のメッセージを読み込めませんでした") { olderFailed = false; olderAttempt += 1 }
                        else Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.width(20.dp), strokeWidth = 2.dp) }
                    }
                } else if (messages.isEmpty()) {
                    item(key = "empty") {
                        // M28c: a channel never loaded here shows its first page on its way (or that it is offline), not
                        // 「まだメッセージはありません」.
                        when (Timeline.firstPage(channel.syncedSeq, controller.engineStatus)) {
                            Timeline.FirstPage.LOADING -> Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.width(24.dp), strokeWidth = 2.dp) }
                            Timeline.FirstPage.OFFLINE -> Column(Modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                                Text("オフラインのため読み込めません", style = MaterialTheme.typography.titleMedium)
                                Text("接続が戻ると読み込みます。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Timeline.FirstPage.EMPTY -> Column(Modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                                // My own DM (a DM with only me) says what it is for, under my name.
                                if (MainTabs.isSelfNotes(channel, store.me?.id)) {
                                    Text(myDisplayName(store), style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
                                    Text(MainTabs.SELF_NOTES_INTRO, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                                } else {
                                    Text("まだメッセージはありません", style = MaterialTheme.typography.titleMedium)
                                    Text("最初のメッセージを送ってみましょう。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    }
                } else if (focus == null) {
                    item(key = "start") {
                        controller.store.channel(channelId)?.let { ChannelIntro(it, controller.store, version) }
                    }
                }
            }
            if (showJump && focus == null && onScreen) {
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
        // A channel I am not in never reaches this pane: MainScreen opens it as a preview (PreviewPane, §7.6.1).
        if (channel.channel.archived) {
            Text("このチャンネルはアーカイブされています", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
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

/** What the last applied composition showed (not state: written in a SideEffect, read by the next composition). */
internal class LastShown<T> { var value: T? = null }

private fun rowAt(items: List<TimelineItem>, index: Int): MessageState? =(items.getOrNull(index) as? TimelineItem.Message)?.message

/**
 * M28c: the read anchor across an activity recreation (a rotation), as one line. A landing never survives (its scroll
 * went with the composition); the quiet ids come back as they were. Message ids are UUIDs, so the separators are safe.
 */
internal val ReadAnchorSaver = Saver<ReadAnchor, String>(
    save = { listOf(if (it.anchored) "1" else "0", it.readSeq.toString(), it.held?.toString() ?: "", it.quiet?.joinToString(",") ?: "-").joinToString("\n") },
    restore = { saved ->
        val parts = saved.split("\n")
        ReadAnchor(
            anchored = parts[0] == "1", landing = false, readSeq = parts[1].toInt(), held = parts[2].toIntOrNull(),
            quiet = parts.getOrNull(3)?.takeIf { it != "-" }?.split(",")?.filter { s -> s.isNotEmpty() }?.toSet(),
        )
    },
)

/** M28c: a page (or a thread's replies) that could not be loaded: the words and 「再読み込み」, instead of a spinner for good. */
@Composable
internal fun LoadFailedRow(text: String, onRetry: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        TextButton(onClick = onRetry) { Text("再読み込み") }
    }
}

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
internal fun DaySeparator(label: String) {
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
        val excerpt = parent?.let { p -> messageLine(p.body, p.attachments, store, 80) }
        // M28c: a 48 dp touch target around the one-line link.
        Text(
            "スレッドに返信: " + (excerpt ?: "元のメッセージ"), style = style, color = color, maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.touchTarget { source -> Modifier.clickable(interactionSource = source, indication = null, onClickLabel = "スレッドを開く") { onOpenThread() } },
        )
    } else if (message.alsoInChannel) {
        Text("チャンネルにも送信済み", style = style, color = color)
    }
}

/**
 * One message. `version` (the Store's) makes the row re-read what lives in the Store rather than in
 * `message` — names, status emoji, 「保存済み」, custom emoji images — which strong skipping would keep stale.
 * `readOnly`: a channel previewed before joining (SYNC_PROTOCOL.md §7.6.1): no long-press sheet, reactions, votes or
 * acknowledgements (the server refuses them from non-members); who reacted or voted can still be read.
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
    readOnly: Boolean = false,
    /**
     * L8 (TIMES_FEED.md §7): a row of the Times feed. `channelLabel` (the times' name) follows the sender's name, `newDot`
     * (non-null: a slot left of the avatar) marks a row after its times' read position, and `onTap` replaces the tap's
     * 「スレッドを開く」 (the feed shows the row in its channel; 「返信 N 件」 still opens the thread).
     */
    channelLabel: String? = null,
    newDot: Boolean? = null,
    onTap: (() -> Unit)? = null,
) {
    // M89 (MEMBERSHIP.md §5 item 3): a join / leave line is one muted line wherever rows show (channel, thread, preview).
    if (message.isSystem) {
        SystemMessageRow(message, store, highlighted = controller.messageFocus?.messageId == message.id)
        return
    }
    val sender = store.users[message.senderId]?.displayName ?: store.me?.takeIf { it.id == message.senderId }?.displayName ?: "unknown"
    var menuOpen by remember { mutableStateOf(false) }
    var showingReactors by remember { mutableStateOf(false) }
    // The edit and share dialogs (with their text) survive a rotation (M28c); the rows are keyed, so the state is theirs.
    var editing by rememberSaveable { mutableStateOf(false) }
    var savingEdit by remember { mutableStateOf(false) }
    val rowScope = rememberCoroutineScope()
    var confirmingDelete by remember { mutableStateOf(false) }
    var showingProfile by remember { mutableStateOf(false) }
    var pickingReaction by remember { mutableStateOf(false) }
    var sharing by rememberSaveable { mutableStateOf(false) }
    var showingRevisions by remember { mutableStateOf(false) }
    // M25: TalkBack names the long press (its actions menu, double-tap and hold) after the sheet it opens; a pending
    // row has no sheet, so no long press is offered. Links and buttons inside stay their own nodes.
    val rowClick = Modifier.combinedClickable(
        onClickLabel = if (onTap != null) "チャンネルで表示" else if (onOpenThread != null) "スレッドを開く" else null,
        onLongClickLabel = "メッセージの操作",
        onLongClick = if (message.pending || readOnly) null else ({ menuOpen = true }),
        // A tap on a message in the channel opens its thread, to read or to reply (Slack; testers, 2026-09-29; a grouped
        // row showed its time before, which its gutter shows now). With the keyboard up the tap only closes it
        // (closesKeyboardOnTap), as on iOS.
        onClick = {
            if (!message.pending && onTap != null) onTap()
            else if (!message.pending && onOpenThread != null && !KeyboardBehavior.upAtTouch) onOpenThread()
        },
    )
    Box(Modifier.fillMaxWidth().background(if (controller.messageFocus?.messageId == message.id) MaterialTheme.colorScheme.tertiaryContainer else Color.Transparent).then(rowClick)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = if (compact) 4.dp else 5.dp).alpha(if (message.pending) 0.6f else 1f)) {
            if (newDot != null) {
                Box(Modifier.width(12.dp).padding(top = 14.dp), contentAlignment = Alignment.TopStart) {
                    if (newDot) Box(Modifier.size(8.dp).background(MaterialTheme.colorScheme.primary, CircleShape).semantics { contentDescription = "新しい投稿" })
                }
            }
            // Grouped under the previous message: its time where the avatar would be, so where one message ends and the
            // next begins shows (testers, 2026-09-28; the same on iOS and the web).
            if (compact) {
                Text(
                    Timeline.timeLabel(message.createdAt), style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f), textAlign = TextAlign.Center,
                    modifier = Modifier.width(36.dp).padding(top = 3.dp),
                )
            } else Avatar(message.senderId, sender, size = 36.dp, onClick = if (message.pending) null else ({ showingProfile = true }))
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
                        // M66: an AI bot says 「AI」 (docs/AI.md §6), the other bots (webhooks, recurring posts) 「BOT」.
                        if (message.senderId in controller.aiBotIds) {
                            AiBadge(Modifier.padding(start = 6.dp))
                        } else if (store.users[message.senderId]?.role == "bot") {
                            Surface(shape = MaterialTheme.shapes.extraSmall, color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.padding(start = 6.dp)) {
                                Text("BOT", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 4.dp, vertical = 1.dp))
                            }
                        }
                        StatusEmoji(store.users[message.senderId], controller, version, modifier = Modifier.padding(start = 6.dp))
                        if (channelLabel != null) {
                            Text(
                                channelLabel, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 6.dp).weight(1f, fill = false),
                            )
                        }
                        Spacer(Modifier.width(8.dp))
                        Text(Timeline.timeLabel(message.createdAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (message.editedAt != null) {
                            Spacer(Modifier.width(4.dp))
                            val own = message.senderId == store.me?.id
                            // M28c: my own 「(編集済み)」 opens the revisions from a 48 dp touch target; others' is plain text.
                            Text(
                                "(編集済み)", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                textDecoration = if (own) androidx.compose.ui.text.style.TextDecoration.Underline else null,
                                modifier = if (!own) Modifier else Modifier.touchTarget { source ->
                                    Modifier.clickable(interactionSource = source, indication = null, onClickLabel = "編集履歴") { showingRevisions = true }
                                },
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
                        onOpenCanvas = { id -> controller.scope.launch { controller.openCanvasLink(id) } },
                        customEmoji = store.customEmoji, emojiImages = store.emojiImages, emojiAnimations = store.emojiAnimations, onNeedEmojiImage = { controller.loadEmojiImage(it) }, version = version,
                        canvasCard = { canvasId -> CanvasLinkCard(controller, canvasId, version) },  // M58
                    )
                }
                message.poll?.let { PollCard(it, message, controller, version, readOnly) }  // M14b
                if (message.ackRequested && !message.pending) AckBar(message, store, controller, version, readOnly)  // M15e
                if (message.collection != null) CollectionChip(message, store, version)  // L6 (M60)
                if (message.tasks.isNotEmpty()) MessageTaskChips(message, controller, version)  // L9 (M64)
                AttachmentList(message.attachments, controller)
                // Not for this server's /m/ and /c/ links: a message shows in place, a canvas as its card (M58).
                if (!message.pending) Links.first(message.body)?.takeIf { link -> controller.serverBase?.let { Permalink.messageId(it, link) } == null && !CanvasCards.isCanvasLink(controller.serverBase, link) }?.let { link ->
                    // Review v0.1.18 #5: an AI bot's link is not previewed until tapped (decided by the sender, here).
                    LinkPreviewCard(controller, link, message.id, auto = LinkPreviewPolicy.autoLoads(message.senderId, store.users[message.senderId]?.role, controller.aiStatus))
                }
                ReactionChips(
                    message, store, onToggle = if (readOnly) null else onReact, onNeedEmojiImage = { controller.loadEmojiImage(it) },
                    onAdd = if (message.pending || readOnly) null else ({ pickingReaction = true }), version = version,  // M25 「＋」
                    onShowReactors = { showingReactors = true },  // M27
                )
                if (message.replyCount > 0 && onOpenThread != null) ThreadSummaryLine(message, store, onOpenThread)  // C3
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
            // M56: the message as a task (its channel's board, or 「自分のタスク」 from a DM or a board I may not add to).
            onMakeTask = if (controller.tasks?.available == true) ({
                controller.taskForm = TaskForm(
                    null,
                    TaskRules.messageTaskInit(
                        message.id, message.body, message.attachments.map { it.contentType }, store.channel(message.channelId),
                        store.users, store.groups, controller.isAdmin,
                    ),
                )
            }) else null,
            // L9 (M64): a review request in the message's conversation (a board I may add to, or a DM).
            onRequestReview = if (controller.tasks?.available == true && TaskRules.canRequestReview(store.channel(message.channelId), controller.isAdmin)) ({
                TaskRules.messageReviewInit(
                    message.id, message.body, message.attachments.map { it.contentType }, store.channel(message.channelId),
                    store.users, store.groups, controller.isAdmin, store.me?.id,
                )?.let { controller.taskForm = TaskForm(null, it) }
            }) else null,
            onShare = { sharing = true },
            quick = QuickReactions.row(store.me?.quickReactions, QuickReactions.read(controller.prefs)),  // M50
            onMoreReactions = { pickingReaction = true },
            onShowReactors = if (message.reactions.isEmpty()) null else ({ showingReactors = true }),
            reacted = store.me?.id?.let { me -> message.reactions.filter { me in it.userIds }.map { it.emoji }.toSet() } ?: emptySet(),
        )
    }
    if (showingReactors) ReactorsDialog(message, store, version, onNeedEmojiImage = { controller.loadEmojiImage(it) }, onDismiss = { showingReactors = false })
    if (sharing) ShareDialog(controller, message, version, onDismiss = { sharing = false })
    if (showingRevisions) RevisionsDialog(controller, message, onDismiss = { showingRevisions = false })
    if (pickingReaction) EmojiPickerSheet(recent = QuickReactions.read(controller.prefs), store = store, onNeedImage = { controller.loadEmojiImage(it) }, onDismiss = { pickingReaction = false }, onPick = { pickingReaction = false; onReact(it) })
    if (showingProfile) ProfileDialog(controller, message.senderId, version, onDismiss = { showingProfile = false }, onOpenDm = { controller.pendingChannelId = it })
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

