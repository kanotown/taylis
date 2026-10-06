package jp.chikuwachat.android.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AddReaction
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
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
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import jp.chikuwachat.android.api.SidebarSectionOut
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch
import java.text.Collator
import java.util.Locale
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource

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
                    Text(if (starred) stringResource(R.string.common_remove_from_favorites) else stringResource(R.string.common_add_to_favorites))
                }
                HorizontalDivider()
                Text(stringResource(R.string.sidebar_dialogs_move_to_section), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
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
                TextButton(onClick = onNewSection) { Text(stringResource(R.string.sidebar_dialogs_new_section)) }
                if (current != null) {
                    TextButton(onClick = { scope.launch { if (controller.moveToSection(channelId, null)) onDismiss() } }) { Text(stringResource(R.string.sidebar_dialogs_remove_from_section)) }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_close)) } },
    )
}

/** The 「…」 on a custom section: name and icon, move up / down, new section, delete. `version`: the icon's image (M28c). */
@Composable
fun SectionActionsDialog(
    controller: AppController, section: SidebarSectionOut, index: Int, count: Int, version: Int,
    onDismiss: () -> Unit, onEdit: () -> Unit, onNewSection: () -> Unit,
    /** DATA_MODEL.md 「並べ替え」: the section's rows in their order now (the start of a hand-made order). */
    shownIds: () -> List<String> = { emptyList() },
    /** 「順番を編集」 (in 「手動」): the home shows the section's arrows. */
    onEditOrder: () -> Unit = {},
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
                TextButton(onClick = onEdit) { Text(stringResource(R.string.sidebar_dialogs_change_name_and_icon)) }
                Row {
                    TextButton(enabled = index > 0, onClick = { scope.launch { if (controller.moveSection(section.id, index - 1)) onDismiss() } }) { Text(stringResource(R.string.common_move_up)) }
                    TextButton(enabled = index < count - 1, onClick = { scope.launch { if (controller.moveSection(section.id, index + 1)) onDismiss() } }) { Text(stringResource(R.string.common_move_down)) }
                }
                TextButton(onClick = onNewSection) { Text(stringResource(R.string.sidebar_dialogs_new_section)) }
                HorizontalDivider()
                SortChoices(section.sort, onSort = { sort -> scope.launch { controller.setSectionSort(AppController.SortTarget.Section(section.id), sort, shownIds()) } })
                if (section.sort == "manual") TextButton(enabled = !section.collapsed, onClick = onEditOrder) { Text(stringResource(R.string.sidebar_dialogs_edit_order)) }
                HorizontalDivider()
                TextButton(onClick = { scope.launch { if (controller.deleteSection(section.id)) onDismiss() } }) {
                    Text(stringResource(R.string.sidebar_dialogs_delete_section_conversations_go_back), color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_close)) } },
    )
}

/** 「並べ替え」: 名前順 / 最近の活動順 / 手動 as a radio group (DATA_MODEL.md sidebar_sections). */
@Composable
fun SortChoices(sort: String, onSort: (String) -> Unit) {
    Column(Modifier.selectableGroup()) {
        Text(stringResource(R.string.sidebar_dialogs_sort), style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(start = 12.dp, top = 8.dp, bottom = 4.dp))
        SIDEBAR_SORTS.forEach { (value, label) ->
            Row(
                Modifier.fillMaxWidth().heightIn(min = 44.dp).selectable(selected = sort == value, role = Role.RadioButton, onClick = { if (sort != value) onSort(value) })
                    .padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = sort == value, onClick = null)
                Text(stringResource(label), modifier = Modifier.padding(start = 8.dp))
            }
        }
    }
}

/** The sorts and their names, in the menu's order. */
val SIDEBAR_SORTS = listOf("name" to R.string.sidebar_dialogs_sort_name, "recent" to R.string.sidebar_dialogs_sort_recent, "manual" to R.string.sidebar_dialogs_sort_manual)

/**
 * A section's icon (M26), also a status emoji: an emoji, or a custom emoji drawn from its image (its `:name:` until the
 * image is here).
 * `version` (M28c): the image lands in the Store after the first draw; without it strong skipping kept the `:name:`.
 */
