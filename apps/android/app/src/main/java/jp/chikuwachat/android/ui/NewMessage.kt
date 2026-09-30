package jp.chikuwachat.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.InputChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.compose.ui.platform.LocalView
import androidx.compose.runtime.SideEffect
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.core.view.WindowCompat
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelState
import kotlinx.coroutines.launch

/** The server allows nine members in a DM including me, so at most eight recipients (as the new-DM dialog). */
private const val MAX_RECIPIENTS = 8

/**
 * M37 ✏️ 新しいメッセージ (MOBILE_UI.md §6.1): the destination, full screen, from one search box. A channel opens at once
 * (mine first, then public ones I can join, which open as a preview); people are ticked, several making a group DM,
 * then 「開始」; me opens my own DM. `onOpen` gets the conversation's id (MainScreen opens it and focuses its composer).
 */
@Composable
fun NewMessageDialog(controller: AppController, version: Int, onDismiss: () -> Unit, onOpen: (String) -> Unit) {
    val store = controller.store
    val meId = store.me?.id
    var query by rememberSaveable { mutableStateOf("") }
    var selected by rememberSaveable { mutableStateOf(listOf<String>()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val destinations = remember(query, version) { Jump.destinations(query, store.channels.values, store.users.values, meId) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    fun start(ids: List<String>) {
        if (busy || ids.isEmpty()) return
        busy = true
        error = null
        scope.launch {
            try {
                // One person (or me): the DM there is (as openDmWith finds it), else a new one; several: their group DM.
                val existing = ids.singleOrNull()?.let { MainTabs.findDmWith(store.channels.values, it, meId)?.id }
                val id = existing ?: controller.createDm(ids).getOrElse { error = controller.describe(it); null }
                if (id != null) onOpen(id)
            } finally { busy = false }
        }
    }

    // Full screen, edge to edge like the app's pages (no dimmed bars around it).
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        // The dialog's own window: its bar icons dark on a light page, light on a dark one (as the activity's).
        val view = LocalView.current
        val lightBars = !isSystemInDarkTheme()
        SideEffect {
            (view.parent as? DialogWindowProvider)?.window?.let { window ->
                WindowCompat.getInsetsController(window, view).apply {
                    isAppearanceLightStatusBars = lightBars
                    isAppearanceLightNavigationBars = lightBars
                }
            }
        }
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().systemBarsPadding().imePadding()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onDismiss) { Icon(Icons.Default.Close, contentDescription = "閉じる") }
                    Text("新しいメッセージ", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() })
                    TextButton(enabled = !busy && selected.isNotEmpty(), onClick = { start(selected) }) { Text(if (busy) "開始中…" else "開始") }
                }
                if (selected.isNotEmpty()) {
                    Row(
                        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        selected.forEach { id ->
                            val name = store.users[id]?.displayName ?: "…"
                            InputChip(
                                selected = true,
                                onClick = { selected = selected - id },
                                label = { Text(name, maxLines = 1) },
                                trailingIcon = { Icon(Icons.Default.Close, contentDescription = "$name を外す", modifier = Modifier.size(InputChipDefaults.IconSize)) },
                            )
                        }
                    }
                }
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it.take(80) },
                    placeholder = { Text("宛先: チャンネルか人の名前") },
                    leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                    trailingIcon = if (query.isEmpty()) null else { { IconButton(onClick = { query = "" }) { Icon(Icons.Default.Close, contentDescription = "入力を消す") } } },
                    singleLine = true,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp).focusRequester(focus),
                )
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
                LazyColumn(Modifier.fillMaxWidth().weight(1f)) {
                    if (destinations.channels.isNotEmpty()) {
                        item(key = "h:channels") { PickerHeader("チャンネル") }
                        items(destinations.channels, key = { "c:" + it.id }) { channel -> PickerChannelRow(channel, enabled = !busy) { onOpen(channel.id) } }
                    }
                    if (destinations.joinable.isNotEmpty()) {
                        item(key = "h:joinable") { PickerHeader("参加できるチャンネル") }
                        items(destinations.joinable, key = { "j:" + it.id }) { channel -> PickerChannelRow(channel, enabled = !busy) { onOpen(channel.id) } }
                    }
                    if (destinations.people.isNotEmpty()) {
                        item(key = "h:people") { PickerHeader("人 (複数選ぶとグループ DM、相手は $MAX_RECIPIENTS 人まで)") }
                        items(destinations.people, key = { "u:" + it.id }) { user ->
                            if (user.id == meId) {
                                PickerPersonRow(user, subtitle = MainTabs.SELF_NOTES_HINT, checked = null, enabled = !busy) { start(listOf(user.id)) }
                            } else {
                                val checked = user.id in selected
                                PickerPersonRow(user, subtitle = "@" + user.username, checked = checked, enabled = !busy && (checked || selected.size < MAX_RECIPIENTS)) {
                                    selected = if (checked) selected - user.id else selected + user.id
                                }
                            }
                        }
                    }
                    if (destinations.channels.isEmpty() && destinations.joinable.isEmpty() && destinations.people.isEmpty()) {
                        item(key = "empty") {
                            Text("一致するチャンネルや人はいません", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 24.dp))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PickerHeader(title: String) {
    Text(
        title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp).semantics { heading() },
    )
}

@Composable
private fun PickerChannelRow(channel: ChannelState, enabled: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(enabled = enabled, onClick = onClick).padding(horizontal = 16.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(32.dp), contentAlignment = Alignment.Center) {
            Icon(
                if (channel.channel.type == "private") Icons.Default.Lock else Icons.Default.Tag, contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp),
            )
        }
        Spacer(Modifier.width(12.dp))
        Text(channel.channel.name ?: "", maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
    }
}

/** `checked` null: a row that opens at once (me); otherwise ticked for the DM. */
@Composable
private fun PickerPersonRow(user: UserPublic, subtitle: String, checked: Boolean?, enabled: Boolean, onClick: () -> Unit) {
    val tap = if (checked == null) Modifier.clickable(enabled = enabled, onClick = onClick)
    else Modifier.toggleable(value = checked, enabled = enabled, role = Role.Checkbox, onValueChange = { onClick() })
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).then(tap).padding(horizontal = 16.dp, vertical = 4.dp).alpha(if (enabled) 1f else 0.6f),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(user.id, user.displayName, size = 32.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(user.displayName, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (checked != null) Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}
