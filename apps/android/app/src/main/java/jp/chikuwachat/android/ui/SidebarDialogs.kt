package jp.chikuwachat.android.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AddReaction
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import jp.chikuwachat.android.api.SidebarSectionOut
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch
import java.text.Collator
import java.util.Locale

/**
 * Long-press on a conversation (M14f): star it, or move it into one of my sections (M26: or a new one, made with it).
 * `version` (M28c): the sections, the star and the icons' images live in the Store.
 */
@Composable
fun ChannelSectionDialog(controller: AppController, channelId: String, version: Int, onDismiss: () -> Unit, onNewSection: () -> Unit) {
    val store = controller.store
    val channel = store.channels[channelId] ?: return onDismiss()
    val current = remember(version, channelId) { store.sectionOf(channelId) }
    val starred = remember(version, channelId) { channelId in store.favorites }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(channelTitle(channel, store)) },
        text = {
            Column {
                TextButton(onClick = { scope.launch { controller.toggleFavorite(channelId); onDismiss() } }) {
                    Text(if (starred) "お気に入りから外す" else "お気に入りに追加")
                }
                HorizontalDivider()
                Text("セクションに移動", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
                store.sidebarSections.forEach { section ->
                    Row(
                        Modifier.fillMaxWidth().clickable(enabled = section.id != current) { scope.launch { if (controller.moveToSection(channelId, section.id)) onDismiss() } }.padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = section.id == current, onClick = null)
                        Spacer(Modifier.width(8.dp))
                        SectionIcon(controller, section.emoji, version)
                        Text(section.name, modifier = Modifier.padding(start = if (section.emoji != null) 6.dp else 0.dp))
                    }
                }
                TextButton(onClick = onNewSection) { Text("新しいセクション…") }
                if (current != null) {
                    TextButton(onClick = { scope.launch { if (controller.moveToSection(channelId, null)) onDismiss() } }) { Text("セクションから外す") }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
    )
}

/** The 「…」 on a custom section: name and icon, move up / down, new section, delete. `version`: the icon's image (M28c). */
@Composable
fun SectionActionsDialog(
    controller: AppController, section: SidebarSectionOut, index: Int, count: Int, version: Int,
    onDismiss: () -> Unit, onEdit: () -> Unit, onNewSection: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                SectionIcon(controller, section.emoji, version, size = 22.dp)
                Text(section.name, modifier = Modifier.padding(start = if (section.emoji != null) 8.dp else 0.dp))
            }
        },
        text = {
            Column {
                TextButton(onClick = onEdit) { Text("名前とアイコンを変更…") }
                Row {
                    TextButton(enabled = index > 0, onClick = { scope.launch { if (controller.moveSection(section.id, index - 1)) onDismiss() } }) { Text("上へ") }
                    TextButton(enabled = index < count - 1, onClick = { scope.launch { if (controller.moveSection(section.id, index + 1)) onDismiss() } }) { Text("下へ") }
                }
                TextButton(onClick = onNewSection) { Text("新しいセクション…") }
                HorizontalDivider()
                TextButton(onClick = { scope.launch { if (controller.deleteSection(section.id)) onDismiss() } }) {
                    Text("セクションを削除 (会話は元の場所へ)", color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
    )
}

/**
 * A section's icon (M26), also a status emoji: an emoji, or a custom emoji drawn from its image (its `:name:` until the
 * image is here).
 * `version` (M28c): the image lands in the Store after the first draw; without it strong skipping kept the `:name:`.
 */
@Composable
fun SectionIcon(controller: AppController, emoji: String?, version: Int, size: Dp = 18.dp) {
    if (emoji == null) return
    val custom = remember(version, emoji) { CustomEmoji.of(emoji, controller.store.customEmoji) }
    val image = remember(version, custom) { custom?.let { controller.store.emojiImages[it.id] } }
    if (custom != null && image == null) LaunchedEffect(custom.id) { controller.loadEmojiImage(custom) }
    if (image != null) EmojiImage(image, custom?.let { controller.store.emojiAnimations[it.id] }, contentDescription = null, modifier = Modifier.size(size))
    else Text(emoji, fontSize = (size.value * 0.9f).sp, maxLines = 1)
}

/**
 * Making or editing one of my sections (M26, Slack): its name and icon; when making one, also the conversations that
 * go in it (they leave the section they were in). `section` null makes a new one; `preselected` ticks the conversation
 * a long-press 「新しいセクション…」 started from.
 */
@Composable
fun SectionDialog(controller: AppController, section: SidebarSectionOut?, preselected: List<String>, version: Int, onDismiss: () -> Unit) {
    val store = controller.store
    val scope = rememberCoroutineScope()
    // The form survives a rotation (M28c); the picked conversations as a joined line (a Set is not saveable as such).
    var name by rememberSaveable { mutableStateOf(section?.name ?: "") }
    var emoji by rememberSaveable { mutableStateOf(section?.emoji) }
    var picking by rememberSaveable { mutableStateOf(false) }
    var chosenLine by rememberSaveable { mutableStateOf(preselected.joinToString("\n")) }
    val chosen = chosenLine.split("\n").filter { it.isNotEmpty() }.toSet()
    fun choose(ids: Set<String>) { chosenLine = ids.joinToString("\n") }
    var query by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val creating = section == null
    val sectionOf = remember(version) { store.sidebarSections.flatMap { s -> s.channelIds.map { it to s } }.toMap() }
    val collator = remember { Collator.getInstance(Locale.JAPANESE) }
    val conversations = remember(query, version) {
        val q = query.trim().lowercase()
        store.channels.values.filter { it.isMember && !it.channel.archived }
            .map { it to channelTitle(it, store) }
            .filter { (_, title) -> q.isEmpty() || title.lowercase().contains(q) }
            .sortedWith { a, b -> collator.compare(a.second, b.second) }
    }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(if (creating) "新しいセクション" else "セクションを編集") },
        text = {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier.size(48.dp).border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(12.dp)).clickable { picking = true },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (emoji != null) SectionIcon(controller, emoji, version, size = 26.dp)
                        else Icon(Icons.Outlined.AddReaction, contentDescription = "アイコンを選ぶ", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Spacer(Modifier.width(8.dp))
                    OutlinedTextField(
                        name, { name = it.take(40) }, label = { Text("セクション名") }, placeholder = { Text("例: 研究、授業") }, singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                }
                if (emoji != null) TextButton(onClick = { emoji = null }) { Text("アイコンを外す") }
                if (creating) {
                    Text(
                        "入れる会話 (${chosen.size})", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
                    )
                    OutlinedTextField(query, { query = it }, placeholder = { Text("チャンネルや DM を絞り込む") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    LazyColumn(Modifier.fillMaxWidth().heightIn(max = 260.dp).padding(top = 4.dp)) {
                        items(conversations, key = { it.first.id }) { (channel, title) ->
                            val current = sectionOf[channel.id]
                            Row(
                                Modifier.fillMaxWidth().clickable { choose(if (channel.id in chosen) chosen - channel.id else chosen + channel.id) }.padding(vertical = 2.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Checkbox(checked = channel.id in chosen, onCheckedChange = null, modifier = Modifier.padding(8.dp))
                                Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                if (current != null) {
                                    Text(
                                        "${current.name} から移動", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1, modifier = Modifier.padding(start = 6.dp),
                                    )
                                }
                            }
                        }
                        if (conversations.isEmpty()) item { Text("該当する会話がありません", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(12.dp)) }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && name.isNotBlank(), onClick = {
                busy = true
                scope.launch {
                    val done = if (section == null) controller.createSection(name.trim(), emoji, chosen.toList())
                    else controller.editSection(section.id, name.trim(), emoji)
                    busy = false
                    if (done) onDismiss()
                }
            }) { Text(if (busy) "保存中…" else if (creating) "作成" else "保存") }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("キャンセル") } },
    )
    if (picking) {
        EmojiPickerSheet(
            recent = QuickReactions.read(controller.prefs),
            store = store, onNeedImage = { controller.loadEmojiImage(it) }, onNeedPackTab = { controller.loadPackTab(it) },
            onDismiss = { picking = false }, onPick = { emoji = it; picking = false },
        )
    }
}
