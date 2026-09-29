package jp.chikuwachat.android.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AddReaction
import androidx.compose.material.icons.outlined.Alarm
import androidx.compose.material.icons.outlined.BookmarkBorder
import androidx.compose.material.icons.outlined.BookmarkRemove
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.MarkEmailUnread
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import jp.chikuwachat.android.platform.KeyValueStore
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.launch

val REACTION_PALETTE = listOf("👍", "❤️", "😂", "🎉", "👀", "✅")

/**
 * The sheet's six quick reactions: the ones I used last first, then REACTION_PALETTE (tester request, 2026-09-28; the
 * same rule as the web's quickReactions and iOS). Custom emoji stay in the picker: the quick row shows plain emoji.
 */
object QuickReactions {
    private const val KEY = "reactions.recent"
    private val custom = Regex("^:[^:\\s]+:$")

    fun read(store: KeyValueStore): List<String> = store.getString(KEY)?.split("\n")?.filter { it.isNotEmpty() } ?: emptyList()

    /** Called when I add a reaction (not when I take one back). */
    fun remember(store: KeyValueStore, glyph: String) {
        store.putString(KEY, (listOf(glyph) + read(store).filter { it != glyph }).take(16).joinToString("\n"))
    }

    fun pick(recent: List<String>, count: Int = 6): List<String> = (recent.filterNot { custom.matches(it) } + REACTION_PALETTE).distinct().take(count)
}

/**
 * A message's actions, Slack-like (testers, 2026-09-28; the same sheet on iOS, MessageActions.swift): a long press opens
 * them from the bottom. Reactions first as big buttons, then reply, edit (author), copy, …, delete (author / admin) last.
 * An action that opens a dialog runs once the sheet is down.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessageMenu(
    expanded: Boolean,
    canEdit: Boolean,
    canDelete: Boolean,
    onDismiss: () -> Unit,
    onReact: (String) -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onReply: (() -> Unit)? = null,
    onMarkUnread: (() -> Unit)? = null,
    pinned: Boolean = false,
    onPin: (() -> Unit)? = null,
    bookmarked: Boolean = false,
    onBookmark: (() -> Unit)? = null,
    onMoreReactions: (() -> Unit)? = null,
    onCopyLink: (() -> Unit)? = null,
    onRemind: (() -> Unit)? = null,
    onShare: (() -> Unit)? = null,
    onCopyText: (() -> Unit)? = null,
    /** M27: 「リアクションした人」, offered when the message has reactions. */
    onShowReactors: (() -> Unit)? = null,
    reacted: Set<String> = emptySet(),
    quick: List<String> = REACTION_PALETTE,
) {
    if (!expanded) return
    // Opens at its full height: half open cut off ピン留め and 削除 (testers, 2026-09-29).
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    fun close(then: () -> Unit) {
        scope.launch { sheet.hide() }.invokeOnCompletion { onDismiss(); then() }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            quick.forEach { emoji ->
                Box(
                    Modifier.size(46.dp).clip(CircleShape)
                        .background(if (emoji in reacted) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant)
                        .clickable { close { onReact(emoji) } },
                    contentAlignment = Alignment.Center,
                ) { Text(emoji, style = MaterialTheme.typography.titleLarge) }
            }
            if (onMoreReactions != null) {
                Box(
                    Modifier.size(46.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant).clickable { close(onMoreReactions) },
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Outlined.AddReaction, contentDescription = "その他のリアクション") }
            }
        }
        Column(Modifier.fillMaxWidth().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(top = 8.dp, bottom = 8.dp)) {
            @Composable
            fun item(label: String, icon: ImageVector, danger: Boolean = false, action: () -> Unit) {
                val color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
                Row(
                    Modifier.fillMaxWidth().clickable { close(action) }.padding(horizontal = 24.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(22.dp))
                    Spacer(Modifier.width(18.dp))
                    Text(label, color = color, style = MaterialTheme.typography.bodyLarge)
                }
            }
            if (onReply != null) item("スレッドで返信", Icons.Outlined.ChatBubbleOutline, action = onReply)
            if (onShowReactors != null) item("リアクションした人", Icons.Outlined.People, action = onShowReactors)
            if (canEdit) item("編集", Icons.Outlined.Edit, action = onEdit)
            if (onCopyText != null) item("テキストをコピー", Icons.Outlined.ContentCopy, action = onCopyText)
            if (onBookmark != null) item(if (bookmarked) "保存を解除" else "あとで見る (保存)", if (bookmarked) Icons.Outlined.BookmarkRemove else Icons.Outlined.BookmarkBorder, action = onBookmark)
            if (onRemind != null) item("リマインド…", Icons.Outlined.Alarm, action = onRemind)
            if (onMarkUnread != null) item("ここから未読にする", Icons.Outlined.MarkEmailUnread, action = onMarkUnread)
            if (onCopyLink != null) item("リンクをコピー", Icons.Outlined.Link, action = onCopyLink)
            if (onShare != null) item("別のチャンネルに共有…", Icons.Outlined.Share, action = onShare)
            if (onPin != null) item(if (pinned) "ピン留めを外す" else "チャンネルにピン留め", Icons.Outlined.PushPin, action = onPin)
            if (canDelete) item("削除", Icons.Outlined.Delete, danger = true, action = onDelete)
        }
    }
}