@Composable
fun SectionIcon(controller: AppController, emoji: String?, version: Int, size: Dp = 18.dp) {
    if (emoji == null) return
    // M114: a letter badge.
    val letter = remember(emoji) { SectionLetterIcon.parse(emoji) }
    if (letter != null) return LetterBadge(letter.text, letter.color, size)
    val custom = remember(version, emoji) { CustomEmoji.of(emoji, controller.store.customEmoji) }
    val image = remember(version, custom) { custom?.let { controller.store.emojiImages[it.id] } }
    if (custom != null && image == null) LaunchedEffect(custom.id) { controller.loadEmojiImage(custom) }
    // A text emoji's pill (M100) as wide as its label, as high as the icon.
    if (image != null) EmojiImage(image, custom?.let { controller.store.emojiAnimations[it.id] }, contentDescription = null, modifier = Modifier.height(size).width(size * (custom?.let { CustomEmoji.aspect(it) } ?: 1f)))
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
    // M114: 「絵文字」 (the picker sheet) or 「文字」 (a letter badge, typed here); the field as typed, so an IME's
    // composing 「しゅう」 is not cut before it becomes 「修」.
    val initialLetter = remember { SectionLetterIcon.parse(section?.emoji) }
    var letters by rememberSaveable { mutableStateOf(initialLetter != null) }
    var letterRaw by rememberSaveable { mutableStateOf(initialLetter?.text ?: "") }
    var letterColor by rememberSaveable { mutableStateOf(initialLetter?.color ?: "blue") }
    val letterText = SectionLetterIcon.normalize(letterRaw)
    val letterValid = SectionLetterIcon.isLetterText(letterText)
    fun applyLetter(raw: String, color: String) {
        letterRaw = raw
        letterColor = color
        val text = SectionLetterIcon.normalize(raw)
        if (SectionLetterIcon.isLetterText(text)) emoji = SectionLetterIcon(text, color).icon
    }
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
        title = { Text(if (creating) stringResource(R.string.common_new_section) else stringResource(R.string.common_edit_section)) },
        text = {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier.size(48.dp).border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(12.dp)).clickable { if (!letters) picking = true },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (emoji != null) SectionIcon(controller, emoji, version, size = 26.dp)
                        else Icon(Icons.Outlined.AddReaction, contentDescription = stringResource(R.string.sidebar_dialogs_choose_an_icon), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Spacer(Modifier.width(8.dp))
                    OutlinedTextField(
                        name, { name = it.take(40) }, label = { Text(stringResource(R.string.sidebar_dialogs_section_name)) }, placeholder = { Text(stringResource(R.string.sidebar_dialogs_e_g_research_classes)) }, singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                }
                Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    FilterChip(selected = !letters, onClick = { letters = false; picking = true }, label = { Text(stringResource(R.string.common_emoji)) })
                    FilterChip(selected = letters, onClick = { letters = true; applyLetter(letterRaw, letterColor) }, label = { Text(stringResource(R.string.sidebar_dialogs_letter)) })
                    Spacer(Modifier.weight(1f))
                    if (emoji != null) TextButton(onClick = { emoji = null }) { Text(stringResource(R.string.sidebar_dialogs_remove_icon)) }
                }
                if (letters) {
                    OutlinedTextField(
                        letterRaw, { applyLetter(it, letterColor) }, label = { Text(stringResource(R.string.sidebar_dialogs_icon_letters)) }, placeholder = { Text(stringResource(R.string.sidebar_dialogs_e_g_m_b_r)) },
                        singleLine = true, isError = letterText.isNotEmpty() && !letterValid,
                        supportingText = { Text(stringResource(R.string.sidebar_dialogs_up_to_2_letters_or_digits)) },
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        SectionLetterIcon.COLORS.forEach { (key, label) ->
                            val selected = key == letterColor
                            Box(
                                Modifier.size(34.dp)
                                    .border(2.dp, if (selected) MaterialTheme.colorScheme.primary else Color.Transparent, RoundedCornerShape(10.dp))
                                    .clickable(onClickLabel = label) { applyLetter(letterRaw, key) }
                                    .semantics { contentDescription = label; this.selected = selected },
                                contentAlignment = Alignment.Center,
                            ) { LetterBadge(if (letterValid) letterText else "A", key, 26.dp) }
                        }
                    }
                }
                if (creating) {
                    Text(
                        stringResource(R.string.sidebar_dialogs_conversations_in_it, chosen.size), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
                    )
                    OutlinedTextField(query, { query = it }, placeholder = { Text(stringResource(R.string.sidebar_dialogs_filter_channels_and_dms)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
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
                                        stringResource(R.string.sidebar_dialogs_move_from, current.name), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1, modifier = Modifier.padding(start = 6.dp),
                                    )
                                }
                            }
                        }
                        if (conversations.isEmpty()) item { Text(stringResource(R.string.sidebar_dialogs_no_matching_conversations), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(12.dp)) }
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
            }) { Text(if (busy) stringResource(R.string.common_saving) else if (creating) stringResource(R.string.common_create) else stringResource(R.string.common_save)) }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
    if (picking) {
        EmojiPickerSheet(
            recent = QuickReactions.read(controller.prefs),
            store = store, onNeedImage = { controller.loadEmojiImage(it) }, onNeedPackTab = { controller.loadPackTab(it) },
            onDismiss = { picking = false }, onPick = { emoji = it; letters = false; picking = false },
        )
    }
}
