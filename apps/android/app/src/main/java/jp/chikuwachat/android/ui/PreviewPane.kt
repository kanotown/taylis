package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.WorkspaceSettingsOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelPreview
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.MessageState
import kotlinx.coroutines.launch
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.pluralStringResource

/**
 * A public channel read before joining (SYNC_PROTOCOL.md §7.6.1, M27): its latest messages (older pages as the reader
 * scrolls up), read-only, with 「#name に参加する」 where the composer would be. Apart from ChannelPane on purpose: none
 * of the member timeline applies here (no cursor, read position, divider, typing or drafts). A link's message shows
 * with the rows around it (the context), like the channel view, until 「最新の会話へ」. Tapping a row opens its thread,
 * read-only too ([PreviewThreadPane]). `version` is read: the rows live in the Store.
 */
@Composable
fun PreviewPane(controller: AppController, channelId: String, version: Int, onOpenThread: (String) -> Unit) {
    val store = controller.store
    val channel = store.channel(channelId) ?: return
    val focus = controller.messageFocus?.takeIf { it.channelId == channelId }
    val preview = remember(version, channelId) { store.preview?.takeIf { it.channelId == channelId } }
    val me = remember(version) { store.me?.id }
    val messages = remember(preview, focus) { focus?.context?.filter { !it.deleted } ?: preview?.messages ?: emptyList() }
    val grouping = controller.groupPosts
    val items = remember(messages, me, grouping) { Timeline.build(messages, null, me, grouping = grouping).asReversed() }
    // M89 (MEMBERSHIP.md §5 item 5): the workspace turned the preview off: the join panel, no rows (follows the switch live).
    val refused = PreviewJoin.refused(preview, store.workspaceSettings)
    val listState = rememberLazyListState()
    var loadingOlder by remember(channelId) { mutableStateOf(false) }
    // M28c: a failed older page offers 「再読み込み」 instead of spinning for good (the effect only ran again on a new row).
    var olderFailed by remember(channelId) { mutableStateOf(false) }
    var olderAttempt by remember(channelId) { mutableIntStateOf(0) }
    // A link's message (or its thread's parent) centred once its rows are there.
    LaunchedEffect(channelId, focus?.messageId, items.isEmpty()) {
        val id = focus?.let { it.parentId ?: it.messageId } ?: return@LaunchedEffect
        val index = Timeline.indexOf(items, id)
        if (index >= 0) listState.centerOn(index)
    }
    Column(Modifier.fillMaxSize()) {
        if (focus != null) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.preview_pane_conversation_around_the_linked_message), style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                TextButton(onClick = { controller.messageFocus = null }) { Text(stringResource(R.string.common_go_to_latest)) }
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (refused) {
                JoinToReadPanel(controller, channel)
            } else if (focus == null && preview?.loaded != true) {
                PreviewLoading(failed = preview?.failed == true, onRetry = { controller.scope.launch { controller.openChannel(channelId) } })
            } else {
                LazyColumn(state = listState, reverseLayout = true, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 8.dp)) {
                    items(items, key = { it.key }) { item ->
                        when (item) {
                            is TimelineItem.DateSeparator -> DaySeparator(item.label)
                            is TimelineItem.UnreadSeparator -> Unit // never drawn here: a preview has no read position
                            is TimelineItem.Message -> PreviewRow(item.message, controller, version, compact = item.compact) {
                                onOpenThread(item.message.parentId ?: item.message.id)
                            }
                        }
                    }
                    if (focus == null && preview?.hasOlder == true) {
                        item(key = "older") {
                            LaunchedEffect(messages.size, controller.engineStatus, olderAttempt) {
                                if (controller.engineStatus != EngineStatus.ONLINE || loadingOlder || olderFailed) return@LaunchedEffect
                                loadingOlder = true
                                try { olderFailed = !controller.loadOlderPreview(channelId) } finally { loadingOlder = false }
                            }
                            if (olderFailed) LoadFailedRow(stringResource(R.string.common_couldnt_load_earlier_messages)) { olderFailed = false; olderAttempt += 1 }
                            else Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.width(20.dp), strokeWidth = 2.dp) }
                        }
                    } else if (messages.isEmpty()) {
                        item(key = "empty") {
                            Text(stringResource(R.string.common_no_messages_yet), style = MaterialTheme.typography.titleMedium, modifier = Modifier.fillMaxWidth().padding(32.dp))
                        }
                    } else if (focus == null) {
                        item(key = "start") { ChannelIntro(channel, store, version) }
                    }
                }
            }
        }
        // The panel has the one button (MEMBERSHIP.md §5 item 5).
        if (!refused) {
            HorizontalDivider()
            JoinBar(controller, channel)
        }
    }
}

