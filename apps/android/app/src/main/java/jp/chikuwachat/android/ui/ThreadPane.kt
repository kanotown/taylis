package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.ReadGate
import jp.chikuwachat.android.sync.toOut
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/** Thread list rows (SYNC_PROTOCOL.md §10.2, §10.3): the parent and the reply count line come before the replies. */
object ThreadRows {
    fun header(hasParent: Boolean): Int = if (hasParent) 2 else 1

    /** The reply at a LazyColumn index. By index, never by key: keys are rowKeys, which no message id equals. */
    fun replyAt(replies: List<MessageState>, header: Int, index: Int): MessageState? = if (index < header) null else replies.getOrNull(index - header)

    /**
     * The focus centred, else the first unread reply (「新しい返信」 above it) at the top, else the last reply.
     * `lastReadSeq` null = the thread is not ready yet, so no unread reply is looked for.
     */
    fun openPosition(replies: List<MessageState>, header: Int, focusId: String?, lastReadSeq: Int?, meId: String?): OpenPosition {
        val focus = focusId?.let { id -> replies.indexOfFirst { it.id == id } } ?: -1
        if (focus >= 0) return OpenPosition.Center(focus + header)
        val first = lastReadSeq?.let { ReadGate.firstUnreadRow(replies, it, meId) } ?: return OpenPosition.Bottom
        return OpenPosition.Top(replies.indexOf(first) + header)
    }
}

/**
 * One thread: the parent, its replies (oldest first) and a composer that posts with parent_id.
 * Replies that were fully shown advance the thread read position (THREADS.md §5) once the whole thread is loaded
 * and the first unread reply was on screen (§10.2); the follow toggle lives in the app bar (MainScreen).
 */