/**
 * Reaction chips under a message; tapping toggles my reaction. M25: a 「＋」 chip after them adds another one without
 * the long press (as on the web, Timeline.tsx). M27: a long press on a chip shows who reacted ([ReactorsDialog]).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ReactionChips(
    message: MessageState,
    store: Store,
    /** Null: the chips only show (a channel previewed before joining, SYNC_PROTOCOL.md §7.6.1). */
    onToggle: ((String) -> Unit)?,
    onNeedEmojiImage: ((jp.chikuwachat.android.api.CustomEmojiOut) -> Unit)? = null,
    /** The 「＋」 chip: the picker the sheet's 「その他のリアクション」 opens. Null = no chip. */
    onAdd: (() -> Unit)? = null,
    /** The Store's version: custom emoji images land in the Store, not in `message` (strong skipping). */
    version: Int = 0,
    /** M27: a long press on a chip; the caller opens 「リアクションした人」. */
    onShowReactors: (() -> Unit)? = null,
) {
    if (message.reactions.isEmpty()) return
    // Read on purpose (MessageBody): an unread parameter is left out of the skip check, and a custom emoji's image that
    // arrived after the first draw never showed.
    val me = remember(version) { store.me?.id }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 4.dp)) {
        message.reactions.forEach { reaction ->
            val mine = me != null && me in reaction.userIds
            val shape = RoundedCornerShape(12.dp)
            val background = if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant
            val custom = CustomEmoji.name(reaction.emoji)?.let { store.customEmoji[it] }
            val image = custom?.let { store.emojiImages[it.id] }
            if (custom != null && image == null) onNeedEmojiImage?.invoke(custom)
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .border(1.dp, if (mine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant, shape)
                    .background(background, shape)
                    .combinedClickable(
                        enabled = onToggle != null || onShowReactors != null,
                        onLongClickLabel = "リアクションした人",
                        onLongClick = onShowReactors,
                        onClick = { onToggle?.invoke(reaction.emoji) },
                    )
                    .padding(horizontal = 8.dp, vertical = 3.dp),
            ) {
                if (image != null) {
                    EmojiImage(image, custom?.let { store.emojiAnimations[it.id] }, contentDescription = reaction.emoji, modifier = Modifier.size(16.dp))
                    Text(" ${reaction.count}", style = MaterialTheme.typography.labelLarge)
                } else {
                    Text("${reaction.emoji} ${reaction.count}", style = MaterialTheme.typography.labelLarge)
                }
            }
        }
        if (onAdd != null) {
            val shape = RoundedCornerShape(12.dp)
            // As tall as a count chip (one labelLarge line + its padding) at any font scale.
            val lineHeight = MaterialTheme.typography.labelLarge.lineHeight.takeIf { it.isSp } ?: 20.sp
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .heightIn(min = with(LocalDensity.current) { lineHeight.toDp() } + 6.dp)
                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
                    .clip(shape)
                    .clickable(role = Role.Button, onClick = onAdd)
                    .padding(horizontal = 8.dp),
            ) {
                Icon(Icons.Outlined.AddReaction, contentDescription = "リアクションを追加", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
            }
        }
    }
}

@Composable
fun EditMessageDialog(initial: String, saving: Boolean = false, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var text by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("メッセージを編集") },
        text = { OutlinedTextField(text, { text = it }, maxLines = 8, enabled = !saving) },
        confirmButton = { TextButton(enabled = text.isNotBlank() && !saving, onClick = { onSave(text.trim()) }) { Text(if (saving) "保存中…" else "保存") } },
        dismissButton = { TextButton(enabled = !saving, onClick = onDismiss) { Text("キャンセル") } },
    )
}

@Composable
fun ConfirmDeleteDialog(onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("メッセージを削除") },
        text = { Column { Text("削除したメッセージは元に戻せません。") } },
        confirmButton = { TextButton(onClick = onConfirm) { Text("削除", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
}