/**
 * A thread opened from a preview (§7.6.1): the parent and its replies, fetched when it opens and kept with the preview.
 * No composer, follow toggle or read position; the join bar stays at the bottom.
 */
@Composable
fun PreviewThreadPane(controller: AppController, channelId: String, parentId: String, version: Int) {
    val store = controller.store
    val channel = store.channel(channelId) ?: return
    val focus = controller.messageFocus?.takeIf { it.channelId == channelId }
    val preview = remember(version, channelId) { store.preview?.takeIf { it.channelId == channelId } }
    val parent = remember(preview, focus, parentId) {
        preview?.messages?.firstOrNull { it.id == parentId } ?: focus?.context?.firstOrNull { it.id == parentId }
    }
    val replies = preview?.replies?.get(parentId)
    // M89: turned off while the thread is open: the same panel as the channel's.
    if (PreviewJoin.refused(preview, store.workspaceSettings)) {
        JoinToReadPanel(controller, channel)
        return
    }
    val listState = rememberLazyListState()
    // M28c: a failed fetch says so with 「再読み込み」 instead of 「返信を読み込んでいます…」 for good.
    var repliesFailed by remember(parentId) { mutableStateOf(false) }
    var repliesAttempt by remember(parentId) { mutableIntStateOf(0) }
    LaunchedEffect(parentId, controller.engineStatus, repliesAttempt) {
        if (replies == null && controller.engineStatus == EngineStatus.ONLINE) repliesFailed = !controller.loadPreviewReplies(channelId, parentId)
    }
    // A link to a reply: centred once the replies are there (the parent and the count line come first).
    LaunchedEffect(parentId, focus?.messageId, replies == null) {
        val index = replies?.indexOfFirst { it.id == focus?.messageId } ?: -1
        if (index >= 0) listState.centerOn(index + 2)
    }
    Column(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = listState) {
            item(key = "parent") {
                if (parent != null) PreviewRow(parent, controller, version)
                else Text(stringResource(R.string.preview_pane_the_original_message_is_not_in), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
            }
            item(key = "divider") {
                if (replies == null && repliesFailed) {
                    LoadFailedRow(stringResource(R.string.preview_pane_couldnt_load_replies)) { repliesFailed = false; repliesAttempt += 1 }
                } else {
                    Text(
                        when {
                            replies == null -> stringResource(R.string.preview_pane_loading_replies)
                            replies.isEmpty() -> stringResource(R.string.common_no_replies_yet)
                            else -> pluralStringResource(R.plurals.common_replies_count, replies.size, replies.size)
                        },
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                    )
                }
                HorizontalDivider()
            }
            items(replies ?: emptyList(), key = { it.id }) { PreviewRow(it, controller, version) }
        }
        HorizontalDivider()
        JoinBar(controller, channel)
    }
}

/** One read-only row (MessageRow without its actions); `onOpenThread` null in a thread. */
@Composable
private fun PreviewRow(message: MessageState, controller: AppController, version: Int, compact: Boolean = false, onOpenThread: (() -> Unit)? = null) {
    MessageRow(
        message, controller.store, controller, version, compact = compact, canEdit = false, canDelete = false,
        onRetry = {}, onDiscard = {}, onReact = {}, onEdit = { false }, onDelete = {}, onOpenThread = onOpenThread, readOnly = true,
    )
}

