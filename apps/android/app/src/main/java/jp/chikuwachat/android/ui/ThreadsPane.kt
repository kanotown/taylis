package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.foundation.layout.size
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.ThreadEntry
import kotlinx.coroutines.launch
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.pluralStringResource

/**
 * Followed threads (THREADS.md §5): newest reply first, an all / unread filter; a row opens the thread. Its conversation
 * header (and the long-press menu's 「チャンネルを開く」 / 「会話を開く」) opens the conversation itself around the
 * thread's parent ([onOpenConversation]).
 */
@Composable
fun ThreadsPane(
    controller: AppController,
    version: Int,
    /** The thread; with a reply (one under a card), landing on that reply. */
    onOpen: (ThreadEntry, MessageState?) -> Unit,
    listState: LazyListState = rememberLazyListState(),
    onOpenConversation: (ThreadEntry) -> Unit = {},
) {
    val store = controller.store
    val rows = remember(version) { store.threadList() }
    val filter = store.threadsFilter
    val scope = rememberCoroutineScope()
    // M28c: offline the list says so instead of 「読み込んでいます…」 for good (the engine's load returns at once), and a
    // failed load offers 「再読み込み」; the reconnect loads again by itself (keyed on the status).
    var failed by remember { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }
    val offline = controller.engineStatus == EngineStatus.OFFLINE
    LaunchedEffect(controller.engineStatus, attempt) {
        failed = false
        try { controller.engine?.loadThreads(store.threadsFilter) } catch (e: Exception) { failed = true; controller.report(e) }
    }
    fun load(next: String, more: Boolean = false) {
        scope.launch {
            failed = false
            try { controller.engine?.loadThreads(next, more) } catch (e: Exception) { failed = true; controller.report(e) }
        }
    }

    LazyColumn(Modifier.fillMaxSize(), state = listState) {
        item {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                // The rows held are filtered at once; the new filter's first page completes them.
                FilterChip(selected = filter == "all", onClick = { store.selectThreadsFilter("all"); load("all") }, label = { Text(stringResource(R.string.common_all)) })
                FilterChip(selected = filter == "unread", onClick = { store.selectThreadsFilter("unread"); load("unread") }, label = { Text(stringResource(R.string.common_unread)) })
            }
        }
        if (rows.isEmpty()) {
            item {
                Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        when {
                            !store.threadsLoaded && offline -> stringResource(R.string.threads_pane_cant_load_threads_while_offline)
                            !store.threadsLoaded && failed -> stringResource(R.string.threads_pane_couldnt_load_threads)
                            !store.threadsLoaded -> stringResource(R.string.common_loading_2)
                            filter == "unread" -> stringResource(R.string.threads_pane_no_unread_threads)
                            else -> stringResource(R.string.threads_pane_no_followed_threads)
                        },
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Text(
                        if (!store.threadsLoaded && offline) stringResource(R.string.common_it_will_load_when_the_connection) else stringResource(R.string.threads_pane_threads_you_posted_in_replied_to),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                    if (!store.threadsLoaded && failed && !offline) TextButton(onClick = { attempt += 1 }) { Text(stringResource(R.string.common_reload)) }
                }
            }
        } else {
            items(rows, key = { it.id }) { entry ->
                ThreadRow(
                    entry, controller, version, { controller.loadEmojiImage(it) }, onClick = { onOpen(entry, null) },
                    onOpenConversation = { onOpenConversation(entry) }, onOpenReply = { onOpen(entry, it) },
                )
                HorizontalDivider()
            }
            if (store.threadsHasMore) {
                item { TextButton(onClick = { load(filter, more = true) }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.threads_pane_show_more)) } }
            }
        }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun ThreadRow(
    entry: ThreadEntry,
    controller: AppController,
    version: Int,
    onNeedEmojiImage: (jp.chikuwachat.android.api.CustomEmojiOut) -> Unit,
    onClick: () -> Unit,
    onOpenConversation: () -> Unit,
    onOpenReply: (MessageState) -> Unit,
) {
    val store = controller.store
    val parent = entry.parent
    val state = entry.state
    val unread = state.unreadCount > 0
    val author = store.users[parent.senderId]?.displayName ?: "…"
    val last = state.lastReplyAt ?: parent.createdAt
    val excerpt = messageLine(parent.body, parent.attachments, store)
    val channel = store.channel(state.channelId)
    val title = channel?.let { channelTitle(it, store) } ?: ""
    val openLabel = stringResource(if (channel?.channel?.isDm == true) R.string.threads_pane_open_conversation else R.string.threads_pane_open_channel)
    var menu by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.fillMaxWidth()
                .combinedClickable(onClick = onClick, onLongClick = { menu = true }, onLongClickLabel = stringResource(R.string.common_menu))
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Avatar(parent.senderId, author, size = 36.dp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    // The conversation's name is a link of its own: the conversation around this thread's parent.
                    val linkLabel = stringResource(R.string.threads_pane_open_named, title)
                    Box(
                        Modifier.weight(1f, fill = false)
                            .heightIn(min = 32.dp)
                            .clip(RoundedCornerShape(4.dp))
                            .clickable(enabled = channel != null, onClickLabel = openLabel, role = Role.Button, onClick = onOpenConversation)
                            .semantics(mergeDescendants = true) { contentDescription = linkLabel }
                            .padding(end = 4.dp),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        Text(
                            title,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Spacer(Modifier.weight(1f))
                    Text(Timeline.timeLabel(last), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(author, style = MaterialTheme.typography.titleSmall, fontWeight = if (unread) FontWeight.Bold else FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                EmojiLineText(
                    excerpt, store, onNeedEmojiImage, version, MaterialTheme.typography.bodyMedium,
                    if (unread) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                )
                Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        pluralStringResource(R.plurals.common_replies_count, state.replyCount, state.replyCount),
                        style = MaterialTheme.typography.labelMedium,
                        color = if (unread) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal,
                    )
                    if (unread) Text(stringResource(R.string.threads_pane_unread, state.unreadCount), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.weight(1f))
                    if (unread) {
                        Text(
                            if (state.mentionCount > 0) "@${state.mentionCount}" else state.unreadCount.toString(),
                            color = MaterialTheme.colorScheme.onPrimary,
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier
                                .background(if (state.mentionCount > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary, CircleShape)
                                .padding(horizontal = 7.dp, vertical = 2.dp),
                        )
                    }
                }
                val card = ThreadCardRules.replies(entry, store.me?.id) { store.isBlocked(it) }
                if (card != null && card.replies.isNotEmpty()) {
                    Column(Modifier.padding(top = 6.dp).fillMaxWidth()) {
                        if (card.more > 0) {
                            Text(
                                pluralStringResource(R.plurals.threads_pane_more_replies, card.more, card.more),
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.primary,
                                fontWeight = FontWeight.Medium,
                                modifier = Modifier
                                    .heightIn(min = 32.dp)
                                    .clip(RoundedCornerShape(4.dp))
                                    .clickable(role = Role.Button, onClick = onClick)
                                    .padding(horizontal = 4.dp, vertical = 6.dp),
                            )
                        }
                        // The replies hang off a thin line, like the thread they belong to.
                        val line = MaterialTheme.colorScheme.outlineVariant
                        Column(
                            Modifier.fillMaxWidth()
                                .drawBehind { drawRect(line, size = Size(2.dp.toPx(), size.height)) }
                                .padding(start = 8.dp),
                        ) {
                            card.replies.forEach { reply ->
                                ThreadPreviewReply(reply, controller, version, onClick = { onOpenReply(reply.message) })
                            }
                        }
                    }
                }
            }
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(text = { Text(stringResource(R.string.common_open_thread)) }, onClick = { menu = false; onClick() })
            DropdownMenuItem(text = { Text(openLabel) }, enabled = channel != null, onClick = { menu = false; onOpenConversation() })
        }
    }
}

/** The replies part of a threads-list card (THREADS.md §5). */
object ThreadCardRules {
    /** [unread]: someone else's reply after my read position in the thread (marked as the thread view marks it). */
    data class Reply(val message: MessageState, val unread: Boolean)

    /** [more] is 「他 n 件の返信」 (0: every reply is in the card). */
    data class Card(val replies: List<Reply>, val more: Int)

    /** null when the server sent no previews (the card is the parent only, as before). */
    fun replies(entry: ThreadEntry, me: String?, isBlocked: (String) -> Boolean): Card? {
        val latest = entry.latestReplies ?: return null
        // Someone blocked after the list came: their replies leave the card at once (the server leaves them out too).
        val shown = latest.filter { !it.deleted && !isBlocked(it.senderId) }
            .map { Reply(it, it.senderId != me && (it.seq ?: 0) > entry.state.lastReadSeq) }
        return Card(shown, maxOf(0, entry.state.replyCount - shown.size))
    }
}

/** A reply under a card: compact, the body in the message renderer cut to four lines' height. */
@Composable
private fun ThreadPreviewReply(reply: ThreadCardRules.Reply, controller: AppController, version: Int, onClick: () -> Unit) {
    val store = controller.store
    val message = reply.message
    val name = store.users[message.senderId]?.displayName ?: "…"
    val label = stringResource(R.string.threads_pane_reply_from, name)
    Row(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .clickable(onClickLabel = label, role = Role.Button, onClick = onClick)
            .padding(horizontal = 4.dp, vertical = 4.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Avatar(message.senderId, name, size = 22.dp)
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    name,
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = if (reply.unread) FontWeight.Bold else FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Spacer(Modifier.width(6.dp))
                Text(Timeline.timeLabel(message.createdAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (reply.unread) {
                    val unreadLabel = stringResource(R.string.common_unread)
                    Spacer(Modifier.width(6.dp))
                    Box(Modifier.size(7.dp).background(MaterialTheme.colorScheme.primary, CircleShape).semantics { contentDescription = unreadLabel })
                }
            }
            if (message.body.isBlank()) {
                Text(messageLine(message.body, message.attachments, store), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                Box(Modifier.heightIn(max = 84.dp).clipToBounds()) {
                    MessageBody(
                        message.body, store.users, groups = store.groups, internalBase = controller.serverBase,
                        customEmoji = store.customEmoji, emojiImages = store.emojiImages, emojiAnimations = store.emojiAnimations,
                        onNeedEmojiImage = { controller.loadEmojiImage(it) }, version = version,
                    )
                }
            }
        }
    }
}