@Composable
fun ThreadPane(controller: AppController, channelId: String, parentId: String, version: Int) {
    val store = controller.store
    val entry = store.threads[parentId]
    val parent = store.message(channelId, parentId)
        ?: entry?.parent?.let { MessageState.from(it) }
        ?: controller.messageFocus?.context?.firstOrNull { it.id == parentId }
    // Successful reply fetches in this open: a fetch that changed no row bumps no store version, yet makes the thread complete.
    var loads by remember(parentId) { mutableIntStateOf(0) }
    // The rows, my read position and the engine's complete flag in one read, so the read gate judges the rows the
    // list shows (the store is live, and a scroll can lay out the old rows before the next recomposition).
    val shown = remember(version, parentId, loads) {
        ThreadShown(store.replies(channelId, parentId), store.threads[parentId]?.state?.lastReadSeq, controller.engine?.threadComplete(parentId) == true)
    }
    val replies = shown.replies
    val listState = rememberLazyListState()
    val header = ThreadRows.header(parent != null)
    // 「新しい返信」 sits before the first reply from someone else past my read position.
    val me = store.me?.id
    val firstUnreadId = shown.lastReadSeq?.let { ReadGate.firstUnreadRow(replies, it, me)?.id }
    val focusId = controller.messageFocus?.takeIf { it.parentId == parentId }?.messageId
    // §10.2: the whole thread was fetched in this open (the engine drops it with the channel's rows) and my read
    // position is known; before that the held replies may be only the new ones that arrived live.
    val complete = shown.complete
    val threadReady = loads > 0 && complete && shown.lastReadSeq != null
    var placed by remember(parentId) { mutableStateOf(false) }
    var positioned by remember(parentId) { mutableStateOf(false) }
    var userScrolled by remember(parentId) { mutableStateOf(false) }
    var anchored by remember(parentId) { mutableStateOf(false) }
    // The keyboard and the input growing: the newest reply (or the one read last) stays above the input.
    KeepBottomOnResize(listState, enabled = placed || positioned)

    suspend fun scrollTo(at: OpenPosition) {
        when (at) {
            is OpenPosition.Center -> listState.centerOn(at.index)
            is OpenPosition.Top -> listState.scrollToItem(at.index)
            OpenPosition.Bottom -> listState.scrollToItem(header + replies.size - 1)
        }
    }
    LaunchedEffect(parentId) {
        listState.interactionSource.interactions.collect { if (it is DragInteraction.Start) userScrolled = true }
    }
    // §10.2: while on screen, a threads-list refresh keeps this thread's state (the read gate needs it).
    val engine = controller.engine
    DisposableEffect(engine, parentId) {
        engine?.threadShown(parentId, true)
        onDispose { engine?.threadShown(parentId, false) }
    }
    // The held rows at the bottom (or the focus) at once; the §10.2 position once, when the thread is ready,
    // unless the reader has scrolled meanwhile.
    LaunchedEffect(parentId, replies.size, threadReady) {
        if (positioned) return@LaunchedEffect
        if (threadReady) {
            positioned = true
            if (userScrolled) return@LaunchedEffect
            val at = ThreadRows.openPosition(replies, header, focusId, shown.lastReadSeq, me)
            scrollTo(at)
            if (at is OpenPosition.Top) anchored = true
        } else if (!placed && replies.isNotEmpty()) {
            placed = true
            scrollTo(ThreadRows.openPosition(replies, header, focusId, null, me))
        }
    }
    suspend fun load() {
        try { if (controller.engine?.loadReplies(channelId, parentId) == true) loads += 1 }
        catch (e: Exception) { controller.report(e) }
    }
    LaunchedEffect(parentId, controller.engineStatus) { load() }
    // A §7.3 reload of the channel dropped the fetched thread: fetch it again.
    LaunchedEffect(parentId, complete) { if (!complete && loads > 0) load() }
    // THREADS.md §5: my relation to the thread (follow flag, read position) is fetched once per thread.
    LaunchedEffect(parentId, controller.engineStatus, parent?.seq) {
        if (store.threads[parentId] != null) return@LaunchedEffect
        val out = parent?.toOut() ?: return@LaunchedEffect
        try { controller.engine?.loadThreadState(parentId, out) }
        catch (e: Exception) { controller.report(e) }
    }
    // Read position = the newest reply fully shown (never just "opened"), like the timeline, and only anchored.
    LaunchedEffect(parentId, threadReady, controller.engineStatus, controller.appForeground, shown, header) {
        if (!controller.appForeground) return@LaunchedEffect
        val first = shown.lastReadSeq?.let { ReadGate.firstUnreadRow(replies, it, me) }
        snapshotFlow { listState.layoutInfo }.collectLatest { layout ->
            val seen = layout.seenIndexes().mapNotNull { ThreadRows.replyAt(replies, header, it) }
            // Partly shown replies too: the first unread one above every shown reply and not even partly on screen was
            // passed unseen (new replies arrived while away and the list followed them), and the anchor drops.
            val onScreen = layout.onScreenIndexes().mapNotNullTo(HashSet()) { ThreadRows.replyAt(replies, header, it)?.id }
            anchored = ReadGate.nextThreadAnchored(anchored, threadReady, first, seen, onScreen)
            if (anchored) seen.mapNotNull { it.seq }.maxOrNull()?.let { controller.engine?.markThreadRead(parentId, it) }
        }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth().closesKeyboardOnTap(LocalFocusManager.current), state = listState) {
            if (parent != null) {
                item(key = "parent") { ThreadMessage(parent, store, controller, version) }
                item(key = "divider") {
                    Text(
                        if (replies.isEmpty()) "返信はまだありません" else "${replies.size} 件の返信",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                    )
                    HorizontalDivider()
                }
            } else {
                item { Text("メッセージが見つかりません", modifier = Modifier.padding(16.dp)) }
            }
            items(replies, key = { it.rowKey }) { reply ->
                Column {
                    if (reply.id == firstUnreadId) NewRepliesDivider()
                    ThreadMessage(reply, store, controller, version)
                }
            }
        }
        HorizontalDivider()
        val channel = store.channel(channelId)
        if (parent != null && channel?.isMember == true && !channel.channel.archived) {
            TypingLine(controller, channelId, parentId, version)
            ConversationComposer(controller, channelId, version, parentId)
        }
    }
}

/** What one store version shows of a thread (see ThreadPane). */
private data class ThreadShown(val replies: List<MessageState>, val lastReadSeq: Int?, val complete: Boolean)

@Composable
private fun NewRepliesDivider() {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f).height(1.dp).background(MaterialTheme.colorScheme.error.copy(alpha = 0.6f)))
        Text(
            "  新しい返信",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.error,
            fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
private fun ThreadMessage(message: MessageState, store: jp.chikuwachat.android.sync.Store, controller: AppController, version: Int) {
    MessageRow(
        message, store, controller, version,
        canEdit = !message.pending && message.senderId == store.me?.id,
        canDelete = !message.pending && (message.senderId == store.me?.id || controller.isAdmin),
        onRetry = { controller.scope.launch { controller.engine?.retryFailed() } },
        onDiscard = { controller.engine?.discardFailed(message.clientMsgId ?: "") },
        onReact = { emoji -> controller.scope.launch { controller.toggleReaction(message, emoji) } },
        onEdit = { body -> controller.scope.launch { controller.editMessage(message.id, Mentions.encode(body, store.users.values, store.groups.values)) } },
        onDelete = { controller.scope.launch { controller.deleteMessage(message.id) } },
    )
}