@Composable
private fun PreviewLoading(failed: Boolean, onRetry: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        if (failed) {
            Text(stringResource(R.string.preview_pane_couldnt_load_the_message), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = onRetry) { Text(stringResource(R.string.common_reload)) }
        } else {
            CircularProgressIndicator(Modifier.width(24.dp), strokeWidth = 2.dp)
        }
    }
}

/** The preview's join bar, apart from Compose so it can be tested. */
object PreviewJoin {
    /** In place of the button when the channel is archived. */
    val ARCHIVED_NOTE: String get() = L10n.str(R.string.preview_pane_this_channel_is_archived_read_only)

    /** Whether 「#name に参加する」 is offered: not for an archived channel (the server refuses: 409 channel_archived). */
    fun canJoin(channel: jp.chikuwachat.android.api.ChannelOut): Boolean = !channel.archived

    /** M89 (MEMBERSHIP.md §5 item 5): the rows are not shown before joining: the workspace's switch, or the server's 403. */
    fun refused(preview: ChannelPreview?, settings: WorkspaceSettingsOut): Boolean = preview?.disabled == true || !settings.previewBeforeJoin

    val REFUSED_TITLE: String get() = L10n.str(R.string.preview_pane_join_to_read_the_messages)

    /** What the panel says of the channel: its purpose, else its topic (as the desktop's JoinToReadPanel). */
    fun about(channel: jp.chikuwachat.android.api.ChannelOut): String? =
        channel.purpose?.takeIf { it.isNotBlank() } ?: channel.topic?.takeIf { it.isNotBlank() }

    fun memberLine(channel: jp.chikuwachat.android.api.ChannelOut): String? = channel.memberCount?.takeIf { it > 0 }?.let { L10n.plural(R.plurals.common_members_count, it, it) }
}

/**
 * M89 (MEMBERSHIP.md §5 item 5): in place of the rows while the workspace does not show them before joining: the channel's
 * purpose (or topic), its member count and 参加 (the bar below steps aside so there is one button).
 */
@Composable
private fun JoinToReadPanel(controller: AppController, channel: ChannelState) {
    var joining by remember(channel.id) { mutableStateOf(false) }
    val out = channel.channel
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("#${out.name ?: ""}", style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(PreviewJoin.REFUSED_TITLE, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        PreviewJoin.about(out)?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center) }
        PreviewJoin.memberLine(out)?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (!PreviewJoin.canJoin(out)) {
            Text(PreviewJoin.ARCHIVED_NOTE, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        } else {
            Button(
                enabled = !joining && controller.engineStatus == EngineStatus.ONLINE,
                // The controller's scope: joining replaces this pane, which must not cancel the join half-way.
                onClick = { joining = true; controller.scope.launch { try { controller.joinChannel(channel.id) } finally { joining = false } } },
            ) { Text(if (joining) stringResource(R.string.preview_pane_joining) else stringResource(R.string.common_join)) }
        }
    }
}

/** Where the composer would be: 「#name に参加する」, after which the conversation carries on as a joined one. */
@Composable
private fun JoinBar(controller: AppController, channel: ChannelState) {
    var joining by remember(channel.id) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        if (!PreviewJoin.canJoin(channel.channel)) {
            Text(PreviewJoin.ARCHIVED_NOTE, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        } else {
            Text(stringResource(R.string.preview_pane_join_to_post_and_react), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Button(
                enabled = !joining,
                // The controller's scope: joining replaces this pane, which must not cancel the join half-way.
                onClick = { joining = true; controller.scope.launch { try { controller.joinChannel(channel.id) } finally { joining = false } } },
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
            ) {
                Text(stringResource(R.string.preview_pane_join, channel.channel.name ?: ""), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
